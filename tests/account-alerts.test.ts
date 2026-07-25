import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAccountMetricAlert } from '../src/lib/account-observability/alerts';

test('account alerts require minimum samples and fresh optional multiplier snapshots', () => {
  assert.equal(evaluateAccountMetricAlert({ metric: 'availability', value: 0.2, threshold: 0.9, eligibleCount: 2, minRequests: 5 }), null);
  assert.equal(evaluateAccountMetricAlert({ metric: 'availability', value: 0.2, threshold: 0.9, eligibleCount: 5, minRequests: 5 })?.triggered, true);
  assert.equal(evaluateAccountMetricAlert({ metric: 'upstream_rate_multiplier', value: 2, threshold: 1.5, eligibleCount: 10, minRequests: 1, snapshotFresh: false }), null);
  assert.equal(evaluateAccountMetricAlert({ metric: 'cache_hit_rate', value: 0.1, threshold: 0.5, eligibleCount: 10, minRequests: 1, promptTokens: 20, minPromptTokens: 100 }), null);
});
