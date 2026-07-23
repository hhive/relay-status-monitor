import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fetchCredentialed,
  validateFeishuWebhookUrl,
  validateUpstreamBaseUrl,
} from '../src/lib/outbound';
import { NewApiAdapter } from '../src/lib/adapters/newapi';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('SUB2API accepts only the exact deployed loopback origin', () => {
  assert.equal(validateUpstreamBaseUrl('SUB2API', 'http://127.0.0.1:8080').toString(), 'http://127.0.0.1:8080/');

  for (const value of [
    'https://127.0.0.1:8080',
    'http://127.0.0.1',
    'http://127.0.0.1:80',
    'http://127.0.0.1:8081',
    'http://localhost:8080',
    'http://127.1:8080',
    'http://2130706433:8080',
    'http://[::1]:8080',
    'http://user:pass@127.0.0.1:8080',
    'http://127.0.0.1:8080.evil.example',
  ]) {
    assert.throws(() => validateUpstreamBaseUrl('SUB2API', value), /不允许|仅支持/i, value);
  }
});

test('NEW_API is explicitly disabled for this deployment', () => {
  for (const value of ['https://new-api.example', 'http://127.0.0.1:3000']) {
    assert.throws(() => validateUpstreamBaseUrl('NEW_API', value), /未启用/i, value);
  }
});

test('credentialed fetch never follows redirects or consumes redirect bodies', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const response = await fetchCredentialed(
    'http://127.0.0.1:8080/v1/models',
    { headers: { Authorization: 'Bearer canary-secret' } },
    1000,
    async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response('attacker-controlled-body', {
        status: 302,
        headers: { Location: 'https://evil.example/steal' },
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal(response.ok, false);
  assert.equal(response.error.category, 'upstream_redirect');
  assert.doesNotMatch(JSON.stringify(response), /attacker-controlled-body|canary-secret|evil\.example/);
});

test('Feishu webhook validation allows only official HTTPS hook endpoints', () => {
  const valid = validateFeishuWebhookUrl(
    'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123',
  );
  assert.equal(valid.toString(), 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123');

  for (const value of [
    'http://open.feishu.cn/open-apis/bot/v2/hook/abc',
    'https://open.feishu.cn:444/open-apis/bot/v2/hook/abc',
    'https://user:pass@open.feishu.cn/open-apis/bot/v2/hook/abc',
    'https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/abc',
    'https://open.feishu.cn/open-apis/other',
    'https://open.feishu.cn/open-apis/bot/v2/hook/',
  ]) {
    assert.throws(() => validateFeishuWebhookUrl(value), /飞书|Webhook/i, value);
  }
});

test('New API metadata lookup never places an API key in a request URL', async () => {
  const canary = 'sk-canary-must-not-appear-in-url';
  const requestedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return Response.json({ code: true, data: { name: 'safe-name' } });
  }) as typeof fetch;

  try {
    const result = await new NewApiAdapter().fetchKeyMetadata({
      baseUrl: 'https://new-api.example',
      apiKey: canary,
      accessToken: 'access-canary',
      userId: '1',
      timeoutMs: 1000,
      testModel: 'test',
    });
    assert.match(result.errorMessage || '', /未启用|不支持/i);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(requestedUrls.every((url) => !url.includes(canary)));
});

test('upstream destinations are validated on save and before credential decryption', () => {
  const createRoute = source('src/app/api/upstreams/route.ts');
  const updateRoute = source('src/app/api/upstreams/[id]/route.ts');
  for (const route of [createRoute, updateRoute]) {
    assert.match(route, /validateUpstreamBaseUrl\(/);
    assert.doesNotMatch(route, /replace\(\/\^https\?:/);
  }

  const collector = source('src/lib/collector.ts');
  assert.match(collector, /validateUpstreamBaseUrl\(/);
  assert.ok(
    collector.indexOf('validateUpstreamBaseUrl(') < collector.indexOf('tryDecrypt('),
    'runtime destination validation must precede credential decryption',
  );

  const modelsRoute = source('src/app/api/upstreams/[id]/models/route.ts');
  assert.match(modelsRoute, /validateUpstreamBaseUrl\(/);
  assert.ok(
    modelsRoute.indexOf('validateUpstreamBaseUrl(') < modelsRoute.indexOf('tryDecrypt('),
    'model listing must validate its destination before credential decryption',
  );
});
