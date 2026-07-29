import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_SORT_KEYS,
  ACCOUNT_SORT_LABELS,
  ACCOUNT_SORT_STORAGE_KEY,
  DEFAULT_ACCOUNT_SORT,
  readAccountSortState,
  readAccountSortStateSafely,
  writeAccountSortState,
  writeAccountSortStateSafely,
  type AccountSortStorage,
} from '../src/lib/account-list-sort';

test('keeps the complete server sort whitelist and default', () => {
  assert.deepEqual(ACCOUNT_SORT_KEYS, [
    'account', 'platformGroup', 'schedulable', 'availability',
    'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'userBilledUsd',
    'accountBilledUsd', 'balanceUsd', 'upstreamRateMultiplier', 'eligibleCount', 'sync', 'alertEnabled',
  ]);
  assert.deepEqual(Object.keys(ACCOUNT_SORT_LABELS), ACCOUNT_SORT_KEYS);
  assert.deepEqual(DEFAULT_ACCOUNT_SORT, { key: 'alertEnabled', order: 'desc' });
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
