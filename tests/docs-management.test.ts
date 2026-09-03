import assert from 'node:assert/strict';
import test from 'node:test';
import { isDocsAdminSession, requestDocsSync, resetDocsSyncState } from '../src/lib/docs-management';

test('docs management is restricted to Sub2API admin sessions', () => {
  assert.equal(isDocsAdminSession({ source: 'sub2api', userId: 1, username: 'admin', email: 'a@b.test', csrfToken: 'x' }), true);
  assert.equal(isDocsAdminSession({ source: 'local', userId: 1, username: 'local', sessionVersion: 1 }), false);
  assert.equal(isDocsAdminSession(null), false);
});

test('docs sync requests are idempotent while running', () => {
  resetDocsSyncState();
  const first = requestDocsSync();
  const second = requestDocsSync();
  assert.equal(first.status, 'running');
  assert.deepEqual(second, first);
  resetDocsSyncState();
});
