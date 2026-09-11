import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { BACKUP_FILE_PATTERN, backupFileName, dumpDatabase, parseSftpListing, parseSftpModifiedAt, postgresCommandEnvironment, selectBackupDeletions, SUB2API_EXCLUDED_TABLE_DATA, SUB2API_RECENT_THREE_DAY_TABLES, validateBackupConfig, runRemoteBackup } from '../src/lib/remote-backup';

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

test('backup names are fixed prefix and sql gzip suffix', () => {
  assert.match(backupFileName(new Date('2026-08-15T01:02:03.000Z')), BACKUP_FILE_PATTERN);
});

test('retention deletion only removes oldest matching monitor files', () => {
  const files = [
    { name: 'relay-monitor-sub2api-20260101000000-aaaaaaaa.sql.gz', modifiedAt: new Date('2026-01-01') },
    { name: 'relay-monitor-sub2api-20260102000000-bbbbbbbb.sql.gz', modifiedAt: new Date('2026-01-02') },
    { name: 'relay-monitor-sub2api-20260103000000-cccccccc.sql.gz', modifiedAt: new Date('2026-01-03') },
    { name: 'relay-monitor-sub2api-manual.sql.gz', modifiedAt: new Date('2025-01-01') },
    { name: 'relay-monitor-sub2api-legacy.tar.gz', modifiedAt: new Date('2025-01-01') },
    { name: 'other.dump', modifiedAt: new Date('2025-01-01') },
  ];
  assert.deepEqual(selectBackupDeletions(files, 2), ['relay-monitor-sub2api-20260101000000-aaaaaaaa.sql.gz']);
});

// 现场实测的 sftp 客户端输出：带路径参数时 name 列是完整路径且 nlink 为 "?"（OpenSSH 9.6 客户端），
// 先 cd 再相对列目录时是 basename。
const REAL_SFTP_LISTING = [
  'sftp> ls -l /app/ai/backups/',
  '-rw-r--r--    ? root     root      4836541 Aug 15 08:39 /app/ai/backups/relay-monitor-sub2api-20260815083925-beb190c9.tar.gz',
  '-rw-------    ? root     root      9112020 Aug 15 13:23 /app/ai/backups/relay-monitor-sub2api-20260815132337-ed080486.sql.gz',
  '-rw-------    ? root     root     22571235 Aug 16 09:56 /app/ai/backups/relay-monitor-sub2api-20260816095633-c93e1a88.sql.gz',
  '-rw-------    ? root     root     24568927 Aug 17 12:43 /app/ai/backups/relay-monitor-sub2api-20260817124323-a8a7dcef.sql.gz',
  '-rw-------    ? root     root     31943507 Sep  1 14:00 /app/ai/backups/relay-monitor-sub2api-20260901140000-61d97795.sql.gz',
  '-rw-------    ? root     root    243453164 Aug 15 18:27 /app/ai/backups/sub2api-full-usage-20260815T182633Z.dump',
  '-rw-------    1 root     root     84822107 Sep  2 14:00 relay-monitor-sub2api-20260902140000-cccccccc.sql.gz',
  'sftp> ls -l /app/ai/backups',
].join('\n');

test('sftp listing parses absolute-path and basename forms and keeps only strict backup names', () => {
  const parsed = parseSftpListing(REAL_SFTP_LISTING);
  assert.deepEqual(parsed.map((file) => file.name), [
    'relay-monitor-sub2api-20260815132337-ed080486.sql.gz',
    'relay-monitor-sub2api-20260816095633-c93e1a88.sql.gz',
    'relay-monitor-sub2api-20260817124323-a8a7dcef.sql.gz',
    'relay-monitor-sub2api-20260901140000-61d97795.sql.gz',
    'relay-monitor-sub2api-20260902140000-cccccccc.sql.gz',
  ]);
  assert.equal(parsed[0].modifiedAt.toISOString(), '2026-08-15T13:23:00.000Z');
  assert.equal(parsed[4].modifiedAt.toISOString(), '2026-09-02T14:00:00.000Z');
  assert.deepEqual(parseSftpListing('sftp> ls -l /app/ai/backups\n'), []);
});

test('retention applies to the real absolute-path listing that previously matched nothing', () => {
  assert.deepEqual(selectBackupDeletions(parseSftpListing(REAL_SFTP_LISTING), 4), [
    'relay-monitor-sub2api-20260815132337-ed080486.sql.gz',
  ]);
});

test('Sub2API dump scope follows the reference policy and keeps credentials out of argv', () => {
  assert.deepEqual(SUB2API_RECENT_THREE_DAY_TABLES, ['usage_logs', 'standalone_image_playground_tasks', 'media_playground_video_tasks']);
  assert.deepEqual(SUB2API_EXCLUDED_TABLE_DATA, ['ops_error_logs', 'ops_system_logs', 'image_playground_tasks', 'ops_alert_events', ...SUB2API_RECENT_THREE_DAY_TABLES]);
  const env = postgresCommandEnvironment('postgresql://backup:p%40ss@127.0.0.1:5432/sub2api?sslmode=disable');
  assert.equal(env.PGDATABASE, 'sub2api'); assert.equal(env.PGPASSWORD, 'p@ss'); assert.equal(env.PGSSLMODE, 'disable');
  assert.equal(env.SUB2API_BACKUP_DATABASE_URL, undefined);
});

test('Sub2API backup is one restorable plain SQL gzip with three-day usage and media tasks', () => {
  const source = readFileSync(new URL('../src/lib/remote-backup.ts', import.meta.url), 'utf8');
  assert.match(source, /--format=plain/);
  assert.match(source, /SUB2API_RECENT_THREE_DAY_TABLES/);
  assert.match(source, /COPY public\.\$\{table\} \(/);
  assert.match(source, /created_at >= now\(\) - interval '3 days'/);
  assert.match(source, /TO STDOUT/);
  assert.match(source, /pg_export_snapshot/);
  assert.match(source, /--snapshot=\$\{snapshot\.id\}/);
  assert.match(source, /--exclude-table-data-and-children=public\.\$\{table\}/);
  assert.match(source, /attgenerated = ''/);
  assert.doesNotMatch(source, /SELECT \* FROM public\.usage_logs/);
  assert.match(source, /gzip/);
  for (const forbidden of ['usage_logs_last_3_days.csv', 'manifest.txt', "command('tar'", "command('pg_restore'", '--format=custom']) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('dump generator writes one snapshot-consistent restorable SQL gzip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-backup-test-'));
  const bin = join(dir, 'bin');
  const output = join(dir, 'backup.sql.gz');
  const previousPath = process.env.PATH;
  const previousUrl = process.env.SUB2API_BACKUP_DATABASE_URL;
  try {
    const { mkdir } = await import('node:fs/promises'); await mkdir(bin);
    await writeFile(join(bin, 'pg_dump'), `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
if (fileIndex < 0 || !args.some((arg) => arg === '--snapshot=00000003-00000001-1')) process.exit(2);
if (args.filter((arg) => arg.startsWith('--exclude-table-data-and-children=public.')).length !== 7) process.exit(3);
fs.writeFileSync(args[fileIndex + 1], '-- main dump\\nCREATE TABLE public.usage_logs (id bigint, request_id text, created_at timestamptz);\\nCREATE TABLE public.standalone_image_playground_tasks (id text, prompt text, created_at timestamptz);\\nCREATE TABLE public.media_playground_video_tasks (id text, prompt text, created_at timestamptz);\\n');
`);
    await writeFile(join(bin, 'psql'), `#!/usr/bin/env node
const args = process.argv.slice(2); const commandIndex = args.indexOf('--command');
if (commandIndex < 0) {
  process.stdout.write('00000003-00000001-1\\n'); process.stdin.setEncoding('utf8');
  process.stdin.on('data', (value) => { if (value.includes('\\\\q')) process.exit(0); });
} else {
  const command = args[commandIndex + 1];
  if (!command.includes("SET TRANSACTION SNAPSHOT '00000003-00000001-1'")) process.exit(4);
  if (command.includes('string_agg')) {
    if (command.includes("'public.usage_logs'::regclass")) process.stdout.write('id, request_id, created_at\\n');
    else if (command.includes("'public.standalone_image_playground_tasks'::regclass") || command.includes("'public.media_playground_video_tasks'::regclass")) process.stdout.write('id, prompt, created_at\\n');
    else process.exit(5);
  } else if (command.includes('COPY (SELECT')) {
    if (!command.includes("created_at >= now() - interval '3 days'")) process.exit(7);
    if (command.includes('FROM public.usage_logs')) process.stdout.write('1\\treq\\\\value\\t2026-08-15 00:00:00+00\\n2\\t\\\\N\\t2026-08-15 01:00:00+00\\n');
    else if (command.includes('FROM public.standalone_image_playground_tasks')) process.stdout.write('image-1\\timage prompt\\t2026-08-15 02:00:00+00\\n');
    else if (command.includes('FROM public.media_playground_video_tasks')) process.stdout.write('video-1\\tvideo prompt\\t2026-08-15 03:00:00+00\\n');
    else process.exit(6);
  }
  else process.exit(5);
}
`);
    await Promise.all([chmod(join(bin, 'pg_dump'), 0o700), chmod(join(bin, 'psql'), 0o700)]);
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    process.env.SUB2API_BACKUP_DATABASE_URL = 'postgresql://backup:secret@127.0.0.1:5432/sub2api';
    await dumpDatabase(output);
    const sql = gunzipSync(await readFile(output)).toString('utf8');
    assert.ok(sql.indexOf('-- main dump') < sql.indexOf('COPY public.usage_logs (id, request_id, created_at) FROM stdin;'));
    assert.match(sql, /1\treq\\value\t2026-08-15 00:00:00\+00/);
    assert.match(sql, /2\t\\N\t2026-08-15 01:00:00\+00/);
    assert.match(sql, /COPY public\.standalone_image_playground_tasks \(id, prompt, created_at\) FROM stdin;\nimage-1\timage prompt/);
    assert.match(sql, /COPY public\.media_playground_video_tasks \(id, prompt, created_at\) FROM stdin;\nvideo-1\tvideo prompt/);
    assert.equal((sql.match(/COPY public\./g) ?? []).length, 3);
    assert.match(sql, /\\\.\n$/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousUrl === undefined) delete process.env.SUB2API_BACKUP_DATABASE_URL; else process.env.SUB2API_BACKUP_DATABASE_URL = previousUrl;
    await rm(dir, { recursive: true, force: true });
  }
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
    { upload: async (local, remote) => { calls.push(`upload:${local}:${remote}`); }, list: async () => [{ name: 'relay-monitor-sub2api-20260101000000-aaaaaaaa.sql.gz', modifiedAt: new Date(0) }, { name: 'relay-monitor-sub2api-20260102000000-bbbbbbbb.sql.gz', modifiedAt: new Date() }], remove: async (remote) => { calls.push(`remove:${remote}`); } },
    async (path) => { const { writeFile } = await import('node:fs/promises'); await writeFile(path, 'dump'); }, async () => {}, false,
  );
  assert.equal(result.deleted.length, 1);
  assert.equal(calls.filter((call) => call.startsWith('upload:')).length, 1);
  assert.deepEqual(calls.filter((call) => call.startsWith('remove:')).length, 1);
});

test('real backup execution triggers a redacted failure and recovers after success', async () => {
  const alerts: Array<{ phase: 'failure' | 'recovery'; detail?: string }> = [];
  let failUpload = true;
  const config = validateBackupConfig({ host: 'host', username: 'user', password: 'secret', path: '/srv', retention: 1 });
  const transport = {
    upload: async () => { if (failUpload) throw new Error('password=hunter2 upload failed'); },
    list: async () => [],
    remove: async () => undefined,
  };
  const reporter = {
    failure: async (detail: string) => { alerts.push({ phase: 'failure', detail }); },
    recovery: async () => { alerts.push({ phase: 'recovery' }); },
  };
  const dump = async (path: string) => { const { writeFile } = await import('node:fs/promises'); await writeFile(path, 'dump'); };

  await assert.rejects(runRemoteBackup(config, transport, dump, async () => {}, false, reporter));
  failUpload = false;
  await runRemoteBackup(config, transport, dump, async () => {}, false, reporter);

  assert.deepEqual(alerts.map((alert) => alert.phase), ['failure', 'recovery']);
  assert.doesNotMatch(alerts[0].detail ?? '', /hunter2/);
  assert.match(alerts[0].detail ?? '', /\[REDACTED\]/);
});

test('disabled cron skips before loading an unconfigured backup target', () => {
  const route = readFileSync(new URL('../src/app/api/cron/backup/route.ts', import.meta.url), 'utf8');
  const enabledCheck = route.indexOf('SettingKeys.BACKUP_ENABLED');
  const configLoad = route.indexOf('loadBackupConfig()');
  assert.ok(enabledCheck >= 0, 'cron route must check the enabled setting');
  assert.ok(enabledCheck < configLoad, 'disabled backup must skip before loading credentials');
});
