import { prisma } from '../db';
import { createSub2ApiReadonlyClient } from './sub2api-readonly';
import { queryProviderErrorRows, queryUsageRows } from './sub2api-readonly';
import { syncSub2ApiAccounts } from './sync';
import { aggregateMinute, type ErrorEvent, type UsageEvent } from './aggregate';
import { minuteBucket } from './metrics';

export async function runAccountObservabilityCycle(now = new Date()): Promise<{ skipped: boolean; readCount: number; ignoredCount: number }> {
  if (!process.env.SUB2API_DATABASE_URL) return { skipped: true, readCount: 0, ignoredCount: 0 };
  const minute = now.getUTCMinutes();
  if (minute % 5 !== 0) return { skipped: true, readCount: 0, ignoredCount: 0 };
  const client = createSub2ApiReadonlyClient();
  try {
    const sync = minute % 5 === 0 ? await syncSub2ApiAccounts(client, prisma) : { readCount: 0, ignoredCount: 0 };
    const end = minuteBucket(now);
    const start = new Date(end.getTime() - 10 * 60_000);
    const [usageRows, errorRows] = await Promise.all([
      queryUsageRows<Record<string, unknown>>(client, start, end),
      queryProviderErrorRows<Record<string, unknown>>(client, start, end),
    ]);
    const accounts = await prisma.sub2ApiAccount.findMany({ select: { id: true, sourceAccountId: true } });
    const localIds = new Map(accounts.map((account) => [account.sourceAccountId, account.id]));
    const grouped = new Map<string, { usages: UsageEvent[]; errors: ErrorEvent[] }>();
    const bucketFor = (createdAt: unknown) => minuteBucket(new Date(String(createdAt))).toISOString();
    for (const row of usageRows) {
      const accountId = String(row.account_id ?? '');
      const key = `${accountId}|${bucketFor(row.created_at)}`;
      const bucket = grouped.get(key) ?? { usages: [], errors: [] };
      bucket.usages.push({ accountId, requestId: row.request_id == null ? null : String(row.request_id), durationMs: row.duration_ms == null ? null : Number(row.duration_ms), firstTokenMs: row.first_token_ms == null ? null : Number(row.first_token_ms), inputTokens: Number(row.input_tokens ?? 0), cacheReadTokens: Number(row.cache_read_tokens ?? 0), cacheCreationTokens: Number(row.cache_creation_tokens ?? 0), actualCost: String(row.actual_cost ?? '0'), accountStatsCost: row.account_stats_cost == null ? null : String(row.account_stats_cost), accountRateMultiplier: row.account_rate_multiplier == null ? null : String(row.account_rate_multiplier) });
      grouped.set(key, bucket);
    }
    for (const row of errorRows) {
      const accountId = String(row.account_id ?? '');
      const key = `${accountId}|${bucketFor(row.created_at)}`;
      const bucket = grouped.get(key) ?? { usages: [], errors: [] };
      bucket.errors.push({ accountId, requestId: row.request_id == null ? null : String(row.request_id), clientRequestId: row.client_request_id == null ? null : String(row.client_request_id), errorOwner: row.error_owner == null ? null : String(row.error_owner), errorPhase: row.error_phase == null ? null : String(row.error_phase), statusCode: row.status_code == null ? null : Number(row.status_code) });
      grouped.set(key, bucket);
    }
    for (const [key, events] of grouped) {
      const [sourceAccountId, bucketStart] = key.split('|');
      const accountId = localIds.get(sourceAccountId);
      if (!accountId) continue;
      const aggregate = aggregateMinute(events);
      await prisma.accountMetricMinute.upsert({
        where: { accountId_bucketStart: { accountId, bucketStart: new Date(bucketStart) } },
        create: { accountId, bucketStart: new Date(bucketStart), successCount: aggregate.successCount, upstreamErrorCount: aggregate.upstreamErrorCount, eligibleCount: aggregate.eligibleCount, durationCount: aggregate.durationCount, durationSumMs: BigInt(aggregate.durationSumMs), durationHistogram: aggregate.durationHistogram, firstTokenHistogram: aggregate.firstTokenHistogram, inputTokens: BigInt(aggregate.inputTokens), cacheReadTokens: BigInt(aggregate.cacheReadTokens), cacheCreationTokens: BigInt(aggregate.cacheCreationTokens), userBilledUsd: (aggregate.userBilledMicroUsd / 1_000_000).toFixed(6), accountBilledUsd: (aggregate.accountBilledMicroUsd / 1_000_000).toFixed(6) },
        update: { successCount: aggregate.successCount, upstreamErrorCount: aggregate.upstreamErrorCount, eligibleCount: aggregate.eligibleCount, durationCount: aggregate.durationCount, durationSumMs: BigInt(aggregate.durationSumMs), durationHistogram: aggregate.durationHistogram, firstTokenHistogram: aggregate.firstTokenHistogram, inputTokens: BigInt(aggregate.inputTokens), cacheReadTokens: BigInt(aggregate.cacheReadTokens), cacheCreationTokens: BigInt(aggregate.cacheCreationTokens), userBilledUsd: (aggregate.userBilledMicroUsd / 1_000_000).toFixed(6), accountBilledUsd: (aggregate.accountBilledMicroUsd / 1_000_000).toFixed(6) },
      });
    }
    return { skipped: false, ...sync };
  } finally {
    await client.$disconnect();
  }
}
