import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileBoundaryLayers,
  shouldPersistBoundaryReconciliation,
} from '../src/lib/account-observability/priority-boundary-reconciliation';

test('boundary reconciliation removes no-op factors and keeps at most one layer per active rule first', () => {
  const result = reconcileBoundaryLayers(
    [10, 10, 0, 0],
    [
      { ruleId: 1, adjustmentLevel: 4, active: true, updatedAt: new Date('2026-08-02T00:00:00Z') },
      { ruleId: 2, adjustmentLevel: 2, active: true, updatedAt: new Date('2026-08-02T00:01:00Z') },
      { ruleId: 3, adjustmentLevel: 1, active: false, updatedAt: new Date('2026-08-02T00:02:00Z') },
    ],
  );

  assert.deepEqual(result.factors, [10, 10]);
  assert.deepEqual([...result.allocations.entries()], [[2, 1], [1, 1]]);
  assert.equal(result.removedLayers, 5);
});

test('boundary reconciliation never invents layers when no real factor remains', () => {
  const result = reconcileBoundaryLayers(
    [0, 0],
    [{ ruleId: 1, adjustmentLevel: 3, active: true, updatedAt: new Date('2026-08-02T00:00:00Z') }],
  );

  assert.deepEqual(result.factors, []);
  assert.deepEqual([...result.allocations.entries()], []);
  assert.equal(result.removedLayers, 3);
});

test('empty failed records are persisted so their status becomes restored', () => {
  const unchangedEmpty = reconcileBoundaryLayers([], []);

  assert.equal(shouldPersistBoundaryReconciliation('FAILED_ADJUST', 0, unchangedEmpty), true);
  assert.equal(shouldPersistBoundaryReconciliation('FAILED_RESTORE', 0, unchangedEmpty), true);
  assert.equal(shouldPersistBoundaryReconciliation('RESTORED', 0, unchangedEmpty), false);
});
