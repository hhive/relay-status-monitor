import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRIORITY_CAP_ELIGIBILITY_SQL,
  createPriorityCapPauser,
  queryPriorityCapPauseEligibility,
} from '../src/lib/account-observability/priority-cap-pause';
import type { ReadonlyClient } from '../src/lib/account-observability/sub2api-readonly';

function readonlyClient(rows: unknown[]): ReadonlyClient {
  return {
    $executeRawUnsafe: async () => undefined,
    $queryRawUnsafe: async <T>() => rows as T,
    $transaction: async <T>(operation: (tx: ReadonlyClient) => Promise<T>) => operation(readonlyClient(rows)),
    $disconnect: async () => undefined,
  };
}

test('priority cap eligibility uses live account-level schedulability for every target group', async () => {
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /account_groups/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /other_account\.id <> target\.id/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /status = 'active'/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /schedulable IS TRUE/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /rate_limit_reset_at IS NULL/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /overload_until IS NULL/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /temp_unschedulable_until IS NULL/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /auto_pause_on_expired IS NOT TRUE/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /relay monitor priority capped/);
  assert.match(PRIORITY_CAP_ELIGIBILITY_SQL, /INTERVAL '1 minute'/);

  const eligible = await queryPriorityCapPauseEligibility(readonlyClient([{
    target_exists: true, target_schedulable: true, cooldown_active: false, group_count: 2, groups_without_replacement: 0,
  }]), '7', 5);
  assert.deepEqual(eligible, { safe: true, reason: 'eligible' });

  const lastInOneGroup = await queryPriorityCapPauseEligibility(readonlyClient([{
    target_exists: true, target_schedulable: true, cooldown_active: false, group_count: 2, groups_without_replacement: 1,
  }]), '7', 5);
  assert.deepEqual(lastInOneGroup, { safe: false, reason: 'last_account' });
});

test('priority cap eligibility skips missing, ungrouped, and already unschedulable accounts', async () => {
  const cases = [
    [{ target_exists: false, target_schedulable: false, cooldown_active: false, group_count: 0, groups_without_replacement: 0 }, 'account_missing'],
    [{ target_exists: true, target_schedulable: true, cooldown_active: false, group_count: 0, groups_without_replacement: 0 }, 'ungrouped'],
    [{ target_exists: true, target_schedulable: false, cooldown_active: false, group_count: 1, groups_without_replacement: 0 }, 'account_unschedulable'],
    [{ target_exists: true, target_schedulable: true, cooldown_active: true, group_count: 1, groups_without_replacement: 0 }, 'cooldown'],
  ] as const;
  for (const [row, reason] of cases) {
    assert.deepEqual(await queryPriorityCapPauseEligibility(readonlyClient([row]), '7', 5), { safe: false, reason });
  }
  await assert.rejects(queryPriorityCapPauseEligibility(readonlyClient([]), '7', 5), /eligibility response/i);
  await assert.rejects(queryPriorityCapPauseEligibility(readonlyClient([]), 'invalid', 5), /account id/i);
});

test('priority cap pauser serializes live rechecks and preserves the last account', async () => {
  let available = 2;
  let activeChecks = 0;
  let maxActiveChecks = 0;
  const paused: string[] = [];
  const pauser = createPriorityCapPauser({
    checkEligibility: async () => {
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeChecks -= 1;
      return available > 1 ? { safe: true, reason: 'eligible' } : { safe: false, reason: 'last_account' };
    },
    pauseScheduling: async (sourceAccountId, durationMinutes) => {
      assert.equal(durationMinutes, 3);
      paused.push(sourceAccountId); available -= 1; return new Date('2026-08-09T00:03:00Z');
    },
  });

  const results = await Promise.all([
    pauser.pauseIfSafe({ id: 1, sourceAccountId: '11' }, { enabled: true, durationMinutes: 3, cooldownMinutes: 5 }),
    pauser.pauseIfSafe({ id: 2, sourceAccountId: '12' }, { enabled: true, durationMinutes: 3, cooldownMinutes: 5 }),
  ]);

  assert.equal(maxActiveChecks, 1);
  assert.deepEqual(paused, ['11']);
  assert.deepEqual(results.map((result) => result.status), ['paused', 'skipped_last_account']);
});

test('priority cap pauser reports a failed pause without throwing', async () => {
  const pauser = createPriorityCapPauser({
    checkEligibility: async () => ({ safe: true, reason: 'eligible' }),
    pauseScheduling: async () => { throw new Error('unavailable'); },
  });
  assert.deepEqual(await pauser.pauseIfSafe(
    { id: 1, sourceAccountId: '11' },
    { enabled: true, durationMinutes: 1, cooldownMinutes: 5 },
  ), { status: 'failed' });
});

test('priority cap pauser skips all reads and writes when pausing is disabled', async () => {
  const pauser = createPriorityCapPauser({
    checkEligibility: async () => { throw new Error('disabled must not query'); },
    pauseScheduling: async () => { throw new Error('disabled must not pause'); },
  });
  assert.deepEqual(await pauser.pauseIfSafe(
    { id: 1, sourceAccountId: '11' },
    { enabled: false, durationMinutes: 1, cooldownMinutes: 5 },
  ), { status: 'skipped_disabled' });
});

test('priority cap pauser reports paused, failed, and safe-skip outcomes to its observer', async () => {
  const observed: Array<{ accountId: number; status: string; errorCode?: string }> = [];
  let outcome: 'paused' | 'failed' | 'skipped' = 'paused';
  const pauser = createPriorityCapPauser({
    checkEligibility: async () => outcome === 'skipped'
      ? { safe: false, reason: 'last_account' }
      : { safe: true, reason: 'eligible' },
    pauseScheduling: async () => {
      if (outcome === 'failed') throw new Error('secret=must-not-be-recorded');
      return new Date('2026-08-09T00:03:00Z');
    },
    recordResult: async (account, result, errorCode) => {
      observed.push({ accountId: account.id, status: result.status, ...(errorCode ? { errorCode } : {}) });
    },
  });
  const account = { id: 1, sourceAccountId: '11' };
  const policy = { enabled: true, durationMinutes: 3, cooldownMinutes: 5 };

  await pauser.pauseIfSafe(account, policy);
  outcome = 'failed';
  await pauser.pauseIfSafe(account, policy);
  outcome = 'skipped';
  await pauser.pauseIfSafe(account, policy);

  assert.deepEqual(observed, [
    { accountId: 1, status: 'paused' },
    { accountId: 1, status: 'failed', errorCode: 'priority_cap_pause_failed' },
    { accountId: 1, status: 'skipped_last_account' },
  ]);
  assert.doesNotMatch(JSON.stringify(observed), /must-not-be-recorded/);
});
