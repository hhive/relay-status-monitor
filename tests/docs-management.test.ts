import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { createLocalDocument, deleteLocalDocument, importZipDocument, isDocsAdminSession, listManagedDocuments, requestDocsSync, resetDocsSyncState, syncFeishuDocs, updateLocalDocument } from '../src/lib/docs-management';
import { isPublicDocsPath } from '../src/middleware';

test('public docs paths exclude the SSO-protected management route', () => {
  assert.equal(isPublicDocsPath('/docs'), true);
  assert.equal(isPublicDocsPath('/docs/guide'), true);
  assert.equal(isPublicDocsPath('/docs/manage'), false);
  assert.equal(isPublicDocsPath('/docs/manage/settings'), false);
});

test('docs management is restricted to Sub2API admin sessions', () => {
  assert.equal(isDocsAdminSession({ source: 'sub2api', userId: 1, username: 'admin', email: 'a@b.test', csrfToken: 'x' }), true);
  assert.equal(isDocsAdminSession({ source: 'local', userId: 1, username: 'local', sessionVersion: 1 }), false);
  assert.equal(isDocsAdminSession(null), false);
});

test('docs sync requests are idempotent while running', () => {
  resetDocsSyncState();
  const first = requestDocsSync();
  const second = requestDocsSync();
  assert.equal(first.status, 'running');
  assert.deepEqual(second, first);
  resetDocsSyncState();
});

test('syncFeishuDocs fetches raw content and publishes VitePress source', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-'));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('tenant_access_token')) return new Response(JSON.stringify({ tenant_access_token: 'test-token' }), { status: 200 });
    return new Response(JSON.stringify({ data: { content: '# Synced\n\nHello from Feishu.' } }), { status: 200 });
  }) as typeof fetch;
  const result = await syncFeishuDocs({
    cwd,
    env: { FEISHU_DOC_URL: 'https://example.feishu.cn/docx/AbC_123', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv,
    fetchImpl,
    runBuild: async () => {},
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(await readFile(path.join(cwd, 'docs-site/feishu.md'), 'utf8'), '---\ntitle: Synced\n---\n\n# Synced\n\nHello from Feishu.\n');
  const page = await readFile(path.join(cwd, 'public/docs/index.html'), 'utf8');
  assert.match(page, /<title>Synced<\/title>/);
  assert.match(page, /<h1 id="synced">Synced<\/h1>/);
  assert.match(page, /<article class="vp-doc">/);
  assert.match(String(calls[1]?.init?.headers && new Headers(calls[1].init?.headers).get('authorization')), /Bearer test-token/);
});

test('syncFeishuDocs resolves Feishu wiki links before reading the Docx body', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-wiki-'));
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.includes('tenant_access_token')) return new Response(JSON.stringify({ tenant_access_token: 'wiki-token' }), { status: 200 });
    if (url.includes('/wiki/v2/spaces/get_node')) return new Response(JSON.stringify({ data: { node: { obj_token: 'docx-resolved-token', obj_type: 'docx' } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { content: '# Wiki synced' } }), { status: 200 });
  }) as typeof fetch;
  const result = await syncFeishuDocs({
    cwd,
    env: { FEISHU_DOC_URL: 'https://xiaoni-ai.feishu.cn/wiki/FQY6wW7fhifg2YkRH7bcYyP3n4e', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv,
    fetchImpl,
    runBuild: async () => {},
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(calls.some((url) => url.includes('/wiki/v2/spaces/get_node?token=FQY6wW7fhifg2YkRH7bcYyP3n4e')));
  assert.ok(calls.some((url) => url.includes('/docx/v1/documents/docx-resolved-token/raw_content')));
});

test('syncFeishuDocs prefers structured Docx blocks for headings, links, and images', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-blocks-'));
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('tenant_access_token')) return new Response(JSON.stringify({ tenant_access_token: 'token' }));
    if (url.includes('/blocks')) return new Response(JSON.stringify({ data: { items: [
      { block_type: 3, heading1: { elements: [{ text_run: { content: '结构化标题' } }] } },
      { block_type: 2, text: { elements: [{ text_run: { content: 'https://example.com' } }] } },
      { block_type: 27, block_id: 'img-1', image: { token: 'image-token' } },
    ] } }));
    if (url.includes('/medias/image-token/download')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    return new Response(JSON.stringify({ data: { content: 'fallback' } }));
  }) as typeof fetch;
  const result = await syncFeishuDocs({ cwd, env: { FEISHU_DOC_URL: 'https://example.feishu.cn/docx/abc', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv, fetchImpl, runBuild: async () => {} });
  assert.equal(result.status, 'succeeded');
  const html = await readFile(path.join(cwd, 'public/docs/index.html'), 'utf8');
  assert.match(html, /<h2 id="[^"]*">结构化标题<\/h2>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer noopener">/);
  assert.match(html, /<img src="\/docs\/assets\/feishu\/image-token\.png"/);
  assert.match(html, /\.vp-doc p>img\{max-width:640px/);
  assert.match(html, /class="doc-lightbox"/);
  assert.deepEqual([...await readFile(path.join(cwd, 'public/docs/assets/feishu/image-token.png'))], [1, 2, 3]);
});

test('syncFeishuDocs preserves Docx rich-text document links', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-links-'));
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('tenant_access_token')) return new Response(JSON.stringify({ tenant_access_token: 'token' }));
    if (url.includes('/blocks')) return new Response(JSON.stringify({ data: { items: [
      { block_type: 2, text: { elements: [{ text_run: { content: '查看文档', text_element_style: { link: { url: 'https://example.feishu.cn/docx/linked-doc' } } } }] } },
    ] } }));
    return new Response(JSON.stringify({ data: { content: 'fallback' } }));
  }) as typeof fetch;
  const result = await syncFeishuDocs({ cwd, env: { FEISHU_DOC_URL: 'https://example.feishu.cn/docx/abc', FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv, fetchImpl, runBuild: async () => {} });
  assert.equal(result.status, 'succeeded');
  const html = await readFile(path.join(cwd, 'public/docs/index.html'), 'utf8');
  assert.match(html, /<a href="https:\/\/example\.feishu\.cn\/docx\/linked-doc" target="_blank" rel="noreferrer noopener">查看文档<\/a>/);
});

test('syncFeishuDocs reports missing configuration without network calls', async () => {
  let called = false;
  const result = await syncFeishuDocs({ env: {} as unknown as NodeJS.ProcessEnv, fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch, runBuild: async () => {} });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /未配置/);
  assert.equal(called, false);
});

test('local documents have independent CRUD and are listed separately from Feishu', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-local-'));
  const env = { DOCS_DATA_DIR: 'content' } as unknown as NodeJS.ProcessEnv;
  const created = await createLocalDocument({ id: 'intro', title: '本地介绍', content: '# Intro' }, { cwd, env });
  assert.equal(created.source, 'local');
  const updated = await updateLocalDocument('intro', { title: '更新介绍', content: '# Updated' }, { cwd, env });
  assert.equal(updated.content.trim(), '# Updated');
  assert.equal((await listManagedDocuments({ cwd, env })).length, 1);
  await deleteLocalDocument('intro', { cwd, env });
  assert.equal((await listManagedDocuments({ cwd, env })).length, 0);
});

function makeZip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name); const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30 + nameBuf.length + compressed.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(compressed.length, 22); local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30); compressed.copy(local, 30 + nameBuf.length); locals.push(local);
    const central = Buffer.alloc(46 + nameBuf.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); nameBuf.copy(central, 46); central.writeUInt32LE(offset, 42); centrals.push(central); offset += local.length;
  }
  const body = Buffer.concat([...locals, ...centrals]); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(Buffer.concat(centrals).length, 12); eocd.writeUInt32LE(offset, 16); return Buffer.concat([body, eocd]);
}

test('importZipDocument publishes markdown and rewrites relative assets', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-zip-')); const zip = makeZip([['guide.md', Buffer.from('# Guide\n\n![shot](assets/shot.png)\n\n[download](files/app.bin)')], ['assets/shot.png', Buffer.from([1, 2, 3])], ['files/app.bin', Buffer.from([4, 5])]]);
  const doc = await importZipDocument(zip, { id: 'guide', title: 'Guide' }, { cwd, env: { DOCS_DATA_DIR: 'content' } as unknown as NodeJS.ProcessEnv });
  assert.equal(doc.id, 'guide'); assert.match(doc.content, /\/docs\/guide\/assets\/shot\.png/); assert.match(doc.content, /\/docs\/guide\/files\/app\.bin/);
  assert.deepEqual([...await readFile(path.join(cwd, 'public/docs/guide/assets/shot.png'))], [1, 2, 3]);
  assert.match(await readFile(path.join(cwd, 'public/docs/guide/index.html'), 'utf8'), /<h1 id="guide">Guide<\/h1>/);
});

test('importZipDocument rejects traversal entries', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-zip-safe-')); const zip = makeZip([['../escape.md', Buffer.from('# bad')]]);
  await assert.rejects(() => importZipDocument(zip, { id: 'bad', title: '' }, { cwd }), /不安全|路径/);
});

test('importZipDocument does not overwrite an existing document', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-zip-existing-')); await createLocalDocument({ id: 'same', title: 'Old', content: '# Old' }, { cwd });
  await assert.rejects(() => importZipDocument(makeZip([['doc.md', Buffer.from('# New')]]), { id: 'same' }, { cwd }), /已存在/);
});
