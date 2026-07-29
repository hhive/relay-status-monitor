import { prisma } from '../db';
import { minuteBucket } from './metrics';
import {
  queryUpstreamBalanceCredentialRows,
  type ReadonlyClient,
} from './sub2api-readonly';
import { openNewApiAccessToken } from './balance-credential-config';
import {
  estimateUpstreamRateMultiplier,
  queryConfiguredUpstreamUsageSnapshot,
  queryUpstreamRateMultiplier,
  type ConfiguredUpstreamBalanceCredential,
  type UpstreamUsageSnapshot,
} from './upstream-balance';

export interface BalanceCredential extends ConfiguredUpstreamBalanceCredential {
  sourceAccountId: string;
}

interface ActiveAccount {
  id: number;
  sourceAccountId: string;
}

interface BalanceMinuteWrite {
  accountId: number;
  balanceUsd: number | null;
  upstreamKeyUsedUsd: number | null;
  upstreamKeyStandardUsd: number | null;
  upstreamRateMultiplier: number | null;
  upstreamRateSource: 'api' | 'estimated' | null;
}

export interface BalanceCollectorDependencies {
  loadActiveAccounts: () => Promise<ActiveAccount[]>;
  loadCredentials: () => Promise<BalanceCredential[]>;
  probe: (credential: BalanceCredential) => Promise<UpstreamUsageSnapshot | null>;
  rateProbe?: (credential: BalanceCredential) => Promise<number | null>;
  estimateRate?: (accountId: number, bucketStart: Date, snapshot: UpstreamUsageSnapshot) => Promise<number | null>;
  write: (bucketStart: Date, rows: BalanceMinuteWrite[]) => Promise<void>;
  concurrency?: number;
}

export async function collectBalanceMinute(now: Date, dependencies: BalanceCollectorDependencies) {
  const [accounts, credentials] = await Promise.all([
    dependencies.loadActiveAccounts(),
    dependencies.loadCredentials(),
  ]);
  const credentialsBySourceId = new Map(credentials.map((item) => [item.sourceAccountId, item]));
  const rows: BalanceMinuteWrite[] = accounts.map((account) => ({
    accountId: account.id,
    balanceUsd: null,
    upstreamKeyUsedUsd: null,
    upstreamKeyStandardUsd: null,
    upstreamRateMultiplier: null,
    upstreamRateSource: null,
  }));
  const tasks = accounts.flatMap((account, index) => {
    const credential = credentialsBySourceId.get(account.sourceAccountId);
    return credential ? [{ credential, index }] : [];
  });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, dependencies.concurrency ?? 8), tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      try {
        const [snapshot, directRate] = await Promise.all([
          dependencies.probe(task.credential).catch(() => null),
          dependencies.rateProbe?.(task.credential).catch(() => null) ?? Promise.resolve(null),
        ]);
        rows[task.index].balanceUsd = snapshot?.balanceUsd != null && Number.isFinite(snapshot.balanceUsd) ? snapshot.balanceUsd : null;
        rows[task.index].upstreamKeyUsedUsd = snapshot?.keyUsedUsd != null && Number.isFinite(snapshot.keyUsedUsd) ? snapshot.keyUsedUsd : null;
        rows[task.index].upstreamKeyStandardUsd = snapshot?.keyStandardUsd != null && Number.isFinite(snapshot.keyStandardUsd) ? snapshot.keyStandardUsd : null;
        if (directRate != null && Number.isFinite(directRate)) {
          rows[task.index].upstreamRateMultiplier = directRate;
          rows[task.index].upstreamRateSource = 'api';
        }
      } catch {
        rows[task.index].balanceUsd = null;
      }
    }
  });
  await Promise.all(workers);
  const bucketStart = new Date(minuteBucket(now).getTime() - 60_000);
  if (dependencies.estimateRate) {
    await Promise.all(rows.map(async (row) => {
      if (row.upstreamRateMultiplier != null || row.upstreamKeyUsedUsd == null) return;
      const estimated = await dependencies.estimateRate!(row.accountId, bucketStart, {
        balanceUsd: row.balanceUsd,
        keyUsedUsd: row.upstreamKeyUsedUsd,
        keyStandardUsd: row.upstreamKeyStandardUsd,
      }).catch(() => null);
      if (estimated != null && Number.isFinite(estimated)) {
        row.upstreamRateMultiplier = estimated;
        row.upstreamRateSource = 'estimated';
      }
    }));
  }
  await dependencies.write(bucketStart, rows);
  const succeeded = rows.filter((row) => row.balanceUsd != null).length;
  return { attempted: tasks.length, succeeded, unavailable: rows.length - succeeded };
}

export async function runUpstreamBalanceCollection(now: Date, readClient: ReadonlyClient) {
  return collectBalanceMinute(now, {
    loadActiveAccounts: () => prisma.sub2ApiAccount.findMany({
      where: { syncState: 'ACTIVE' },
      select: { id: true, sourceAccountId: true },
    }),
    loadCredentials: async () => {
      const [upstreamCredentials, localConfigs] = await Promise.all([
        queryUpstreamBalanceCredentialRows<BalanceCredential>(readClient),
        prisma.accountBalanceCredential.findMany({
          select: {
            mode: true,
            newApiUserId: true,
            newApiAccessTokenCiphertext: true,
            account: { select: { sourceAccountId: true } },
          },
        }),
      ]);
      const configsBySourceId = new Map(localConfigs.map((config) => [config.account.sourceAccountId, config]));
      return upstreamCredentials.map((credential) => {
        const config = configsBySourceId.get(credential.sourceAccountId);
        return {
          ...credential,
          mode: config?.mode.toLowerCase() as BalanceCredential['mode'] ?? 'auto',
          newApiUserId: config?.newApiUserId,
          newApiAccessToken: config?.newApiAccessTokenCiphertext
            ? openNewApiAccessToken(config.newApiAccessTokenCiphertext)
            : null,
        };
      });
    },
    probe: queryConfiguredUpstreamUsageSnapshot,
    rateProbe: queryUpstreamRateMultiplier,
    estimateRate: async (accountId, bucketStart, snapshot) => {
      const historyStart = new Date(bucketStart.getTime() - 15 * 60_000);
      const previous = await prisma.accountMetricMinute.findFirst({
        where: {
          accountId,
          bucketStart: { gte: historyStart, lt: bucketStart },
          upstreamKeyUsedUsd: { not: null },
        },
        orderBy: { bucketStart: 'asc' },
        select: { bucketStart: true, upstreamKeyUsedUsd: true, upstreamKeyStandardUsd: true },
      });
      if (previous?.upstreamKeyUsedUsd == null || snapshot.keyUsedUsd == null) return null;
      let baseBilledUsd: number;
      if (previous.upstreamKeyStandardUsd != null && snapshot.keyStandardUsd != null) {
        baseBilledUsd = snapshot.keyStandardUsd - Number(previous.upstreamKeyStandardUsd);
      } else {
        const minutes = await prisma.accountMetricMinute.findMany({
          where: { accountId, bucketStart: { gt: previous.bucketStart, lte: bucketStart } },
          orderBy: { bucketStart: 'asc' },
          select: { baseBilledUsd: true },
        });
        const expectedMinutes = (bucketStart.getTime() - previous.bucketStart.getTime()) / 60_000;
        if (!Number.isInteger(expectedMinutes) || expectedMinutes <= 0 || minutes.length !== expectedMinutes) return null;
        baseBilledUsd = minutes.reduce((sum, minute) => sum + Number(minute.baseBilledUsd), 0);
      }
      return estimateUpstreamRateMultiplier({
        previousKeyUsedUsd: Number(previous.upstreamKeyUsedUsd),
        currentKeyUsedUsd: snapshot.keyUsedUsd,
        baseBilledUsd,
      });
    },
    write: async (bucketStart, rows) => {
      await prisma.$transaction(async (tx) => {
        for (const row of rows) {
          await tx.accountMetricMinute.upsert({
            where: { accountId_bucketStart: { accountId: row.accountId, bucketStart } },
            create: { accountId: row.accountId, bucketStart, balanceUsd: row.balanceUsd, upstreamKeyUsedUsd: row.upstreamKeyUsedUsd, upstreamKeyStandardUsd: row.upstreamKeyStandardUsd, upstreamRateMultiplier: row.upstreamRateMultiplier, upstreamRateSource: row.upstreamRateSource },
            update: { balanceUsd: row.balanceUsd, upstreamKeyUsedUsd: row.upstreamKeyUsedUsd, upstreamKeyStandardUsd: row.upstreamKeyStandardUsd, upstreamRateMultiplier: row.upstreamRateMultiplier, upstreamRateSource: row.upstreamRateSource },
          });
        }
      });
    },
  });
}
