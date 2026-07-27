import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  GroupAlertSettingValidationError,
  buildGroupAlertSettingSummaries,
  parseGroupAlertSettingUpdate,
  shouldSuppressAccountAlerts,
  uniqueGroupId,
} from '../src/lib/account-observability/group-alert-settings';

const root = new URL('../', import.meta.url);
const source = (path: string) => {
  const file = new URL(path, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

type HandlerModule = typeof import('../src/lib/group-alert-settings-handler');

async function loadHandlerModule(): Promise<HandlerModule | null> {
  return import('../src/lib/group-alert-settings-handler').catch(() => null);
}

test('unique group parsing accepts one safe positive group and deduplicates repeats', () => {
  assert.equal(uniqueGroupId([{ id: 7, name: 'Alpha' }]), 7);
  assert.equal(uniqueGroupId([{ id: 7 }, { id: 7, name: 'Alpha' }]), 7);
  assert.equal(uniqueGroupId([{ id: 7 }, { id: 8 }]), null);
  assert.equal(uniqueGroupId([]), null);
});

test('invalid projection entries never create an exclusive group assignment', () => {
  for (const projection of [
    null,
    {},
    [{ id: 0 }],
    [{ id: -1 }],
    [{ id: 1.5 }],
    [{ id: '7' }],
    [{ id: Number.MAX_SAFE_INTEGER + 1 }],
    [{ id: 7 }, { id: 'broken' }],
  ]) {
    assert.equal(uniqueGroupId(projection), null);
  }
});

test('only an account exclusively assigned to a disabled group is suppressed', () => {
  const disabled = new Set([7]);
  assert.equal(shouldSuppressAccountAlerts([{ id: 7 }], disabled), true);
  assert.equal(shouldSuppressAccountAlerts([{ id: 7 }, { id: 7 }], disabled), true);
  assert.equal(shouldSuppressAccountAlerts([{ id: 7 }, { id: 8 }], disabled), false);
  assert.equal(shouldSuppressAccountAlerts([{ id: 8 }], disabled), false);
  assert.equal(shouldSuppressAccountAlerts([], disabled), false);
  assert.equal(shouldSuppressAccountAlerts([{ id: 7 }], new Set()), false);
});

test('group summaries expose stable names, defaults, exclusive counts and bound counts', () => {
  const summaries = buildGroupAlertSettingSummaries([
    { groupProjection: [{ id: 8, name: 'Beta' }] },
    { groupProjection: [{ id: 7, name: 'Alpha' }, { id: 8, name: 'Beta' }] },
    { groupProjection: [{ id: 7, name: 'Alpha' }, { id: 7, name: 'Alpha' }] },
    { groupProjection: [{ id: 7, name: 'Alpha' }], alertEnabled: false },
    { groupProjection: [{ id: 'broken', name: 'Ignored' }] },
  ], [{ groupId: 7, alertEnabled: false }]);

  assert.deepEqual(summaries, [
    { groupId: 7, name: 'Alpha', alertEnabled: false, exclusiveAccountCount: 1, boundAccountCount: 3 },
    { groupId: 8, name: 'Beta', alertEnabled: true, exclusiveAccountCount: 1, boundAccountCount: 2 },
  ]);
});

test('group setting updates accept only an exact boolean payload', () => {
  assert.deepEqual(parseGroupAlertSettingUpdate({ enabled: false }), { enabled: false });
  for (const body of [null, {}, { enabled: 'false' }, { enabled: true, groupId: 7 }, []]) {
    assert.throws(() => parseGroupAlertSettingUpdate(body), GroupAlertSettingValidationError);
  }
});

test('group alert setting schema and routes are additive, authenticated and bound-group scoped', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source('prisma/migrations/20260727040000_add_group_alert_settings/migration.sql');
  const listRoute = source('src/app/api/group-alert-settings/route.ts');
  const itemRoute = source('src/app/api/group-alert-settings/[groupId]/route.ts');

  assert.match(schema, /model GroupAlertSetting/);
  assert.match(schema, /groupId\s+Int\s+@id/);
  assert.match(schema, /alertEnabled\s+Boolean\s+@default\(true\)/);
  assert.match(migration, /CREATE TABLE "GroupAlertSetting"/);
  assert.match(listRoute, /requireApiSession/);
  assert.match(listRoute, /syncState:\s*'ACTIVE'/);
  assert.match(listRoute, /getGroupAlertSettings/);
  assert.match(itemRoute, /requireApiSession/);
  assert.match(itemRoute, /putGroupAlertSetting/);
  assert.match(itemRoute, /syncState:\s*'ACTIVE'/);
  assert.match(itemRoute, /upsert/);
});

test('settings page provides an independent group alert tab with safe immediate saves', () => {
  const settings = source('src/app/(dashboard)/settings/page.tsx');

  assert.match(settings, /TabsTrigger value="group-alerts"/);
  assert.match(settings, /分组告警/);
  assert.match(settings, /TabsContent value="group-alerts"/);
  assert.match(settings, /function GroupAlertsTab/);
  assert.match(settings, /\/api\/group-alert-settings/);
  assert.match(settings, /exclusiveAccountCount/);
  assert.match(settings, /boundAccountCount/);
  assert.match(settings, /pendingGroupIds/);
  assert.match(settings, /pendingGroupIds\.has\(group\.groupId\)/);
  assert.match(settings, /alertEnabled:\s*group\.alertEnabled/);
  assert.match(settings, /暂无已绑定分组/);
  assert.match(settings, /分组告警加载失败/);
});

test('group alert handlers return summaries and persist a bound group update', async () => {
  const module = await loadHandlerModule();
  assert.ok(module, 'group alert settings handler is missing');
  const writes: Array<{ groupId: number; enabled: boolean }> = [];
  const repository = {
    loadAccounts: async () => [
      { groupProjection: [{ id: 7, name: 'Alpha' }], alertEnabled: true },
      { groupProjection: [{ id: 7, name: 'Alpha' }], alertEnabled: false },
    ],
    loadSettings: async () => [{ groupId: 7, alertEnabled: true }],
    upsert: async (groupId: number, enabled: boolean) => {
      writes.push({ groupId, enabled });
      return { groupId, alertEnabled: enabled };
    },
  };

  const listed = await module.getGroupAlertSettings(repository);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { groups: [
    { groupId: 7, name: 'Alpha', alertEnabled: true, exclusiveAccountCount: 1, boundAccountCount: 2 },
  ] });

  const updated = await module.putGroupAlertSetting(
    new Request('http://localhost/api/group-alert-settings/7', { method: 'PUT', body: JSON.stringify({ enabled: false }) }),
    '7',
    repository,
  );
  assert.equal(updated.status, 200);
  assert.deepEqual(writes, [{ groupId: 7, enabled: false }]);
  assert.deepEqual(await updated.json(), {
    groupId: 7, name: 'Alpha', alertEnabled: false, exclusiveAccountCount: 1, boundAccountCount: 2,
  });
});

test('group alert update handler enforces 400, 404 and 503 responses', async () => {
  const module = await loadHandlerModule();
  assert.ok(module, 'group alert settings handler is missing');
  let writes = 0;
  const repository = {
    loadAccounts: async () => [{ groupProjection: [{ id: 7, name: 'Alpha' }], alertEnabled: true }],
    loadSettings: async () => [],
    upsert: async (groupId: number, enabled: boolean) => {
      writes += 1;
      return { groupId, alertEnabled: enabled };
    },
  };

  for (const [groupId, body] of [['0', { enabled: true }], ['7', { enabled: 'true' }], ['7', { enabled: true, extra: 1 }]] as const) {
    const response = await module.putGroupAlertSetting(
      new Request(`http://localhost/api/group-alert-settings/${groupId}`, { method: 'PUT', body: JSON.stringify(body) }),
      groupId,
      repository,
    );
    assert.equal(response.status, 400);
  }
  const missing = await module.putGroupAlertSetting(
    new Request('http://localhost/api/group-alert-settings/8', { method: 'PUT', body: JSON.stringify({ enabled: false }) }),
    '8',
    repository,
  );
  assert.equal(missing.status, 404);
  assert.equal(writes, 0);

  const unavailable = await module.getGroupAlertSettings({
    ...repository,
    loadAccounts: async () => { throw new Error('database unavailable'); },
  });
  assert.equal(unavailable.status, 503);
  const saveFailure = await module.putGroupAlertSetting(
    new Request('http://localhost/api/group-alert-settings/7', { method: 'PUT', body: JSON.stringify({ enabled: false }) }),
    '7',
    { ...repository, upsert: async () => { throw new Error('database unavailable'); } },
  );
  assert.equal(saveFailure.status, 503);
});
