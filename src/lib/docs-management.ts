import type { ApiSession } from '@/lib/auth';
import { mkdir, rename, writeFile, readdir, readFile, unlink, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { getSetting, setSetting, FeishuSettingKeys } from '@/lib/settings';
import { blocksToMarkdown, type FeishuBlock } from '@/lib/docs-feishu';
import { deriveDocumentTitle, renderDocsPage } from '@/lib/docs-render';

export type DocsSyncStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export interface DocsSyncState { status: DocsSyncStatus; lastRunAt: string | null; message: string; }

let state: DocsSyncState = { status: 'idle', lastRunAt: null, message: '尚未执行同步' };

async function downloadFeishuAssets(markdown: string, base: string, accessToken: string, publicDocs: string, fetchImpl: typeof fetch): Promise<string> {
  const tokens = [...markdown.matchAll(/@@FEISHU_ASSET:([A-Za-z0-9_-]+)@@/g)].map((match) => match[1]);
  let result = markdown;
  for (const token of new Set(tokens)) {
    const response = await fetchImpl(`${base}/open-apis/drive/v1/medias/${encodeURIComponent(token)}/download`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) { result = result.replaceAll(`@@FEISHU_ASSET:${token}@@`, '#'); continue; }
    const type = response.headers.get('content-type') ?? '';
    const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg';
    const relative = `assets/feishu/${token}.${extension}`;
    const target = path.join(publicDocs, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    result = result.replaceAll(`@@FEISHU_ASSET:${token}@@`, `/docs/${relative}`);
  }
  return result;
}

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
    let content = payload.data?.content ?? payload.content;
    const blocksResponse = await fetchImpl(`${base}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?page_size=500`, { headers: { Authorization: `Bearer ${tokenPayload.tenant_access_token}` } });
    if (blocksResponse.ok) {
      const blocksPayload = await blocksResponse.json() as { data?: { items?: FeishuBlock[] } };
      const structured = blocksToMarkdown(blocksPayload.data?.items ?? []);
      if (structured.trim()) content = structured;
    }
    if (typeof content !== 'string') throw new Error(`飞书文档读取失败：${payload.msg ?? '响应缺少正文'}`);
    const cwd = options.cwd ?? process.cwd();
    const publicDocs = options.cwd ? path.resolve(cwd, 'public/docs') : '/var/lib/relay-status-monitor/docs';
    await mkdir(publicDocs, { recursive: true });
    content = await downloadFeishuAssets(content, base, tokenPayload.tenant_access_token, publicDocs, fetchImpl);
    const defaultOutput = options.cwd ? path.join(env.DOCS_DATA_DIR ?? 'docs-site', 'feishu.md') : '/var/lib/relay-status-monitor/feishu.md';
    const output = path.resolve(cwd, stored?.output || env.FEISHU_DOC_OUTPUT || defaultOutput);
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    const title = deriveDocumentTitle(content, '飞书同步文档');
    await writeFile(temporary, `---\ntitle: ${title}\n---\n\n${content.trim()}\n`, 'utf8');
    await rename(temporary, output);
    await writeFile(path.join(publicDocs, 'index.html'), await renderDocsPage({ markdown: content.trim(), title, assetsDir: path.join(publicDocs, 'assets') }), 'utf8');
    if (options.runBuild) await options.runBuild();
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

type ZipEntry = { name: string; method: number; compressedSize: number; size: number; offset: number };
function parseZip(buffer: Buffer): ZipEntry[] {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error('ZIP 文件格式无效');
  const count = buffer.readUInt16LE(eocd + 10); const centralSize = buffer.readUInt32LE(eocd + 12); const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) throw new Error('ZIP 中央目录无效');
  if (count > 1000) throw new Error('ZIP 条目数量过多');
  const entries: ZipEntry[] = []; let cursor = centralOffset; let totalSize = 0;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 条目无效');
    const method = buffer.readUInt16LE(cursor + 10); const compressedSize = buffer.readUInt32LE(cursor + 20); const size = buffer.readUInt32LE(cursor + 24); const nameLen = buffer.readUInt16LE(cursor + 28); const extraLen = buffer.readUInt16LE(cursor + 30); const commentLen = buffer.readUInt16LE(cursor + 32); const offset = buffer.readUInt32LE(cursor + 42); const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, size, offset }); cursor += 46 + nameLen + extraLen + commentLen;
    totalSize += size; if (totalSize > 100 * 1024 * 1024) throw new Error('ZIP 解压后文件总大小不能超过 100MB');
  }
  return entries;
}
function extractZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (entry.name.endsWith('/')) return Buffer.alloc(0);
  if (buffer.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error('ZIP 本地条目无效');
  const nameLen = buffer.readUInt16LE(entry.offset + 26); const extraLen = buffer.readUInt16LE(entry.offset + 28); const start = entry.offset + 30 + nameLen + extraLen; const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
}
export async function importZipDocument(buffer: Buffer, input: { id: string; title?: string }, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ManagedDocument> {
  const id = safeId(input.id); const entries = parseZip(buffer); for (const entry of entries) { const normalized = path.posix.normalize(entry.name); if (normalized.startsWith('../') || path.posix.isAbsolute(normalized) || entry.name.includes('\\')) throw new Error('ZIP 包含不安全路径'); } const markdown = entries.find((entry) => !entry.name.endsWith('/') && entry.name.toLowerCase().endsWith('.md'));
  if (!markdown) throw new Error('ZIP 中未找到 Markdown 文档');
  const root = docsRoot(options.cwd, options.env); const file = fileFor(root, 'local', id); const publicRoot = options.cwd ? path.resolve(options.cwd, 'public/docs') : '/var/lib/relay-status-monitor/docs'; const publishRoot = path.join(publicRoot, id);
  // Prevent accidental overwrite of an existing local document during import.
  try { await readFile(fileFor(root, 'local', id)); throw new Error('本地文档已存在'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(publishRoot, { recursive: true });
  const names = new Set(entries.map((entry) => entry.name));
  let content = extractZipEntry(buffer, markdown).toString('utf8');
  const rewrite = (value: string) => { if (/^(?:https?:|\/|#|data:)/i.test(value)) return value; const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(markdown.name), value)); if (normalized.startsWith('../') || !names.has(normalized)) return value; return `/docs/${encodeURIComponent(id)}/${normalized.split('/').map(encodeURIComponent).join('/')}`; };
  content = content.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (_, prefix, target, suffix) => `${prefix}${rewrite(target)}${suffix}`);
  for (const entry of entries) { if (entry.name.endsWith('/') || entry.name === markdown.name) continue; const normalized = path.posix.normalize(entry.name); const target = path.join(publishRoot, ...normalized.split('/')); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, extractZipEntry(buffer, entry)); }
  const title = (input.title ?? id).trim() || id;
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `---\ntitle: ${title}\n---\n\n${content.trim()}\n`, 'utf8');
  await writeFile(path.join(publishRoot, 'index.html'), await renderDocsPage({ markdown: content.trim(), title, assetsDir: path.join(publicRoot, 'assets') }), 'utf8');
  return readDocument(file, id, 'local');
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
