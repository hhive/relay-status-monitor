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
  assert.equal(evaluateAccountMetricAlert({ metric: 'availability_low', value: 0.2, threshold: 0.9, eligibleCount: 2, minRequests: 5 }), null);
  assert.equal(evaluateAccountMetricAlert({ metric: 'availability_low', value: 0.2, threshold: 0.9, eligibleCount: 5, minRequests: 5 })?.triggered, true);
  assert.equal(evaluateAccountMetricAlert({ metric: 'upstream_rate_multiplier', value: 2, threshold: 1.5, eligibleCount: 10, minRequests: 1, snapshotFresh: false }), null);
  assert.equal(evaluateAccountMetricAlert({ metric: 'cache_hit_low', value: 0.1, threshold: 0.5, eligibleCount: 10, minRequests: 1, promptTokens: 20, minPromptTokens: 100 }), null);
});

function rule(overrides: Partial<AccountAlertRuleRecord> = {}): AccountAlertRuleRecord {
  return {
    id: 1, name: 'availability low', metric: 'availability_low', operator: 'lt', threshold: 0.9,
    accountId: null, minRequests: 5, minPromptTokens: 0, cooldownMin: 30, enabled: true, ...overrides,
  };
}

function harness(input: {
  rules: AccountAlertRuleRecord[];
  account?: Partial<AccountAlertAccountRecord>;
  minutes?: AccountMetricMinuteRecord[];
  openEvents?: AccountAlertEventRecord[];
  recentEvents?: AccountAlertEventRecord[];
  latestMetricBucketStart?: Date | null;
  notify?: (
    event: AccountAlertEventRecord,
    recovery: boolean,
    deliveredChannelIds: readonly number[],
    onDelivered: (channelId: number) => Promise<void>,
  ) => Promise<void>;
}) {
  const created: Array<Record<string, unknown>> = [];
  const resolved: Array<{ id: number; at: Date }> = [];
  const notified: Array<{ recovery: boolean; metric: string }> = [];
  const openEvents = [...(input.openEvents ?? [])];
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
    loadLatestMetricBucket: async () => input.latestMetricBucketStart
      ?? account.metricMinutes.reduce<Date | null>((latest, item) => latest == null || item.bucketStart > latest ? item.bucketStart : latest, null),
    findOpenEvent: async (accountId, ruleId) => openEvents.find((event) => event.accountId === accountId && event.ruleId === ruleId) ?? null,
    findRecentEvent: async (accountId, ruleId) => (input.recentEvents ?? []).find((event) => event.accountId === accountId && event.ruleId === ruleId) ?? null,
    createEvent: async (event) => { const saved = { id: 100 + created.length, ...event }; created.push(saved); openEvents.push(saved); return saved; },
    updateNotificationDeliveries: async (id, notificationDeliveries) => {
      const event = openEvents.find((item) => item.id === id);
      if (event) event.notificationDeliveries = notificationDeliveries;
    },
    resolveEvent: async (id, at) => { resolved.push({ id, at }); openEvents.splice(0, openEvents.length, ...openEvents.filter((event) => event.id !== id)); },
    notify: async (event, _account, recovery, deliveredChannelIds, onDelivered) => {
      notified.push({ recovery, metric: event.metric });
      await input.notify?.(event, recovery, deliveredChannelIds, onDelivered);
    },
  };
  return { evaluate: createAccountAlertEvaluator(dependencies), created, resolved, notified, openEvents };
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
    rules: [rule({ metric: 'cache_hit_low', threshold: 0.5, minRequests: 1, minPromptTokens: 500 })],
    minutes: [minute({ inputTokens: BigInt(20), cacheReadTokens: BigInt(5) })],
  });
  await lowTokens.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(lowTokens.created.length, 0);
});

test('legacy stored metrics are evaluated and emitted with canonical event metrics', async () => {
  const run = harness({
    rules: [rule({ metric: 'availability' as never, threshold: 0.9, minRequests: 1 })],
    minutes: [minute({ successCount: 2, upstreamErrorCount: 8, eligibleCount: 10 })],
  });
  await run.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(run.created.length, 1);
  assert.equal(run.created[0]?.metric, 'availability_low');
});

test('active alert is suppressed and a recently recovered alert remains in cooldown', async () => {
  const open = harness({ rules: [rule()], minutes: [minute({ successCount: 2, upstreamErrorCount: 8 })], openEvents: [{ id: 7, accountId: 9, ruleId: 1, metric: 'availability_low', message: 'low' }] });
  await open.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(open.created.length, 0);
  assert.deepEqual(open.notified, []);

  const cooling = harness({ rules: [rule()], minutes: [minute({ successCount: 2, upstreamErrorCount: 8 })], recentEvents: [{ id: 8, accountId: 9, ruleId: 1, metric: 'availability_low', message: 'low' }] });
  await cooling.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(cooling.created.length, 0);
});

test('cleared condition resolves the open event and sends recovery', async () => {
  const run = harness({ rules: [rule()], minutes: [minute({ successCount: 10, upstreamErrorCount: 0 })], openEvents: [{ id: 7, accountId: 9, ruleId: 1, metric: 'availability_low', metricValue: 0.2, message: 'low' }] });
  await run.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.deepEqual(run.resolved.map((entry) => entry.id), [7]);
  assert.deepEqual(run.notified, [{ recovery: true, metric: 'availability_low' }]);
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

test('sync stale uses the latest metric bucket beyond the ten-minute traffic window', async () => {
  const now = new Date('2026-07-25T12:00:00Z');
  const freshEnough = harness({
    rules: [rule({ id: 3, metric: 'sync_stale', operator: 'gt', threshold: 60, minRequests: 0 })],
    account: { lastSyncedAt: new Date('2026-07-25T11:59:00Z') },
    latestMetricBucketStart: new Date('2026-07-25T11:49:00Z'),
  });
  await freshEnough.evaluate(now);
  assert.equal(freshEnough.created.length, 0);

  const stale = harness({
    rules: [rule({ id: 3, metric: 'sync_stale', operator: 'gt', threshold: 60, minRequests: 0 })],
    account: { lastSyncedAt: new Date('2026-07-25T11:59:00Z') },
    latestMetricBucketStart: new Date('2026-07-25T10:59:00Z'),
  });
  await stale.evaluate(now);
  assert.deepEqual(stale.created.map((event) => event.metric), ['sync_stale']);
});

test('partial trigger delivery retries only the failed channel on the same open event', async () => {
  let attempts = 0;
  const deliveredInputs: number[][] = [];
  const run = harness({
    rules: [rule()],
    minutes: [minute({ successCount: 2, upstreamErrorCount: 8 })],
    notify: async (_event, recovery, deliveredChannelIds, onDelivered) => {
      assert.equal(recovery, false);
      deliveredInputs.push([...deliveredChannelIds]);
      attempts += 1;
      if (attempts === 1) {
        await onDelivered(1);
        throw new Error('channel 2 failed');
      }
      await onDelivered(2);
    },
  });
  await assert.rejects(run.evaluate(new Date('2026-07-25T12:00:00Z')), /channel 2 failed/);
  await run.evaluate(new Date('2026-07-25T12:01:00Z'));
  assert.equal(attempts, 2);
  assert.equal(run.created.length, 1);
  assert.deepEqual(deliveredInputs, [[], [1]]);
  assert.deepEqual(run.openEvents[0].notificationDeliveries, { trigger: [1, 2], recovery: [] });
});

test('partial recovery delivery retries only the failed channel before resolving', async () => {
  let attempts = 0;
  const deliveredInputs: number[][] = [];
  const run = harness({
    rules: [rule()],
    minutes: [minute({ successCount: 10, upstreamErrorCount: 0 })],
    openEvents: [{
      id: 7, accountId: 9, ruleId: 1, metric: 'availability_low', metricValue: 0.2,
      message: 'low', notificationDeliveries: { trigger: [1, 2], recovery: [] },
    }],
    notify: async (_event, recovery, deliveredChannelIds, onDelivered) => {
      if (!recovery) {
        assert.deepEqual(deliveredChannelIds, [1, 2]);
        return;
      }
      deliveredInputs.push([...deliveredChannelIds]);
      attempts += 1;
      if (attempts === 1) {
        await onDelivered(1);
        throw new Error('channel 2 recovery failed');
      }
      await onDelivered(2);
    },
  });
  await assert.rejects(run.evaluate(new Date('2026-07-25T12:00:00Z')), /channel 2 recovery failed/);
  assert.equal(run.resolved.length, 0);
  await run.evaluate(new Date('2026-07-25T12:01:00Z'));
  assert.equal(attempts, 2);
  assert.deepEqual(deliveredInputs, [[], [1]]);
  assert.deepEqual(run.resolved.map((entry) => entry.id), [7]);
});

test('cleared condition finishes a partial trigger delivery before recovery', async () => {
  const minutes = [minute({ successCount: 2, upstreamErrorCount: 8 })];
  const calls: Array<{ recovery: boolean; delivered: number[] }> = [];
  let triggerAttempts = 0;
  const run = harness({
    rules: [rule()],
    minutes,
    notify: async (_event, recovery, deliveredChannelIds, onDelivered) => {
      calls.push({ recovery, delivered: [...deliveredChannelIds] });
      if (!recovery) {
        triggerAttempts += 1;
        if (triggerAttempts === 1) {
          await onDelivered(1);
          throw new Error('channel 2 failed');
        }
        await onDelivered(2);
        return;
      }
      await onDelivered(1);
      await onDelivered(2);
    },
  });
  await assert.rejects(run.evaluate(new Date('2026-07-25T12:00:00Z')), /channel 2 failed/);
  minutes[0].successCount = 10;
  minutes[0].upstreamErrorCount = 0;
  await run.evaluate(new Date('2026-07-25T12:01:00Z'));
  assert.deepEqual(calls, [
    { recovery: false, delivered: [] },
    { recovery: false, delivered: [1] },
    { recovery: true, delivered: [] },
  ]);
  assert.deepEqual(run.resolved.map((entry) => entry.id), [100]);
});

test('account alert master switch off suppresses every rule including multiplier', async () => {
  const availabilityRule = rule({ minRequests: 1 });
  const multiplierRule = rule({ id: 2, accountId: 9, metric: 'upstream_rate_multiplier', operator: 'gt', threshold: 1.5, minRequests: 0 });
  const snapshot = {
    probeStatus: 'ok', probeBillingScope: 'token', probeResolvedRateMultiplier: '2',
    probePeakRateEnabled: false, probeLastSuccessAt: new Date('2026-07-25T11:59:00Z'),
    probeFreshAt: new Date('2026-07-25T13:00:00Z'),
  };
  const off = harness({
    rules: [availabilityRule, multiplierRule],
    minutes: [minute({ successCount: 2, upstreamErrorCount: 8 })],
    account: { alertEnabled: false, ...snapshot },
  });
  await off.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.equal(off.created.length, 0);
  assert.deepEqual(off.notified, []);

  const on = harness({
    rules: [availabilityRule, multiplierRule],
    minutes: [minute({ successCount: 2, upstreamErrorCount: 8 })],
    account: { alertEnabled: true, ...snapshot },
  });
  await on.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.deepEqual(on.created.map((event) => event.metric).sort(), ['availability_low', 'upstream_rate_multiplier']);
});

test('account alert master switch off leaves existing open events untouched', async () => {
  const run = harness({
    rules: [rule()],
    minutes: [minute({ successCount: 10, upstreamErrorCount: 0 })],
    account: { alertEnabled: false },
    openEvents: [{ id: 7, accountId: 9, ruleId: 1, metric: 'availability_low', metricValue: 0.2, message: 'low' }],
  });
  await run.evaluate(new Date('2026-07-25T12:00:00Z'));
  assert.deepEqual(run.resolved, []);
  assert.deepEqual(run.notified, []);
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
