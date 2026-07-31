import { isAccountPriority } from '../account-priority';

export interface RemoteAccountState {
  status: string | null;
  schedulable: boolean | null;
}

export function projectSyncState(remote: RemoteAccountState | null, presentInFullScan: boolean): {
  syncState: 'ACTIVE' | 'RETIRED';
  schedulable: boolean;
} {
  const active = presentInFullScan && remote?.status === 'active';
  return {
    syncState: active ? 'ACTIVE' : 'RETIRED',
    schedulable: remote ? remote.schedulable !== false : false,
  };
}

interface AccountProjection {
  source_account_id: string;
  name: string;
  platform: string | null;
  type: string | null;
  remote_status: string | null;
  schedulable: boolean | null;
  priority: number;
  rate_limited_at: Date | null;
  rate_limit_reset_at: Date | null;
  overload_until: Date | null;
  temp_unschedulable_until: Date | null;
  temp_unschedulable_reason: string | null;
  group_ids: unknown;
  group_projection: unknown;
  probe_enabled: boolean | null;
  probe_status: string | null;
  probe_received_at: string | null;
  probe_fresh_until: string | null;
  probe_billing_scope: string | null;
  probe_resolved_rate_multiplier: string | null;
  probe_peak_rate_enabled: string | null;
  probe_peak_start: string | null;
  probe_peak_end: string | null;
  probe_peak_rate_multiplier: string | null;
  probe_timezone: string | null;
  probe_next_at: string | null;
  remote_updated_at: Date | null;
}

function isValidProjection(row: AccountProjection): boolean {
  const decimal = (value: string | null | undefined) => value == null || /^\d+(?:\.\d+)?$/.test(value);
  const validDate = row.remote_updated_at == null ||
    (row.remote_updated_at instanceof Date && Number.isFinite(row.remote_updated_at.getTime()));
  const dateStrings = [row.probe_received_at, row.probe_fresh_until, row.probe_next_at];
  return Boolean(row.source_account_id && row.name) && isAccountPriority(row.priority) &&
    dateStrings.every((value) => value == null || Number.isFinite(Date.parse(value))) &&
    decimal(row.probe_resolved_rate_multiplier) && decimal(row.probe_peak_rate_multiplier) && validDate;
}

function date(value: string | null): Date | null {
  return value == null ? null : new Date(value);
}

export async function syncSub2ApiAccounts(
  readClient: ReadonlyClient,
  monitorClient: PrismaClient = prisma,
): Promise<{ readCount: number; ignoredCount: number }> {
  const startedAt = new Date();
  const run = await monitorClient.accountSyncRun.create({ data: { type: 'ACCOUNT', status: 'RUNNING', startedAt } });
  try {
    const rows = await queryAccountRows<AccountProjection>(readClient);
    let ignoredCount = 0;
    const seenAccountIds: string[] = [];
    for (const row of rows) {
    if (row.source_account_id) seenAccountIds.push(row.source_account_id);
    if (!isValidProjection(row)) { ignoredCount += 1; continue; }
    const state = projectSyncState({ status: row.remote_status, schedulable: row.schedulable }, true);
    const projection = {
      name: row.name,
      platform: row.platform,
      type: row.type,
      remoteStatus: row.remote_status,
      schedulable: state.schedulable,
      priority: row.priority,
      rateLimitedAt: row.rate_limited_at,
      rateLimitResetAt: row.rate_limit_reset_at,
      overloadUntil: row.overload_until,
      tempUnschedulableUntil: row.temp_unschedulable_until,
      tempUnschedulableReason: row.temp_unschedulable_reason,
      groupIds: row.group_ids as Prisma.InputJsonValue,
      groupProjection: row.group_projection as Prisma.InputJsonValue,
      probeEnabled: row.probe_enabled === true,
      probeStatus: row.probe_status,
      probeFreshAt: date(row.probe_fresh_until),
      probeBillingScope: row.probe_billing_scope,
      probeResolvedRateMultiplier: row.probe_resolved_rate_multiplier,
      probePeakRateEnabled: row.probe_peak_rate_enabled == null ? null : row.probe_peak_rate_enabled === 'true',
      probePeakStart: row.probe_peak_start,
      probePeakEnd: row.probe_peak_end,
      probePeakRateMultiplier: row.probe_peak_rate_multiplier,
      probeTimezone: row.probe_timezone,
      probeLastSuccessAt: row.probe_status === 'ok' ? date(row.probe_received_at) : null,
      syncState: state.syncState,
      remoteUpdatedAt: row.remote_updated_at,
      lastSyncedAt: new Date(),
    };
    await monitorClient.sub2ApiAccount.upsert({
      where: { sourceAccountId: row.source_account_id },
      create: {
        sourceAccountId: row.source_account_id,
        ...projection,
        retiredAt: state.syncState === 'RETIRED' ? new Date() : null,
      },
      update: {
        ...projection,
        retiredAt: state.syncState === 'RETIRED' ? new Date() : null,
      },
    });
    }
    await monitorClient.sub2ApiAccount.updateMany({
    where: {
      syncState: 'ACTIVE',
      ...(seenAccountIds.length > 0 ? { sourceAccountId: { notIn: seenAccountIds } } : {}),
    },
    data: { syncState: 'RETIRED', retiredAt: new Date(), lastSyncedAt: new Date() },
    });
    await monitorClient.accountSyncRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), readCount: rows.length, ignoredCount } });
    return { readCount: rows.length, ignoredCount };
  } catch (error) {
    await monitorClient.accountSyncRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), errorMessage: 'Sub2API account synchronization failed' },
    }).catch(() => undefined);
    throw error;
  }
}
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { queryAccountRows, type ReadonlyClient } from './sub2api-readonly';
