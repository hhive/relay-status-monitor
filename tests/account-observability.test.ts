import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beijingTodayWindow,
  cacheHitRate,
  histogramP95,
  mergeLatencyHistogram,
  providerErrorKey,
  isEligibleProviderError,
  minuteBucket,
  snapshotBillingMicroUsd,
  effectiveBillingRate,
} from '../src/lib/account-observability/metrics';
import {
  accountDataIsStale,
  formatAccountGroups,
} from '../src/lib/account-observability/presentation';

test('provider errors require an eligible owner and phase and dedupe by account request', () => {
  assert.equal(isEligibleProviderError({ accountId: 7, errorOwner: 'provider', errorPhase: 'upstream' }), true);
  assert.equal(isEligibleProviderError({ accountId: 7, errorOwner: 'client', errorPhase: 'upstream' }), false);
  assert.equal(isEligibleProviderError({ accountId: 7, errorOwner: 'provider', errorPhase: 'platform' }), false);
  assert.equal(providerErrorKey({ accountId: 7, clientRequestId: '', requestId: 'req-1' }), '7:req-1');
  assert.equal(providerErrorKey({ accountId: 7, clientRequestId: 'client-1', requestId: 'req-1' }), '7:client-1');
});

test('effective upstream billing rate honors freshness and configured peak time zone', () => {
  const base = {
    status: 'ok', billingScope: 'token', resolvedRateMultiplier: 2,
    peakRateEnabled: true, peakStart: '09:00', peakEnd: '18:00', peakRateMultiplier: 1.5,
    timezone: 'Asia/Shanghai', receivedAt: new Date('2026-07-25T00:00:00Z'),
    freshUntil: new Date('2026-07-26T00:00:00Z'),
  };
  assert.equal(effectiveBillingRate(base, new Date('2026-07-25T02:00:00Z')), 3);
  assert.equal(effectiveBillingRate(base, new Date('2026-07-25T12:00:00Z')), 2);
  assert.equal(effectiveBillingRate({ ...base, freshUntil: new Date('2026-07-25T01:00:00Z') }, new Date('2026-07-25T02:00:00Z')), null);
});

test('account data is stale when either account sync or latest complete minute is delayed', () => {
  const now = new Date('2026-07-25T12:10:30Z');
  assert.equal(accountDataIsStale({
    lastSyncedAt: '2026-07-25T12:05:00Z',
    lastCompleteMinute: '2026-07-25T12:09:00Z',
  }, now), false);
  assert.equal(accountDataIsStale({
    lastSyncedAt: '2026-07-25T11:59:59Z',
    lastCompleteMinute: '2026-07-25T12:09:00Z',
  }, now), true);
  assert.equal(accountDataIsStale({
    lastSyncedAt: '2026-07-25T12:05:00Z',
    lastCompleteMinute: '2026-07-25T12:07:00Z',
  }, now), true);
  assert.equal(accountDataIsStale({ lastSyncedAt: null, lastCompleteMinute: null }, now), true);
});

test('account groups use the allowlisted projection and degrade safely for empty or dirty data', () => {
  assert.equal(formatAccountGroups([{ id: 4, name: '默认组' }, { id: 7, name: '高优先级' }]), '默认组、高优先级');
  assert.equal(formatAccountGroups([{ id: 4, name: '' }, { name: '无编号' }, null]), '分组 #4、无编号');
  assert.equal(formatAccountGroups({ unexpected: true }), '无分组');
});

test('cache hit rate uses token denominator and returns null for zero tokens', () => {
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: 50 }), 0.25);
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), null);
});

test('billing uses event-time account multiplier snapshot with fixed micro USD precision', () => {
  assert.equal(snapshotBillingMicroUsd({ accountStatsCost: '1.23456789', totalCost: '9', rateMultiplier: '1.5' }), 1851852);
  assert.equal(snapshotBillingMicroUsd({ accountStatsCost: null, totalCost: '2.000001', rateMultiplier: null }), 2000001);
});

test('minute buckets truncate UTC timestamps and Beijing today converts to UTC', () => {
  assert.equal(minuteBucket(new Date('2026-07-25T12:34:56.789Z')).toISOString(), '2026-07-25T12:34:00.000Z');
  const window = beijingTodayWindow(new Date('2026-07-25T02:00:00.000Z'));
  assert.equal(window.start.toISOString(), '2026-07-24T16:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-07-25T02:00:00.000Z');
});

test('merged latency histogram computes p95 from samples rather than averaging minute p95', () => {
  const merged = mergeLatencyHistogram([
    { '100': 95, '1000': 5 },
    { '100': 1, '2000': 99 },
  ]);
  assert.equal(histogramP95(merged), 2000);
  assert.equal(histogramP95({}), null);
});
