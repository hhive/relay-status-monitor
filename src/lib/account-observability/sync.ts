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
  probe_enabled: boolean | null;
  probe_projection: Record<string, unknown> | null;
  remote_updated_at: Date | null;
}

function probeValue(probe: Record<string, unknown> | null, key: string): string | null {
  const value = probe?.data && typeof probe.data === 'object'
    ? (probe.data as Record<string, unknown>)[key]
    : probe?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

export async function syncSub2ApiAccounts(
  readClient: ReadonlyClient,
  monitorClient: PrismaClient = prisma,
): Promise<{ readCount: number; ignoredCount: number }> {
  const startedAt = new Date();
  const run = await monitorClient.accountSyncRun.create({ data: { type: 'ACCOUNT', status: 'RUNNING', startedAt } });
  let rows: AccountProjection[];
  try {
    rows = await queryAccountRows<AccountProjection>(readClient);
  } catch (error) {
    await monitorClient.accountSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), errorMessage: 'Sub2API account query failed' } });
    throw error;
  }
  let ignoredCount = 0;
  for (const row of rows) {
    if (!row.source_account_id || !row.name) { ignoredCount += 1; continue; }
    const state = projectSyncState({ status: row.remote_status, schedulable: true }, true);
    const probe = row.probe_projection;
    await monitorClient.sub2ApiAccount.upsert({
      where: { sourceAccountId: row.source_account_id },
      create: {
        sourceAccountId: row.source_account_id,
        name: row.name,
        platform: row.platform,
        type: row.type,
        remoteStatus: row.remote_status,
        schedulable: state.schedulable,
        probeEnabled: row.probe_enabled === true,
        probeStatus: typeof probe?.status === 'string' ? probe.status : null,
        probeFreshAt: row.remote_updated_at,
        probeResolvedRateMultiplier: probeValue(probe, 'resolved_rate_multiplier'),
        probePeakRateMultiplier: probeValue(probe, 'peak_rate_multiplier'),
        syncState: state.syncState,
        remoteUpdatedAt: row.remote_updated_at,
        lastSyncedAt: new Date(),
      },
      update: {
        name: row.name,
        platform: row.platform,
        type: row.type,
        remoteStatus: row.remote_status,
        schedulable: state.schedulable,
        probeEnabled: row.probe_enabled === true,
        probeStatus: typeof probe?.status === 'string' ? probe.status : null,
        probeFreshAt: row.remote_updated_at,
        probeResolvedRateMultiplier: probeValue(probe, 'resolved_rate_multiplier'),
        probePeakRateMultiplier: probeValue(probe, 'peak_rate_multiplier'),
        syncState: state.syncState,
        remoteUpdatedAt: row.remote_updated_at,
        lastSyncedAt: new Date(),
        retiredAt: state.syncState === 'RETIRED' ? new Date() : null,
      },
    });
  }
  await monitorClient.accountSyncRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), readCount: rows.length, ignoredCount } });
  return { readCount: rows.length, ignoredCount };
}
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { queryAccountRows, type ReadonlyClient } from './sub2api-readonly';
