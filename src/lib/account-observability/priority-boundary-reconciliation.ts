export interface BoundaryCandidate {
  ruleId: number;
  adjustmentLevel: number;
  active: boolean;
  updatedAt: Date;
}

export interface BoundaryReconciliationResult {
  factors: number[];
  allocations: Map<number, number>;
  removedLayers: number;
}

export function boundaryFactorsForMode(factors: readonly number[], resetAll: boolean): readonly number[] {
  return resetAll ? [] : factors;
}

export function reconcileBoundaryLayers(
  factors: readonly number[],
  candidates: readonly BoundaryCandidate[],
): BoundaryReconciliationResult {
  const realFactors = factors.filter((factor) => factor > 0);
  let remaining = realFactors.length;
  const allocations = new Map<number, number>();
  const ordered = [...candidates]
    .filter((candidate) => candidate.active && candidate.adjustmentLevel > 0)
    .sort((left, right) => {
      if (left.updatedAt.getTime() !== right.updatedAt.getTime()) {
        return right.updatedAt.getTime() - left.updatedAt.getTime();
      }
      return left.ruleId - right.ruleId;
    });

  for (const candidate of ordered) {
    if (remaining === 0) break;
    allocations.set(candidate.ruleId, 1);
    remaining -= 1;
  }
  while (remaining > 0) {
    let allocated = false;
    for (const candidate of ordered) {
      const current = allocations.get(candidate.ruleId) ?? 0;
      if (current >= candidate.adjustmentLevel) continue;
      allocations.set(candidate.ruleId, current + 1);
      remaining -= 1;
      allocated = true;
      if (remaining === 0) break;
    }
    if (!allocated) break;
  }

  const retainedLayers = [...allocations.values()].reduce((sum, value) => sum + value, 0);
  const originalLayers = candidates.reduce((sum, candidate) => sum + Math.max(0, candidate.adjustmentLevel), 0);
  return { factors: realFactors, allocations, removedLayers: Math.max(0, originalLayers - retainedLayers) };
}

export function shouldPersistBoundaryReconciliation(
  status: string,
  originalFactorCount: number,
  result: BoundaryReconciliationResult,
): boolean {
  const boundaryChanged = result.factors.length !== originalFactorCount || result.removedLayers > 0;
  return boundaryChanged || (result.factors.length === 0 && status !== 'RESTORED');
}
