import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADMIN_APP_ID,
  ADMIN_EXCHANGE_PATH,
  ADMIN_EXCHANGE_TIMEOUT_MS,
  exchangeAdminLaunchTicket,
  resolveAdminSsoConfig,
  validateAdminClaims,
  type AdminClaims,
} from '../src/lib/admin-sso';
import { createAdminLaunchHandler } from '../src/app/api/sub2api/admin-launch/route';

const strongSecret = 'admin-exchange-secret-for-tests-only';
const validEnvironment = {
  SUB2API_ADMIN_EXCHANGE_BASE_URL: 'https://sub2api.example.test',
  SUB2API_ADMIN_EXCHANGE_SECRET: strongSecret,
};
const nowSeconds = 1_800_000_000;
const validClaims: AdminClaims = {
  user_id: 7,
  email: 'admin@example.test',
  username: 'admin',
  role: 'admin',
  app_id: ADMIN_APP_ID,
  issued_at: nowSeconds - 10,
  expires_at: nowSeconds + 60,
};

test('admin sso rejects missing, weak, and non-fixed exchange configuration', () => {
  assert.throws(() => resolveAdminSsoConfig({}), /configuration/i);
  assert.throws(() => resolveAdminSsoConfig({
    ...validEnvironment,
    SUB2API_ADMIN_EXCHANGE_SECRET: 'too-short',
  }), /configuration/i);
  assert.throws(() => resolveAdminSsoConfig({
    ...validEnvironment,
    SUB2API_ADMIN_EXCHANGE_SECRET: 'replace-with-a-32-byte-minimum-random-secret',
  }), /configuration/i);

  for (const baseUrl of [
    'http://sub2api.example.test',
    'https://sub2api.example.test/prefix',
    'https://sub2api.example.test?exchange=/attacker',
    'https://user:password@sub2api.example.test',
    'http://localhost.attacker.test:3000',
    'http://127.0.0.2:3000',
  ]) {
    assert.throws(() => resolveAdminSsoConfig({
      ...validEnvironment,
      SUB2API_ADMIN_EXCHANGE_BASE_URL: baseUrl,
    }), /configuration/i, baseUrl);
  }

  assert.equal(
    resolveAdminSsoConfig({
      ...validEnvironment,
      SUB2API_ADMIN_EXCHANGE_BASE_URL: 'http://127.0.0.1:3000',
    }).exchangeUrl,
    `http://127.0.0.1:3000${ADMIN_EXCHANGE_PATH}`,
  );
  assert.equal(ADMIN_APP_ID, 'upstream-monitor');
  assert.equal(ADMIN_EXCHANGE_PATH, '/api/v1/external-apps/upstream-monitor/exchange');
});

test('admin sso resolves an 8 hour default TTL with a 24 hour maximum', () => {
  assert.equal(resolveAdminSsoConfig(validEnvironment).sessionTtlSeconds, 8 * 60 * 60);
  assert.equal(resolveAdminSsoConfig({
    ...validEnvironment,
    RSM_ADMIN_SESSION_TTL_SECONDS: String(24 * 60 * 60),
  }).sessionTtlSeconds, 24 * 60 * 60);

  for (const ttl of ['0', '1.5', String(24 * 60 * 60 + 1), 'not-a-number']) {
    assert.throws(() => resolveAdminSsoConfig({
      ...validEnvironment,
      RSM_ADMIN_SESSION_TTL_SECONDS: ttl,
    }), /configuration/i, ttl);
  }
});

test('admin sso exchange sends only the launch token and fixed secret header', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json(validClaims);
  };

  const claims = await exchangeAdminLaunchTicket('one-time-ticket', {
    environment: validEnvironment,
    fetchImpl,
    nowSeconds,
  });

  assert.deepEqual(claims, validClaims);
  assert.equal(capturedUrl, `https://sub2api.example.test${ADMIN_EXCHANGE_PATH}`);
  assert.equal(capturedInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { token: 'one-time-ticket' });
  assert.deepEqual(
    Object.fromEntries(new Headers(capturedInit?.headers).entries()),
    {
      'content-type': 'application/json',
      'x-sub2api-external-app-secret': strongSecret,
    },
  );
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  assert.equal(ADMIN_EXCHANGE_TIMEOUT_MS, 10_000);
});

test('admin sso accepts only exact, current administrator claims', () => {
  assert.deepEqual(validateAdminClaims(validClaims, nowSeconds), validClaims);

  const rejected: unknown[] = [
    { ...validClaims, role: 'user' },
    { ...validClaims, app_id: 'other-app' },
    { ...validClaims, issued_at: nowSeconds + 1 },
    { ...validClaims, expires_at: nowSeconds },
    { ...validClaims, user_id: 0 },
    { ...validClaims, email: '' },
    { ...validClaims, access_token: 'must-not-cross-boundary' },
    { ...validClaims, api_key: 'must-not-cross-boundary' },
    { ...validClaims, display_name: 'extra identity field' },
  ];

  for (const claims of rejected) {
    assert.throws(() => validateAdminClaims(claims, nowSeconds), /claims/i);
  }
});

test('admin sso landing requires one non-empty token and redirects after attaching a session', async () => {
  const calls: string[] = [];
  const handler = createAdminLaunchHandler({
    exchangeAdminTicket: async (token) => {
      calls.push(`exchange:${token}`);
      return { claims: validClaims, sessionTtlSeconds: 600 };
    },
    createAdminSession: async (claims, ttlSeconds) => {
      assert.deepEqual(claims, validClaims);
      assert.equal(ttlSeconds, 600);
      calls.push('create');
      return 'signed-admin-session';
    },
    attachAdminSession: (response, token, ttlSeconds) => {
      assert.equal(token, 'signed-admin-session');
      assert.equal(ttlSeconds, 600);
      calls.push('attach');
      response.headers.set('x-test-session-attached', 'yes');
    },
  });

  const response = await handler(new Request(
    'https://monitor.example.test/api/sub2api/admin-launch?token=one-time-ticket',
  ));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://monitor.example.test/');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-test-session-attached'), 'yes');
  assert.deepEqual(calls, ['exchange:one-time-ticket', 'create', 'attach']);
});

test('admin sso landing returns one redacted 401 response for invalid or failed launches', async () => {
  const canaries = ['ticket-canary', 'secret-canary', 'upstream-body-canary'];
  let exchangeCalls = 0;
  const handler = createAdminLaunchHandler({
    exchangeAdminTicket: async () => {
      exchangeCalls += 1;
      throw new Error(`${canaries[1]} ${canaries[2]}`);
    },
    createAdminSession: async () => {
      throw new Error('must not be reached');
    },
    attachAdminSession: () => {
      throw new Error('must not be reached');
    },
  });

  const urls = [
    'https://monitor.example.test/api/sub2api/admin-launch',
    'https://monitor.example.test/api/sub2api/admin-launch?token=',
    `https://monitor.example.test/api/sub2api/admin-launch?token=${canaries[0]}&token=second`,
    `https://monitor.example.test/api/sub2api/admin-launch?token=${canaries[0]}`,
  ];

  for (const url of urls) {
    const response = await handler(new Request(url));
    const body = await response.text();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    for (const canary of canaries) assert.doesNotMatch(body, new RegExp(canary));
  }
  assert.equal(exchangeCalls, 1);
});
