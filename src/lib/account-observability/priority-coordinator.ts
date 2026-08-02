import { prisma } from '../db';
import { calculateAdjustedPriority, calculateRestoredPriority } from './alert-behavior';
import { createSub2ApiPriorityClient, Sub2ApiPriorityError, type Sub2ApiPriorityClient } from './sub2api-priority-client';

export interface PriorityAdjustmentRecord {
  accountId: number;
  sourceAccountId: string;
  expectedPriority: number | null;
  basePriority: number | null;
  adjustedPriority: number | null;
  restoreExpectedPriority: number | null;
  restoreTargetPriority: number | null;
  appliedFactors: number[];
  factor: number;
  status: string;
  lastError: string | null;
}

export interface PriorityAdjustmentRepository {
  find(accountId: number): Promise<PriorityAdjustmentRecord | null>;
  save(record: PriorityAdjustmentRecord): Promise<void>;
  countActiveSignals(accountId: number): Promise<number>;
  listUnsettled(): Promise<PriorityAdjustmentRecord[]>;
}

export interface PriorityChangeLogEntry {
  event: 'relay_monitor_priority_changed';
  accountId: number;
  sourceAccountId: string;
  direction: 'adjust' | 'restore';
  previousPriority: number;
  targetPriority: number;
  factor: number;
  conflictRecalculated: boolean;
}

export type PrioritySyncResult = 'applied' | 'capped' | 'disabled' | 'pending_retry' | 'unchanged';

export type PriorityChangeLogger = (entry: PriorityChangeLogEntry) => void;

function errorCode(error: unknown): string {
  return error instanceof Sub2ApiPriorityError ? error.code : 'priority_request_failed';
}

function emptyRecord(account: { id: number; sourceAccountId: string }, factor: number): PriorityAdjustmentRecord {
  return {
    accountId: account.id,
    sourceAccountId: account.sourceAccountId,
    expectedPriority: null,
    basePriority: null,
    adjustedPriority: null,
    restoreExpectedPriority: null,
    restoreTargetPriority: null,
    appliedFactors: [],
    factor,
    status: 'PENDING',
    lastError: null,
  };
}

export function createPriorityCoordinator(
  repository: PriorityAdjustmentRepository,
  client: Sub2ApiPriorityClient,
  logPriorityChange: PriorityChangeLogger = () => undefined,
) {
  const logSuccessfulChange = (entry: PriorityChangeLogEntry): void => {
    try { logPriorityChange(entry); } catch { /* Logging must not invalidate a completed remote write. */ }
  };

  const settleSkippedAdjustment = async (
    record: PriorityAdjustmentRecord,
    result: 'capped' | 'disabled',
  ): Promise<{ record: PriorityAdjustmentRecord; result: PrioritySyncResult }> => {
    const settled = {
      ...record,
      expectedPriority: null,
      basePriority: null,
      adjustedPriority: null,
      status: record.appliedFactors.length > 0 ? 'ACTIVE' : 'RESTORED',
      lastError: null,
    };
    await repository.save(settled);
    return { record: settled, result };
  };

  const applyAdjustment = async (
    input: PriorityAdjustmentRecord,
    requestedFactor: number,
  ): Promise<{ record: PriorityAdjustmentRecord; result: PrioritySyncResult }> => {
    let record = input;
    const factor = ['PENDING', 'FAILED_ADJUST'].includes(record.status) ? record.factor : requestedFactor;
    if (factor === 0) {
      return settleSkippedAdjustment({ ...record, factor }, 'disabled');
    }
    if (!['PENDING', 'FAILED_ADJUST'].includes(record.status) || record.expectedPriority == null || record.adjustedPriority == null) {
      record = {
        ...record,
        expectedPriority: null,
        basePriority: null,
        adjustedPriority: null,
        restoreExpectedPriority: null,
        restoreTargetPriority: null,
        factor,
        status: 'PENDING',
        lastError: null,
      };
      await repository.save(record);
      const current = await client.getPriority(record.sourceAccountId);
      const calculated = calculateAdjustedPriority(current, factor);
      if (!calculated.enabled) {
        return settleSkippedAdjustment({ ...record, factor }, 'capped');
      }
      record = {
        ...record,
        expectedPriority: current,
        basePriority: calculated.basePriority,
        adjustedPriority: calculated.adjustedPriority,
        restoreExpectedPriority: null,
        restoreTargetPriority: null,
        factor,
        status: 'PENDING',
        lastError: null,
      };
      await repository.save(record);
    }
    let conflictRecalculated = false;
    try {
      await client.setPriority(record.sourceAccountId, record.expectedPriority!, record.adjustedPriority!);
    } catch (error) {
      if (!(error instanceof Sub2ApiPriorityError) || error.code !== 'priority_conflict' || error.currentPriority == null) throw error;
      conflictRecalculated = true;
      const recalculated = calculateAdjustedPriority(error.currentPriority, factor);
      if (!recalculated.enabled) {
        return settleSkippedAdjustment({ ...record, factor }, 'capped');
      }
      record = { ...record, expectedPriority: error.currentPriority, basePriority: recalculated.basePriority, adjustedPriority: recalculated.adjustedPriority };
      await repository.save(record);
      await client.setPriority(record.sourceAccountId, record.expectedPriority!, record.adjustedPriority!);
    }
    logSuccessfulChange({
      event: 'relay_monitor_priority_changed', accountId: record.accountId,
      sourceAccountId: record.sourceAccountId, direction: 'adjust',
      previousPriority: record.expectedPriority!, targetPriority: record.adjustedPriority!,
      factor, conflictRecalculated,
    });
    record = {
      ...record,
      appliedFactors: [...record.appliedFactors, factor],
      expectedPriority: null,
      basePriority: null,
      adjustedPriority: null,
      status: 'ACTIVE',
      lastError: null,
    };
    await repository.save(record);
    return { record, result: 'applied' };
  };

  const applyRestore = async (input: PriorityAdjustmentRecord): Promise<PriorityAdjustmentRecord> => {
    let record = input;
    const factor = record.appliedFactors.at(-1);
    if (factor == null) return record;
    if (factor === 0) {
      record = {
        ...record,
        appliedFactors: record.appliedFactors.slice(0, -1),
        status: record.appliedFactors.length > 1 ? 'ACTIVE' : 'RESTORED',
        lastError: null,
      };
      await repository.save(record);
      return record;
    }
    if (!['RESTORING', 'FAILED_RESTORE'].includes(record.status) || record.restoreExpectedPriority == null || record.restoreTargetPriority == null) {
      record = {
        ...record,
        restoreExpectedPriority: null,
        restoreTargetPriority: null,
        factor,
        status: 'RESTORING',
        lastError: null,
      };
      await repository.save(record);
      const current = await client.getPriority(record.sourceAccountId);
      record = {
        ...record,
        restoreExpectedPriority: current,
        restoreTargetPriority: calculateRestoredPriority(current, factor),
        factor,
        status: 'RESTORING',
        lastError: null,
      };
      await repository.save(record);
    }
    if (record.restoreExpectedPriority === record.restoreTargetPriority) {
      const appliedFactors = record.appliedFactors.slice(0, -1);
      record = {
        ...record,
        appliedFactors,
        restoreExpectedPriority: null,
        restoreTargetPriority: null,
        status: appliedFactors.length > 0 ? 'ACTIVE' : 'RESTORED',
        lastError: null,
      };
      await repository.save(record);
      return record;
    }
    let conflictRecalculated = false;
    try {
      await client.setPriority(record.sourceAccountId, record.restoreExpectedPriority!, record.restoreTargetPriority!);
    } catch (error) {
      if (!(error instanceof Sub2ApiPriorityError) || error.code !== 'priority_conflict' || error.currentPriority == null) throw error;
      conflictRecalculated = true;
      record = {
        ...record,
        restoreExpectedPriority: error.currentPriority,
        restoreTargetPriority: calculateRestoredPriority(error.currentPriority, factor),
      };
      await repository.save(record);
      await client.setPriority(record.sourceAccountId, record.restoreExpectedPriority!, record.restoreTargetPriority!);
    }
    logSuccessfulChange({
      event: 'relay_monitor_priority_changed', accountId: record.accountId,
      sourceAccountId: record.sourceAccountId, direction: 'restore',
      previousPriority: record.restoreExpectedPriority!, targetPriority: record.restoreTargetPriority!,
      factor, conflictRecalculated,
    });
    const appliedFactors = record.appliedFactors.slice(0, -1);
    record = {
      ...record,
      appliedFactors,
      restoreExpectedPriority: null,
      restoreTargetPriority: null,
      status: appliedFactors.length > 0 ? 'ACTIVE' : 'RESTORED',
      lastError: null,
    };
    await repository.save(record);
    return record;
  };

  const sync = async (
    account: { id: number; sourceAccountId: string },
    factor: number,
    eligible = true,
  ): Promise<PrioritySyncResult> => {
    let record = await repository.find(account.id);
    const desiredLevel = eligible ? await repository.countActiveSignals(account.id) : 0;
    if (!record && desiredLevel === 0) return 'unchanged';
    record ??= emptyRecord(account, factor);
    let result: PrioritySyncResult = 'unchanged';
    try {
      if (['PENDING', 'FAILED_ADJUST'].includes(record.status) && record.expectedPriority != null) {
        const applied = await applyAdjustment(record, record.factor);
        record = applied.record;
        result = applied.result;
        if (result === 'capped' || result === 'disabled') return result;
      } else if (['RESTORING', 'FAILED_RESTORE'].includes(record.status) && record.restoreExpectedPriority != null) {
        record = await applyRestore(record);
      }
      while (record.appliedFactors.length < desiredLevel) {
        const applied = await applyAdjustment(record, factor);
        record = applied.record;
        result = applied.result;
        if (result === 'capped' || result === 'disabled') return result;
      }
      while (record.appliedFactors.length > desiredLevel) record = await applyRestore(record);
      return result;
    } catch (error) {
      const persisted = await repository.find(account.id) ?? record;
      const restoring = ['RESTORING', 'FAILED_RESTORE'].includes(persisted.status);
      await repository.save({
        ...persisted,
        status: restoring ? 'FAILED_RESTORE' : 'FAILED_ADJUST',
        lastError: errorCode(error),
      });
      return 'pending_retry';
    }
  };

  const retry = async (accounts: ReadonlyMap<number, { id: number; sourceAccountId: string; priorityEligible?: boolean }>, factor: number): Promise<number[]> => {
    const seen = new Set<number>();
    const discardedAccountIds: number[] = [];
    for (const account of accounts.values()) {
      seen.add(account.id);
      const result = await sync(account, factor, account.priorityEligible !== false);
      if (result === 'capped' || result === 'disabled') discardedAccountIds.push(account.id);
    }
    for (const record of await repository.listUnsettled()) {
      if (!seen.has(record.accountId)) {
        const result = await sync({ id: record.accountId, sourceAccountId: record.sourceAccountId }, factor);
        if (result === 'capped' || result === 'disabled') discardedAccountIds.push(record.accountId);
      }
    }
    return discardedAccountIds;
  };

  return { adjust: sync, restore: (accountId: number) => repository.find(accountId).then((record) => (
    record ? sync({ id: record.accountId, sourceAccountId: record.sourceAccountId }, record.factor) : undefined
  )), retry };
}

const repository: PriorityAdjustmentRepository = {
  find: (accountId) => prisma.accountPriorityAdjustment.findUnique({ where: { accountId } }),
  save: async (record) => { await prisma.accountPriorityAdjustment.upsert({
    where: { accountId: record.accountId }, create: record, update: record,
  }); },
  countActiveSignals: async (accountId) => (await prisma.accountAlertCandidate.aggregate({
    where: { accountId, active: true },
    _sum: { adjustmentLevel: true },
  }))._sum.adjustmentLevel ?? 0,
  listUnsettled: () => prisma.accountPriorityAdjustment.findMany({ where: { status: { not: 'RESTORED' } } }),
};

let productionCoordinator: ReturnType<typeof createPriorityCoordinator> | null = null;
function coordinator() {
  productionCoordinator ??= createPriorityCoordinator(
    repository,
    createSub2ApiPriorityClient(),
    (entry) => { console.info(JSON.stringify(entry)); },
  );
  return productionCoordinator;
}

export async function ensurePriorityAdjusted(account: { id: number; sourceAccountId: string }, factor: number) {
  try { return await coordinator().adjust(account, factor); } catch { return 'pending_retry' as const; }
}

export async function ensurePriorityRestored(accountId: number) {
  try { await coordinator().restore(accountId); } catch { /* Retried by the next evaluation cycle. */ }
}

export async function retryPriorityAdjustments(accounts: ReadonlyMap<number, { id: number; sourceAccountId: string; priorityEligible?: boolean }>, factor: number) {
  try { return await coordinator().retry(accounts, factor); } catch { return []; }
}
