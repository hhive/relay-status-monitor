/**
 * 采集器：对每个 UpstreamKey（分组/Token 监控单元）执行指标采集
 * 采集维度为 key（分组级），采集完一个 upstream 的所有 key 后聚合汇总状态
 */
import type { Upstream, UpstreamKey } from '@prisma/client';
import { prisma } from './db';
import { getAdapter } from './adapters/registry';
import type { AdapterContext } from './adapters/base';
import { tryDecrypt } from './crypto';
import { getCollectConfig } from './settings';
import { evaluateAlerts } from './alerts/engine';
import { safeStoredError } from './safe-error';
import { validateUpstreamBaseUrl } from './outbound';

export type CollectMode = 'light' | 'heavy';

type UpstreamKeyWithUpstream = UpstreamKey & { upstream: Upstream };

export interface UpstreamCollectionDependencies<TKey, TResult = unknown> {
  collectKey: (key: TKey, mode: CollectMode) => Promise<TResult>;
  loadEnabledStatuses: (upstreamId: number) => Promise<string[]>;
  saveUpstreamStatus: (upstreamId: number, status: Upstream['status']) => Promise<void>;
}

/**
 * 对单个 key 执行采集
 */
export async function collectOneKey(key: UpstreamKeyWithUpstream, mode: CollectMode) {
  const { upstream } = key;

  try {
    validateUpstreamBaseUrl(upstream.type, upstream.baseUrl);
  } catch (error) {
    await prisma.upstreamKey.update({
      where: { id: key.id },
      data: { lastError: safeStoredError(error), status: 'UNKNOWN' },
    });
    return null;
  }

  // 凭证解密
  const apiKey = key.apiKeyEnc ? tryDecrypt(key.apiKeyEnc) : null;
  const accessToken = key.accessTokenEnc ? tryDecrypt(key.accessTokenEnc) : null;
  if (!apiKey && !accessToken) {
    await prisma.upstreamKey.update({
      where: { id: key.id },
      data: { lastError: '未配置任何凭证', status: 'UNKNOWN' },
    });
    return null;
  }

  const config = await getCollectConfig();
  const adapter = getAdapter(upstream.type);
  const ctx: AdapterContext = {
    baseUrl: upstream.baseUrl,
    apiKey: apiKey || '',
    accessToken: accessToken || undefined,
    userId: key.userId || undefined,
    timeoutMs: config.timeoutMs,
    testModel: key.testModel || upstream.testModel || config.testModel,
  };

  const errors: string[] = [];

  // 轻量采集
  const [balanceRes, latencyRes] = await Promise.all([
    adapter.queryBalance(ctx),
    adapter.testLatency(ctx),
  ]);

  // 重量采集
  let modelRes = null;
  let streamRes = null;
  if (mode === 'heavy') {
    [modelRes, streamRes] = await Promise.all([
      adapter.testModel(ctx, ctx.testModel),
      adapter.testStream(ctx, ctx.testModel),
    ]);
  }

  if (!balanceRes.ok) errors.push(`balance:${safeStoredError(balanceRes.errorMessage)}`);
  if (!latencyRes.ok) errors.push(`latency:${safeStoredError(latencyRes.errorMessage)}`);
  if (modelRes && !modelRes.ok) errors.push(`model:${safeStoredError(modelRes.errorMessage)}`);
  if (streamRes && !streamRes.ok) errors.push(`stream:${safeStoredError(streamRes.errorMessage)}`);

  const success = balanceRes.ok || latencyRes.ok;
  const errorMessage = errors.length > 0 ? errors.join('; ') : null;

  // 写入指标（同时关联 upstreamId 和 upstreamKeyId）
  const metric = await prisma.metric.create({
    data: {
      upstreamId: upstream.id,
      upstreamKeyId: key.id,
      balance: balanceRes.balance ?? null,
      latencyMs: latencyRes.latencyMs ?? null,
      modelTestOk: modelRes?.ok ?? null,
      modelTestLatMs: modelRes?.latencyMs ?? null,
      streamTps: streamRes?.tps ?? null,
      streamFirstLat: streamRes?.firstTokenLatMs ?? null,
      success,
      errorMessage,
    },
  });

  // 更新 key 缓存
  const newStatus = deriveStatus(balanceRes, latencyRes, modelRes);
  const updateData: Record<string, unknown> = {
    status: newStatus,
    lastBalance: balanceRes.balance ?? undefined,
    lastLatencyMs: latencyRes.latencyMs ?? undefined,
    lastCollectedAt: new Date(),
    lastError: errorMessage,
  };

  // SUB2API 保留旧版 planName 回写；NEW_API 的 Token 分组由独立元数据接口维护。
  if (upstream.type === 'SUB2API' && balanceRes.groupName && balanceRes.groupName !== key.group) {
    const newName = balanceRes.groupName;
    // 检查是否已有同名分组（避免唯一约束冲突）
    const existing = await prisma.upstreamKey.findUnique({
      where: { upstreamId_group: { upstreamId: key.upstreamId, group: newName } },
    }).catch(() => null);
    if (!existing) {
      updateData.group = newName;
    }
  }

  await prisma.upstreamKey.update({
    where: { id: key.id },
    data: updateData,
  });

  // 告警判断（按 key）
  await evaluateAlerts(key.id);

  return metric;
}

function deriveStatus(
  balance: { ok: boolean },
  latency: { ok: boolean; latencyMs?: number },
  model?: { ok: boolean } | null
): UpstreamKey['status'] {
  if (!balance.ok && !latency.ok) return 'OFFLINE';
  if (model && !model.ok) return 'DEGRADED';
  if (latency.ok && latency.latencyMs && latency.latencyMs > 3000) return 'DEGRADED';
  return 'ONLINE';
}

/** 聚合多个 key 的状态为 upstream 汇总状态 */
export function aggregateStatus(statuses: string[]): Upstream['status'] {
  if (statuses.length === 0) return 'UNKNOWN';
  if (statuses.every((s) => s === 'ONLINE')) return 'ONLINE';
  if (statuses.every((s) => s === 'OFFLINE')) return 'OFFLINE';
  if (statuses.some((s) => s === 'OFFLINE') && !statuses.some((s) => s === 'ONLINE' || s === 'DEGRADED')) return 'OFFLINE';
  return 'DEGRADED';
}

/** 创建可测试的上游批量采集流程。 */
export function createUpstreamCollectionRunner<TKey, TResult = unknown>(
  dependencies: UpstreamCollectionDependencies<TKey, TResult>
) {
  return async (upstreamId: number, keys: TKey[], mode: CollectMode) => {
    const results = await Promise.allSettled(
      keys.map((key) => dependencies.collectKey(key, mode))
    );
    const statuses = await dependencies.loadEnabledStatuses(upstreamId);
    const status = aggregateStatus(statuses);
    await dependencies.saveUpstreamStatus(upstreamId, status);
    return { results, status };
  };
}

const runUpstreamCollection = createUpstreamCollectionRunner<
  UpstreamKeyWithUpstream,
  Awaited<ReturnType<typeof collectOneKey>>
>({
  collectKey: collectOneKey,
  loadEnabledStatuses: async (upstreamId) => {
    const keys = await prisma.upstreamKey.findMany({
      where: { upstreamId, enabled: true },
      select: { status: true },
    });
    return keys.map((key) => key.status);
  },
  saveUpstreamStatus: async (upstreamId, status) => {
    await prisma.upstream.update({
      where: { id: upstreamId },
      data: { status },
    });
  },
});

/** 对一个上游的指定 keys 执行采集，并刷新上游汇总状态。 */
export async function collectUpstreamKeys(
  upstream: Upstream & { keys: UpstreamKey[] },
  mode: CollectMode
) {
  const keys = upstream.keys.map((key) => ({ ...key, upstream }));
  return runUpstreamCollection(upstream.id, keys, mode);
}

/** 只根据当前 key 缓存重新计算上游汇总状态。 */
export async function refreshUpstreamAggregateStatus(upstreamId: number) {
  const keys = await prisma.upstreamKey.findMany({
    where: { upstreamId, enabled: true },
    select: { status: true },
  });
  const status = aggregateStatus(keys.map((key) => key.status));
  await prisma.upstream.update({
    where: { id: upstreamId },
    data: { status },
  });
  return status;
}

/**
 * 执行一轮采集（被 cron 调用）
 */
export async function runCollectCycle(): Promise<{ collected: number; mode: CollectMode }> {
  const config = await getCollectConfig();
  const now = new Date();
  const minuteSlot = Math.floor(now.getTime() / 60000);
  const mode: CollectMode = minuteSlot % config.heavyMin === 0 ? 'heavy' : 'light';

  // 查所有 enabled upstream 的 enabled keys
  const upstreams = await prisma.upstream.findMany({
    where: { enabled: true },
    include: { keys: { where: { enabled: true } } },
  });

  let count = 0;
  for (const upstream of upstreams) {
    if (upstream.keys.length === 0) continue;

    await collectUpstreamKeys(upstream, mode);
    count += upstream.keys.length;
  }

  return { collected: count, mode };
}

/** 手动触发单个 key 的完整采集 */
export async function collectOneKeyManual(keyId: number) {
  const key = await prisma.upstreamKey.findUnique({
    where: { id: keyId },
    include: { upstream: true },
  });
  if (!key) throw new Error('Key 不存在');
  const metric = await collectOneKey(key, 'heavy');
  await refreshUpstreamAggregateStatus(key.upstreamId);
  return metric;
}
