import { prisma } from '../src/lib/db';
import {
  reconcileBoundaryLayers,
  shouldPersistBoundaryReconciliation,
  type BoundaryCandidate,
} from '../src/lib/account-observability/priority-boundary-reconciliation';

const apply = process.argv.includes('--apply');
async function main(): Promise<void> {
  if (!apply) console.log('dry-run: pass --apply to persist the displayed reconciliation');
  const adjustments = await prisma.accountPriorityAdjustment.findMany({
  include: { account: { select: { id: true, name: true, priority: true } } },
  });
  const plans: Array<{
  adjustment: (typeof adjustments)[number];
  candidates: BoundaryCandidate[];
  result: ReturnType<typeof reconcileBoundaryLayers>;
  }> = [];
  for (const adjustment of adjustments) {
  const candidates = await prisma.accountAlertCandidate.findMany({
    where: { accountId: adjustment.accountId },
    select: { ruleId: true, adjustmentLevel: true, active: true, updatedAt: true },
  });
  const result = reconcileBoundaryLayers(adjustment.appliedFactors, candidates);
  const originalLayers = candidates.reduce((sum, candidate) => sum + Math.max(0, candidate.adjustmentLevel), 0);
  if (!shouldPersistBoundaryReconciliation(adjustment.status, adjustment.appliedFactors.length, result)) continue;
  const retainedLayers = [...result.allocations.values()].reduce((sum, value) => sum + value, 0);
  if (retainedLayers !== result.factors.length) {
    throw new Error(`account ${adjustment.accountId} cannot align candidate layers with real factors`);
  }
  plans.push({ adjustment, candidates, result });
  console.log(JSON.stringify({
    accountId: adjustment.accountId,
    accountName: adjustment.account.name,
    priority: adjustment.account.priority,
    originalFactors: adjustment.appliedFactors.length,
    realFactors: result.factors.length,
    originalCandidateLayers: originalLayers,
    retainedCandidateLayers: retainedLayers,
    removedLayers: result.removedLayers,
  }));
  }
  if (apply && plans.length > 0) {
  await prisma.$transaction(async (tx) => {
    for (const { adjustment, candidates, result } of plans) {
    await tx.accountPriorityAdjustment.update({
      where: { accountId: adjustment.accountId },
      data: {
        appliedFactors: result.factors,
        status: result.factors.length > 0 ? 'ACTIVE' : 'RESTORED',
        expectedPriority: null,
        basePriority: null,
        adjustedPriority: null,
        restoreExpectedPriority: null,
        restoreTargetPriority: null,
        lastError: null,
      },
    });
    for (const candidate of candidates) {
      if (!candidate.active || candidate.adjustmentLevel < 1) continue;
      const level = result.allocations.get(candidate.ruleId) ?? 0;
      if (level === 0) {
        await tx.accountAlertCandidate.delete({ where: { accountId_ruleId: { accountId: adjustment.accountId, ruleId: candidate.ruleId } } });
      } else {
        await tx.accountAlertCandidate.update({
          where: { accountId_ruleId: { accountId: adjustment.accountId, ruleId: candidate.ruleId } },
          data: { adjustmentLevel: level, active: level > 0 },
        });
      }
    }
    const retained = await tx.accountAlertCandidate.aggregate({
      where: { accountId: adjustment.accountId, active: true },
      _sum: { adjustmentLevel: true },
    });
    if ((retained._sum.adjustmentLevel ?? 0) !== result.factors.length) {
      throw new Error(`account ${adjustment.accountId} failed post-reconciliation invariant`);
    }
    }
  }, { timeout: 30_000 });
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', changed: plans.length }));
  await prisma.$disconnect();
}

void main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : 'priority boundary reconciliation failed');
  await prisma.$disconnect();
  process.exitCode = 1;
});
