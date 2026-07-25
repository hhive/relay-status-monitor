import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { redactSensitiveText, safeErrorMessage } from '../src/lib/safe-error';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function apiRoutePaths(directory = path.join(projectRoot, 'src/app/api')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return apiRoutePaths(absolutePath);
    return entry.name === 'route.ts' ? [path.relative(projectRoot, absolutePath)] : [];
  });
}

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

  for (const relativePath of ['src/lib/alerts/channels/feishu.ts']) {
    const source = readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /\.text\s*\(/, relativePath);
    if (relativePath.endsWith('feishu.ts')) assert.match(source, /responseBody\.code/);
  }
});

test('all API routes keep exception messages out of catch responses', () => {
  const routes = apiRoutePaths();
  assert.ok(routes.length > 0);
  for (const relativePath of routes) {
    const contents = readFileSync(path.join(projectRoot, relativePath), 'utf8');
    assert.doesNotMatch(contents, /\.(?:message)\b/, relativePath);
    assert.doesNotMatch(
      contents,
      /catch\s*\([^)]*\)[\s\S]*?NextResponse\.json\([^)]*\+[^)]*\)/,
      relativePath,
    );
  }
});
