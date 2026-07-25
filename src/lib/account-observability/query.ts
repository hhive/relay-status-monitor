import { prisma } from '../db';
import { beijingTodayWindow, decimalToMicroUsd, histogramP95, mergeLatencyHistogram } from './metrics';

function usd(micro: bigint): string {
  return (Number(micro) / 1_000_000).toFixed(6);
}

function aggregate(minutes: Array<{
  successCount: number; upstreamErrorCount: number; eligibleCount: number;
  durationCount: number; durationSumMs: bigint; durationHistogram: unknown;
  firstTokenHistogram: unknown; inputTokens: bigint; cacheReadTokens: bigint;
  cacheCreationTokens: bigint; userBilledUsd: unknown; accountBilledUsd: unknown;
}>) {
  const durationHistogram = mergeLatencyHistogram(minutes.map((m) => (m.durationHistogram ?? {}) as Record<string, number>));
  const firstTokenHistogram = mergeLatencyHistogram(minutes.map((m) => (m.firstTokenHistogram ?? {}) as Record<string, number>));
  const successCount = minutes.reduce((n, m) => n + m.successCount, 0);
  const upstreamErrorCount = minutes.reduce((n, m) => n + m.upstreamErrorCount, 0);
  const eligibleCount = minutes.reduce((n, m) => n + m.eligibleCount, 0);
  const inputTokens = minutes.reduce((n, m) => n + m.inputTokens, BigInt(0));
  const cacheReadTokens = minutes.reduce((n, m) => n + m.cacheReadTokens, BigInt(0));
  const cacheCreationTokens = minutes.reduce((n, m) => n + m.cacheCreationTokens, BigInt(0));
  const tokenDenominator = inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    successCount, upstreamErrorCount, eligibleCount,
    availability: eligibleCount ? successCount / eligibleCount : null,
    errorRate: eligibleCount ? upstreamErrorCount / eligibleCount : null,
    averageDurationMs: minutes.reduce((n, m) => n + Number(m.durationSumMs), 0) /
      (minutes.reduce((n, m) => n + m.durationCount, 0) || 1) || null,
    durationP95Ms: histogramP95(durationHistogram),
    firstTokenP95Ms: histogramP95(firstTokenHistogram),
    cacheHitRate: tokenDenominator === BigInt(0) ? null : Number(cacheReadTokens) / Number(tokenDenominator),
    userBilledUsd: usd(minutes.reduce((n, m) => n + decimalToMicroUsd(String(m.userBilledUsd)), BigInt(0))),
    accountBilledUsd: usd(minutes.reduce((n, m) => n + decimalToMicroUsd(String(m.accountBilledUsd)), BigInt(0))),
  };
}

export async function listAccountSummaries() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const accounts = await prisma.sub2ApiAccount.findMany({
    orderBy: [{ syncState: 'asc' }, { name: 'asc' }],
    include: { metricMinutes: { where: { bucketStart: { gte: since } }, orderBy: { bucketStart: 'asc' } } },
  });
  return accounts.map((account) => ({
    id: account.id,
    sourceAccountId: account.sourceAccountId,
    name: account.name,
    platform: account.platform,
    type: account.type,
    remoteStatus: account.remoteStatus,
    schedulable: account.schedulable,
    syncState: account.syncState,
    billingProbe: {
      enabled: account.probeEnabled,
      status: account.probeStatus,
      freshAt: account.probeFreshAt,
      resolvedRateMultiplier: account.probeResolvedRateMultiplier?.toString() ?? null,
      peakRateMultiplier: account.probePeakRateMultiplier?.toString() ?? null,
    },
    lastSyncedAt: account.lastSyncedAt,
    metrics24h: aggregate(account.metricMinutes),
  }));
}

export async function getAccountDetail(id: number) {
  const account = await prisma.sub2ApiAccount.findUnique({
    where: { id },
    include: { metricMinutes: { orderBy: { bucketStart: 'asc' }, take: 1440 } },
  });
  if (!account) return null;
  const now = new Date();
  const todayStart = beijingTodayWindow(now).start;
  const oneHourStart = new Date(now.getTime() - 60 * 60 * 1000);
  const today = account.metricMinutes.filter((minute) => minute.bucketStart >= todayStart);
  const oneHour = account.metricMinutes.filter((minute) => minute.bucketStart >= oneHourStart);
  return {
    id: account.id, sourceAccountId: account.sourceAccountId, name: account.name,
    platform: account.platform, type: account.type, remoteStatus: account.remoteStatus,
    schedulable: account.schedulable, syncState: account.syncState, lastSyncedAt: account.lastSyncedAt,
    billingProbe: { enabled: account.probeEnabled, status: account.probeStatus, freshAt: account.probeFreshAt,
      resolvedRateMultiplier: account.probeResolvedRateMultiplier?.toString() ?? null,
      peakRateMultiplier: account.probePeakRateMultiplier?.toString() ?? null },
    windows: { today: aggregate(today), last1h: aggregate(oneHour), last24h: aggregate(account.metricMinutes) },
    trend: account.metricMinutes.map((minute) => ({
      bucketStart: minute.bucketStart, successCount: minute.successCount,
      upstreamErrorCount: minute.upstreamErrorCount,
      availability: minute.eligibleCount ? minute.successCount / minute.eligibleCount : null,
      durationP95Ms: histogramP95((minute.durationHistogram ?? {}) as Record<string, number>),
      firstTokenP95Ms: histogramP95((minute.firstTokenHistogram ?? {}) as Record<string, number>),
    })),
  };
}
