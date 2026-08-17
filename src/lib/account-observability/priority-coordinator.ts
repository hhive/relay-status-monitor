import { prisma } from '../db';
import { calculateAdjustedPriority, calculateRestoredPriority } from './alert-behavior';
import { createSub2ApiPriorityClient, Sub2ApiPriorityError, type Sub2ApiPriorityClient } from './sub2api-priority-client';
import { pausePriorityCappedAccount } from './priority-cap-pause';
import { recordAccountSchedulingAction, recordOperationalFailure, recoverOperationalAlert } from '../operational-alerts';

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
export type PriorityCapHandler = (account: { id: number; sourceAccountId: string }) => Promise<unknown>;

export interface PrioritySchedulingAction {
  accountId: number;
  sourceAccountId: string;
  actionType: 'PRIORITY_ADJUST' | 'PRIORITY_RESTORE';
  result: 'SUCCESS' | 'FAILURE';
  priorityBefore: number | null;
  priorityAfter: number | null;
  factor: number;
  conflictRecomputed: boolean;
  errorCode?: string;
}

export interface PriorityCoordinatorInstrumentation {
  recordAction(entry: PrioritySchedulingAction): Promise<void> | void;
  recordFailure(entry: { sourceAccountId: string; errorCode: string }): Promise<void> | void;
  recoverFailure(sourceAccountId: string): Promise<void> | void;
}

const noopInstrumentation: PriorityCoordinatorInstrumentation = {
  recordAction: () => undefined,
  recordFailure: () => undefined,
  recoverFailure: () => undefined,
};

class PriorityAttemptError extends Error {
  constructor(readonly original: unknown, readonly conflictRecomputed: boolean) {
    super('priority_attempt_failed');
  }
}

function errorCode(error: unknown): string {
  const source = error instanceof PriorityAttemptError ? error.original : error;
  return source instanceof Sub2ApiPriorityError ? source.code : 'priority_request_failed';
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
  onPriorityCapped: PriorityCapHandler = async () => undefined,
  instrumentation: PriorityCoordinatorInstrumentation = noopInstrumentation,
) {
  const logSuccessfulChange = (entry: PriorityChangeLogEntry): void => {
    try { logPriorityChange(entry); } catch { /* Logging must not invalidate a completed remote write. */ }
  };

  const observe = async (operation: () => Promise<void> | void): Promise<void> => {
    try { await operation(); } catch { /* Observability must not alter scheduling state. */ }
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
    if (result === 'capped') {
      try {
        await onPriorityCapped({ id: settled.accountId, sourceAccountId: settled.sourceAccountId });
      } catch { /* A scheduling pause failure must not recreate settled priority debt. */ }
    }
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
      try {
        await client.setPriority(record.sourceAccountId, record.expectedPriority!, record.adjustedPriority!);
      } catch (retryError) {
        throw new PriorityAttemptError(retryError, true);
      }
    }
    logSuccessfulChange({
      event: 'relay_monitor_priority_changed', accountId: record.accountId,
      sourceAccountId: record.sourceAccountId, direction: 'adjust',
      previousPriority: record.expectedPriority!, targetPriority: record.adjustedPriority!,
      factor, conflictRecalculated,
    });
    await observe(() => instrumentation.recordAction({
      accountId: record.accountId,
      sourceAccountId: record.sourceAccountId,
      actionType: 'PRIORITY_ADJUST',
      result: 'SUCCESS',
      priorityBefore: record.expectedPriority!,
      priorityAfter: record.adjustedPriority!,
      factor,
      conflictRecomputed: conflictRecalculated,
    }));
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
      try {
        await client.setPriority(record.sourceAccountId, record.restoreExpectedPriority!, record.restoreTargetPriority!);
      } catch (retryError) {
        throw new PriorityAttemptError(retryError, true);
      }
    }
    logSuccessfulChange({
      event: 'relay_monitor_priority_changed', accountId: record.accountId,
      sourceAccountId: record.sourceAccountId, direction: 'restore',
      previousPriority: record.restoreExpectedPriority!, targetPriority: record.restoreTargetPriority!,
      factor, conflictRecalculated,
    });
    await observe(() => instrumentation.recordAction({
      accountId: record.accountId,
      sourceAccountId: record.sourceAccountId,
      actionType: 'PRIORITY_RESTORE',
      result: 'SUCCESS',
      priorityBefore: record.restoreExpectedPriority!,
      priorityAfter: record.restoreTargetPriority!,
      factor,
      conflictRecomputed: conflictRecalculated,
    }));
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
        if (result === 'capped' || result === 'disabled') {
          await observe(() => instrumentation.recoverFailure(account.sourceAccountId));
          return result;
        }
      } else if (['RESTORING', 'FAILED_RESTORE'].includes(record.status) && record.restoreExpectedPriority != null) {
        record = await applyRestore(record);
      }
      while (record.appliedFactors.length < desiredLevel) {
        const applied = await applyAdjustment(record, factor);
        record = applied.record;
        result = applied.result;
        if (result === 'capped' || result === 'disabled') {
          await observe(() => instrumentation.recoverFailure(account.sourceAccountId));
          return result;
        }
      }
      while (record.appliedFactors.length > desiredLevel) record = await applyRestore(record);
      await observe(() => instrumentation.recoverFailure(account.sourceAccountId));
      return result;
    } catch (error) {
      const persisted = await repository.find(account.id) ?? record;
      const restoring = ['RESTORING', 'FAILED_RESTORE'].includes(persisted.status);
      const code = errorCode(error);
      await repository.save({
        ...persisted,
        status: restoring ? 'FAILED_RESTORE' : 'FAILED_ADJUST',
        lastError: code,
      });
      await observe(() => instrumentation.recordAction({
        accountId: persisted.accountId,
        sourceAccountId: persisted.sourceAccountId,
        actionType: restoring ? 'PRIORITY_RESTORE' : 'PRIORITY_ADJUST',
        result: 'FAILURE',
        priorityBefore: restoring ? persisted.restoreExpectedPriority : persisted.expectedPriority,
        priorityAfter: restoring ? persisted.restoreTargetPriority : persisted.adjustedPriority,
        factor: persisted.factor,
        conflictRecomputed: error instanceof PriorityAttemptError && error.conflictRecomputed,
        errorCode: code,
      }));
      await observe(() => instrumentation.recordFailure({ sourceAccountId: persisted.sourceAccountId, errorCode: code }));
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
const productionInstrumentation: PriorityCoordinatorInstrumentation = {
  recordAction: (entry) => recordAccountSchedulingAction({
    accountId: entry.accountId,
    sourceAccountId: entry.sourceAccountId,
    accountName: `Sub2API #${entry.sourceAccountId}`,
    actionType: entry.actionType,
    result: entry.result,
    priorityBefore: entry.priorityBefore,
    priorityAfter: entry.priorityAfter,
    factor: entry.factor,
    conflictRecomputed: entry.conflictRecomputed,
    errorCode: entry.errorCode,
  }),
  recordFailure: ({ sourceAccountId, errorCode }) => recordOperationalFailure(
    'priority_adjustment_failed', sourceAccountId, `Sub2API #${sourceAccountId}`, errorCode,
  ),
  recoverFailure: (sourceAccountId) => recoverOperationalAlert('priority_adjustment_failed', sourceAccountId),
};
function coordinator() {
  productionCoordinator ??= createPriorityCoordinator(
    repository,
    createSub2ApiPriorityClient(),
    (entry) => { console.info(JSON.stringify(entry)); },
    pausePriorityCappedAccount,
    productionInstrumentation,
  );
  return productionCoordinator;
}

export async function ensurePriorityAdjusted(account: { id: number; sourceAccountId: string }, factor: number) {
  try { return await coordinator().adjust(account, factor); } catch (error) {
    const code = errorCode(error);
    await productionInstrumentation.recordAction({
      accountId: account.id,
      sourceAccountId: account.sourceAccountId,
      actionType: 'PRIORITY_ADJUST',
      result: 'FAILURE',
      priorityBefore: null,
      priorityAfter: null,
      factor,
      conflictRecomputed: false,
      errorCode: code,
    });
    await productionInstrumentation.recordFailure({ sourceAccountId: account.sourceAccountId, errorCode: code });
    return 'pending_retry' as const;
  }
}

export async function ensurePriorityRestored(accountId: number) {
  try { await coordinator().restore(accountId); } catch (error) {
    const record = await repository.find(accountId).catch(() => null);
    if (!record) return;
    const code = errorCode(error);
    await productionInstrumentation.recordAction({
      accountId: record.accountId,
      sourceAccountId: record.sourceAccountId,
      actionType: 'PRIORITY_RESTORE',
      result: 'FAILURE',
      priorityBefore: record.restoreExpectedPriority,
      priorityAfter: record.restoreTargetPriority,
      factor: record.factor,
      conflictRecomputed: false,
      errorCode: code,
    });
    await productionInstrumentation.recordFailure({ sourceAccountId: record.sourceAccountId, errorCode: code });
  }
}

export async function retryPriorityAdjustments(accounts: ReadonlyMap<number, { id: number; sourceAccountId: string; priorityEligible?: boolean }>, factor: number) {
  try { return await coordinator().retry(accounts, factor); } catch (error) {
    const code = errorCode(error);
    const unsettled = await repository.listUnsettled().catch(() => []);
    for (const record of unsettled) {
      const restoring = ['RESTORING', 'FAILED_RESTORE'].includes(record.status);
      await productionInstrumentation.recordAction({
        accountId: record.accountId,
        sourceAccountId: record.sourceAccountId,
        actionType: restoring ? 'PRIORITY_RESTORE' : 'PRIORITY_ADJUST',
        result: 'FAILURE',
        priorityBefore: restoring ? record.restoreExpectedPriority : record.expectedPriority,
        priorityAfter: restoring ? record.restoreTargetPriority : record.adjustedPriority,
        factor: record.factor,
        conflictRecomputed: false,
        errorCode: code,
      });
      await productionInstrumentation.recordFailure({ sourceAccountId: record.sourceAccountId, errorCode: code });
    }
    return [];
  }
}
