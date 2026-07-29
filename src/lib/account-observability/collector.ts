import { prisma } from '../db';
import { aggregateMinute, type ErrorEvent, type UsageEvent } from './aggregate';
import { evaluateAccountAlerts } from './alerts';
import { runUpstreamBalanceCollection } from './balance-collector';
import { microUsdToDecimal, minuteBucket } from './metrics';
import { refreshAccountMetricSnapshots } from './snapshot';
import {
  createSub2ApiReadonlyClient,
  queryProviderErrorRows,
  querySchemaCapabilities,
  queryUsageRows,
} from './sub2api-readonly';
import { syncSub2ApiAccounts } from './sync';

export interface MetricWindow {
  start: Date;
  end: Date;
}

type SourceRow = Record<string, unknown>;

export interface MetricMinuteWrite {
  accountId: number;
  bucketStart: Date;
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  durationCount: number;
  durationSumMs: number;
  durationHistogram: Record<string, number>;
  firstTokenHistogram: Record<string, number>;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  userBilledMicroUsd: bigint;
  baseBilledMicroUsd: bigint;
  accountBilledMicroUsd: bigint;
  errorStatusCounts: Record<string, number>;
  errorPhaseCounts: Record<string, number>;
  sourceMaxUsageId: string | null;
  sourceMaxErrorId: string | null;
}

interface MetricWindowDependencies {
  readUsageRows: (start: Date, end: Date) => Promise<SourceRow[]>;
  readErrorRows: (start: Date, end: Date) => Promise<SourceRow[]>;
  loadActiveAccounts: () => Promise<Array<{ id: number; sourceAccountId: string }>>;
  upsertMinute: (row: MetricMinuteWrite) => Promise<void>;
  startRun: (window: MetricWindow) => Promise<number>;
  finishRun: (id: number, result: Record<string, unknown>) => Promise<void>;
}

export interface MetricWindowResult {
  readCount: number;
  writeCount: number;
  ignoredCount: number;
}

export function completeMetricWindow(now: Date, minutes = 10): MetricWindow {
  const end = minuteBucket(now);
  return { start: new Date(end.getTime() - minutes * 60_000), end };
}

function minuteStarts(window: MetricWindow): Date[] {
  if (window.start >= window.end || window.start.getTime() % 60_000 || window.end.getTime() % 60_000) {
    throw new Error('metric window must contain complete UTC minutes');
  }
  const result: Date[] = [];
  for (let time = window.start.getTime(); time < window.end.getTime(); time += 60_000) result.push(new Date(time));
  return result;
}

function maxSourceId(rows: SourceRow[], field: string): string | null {
  let maximum: string | null = null;
  for (const row of rows) {
    if (row[field] == null) continue;
    const value = String(row[field]);
    if (maximum === null || (BigInt(value) > BigInt(maximum))) maximum = value;
  }
  return maximum;
}

function usageEvent(row: SourceRow): UsageEvent {
  return {
    accountId: String(row.account_id), requestId: row.request_id == null ? null : String(row.request_id),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    firstTokenMs: row.first_token_ms == null ? null : Number(row.first_token_ms),
    inputTokens: Number(row.input_tokens ?? 0), cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheCreationTokens: Number(row.cache_creation_tokens ?? 0), actualCost: String(row.actual_cost ?? '0'),
    totalCost: String(row.total_cost ?? '0'),
    accountStatsCost: row.account_stats_cost == null ? null : String(row.account_stats_cost),
    accountRateMultiplier: row.account_rate_multiplier == null ? null : String(row.account_rate_multiplier),
  };
}

function errorEvent(row: SourceRow): ErrorEvent {
  return {
    accountId: String(row.account_id), requestId: row.request_id == null ? null : String(row.request_id),
    clientRequestId: row.client_request_id == null ? null : String(row.client_request_id),
    errorOwner: row.error_owner == null ? null : String(row.error_owner),
    errorPhase: row.error_phase == null ? null : String(row.error_phase),
    statusCode: row.status_code == null ? null : Number(row.status_code),
  };
}

export function createMetricWindowRunner(dependencies: MetricWindowDependencies) {
  return async (window: MetricWindow): Promise<MetricWindowResult> => {
    const runId = await dependencies.startRun(window);
    try {
      const [usageRows, errorRows] = await Promise.all([
        dependencies.readUsageRows(window.start, window.end),
        dependencies.readErrorRows(window.start, window.end),
      ]);
      const accounts = await dependencies.loadActiveAccounts();
      const bySourceId = new Map(accounts.map((account) => [account.sourceAccountId, account]));
      const buckets = new Map<string, { usages: SourceRow[]; errors: SourceRow[] }>();
      for (const account of accounts) for (const bucketStart of minuteStarts(window)) {
        buckets.set(`${account.sourceAccountId}|${bucketStart.toISOString()}`, { usages: [], errors: [] });
      }
      let ignoredCount = 0;
      for (const [kind, rows] of [['usage', usageRows], ['error', errorRows]] as const) {
        for (const row of rows) {
          const sourceAccountId = String(row.account_id ?? '');
          const createdAt = new Date(String(row.created_at));
          const key = `${sourceAccountId}|${minuteBucket(createdAt).toISOString()}`;
          const bucket = buckets.get(key);
          if (!bySourceId.has(sourceAccountId) || !Number.isFinite(createdAt.getTime()) || !bucket) {
            ignoredCount += 1;
            continue;
          }
          bucket[kind === 'usage' ? 'usages' : 'errors'].push(row);
        }
      }
      let writeCount = 0;
      for (const [key, rows] of buckets) {
        const [sourceAccountId, bucketIso] = key.split('|');
        const aggregate = aggregateMinute({ usages: rows.usages.map(usageEvent), errors: rows.errors.map(errorEvent) });
        await dependencies.upsertMinute({
          accountId: bySourceId.get(sourceAccountId)!.id,
          bucketStart: new Date(bucketIso), ...aggregate,
          sourceMaxUsageId: maxSourceId(rows.usages, 'usage_id'),
          sourceMaxErrorId: maxSourceId(rows.errors, 'error_id'),
        });
        writeCount += 1;
      }
      const result = { readCount: usageRows.length + errorRows.length, writeCount, ignoredCount };
      await dependencies.finishRun(runId, { status: 'SUCCEEDED', ...result });
      return result;
    } catch (error) {
      await dependencies.finishRun(runId, { status: 'FAILED', errorMessage: 'Sub2API metric collection failed' });
      throw error;
    }
  };
}

const MAX_REBUILD_MINUTES = 24 * 60;

export async function rebuildAccountMetrics(
  start: Date,
  end: Date,
  runWindow: (window: MetricWindow) => Promise<MetricWindowResult>,
  refreshSnapshots?: () => Promise<void>,
): Promise<MetricWindowResult> {
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_REBUILD_MINUTES) {
    throw new Error('bounded rebuild window must not exceed 24 hours');
  }
  const total = { readCount: 0, writeCount: 0, ignoredCount: 0 };
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += 10 * 60_000) {
    const result = await runWindow({ start: new Date(cursor), end: new Date(Math.min(cursor + 10 * 60_000, end.getTime())) });
    total.readCount += result.readCount; total.writeCount += result.writeCount; total.ignoredCount += result.ignoredCount;
  }
  await refreshSnapshots?.();
  return total;
}

function productionMetricRunner(
  readClient: ReturnType<typeof createSub2ApiReadonlyClient>,
  runType: 'METRIC' | 'REBUILD' = 'METRIC',
) {
  const startedAtByRun = new Map<number, number>();
  return createMetricWindowRunner({
    readUsageRows: (start, end) => queryUsageRows<SourceRow>(readClient, start, end),
    readErrorRows: (start, end) => queryProviderErrorRows<SourceRow>(readClient, start, end),
    loadActiveAccounts: () => prisma.sub2ApiAccount.findMany({ where: { syncState: 'ACTIVE' }, select: { id: true, sourceAccountId: true } }),
    startRun: async (window) => {
      const startedAt = new Date();
      const run = await prisma.accountSyncRun.create({ data: { type: runType, status: 'RUNNING', startedAt, scanStart: window.start, scanEnd: window.end } });
      startedAtByRun.set(run.id, startedAt.getTime());
      return run.id;
    },
    finishRun: async (id, result) => {
      const finishedAt = new Date();
      await prisma.accountSyncRun.update({ where: { id }, data: { status: result.status as 'SUCCEEDED' | 'FAILED', finishedAt, durationMs: finishedAt.getTime() - (startedAtByRun.get(id) ?? finishedAt.getTime()), readCount: Number(result.readCount ?? 0), bucketWriteCount: Number(result.writeCount ?? 0), ignoredCount: Number(result.ignoredCount ?? 0), errorMessage: result.errorMessage == null ? null : String(result.errorMessage) } });
      startedAtByRun.delete(id);
    },
    upsertMinute: async (row) => {
      const data = { successCount: row.successCount, upstreamErrorCount: row.upstreamErrorCount, eligibleCount: row.eligibleCount, durationCount: row.durationCount, durationSumMs: BigInt(row.durationSumMs), durationHistogram: row.durationHistogram, firstTokenHistogram: row.firstTokenHistogram, inputTokens: BigInt(row.inputTokens), cacheReadTokens: BigInt(row.cacheReadTokens), cacheCreationTokens: BigInt(row.cacheCreationTokens), userBilledUsd: microUsdToDecimal(row.userBilledMicroUsd), baseBilledUsd: microUsdToDecimal(row.baseBilledMicroUsd), accountBilledUsd: microUsdToDecimal(row.accountBilledMicroUsd), errorStatusCounts: row.errorStatusCounts, errorPhaseCounts: row.errorPhaseCounts, sourceMaxUsageId: row.sourceMaxUsageId, sourceMaxErrorId: row.sourceMaxErrorId };
      await prisma.accountMetricMinute.upsert({ where: { accountId_bucketStart: { accountId: row.accountId, bucketStart: row.bucketStart } }, create: { accountId: row.accountId, bucketStart: row.bucketStart, ...data }, update: data });
    },
  });
}

export async function runAccountObservabilityCycle(now = new Date()): Promise<{ skipped: boolean; readCount: number; ignoredCount: number; writeCount: number }> {
  if (!process.env.SUB2API_DATABASE_URL) return { skipped: true, readCount: 0, ignoredCount: 0, writeCount: 0 };
  const client = createSub2ApiReadonlyClient();
  try {
    await querySchemaCapabilities(client);
    const sync = now.getUTCMinutes() % 5 === 0
      ? await syncSub2ApiAccounts(client, prisma)
      : { readCount: 0, ignoredCount: 0 };
    const metricRunner = productionMetricRunner(client);
    const metrics = await metricRunner(completeMetricWindow(now));
    await runUpstreamBalanceCollection(now, client);
    await refreshAccountMetricSnapshots(now);
    await evaluateAccountAlerts(now);
    return { skipped: false, readCount: sync.readCount + metrics.readCount, ignoredCount: sync.ignoredCount + metrics.ignoredCount, writeCount: metrics.writeCount };
  } catch (error) {
    await evaluateAccountAlerts(now).catch(() => undefined);
    throw error;
  } finally {
    await client.$disconnect();
  }
}

export async function runAccountMetricRebuild(start: Date, end: Date): Promise<MetricWindowResult> {
  if (!process.env.SUB2API_DATABASE_URL) throw new Error('SUB2API_DATABASE_URL is required');
  const client = createSub2ApiReadonlyClient();
  try {
    await querySchemaCapabilities(client);
    return await rebuildAccountMetrics(
      start,
      end,
      productionMetricRunner(client, 'REBUILD'),
      async () => { await refreshAccountMetricSnapshots(new Date()); },
    );
  } finally {
    await client.$disconnect();
  }
}
