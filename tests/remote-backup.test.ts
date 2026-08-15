import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { backupFileName, parseSftpModifiedAt, postgresCommandEnvironment, selectBackupDeletions, SUB2API_EXCLUDED_TABLE_DATA, validateBackupConfig, runRemoteBackup } from '../src/lib/remote-backup';

test('backup config validates safe path, time, port and retention', () => {
  const config = validateBackupConfig({ host: '10.0.0.2', username: 'backup', password: 'secret', path: '/srv/monitor', time: '03:15', port: 2222, retention: 3, enabled: true });
  assert.equal(config.port, 2222);
  for (const patch of [{ path: 'relative' }, { path: '/srv/../etc' }, { path: '/srv/backup dir' }, { time: '3:15' }, { retention: 0 }, { port: 70000 }]) {
    assert.throws(() => validateBackupConfig({ ...config, ...patch }));
  }
  for (const patch of [{ host: '-oProxyCommand=bad' }, { host: 'bad host' }, { username: '-oProxyCommand=bad' }, { username: 'user@host' }]) {
    assert.throws(() => validateBackupConfig({ ...config, ...patch }));
  }
});

test('backup names are fixed prefix and dump suffix', () => {
  assert.match(backupFileName(new Date('2026-08-15T01:02:03.000Z')), /^relay-monitor-sub2api-20260815010203-[-a-f0-9]{8}\.tar\.gz$/);
});

test('retention deletion only removes oldest matching monitor files', () => {
  const files = [
    { name: 'relay-monitor-sub2api-a.tar.gz', modifiedAt: new Date('2026-01-01') },
    { name: 'relay-monitor-sub2api-b.tar.gz', modifiedAt: new Date('2026-01-02') },
    { name: 'relay-monitor-sub2api-c.tar.gz', modifiedAt: new Date('2026-01-03') },
    { name: 'other.dump', modifiedAt: new Date('2025-01-01') },
  ];
  assert.deepEqual(selectBackupDeletions(files, 2), ['relay-monitor-sub2api-a.tar.gz']);
});

test('Sub2API dump scope follows the reference policy and keeps credentials out of argv', () => {
  assert.deepEqual(SUB2API_EXCLUDED_TABLE_DATA, ['ops_error_logs', 'ops_system_logs', 'image_playground_tasks', 'ops_alert_events', 'usage_logs']);
  const env = postgresCommandEnvironment('postgresql://backup:p%40ss@127.0.0.1:5432/sub2api?sslmode=disable');
  assert.equal(env.PGDATABASE, 'sub2api'); assert.equal(env.PGPASSWORD, 'p@ss'); assert.equal(env.PGSSLMODE, 'disable');
  assert.equal(env.SUB2API_BACKUP_DATABASE_URL, undefined);
});

test('SFTP timestamps sort cross-year files correctly', () => {
  const now = new Date('2026-01-02T12:00:00Z');
  assert.equal(parseSftpModifiedAt('Dec', '31', '23:59', now).toISOString(), '2025-12-31T23:59:00.000Z');
  assert.equal(parseSftpModifiedAt('Jan', '1', '2024', now).toISOString(), '2024-01-01T00:00:00.000Z');
});

test('backup removes local temporary state after successful upload and cleanup', async () => {
  const calls: string[] = [];
  const result = await runRemoteBackup(
    validateBackupConfig({ host: 'host', username: 'user', password: 'secret', path: '/srv', retention: 1 }),
    { upload: async (local, remote) => { calls.push(`upload:${local}:${remote}`); }, list: async () => [{ name: 'relay-monitor-sub2api-old.tar.gz', modifiedAt: new Date(0) }, { name: 'relay-monitor-sub2api-new.tar.gz', modifiedAt: new Date() }], remove: async (remote) => { calls.push(`remove:${remote}`); } },
    async (path) => { const { writeFile } = await import('node:fs/promises'); await writeFile(path, 'dump'); }, async () => {}, false,
  );
  assert.equal(result.deleted.length, 1);
  assert.equal(calls.filter((call) => call.startsWith('upload:')).length, 1);
  assert.deepEqual(calls.filter((call) => call.startsWith('remove:')).length, 1);
});

test('disabled cron skips before loading an unconfigured backup target', () => {
  const route = readFileSync(new URL('../src/app/api/cron/backup/route.ts', import.meta.url), 'utf8');
  const enabledCheck = route.indexOf('SettingKeys.BACKUP_ENABLED');
  const configLoad = route.indexOf('loadBackupConfig()');
  assert.ok(enabledCheck >= 0, 'cron route must check the enabled setting');
  assert.ok(enabledCheck < configLoad, 'disabled backup must skip before loading credentials');
});
