import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { decrypt, encrypt } from './crypto';
import { getSetting, setSetting, SettingKeys } from './settings';
import { prisma } from './db';
import { recordOperationalFailure, recoverOperationalAlert } from './operational-alerts';
import { safeErrorMessage } from './safe-error';

export type RemoteBackupConfig = {
  enabled: boolean; host: string; port: number; username: string; password: string;
  path: string; time: string; retention: number;
};

export type BackupTransport = {
  upload(localPath: string, remotePath: string, config: RemoteBackupConfig): Promise<void>;
  list(remoteDir: string, config: RemoteBackupConfig): Promise<Array<{ name: string; modifiedAt: Date }>>;
  remove(remotePath: string, config: RemoteBackupConfig): Promise<void>;
};

export interface BackupOperationalAlertReporter {
  failure(detail: string): Promise<void> | void;
  recovery(): Promise<void> | void;
}

const productionBackupAlertReporter: BackupOperationalAlertReporter = {
  failure: (detail) => recordOperationalFailure('remote_backup_failed', 'system', 'Sub2API 远程备份', detail),
  recovery: () => recoverOperationalAlert('remote_backup_failed', 'system'),
};

async function observeBackupAlert(operation: (() => Promise<void> | void) | undefined): Promise<void> {
  if (!operation) return;
  try { await operation(); } catch { /* Alert persistence must not alter backup state. */ }
}

export const BACKUP_PREFIX = 'relay-monitor-';
export const BACKUP_FILE_PATTERN = /^relay-monitor-sub2api-\d{14}-[0-9a-f]{8}\.sql\.gz$/;
export function backupFileName(now = new Date()): string {
  return `${BACKUP_PREFIX}sub2api-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}.sql.gz`;
}

export function validateBackupConfig(input: Partial<RemoteBackupConfig>): RemoteBackupConfig {
  const host = String(input.host ?? '').trim();
  const username = String(input.username ?? '').trim();
  const path = String(input.path ?? '').trim();
  const time = String(input.time ?? '02:00').trim();
  const port = Number(input.port ?? 22);
  const retention = Number(input.retention ?? 7);
  if (!host || host.length > 253 || !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/.test(host)) throw new Error('备份服务器地址无效');
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username)) throw new Error('备份用户名无效');
  if (!path || !path.startsWith('/') || path.includes('..') || !/^\/[A-Za-z0-9_./-]*$/.test(path)) throw new Error('备份路径必须为绝对安全路径');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('备份时间无效');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('备份端口无效');
  if (!Number.isInteger(retention) || retention < 1 || retention > 10000) throw new Error('保留数量无效');
  return { enabled: Boolean(input.enabled), host, port, username, password: String(input.password ?? ''), path, time, retention };
}

/**
 * 解析 `sftp` 的 `ls -l` 输出。
 * 客户端形态不一致：带路径参数时输出完整路径（OpenSSH 9.6 客户端会给 name 列加远程目录前缀），
 * 先 cd 再相对列目录时输出 basename。两种形态都必须归一为 basename 后再匹配。
 */
export function parseSftpListing(output: string): Array<{ name: string; modifiedAt: Date }> {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 9)
    .map((parts) => ({ parts, name: parts.slice(8).join(' ').split('/').pop() ?? '' }))
    .filter(({ name }) => BACKUP_FILE_PATTERN.test(name))
    .map(({ parts, name }) => ({ name, modifiedAt: parseSftpModifiedAt(parts[5], parts[6], parts[7]) }));
}

export function selectBackupDeletions(files: Array<{ name: string; modifiedAt: Date }>, retention: number): string[] {
  const matching = files.filter((f) => BACKUP_FILE_PATTERN.test(f.name));
  return matching
    .sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime())
    .slice(0, Math.max(0, matching.length - retention))
    .map((f) => f.name);
}

export function parseSftpModifiedAt(month: string, day: string, timeOrYear: string, now = new Date()): Date {
  const year = /^\d{4}$/.test(timeOrYear) ? Number(timeOrYear) : now.getUTCFullYear();
  const time = /^\d{2}:\d{2}$/.test(timeOrYear) ? timeOrYear : '00:00';
  const parsed = new Date(`${month} ${day} ${year} ${time} UTC`);
  if (!Number.isFinite(parsed.getTime())) throw new Error('远程备份时间格式无效');
  if (!/^\d{4}$/.test(timeOrYear) && parsed.getTime() > now.getTime() + 24 * 60 * 60 * 1000) parsed.setUTCFullYear(year - 1);
  return parsed;
}

export async function loadBackupConfig(): Promise<RemoteBackupConfig> {
  return validateBackupConfig({
    enabled: (await getSetting(SettingKeys.BACKUP_ENABLED, 'false')) === 'true',
    host: await getSetting(SettingKeys.BACKUP_HOST), port: Number(await getSetting(SettingKeys.BACKUP_PORT, '22')),
    username: await getSetting(SettingKeys.BACKUP_USERNAME), password: decrypt(await getSetting(SettingKeys.BACKUP_PASSWORD)),
    path: await getSetting(SettingKeys.BACKUP_PATH, '/var/backups/relay-monitor'),
    time: await getSetting(SettingKeys.BACKUP_TIME, '02:00'), retention: Number(await getSetting(SettingKeys.BACKUP_RETENTION, '7')),
  });
}

export async function saveBackupConfig(input: Partial<RemoteBackupConfig>): Promise<RemoteBackupConfig> {
  const currentPassword = await getSetting(SettingKeys.BACKUP_PASSWORD, '');
  const config = validateBackupConfig({ ...input, password: input.password || (currentPassword ? decrypt(currentPassword) : '') });
  if (!config.password) throw new Error('备份密码不能为空');
  await Promise.all([
    setSetting(SettingKeys.BACKUP_ENABLED, String(config.enabled)), setSetting(SettingKeys.BACKUP_HOST, config.host),
    setSetting(SettingKeys.BACKUP_PORT, String(config.port)), setSetting(SettingKeys.BACKUP_USERNAME, config.username),
    setSetting(SettingKeys.BACKUP_PASSWORD, encrypt(config.password)), setSetting(SettingKeys.BACKUP_PATH, config.path),
    setSetting(SettingKeys.BACKUP_TIME, config.time), setSetting(SettingKeys.BACKUP_RETENTION, String(config.retention)),
  ]);
  return config;
}

function command(commandName: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => { const child = spawn(commandName, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (d) => out.push(Buffer.from(d))); child.stderr.on('data', (d) => err.push(Buffer.from(d)));
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`命令失败(${code}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`))); });
}

async function commandToFile(commandName: string, args: string[], path: string, append: boolean, env?: NodeJS.ProcessEnv): Promise<void> {
  const target = await open(path, append ? 'a' : 'w', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(commandName, args, { env, stdio: ['ignore', target.fd, 'pipe'] }); const err: Buffer[] = [];
      child.stderr!.on('data', (d) => err.push(Buffer.from(d))); child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`命令失败(${code}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`)));
    });
  } finally {
    await target.close();
  }
}

type ExportedSnapshot = { id: string; close(): Promise<void> };

function openExportedSnapshot(env: NodeJS.ProcessEnv): Promise<ExportedSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const err: Buffer[] = []; let output = ''; let ready = false;
    const timeout = setTimeout(() => { if (!ready) { child.kill(); reject(new Error('创建数据库一致性快照超时')); } }, 30_000);
    const exited = new Promise<{ code: number | null; error?: Error }>((done) => {
      child.on('error', (error) => done({ code: null, error })); child.on('close', (code) => done({ code }));
    });
    child.stderr.on('data', (data) => err.push(Buffer.from(data)));
    child.stdout.on('data', (data) => {
      output += Buffer.from(data).toString('utf8');
      const id = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/i.test(line));
      if (!id || ready) return;
      ready = true; clearTimeout(timeout);
      resolve({ id, async close() {
        if (child.exitCode === null && !child.killed) child.stdin.end('ROLLBACK;\n\\q\n');
        const result = await exited;
        if (result.error) throw result.error;
        if (result.code !== 0) throw new Error(`关闭数据库一致性快照失败(${result.code}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`);
      } });
    });
    void exited.then((result) => {
      if (ready) return;
      clearTimeout(timeout);
      reject(result.error ?? new Error(`创建数据库一致性快照失败(${result.code}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`));
    });
    child.stdin.write("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n");
  });
}

export const defaultTransport: BackupTransport = {
  async upload(localPath, remotePath, config) {
    await commandWithInput('sshpass', ['-e', 'sftp', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(config.port), `${config.username}@${config.host}`], `put ${localPath} ${remotePath}\n`, { ...process.env, SSHPASS: config.password });
  },
  async list(remoteDir, config) {
    const output = await commandWithOutput('sshpass', ['-e', 'sftp', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(config.port), `${config.username}@${config.host}`], `ls -l ${remoteDir}\n`, { ...process.env, SSHPASS: config.password });
    return parseSftpListing(output.toString('utf8'));
  },
  async remove(remotePath, config) { await commandWithInput('sshpass', ['-e', 'sftp', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(config.port), `${config.username}@${config.host}`], `rm ${remotePath}\n`, { ...process.env, SSHPASS: config.password }); },
};

function commandWithInput(commandName: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => { const child = spawn(commandName, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); const err: Buffer[] = [];
    child.stderr.on('data', (d) => err.push(Buffer.from(d))); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`命令失败(${code}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`))); child.stdin.end(input); });
}

function commandWithOutput(commandName: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => { const child = spawn(commandName, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (d) => out.push(Buffer.from(d))); child.stderr.on('data', (d) => err.push(Buffer.from(d))); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`命令失败(${code}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`))); child.stdin.end(input); });
}

let backupInProgress = false;

export async function runRemoteBackup(config: RemoteBackupConfig, transport: BackupTransport = defaultTransport, dump = dumpDatabase, recordStatus: (status: 'success' | 'failed', error?: string, fileName?: string) => Promise<void> = async (status, error = '', fileName) => {
  await setSetting(SettingKeys.BACKUP_LAST_STATUS, status); await setSetting(SettingKeys.BACKUP_LAST_AT, new Date().toISOString()); await setSetting(SettingKeys.BACKUP_LAST_ERROR, error); if (fileName) await setSetting(SettingKeys.BACKUP_LAST_FILE, fileName);
}, persistRecord = true, alertReporter?: BackupOperationalAlertReporter): Promise<{ fileName: string; deleted: string[] }> {
  if (backupInProgress) throw new Error('备份任务正在执行');
  const reporter = alertReporter ?? (persistRecord ? productionBackupAlertReporter : null);
  backupInProgress = true;
  let record: { id: number } | null = null;
  let dir = '';
  try {
    record = persistRecord ? await prisma.remoteBackupRecord.create({ data: { status: 'RUNNING' }, select: { id: true } }) : null;
    dir = await mkdtemp(join(tmpdir(), 'relay-monitor-backup-')); const fileName = backupFileName(); const localPath = join(dir, fileName);
    await dump(localPath); const size = (await stat(localPath)).size; if (!size) throw new Error('备份文件为空');
    const remotePath = `${config.path.replace(/\/$/, '')}/${fileName}`; await transport.upload(localPath, remotePath, config);
    const files = await transport.list(config.path, config); const deleted = selectBackupDeletions(files, config.retention); for (const name of deleted) await transport.remove(`${config.path.replace(/\/$/, '')}/${name}`, config);
    await recordStatus('success', '', fileName);
    if (record) await prisma.remoteBackupRecord.update({ where: { id: record.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), fileName, fileSize: size, deletedCount: deleted.length, deletedFiles: deleted } });
    await observeBackupAlert(reporter ? () => reporter.recovery() : undefined);
    return { fileName, deleted };
  } catch (error) { const message = safeErrorMessage(error, '备份失败'); await observeBackupAlert(reporter ? () => reporter.failure(message) : undefined); await recordStatus('failed', message); if (record) await prisma.remoteBackupRecord.update({ where: { id: record.id }, data: { status: 'FAILED', finishedAt: new Date(), errorMessage: message } }); throw error; }
  finally { if (dir) await rm(dir, { recursive: true, force: true }); backupInProgress = false; }
}

export const SUB2API_RECENT_THREE_DAY_TABLES = ['usage_logs', 'standalone_image_playground_tasks', 'media_playground_video_tasks'] as const;
export const SUB2API_EXCLUDED_TABLE_DATA = ['ops_error_logs', 'ops_system_logs', 'image_playground_tasks', 'ops_alert_events', ...SUB2API_RECENT_THREE_DAY_TABLES] as const;

export function postgresCommandEnvironment(rawUrl: string): NodeJS.ProcessEnv {
  const url = new URL(rawUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('Sub2API 备份数据库地址无效');
  const env = { ...process.env };
  delete env.DATABASE_URL; delete env.SUB2API_DATABASE_URL; delete env.SUB2API_BACKUP_DATABASE_URL;
  env.PGHOST = url.searchParams.get('host') || decodeURIComponent(url.hostname);
  env.PGPORT = url.port || '5432'; env.PGUSER = decodeURIComponent(url.username); env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = decodeURIComponent(url.pathname.replace(/^\//, ''));
  env.PGSSLMODE = url.searchParams.get('sslmode') || 'prefer';
  return env;
}

export async function dumpDatabase(path: string): Promise<void> {
  const url = process.env.SUB2API_BACKUP_DATABASE_URL ?? process.env.SUB2API_DATABASE_URL;
  if (!url) throw new Error('SUB2API_BACKUP_DATABASE_URL 未配置');
  const env = postgresCommandEnvironment(url);
  const workDir = await mkdtemp(join(tmpdir(), 'sub2api-pg-dump-'));
  const sqlPath = join(workDir, 'sub2api.sql');
  try {
    const snapshot = await openExportedSnapshot(env);
    try {
      await command('pg_dump', ['--format=plain', '--no-owner', '--no-acl', '--clean', '--if-exists', `--snapshot=${snapshot.id}`, '--file', sqlPath, ...SUB2API_EXCLUDED_TABLE_DATA.map((table) => `--exclude-table-data-and-children=public.${table}`)], env);
      await chmod(sqlPath, 0o600);
      const snapshotPrefix = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot.id}';`;
      for (const table of SUB2API_RECENT_THREE_DAY_TABLES) {
        const columns = (await command('psql', ['--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align', '--command', `${snapshotPrefix} SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.${table}'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''; COMMIT;`], env)).toString('utf8').trim();
        if (!columns || /[\r\n;]/.test(columns)) throw new Error(`${table} 列清单无效`);
        await appendFile(sqlPath, `\nCOPY public.${table} (${columns}) FROM stdin;\n`, { mode: 0o600 });
        await commandToFile('psql', ['--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--command', `${snapshotPrefix} COPY (SELECT ${columns} FROM public.${table} WHERE created_at >= now() - interval '3 days') TO STDOUT; COMMIT;`], sqlPath, true, env);
        await appendFile(sqlPath, '\\.\n', { mode: 0o600 });
      }
    } finally {
      await snapshot.close();
    }
    await commandToFile('gzip', ['-c', sqlPath], path, false);
    await chmod(path, 0o600);
    await command('gzip', ['-t', path]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function getBackupStatus() { return { status: await getSetting(SettingKeys.BACKUP_LAST_STATUS, 'never'), at: await getSetting(SettingKeys.BACKUP_LAST_AT), fileName: await getSetting(SettingKeys.BACKUP_LAST_FILE), error: await getSetting(SettingKeys.BACKUP_LAST_ERROR) }; }

export async function getBackupRecords(options: { limit?: number; offset?: number; status?: string } = {}) {
  const limit = Math.min(100, Math.max(1, options.limit ?? 30)); const offset = Math.max(0, options.offset ?? 0);
  const where = options.status && ['RUNNING', 'SUCCEEDED', 'FAILED'].includes(options.status) ? { status: options.status } : undefined;
  const [rows, total] = await Promise.all([prisma.remoteBackupRecord.findMany({ where, orderBy: { startedAt: 'desc' }, take: limit, skip: offset }), prisma.remoteBackupRecord.count({ where })]);
  return { items: rows.map((row) => ({ ...row, fileSize: row.fileSize === null ? null : Number(row.fileSize) })), total, limit, offset };
}

export async function isBackupDue(config: RemoteBackupConfig, now = new Date()): Promise<boolean> {
  if (!config.enabled) return false;
  const [hour, minute] = config.time.split(':').map(Number);
  if (now.getUTCHours() * 60 + now.getUTCMinutes() < hour * 60 + minute) return false;
  const lastAt = await getSetting(SettingKeys.BACKUP_LAST_AT, '');
  return !lastAt || new Date(lastAt).toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
}

export function redactBackupConfig(config: RemoteBackupConfig) {
  return { enabled: config.enabled, host: config.host, port: config.port, username: config.username, path: config.path, time: config.time, retention: config.retention, passwordConfigured: Boolean(config.password) };
}
