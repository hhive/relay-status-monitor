import assert from 'node:assert/strict';
import test from 'node:test';

import { syncSub2ApiAccounts } from '../src/lib/account-observability/sync';

test('full account sync retires missing accounts without deleting history and isolates dirty rows', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];
  let deleted = false;
  const monitor = {
    accountSyncRun: {
      create: async () => ({ id: 9 }),
      update: async (args: Record<string, unknown>) => { updates.push(args); },
    },
    sub2ApiAccount: {
      upsert: async (args: Record<string, unknown>) => { upserts.push(args); },
      updateMany: async (args: Record<string, unknown>) => { updates.push(args); return { count: 1 }; },
      deleteMany: async () => { deleted = true; },
    },
  };
  const read = {
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(read),
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [
      { source_account_id: 'active-1', name: 'Healthy', remote_status: 'active' },
      { source_account_id: '', name: 'Dirty', remote_status: 'active' },
      { source_account_id: 'dirty-rate', name: 'Dirty Rate', remote_status: 'active', probe_resolved_rate_multiplier: 'not-a-decimal' },
    ],
    $disconnect: async () => {},
  };

  const result = await syncSub2ApiAccounts(read as never, monitor as never);

  assert.deepEqual(result, { readCount: 3, ignoredCount: 2 });
  assert.equal(upserts.length, 1);
  assert.equal(deleted, false);
  const retirement = updates.find((entry) => JSON.stringify(entry).includes('notIn'));
  assert.ok(retirement, 'missing accounts must be retired with updateMany');
  assert.match(JSON.stringify(retirement), /RETIRED/);
  assert.deepEqual(((retirement.where as { sourceAccountId: { notIn: string[] } }).sourceAccountId.notIn), ['active-1', 'dirty-rate']);
});
