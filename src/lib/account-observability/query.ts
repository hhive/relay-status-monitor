import { prisma } from '../db';
import { filterAccounts, type AccountFilters } from './filters';
import { aggregateMetricMinutes } from './metric-aggregate';
import { effectiveBillingRate } from './metrics';
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
  alertEnabled?: boolean;
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
  balanceUsd?: unknown;
  upstreamRateMultiplier?: unknown;
  upstreamEstimatedRateMultiplier?: unknown;
  upstreamRateSource?: string | null;
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

const DEFAULT_FILTERS: AccountFilters = { status: 'schedulable', platform: null, groupId: null, search: null };

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
  return { bucketStart, complete, ...aggregateMetricMinutes(rows) };
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
      ...aggregateMetricMinutes(minutes),
    },
    trend,
    accounts: accounts.map((account) => {
      const accountMinutes = minutesByAccount.get(account.id) ?? [];
      const latest = accountMinutes.at(-1);
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
        alertEnabled: account.alertEnabled ?? true,
        lastCompleteMinute: accountMinutes.at(-1)?.bucketStart ?? null,
        billingProbe: billingProbe(account),
        upstream: {
          balanceUsd: latest?.balanceUsd == null ? null : String(latest.balanceUsd),
          rateMultiplier: latest?.upstreamRateMultiplier == null ? null : String(latest.upstreamRateMultiplier),
          apiRateMultiplier: latest?.upstreamRateSource === 'api' && latest.upstreamRateMultiplier != null
            ? String(latest.upstreamRateMultiplier) : null,
          estimatedRateMultiplier: latest?.upstreamEstimatedRateMultiplier != null
            ? String(latest.upstreamEstimatedRateMultiplier)
            : latest?.upstreamRateSource === 'estimated' && latest.upstreamRateMultiplier != null
              ? String(latest.upstreamRateMultiplier) : null,
          upstreamRateSource: latest?.upstreamRateSource ?? null,
          collectedAt: latest?.bucketStart ?? null,
        },
        metrics: aggregateMetricMinutes(accountMinutes),
        metrics24h: aggregateMetricMinutes(accountMinutes),
      };
    }),
    openAlertCount: input.openAlertCount,
  };
}

export async function getAccountOverview(
  windowKey: AccountWindowKey = 'last1h',
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
  windowKey: AccountWindowKey = 'last1h',
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
    filters: { status: 'all', platform: null, groupId: null, search: null },
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
