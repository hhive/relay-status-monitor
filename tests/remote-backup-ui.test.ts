import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const backupPage = fs.readFileSync(new URL('../src/app/(dashboard)/backup/page.tsx', import.meta.url), 'utf8');
const backupView = fs.readFileSync(new URL('../src/components/backup/remote-backup-view.tsx', import.meta.url), 'utf8');
const navLayout = fs.readFileSync(new URL('../src/app/(dashboard)/layout.tsx', import.meta.url), 'utf8');
const settingsPage = fs.readFileSync(new URL('../src/app/(dashboard)/settings/page.tsx', import.meta.url), 'utf8');
const alertBehaviorCard = settingsPage.slice(settingsPage.indexOf('function AlertBehaviorCard'), settingsPage.indexOf('function RuleNumberInput'));

test('data backup is reachable from the main navigation', () => {
  assert.match(navLayout, /\{ href: '\/backup', label: '数据备份', icon: DatabaseBackup \}/);
  assert.match(navLayout, /DatabaseBackup,/);
  assert.match(backupPage, /<PageHeader/);
  assert.match(backupPage, /title="数据备份"/);
  assert.match(backupPage, /<RemoteBackupView \/>/);
});

test('backup page exposes remote backup configuration without rendering password', () => {
  assert.match(backupView, /数据备份|远程数据库备份/);
  assert.match(backupView, /\.sql\.gz/);
  assert.match(backupView, /psql/);
  assert.match(backupView, /\/api\/remote-backup/);
  for (const key of ['remote_backup_host', 'remote_backup_port', 'remote_backup_username', 'remote_backup_path', 'remote_backup_time', 'remote_backup_retention']) {
    assert.match(backupView, new RegExp(key));
  }
  assert.match(backupView, /remote_backup_password_configured/);
  assert.match(backupView, /type="password"/);
  assert.match(backupView, /留空表示不修改/);
  assert.match(backupView, /apiFetch\('\/api\/remote-backup', \{\s*method: 'PUT'/);
  assert.doesNotMatch(backupView, /apiFetch\('\/api\/settings'/);
  assert.match(backupView, /apiFetch\(`\/api\/remote-backup\/\$\{kind\}`/);
  assert.match(backupView, /runAction\('test'\)/);
  assert.match(backupView, /runAction\('run'\)/);
});

test('remote backup form includes daily schedule and retention controls', () => {
  assert.match(backupView, /每日备份时间（UTC）/);
  assert.match(backupView, /保留备份数量/);
  assert.match(backupView, /超过数量后清理最早的备份/);
  assert.match(backupView, /启用每日备份/);
  assert.match(backupView, /Sub2API PostgreSQL/);
});

test('remote backup records display file sizes in MB with an empty-value fallback', () => {
  assert.match(backupView, /<th className="px-3 py-2">大小<\/th>/);
  assert.match(backupView, /fileSize \/ \(1024 \* 1024\)/);
  assert.match(backupView, /toFixed\(2\)\} MB/);
  assert.match(backupView, /record\.fileSize == null \? '-' :/);
});

test('backup is no longer duplicated inside the settings page', () => {
  assert.doesNotMatch(settingsPage, /TabsTrigger value="backup"/);
  assert.doesNotMatch(settingsPage, /RemoteBackupCard|BackupTab/);
  assert.doesNotMatch(settingsPage, /\/api\/remote-backup/);
});

test('alert behavior save uses the settings endpoint instead of the backup endpoint', () => {
  assert.match(alertBehaviorCard, /apiFetch\('\/api\/settings', \{/);
  assert.doesNotMatch(alertBehaviorCard, /apiFetch\('\/api\/remote-backup'/);
});
