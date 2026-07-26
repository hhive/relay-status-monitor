import type { AccountMetricSnapshotWindow } from '@prisma/client';

import { prisma } from '../db';
import { aggregateMetricMinutes, type MetricMinuteAggregateInput } from './metric-aggregate';
import { resolveAccountWindow, type AccountWindow, type AccountWindowKey } from './window';

export const SNAPSHOT_WINDOWS: Record<AccountWindowKey, AccountMetricSnapshotWindow> = {
  today: 'TODAY',
  last1h: 'LAST_1H',
  last24h: 'LAST_24H',
};

export interface AccountMetricSnapshotWrite {
  accountId: number;
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  availability: number | null;
  errorRate: number | null;
  durationP95Ms: number | null;
  firstTokenP95Ms: number | null;
  cacheHitRate: number | null;
  userBilledUsd: string;
  accountBilledUsd: string;
  lastCompleteMinute: Date | null;
}

export interface SnapshotBatchWrite {
  windowKey: AccountMetricSnapshotWindow;
  windowStart: Date;
  windowEnd: Date;
  lastCompleteMinute: Date | null;
  computedAt: Date;
  rows: AccountMetricSnapshotWrite[];
}

export type SnapshotClient = Pick<typeof prisma,
  'sub2ApiAccount' | 'accountMetricMinute' | 'accountMetricSnapshotBatch' |
  'accountMetricSnapshot' | '$transaction'>;

export function buildSnapshotRows(input: {
  accounts: Array<{ id: number }>;
  minutes: Array<MetricMinuteAggregateInput & { accountId: number }>;
  window: AccountWindow;
}): AccountMetricSnapshotWrite[] {
  const rowsByAccount = new Map<number, MetricMinuteAggregateInput[]>();
  for (const row of input.minutes) {
    if (row.bucketStart < input.window.start || row.bucketStart >= input.window.end) continue;
    const rows = rowsByAccount.get(row.accountId) ?? [];
    rows.push(row);
    rowsByAccount.set(row.accountId, rows);
  }
  return input.accounts.map(({ id: accountId }) => {
    const rows = rowsByAccount.get(accountId) ?? [];
    const metric = aggregateMetricMinutes(rows);
    return {
      accountId,
      successCount: metric.successCount,
      upstreamErrorCount: metric.upstreamErrorCount,
      eligibleCount: metric.eligibleCount,
      availability: metric.availability,
      errorRate: metric.errorRate,
      durationP95Ms: metric.durationP95Ms,
      firstTokenP95Ms: metric.firstTokenP95Ms,
      cacheHitRate: metric.cacheHitRate,
      userBilledUsd: metric.userBilledUsd,
      accountBilledUsd: metric.accountBilledUsd,
      lastCompleteMinute: rows.reduce<Date | null>((latest, row) =>
        latest === null || row.bucketStart > latest ? row.bucketStart : latest, null),
    };
  });
}

export async function replaceActiveSnapshot(input: SnapshotBatchWrite, client: SnapshotClient = prisma) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await client.$transaction(async (tx) => {
        const lockKey = `relay-monitor:account-snapshot:${input.windowKey}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS lock_result`;
        const current = await tx.accountMetricSnapshotBatch.findFirst({
          where: { windowKey: input.windowKey, active: true },
          orderBy: { windowEnd: 'desc' },
        });
        if (current && current.windowEnd >= input.windowEnd) return { batch: current, skipped: true };

        const batch = await tx.accountMetricSnapshotBatch.create({
          data: {
            windowKey: input.windowKey,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
            lastCompleteMinute: input.lastCompleteMinute,
            computedAt: input.computedAt,
            active: false,
          },
        });
        const inserted = await tx.accountMetricSnapshot.createMany({
          data: input.rows.map((row) => ({ ...row, batchId: batch.id })),
        });
        if (inserted.count !== input.rows.length) throw new Error('snapshot row count mismatch');
        await tx.accountMetricSnapshotBatch.updateMany({
          where: { windowKey: input.windowKey, active: true },
          data: { active: false },
        });
        const active = await tx.accountMetricSnapshotBatch.update({
          where: { id: batch.id },
          data: { active: true },
        });
        return { batch: active, skipped: false };
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code !== 'P2034' || attempt === 3) throw error;
    }
  }
  throw new Error('snapshot replacement retry loop exhausted');
}

interface SnapshotRefreshOptions {
  replace?: (
    input: SnapshotBatchWrite,
    client?: SnapshotClient,
  ) => Promise<{ batch: { id: number }; skipped: boolean }>;
  warn?: (message: string) => void;
}

export async function refreshAccountMetricSnapshots(
  now = new Date(),
  client: SnapshotClient = prisma,
  options: SnapshotRefreshOptions = {},
) {
  const replace = options.replace ?? replaceActiveSnapshot;
  const warn = options.warn ?? console.warn;
  const windows = (['today', 'last1h', 'last24h'] as const).map((key) => resolveAccountWindow(key, now));
  const accounts = await client.sub2ApiAccount.findMany({ select: { id: true } });
  const earliest = windows.reduce((value, window) => window.start < value ? window.start : value, windows[0].start);
  const minutes = await client.accountMetricMinute.findMany({
    where: { bucketStart: { gte: earliest, lt: windows[0].end } },
    orderBy: [{ bucketStart: 'asc' }, { accountId: 'asc' }],
  });
  const results = [];
  for (const window of windows) {
    const windowKey = SNAPSHOT_WINDOWS[window.key];
    const result = await replace({
      windowKey,
      windowStart: window.start,
      windowEnd: window.end,
      lastCompleteMinute: window.lastCompleteMinute,
      computedAt: now,
      rows: buildSnapshotRows({ accounts, minutes, window }),
    }, client);
    results.push(result);
    if (!result.skipped) {
      try {
        await client.accountMetricSnapshotBatch.deleteMany({
          where: { windowKey, active: false, id: { not: result.batch.id } },
        });
      } catch {
        warn(`inactive account snapshot cleanup failed for ${windowKey}`);
      }
    }
  }
  return results;
}
