import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalDocument, deleteLocalDocument, isDocsAdminSession, listManagedDocuments, requestDocsSync, resetDocsSyncState, syncFeishuDocs, updateLocalDocument } from '../src/lib/docs-management';
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
  assert.equal(await readFile(path.join(cwd, 'docs-site/feishu.md'), 'utf8'), '---\ntitle: 飞书同步文档\n---\n\n# Synced\n\nHello from Feishu.\n');
  assert.match(await readFile(path.join(cwd, 'public/docs/index.html'), 'utf8'), /<h1>Synced<\/h1>/);
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
  assert.match(html, /结构化标题/);
  assert.match(html, /https:\/\/example\.com/);
  assert.match(html, /<img src="\/docs\/assets\/feishu\/image-token\.png"/);
  assert.match(html, /img\{display:block;width:70%;max-width:70%;/);
  assert.match(html, /@media \(max-width:640px\)\{img\{width:100%;max-width:100%;\}\}/);
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
  assert.match(html, /<a href="https:\/\/example\.feishu\.cn\/docx\/linked-doc" rel="noreferrer">查看文档<\/a>/);
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
