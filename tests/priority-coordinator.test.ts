import assert from 'node:assert/strict';
import test from 'node:test';

import { createPriorityCoordinator, type PriorityAdjustmentRecord, type PriorityAdjustmentRepository, type PriorityChangeLogEntry } from '../src/lib/account-observability/priority-coordinator';
import { createSub2ApiPriorityClient, Sub2ApiPriorityError, type Sub2ApiPriorityClient } from '../src/lib/account-observability/sub2api-priority-client';

test('priority client sends the dedicated secret and returns conflict priority without response details', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createSub2ApiPriorityClient({
    baseUrl: 'http://127.0.0.1:8080/', secret: '0123456789abcdef0123456789abcdef',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ priority: 55 }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
  await assert.rejects(client.setPriority('7', 50, 5), (error: unknown) =>
    error instanceof Sub2ApiPriorityError && error.code === 'priority_conflict' && error.currentPriority === 55);
  assert.equal(requests[0].url, 'http://127.0.0.1:8080/api/v1/internal/relay-monitor/accounts/7/priority');
  assert.equal((requests[0].init?.headers as Record<string, string>)['X-Sub2API-Relay-Monitor-Secret'], '0123456789abcdef0123456789abcdef');
});

test('priority coordinator multiplies every confirmed layer and divides every recovered layer', async () => {
  let stored: PriorityAdjustmentRecord | null = null;
  let activeSignals = 1;
  let remotePriority = 5;
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => activeSignals,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const client: Sub2ApiPriorityClient = {
    getPriority: async () => remotePriority,
    setPriority: async (_id, expected, target) => {
      if (remotePriority !== expected && remotePriority !== target) throw new Sub2ApiPriorityError('priority_conflict', remotePriority);
      remotePriority = target;
      return target;
    },
  };
  const coordinator = createPriorityCoordinator(repository, client);
  await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10);
  assert.equal(remotePriority, 50);
  activeSignals = 2;
  await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10);
  assert.equal(remotePriority, 500, 'every confirmed batch adds one priority layer');

  remotePriority = 550;
  activeSignals = 1;
  await coordinator.restore(7);
  assert.equal(remotePriority, 55, 'manual changes are the current restore baseline');
  activeSignals = 0;
  await coordinator.restore(7);
  assert.equal(remotePriority, 5, 'each recovered layer divides once');
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'RESTORED');
});

test('priority coordinator stores each layer factor and restores in reverse order', async () => {
  let stored: PriorityAdjustmentRecord | null = {
    accountId: 7, sourceAccountId: '9', expectedPriority: 5, basePriority: 5, adjustedPriority: 50,
    restoreExpectedPriority: null, restoreTargetPriority: null, appliedFactors: [10, 20],
    factor: 20, status: 'ACTIVE', lastError: null,
  };
  let activeSignals = 1;
  let remotePriority = 1000;
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => activeSignals,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => remotePriority,
    setPriority: async (_id, expected, target) => {
      assert.equal(remotePriority, expected);
      remotePriority = target;
      return target;
    },
  });
  await coordinator.restore(7);
  assert.equal(remotePriority, 50);
  assert.deepEqual(stored.appliedFactors, [10]);
  activeSignals = 0;
  await coordinator.restore(7);
  assert.equal(remotePriority, 5);
  assert.equal(stored.status, 'RESTORED');
});

test('priority coordinator retries a failed new layer with its persisted factor', async () => {
  let stored: PriorityAdjustmentRecord | null = null;
  let activeSignals = 1;
  let remotePriority = 5;
  let failRead = false;
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => activeSignals,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => {
      if (failRead) throw new Error('unavailable');
      return remotePriority;
    },
    setPriority: async (_id, _expected, target) => { remotePriority = target; return target; },
  });
  await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10);
  activeSignals = 2;
  failRead = true;
  await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 20);
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'FAILED_ADJUST');
  assert.equal((stored as PriorityAdjustmentRecord | null)?.factor, 20);

  failRead = false;
  await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 99);
  assert.equal(remotePriority, 1000, 'retry uses the factor persisted for the failed layer');
  assert.deepEqual((stored as PriorityAdjustmentRecord | null)?.appliedFactors, [10, 20]);
});

test('priority coordinator restores applied layers when the account has no enabled alert group', async () => {
  let stored: PriorityAdjustmentRecord | null = {
    accountId: 7, sourceAccountId: '9', expectedPriority: null, basePriority: null, adjustedPriority: null,
    restoreExpectedPriority: null, restoreTargetPriority: null, appliedFactors: [10],
    factor: 10, status: 'ACTIVE', lastError: null,
  };
  let remotePriority = 50;
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => 1,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => remotePriority,
    setPriority: async (_id, _expected, target) => { remotePriority = target; return target; },
  });
  await coordinator.retry(new Map([[7, { id: 7, sourceAccountId: '9', priorityEligible: false }]]), 10);
  assert.equal(remotePriority, 5);
  assert.deepEqual((stored as PriorityAdjustmentRecord | null)?.appliedFactors, []);
});

test('priority coordinator logs only successful writes with recalculated CAS values', async () => {
  let stored: PriorityAdjustmentRecord | null = null;
  let activeSignals = 1;
  let remotePriority = 5;
  let failWrite = false;
  let conflictAfterRead = false;
  const logs: PriorityChangeLogEntry[] = [];
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => activeSignals,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => {
      const current = remotePriority;
      if (conflictAfterRead) {
        remotePriority = 55;
        conflictAfterRead = false;
      }
      return current;
    },
    setPriority: async (_id, expected, target) => {
      if (failWrite) throw new Sub2ApiPriorityError('priority_http_503');
      if (remotePriority !== expected) throw new Sub2ApiPriorityError('priority_conflict', remotePriority);
      remotePriority = target;
      return target;
    },
  }, (entry) => { logs.push(entry); });

  await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10);
  assert.deepEqual(logs[0], {
    event: 'relay_monitor_priority_changed', accountId: 7, sourceAccountId: '9',
    direction: 'adjust', previousPriority: 5, targetPriority: 50, factor: 10,
    conflictRecalculated: false,
  });

  remotePriority = 50;
  conflictAfterRead = true;
  activeSignals = 0;
  await coordinator.restore(7);
  assert.deepEqual(logs[1], {
    event: 'relay_monitor_priority_changed', accountId: 7, sourceAccountId: '9',
    direction: 'restore', previousPriority: 55, targetPriority: 5, factor: 10,
    conflictRecalculated: true,
  });

  activeSignals = 1;
  failWrite = true;
  await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10);
  assert.equal(logs.length, 2, 'a failed write must not be logged as a priority change');
});
