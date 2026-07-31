import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      { source_account_id: 'active-1', name: 'Healthy', remote_status: 'active', priority: 7 },
      { source_account_id: '', name: 'Dirty', remote_status: 'active', priority: 50 },
      { source_account_id: 'dirty-rate', name: 'Dirty Rate', remote_status: 'active', priority: 50, probe_resolved_rate_multiplier: 'not-a-decimal' },
      { source_account_id: 'dirty-priority', name: 'Dirty Priority', remote_status: 'active', priority: -1 },
    ],
    $disconnect: async () => {},
  };

  const result = await syncSub2ApiAccounts(read as never, monitor as never);

  assert.deepEqual(result, { readCount: 4, ignoredCount: 3 });
  assert.equal(upserts.length, 1);
  assert.equal((upserts[0].create as { priority?: number }).priority, 7);
  assert.equal(deleted, false);
  const retirement = updates.find((entry) => JSON.stringify(entry).includes('notIn'));
  assert.ok(retirement, 'missing accounts must be retired with updateMany');
  assert.match(JSON.stringify(retirement), /RETIRED/);
  assert.deepEqual(((retirement.where as { sourceAccountId: { notIn: string[] } }).sourceAccountId.notIn), ['active-1', 'dirty-rate', 'dirty-priority']);
});

test('first import of an inactive account sets retiredAt and a write failure closes the run as FAILED', async () => {
  const runUpdates: Array<Record<string, unknown>> = [];
  let created: Record<string, unknown> | undefined;
  const monitor = {
    accountSyncRun: {
      create: async () => ({ id: 10 }),
      update: async (args: Record<string, unknown>) => { runUpdates.push(args); },
    },
    sub2ApiAccount: {
      upsert: async (args: Record<string, unknown>) => { created = args; throw new Error('monitor write failed'); },
      updateMany: async () => ({ count: 0 }),
    },
  };
  const read = {
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(read),
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => [{ source_account_id: 'inactive-1', name: 'Inactive', remote_status: 'error', priority: 50 }],
    $disconnect: async () => {},
  };

  await assert.rejects(() => syncSub2ApiAccounts(read as never, monitor as never), /monitor write failed/);
  assert.ok((created?.create as { retiredAt?: Date }).retiredAt instanceof Date);
  assert.equal(runUpdates.at(-1)?.data && (runUpdates.at(-1)!.data as { status?: string }).status, 'FAILED');
});

test('account priority uses an additive non-null migration with the Sub2API default', () => {
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../prisma/migrations/20260731180000_add_account_priority/migration.sql', import.meta.url), 'utf8');
  assert.match(schema, /priority\s+Int\s+@default\(50\)/);
  assert.match(migration, /ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 50/);
  assert.doesNotMatch(migration, /DROP|DELETE|TRUNCATE/i);
});
