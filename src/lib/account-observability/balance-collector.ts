import { prisma } from '../db';
import { minuteBucket } from './metrics';
import {
  queryUpstreamBalanceCredentialRows,
  type ReadonlyClient,
} from './sub2api-readonly';
import { openNewApiAccessToken } from './balance-credential-config';
import {
  queryConfiguredUpstreamBalance,
  type ConfiguredUpstreamBalanceCredential,
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
}

export interface BalanceCollectorDependencies {
  loadActiveAccounts: () => Promise<ActiveAccount[]>;
  loadCredentials: () => Promise<BalanceCredential[]>;
  probe: (credential: BalanceCredential) => Promise<number | null>;
  write: (bucketStart: Date, rows: BalanceMinuteWrite[]) => Promise<void>;
  concurrency?: number;
}

export async function collectBalanceMinute(now: Date, dependencies: BalanceCollectorDependencies) {
  const [accounts, credentials] = await Promise.all([
    dependencies.loadActiveAccounts(),
    dependencies.loadCredentials(),
  ]);
  const credentialsBySourceId = new Map(credentials.map((item) => [item.sourceAccountId, item]));
  const rows = accounts.map((account) => ({ accountId: account.id, balanceUsd: null as number | null }));
  const tasks = accounts.flatMap((account, index) => {
    const credential = credentialsBySourceId.get(account.sourceAccountId);
    return credential ? [{ credential, index }] : [];
  });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, dependencies.concurrency ?? 8), tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      try {
        const value = await dependencies.probe(task.credential);
        rows[task.index].balanceUsd = value != null && Number.isFinite(value) ? value : null;
      } catch {
        rows[task.index].balanceUsd = null;
      }
    }
  });
  await Promise.all(workers);
  const bucketStart = new Date(minuteBucket(now).getTime() - 60_000);
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
    probe: queryConfiguredUpstreamBalance,
    write: async (bucketStart, rows) => {
      await prisma.$transaction(async (tx) => {
        for (const row of rows) {
          await tx.accountMetricMinute.upsert({
            where: { accountId_bucketStart: { accountId: row.accountId, bucketStart } },
            create: { accountId: row.accountId, bucketStart, balanceUsd: row.balanceUsd },
            update: { balanceUsd: row.balanceUsd },
          });
        }
      });
    },
  });
}
