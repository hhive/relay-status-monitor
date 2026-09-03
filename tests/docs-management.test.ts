import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDocsAdminSession, requestDocsSync, resetDocsSyncState, syncFeishuDocs } from '../src/lib/docs-management';
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
  assert.match(String(calls[1]?.init?.headers && new Headers(calls[1].init?.headers).get('authorization')), /Bearer test-token/);
});

test('syncFeishuDocs reports missing configuration without network calls', async () => {
  let called = false;
  const result = await syncFeishuDocs({ env: {} as unknown as NodeJS.ProcessEnv, fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch, runBuild: async () => {} });
  assert.equal(result.status, 'failed');
  assert.match(result.message, /未配置/);
  assert.equal(called, false);
});
