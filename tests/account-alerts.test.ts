import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAccountAlertEvaluator,
  evaluateAccountMetricAlert,
  type AccountAlertAccountRecord,
  type AccountAlertDependencies,
  type AccountAlertEventRecord,
  type AccountMetricMinuteRecord,
  type AccountAlertRuleRecord,
} from '../src/lib/account-observability/alerts';

test('account alerts require minimum samples and fresh optional multiplier snapshots', () => {
  assert.equal(evaluateAccountMetricAlert({ metric: 'availability', value: 0.2, threshold: 0.9, eligibleCount: 2, minRequests: 5 }), null);
  assert.equal(evaluateAccountMetricAlert({ metric: 'availability', value: 0.2, threshold: 0.9, eligibleCount: 5, minRequests: 5 })?.triggered, true);
  assert.equal(evaluateAccountMetricAlert({ metric: 'upstream_rate_multiplier', value: 2, threshold: 1.5, eligibleCount: 10, minRequests: 1, snapshotFresh: false }), null);
  assert.equal(evaluateAccountMetricAlert({ metric: 'cache_hit_rate', value: 0.1, threshold: 0.5, eligibleCount: 10, minRequests: 1, promptTokens: 20, minPromptTokens: 100 }), null);
});

function rule(overrides: Partial<AccountAlertRuleRecord> = {}): AccountAlertRuleRecord {
  return {
    id: 1, name: 'availability low', metric: 'availability', operator: 'lt', threshold: 0.9,
    accountId: null, minRequests: 5, minPromptTokens: 0, cooldownMin: 30, enabled: true, ...overrides,
  };
}

function harness(input: {
  rules: AccountAlertRuleRecord[];
  account?: Partial<AccountAlertAccountRecord>;
  minutes?: AccountMetricMinuteRecord[];
  openEvents?: AccountAlertEventRecord[];
  recentEvents?: AccountAlertEventRecord[];
}) {
  const created: Array<Record<string, unknown>> = [];
  const resolved: Array<{ id: number; at: Date }> = [];
  const notified: Array<{ recovery: boolean; metric: string }> = [];
  const account = {
    id: 9, sourceAccountId: 'acct-9', name: 'Account 9', platform: 'anthropic', schedulable: true,
    syncState: 'ACTIVE', lastSyncedAt: new Date('2026-07-25T11:59:00Z'), probeFreshAt: null,
    probeLastSuccessAt: null, probeStatus: null, probeBillingScope: null, probeResolvedRateMultiplier: null,
    probePeakRateEnabled: null, probePeakStart: null, probePeakEnd: null, probePeakRateMultiplier: null,
    probeTimezone: null, metricMinutes: input.minutes ?? [],
  };
  const dependencies: AccountAlertDependencies = {
    loadRules: async () => input.rules,
    loadAccounts: async () => [{ ...account, ...(input.account ?? {}) }],
    findOpenEvent: async (accountId, ruleId) => (input.openEvents ?? []).find((event) => event.accountId === accountId && event.ruleId === ruleId) ?? null,
    findRecentEvent: async (accountId, ruleId) => (input.recentEvents ?? []).find((event) => event.accountId === accountId && event.ruleId === ruleId) ?? null,
    createEvent: async (event) => { const saved = { id: 100 + created.length, ...event }; created.push(saved); return saved; },
    resolveEvent: async (id, at) => { resolved.push({ id, at }); },
    notify: async (event, _account, recovery) => { notified.push({ recovery, metric: event.metric }); },
  };
  return { evaluate: createAccountAlertEvaluator(dependencies), created, resolved, notified };
}

const minute = (overrides: Partial<AccountMetricMinuteRecord> = {}): AccountMetricMinuteRecord => ({
  bucketStart: new Date('2026-07-25T11:59:00Z'), successCount: 8, upstreamErrorCount: 2,
  eligibleCount: 10, durationHistogram: { '100': 9, '500': 1 }, firstTokenHistogram: { '20': 9, '200': 1 },
  inputTokens: BigInt(100), cacheReadTokens: BigInt(20), cacheCreationTokens: BigInt(0), ...overrides,
});

test('traffic alerts enforce request and prompt-token minimums', async () => {
  const lowSamples = harness({ rules: [rule()], minutes: [minute({ eligibleCount: 4, successCount: 1, upstreamErrorCount: 3 })] });
  await lowSamples.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(lowSamples.created.length, 0);

  const lowTokens = harness({
    rules: [rule({ metric: 'cache_hit_rate', threshold: 0.5, minRequests: 1, minPromptTokens: 500 })],
    minutes: [minute({ inputTokens: BigInt(20), cacheReadTokens: BigInt(5) })],
  });
  await lowTokens.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(lowTokens.created.length, 0);
});

test('active alert is suppressed and a recently recovered alert remains in cooldown', async () => {
  const open = harness({ rules: [rule()], minutes: [minute({ successCount: 2, upstreamErrorCount: 8 })], openEvents: [{ id: 7, accountId: 9, ruleId: 1, metric: 'availability', message: 'low' }] });
  await open.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(open.created.length, 0);

  const cooling = harness({ rules: [rule()], minutes: [minute({ successCount: 2, upstreamErrorCount: 8 })], recentEvents: [{ id: 8, accountId: 9, ruleId: 1, metric: 'availability', message: 'low' }] });
  await cooling.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(cooling.created.length, 0);
});

test('cleared condition resolves the open event and sends recovery', async () => {
  const run = harness({ rules: [rule()], minutes: [minute({ successCount: 10, upstreamErrorCount: 0 })], openEvents: [{ id: 7, accountId: 9, ruleId: 1, metric: 'availability', metricValue: 0.2, message: 'low' }] });
  await run.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.deepEqual(run.resolved.map((entry) => entry.id), [7]);
  assert.deepEqual(run.notified, [{ recovery: true, metric: 'availability' }]);
});

test('status alerts do not require traffic samples', async () => {
  const run = harness({
    rules: [
      rule({ id: 2, metric: 'unschedulable', operator: 'eq', threshold: 1, minRequests: 99 }),
      rule({ id: 3, metric: 'sync_stale', operator: 'gt', threshold: 10, minRequests: 99 }),
    ],
    account: { schedulable: false, lastSyncedAt: new Date('2026-07-25T11:40:00Z') },
  });
  await run.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.deepEqual(run.created.map((event) => event.metric), ['unschedulable', 'sync_stale']);
});

test('sync stale alert uses the older of account sync and latest complete metric minute', async () => {
  const run = harness({
    rules: [rule({ id: 3, metric: 'sync_stale', operator: 'gt', threshold: 10, minRequests: 99 })],
    account: { lastSyncedAt: new Date('2026-07-25T11:59:00Z') },
    minutes: [minute({ bucketStart: new Date('2026-07-25T11:40:00Z') })],
  });
  await run.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.deepEqual(run.created.map((event) => event.metric), ['sync_stale']);
});

test('stale multiplier snapshots are excluded while fresh snapshots can alert', async () => {
  const multiplierRule = rule({ accountId: 9, metric: 'upstream_rate_multiplier', operator: 'gt', threshold: 1.5, minRequests: 0 });
  const snapshot = { probeStatus: 'ok', probeBillingScope: 'token', probeResolvedRateMultiplier: '2',
    probePeakRateEnabled: false, probeLastSuccessAt: new Date('2026-07-25T11:59:00Z') };
  const stale = harness({ rules: [multiplierRule], account: { ...snapshot, probeFreshAt: new Date('2026-07-25T11:59:59Z') } });
  await stale.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(stale.created.length, 0);

  const fresh = harness({ rules: [multiplierRule], account: { ...snapshot, probeFreshAt: new Date('2026-07-25T13:00:00Z') } });
  await fresh.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.deepEqual(fresh.created.map((event) => event.metric), ['upstream_rate_multiplier']);

  const otherAccount = harness({ rules: [{ ...multiplierRule, accountId: 10 }], account: { ...snapshot, probeFreshAt: new Date('2026-07-25T13:00:00Z') } });
  await otherAccount.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(otherAccount.created.length, 0);
});
