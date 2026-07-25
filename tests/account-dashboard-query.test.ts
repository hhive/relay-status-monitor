import assert from 'node:assert/strict';
import test from 'node:test';

import { filterAccounts, parseAccountFilters } from '../src/lib/account-observability/filters';
import { buildAccountOverview, getAccountDetail } from '../src/lib/account-observability/query';
import { resolveAccountWindow } from '../src/lib/account-observability/window';

const accounts = [
  { id: 1, name: 'Alpha', platform: 'openai', syncState: 'ACTIVE', schedulable: true, groupProjection: [{ id: 7, name: 'Premium' }] },
  { id: 2, name: 'Beta', platform: 'anthropic', syncState: 'ACTIVE', schedulable: false, groupProjection: [{ id: 8, name: 'Fallback' }] },
  { id: 3, name: 'Retired', platform: 'openai', syncState: 'RETIRED', schedulable: false, groupProjection: [] },
];

test('server windows end at the latest complete minute and reject unknown keys', () => {
  const now = new Date('2026-07-25T12:34:56.789Z');
  assert.deepEqual(resolveAccountWindow('last1h', now), {
    key: 'last1h', label: '近 1 小时', start: new Date('2026-07-25T11:34:00.000Z'),
    end: new Date('2026-07-25T12:34:00.000Z'), lastCompleteMinute: new Date('2026-07-25T12:33:00.000Z'), expectedMinutes: 60,
  });
  assert.equal(resolveAccountWindow('last24h', now).expectedMinutes, 1440);
  assert.equal(resolveAccountWindow('today', now).start.toISOString(), '2026-07-24T16:00:00.000Z');
  assert.throws(() => resolveAccountWindow('week' as never, now), /window/i);
});

test('status, platform, group, and search filters apply to the same account collection', () => {
  assert.deepEqual(filterAccounts(accounts, parseAccountFilters(new URLSearchParams())).map((row) => row.id), [1]);
  assert.deepEqual(filterAccounts(accounts, parseAccountFilters(new URLSearchParams('status=unschedulable'))).map((row) => row.id), [2]);
  assert.deepEqual(filterAccounts(accounts, parseAccountFilters(new URLSearchParams('status=all&platform=openai&group=Premium&search=alpha'))).map((row) => row.id), [1]);
  assert.throws(() => parseAccountFilters(new URLSearchParams('status=retired')), /status/i);
});

test('overview aggregates raw counts and histograms and reports coverage for the filtered account set', () => {
  const window = {
    key: 'last1h' as const, label: '近 1 小时', start: new Date('2026-07-25T12:00:00Z'),
    end: new Date('2026-07-25T12:02:00Z'), lastCompleteMinute: new Date('2026-07-25T12:01:00Z'), expectedMinutes: 2,
  };
  const minute = (accountId: number, bucketStart: string, values: Record<string, unknown>) => ({
    accountId, bucketStart: new Date(bucketStart), successCount: 0, upstreamErrorCount: 0, eligibleCount: 0,
    durationCount: 0, durationSumMs: BigInt(0), durationHistogram: {}, firstTokenHistogram: {},
    inputTokens: BigInt(0), cacheReadTokens: BigInt(0), cacheCreationTokens: BigInt(0),
    userBilledUsd: '0', accountBilledUsd: '0', errorStatusCounts: {}, errorPhaseCounts: {}, ...values,
  });
  const result = buildAccountOverview({
    accounts: accounts.slice(0, 2), window,
    filters: { status: 'all', platform: null, group: null, search: null },
    minutes: [
      minute(1, '2026-07-25T12:00:00Z', { successCount: 90, upstreamErrorCount: 10, eligibleCount: 100, durationCount: 100, durationSumMs: BigInt(10_000), durationHistogram: { '100': 95, '1000': 5 }, userBilledUsd: '9007199254.740991', accountBilledUsd: '1.000001' }),
      minute(2, '2026-07-25T12:00:00Z', { successCount: 0, upstreamErrorCount: 1, eligibleCount: 1, durationCount: 100, durationSumMs: BigInt(200_000), durationHistogram: { '2000': 100 }, inputTokens: BigInt(100), cacheReadTokens: BigInt(25), cacheCreationTokens: BigInt(5), userBilledUsd: '0.000009', accountBilledUsd: '2.000009' }),
      minute(1, '2026-07-25T12:01:00Z', {}),
    ],
    latestMetricRun: { status: 'SUCCEEDED', scanEnd: new Date('2026-07-25T12:02:00Z') },
    openAlertCount: 2,
  });

  assert.equal(result.summary.availability, 90 / 101, 'percentages must use total counts instead of averaging accounts');
  assert.equal(result.summary.durationP95Ms, 2000, 'P95 must merge histograms instead of averaging minute P95 values');
  assert.equal(result.summary.userBilledUsd, '9007199254.741000', 'Decimal totals must not pass through Number');
  assert.equal(result.summary.accountBilledUsd, '3.000010');
  assert.equal(result.summary.promptTokens, '130');
  assert.equal(result.summary.selectedAccountCount, 2);
  assert.equal(result.summary.schedulableAccountCount, 1);
  assert.deepEqual(result.coverage, {
    earliestBucket: new Date('2026-07-25T12:00:00Z'), latestBucket: new Date('2026-07-25T12:00:00Z'),
    expectedMinutes: 2, actualMinutes: 1, missingMinutes: 1, complete: false, status: 'gap',
  });
  assert.equal(result.trend.length, 2);
  assert.equal(result.trend[0].complete, true);
  assert.equal(result.trend[1].complete, false);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.openAlertCount, 2);
});

test('today and 24 hour trends use stable five-minute buckets while one hour stays minute-grained', () => {
  const start = new Date('2026-07-25T12:00:00Z');
  const rows = Array.from({ length: 10 }, (_, index) => ({
    accountId: 1,
    bucketStart: new Date(start.getTime() + index * 60_000),
    successCount: 1,
    upstreamErrorCount: 0,
    eligibleCount: 1,
    durationCount: 1,
    durationSumMs: BigInt(100),
    durationHistogram: { '100': 1 },
    firstTokenHistogram: { '50': 1 },
    inputTokens: BigInt(10),
    cacheReadTokens: BigInt(2),
    cacheCreationTokens: BigInt(0),
    userBilledUsd: '0.000001',
    accountBilledUsd: '0.000001',
  }));
  const base = {
    accounts: [accounts[0]],
    minutes: rows,
    filters: { status: 'all' as const, platform: null, group: null, search: null },
    latestMetricRun: { status: 'SUCCEEDED', scanEnd: new Date('2026-07-25T12:10:00Z') },
    openAlertCount: 0,
  };
  const window = (key: 'last1h' | 'last24h') => ({ key, label: key, start, end: new Date('2026-07-25T12:10:00Z'), lastCompleteMinute: new Date('2026-07-25T12:09:00Z'), expectedMinutes: 10 });

  assert.equal(buildAccountOverview({ ...base, window: window('last1h') }).trend.length, 10);
  const day = buildAccountOverview({ ...base, window: window('last24h') });
  assert.equal(day.trend.length, 2);
  assert.equal(day.trend[0].eligibleCount, 5);
  assert.equal(day.trend[0].promptTokens, '60');
});

test('coverage distinguishes pre-backfill gaps from collection delay', () => {
  const window = {
    key: 'last1h' as const, label: '近 1 小时', start: new Date('2026-07-25T12:00:00Z'),
    end: new Date('2026-07-25T12:02:00Z'), lastCompleteMinute: new Date('2026-07-25T12:01:00Z'), expectedMinutes: 2,
  };
  const row = (bucketStart: string) => ({
    accountId: 1, bucketStart: new Date(bucketStart), successCount: 0, upstreamErrorCount: 0, eligibleCount: 0,
    durationCount: 0, durationSumMs: BigInt(0), durationHistogram: {}, firstTokenHistogram: {}, inputTokens: BigInt(0),
    cacheReadTokens: BigInt(0), cacheCreationTokens: BigInt(0), userBilledUsd: '0', accountBilledUsd: '0',
  });
  const base = { accounts: [accounts[0]], window, filters: { status: 'all' as const, platform: null, group: null, search: null }, openAlertCount: 0 };
  assert.equal(buildAccountOverview({ ...base, minutes: [row('2026-07-25T12:01:00Z')], latestMetricRun: null }).coverage.status, 'before_backfill');
  assert.equal(buildAccountOverview({ ...base, minutes: [row('2026-07-25T12:00:00Z')], latestMetricRun: { status: 'SUCCEEDED', scanEnd: new Date('2026-07-25T12:01:00Z') } }).coverage.status, 'collection_delay');
});

test('account detail queries only the requested server window', async () => {
  let minuteWhere: Record<string, unknown> | undefined;
  const client = {
    sub2ApiAccount: { findUnique: async () => ({ ...accounts[0], sourceAccountId: 'remote-1' }) },
    accountMetricMinute: { findMany: async (args: { where: Record<string, unknown> }) => { minuteWhere = args.where; return []; } },
    accountSyncRun: { findFirst: async () => null },
  };
  const detail = await getAccountDetail(1, 'last1h', new Date('2026-07-25T12:34:56Z'), client as never);

  assert.ok(detail);
  assert.deepEqual((minuteWhere?.bucketStart as { gte: Date; lt: Date }), {
    gte: new Date('2026-07-25T11:34:00Z'), lt: new Date('2026-07-25T12:34:00Z'),
  });
  assert.equal(detail.window.key, 'last1h');
  assert.equal(detail.minutes.length, 0);
});
