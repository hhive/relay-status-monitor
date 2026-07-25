import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSyncState } from '../src/lib/account-observability/sync';
import { aggregateMinute } from '../src/lib/account-observability/aggregate';

test('active but temporarily unschedulable accounts stay active, missing accounts retire', () => {
  assert.deepEqual(projectSyncState({ status: 'active', schedulable: false }, true), {
    syncState: 'ACTIVE', schedulable: false,
  });
  assert.deepEqual(projectSyncState({ status: 'inactive', schedulable: true }, true), {
    syncState: 'RETIRED', schedulable: true,
  });
  assert.deepEqual(projectSyncState(null, false), { syncState: 'RETIRED', schedulable: false });
});

test('minute aggregation attributes provider errors per account and deduplicates only same account request', () => {
  const result = aggregateMinute({
    usages: [
      { accountId: 'a', requestId: 'req-ok', durationMs: 100, firstTokenMs: 25, inputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 0, actualCost: '0.1', totalCost: '0.1', accountStatsCost: '0.08', accountRateMultiplier: '2' },
      { accountId: 'b', requestId: 'req-failover', durationMs: 200, firstTokenMs: null, inputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, actualCost: '0.2', totalCost: '0.25', accountStatsCost: null, accountRateMultiplier: null },
    ],
    errors: [
      { accountId: 'a', requestId: 'req-error', clientRequestId: 'same', errorOwner: 'provider', errorPhase: 'upstream', statusCode: 429 },
      { accountId: 'a', requestId: 'req-error-duplicate', clientRequestId: 'same', errorOwner: 'provider', errorPhase: 'upstream', statusCode: 429 },
      { accountId: 'b', requestId: 'req-failover', clientRequestId: '', errorOwner: 'provider', errorPhase: 'network', statusCode: 503 },
      { accountId: 'a', requestId: 'ignored', clientRequestId: '', errorOwner: 'client', errorPhase: 'request', statusCode: 400 },
    ],
  });
  assert.equal(result.successCount, 2);
  assert.equal(result.upstreamErrorCount, 2);
  assert.equal(result.eligibleCount, 4);
  assert.equal(result.userBilledMicroUsd, 300000);
  assert.equal(result.accountBilledMicroUsd, 410000);
  assert.equal(result.cacheReadTokens, 5);
  assert.equal(result.durationHistogram['100'], 1);
  assert.equal(result.firstTokenHistogram['25'], 1);
});
