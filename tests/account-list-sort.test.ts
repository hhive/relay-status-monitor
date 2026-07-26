import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_SORT_KEYS,
  ACCOUNT_SORT_STORAGE_KEY,
  DEFAULT_ACCOUNT_SORT,
  readAccountSortState,
  readAccountSortStateSafely,
  sortAccountSummaries,
  writeAccountSortState,
  writeAccountSortStateSafely,
  type AccountSortKey,
  type AccountSortStorage,
} from '../src/lib/account-list-sort';
import type { AccountSummaryDto } from '../src/lib/account-observability-ui';

const NOW = new Date('2026-07-26T10:05:00Z');

const baseMetrics: AccountSummaryDto['metrics'] = {
  successCount: 0,
  upstreamErrorCount: 0,
  eligibleCount: 0,
  availability: null,
  errorRate: null,
  averageDurationMs: null,
  durationP95Ms: null,
  firstTokenP95Ms: null,
  cacheHitRate: null,
  promptTokens: '0',
  userBilledUsd: '0',
  accountBilledUsd: '0',
  errorStatusCounts: {},
  errorPhaseCounts: {},
};

function metrics(overrides: Partial<AccountSummaryDto['metrics']> = {}): AccountSummaryDto['metrics'] {
  return { ...baseMetrics, ...overrides };
}

function account(id: number, overrides: Partial<AccountSummaryDto> = {}): AccountSummaryDto {
  return {
    id,
    name: `Account ${id}`,
    platform: 'openai',
    type: 'oauth',
    remoteStatus: 'active',
    schedulable: true,
    syncState: 'ACTIVE',
    groupProjection: [],
    lastSyncedAt: '2026-07-26T10:00:00Z',
    lastCompleteMinute: '2026-07-26T10:03:00Z',
    alertEnabled: true,
    billingProbe: {
      enabled: false,
      status: null,
      freshAt: null,
      lastSuccessAt: null,
      resolvedRateMultiplier: null,
      peakRateMultiplier: null,
      currentEffectiveRate: null,
    },
    metrics: metrics(),
    ...overrides,
  };
}

test('defaults to enabled alerts first without mutating input', () => {
  const rows = [
    account(3, { name: 'Beta', alertEnabled: false }),
    account(2, { name: 'Alpha' }),
    account(1, { name: 'Alpha' }),
  ];

  assert.deepEqual(sortAccountSummaries(rows, DEFAULT_ACCOUNT_SORT, NOW).map(({ id }) => id), [1, 2, 3]);
  assert.deepEqual(rows.map(({ id }) => id), [3, 2, 1]);
});

const fieldCases: Record<AccountSortKey, [AccountSummaryDto, AccountSummaryDto]> = {
  account: [account(1, { name: 'Alpha', type: 'oauth' }), account(2, { name: 'Beta', type: 'api_key' })],
  platformGroup: [
    account(1, { platform: 'anthropic', groupProjection: [{ id: 2, name: 'Zulu' }] }),
    account(2, { platform: 'openai', groupProjection: [{ id: 1, name: 'Alpha' }] }),
  ],
  schedulable: [account(1, { schedulable: false }), account(2, { schedulable: true })],
  availability: [account(1, { metrics: metrics({ availability: 0.5 }) }), account(2, { metrics: metrics({ availability: 0.9 }) })],
  errorRate: [account(1, { metrics: metrics({ errorRate: 0.01 }) }), account(2, { metrics: metrics({ errorRate: 0.2 }) })],
  durationP95Ms: [account(1, { metrics: metrics({ durationP95Ms: 100 }) }), account(2, { metrics: metrics({ durationP95Ms: 900 }) })],
  firstTokenP95Ms: [account(1, { metrics: metrics({ firstTokenP95Ms: 50 }) }), account(2, { metrics: metrics({ firstTokenP95Ms: 500 }) })],
  cacheHitRate: [account(1, { metrics: metrics({ cacheHitRate: 0.1 }) }), account(2, { metrics: metrics({ cacheHitRate: 0.8 }) })],
  userBilledUsd: [account(1, { metrics: metrics({ userBilledUsd: '1.01' }) }), account(2, { metrics: metrics({ userBilledUsd: '2.01' }) })],
  accountBilledUsd: [account(1, { metrics: metrics({ accountBilledUsd: '1.01' }) }), account(2, { metrics: metrics({ accountBilledUsd: '2.01' }) })],
  eligibleCount: [account(1, { metrics: metrics({ eligibleCount: 1 }) }), account(2, { metrics: metrics({ eligibleCount: 2 }) })],
  sync: [
    account(1, { lastSyncedAt: '2026-07-26T10:04:00Z', lastCompleteMinute: '2026-07-26T10:03:00Z' }),
    account(2, { lastSyncedAt: '2026-07-26T09:30:00Z', lastCompleteMinute: '2026-07-26T09:30:00Z' }),
  ],
  alertEnabled: [account(1, { alertEnabled: false }), account(2, { alertEnabled: true })],
};

test('supports ascending and descending sort for all 13 fields', () => {
  assert.deepEqual(Object.keys(fieldCases), ACCOUNT_SORT_KEYS);
  for (const key of ACCOUNT_SORT_KEYS) {
    const rows = fieldCases[key];
    assert.deepEqual(sortAccountSummaries(rows, { key, order: 'asc' }, NOW).map(({ id }) => id), [1, 2], `${key} ascending`);
    assert.deepEqual(sortAccountSummaries(rows, { key, order: 'desc' }, NOW).map(({ id }) => id), [2, 1], `${key} descending`);
  }
});

test('keeps null last in either direction and compares decimal strings exactly', () => {
  const availabilityRows = [
    account(1, { metrics: metrics({ availability: null }) }),
    account(2, { metrics: metrics({ availability: 0.9 }) }),
  ];
  const moneyRows = [
    account(1, { metrics: metrics({ userBilledUsd: '9007199254740993.000001' }) }),
    account(2, { metrics: metrics({ userBilledUsd: '9007199254740992.999999' }) }),
  ];

  assert.deepEqual(sortAccountSummaries(availabilityRows, { key: 'availability', order: 'asc' }, NOW).map(({ id }) => id), [2, 1]);
  assert.deepEqual(sortAccountSummaries(availabilityRows, { key: 'availability', order: 'desc' }, NOW).map(({ id }) => id), [2, 1]);
  assert.deepEqual(sortAccountSummaries(moneyRows, { key: 'userBilledUsd', order: 'desc' }, NOW).map(({ id }) => id), [1, 2]);
});

test('uses platform then formatted groups and stale state then sync timestamp', () => {
  const platformRows = [
    account(2, { name: 'Same', platform: 'openai', groupProjection: [{ name: 'Zulu' }] }),
    account(1, { name: 'Same', platform: 'openai', groupProjection: [{ name: 'Alpha' }] }),
  ];
  const syncRows = [
    account(1, { lastSyncedAt: '2026-07-26T09:58:00Z', lastCompleteMinute: '2026-07-26T10:03:00Z' }),
    account(2, { lastSyncedAt: '2026-07-26T10:04:00Z', lastCompleteMinute: '2026-07-26T10:03:00Z' }),
    account(3, { lastSyncedAt: '2026-07-26T09:30:00Z', lastCompleteMinute: '2026-07-26T09:30:00Z' }),
    account(4, { lastSyncedAt: null, lastCompleteMinute: '2026-07-26T09:30:00Z' }),
  ];

  assert.deepEqual(sortAccountSummaries(platformRows, { key: 'platformGroup', order: 'asc' }, NOW).map(({ id }) => id), [1, 2]);
  assert.deepEqual(sortAccountSummaries(syncRows, { key: 'sync', order: 'asc' }, NOW).map(({ id }) => id), [1, 2, 3, 4]);
  assert.deepEqual(sortAccountSummaries(syncRows, { key: 'sync', order: 'desc' }, NOW).map(({ id }) => id), [3, 2, 1, 4]);
});

test('uses name and id as a stable direction-independent tie-breaker', () => {
  const rows = [account(3, { name: 'Beta' }), account(2, { name: 'Alpha' }), account(1, { name: 'Alpha' })];

  assert.deepEqual(sortAccountSummaries(rows, { key: 'availability', order: 'asc' }, NOW).map(({ id }) => id), [1, 2, 3]);
  assert.deepEqual(sortAccountSummaries(rows, { key: 'availability', order: 'desc' }, NOW).map(({ id }) => id), [1, 2, 3]);
});

test('persists only whitelisted state and tolerates corrupt or blocked storage', () => {
  let raw: string | null = null;
  let writtenKey = '';
  const storage: AccountSortStorage & { set(value: string): void } = {
    getItem: () => raw,
    setItem: (key, value) => { writtenKey = key; raw = value; },
    set: (value) => { raw = value; },
  };
  const throwingStorage: AccountSortStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };

  writeAccountSortState(storage, { key: 'durationP95Ms', order: 'desc' });
  assert.equal(writtenKey, ACCOUNT_SORT_STORAGE_KEY);
  assert.deepEqual(readAccountSortState(storage), { key: 'durationP95Ms', order: 'desc' });

  for (const value of [null, '', '{', '{"key":"secret","order":"desc"}', '{"key":"account","order":"sideways"}', '[]']) {
    storage.set(value ?? '');
    assert.deepEqual(readAccountSortState(storage), DEFAULT_ACCOUNT_SORT);
  }
  assert.deepEqual(readAccountSortState(throwingStorage), DEFAULT_ACCOUNT_SORT);
  assert.doesNotThrow(() => writeAccountSortState(throwingStorage, DEFAULT_ACCOUNT_SORT));
});

test('tolerates a storage property getter that throws before storage is returned', () => {
  const getBlockedStorage = (): AccountSortStorage => {
    throw new DOMException('Access denied', 'SecurityError');
  };

  assert.deepEqual(readAccountSortStateSafely(getBlockedStorage), DEFAULT_ACCOUNT_SORT);
  assert.doesNotThrow(() => writeAccountSortStateSafely(getBlockedStorage, { key: 'account', order: 'asc' }));
});
