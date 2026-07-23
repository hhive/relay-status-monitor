import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { redactSensitiveText, safeErrorMessage } from '../src/lib/safe-error';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('redacts credentials from representative error formats', () => {
  const secretValues = [
    'bearer-canary-value',
    'sk-canary-api-key-123456789',
    'postgres-password',
    'url-password',
    'webhook-token-canary',
    'plain-api-key-canary',
  ];
  const raw = [
    'Authorization: Bearer bearer-canary-value',
    'request failed for sk-canary-api-key-123456789',
    'postgresql://monitor:postgres-password@db.internal:5432/status',
    'https://alice:url-password@example.test/private',
    'https://open.feishu.cn/open-apis/bot/v2/hook/webhook-token-canary',
    'api_key=plain-api-key-canary',
  ].join(' | ');

  const redacted = redactSensitiveText(raw);
  for (const secret of secretValues) assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /\[REDACTED\]/);
});

test('safe error messages are bounded and never stringify response bodies', () => {
  const message = safeErrorMessage(new Error(`upstream failed ${'x'.repeat(2_000)} Bearer final-canary`));
  assert.ok(message.length <= 240);
  assert.doesNotMatch(message, /final-canary/);

  for (const relativePath of [
    'src/lib/adapters/sub2api.ts',
    'src/lib/adapters/newapi.ts',
    'src/lib/alerts/channels/feishu.ts',
  ]) {
    const source = readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /\.text\s*\(/, relativePath);
    if (relativePath.endsWith('feishu.ts')) assert.match(source, /responseBody\.code/);
  }
});

test('credential and collection routes return fixed errors instead of exception messages', () => {
  for (const relativePath of [
    'src/app/api/keys/[keyId]/metadata/route.ts',
    'src/app/api/keys/[keyId]/test/route.ts',
    'src/app/api/upstreams/[id]/keys/route.ts',
    'src/app/api/upstreams/[id]/keys/[keyId]/route.ts',
    'src/app/api/upstreams/[id]/refresh/route.ts',
    'src/app/api/upstreams/[id]/test/route.ts',
    'src/app/api/upstreams/route.ts',
    'src/app/api/upstreams/[id]/route.ts',
  ]) {
    const source = readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /\(e(?:rror)? as Error\)\.message|error instanceof Error \? error\.message/, relativePath);
  }
});
