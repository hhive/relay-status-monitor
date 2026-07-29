import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  queryConfiguredUpstreamBalance,
  queryNewApiBalance,
} from '../src/lib/account-observability/upstream-balance';
import {
  openNewApiAccessToken,
  sealNewApiAccessToken,
  toSafeBalanceCredential,
} from '../src/lib/account-observability/balance-credential-config';

process.env.SESSION_SECRET ||= 'session-secret-for-newapi-balance-tests-123';
process.env.APP_ENCRYPTION_KEY ||= 'encryption-key-for-newapi-balance-tests-123';

const root = new URL('../', import.meta.url);
const source = (path: string) => {
  const file = new URL(path, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

test('New API wallet uses instance quota_per_unit and credential headers', async () => {
  const requests: Array<{ url: string; authorization: string | null; userId: string | null; redirect?: RequestRedirect }> = [];
  const balance = await queryNewApiBalance({
    baseUrl: 'https://new.example/v1', accessToken: 'access-canary', userId: '42',
  }, async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      authorization: headers.get('authorization'),
      userId: headers.get('new-api-user'),
      redirect: init?.redirect,
    });
    if (url.endsWith('/api/status')) {
      return new Response(JSON.stringify({ success: true, data: { quota_per_unit: 250000 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, data: { quota: 1_375_000 } }), { status: 200 });
  });

  assert.equal(balance, 5.5);
  assert.deepEqual(requests.map(({ url }) => url), [
    'https://new.example/api/status',
    'https://new.example/api/user/self',
  ]);
  assert.equal(requests[1].authorization, 'Bearer access-canary');
  assert.equal(requests[1].userId, '42');
  assert.equal(requests.every(({ redirect }) => redirect === 'manual'), true);
});

test('New API wallet and automatic detection map unsupported responses to null', async () => {
  assert.equal(await queryNewApiBalance({
    baseUrl: 'https://new.example', accessToken: 'access', userId: '42',
  }, async (input) => String(input).endsWith('/api/status')
    ? new Response(JSON.stringify({ success: true, data: { quota_per_unit: 0 } }), { status: 200 })
    : new Response(JSON.stringify({ success: true, data: { quota: 500000 } }), { status: 200 })), null);

  const paths: string[] = [];
  const balance = await queryConfiguredUpstreamBalance({
    baseUrl: 'https://new.example/v1', apiKey: 'api-key', mode: 'auto',
    newApiAccessToken: 'access', newApiUserId: '42',
  }, async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/v1/usage') return new Response('{}', { status: 404 });
    if (path === '/api/status') return new Response(JSON.stringify({ success: true, data: { quota_per_unit: 500000 } }), { status: 200 });
    return new Response(JSON.stringify({ success: true, data: { quota: 2_000_000 } }), { status: 200 });
  });
  assert.equal(balance, 4);
  assert.deepEqual(paths, ['/v1/usage', '/api/status', '/api/user/self']);
});

test('New API access tokens are encrypted and represented write-only', () => {
  const ciphertext = sealNewApiAccessToken('access-token-canary');
  assert.doesNotMatch(ciphertext, /access-token-canary/);
  assert.equal(openNewApiAccessToken(ciphertext), 'access-token-canary');
  assert.deepEqual(toSafeBalanceCredential({ mode: 'AUTO', newApiUserId: '42', newApiAccessTokenCiphertext: ciphertext }), {
    mode: 'auto', newApiUserId: '42', accessTokenConfigured: true,
  });
});

test('schema, API and account detail expose safe New API balance configuration', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source('prisma/migrations/20260729120000_add_newapi_balance_credentials/migration.sql');
  const route = source('src/app/api/accounts/[id]/balance-credential/route.ts');
  const detail = source('src/app/(dashboard)/accounts/[id]/page.tsx');

  assert.match(schema, /model AccountBalanceCredential/);
  assert.match(schema, /newApiAccessTokenCiphertext\s+String\?/);
  assert.match(migration, /CREATE TABLE "AccountBalanceCredential"/);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE)/i);
  assert.match(route, /requireApiSession/);
  assert.match(route, /accessTokenConfigured/);
  assert.doesNotMatch(route, /NextResponse\.json\([^\n]*newApiAccessTokenCiphertext/);
  assert.match(detail, /余额接口模式/);
  assert.match(detail, /New API Access Token/);
  assert.match(detail, /New API User ID/);
  assert.match(detail, /type="password"/);
});
