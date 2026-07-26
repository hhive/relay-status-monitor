import assert from 'node:assert/strict';
import test from 'node:test';

type ToggleModule = typeof import('../src/lib/account-alert-toggle');
type HandlerModule = typeof import('../src/lib/account-alert-toggle-handler');

async function loadToggleModule(): Promise<ToggleModule | null> {
  return import('../src/lib/account-alert-toggle').catch(() => null);
}

async function loadHandlerModule(): Promise<HandlerModule | null> {
  return import('../src/lib/account-alert-toggle-handler').catch(() => null);
}

test('alert toggle adopts the server value and exposes pending state while saving', async () => {
  const module = await loadToggleModule();
  assert.ok(module, 'account alert toggle coordinator is missing');

  const pending = new Set<number>();
  const applied: boolean[] = [];
  const pendingChanges: boolean[] = [];
  const result = await module.runAccountAlertToggle({
    accountId: 7,
    previous: true,
    requested: false,
    pending,
    apply: (enabled) => applied.push(enabled),
    setPending: (_accountId, value) => pendingChanges.push(value),
    save: async () => true,
  });

  assert.equal(result, 'saved');
  assert.deepEqual(applied, [false, true]);
  assert.deepEqual(pendingChanges, [true, false]);
  assert.equal(pending.size, 0);
});

test('alert toggle restores the exact pre-request value when saving fails', async () => {
  const module = await loadToggleModule();
  assert.ok(module, 'account alert toggle coordinator is missing');

  const applied: boolean[] = [];
  const result = await module.runAccountAlertToggle({
    accountId: 7,
    previous: false,
    requested: true,
    pending: new Set<number>(),
    apply: (enabled) => applied.push(enabled),
    setPending: () => undefined,
    save: async () => { throw new Error('save failed'); },
  });

  assert.equal(result, 'failed');
  assert.deepEqual(applied, [true, false]);
});

test('alert toggle prevents re-entry only for the account already pending', async () => {
  const module = await loadToggleModule();
  assert.ok(module, 'account alert toggle coordinator is missing');

  const pending = new Set<number>();
  let releaseFirst: ((value: boolean) => void) | undefined;
  let saves = 0;
  const first = module.runAccountAlertToggle({
    accountId: 7,
    previous: true,
    requested: false,
    pending,
    apply: () => undefined,
    setPending: () => undefined,
    save: () => {
      saves += 1;
      return new Promise<boolean>((resolve) => { releaseFirst = resolve; });
    },
  });

  assert.deepEqual([...pending], [7]);
  const duplicate = await module.runAccountAlertToggle({
    accountId: 7,
    previous: false,
    requested: true,
    pending,
    apply: () => assert.fail('duplicate request must not update state'),
    setPending: () => assert.fail('duplicate request must not change pending state'),
    save: async () => { saves += 1; return true; },
  });
  assert.equal(duplicate, 'ignored');

  const other = await module.runAccountAlertToggle({
    accountId: 8,
    previous: true,
    requested: false,
    pending,
    apply: () => undefined,
    setPending: () => undefined,
    save: async () => { saves += 1; return false; },
  });
  assert.equal(other, 'saved');
  assert.deepEqual([...pending], [7]);
  assert.equal(saves, 2);

  assert.ok(releaseFirst);
  releaseFirst(false);
  await first;
});

test('GET alert-enabled returns stored state and 400/404 semantics', async () => {
  const module = await loadHandlerModule();
  assert.ok(module, 'account alert toggle handler is missing');

  const found = await module.getAccountAlertEnabled('7', {
    find: async (id) => id === 7 ? { alertEnabled: false } : null,
    update: async () => assert.fail('GET must not update'),
  });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { enabled: false });

  const invalid = await module.getAccountAlertEnabled('0', {
    find: async () => assert.fail('invalid id must not query'),
    update: async () => assert.fail('GET must not update'),
  });
  assert.equal(invalid.status, 400);

  const missing = await module.getAccountAlertEnabled('8', {
    find: async () => null,
    update: async () => assert.fail('GET must not update'),
  });
  assert.equal(missing.status, 404);
});

test('PUT alert-enabled validates input, persists the requested value, and returns server state', async () => {
  const module = await loadHandlerModule();
  assert.ok(module, 'account alert toggle handler is missing');

  const writes: Array<{ id: number; enabled: boolean }> = [];
  const repository = {
    find: async (id: number) => id === 7 ? { alertEnabled: true } : null,
    update: async (id: number, enabled: boolean) => {
      writes.push({ id, enabled });
      return { alertEnabled: !enabled };
    },
  };
  const success = await module.putAccountAlertEnabled(
    new Request('http://localhost/api/accounts/7/alert-enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) }),
    '7',
    repository,
  );
  assert.equal(success.status, 200);
  assert.deepEqual(writes, [{ id: 7, enabled: false }]);
  assert.deepEqual(await success.json(), { enabled: true });

  const invalid = await module.putAccountAlertEnabled(
    new Request('http://localhost/api/accounts/7/alert-enabled', { method: 'PUT', body: JSON.stringify({ enabled: 'false' }) }),
    '7',
    repository,
  );
  assert.equal(invalid.status, 400);
  assert.equal(writes.length, 1);

  const malformed = await module.putAccountAlertEnabled(
    new Request('http://localhost/api/accounts/7/alert-enabled', { method: 'PUT', body: '{' }),
    '7',
    repository,
  );
  assert.equal(malformed.status, 400);
  assert.equal(writes.length, 1);

  const missing = await module.putAccountAlertEnabled(
    new Request('http://localhost/api/accounts/8/alert-enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) }),
    '8',
    repository,
  );
  assert.equal(missing.status, 404);
  assert.equal(writes.length, 1);
});
