import { createSub2ApiPriorityClient } from './sub2api-priority-client';
import {
  createSub2ApiReadonlyClient,
  withReadonlyTransaction,
  type ReadonlyClient,
} from './sub2api-readonly';
import { loadAlertBehaviorSettings } from './alert-signal-store';

export const PRIORITY_CAP_ELIGIBILITY_SQL = `
  WITH target AS (
    SELECT
      a.id,
      a.status = 'active'
        AND a.schedulable IS TRUE
        AND (a.rate_limit_reset_at IS NULL OR a.rate_limit_reset_at <= NOW())
        AND (a.overload_until IS NULL OR a.overload_until <= NOW())
        AND (a.temp_unschedulable_until IS NULL OR a.temp_unschedulable_until <= NOW())
        AND (a.auto_pause_on_expired IS NOT TRUE OR a.expires_at IS NULL OR a.expires_at > NOW())
        AS target_schedulable,
      a.temp_unschedulable_reason = 'relay monitor priority capped'
        AND a.temp_unschedulable_until IS NOT NULL
        AND a.temp_unschedulable_until + ($2::int * INTERVAL '1 minute') > NOW()
        AS cooldown_active
    FROM accounts a
    WHERE a.id = $1::bigint AND a.deleted_at IS NULL
  ), target_groups AS (
    SELECT ag.group_id
    FROM account_groups ag
    JOIN target ON target.id = ag.account_id
  )
  SELECT
    EXISTS (SELECT 1 FROM target) AS target_exists,
    COALESCE((SELECT target_schedulable FROM target), false) AS target_schedulable,
    COALESCE((SELECT cooldown_active FROM target), false) AS cooldown_active,
    (SELECT COUNT(*) FROM target_groups) AS group_count,
    (SELECT COUNT(*)
      FROM target_groups target_group
      WHERE NOT EXISTS (
        SELECT 1
        FROM account_groups other_binding
        JOIN accounts other_account ON other_account.id = other_binding.account_id
        CROSS JOIN target
        WHERE other_binding.group_id = target_group.group_id
          AND other_account.id <> target.id
          AND other_account.deleted_at IS NULL
          AND other_account.status = 'active'
          AND other_account.schedulable IS TRUE
          AND (other_account.rate_limit_reset_at IS NULL OR other_account.rate_limit_reset_at <= NOW())
          AND (other_account.overload_until IS NULL OR other_account.overload_until <= NOW())
          AND (other_account.temp_unschedulable_until IS NULL OR other_account.temp_unschedulable_until <= NOW())
          AND (other_account.auto_pause_on_expired IS NOT TRUE OR other_account.expires_at IS NULL OR other_account.expires_at > NOW())
      )) AS groups_without_replacement
`;

export type PriorityCapEligibility =
  | { safe: true; reason: 'eligible' }
  | { safe: false; reason: 'account_missing' | 'account_unschedulable' | 'ungrouped' | 'last_account' | 'cooldown' };

interface EligibilityRow {
  target_exists: boolean;
  target_schedulable: boolean;
  cooldown_active: boolean;
  group_count: bigint | number;
  groups_without_replacement: bigint | number;
}

export async function queryPriorityCapPauseEligibility(
  client: ReadonlyClient,
  sourceAccountId: string,
  cooldownMinutes: number,
): Promise<PriorityCapEligibility> {
  if (!/^[1-9]\d*$/.test(sourceAccountId)) throw new Error('invalid account id');
  if (!Number.isSafeInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1_440) {
    throw new Error('invalid cooldown minutes');
  }
  const rows = await withReadonlyTransaction(client, (tx) =>
    tx.$queryRawUnsafe<EligibilityRow[]>(PRIORITY_CAP_ELIGIBILITY_SQL, sourceAccountId, cooldownMinutes));
  const row = rows[0];
  if (!row) throw new Error('invalid priority cap eligibility response');
  if (!row.target_exists) return { safe: false, reason: 'account_missing' };
  if (!row.target_schedulable) return { safe: false, reason: 'account_unschedulable' };
  if (row.cooldown_active) return { safe: false, reason: 'cooldown' };
  if (Number(row.group_count) === 0) return { safe: false, reason: 'ungrouped' };
  if (Number(row.groups_without_replacement) > 0) return { safe: false, reason: 'last_account' };
  return { safe: true, reason: 'eligible' };
}

export type PriorityCapPauseResult = {
  status: 'paused' | 'skipped_disabled' | 'skipped_account_missing' | 'skipped_account_unschedulable' |
    'skipped_ungrouped' | 'skipped_last_account' | 'skipped_cooldown' | 'failed';
  until?: Date;
};

export interface PriorityCapPausePolicy {
  enabled: boolean;
  durationMinutes: number;
  cooldownMinutes: number;
}

export function createPriorityCapPauser(input: {
  checkEligibility: (sourceAccountId: string, cooldownMinutes: number) => Promise<PriorityCapEligibility>;
  pauseScheduling: (sourceAccountId: string, durationMinutes: number) => Promise<Date>;
}) {
  let tail = Promise.resolve();
  const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
  return {
    pauseIfSafe: (
      account: { id: number; sourceAccountId: string },
      policy: PriorityCapPausePolicy,
    ): Promise<PriorityCapPauseResult> => serialized(async () => {
      try {
        if (!policy.enabled) return { status: 'skipped_disabled' };
        const eligibility = await input.checkEligibility(account.sourceAccountId, policy.cooldownMinutes);
        if (!eligibility.safe) return { status: `skipped_${eligibility.reason}` } as PriorityCapPauseResult;
        return { status: 'paused', until: await input.pauseScheduling(account.sourceAccountId, policy.durationMinutes) };
      } catch {
        return { status: 'failed' };
      }
    }),
  };
}

let productionPauser: ReturnType<typeof createPriorityCapPauser> | null = null;

export async function pausePriorityCappedAccount(account: { id: number; sourceAccountId: string }): Promise<void> {
  let result: PriorityCapPauseResult = { status: 'failed' };
  try {
    const settings = await loadAlertBehaviorSettings();
    const policy = {
      enabled: settings.priorityCapPauseEnabled,
      durationMinutes: settings.priorityCapPauseDurationMinutes,
      cooldownMinutes: settings.priorityCapPauseCooldownMinutes,
    };
    if (!policy.enabled) {
      result = { status: 'skipped_disabled' };
    } else if (!productionPauser) {
      const readonlyClient = createSub2ApiReadonlyClient();
      const priorityClient = createSub2ApiPriorityClient();
      productionPauser = createPriorityCapPauser({
        checkEligibility: (sourceAccountId, cooldownMinutes) =>
          queryPriorityCapPauseEligibility(readonlyClient, sourceAccountId, cooldownMinutes),
        pauseScheduling: (sourceAccountId, durationMinutes) =>
          priorityClient.pauseScheduling(sourceAccountId, durationMinutes),
      });
    }
    if (policy.enabled) result = await productionPauser!.pauseIfSafe(account, policy);
  } catch {
    // The structured failed result below keeps configuration errors observable.
  }
  console.info(JSON.stringify({
    event: 'relay_monitor_priority_cap_pause',
    accountId: account.id,
    sourceAccountId: account.sourceAccountId,
    status: result.status,
    ...(result.until ? { until: result.until.toISOString() } : {}),
  }));
}
