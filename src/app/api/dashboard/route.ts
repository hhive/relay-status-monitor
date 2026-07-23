import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiSession } from '@/lib/auth';

/**
 * Dashboard 概览数据
 * 统计从 keys 聚合，列表按 key（分组）粒度展开
 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const upstreams = await prisma.upstream.findMany({
    orderBy: [{ priority: 'desc' }, { id: 'asc' }],
    include: {
      keys: {
        where: { enabled: true },
        orderBy: { id: 'asc' },
        include: { _count: { select: { incidents: { where: { resolved: false } } } } },
      },
    },
  });

  const total = upstreams.length;
  const online = upstreams.filter((u) => u.status === 'ONLINE').length;
  const degraded = upstreams.filter((u) => u.status === 'DEGRADED').length;
  const offline = upstreams.filter((u) => u.status === 'OFFLINE').length;

  // 从所有 keys 聚合余额
  const allKeys = upstreams.flatMap((u) => u.keys);
  const balanceKeys = allKeys.filter((k) => k.lastBalance !== null);
  const totalBalance = balanceKeys.reduce((s, k) => s + (k.lastBalance || 0), 0);

  // 最近 24 小时采集成功率
  const oneDayAgo = new Date(Date.now() - 86400000);
  const recentMetrics = await prisma.metric.groupBy({
    by: ['success'],
    where: { recordedAt: { gte: oneDayAgo } },
    _count: true,
  });
  const totalCount = recentMetrics.reduce((s, r) => s + r._count, 0);
  const successCount = recentMetrics.find((r) => r.success === true)?._count ?? 0;
  const availability = totalCount > 0 ? (successCount / totalCount) * 100 : 100;

  const openIncidents = await prisma.incident.count({ where: { resolved: false } });

  // 按 key 粒度展开列表
  const list = [];
  for (const u of upstreams) {
    for (const k of u.keys) {
      list.push({
        keyId: k.id,
        upstreamId: u.id,
        upstreamName: u.name,
        baseUrl: u.baseUrl,
        type: u.type,
        group: k.group,
        label: k.label,
        keyName: k.keyName,
        groupName: k.groupName,
        groupDescription: k.groupDescription,
        groupRateMultiplier: k.groupRateMultiplier,
        remoteKeyId: k.remoteKeyId,
        status: k.status,
        balance: k.lastBalance,
        latencyMs: k.lastLatencyMs,
        hasApiKey: Boolean(k.apiKeyEnc),
        hasAccessToken: Boolean(k.accessTokenEnc),
        testModel: k.testModel || u.testModel,
        lastCollectedAt: k.lastCollectedAt,
        lastError: k.lastError,
        openIncidents: k._count.incidents,
      });
    }
  }

  return NextResponse.json({
    summary: {
      total,
      online,
      degraded,
      offline,
      totalKeys: allKeys.length,
      totalBalance: Math.round(totalBalance * 100) / 100,
      availability: Math.round(availability * 10) / 10,
      openIncidents,
    },
    items: list,
  });
}
