import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';

import { aggregateMetricMinutes } from '../src/lib/account-observability/metric-aggregate';
import {
  buildSnapshotRows,
  refreshAccountMetricSnapshots,
  replaceActiveSnapshot,
  type SnapshotBatchWrite,
} from '../src/lib/account-observability/snapshot';
import { resolveAccountWindow } from '../src/lib/account-observability/window';

const root = new URL('../', import.meta.url);
function source(path: string): string {
  const file = new URL(path, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function minute(accountId: number, bucketStart: string, values: Record<string, unknown> = {}) {
  return {
    accountId,
    bucketStart: new Date(bucketStart),
    successCount: 0,
    upstreamErrorCount: 0,
    eligibleCount: 0,
    durationCount: 0,
    durationSumMs: BigInt(0),
    durationHistogram: {},
    firstTokenHistogram: {},
    inputTokens: BigInt(0),
    cacheReadTokens: BigInt(0),
    cacheCreationTokens: BigInt(0),
    userBilledUsd: '0',
    accountBilledUsd: '0',
    balanceUsd: null,
    errorStatusCounts: {},
    errorPhaseCounts: {},
    ...values,
  };
}

test('snapshot migration is additive and enforces one active batch per window', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source('prisma/migrations/20260726170000_add_account_metric_snapshots/migration.sql');
  assert.match(schema, /enum AccountMetricSnapshotWindow[\s\S]*TODAY[\s\S]*LAST_1H[\s\S]*LAST_24H/);
  assert.match(schema, /model AccountMetricSnapshotBatch/);
  assert.match(schema, /model AccountMetricSnapshot/);
  assert.match(schema, /metricSnapshots\s+AccountMetricSnapshot\[\]/);
  assert.match(schema, /@@unique\(\[batchId, accountId\]\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "AccountMetricSnapshotBatch_one_active_window"[\s\S]*WHERE "active" = true/);
  assert.match(migration, /AccountMetricSnapshot_batchId_fkey[\s\S]*ON DELETE CASCADE/);
  assert.match(migration, /AccountMetricSnapshot_accountId_fkey[\s\S]*ON DELETE CASCADE/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)/i);
});

test('shared aggregate merges histograms and sums Decimal values in micro USD', () => {
  const result = aggregateMetricMinutes([
    minute(1, '2026-07-25T12:00:00Z', {
      durationHistogram: { '100': 95, '1000': 5 },
      userBilledUsd: '9007199254.740991',
      accountBilledUsd: '1.000001',
    }),
    minute(1, '2026-07-25T12:01:00Z', {
      durationHistogram: { '2000': 100 },
      userBilledUsd: '0.000009',
      accountBilledUsd: '2.000009',
    }),
  ]);
  assert.equal(result.durationP95Ms, 2000);
  assert.equal(result.userBilledUsd, '9007199254.741000');
  assert.equal(result.accountBilledUsd, '3.000010');
});

test('snapshot rows include accounts without minute data', () => {
  const window = resolveAccountWindow('last1h', new Date('2026-07-25T12:34:56Z'));
  const rows = buildSnapshotRows({
    accounts: [{ id: 1 }, { id: 2 }],
    minutes: [minute(1, '2026-07-25T12:00:00Z', { successCount: 1, eligibleCount: 1 })],
    window,
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    accountId: 2,
    successCount: 0,
    upstreamErrorCount: 0,
    eligibleCount: 0,
    availability: null,
    errorRate: null,
    durationP95Ms: null,
    firstTokenP95Ms: null,
    cacheHitRate: null,
    userBilledUsd: '0.000000',
    accountBilledUsd: '0.000000',
    balanceUsd: null,
    upstreamRateMultiplier: null,
    upstreamEstimatedRateMultiplier: null,
    upstreamRateSource: null,
    lastCompleteMinute: null,
  });
});

test('snapshot balance uses the last minute and never fills a current null from history', () => {
  const window = resolveAccountWindow('last1h', new Date('2026-07-25T12:34:56Z'));
  const rows = buildSnapshotRows({
    accounts: [{ id: 1 }],
    minutes: [
      minute(1, '2026-07-25T12:32:00Z', { balanceUsd: '8.250000' }),
      minute(1, '2026-07-25T12:33:00Z', { balanceUsd: null }),
    ],
    window,
  });
  assert.equal(rows[0].balanceUsd, null);
  assert.equal(rows[0].lastCompleteMinute?.toISOString(), '2026-07-25T12:33:00.000Z');
});

test('snapshot uses the latest minute upstream rate and source without historical fill', () => {
  const window = resolveAccountWindow('last1h', new Date('2026-07-25T12:34:56Z'));
  const rows = buildSnapshotRows({
    accounts: [{ id: 1 }],
    minutes: [
      minute(1, '2026-07-25T12:32:00Z', { upstreamRateMultiplier: '1.5', upstreamRateSource: 'api' }),
      minute(1, '2026-07-25T12:33:00Z', { upstreamRateMultiplier: null, upstreamRateSource: null }),
    ],
    window,
  });
  assert.equal(rows[0].upstreamRateMultiplier, null);
  assert.equal(rows[0].upstreamRateSource, null);
});

test('snapshot keeps the latest estimated rate beside the API rate', () => {
  const window = resolveAccountWindow('last1h', new Date('2026-07-25T12:34:56Z'));
  const rows = buildSnapshotRows({
    accounts: [{ id: 1 }],
    minutes: [minute(1, '2026-07-25T12:33:00Z', {
      upstreamRateMultiplier: '1.2', upstreamRateSource: 'api', upstreamEstimatedRateMultiplier: '1.35',
    })],
    window,
  });
  assert.equal(rows[0].upstreamRateMultiplier, '1.2');
  assert.equal(rows[0].upstreamEstimatedRateMultiplier, '1.35');
});

test('refresh reads every account once and all windows share one complete minute', async () => {
  const writes: SnapshotBatchWrite[] = [];
  let accountArgs: unknown;
  const client = {
    sub2ApiAccount: { findMany: async (args: unknown) => { accountArgs = args; return [{ id: 1 }, { id: 2 }]; } },
    accountMetricMinute: { findMany: async () => [] },
  };
  await refreshAccountMetricSnapshots(new Date('2026-07-25T12:34:56Z'), client as never, {
    replace: async (input) => { writes.push(input); return { batch: { id: writes.length }, skipped: false }; },
    warn: () => {},
  });
  assert.deepEqual(accountArgs, { select: { id: true } }, 'account load must not filter syncState');
  assert.equal(writes.length, 3);
  assert.deepEqual([...new Set(writes.map((row) => row.windowEnd.toISOString()))], ['2026-07-25T12:34:00.000Z']);
  assert.deepEqual([...new Set(writes.map((row) => row.lastCompleteMinute?.toISOString()))], ['2026-07-25T12:33:00.000Z']);
  assert.equal(writes.every((row) => row.rows.length === 2), true);
});

function batchInput(windowEnd = '2026-07-25T12:34:00Z'): SnapshotBatchWrite {
  return {
    windowKey: 'LAST_1H',
    windowStart: new Date('2026-07-25T11:34:00Z'),
    windowEnd: new Date(windowEnd),
    lastCompleteMinute: new Date('2026-07-25T12:33:00Z'),
    computedAt: new Date('2026-07-25T12:34:56Z'),
    rows: buildSnapshotRows({ accounts: [{ id: 1 }], minutes: [], window: resolveAccountWindow('last1h', new Date('2026-07-25T12:34:56Z')) }),
  };
}

function replacementClient(options: { currentEnd?: string; inserted?: number } = {}) {
  const order: string[] = [];
  let activeId = 7;
  const tx = {
    $queryRaw: async () => { order.push('lock'); return []; },
    accountMetricSnapshotBatch: {
      findFirst: async () => options.currentEnd ? { id: activeId, windowEnd: new Date(options.currentEnd), active: true } : null,
      create: async () => { order.push('create-inactive'); return { id: 8, active: false }; },
      updateMany: async () => { order.push('deactivate-old'); activeId = 0; return { count: 1 }; },
      update: async () => { order.push('activate-new'); activeId = 8; return { id: 8, active: true }; },
    },
    accountMetricSnapshot: {
      createMany: async ({ data }: { data: unknown[] }) => { order.push('rows'); return { count: options.inserted ?? data.length }; },
    },
  };
  let isolation: unknown;
  const client = {
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>, config: unknown) => {
      isolation = config;
      return callback(tx);
    },
  };
  return { client, order, active: () => activeId, isolation: () => isolation };
}

test('replacement locks, writes every row, and activates only after complete insertion', async () => {
  const fake = replacementClient();
  const result = await replaceActiveSnapshot(batchInput(), fake.client as never);
  assert.deepEqual(fake.order, ['lock', 'create-inactive', 'rows', 'deactivate-old', 'activate-new']);
  assert.deepEqual(fake.isolation(), { isolationLevel: 'Serializable' });
  assert.equal(result.skipped, false);
  assert.equal(fake.active(), 8);
});

test('row-count mismatch retains the prior active batch', async () => {
  const fake = replacementClient({ currentEnd: '2026-07-25T12:33:00Z', inserted: 0 });
  await assert.rejects(() => replaceActiveSnapshot(batchInput(), fake.client as never), /row count mismatch/);
  assert.deepEqual(fake.order, ['lock', 'create-inactive', 'rows']);
  assert.equal(fake.active(), 7);
});

test('an older window never replaces a newer active batch', async () => {
  const fake = replacementClient({ currentEnd: '2026-07-25T12:35:00Z' });
  const result = await replaceActiveSnapshot(batchInput(), fake.client as never);
  assert.equal(result.skipped, true);
  assert.deepEqual(fake.order, ['lock']);
  assert.equal(fake.active(), 7);
});

test('replacement retries a transient PostgreSQL serialization conflict', async () => {
  const fake = replacementClient();
  let attempts = 0;
  const retryingClient = {
    $transaction: async (...args: Parameters<typeof fake.client.$transaction>) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('write conflict'), { code: 'P2034' });
      return fake.client.$transaction(...args);
    },
  };
  const result = await replaceActiveSnapshot(batchInput(), retryingClient as never);
  assert.equal(attempts, 2);
  assert.equal(result.skipped, false);
});

test('inactive cleanup failure warns without rolling back the new active batch', async () => {
  const warnings: string[] = [];
  const client = {
    sub2ApiAccount: { findMany: async () => [{ id: 1 }] },
    accountMetricMinute: { findMany: async () => [] },
    accountMetricSnapshotBatch: { deleteMany: async () => { throw new Error('cleanup failed'); } },
  };
  const result = await refreshAccountMetricSnapshots(new Date('2026-07-25T12:34:56Z'), client as never, {
    replace: async () => ({ batch: { id: 9 }, skipped: false }),
    warn: (message) => { warnings.push(message); },
  });
  assert.equal(result.length, 3);
  assert.equal(warnings.length, 3);
});

const snapshotIntegrationDatabaseUrl = process.env.ACCOUNT_SNAPSHOT_TEST_DATABASE_URL;

function postgresBatchInput(windowEnd: string, computedAt: string): SnapshotBatchWrite {
  return {
    ...batchInput(windowEnd),
    computedAt: new Date(computedAt),
  };
}

test('PostgreSQL rolls back failed activation and serializes concurrent replacements', {
  skip: !snapshotIntegrationDatabaseUrl,
  timeout: 20_000,
}, async () => {
  const client = new PrismaClient({ datasourceUrl: snapshotIntegrationDatabaseUrl });
  try {
    await client.accountMetricSnapshot.deleteMany();
    await client.accountMetricSnapshotBatch.deleteMany();
    await client.sub2ApiAccount.deleteMany();
    await client.sub2ApiAccount.create({ data: { id: 1, sourceAccountId: 'snapshot-test-1', name: 'Snapshot test' } });

    await replaceActiveSnapshot(
      postgresBatchInput('2026-07-25T12:34:00Z', '2026-07-25T12:34:30Z'),
      client,
    );
    await client.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_test_snapshot_activation() RETURNS trigger AS $$
      BEGIN
        IF NEW.active = true AND NEW."computedAt" = TIMESTAMP '2026-07-25 12:35:30' THEN
          RAISE EXCEPTION 'forced snapshot activation failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.$executeRawUnsafe(`
      CREATE TRIGGER fail_test_snapshot_activation_trigger
      BEFORE UPDATE OF active ON "AccountMetricSnapshotBatch"
      FOR EACH ROW EXECUTE FUNCTION fail_test_snapshot_activation()
    `);
    try {
      await assert.rejects(
        replaceActiveSnapshot(
          postgresBatchInput('2026-07-25T12:35:00Z', '2026-07-25T12:35:30Z'),
          client,
        ),
        /forced snapshot activation failure/,
      );
    } finally {
      await client.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_test_snapshot_activation_trigger ON "AccountMetricSnapshotBatch"');
      await client.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_test_snapshot_activation()');
    }

    const afterFailure = await client.accountMetricSnapshotBatch.findMany({
      orderBy: { windowEnd: 'asc' },
      include: { snapshots: true },
    });
    assert.equal(afterFailure.length, 1, 'the failed batch must be rolled back completely');
    assert.equal(afterFailure[0].active, true);
    assert.equal(afterFailure[0].windowEnd.toISOString(), '2026-07-25T12:34:00.000Z');
    assert.equal(afterFailure[0].snapshots.length, 1);

    await client.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION delay_test_snapshot_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW."computedAt" = TIMESTAMP '2026-07-25 12:36:30' THEN
          PERFORM pg_sleep(0.25);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.$executeRawUnsafe(`
      CREATE TRIGGER delay_test_snapshot_insert_trigger
      BEFORE INSERT ON "AccountMetricSnapshotBatch"
      FOR EACH ROW EXECUTE FUNCTION delay_test_snapshot_insert()
    `);
    const newerReplacement = replaceActiveSnapshot(
        postgresBatchInput('2026-07-25T12:36:00Z', '2026-07-25T12:36:30Z'),
        client,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const olderReplacement = replaceActiveSnapshot(
        postgresBatchInput('2026-07-25T12:35:00Z', '2026-07-25T12:35:45Z'),
        client,
      );
    const concurrent = await Promise.allSettled([newerReplacement, olderReplacement]);
    await client.$executeRawUnsafe('DROP TRIGGER IF EXISTS delay_test_snapshot_insert_trigger ON "AccountMetricSnapshotBatch"');
    await client.$executeRawUnsafe('DROP FUNCTION IF EXISTS delay_test_snapshot_insert()');
    const concurrencyErrors = concurrent.flatMap((result) => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []);
    assert.deepEqual(
      concurrent.map((result) => result.status),
      ['fulfilled', 'fulfilled'],
      concurrencyErrors.join('\n'),
    );
    const active = await client.accountMetricSnapshotBatch.findMany({ where: { active: true } });
    assert.equal(active.length, 1);
    assert.equal(active[0].windowEnd.toISOString(), '2026-07-25T12:36:00.000Z');
  } finally {
    await client.$disconnect();
  }
});
