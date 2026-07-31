import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';

import { ACCOUNT_SORT_KEYS } from '../src/lib/account-list-sort';
import {
  AccountSnapshotUnavailableError,
  buildAccountListPageQuery,
  getAccountList,
  parseAccountListQuery,
} from '../src/lib/account-observability/account-list-query';

function sqlText(query: { strings?: readonly string[] }): string {
  return query.strings?.join('?') ?? '';
}

test('list query parser applies safe defaults and rejects invalid paging or sorting before SQL construction', () => {
  const defaults = parseAccountListQuery(new URLSearchParams());
  assert.deepEqual(defaults, {
    windowKey: 'last1h',
    filters: { status: 'schedulable', platform: null, groupId: null, search: null, alertGroupsOnly: true },
    page: 1,
    pageSize: 50,
    sort: { key: 'alertEnabled', order: 'desc' },
  });

  for (const query of ['page=0', 'page=-1', 'page=1.2', 'pageSize=10', 'groupId=0', 'groupId=1.2', 'groupId=7x', 'sortKey=name;DROP TABLE x', 'sortOrder=sideways']) {
    assert.throws(() => parseAccountListQuery(new URLSearchParams(query)), /invalid/i, query);
  }
  assert.throws(() => buildAccountListPageQuery({ ...defaults, sort: { key: 'injected' as never, order: 'asc' } }, 1, 0), /invalid/i);
  assert.equal(parseAccountListQuery(new URLSearchParams('alertGroupsOnly=false')).filters.alertGroupsOnly, false);
  assert.throws(() => parseAccountListQuery(new URLSearchParams('alertGroupsOnly=yes')), /invalid/i);
});

test('default list SQL requires at least one alert-enabled group', () => {
  const enabledOnly = buildAccountListPageQuery(parseAccountListQuery(new URLSearchParams()), 7, 0);
  const enabledSql = sqlText(enabledOnly);
  assert.match(enabledSql, /EXISTS/);
  assert.match(enabledSql, /LEFT JOIN "GroupAlertSetting"/);
  assert.match(enabledSql, /alert_group\."groupId"/);
  assert.match(enabledSql, /alert_group\."alertEnabled" IS DISTINCT FROM false/);
  const all = buildAccountListPageQuery(parseAccountListQuery(new URLSearchParams('alertGroupsOnly=false')), 7, 0);
  assert.doesNotMatch(sqlText(all), /GroupAlertSetting/);
});

test('all fifteen sort keys use fixed SQL with NULLS LAST and deterministic account ties', () => {
  const input = parseAccountListQuery(new URLSearchParams('status=all'));
  const requestNow = new Date('2026-07-26T12:34:56.789Z');
  assert.equal(ACCOUNT_SORT_KEYS.length, 15);
  for (const key of ACCOUNT_SORT_KEYS) {
    for (const order of ['asc', 'desc'] as const) {
      const query = buildAccountListPageQuery({ ...input, sort: { key, order } }, 7, 0, requestNow);
      const text = sqlText(query);
      assert.match(text, new RegExp(`\\b${order.toUpperCase()} NULLS LAST`), `${key} ${order}`);
      assert.match(text, /LOWER\(a\."name"\) ASC/);
      assert.match(text, /a\."id" ASC/);
      assert.doesNotMatch(text, /DROP TABLE|injected/);
    }
  }
});

test('sync sorting uses one request time and the same account and metric freshness rules as presentation', () => {
  const input = parseAccountListQuery(new URLSearchParams('status=all&sortKey=sync&sortOrder=desc'));
  const requestNow = new Date('2026-07-26T12:34:56.789Z');
  const query = buildAccountListPageQuery(input, 7, 0, requestNow);
  const text = sqlText(query);

  assert.match(text, /a\."lastSyncedAt" IS NULL/);
  assert.match(text, /s\."lastCompleteMinute" IS NULL/);
  assert.match(text, /a\."lastSyncedAt" < \?/);
  assert.match(text, /s\."lastCompleteMinute" < \?/);
  assert.doesNotMatch(text, /a\."schedulable" = (?:true|false)/);
  assert.doesNotMatch(text, /CURRENT_TIMESTAMP/);
  assert.deepEqual(query.values?.filter((value) => value instanceof Date), [
    new Date('2026-07-26T12:24:56.789Z'),
    new Date('2026-07-26T12:31:56.789Z'),
  ]);
});

test('priority sorting uses the synchronized local account projection', () => {
  const input = parseAccountListQuery(new URLSearchParams('status=all&sortKey=priority&sortOrder=asc'));
  const text = sqlText(buildAccountListPageQuery(input, 7, 0));
  assert.match(text, /a\."priority" ASC NULLS LAST/);
});

test('list SQL uses exact group IDs, ordered JSON groups, snapshot-aware sorting, and a left join', () => {
  const input = parseAccountListQuery(new URLSearchParams('status=all&platform=openai&groupId=7&search=a_b'));
  const query = buildAccountListPageQuery(input, 7, 0);
  const text = sqlText(query);
  assert.match(text, /jsonb_array_elements/);
  assert.match(text, /WITH ORDINALITY/);
  assert.match(text, /group_sort_text/);
  assert.match(text, /group_filter_text/);
  assert.match(text, /BTRIM\(item\.value->>'name'\)/i);
  assert.match(text, /分组 #/);
  assert.match(text, /string_agg\([^\n]*, '、' ORDER BY/i);
  assert.match(text, /COALESCE\(groups\.group_sort_text, '无分组'\)/);
  assert.match(text, /item\.value->>'id'/);
  assert.match(text, /EXISTS/);
  assert.match(text, /LEFT JOIN "AccountMetricSnapshot" s/);
  assert.match(text, /s\."id"/);
  assert.doesNotMatch(text, /COALESCE\(s\."availability", 0\)/);
  assert.ok(query.values?.includes('7'));
  assert.ok(query.values?.includes('a_b'));
});

test('account list runs batch, platform and group facets, count, and page in one repeatable-read transaction', async () => {
  const order: string[] = [];
  const queries: string[] = [];
  let isolationLevel: string | undefined;
  const client = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>, options: { isolationLevel: string }) => {
      isolationLevel = options.isolationLevel;
      return work(tx);
    },
  };
  const tx = {
    accountMetricSnapshotBatch: {
      findFirst: async () => {
        order.push('batch');
        return {
          id: 41, windowKey: 'LAST_1H', windowStart: new Date('2026-07-26T11:00:00Z'),
          windowEnd: new Date('2026-07-26T12:00:00Z'), lastCompleteMinute: new Date('2026-07-26T11:59:00Z'),
          computedAt: new Date('2026-07-26T12:00:05Z'), active: true,
        };
      },
    },
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const text = sqlText(query);
      queries.push(text);
      if (queries.length === 1) { order.push('platform-facets'); return [{ platform: 'anthropic' }, { platform: 'openai' }]; }
      if (queries.length === 2) { order.push('group-facets'); return [
        { id: '7', name: 'Premium' }, { id: '8', name: 'Fallback' },
        { id: '10', name: 'Same' }, { id: '2', name: 'Same' },
      ]; }
      if (queries.length === 3) { order.push('count'); return [{ total: BigInt(101) }]; }
      order.push('page');
      return [{
        id: 9, name: 'New account', platform: 'openai', type: null, remoteStatus: null,
        schedulable: true, priority: 7, syncState: 'ACTIVE', groupProjection: [], lastSyncedAt: null,
        alertEnabled: true, snapshotId: 77, eligibleCount: null, availability: null, errorRate: null,
        durationP95Ms: null, firstTokenP95Ms: null, cacheHitRate: null,
        userBilledUsd: null, accountBilledUsd: null, balanceUsd: null,
        upstreamRateMultiplier: '1.25000000', upstreamRateSource: 'estimated',
        lastCompleteMinute: new Date('2026-07-26T11:59:00Z'),
      }];
    },
  };
  Object.assign(client, { $transaction: async (work: (value: typeof tx) => Promise<unknown>, options: { isolationLevel: string }) => {
    isolationLevel = options.isolationLevel;
    return work(tx);
  } });

  const result = await getAccountList(parseAccountListQuery(new URLSearchParams('page=99&pageSize=50&platform=openai')), client as never);
  assert.equal(isolationLevel, 'RepeatableRead');
  assert.deepEqual(order, ['batch', 'platform-facets', 'group-facets', 'count', 'page']);
  assert.deepEqual(result.facets.platforms, ['anthropic', 'openai']);
  assert.deepEqual(result.facets.groups, [
    { id: 8, name: 'Fallback' }, { id: 7, name: 'Premium' },
    { id: 2, name: 'Same' }, { id: 10, name: 'Same' },
  ]);
  assert.deepEqual(result.pagination, { page: 3, pageSize: 50, totalItems: 101, totalPages: 3 });
  assert.match(queries[0], /group_filter_text/);
  assert.doesNotMatch(queries[0], /a\."platform" =/i, 'facet SQL must ignore the selected platform');
  assert.match(queries[0], /a\."syncState" = 'ACTIVE'/, 'platform facets must exclude retired accounts');
  assert.doesNotMatch(queries[0], /a\."schedulable"|strpos\(/i, 'platform facets must ignore current status and search filters');
  assert.match(queries[1], /jsonb_array_elements/);
  assert.match(queries[1], /a\."syncState" = 'ACTIVE'/, 'group facets must exclude stale projections on retired accounts');
  assert.doesNotMatch(queries[1], /a\."platform" =/i, 'group facets must ignore selected filters');
  assert.match(queries[2], /lower\(a\."platform"\) = lower\(\?\)/i);
  assert.match(queries[3], /LEFT JOIN "AccountMetricSnapshot" s/);
  assert.equal(result.accounts[0].metrics.eligibleCount, 0);
  assert.equal(result.accounts[0].priority, 7);
  assert.equal(result.accounts[0].metrics.userBilledUsd, '0.000000');
  assert.equal(result.accounts[0].metrics.accountBilledUsd, '0.000000');
  assert.equal(result.accounts[0].metrics.availability, null);
  assert.equal(result.accounts[0].metrics.upstreamRateMultiplier, '1.25000000');
  assert.equal(result.accounts[0].metrics.upstreamRateSource, 'estimated');
  assert.equal(result.accounts[0].lastCompleteMinute, '2026-07-26T11:59:00.000Z');
  assert.deepEqual(result.snapshot, {
    computedAt: '2026-07-26T12:00:05.000Z',
    lastCompleteMinute: '2026-07-26T11:59:00.000Z',
  });
});

test('empty result converges to page one without inventing pages', async () => {
  let queryNumber = 0;
  const tx = {
    accountMetricSnapshotBatch: { findFirst: async () => ({
      id: 1, windowKey: 'LAST_1H', windowStart: new Date('2026-07-26T11:00:00Z'),
      windowEnd: new Date('2026-07-26T12:00:00Z'), lastCompleteMinute: null,
      computedAt: new Date('2026-07-26T12:00:05Z'), active: true,
    }) },
    $queryRaw: async () => (++queryNumber <= 2 ? [] : queryNumber === 3 ? [{ total: BigInt(0) }] : []),
  };
  const client = { $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) };
  const result = await getAccountList(parseAccountListQuery(new URLSearchParams('page=8')), client as never);
  assert.deepEqual(result.pagination, { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
  assert.deepEqual(result.accounts, []);
  assert.equal(result.window.lastCompleteMinute, null);
  assert.deepEqual(result.snapshot, {
    computedAt: '2026-07-26T12:00:05.000Z',
    lastCompleteMinute: null,
  });
});

test('missing active snapshot batch raises the dedicated unavailable error before SQL queries', async () => {
  let queried = false;
  const tx = {
    accountMetricSnapshotBatch: { findFirst: async () => null },
    $queryRaw: async () => { queried = true; return []; },
  };
  const client = { $transaction: async (work: (value: typeof tx) => Promise<unknown>) => work(tx) };
  await assert.rejects(
    getAccountList(parseAccountListQuery(new URLSearchParams()), client as never),
    AccountSnapshotUnavailableError,
  );
  assert.equal(queried, false);
});

const listIntegrationDatabaseUrl = process.env.ACCOUNT_LIST_TEST_DATABASE_URL;

test('PostgreSQL executes every account sort and preserves list semantics', {
  skip: !listIntegrationDatabaseUrl,
  timeout: 20_000,
}, async () => {
  const client = new PrismaClient({ datasourceUrl: listIntegrationDatabaseUrl });
  const now = new Date('2026-07-26T12:34:56.789Z');
  try {
    await client.accountMetricSnapshot.deleteMany();
    await client.accountMetricSnapshotBatch.deleteMany();
    await client.sub2ApiAccount.deleteMany();
    await client.sub2ApiAccount.createMany({ data: [
      {
        id: 101, sourceAccountId: 'list-test-101', name: 'Alpha', platform: 'OpenAI',
        schedulable: true, lastSyncedAt: new Date('2026-07-26T12:34:00Z'),
        groupProjection: [{ id: 2, name: '  Alpha group  ' }],
      },
      {
        id: 102, sourceAccountId: 'list-test-102', name: 'Beta', platform: 'OpenAI',
        schedulable: true, lastSyncedAt: new Date('2026-07-26T12:20:00Z'),
        groupProjection: [{ id: 3, name: 'Beta group' }],
      },
      {
        id: 103, sourceAccountId: 'list-test-103', name: 'Gamma', platform: 'Anthropic',
        schedulable: true, lastSyncedAt: new Date('2026-07-26T12:34:00Z'),
        groupProjection: [{ id: 4, name: '   ' }],
      },
      {
        id: 104, sourceAccountId: 'list-test-104', name: 'No snapshot', platform: 'Google',
        schedulable: true, lastSyncedAt: new Date('2026-07-26T12:34:00Z'), groupProjection: [],
      },
    ] });
    const batch = await client.accountMetricSnapshotBatch.create({ data: {
      windowKey: 'LAST_1H', windowStart: new Date('2026-07-26T11:34:00Z'),
      windowEnd: new Date('2026-07-26T12:34:00Z'), lastCompleteMinute: new Date('2026-07-26T12:33:00Z'),
      computedAt: new Date('2026-07-26T12:34:30Z'), active: true,
    } });
    await client.accountMetricSnapshot.createMany({ data: [
      {
        batchId: batch.id, accountId: 101, eligibleCount: 100, availability: 0.99,
        errorRate: 0.01, durationP95Ms: 100, firstTokenP95Ms: 50, cacheHitRate: 0.8,
        userBilledUsd: '9007199254.740991', accountBilledUsd: '2.000001',
        lastCompleteMinute: new Date('2026-07-26T12:33:00Z'),
      },
      {
        batchId: batch.id, accountId: 102, eligibleCount: 200, availability: 0.98,
        errorRate: 0.02, durationP95Ms: 200, firstTokenP95Ms: 60, cacheHitRate: 0.7,
        userBilledUsd: '9007199254.740992', accountBilledUsd: '2.000002',
        lastCompleteMinute: new Date('2026-07-26T12:33:00Z'),
      },
      {
        batchId: batch.id, accountId: 103, eligibleCount: 300, availability: 0.97,
        errorRate: 0.03, durationP95Ms: 300, firstTokenP95Ms: 70, cacheHitRate: 0.6,
        userBilledUsd: '9007199254.740993', accountBilledUsd: '2.000003',
        lastCompleteMinute: new Date('2026-07-26T12:30:00Z'),
      },
    ] });

    for (const key of ACCOUNT_SORT_KEYS) {
      for (const order of ['asc', 'desc'] as const) {
        const input = parseAccountListQuery(new URLSearchParams(`status=all&pageSize=20&sortKey=${key}&sortOrder=${order}`));
        const result = await getAccountList(input, client as never, now);
        assert.equal(result.accounts.length, 4, `${key} ${order}`);
        if (['availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate',
          'userBilledUsd', 'accountBilledUsd', 'eligibleCount'].includes(key)) {
          assert.equal(result.accounts.at(-1)?.id, 104, `${key} ${order} must keep a missing snapshot last`);
        }
      }
    }

    const syncDescending = await getAccountList(
      parseAccountListQuery(new URLSearchParams('status=all&pageSize=20&sortKey=sync&sortOrder=desc')),
      client as never,
      now,
    );
    assert.deepEqual(syncDescending.accounts.map((account) => account.id), [102, 103, 101, 104]);

    const platformGroup = await getAccountList(
      parseAccountListQuery(new URLSearchParams('status=all&pageSize=20&sortKey=platformGroup&sortOrder=asc')),
      client as never,
      now,
    );
    assert.deepEqual(platformGroup.accounts.filter((account) => account.platform === 'OpenAI').map((account) => account.id), [101, 102]);

    const filtered = await getAccountList(
      parseAccountListQuery(new URLSearchParams(
        'status=all&pageSize=20&platform=OpenAI&groupId=2&sortKey=userBilledUsd&sortOrder=desc',
      )),
      client as never,
      now,
    );
    assert.deepEqual(filtered.facets.platforms, ['Anthropic', 'Google', 'OpenAI']);
    assert.deepEqual(filtered.facets.groups, [
      { id: 2, name: 'Alpha group' }, { id: 3, name: 'Beta group' },
    ]);
    assert.equal(filtered.pagination.totalItems, 1);
    assert.deepEqual(filtered.accounts.map((account) => account.id), [101]);
  } finally {
    await client.$disconnect();
  }
});
