import assert from 'node:assert/strict';
import test from 'node:test';

import { createPriorityCoordinator, type PriorityAdjustmentRecord, type PriorityAdjustmentRepository, type PriorityChangeLogEntry } from '../src/lib/account-observability/priority-coordinator';
import { createSub2ApiPriorityClient, Sub2ApiPriorityError, type Sub2ApiPriorityClient } from '../src/lib/account-observability/sub2api-priority-client';

test('priority client sends the SSO secret and returns conflict priority without response details', async () => {
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
  assert.equal((requests[0].init?.headers as Record<string, string>)['X-Sub2API-External-App-Secret'], '0123456789abcdef0123456789abcdef');
  await assert.rejects(client.setPriority('7', 50, 1_000_001), (error: unknown) =>
    error instanceof Sub2ApiPriorityError && error.code === 'invalid_priority_response');
  assert.equal(requests.length, 1, 'an over-limit target must fail before the request');
});

test('priority client reuses the administrator SSO URL and secret from the environment', async (t) => {
  const environment = {
    SUB2API_ADMIN_EXCHANGE_BASE_URL: process.env.SUB2API_ADMIN_EXCHANGE_BASE_URL,
    SUB2API_ADMIN_EXCHANGE_SECRET: process.env.SUB2API_ADMIN_EXCHANGE_SECRET,
    SUB2API_PRIORITY_API_BASE_URL: process.env.SUB2API_PRIORITY_API_BASE_URL,
    SUB2API_RELAY_MONITOR_PRIORITY_SECRET: process.env.SUB2API_RELAY_MONITOR_PRIORITY_SECRET,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.SUB2API_ADMIN_EXCHANGE_BASE_URL = 'https://sso.sub2api.example.test/';
  process.env.SUB2API_ADMIN_EXCHANGE_SECRET = 'sso-secret-0123456789abcdef0123456789';
  process.env.SUB2API_PRIORITY_API_BASE_URL = 'https://deprecated.example.test';
  process.env.SUB2API_RELAY_MONITOR_PRIORITY_SECRET = 'deprecated-secret-0123456789abcdef';

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createSub2ApiPriorityClient({
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ priority: 5 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  assert.equal(await client.getPriority('7'), 5);
  assert.equal(requests[0].url, 'https://sso.sub2api.example.test/api/v1/internal/relay-monitor/accounts/7/priority');
  assert.equal((requests[0].init?.headers as Record<string, string>)['X-Sub2API-External-App-Secret'], process.env.SUB2API_ADMIN_EXCHANGE_SECRET);
  assert.equal((requests[0].init?.headers as Record<string, string>)['X-Sub2API-Relay-Monitor-Secret'], undefined);
});

test('priority client rejects an over-limit upstream response', async () => {
  const client = createSub2ApiPriorityClient({
    baseUrl: 'http://127.0.0.1:8080', secret: '0123456789abcdef0123456789abcdef',
    fetchImpl: (async () => new Response(JSON.stringify({ priority: 1_000_001 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });
  await assert.rejects(client.getPriority('7'), (error: unknown) =>
    error instanceof Sub2ApiPriorityError && error.code === 'invalid_priority_response');
});

test('priority client sends the configured pause duration and validates until', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createSub2ApiPriorityClient({
    baseUrl: 'http://127.0.0.1:8080', secret: '0123456789abcdef0123456789abcdef',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ temp_unschedulable_until: '2026-08-09T00:01:00.000Z' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  assert.equal((await client.pauseScheduling('7', 12)).toISOString(), '2026-08-09T00:01:00.000Z');
  assert.equal(requests[0].url, 'http://127.0.0.1:8080/api/v1/internal/relay-monitor/accounts/7/priority-cap-pause');
  assert.equal(requests[0].init?.method, 'POST');
  assert.equal(requests[0].init?.body, JSON.stringify({ duration_seconds: 720 }));
  await assert.rejects(client.pauseScheduling('7', 0), /pause_duration/i);
  await assert.rejects(client.pauseScheduling('7', 61), /pause_duration/i);
  assert.equal(requests.length, 1);
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

test('priority coordinator rejects an over-limit layer without accumulating a no-op', async () => {
  let stored: PriorityAdjustmentRecord | null = null;
  const activeSignals = 1;
  let writeCount = 0;
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => activeSignals,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const cappedAccounts: string[] = [];
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => 900_000,
    setPriority: async () => { writeCount += 1; return 900_000; },
  }, undefined, async (account) => { cappedAccounts.push(account.sourceAccountId); });

  const result = await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10);
  assert.equal(writeCount, 0);
  assert.deepEqual((stored as PriorityAdjustmentRecord | null)?.appliedFactors, []);
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'RESTORED');
  assert.equal(result, 'capped');
  assert.deepEqual(cappedAccounts, ['9']);
});

test('priority cap pause failure does not turn capped settlement into a retry debt', async () => {
  let stored: PriorityAdjustmentRecord | null = null;
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => 1,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => 1_000_000,
    setPriority: async () => { throw new Error('must not write'); },
  }, undefined, async () => { throw new Error('pause unavailable'); });

  assert.equal(await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10), 'capped');
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'RESTORED');
  assert.equal((stored as PriorityAdjustmentRecord | null)?.lastError, null);
});

test('priority coordinator disables a zero-factor layer without accumulating a no-op', async () => {
  let stored: PriorityAdjustmentRecord | null = null;
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => 1,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => { throw new Error('zero factor must not read priority'); },
    setPriority: async () => { throw new Error('zero factor must not write priority'); },
  });

  const result = await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 0);

  assert.equal(result, 'disabled');
  assert.deepEqual((stored as PriorityAdjustmentRecord | null)?.appliedFactors, []);
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'RESTORED');
});

test('priority coordinator settles a lower-bound restore without a remote no-op write or log', async () => {
  let stored: PriorityAdjustmentRecord | null = {
    accountId: 7, sourceAccountId: '9', expectedPriority: null, basePriority: null, adjustedPriority: null,
    restoreExpectedPriority: null, restoreTargetPriority: null, appliedFactors: [10],
    factor: 10, status: 'ACTIVE', lastError: null,
  };
  let writeCount = 0;
  const logs: PriorityChangeLogEntry[] = [];
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => 0,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => 1,
    setPriority: async () => { writeCount += 1; return 1; },
  }, (entry) => { logs.push(entry); });

  await coordinator.restore(7);

  assert.equal(writeCount, 0);
  assert.deepEqual(logs, []);
  assert.deepEqual((stored as PriorityAdjustmentRecord | null)?.appliedFactors, []);
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'RESTORED');
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

test('priority retry reports a pending layer that becomes capped on the next cycle', async () => {
  let stored: PriorityAdjustmentRecord | null = {
    accountId: 7, sourceAccountId: '9', expectedPriority: null, basePriority: null, adjustedPriority: null,
    restoreExpectedPriority: null, restoreTargetPriority: null, appliedFactors: [],
    factor: 10, status: 'FAILED_ADJUST', lastError: 'priority_request_failed',
  };
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => 1,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const cappedAccounts: string[] = [];
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => 1_000_000,
    setPriority: async () => { throw new Error('capped retry must not write'); },
  }, undefined, async (account) => { cappedAccounts.push(account.sourceAccountId); });

  const discarded = await coordinator.retry(new Map([[7, { id: 7, sourceAccountId: '9' }]]), 10);

  assert.deepEqual(discarded, [7]);
  assert.deepEqual((stored as PriorityAdjustmentRecord | null)?.appliedFactors, []);
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'RESTORED');
  assert.deepEqual(cappedAccounts, ['9']);
});

test('priority coordinator pauses after a CAS conflict recalculates to the cap', async () => {
  let stored: PriorityAdjustmentRecord | null = null;
  const cappedAccounts: string[] = [];
  const repository: PriorityAdjustmentRepository = {
    find: async () => stored,
    save: async (record) => { stored = { ...record }; },
    countActiveSignals: async () => 1,
    listUnsettled: async () => stored ? [stored] : [],
  };
  const coordinator = createPriorityCoordinator(repository, {
    getPriority: async () => 50,
    setPriority: async () => { throw new Sub2ApiPriorityError('priority_conflict', 1_000_000); },
  }, undefined, async (account) => { cappedAccounts.push(account.sourceAccountId); });

  assert.equal(await coordinator.adjust({ id: 7, sourceAccountId: '9' }, 10), 'capped');
  assert.deepEqual(cappedAccounts, ['9']);
  assert.equal((stored as PriorityAdjustmentRecord | null)?.status, 'RESTORED');
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
