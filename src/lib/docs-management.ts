import type { ApiSession } from '@/lib/auth';
import { mkdir, rename, writeFile, readdir, readFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getSetting, setSetting, FeishuSettingKeys } from '@/lib/settings';

export type DocsSyncStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export interface DocsSyncState { status: DocsSyncStatus; lastRunAt: string | null; message: string; }

let state: DocsSyncState = { status: 'idle', lastRunAt: null, message: '尚未执行同步' };
const execFileAsync = promisify(execFile);

export function isDocsAdminSession(session: ApiSession | null): boolean {
  return session?.source === 'sub2api';
}
export function getDocsSyncState(): DocsSyncState { return { ...state }; }
export function requestDocsSync(): DocsSyncState {
  if (state.status === 'running') return getDocsSyncState();
  state = { status: 'running', lastRunAt: new Date().toISOString(), message: '同步任务已排队，等待飞书适配器执行' };
  return getDocsSyncState();
}
function documentRefFromUrl(value: string): { kind: 'document' | 'wiki'; id: string } | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const match = url.pathname.match(/\/(docx|docs|wiki)\/([A-Za-z0-9_-]+)/);
    return match ? { kind: match[1] === 'wiki' ? 'wiki' : 'document', id: match[2] } : null;
  } catch { return null; }
}

export interface FeishuSyncOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runBuild?: () => Promise<void>;
  cwd?: string;
}

export async function syncFeishuDocs(options: FeishuSyncOptions = {}): Promise<DocsSyncState> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const stored = options.env ? null : await getFeishuConfig();
  const url = (stored?.url ?? env.FEISHU_DOC_URL)?.trim();
  const appId = (stored?.appId ?? env.FEISHU_APP_ID)?.trim();
  const appSecret = (stored?.secretConfigured ? await getSetting(FeishuSettingKeys.APP_SECRET) : env.FEISHU_APP_SECRET)?.trim();
  const documentRef = url ? documentRefFromUrl(url) : null;
  const now = new Date().toISOString();
  state = { status: 'running', lastRunAt: now, message: '正在从飞书同步文档' };
  try {
    if (!url || !appId || !appSecret) throw new Error('未配置 FEISHU_DOC_URL、FEISHU_APP_ID 或 FEISHU_APP_SECRET');
    if (!documentRef) throw new Error('FEISHU_DOC_URL 不是受支持的飞书文档链接');
    const base = (stored?.apiBase ?? env.FEISHU_API_BASE ?? 'https://open.feishu.cn').replace(/\/$/, '');
    const tokenResponse = await fetchImpl(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    if (!tokenResponse.ok) throw new Error(`飞书鉴权失败（HTTP ${tokenResponse.status}）`);
    const tokenPayload = await tokenResponse.json() as { tenant_access_token?: string; code?: number; msg?: string };
    if (!tokenPayload.tenant_access_token) throw new Error(`飞书鉴权失败：${tokenPayload.msg ?? '未返回 token'}`);
    let documentId = documentRef.id;
    if (documentRef.kind === 'wiki') {
      const nodeResponse = await fetchImpl(`${base}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(documentRef.id)}`, {
        headers: { Authorization: `Bearer ${tokenPayload.tenant_access_token}` },
      });
      if (!nodeResponse.ok) throw new Error(`飞书知识库节点读取失败（HTTP ${nodeResponse.status}）`);
      const nodePayload = await nodeResponse.json() as { data?: { node?: { obj_token?: string; obj_type?: string }; obj_token?: string; obj_type?: string }; msg?: string };
      const node = nodePayload.data?.node ?? nodePayload.data;
      if (!node?.obj_token || (node.obj_type && node.obj_type !== 'docx')) throw new Error(`飞书知识库节点不是可读取的 Docx 文档：${nodePayload.msg ?? '类型不匹配'}`);
      documentId = node.obj_token;
    }
    const contentResponse = await fetchImpl(`${base}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, {
      headers: { Authorization: `Bearer ${tokenPayload.tenant_access_token}` },
    });
    if (!contentResponse.ok) throw new Error(`飞书文档读取失败（HTTP ${contentResponse.status}）`);
    const payload = await contentResponse.json() as { data?: { content?: string }; content?: string; msg?: string };
    const content = payload.data?.content ?? payload.content;
    if (typeof content !== 'string') throw new Error(`飞书文档读取失败：${payload.msg ?? '响应缺少正文'}`);
    const cwd = options.cwd ?? process.cwd();
    const output = path.resolve(cwd, stored?.output || env.FEISHU_DOC_OUTPUT || path.join(env.DOCS_DATA_DIR ?? 'docs-site', 'feishu.md'));
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    await writeFile(temporary, `---\ntitle: 飞书同步文档\n---\n\n${content.trim()}\n`, 'utf8');
    await rename(temporary, output);
    if (options.runBuild) await options.runBuild();
    else await execFileAsync('pnpm', ['run', 'docs:build'], { cwd });
    state = { status: 'succeeded', lastRunAt: now, message: `同步成功：${documentId}` };
  } catch (error) {
    state = { status: 'failed', lastRunAt: now, message: error instanceof Error ? error.message : '同步失败' };
  }
  return getDocsSyncState();
}
export function resetDocsSyncState(): void { state = { status: 'idle', lastRunAt: null, message: '尚未执行同步' }; }

export async function getFeishuConfig() {
  const [url, appId, apiBase, output, secret] = await Promise.all([
    getSetting(FeishuSettingKeys.DOC_URL, process.env.FEISHU_DOC_URL ?? ''), getSetting(FeishuSettingKeys.APP_ID, process.env.FEISHU_APP_ID ?? ''),
    getSetting(FeishuSettingKeys.API_BASE, process.env.FEISHU_API_BASE ?? 'https://open.feishu.cn'), getSetting(FeishuSettingKeys.DOC_OUTPUT, process.env.FEISHU_DOC_OUTPUT ?? ''), getSetting(FeishuSettingKeys.APP_SECRET, process.env.FEISHU_APP_SECRET ?? ''),
  ]);
  return { url, appId, apiBase, output, secretConfigured: Boolean(secret) };
}

export async function saveFeishuConfig(input: { url: string; appId: string; appSecret?: string; apiBase?: string; output?: string }) {
  const url = input.url.trim(); const appId = input.appId.trim();
  if (!url || !appId) throw new Error('飞书文档链接和 App ID 不能为空');
  if (!/^https:\/\//.test(url) || /[\r\n]/.test(url) || /[\r\n]/.test(appId)) throw new Error('飞书配置格式无效');
  await setSetting(FeishuSettingKeys.DOC_URL, url); await setSetting(FeishuSettingKeys.APP_ID, appId);
  if (input.appSecret?.trim()) await setSetting(FeishuSettingKeys.APP_SECRET, input.appSecret.trim());
  if (input.apiBase?.trim()) await setSetting(FeishuSettingKeys.API_BASE, input.apiBase.trim());
  if (input.output?.trim()) await setSetting(FeishuSettingKeys.DOC_OUTPUT, input.output.trim());
  return getFeishuConfig();
}

export type ManagedDocumentSource = 'feishu' | 'local';
export interface ManagedDocument {
  id: string;
  title: string;
  source: ManagedDocumentSource;
  content: string;
  updatedAt: string;
}

function docsRoot(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(cwd, env.DOCS_DATA_DIR ?? 'docs-site');
}
function safeId(value: string): string {
  const id = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!id || id.split('/').some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('文档标识只能包含字母、数字、下划线和短横线');
  return id;
}
function parseDocument(id: string, source: ManagedDocumentSource, raw: string, updatedAt: string): ManagedDocument {
  const match = raw.match(/^---\n(?:title:\s*(.*)\n)?---\n\n?([\s\S]*)$/);
  return { id, source, title: match?.[1]?.trim() || id.split('/').at(-1) || id, content: match?.[2] ?? raw, updatedAt };
}
function fileFor(root: string, source: ManagedDocumentSource, id: string): string {
  return path.join(root, source === 'local' ? 'local' : '', `${safeId(id)}.md`);
}
async function readDocument(file: string, id: string, source: ManagedDocumentSource): Promise<ManagedDocument> {
  const [raw, metadata] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  return parseDocument(id, source, raw, metadata.mtime.toISOString());
}
export async function listManagedDocuments(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ManagedDocument[]> {
  const root = docsRoot(options.cwd, options.env);
  const result: ManagedDocument[] = [];
  const sources: Array<[ManagedDocumentSource, string]> = [['feishu', root], ['local', path.join(root, 'local')]];
  for (const [source, directory] of sources) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      try { result.push(await readDocument(path.join(directory, entry.name), id, source)); } catch { /* ignore unreadable files */ }
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
export async function createLocalDocument(input: { id: string; title: string; content: string }, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ManagedDocument> {
  const id = safeId(input.id);
  const file = fileFor(docsRoot(options.cwd, options.env), 'local', id);
  await mkdir(path.dirname(file), { recursive: true });
  try { await readFile(file); throw new Error('本地文档已存在'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(file, `---\ntitle: ${input.title.trim() || id}\n---\n\n${input.content ?? ''}\n`, 'utf8');
  return readDocument(file, id, 'local');
}
export async function updateLocalDocument(id: string, input: { title: string; content: string }, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ManagedDocument> {
  const file = fileFor(docsRoot(options.cwd, options.env), 'local', id);
  await readFile(file);
  await writeFile(file, `---\ntitle: ${input.title.trim() || id}\n---\n\n${input.content ?? ''}\n`, 'utf8');
  return readDocument(file, safeId(id), 'local');
}
export async function deleteLocalDocument(id: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  await unlink(fileFor(docsRoot(options.cwd, options.env), 'local', id));
}
