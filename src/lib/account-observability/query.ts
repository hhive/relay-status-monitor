import { prisma } from '../db';
import { filterAccounts, type AccountFilters } from './filters';
import { decimalToMicroUsd, effectiveBillingRate, histogramP95, mergeLatencyHistogram, microUsdToDecimal } from './metrics';
import { resolveAccountWindow, type AccountWindow, type AccountWindowKey } from './window';

interface AccountRow {
  id: number;
  sourceAccountId?: string;
  name: string;
  platform: string | null;
  type?: string | null;
  remoteStatus?: string | null;
  schedulable: boolean | null;
  syncState: string;
  groupProjection: unknown;
  lastSyncedAt?: Date | null;
  probeEnabled?: boolean;
  probeStatus?: string | null;
  probeFreshAt?: Date | null;
  probeLastSuccessAt?: Date | null;
  probeBillingScope?: string | null;
  probeResolvedRateMultiplier?: { toString(): string } | null;
  probePeakRateEnabled?: boolean | null;
  probePeakStart?: string | null;
  probePeakEnd?: string | null;
  probePeakRateMultiplier?: { toString(): string } | null;
  probeTimezone?: string | null;
}

interface MetricRow {
  accountId: number;
  bucketStart: Date;
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  durationCount: number;
  durationSumMs: bigint;
  durationHistogram: unknown;
  firstTokenHistogram: unknown;
  inputTokens: bigint;
  cacheReadTokens: bigint;
  cacheCreationTokens: bigint;
  userBilledUsd: unknown;
  accountBilledUsd: unknown;
  errorStatusCounts?: unknown;
  errorPhaseCounts?: unknown;
}

interface MetricRunRow { status: string; scanEnd: Date | null }

interface AccountQueryClient {
  sub2ApiAccount: {
    findMany(args: Record<string, unknown>): Promise<AccountRow[]>;
    findUnique(args: Record<string, unknown>): Promise<AccountRow | null>;
  };
  accountMetricMinute: { findMany(args: Record<string, unknown>): Promise<MetricRow[]> };
  accountSyncRun: { findFirst(args: Record<string, unknown>): Promise<MetricRunRow | null> };
  accountAlertEvent?: { count(args: Record<string, unknown>): Promise<number> };
}

const DEFAULT_FILTERS: AccountFilters = { status: 'schedulable', platform: null, group: null, search: null };

function billingProbe(account: AccountRow) {
  const resolved = account.probeResolvedRateMultiplier?.toString() ?? null;
  const peak = account.probePeakRateMultiplier?.toString() ?? null;
  return {
    enabled: account.probeEnabled ?? false,
    status: account.probeStatus ?? null,
    freshAt: account.probeFreshAt ?? null,
    lastSuccessAt: account.probeLastSuccessAt ?? null,
    resolvedRateMultiplier: resolved,
    peakRateMultiplier: peak,
    currentEffectiveRate: effectiveBillingRate({
      status: account.probeStatus ?? null,
      billingScope: account.probeBillingScope ?? null,
      resolvedRateMultiplier: resolved == null ? null : Number(resolved),
      peakRateEnabled: account.probePeakRateEnabled ?? null,
      peakStart: account.probePeakStart ?? null,
      peakEnd: account.probePeakEnd ?? null,
      peakRateMultiplier: peak == null ? null : Number(peak),
      timezone: account.probeTimezone ?? null,
      receivedAt: account.probeLastSuccessAt ?? null,
      freshUntil: account.probeFreshAt ?? null,
    }),
  };
}

function mergeCounts(values: unknown[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count)) result[key] = (result[key] ?? 0) + count;
    }
  }
  return result;
}

function aggregate(minutes: MetricRow[]) {
  const successCount = minutes.reduce((sum, row) => sum + row.successCount, 0);
  const upstreamErrorCount = minutes.reduce((sum, row) => sum + row.upstreamErrorCount, 0);
  const eligibleCount = minutes.reduce((sum, row) => sum + row.eligibleCount, 0);
  const durationCount = minutes.reduce((sum, row) => sum + row.durationCount, 0);
  const durationSumMs = minutes.reduce((sum, row) => sum + row.durationSumMs, BigInt(0));
  const inputTokens = minutes.reduce((sum, row) => sum + row.inputTokens, BigInt(0));
  const cacheReadTokens = minutes.reduce((sum, row) => sum + row.cacheReadTokens, BigInt(0));
  const cacheCreationTokens = minutes.reduce((sum, row) => sum + row.cacheCreationTokens, BigInt(0));
  const tokenDenominator = inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    successCount,
    upstreamErrorCount,
    eligibleCount,
    availability: eligibleCount === 0 ? null : successCount / eligibleCount,
    errorRate: eligibleCount === 0 ? null : upstreamErrorCount / eligibleCount,
    averageDurationMs: durationCount === 0 ? null : Number(durationSumMs) / durationCount,
    durationP95Ms: histogramP95(mergeLatencyHistogram(minutes.map((row) => (row.durationHistogram ?? {}) as Record<string, number>))),
    firstTokenP95Ms: histogramP95(mergeLatencyHistogram(minutes.map((row) => (row.firstTokenHistogram ?? {}) as Record<string, number>))),
    cacheHitRate: tokenDenominator === BigInt(0) ? null : Number(cacheReadTokens) / Number(tokenDenominator),
    promptTokens: tokenDenominator.toString(),
    userBilledUsd: microUsdToDecimal(minutes.reduce((sum, row) => sum + decimalToMicroUsd(String(row.userBilledUsd)), BigInt(0))),
    accountBilledUsd: microUsdToDecimal(minutes.reduce((sum, row) => sum + decimalToMicroUsd(String(row.accountBilledUsd)), BigInt(0))),
    errorStatusCounts: mergeCounts(minutes.map((row) => row.errorStatusCounts)),
    errorPhaseCounts: mergeCounts(minutes.map((row) => row.errorPhaseCounts)),
  };
}

function coverage(accountIds: number[], minutes: MetricRow[], window: AccountWindow, latestMetricRun: MetricRunRow | null) {
  if (accountIds.length === 0) {
    return { earliestBucket: null, latestBucket: null, expectedMinutes: window.expectedMinutes, actualMinutes: 0, missingMinutes: 0, complete: true, status: 'complete' as const };
  }
  const accountSetByBucket = new Map<number, Set<number>>();
  for (const row of minutes) {
    const time = row.bucketStart.getTime();
    if (!accountSetByBucket.has(time)) accountSetByBucket.set(time, new Set());
    accountSetByBucket.get(time)!.add(row.accountId);
  }
  const completeBuckets: Date[] = [];
  const missingIndexes: number[] = [];
  for (let index = 0; index < window.expectedMinutes; index += 1) {
    const bucket = new Date(window.start.getTime() + index * 60_000);
    if (accountIds.every((id) => accountSetByBucket.get(bucket.getTime())?.has(id))) completeBuckets.push(bucket);
    else missingIndexes.push(index);
  }
  const missingMinutes = missingIndexes.length;
  let status: 'complete' | 'before_backfill' | 'collection_delay' | 'gap' = 'complete';
  if (missingMinutes > 0) {
    const prefixOnly = missingIndexes.every((index, offset) => index === offset);
    const suffixOnly = missingIndexes.every((index, offset) => index === window.expectedMinutes - missingMinutes + offset);
    if (prefixOnly) status = 'before_backfill';
    else if (suffixOnly && (!latestMetricRun?.scanEnd || latestMetricRun.scanEnd < window.end)) status = 'collection_delay';
    else status = 'gap';
  }
  return {
    earliestBucket: completeBuckets.at(0) ?? null,
    latestBucket: completeBuckets.at(-1) ?? null,
    expectedMinutes: window.expectedMinutes,
    actualMinutes: completeBuckets.length,
    missingMinutes,
    complete: missingMinutes === 0,
    status,
  };
}

function minuteDto(rows: MetricRow[], bucketStart: Date, complete = true) {
  return { bucketStart, complete, ...aggregate(rows) };
}

export function buildAccountOverview(input: {
  accounts: AccountRow[];
  minutes: MetricRow[];
  window: AccountWindow;
  filters: AccountFilters;
  latestMetricRun: MetricRunRow | null;
  openAlertCount: number;
}) {
  const accounts = filterAccounts(input.accounts, input.filters);
  const accountIds = accounts.map((account) => account.id);
  const accountIdSet = new Set(accountIds);
  const minutes = input.minutes.filter((row) => accountIdSet.has(row.accountId));
  const minutesByBucket = new Map<number, MetricRow[]>();
  const minutesByAccount = new Map<number, MetricRow[]>();
  for (const row of minutes) {
    const bucket = row.bucketStart.getTime();
    if (!minutesByBucket.has(bucket)) minutesByBucket.set(bucket, []);
    if (!minutesByAccount.has(row.accountId)) minutesByAccount.set(row.accountId, []);
    minutesByBucket.get(bucket)!.push(row);
    minutesByAccount.get(row.accountId)!.push(row);
  }
  const trendStepMinutes = input.window.key === 'last1h' ? 1 : 5;
  const trend = Array.from({ length: Math.ceil(input.window.expectedMinutes / trendStepMinutes) }, (_, index) => {
    const firstMinuteIndex = index * trendStepMinutes;
    const minuteCount = Math.min(trendStepMinutes, input.window.expectedMinutes - firstMinuteIndex);
    const bucketStart = new Date(input.window.start.getTime() + firstMinuteIndex * 60_000);
    const bucketRows: MetricRow[] = [];
    let complete = true;
    for (let offset = 0; offset < minuteCount; offset += 1) {
      const minuteStart = new Date(bucketStart.getTime() + offset * 60_000);
      const rows = minutesByBucket.get(minuteStart.getTime()) ?? [];
      bucketRows.push(...rows);
      const presentAccountIds = new Set(rows.map((row) => row.accountId));
      if (!accountIds.every((id) => presentAccountIds.has(id))) complete = false;
    }
    return minuteDto(bucketRows, bucketStart, complete);
  });
  return {
    window: input.window,
    coverage: coverage(accountIds, minutes, input.window, input.latestMetricRun),
    filters: input.filters,
    summary: {
      selectedAccountCount: accounts.length,
      schedulableAccountCount: accounts.filter((account) => account.syncState === 'ACTIVE' && account.schedulable === true).length,
      ...aggregate(minutes),
    },
    trend,
    accounts: accounts.map((account) => {
      const accountMinutes = minutesByAccount.get(account.id) ?? [];
      return {
        id: account.id,
        sourceAccountId: account.sourceAccountId,
        name: account.name,
        platform: account.platform,
        type: account.type ?? null,
        remoteStatus: account.remoteStatus ?? null,
        schedulable: account.schedulable,
        syncState: account.syncState,
        groupProjection: account.groupProjection,
        lastSyncedAt: account.lastSyncedAt ?? null,
        lastCompleteMinute: accountMinutes.at(-1)?.bucketStart ?? null,
        billingProbe: billingProbe(account),
        metrics: aggregate(accountMinutes),
        metrics24h: aggregate(accountMinutes),
      };
    }),
    openAlertCount: input.openAlertCount,
  };
}

export async function getAccountOverview(
  windowKey: AccountWindowKey = 'today',
  filters: AccountFilters = DEFAULT_FILTERS,
  now = new Date(),
  client: AccountQueryClient = prisma as unknown as AccountQueryClient,
) {
  const window = resolveAccountWindow(windowKey, now);
  const allAccounts = await client.sub2ApiAccount.findMany({ orderBy: [{ syncState: 'asc' }, { name: 'asc' }] });
  const accounts = filterAccounts(allAccounts, filters);
  const accountIds = accounts.map((account) => account.id);
  const minutes = accountIds.length === 0 ? [] : await client.accountMetricMinute.findMany({
    where: { accountId: { in: accountIds }, bucketStart: { gte: window.start, lt: window.end } },
    orderBy: [{ bucketStart: 'asc' }, { accountId: 'asc' }],
  });
  const latestMetricRun = await client.accountSyncRun.findFirst({
    where: { type: { in: ['METRIC', 'REBUILD'] }, status: 'SUCCEEDED' }, orderBy: { finishedAt: 'desc' }, select: { status: true, scanEnd: true },
  });
  const openAlertCount = client.accountAlertEvent && accountIds.length > 0
    ? await client.accountAlertEvent.count({ where: { accountId: { in: accountIds }, resolved: false } })
    : 0;
  return buildAccountOverview({ accounts, minutes, window, filters, latestMetricRun, openAlertCount });
}

export async function listAccountSummaries() {
  return (await getAccountOverview('today', { ...DEFAULT_FILTERS, status: 'all' })).accounts;
}

export async function getAccountDetail(
  id: number,
  windowKey: AccountWindowKey = 'today',
  now = new Date(),
  client: AccountQueryClient = prisma as unknown as AccountQueryClient,
) {
  const window = resolveAccountWindow(windowKey, now);
  const account = await client.sub2ApiAccount.findUnique({ where: { id } });
  if (!account) return null;
  const minutes = await client.accountMetricMinute.findMany({
    where: { accountId: id, bucketStart: { gte: window.start, lt: window.end } },
    orderBy: { bucketStart: 'asc' },
  });
  const latestMetricRun = await client.accountSyncRun.findFirst({
    where: { type: { in: ['METRIC', 'REBUILD'] }, status: 'SUCCEEDED' }, orderBy: { finishedAt: 'desc' }, select: { status: true, scanEnd: true },
  });
  const overview = buildAccountOverview({
    accounts: [account], minutes, window,
    filters: { status: 'all', platform: null, group: null, search: null },
    latestMetricRun, openAlertCount: 0,
  });
  return {
    ...overview.accounts[0],
    window,
    coverage: overview.coverage,
    summary: overview.summary,
    windows: { [windowKey]: overview.summary },
    trend: overview.trend,
    minutes: minutes.map((row) => minuteDto([row], row.bucketStart)),
  };
}
