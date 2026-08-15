import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('../src/app/(dashboard)/settings/page.tsx', import.meta.url), 'utf8');
const backupCard = page.slice(page.indexOf('function RemoteBackupCard'), page.indexOf('function Field'));
const alertBehaviorCard = page.slice(page.indexOf('function AlertBehaviorCard'), page.indexOf('function RuleNumberInput'));

test('settings page exposes remote backup configuration without rendering password', () => {
  assert.match(page, /TabsTrigger value="backup"/);
  assert.match(page, /数据备份/);
  assert.match(page, /\.sql\.gz/);
  assert.match(page, /psql/);
  assert.match(page, /TabsContent value="backup"/);
  assert.match(page, /function BackupTab/);
  assert.match(page, /function RemoteBackupCard/);
  for (const key of ['remote_backup_host', 'remote_backup_port', 'remote_backup_username', 'remote_backup_path', 'remote_backup_time', 'remote_backup_retention']) {
    assert.match(page, new RegExp(key));
  }
  assert.match(page, /remote_backup_password_configured/);
  assert.match(page, /type="password"/);
  assert.match(page, /留空表示不修改/);
  assert.ok(page.includes('/api/remote-backup'));
  assert.match(backupCard, /apiFetch\('\/api\/remote-backup', \{\s*method: 'PUT'/);
  assert.doesNotMatch(backupCard, /apiFetch\('\/api\/settings'/);
  assert.ok(page.includes('/api/remote-backup/${kind}'));
  assert.ok(page.includes("runAction('test')"));
  assert.ok(page.includes("runAction('run')"));
});

test('remote backup form includes daily schedule and retention controls', () => {
  assert.match(page, /每日备份时间（UTC）/);
  assert.match(page, /保留备份数量/);
  assert.match(page, /超过数量后清理最早的备份/);
  assert.match(page, /启用每日备份/);
  assert.match(page, /Sub2API PostgreSQL/);
});

test('remote backup records display file sizes in MB with an empty-value fallback', () => {
  assert.match(backupCard, /<th className="px-3 py-2">大小<\/th>/);
  assert.match(backupCard, /fileSize \/ \(1024 \* 1024\)/);
  assert.match(backupCard, /toFixed\(2\)\} MB/);
  assert.match(backupCard, /record\.fileSize == null \? '-' :/);
});

test('alert behavior save uses the settings endpoint instead of the backup endpoint', () => {
  assert.match(alertBehaviorCard, /apiFetch\('\/api\/settings', \{/);
  assert.doesNotMatch(alertBehaviorCard, /apiFetch\('\/api\/remote-backup'/);
});
