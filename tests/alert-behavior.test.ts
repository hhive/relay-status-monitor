import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceAlertCandidate,
  calculateAdjustedPriority,
  calculateRestoredPriority,
  parseAlertBehaviorSettings,
  type AlertCandidateState,
} from '../src/lib/account-observability/alert-behavior';

test('alert behavior defaults to two hits in five minutes and priority factor ten', () => {
  assert.deepEqual(parseAlertBehaviorSettings({}), {
    confirmationWindowMinutes: 5,
    confirmationCount: 2,
    priorityFactor: 10,
  });
  assert.deepEqual(parseAlertBehaviorSettings({
    alert_confirmation_window_minutes: '9',
    alert_confirmation_count: '3',
    alert_priority_factor: '0',
  }), { confirmationWindowMinutes: 9, confirmationCount: 3, priorityFactor: 0 });
  for (const invalid of ['-1', '1.5', 'x']) {
    assert.throws(() => parseAlertBehaviorSettings({ alert_confirmation_count: invalid }), /invalid/i);
  }
});

test('candidate confirms on the second hit inside the rolling window and resets after expiry', () => {
  const first = advanceAlertCandidate(null, new Date('2026-07-31T00:00:00Z'), 5, 2);
  assert.equal(first.confirmed, false);
  const second = advanceAlertCandidate(first.state, new Date('2026-07-31T00:04:59Z'), 5, 2);
  assert.equal(second.confirmed, true);

  const third = advanceAlertCandidate(second.state, new Date('2026-07-31T00:05:00Z'), 5, 2);
  assert.equal(third.confirmed, false, 'a completed batch starts the next confirmation layer');
  const fourth = advanceAlertCandidate(third.state, new Date('2026-07-31T00:05:01Z'), 5, 2);
  assert.equal(fourth.confirmed, true, 'every complete batch creates another layer');

  const expired = advanceAlertCandidate(first.state, new Date('2026-07-31T00:05:01Z'), 5, 2);
  assert.equal(expired.confirmed, false);
  assert.equal(expired.state.triggerCount, 1);
  assert.equal(expired.state.windowStartedAt.toISOString(), '2026-07-31T00:05:01.000Z');
});

test('candidate hits need not be consecutive and count one confirms immediately', () => {
  const state: AlertCandidateState = {
    windowStartedAt: new Date('2026-07-31T00:00:00Z'),
    lastTriggeredAt: new Date('2026-07-31T00:00:00Z'),
    triggerCount: 1,
  };
  assert.equal(advanceAlertCandidate(state, new Date('2026-07-31T00:03:00Z'), 5, 2).confirmed, true);
  assert.equal(advanceAlertCandidate(null, new Date('2026-07-31T00:00:00Z'), 5, 1).confirmed, true);
});

test('priority adjustment enforces minimum one and factor zero disables writes', () => {
  assert.deepEqual(calculateAdjustedPriority(5, 10), { enabled: true, basePriority: 5, adjustedPriority: 50 });
  assert.deepEqual(calculateAdjustedPriority(0, 10), { enabled: true, basePriority: 1, adjustedPriority: 10 });
  assert.deepEqual(calculateAdjustedPriority(5, 0), { enabled: false, basePriority: 5, adjustedPriority: 5 });
  assert.throws(() => calculateAdjustedPriority(214_748_365, 10), /overflow/i);
  assert.equal(calculateRestoredPriority(55, 10), 5, 'manual changes are the recovery calculation baseline');
  assert.equal(calculateRestoredPriority(5, 10), 1, 'recovery never writes below one');
});

test('schema and settings expose persistent candidates, adjustments and exact editable keys', async () => {
  const fs = await import('node:fs');
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const settings = fs.readFileSync(new URL('../src/lib/settings.ts', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../src/app/(dashboard)/settings/page.tsx', import.meta.url), 'utf8');
  assert.match(schema, /model AccountAlertCandidate/);
  assert.match(schema, /model AccountPriorityAdjustment/);
  assert.match(settings, /ALERT_CONFIRMATION_WINDOW_MIN/);
  assert.match(settings, /ALERT_CONFIRMATION_COUNT/);
  assert.match(settings, /ALERT_PRIORITY_FACTOR/);
  assert.match(page, /告警行为/);
});
