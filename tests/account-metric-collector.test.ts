import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeMetricWindow,
  createMetricWindowRunner,
  rebuildAccountMetrics,
  type MetricMinuteWrite,
} from '../src/lib/account-observability/collector';
import { readFileSync } from 'node:fs';

test('production cycle checks source schema before account or metric writes', () => {
  const source = readFileSync(new URL('../src/lib/account-observability/collector.ts', import.meta.url), 'utf8');
  assert.match(source, /await querySchemaCapabilities\(client\)/);
  assert.match(source, /catch \(error\)[\s\S]*evaluateAccountAlerts\(now\)[\s\S]*throw error/);
});

test('server rebuild command requires explicit UTC bounds and reuses production window runner', () => {
  const collector = readFileSync(new URL('../src/lib/account-observability/collector.ts', import.meta.url), 'utf8');
  const command = readFileSync(new URL('../scripts/rebuild-account-metrics.ts', import.meta.url), 'utf8');
  const crypto = readFileSync(new URL('../src/lib/crypto.ts', import.meta.url), 'utf8');
  assert.match(collector, /export async function runAccountMetricRebuild/);
  assert.match(command, /--start/);
  assert.match(command, /--end/);
  assert.match(command, /runAccountMetricRebuild/);
  assert.match(command, /async function main\(\)/);
  assert.match(command, /main\(\)\.catch/);
  assert.doesNotMatch(crypto, /from ['"]@\//);
  assert.match(collector, /productionMetricRunner\(client, 'REBUILD'\)/);
});

test('metric cycle recomputes the last ten complete UTC minutes including empty buckets for active accounts', async () => {
  const writes: MetricMinuteWrite[] = [];
  const completed: Array<{ status?: unknown }> = [];
  const runner = createMetricWindowRunner({
    readUsageRows: async () => [],
    readErrorRows: async () => [],
    loadActiveAccounts: async () => [{ id: 3, sourceAccountId: 'acct-3' }],
    upsertMinute: async (row) => { writes.push(row); },
    startRun: async () => 11,
    finishRun: async (_id, result) => { completed.push(result); },
  });
  const now = new Date('2026-07-25T12:10:42.000Z');

  const result = await runner(completeMetricWindow(now));

  assert.equal(writes.length, 10);
  assert.equal(writes[0].bucketStart.toISOString(), '2026-07-25T12:00:00.000Z');
  assert.equal(writes[9].bucketStart.toISOString(), '2026-07-25T12:09:00.000Z');
  assert.equal(writes.every((row) => row.eligibleCount === 0), true);
  assert.deepEqual(result, { readCount: 0, writeCount: 10, ignoredCount: 0 });
  assert.equal(completed[0].status, 'SUCCEEDED');
});

test('metric cycle writes nothing when source reads fail and records a failed run', async () => {
  let writes = 0;
  const completed: Array<{ status?: unknown }> = [];
  const runner = createMetricWindowRunner({
    readUsageRows: async () => { throw new Error('source unavailable'); },
    readErrorRows: async () => [],
    loadActiveAccounts: async () => [{ id: 3, sourceAccountId: 'acct-3' }],
    upsertMinute: async () => { writes += 1; },
    startRun: async () => 12,
    finishRun: async (_id, result) => { completed.push(result); },
  });

  await assert.rejects(() => runner(completeMetricWindow(new Date('2026-07-25T12:10:42.000Z'))));
  assert.equal(writes, 0);
  assert.equal(completed[0].status, 'FAILED');
});

test('metric aggregation persists error dimensions and source high-water ids', async () => {
  const writes: MetricMinuteWrite[] = [];
  const runner = createMetricWindowRunner({
    readUsageRows: async () => [{ usage_id: '20', account_id: 'acct-3', request_id: 'ok', created_at: '2026-07-25T12:09:10Z', duration_ms: 100, actual_cost: '0', total_cost: '0' }],
    readErrorRows: async () => [
      { error_id: '31', account_id: 'acct-3', request_id: 'bad', created_at: '2026-07-25T12:09:20Z', error_owner: 'provider', error_phase: 'network', status_code: 504 },
      { error_id: '32', account_id: 'acct-3', request_id: 'bad', created_at: '2026-07-25T12:09:21Z', error_owner: 'provider', error_phase: 'network', status_code: 504 },
    ],
    loadActiveAccounts: async () => [{ id: 3, sourceAccountId: 'acct-3' }],
    upsertMinute: async (row) => { writes.push(row); },
    startRun: async () => 13,
    finishRun: async () => {},
  });

  await runner({ start: new Date('2026-07-25T12:09:00Z'), end: new Date('2026-07-25T12:10:00Z') });
  assert.deepEqual(writes[0].errorStatusCounts, { '504': 1 });
  assert.deepEqual(writes[0].errorPhaseCounts, { network: 1 });
  assert.equal(writes[0].sourceMaxUsageId, '20');
  assert.equal(writes[0].sourceMaxErrorId, '32');
});

test('bounded rebuild reuses the metric window runner and rejects unbounded ranges', async () => {
  const windows: Array<{ start: Date; end: Date }> = [];
  await rebuildAccountMetrics(
    new Date('2026-07-25T00:00:00Z'),
    new Date('2026-07-25T00:25:00Z'),
    async (window) => { windows.push(window); return { readCount: 0, writeCount: 0, ignoredCount: 0 }; },
  );
  assert.deepEqual(windows.map((window) => (window.end.getTime() - window.start.getTime()) / 60_000), [10, 10, 5]);
  await assert.rejects(() => rebuildAccountMetrics(
    new Date('2026-01-01T00:00:00Z'),
    new Date('2026-07-25T00:00:00Z'),
    async () => ({ readCount: 0, writeCount: 0, ignoredCount: 0 }),
  ), /bounded/i);
  await assert.rejects(() => rebuildAccountMetrics(
    new Date('2026-07-24T00:00:00Z'),
    new Date('2026-07-25T00:01:00Z'),
    async () => ({ readCount: 0, writeCount: 0, ignoredCount: 0 }),
  ), /24 hours/i);
});

test('rebuild stops after the first failed batch and never executes later windows', async () => {
  let attempts = 0;
  await assert.rejects(() => rebuildAccountMetrics(
    new Date('2026-07-25T00:00:00Z'),
    new Date('2026-07-25T00:25:00Z'),
    async () => {
      attempts += 1;
      if (attempts === 2) throw new Error('source failed');
      return { readCount: 0, writeCount: 0, ignoredCount: 0 };
    },
  ), /source failed/);
  assert.equal(attempts, 2);
});

test('bounded rebuild refreshes snapshots once after the final metric batch', async () => {
  const order: string[] = [];
  await rebuildAccountMetrics(
    new Date('2026-07-25T00:00:00Z'),
    new Date('2026-07-25T00:25:00Z'),
    async () => { order.push('batch'); return { readCount: 0, writeCount: 0, ignoredCount: 0 }; },
    async () => { order.push('snapshot'); },
  );
  assert.deepEqual(order, ['batch', 'batch', 'batch', 'snapshot']);
});

test('production collection refreshes after metric writes and before alerts', () => {
  const source = readFileSync(new URL('../src/lib/account-observability/collector.ts', import.meta.url), 'utf8');
  assert.match(source, /await metricRunner\(completeMetricWindow\(now\)\);[\s\S]*await refreshAccountMetricSnapshots\(now\);[\s\S]*await evaluateAccountAlerts\(now\);/);
});

test('collection cycle records one system failure and resolves it after a complete success', () => {
  const source = readFileSync(new URL('../src/lib/account-observability/collector.ts', import.meta.url), 'utf8');
  assert.match(source, /recoverOperationalAlert\('collection_failed', 'system'\)/);
  assert.match(source, /recordOperationalFailure\('collection_failed', 'system', 'Sub2API 指标采集'/);
  assert.ok(source.indexOf("recoverOperationalAlert('collection_failed'") > source.indexOf('evaluateAccountAlerts(now)'));
});
