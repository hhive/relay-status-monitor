import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fetchCredentialed,
  validateFeishuWebhookUrl,
} from '../src/lib/outbound';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

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

test('account Feishu notifications validate destinations before sending credentials', () => {
  const channel = source('src/lib/alerts/channels/feishu.ts');
  assert.match(channel, /fetchCredentialed\(validateFeishuWebhookUrl\(config\.webhookUrl\)/);
  assert.match(channel, /for\s*\(const channel of channels\)/);
  assert.match(channel, /deliveredChannelIds\.has\(channel\.id\)/);
  assert.match(channel, /await onDelivered\(channel\.id\)/);
  assert.match(channel, /safeErrorMessage\(/);
  assert.match(channel, /if\s*\(failed\)\s*throw new Error\(['"]账号告警通知发送失败['"]\)/);
});
