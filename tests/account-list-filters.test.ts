import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_FILTER_STORAGE_KEY,
  DEFAULT_ACCOUNT_FILTER_PREFERENCES,
  readAccountFilterPreferences,
  readAccountFilterPreferencesSafely,
  reconcileAccountFilterPreferences,
  writeAccountFilterPreferences,
  writeAccountFilterPreferencesSafely,
  type AccountFilterStorage,
} from '../src/lib/account-list-filters';

test('persists only reusable account filters', () => {
  let raw: string | null = null;
  let writtenKey = '';
  const storage: AccountFilterStorage = {
    getItem: () => raw,
    setItem: (key, value) => { writtenKey = key; raw = value; },
  };
  const expected = {
    windowKey: 'today' as const,
    status: 'all' as const,
    platform: 'openai',
    groupId: 7,
    alertGroupsOnly: false,
    pageSize: 20 as const,
  };

  writeAccountFilterPreferences(storage, expected);

  assert.equal(writtenKey, ACCOUNT_FILTER_STORAGE_KEY);
  assert.deepEqual(readAccountFilterPreferences(storage), expected);
  const serialized = JSON.parse(raw ?? '{}') as Record<string, unknown>;
  assert.equal('search' in serialized, false);
  assert.equal('page' in serialized, false);
});

test('rejects incomplete or invalid persisted filter preferences', () => {
  let raw: string | null = null;
  const storage: AccountFilterStorage = {
    getItem: () => raw,
    setItem: (_key, value) => { raw = value; },
  };
  const invalid = [
    null,
    '',
    '{',
    '[]',
    '{}',
    '{"windowKey":"week","status":"all","platform":"","groupId":null,"alertGroupsOnly":true,"pageSize":50}',
    '{"windowKey":"today","status":"retired","platform":"","groupId":null,"pageSize":50}',
    '{"windowKey":"today","status":"all","platform":7,"groupId":null,"pageSize":50}',
    '{"windowKey":"today","status":"all","platform":"openai","groupId":0,"pageSize":50}',
    '{"windowKey":"today","status":"all","platform":"openai","groupId":1.2,"pageSize":50}',
    '{"windowKey":"today","status":"all","platform":"openai","groupId":null,"pageSize":25}',
  ];

  for (const value of invalid) {
    raw = value;
    assert.deepEqual(readAccountFilterPreferences(storage), DEFAULT_ACCOUNT_FILTER_PREFERENCES, String(value));
  }
});

test('tolerates blocked storage and a throwing localStorage getter', () => {
  const blocked: AccountFilterStorage = {
    getItem: () => { throw new DOMException('Access denied', 'SecurityError'); },
    setItem: () => { throw new DOMException('Access denied', 'SecurityError'); },
  };
  const getter = (): AccountFilterStorage => { throw new DOMException('Access denied', 'SecurityError'); };

  assert.deepEqual(readAccountFilterPreferences(blocked), DEFAULT_ACCOUNT_FILTER_PREFERENCES);
  assert.doesNotThrow(() => writeAccountFilterPreferences(blocked, DEFAULT_ACCOUNT_FILTER_PREFERENCES));
  assert.deepEqual(readAccountFilterPreferencesSafely(getter), DEFAULT_ACCOUNT_FILTER_PREFERENCES);
  assert.doesNotThrow(() => writeAccountFilterPreferencesSafely(getter, DEFAULT_ACCOUNT_FILTER_PREFERENCES));
});

test('stale facet values converge once without clearing unrelated preferences', () => {
  const saved = {
    windowKey: 'today' as const,
    status: 'unschedulable' as const,
    platform: 'removed-platform',
    groupId: 99,
    alertGroupsOnly: true,
    pageSize: 100 as const,
  };

  const corrected = reconcileAccountFilterPreferences(saved, {
    platforms: ['openai'],
    groups: [{ id: 7, name: 'Premium' }],
  });

  assert.deepEqual(corrected, {
    windowKey: 'today', status: 'unschedulable', platform: '', groupId: null, alertGroupsOnly: true, pageSize: 100,
  });
  assert.equal(reconcileAccountFilterPreferences(corrected, {
    platforms: ['openai'], groups: [{ id: 7, name: 'Premium' }],
  }), corrected, 'a corrected preference must be stable and must not trigger another correction');
  assert.equal(reconcileAccountFilterPreferences({ ...saved, platform: 'openai', groupId: 7 }, {
    platforms: ['openai'], groups: [{ id: 7, name: 'Premium' }],
  }).groupId, 7);
});
