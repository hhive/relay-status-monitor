import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';

import { parseStrictPositiveInteger, safeRedirectPath } from '../src/lib/security';
import { middleware } from '../src/middleware';
import { createAdminSession, verifyAdminSession } from '../src/lib/admin-session-token';
import { ADMIN_APP_ID } from '../src/lib/admin-sso';
import { signSessionToken } from '../src/lib/session-token';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('strict positive integer parser accepts only safe canonical decimals', () => {
  for (const [raw, expected] of [
    ['1', 1],
    ['42', 42],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const) {
    assert.equal(parseStrictPositiveInteger(raw), expected);
  }

  for (const raw of [
    '', '0', '00', '01', '-1', '+1', '1.0', '1e2', ' 1', '1 ', '1x',
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.equal(parseStrictPositiveInteger(raw), null, raw);
  }
});

test('safe redirect permits one leading slash and rejects dangerous forms', () => {
  for (const value of ['/', '/accounts', '/accounts/1?window=last24h']) {
    assert.equal(safeRedirectPath(value), value);
  }

  for (const value of [
    null,
    '',
    'accounts',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/path\nnext',
    '/path%0anext',
    '/path%0Dnext',
    '/path%09next',
    '/path%5cnext',
    '/path%255cnext',
  ]) {
    assert.equal(safeRedirectPath(value), '/', String(value));
  }
});

test('dynamic API routes use the strict parser instead of Number coercion', () => {
  const routes = [
    'src/app/api/alert-channels/[id]/route.ts',
    'src/app/api/account-alert-events/[id]/route.ts',
    'src/app/api/account-alert-rules/[id]/route.ts',
    'src/app/api/accounts/[id]/route.ts',
    'src/app/api/accounts/[id]/billing-alert/route.ts',
    'src/app/api/accounts/[id]/balance-credential/route.ts',
  ];

  for (const route of routes) {
    const contents = source(route);
    assert.match(contents, /parseStrictPositiveInteger\(/, route);
    assert.doesNotMatch(contents, /Number\((?:id|keyId)\)/, route);
  }
});

test('middleware exposes only exact public endpoints and framework assets', async () => {
  for (const pathname of [
    '/login',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/cron/collect',
    '/api/sub2api/admin-launch?token=one-time-ticket',
    '/_next/static/chunks/app.js',
    '/_next/image?url=%2Flogo.png&w=64&q=75',
    '/favicon.ico',
  ]) {
    const response = await middleware(new NextRequest(`https://monitor.example${pathname}`));
    assert.equal(response.headers.get('x-middleware-next'), '1', pathname);
  }

  for (const pathname of [
    '/login.evil',
    '/.env',
    '/api/data.json',
    '/api/sub2api/admin-launch.evil?token=one-time-ticket',
    '/api/sub2api/admin-launch/nested?token=one-time-ticket',
  ]) {
    const response = await middleware(new NextRequest(`https://monitor.example${pathname}`));
    if (pathname.startsWith('/api/')) {
      assert.equal(response.status, 401, pathname);
    } else {
      assert.equal(response.status, 307, pathname);
      const location = new URL(response.headers.get('location')!);
      assert.equal(location.pathname, '/login');
      assert.equal(location.searchParams.get('redirect'), pathname);
    }
  }
});

test('middleware returns 401 for unauthenticated APIs and a safe login redirect for pages', async () => {
  const apiResponse = await middleware(
    new NextRequest('https://monitor.example/api/accounts'),
  );
  assert.equal(apiResponse.status, 401);
  assert.deepEqual(await apiResponse.json(), { error: '未登录' });

  const pageResponse = await middleware(
    new NextRequest('https://monitor.example/accounts?window=last24h'),
  );
  assert.equal(pageResponse.status, 307);
  const location = new URL(pageResponse.headers.get('location')!);
  assert.equal(location.pathname, '/login');
  assert.equal(location.searchParams.get('redirect'), '/accounts?window=last24h');
});

test('middleware accepts valid local and admin sessions for pages and APIs', async () => {
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousEncryptionKey = process.env.APP_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = 's'.repeat(32);
  process.env.APP_ENCRYPTION_KEY = 'e'.repeat(32);
  try {
    const local = await signSessionToken({ userId: 7, username: 'local', sessionVersion: 1 });
    const admin = await createAdminSession({
      user_id: 19,
      email: 'owner@example.test',
      username: 'owner',
      role: 'admin',
      app_id: ADMIN_APP_ID,
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_060,
    }, 600);
    const cases = [
      ['rsm_session', local],
      ['rsm_admin_session', admin],
    ] as const;

    for (const [name, value] of cases) {
      for (const pathname of ['/', '/api/accounts']) {
        const request = new NextRequest(`https://monitor.example${pathname}`, {
          headers: { cookie: `${name}=${value}` },
        });
        const response = await middleware(request);
        assert.equal(response.headers.get('x-middleware-next'), '1', `${name}:${pathname}`);
      }
    }
  } finally {
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('csrf rejects unsafe admin-session writes unless origin and token both match', async () => {
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousEncryptionKey = process.env.APP_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = 's'.repeat(32);
  process.env.APP_ENCRYPTION_KEY = 'e'.repeat(32);
  try {
    const admin = await createAdminSession({
      user_id: 19,
      email: 'owner@example.test',
      username: 'owner',
      role: 'admin',
      app_id: ADMIN_APP_ID,
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_060,
    }, 600);
    const session = await verifyAdminSession(admin);
    assert.ok(session);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const rejectionCases: Array<{ headers: Record<string, string>; label: string }> = [
        { headers: {}, label: 'missing origin' },
        { headers: { origin: 'https://evil.example', 'x-csrf-token': session.csrfToken }, label: 'wrong origin' },
        { headers: { origin: 'https://monitor.example' }, label: 'missing token' },
        { headers: { origin: 'https://monitor.example', 'x-csrf-token': `${session.csrfToken}x` }, label: 'wrong token' },
      ];
      for (const item of rejectionCases) {
        const response = await middleware(new NextRequest('https://monitor.example/api/account-alert-rules/1', {
          method,
          headers: { cookie: `rsm_admin_session=${admin}`, ...item.headers },
        }));
        assert.equal(response.status, 403, `${method}: ${item.label}`);
      }

      const response = await middleware(new NextRequest('https://monitor.example/api/account-alert-rules/1', {
        method,
        headers: {
          cookie: `rsm_admin_session=${admin}`,
          origin: 'https://monitor.example',
          'x-csrf-token': session.csrfToken,
          'x-forwarded-host': 'evil.example',
        },
      }));
      assert.equal(response.headers.get('x-middleware-next'), '1', method);
    }

    const proxyHeaders = {
      cookie: `rsm_admin_session=${admin}`,
      host: 'monitor.xiaoni-ai.top',
      origin: 'https://monitor.xiaoni-ai.top',
      'x-csrf-token': session.csrfToken,
      'x-forwarded-proto': 'https',
    };
    const proxiedWrite = await middleware(new NextRequest(
      'https://localhost:3305/api/alert-channels',
      { method: 'POST', headers: proxyHeaders },
    ));
    assert.equal(proxiedWrite.headers.get('x-middleware-next'), '1', 'trusted proxy origin');

    const proxyRejectionCases: Array<{ headers: Record<string, string>; label: string }> = [
      {
        headers: { ...proxyHeaders, origin: 'https://localhost:3305' },
        label: 'internal standalone origin',
      },
      {
        headers: {
          ...proxyHeaders,
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
        },
        label: 'untrusted forwarded host',
      },
      {
        headers: { ...proxyHeaders, 'x-forwarded-proto': 'https,http' },
        label: 'forwarded protocol chain',
      },
      {
        headers: { ...proxyHeaders, 'x-forwarded-proto': 'javascript' },
        label: 'invalid forwarded protocol',
      },
    ];
    for (const item of proxyRejectionCases) {
      const response = await middleware(new NextRequest(
        'https://localhost:3305/api/alert-channels',
        { method: 'POST', headers: item.headers },
      ));
      assert.equal(response.status, 403, item.label);
    }
  } finally {
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('csrf leaves safe methods and valid local-session writes unchanged', async () => {
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousEncryptionKey = process.env.APP_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = 's'.repeat(32);
  process.env.APP_ENCRYPTION_KEY = 'e'.repeat(32);
  try {
    const admin = await createAdminSession({
      user_id: 19,
      email: 'owner@example.test',
      username: 'owner',
      role: 'admin',
      app_id: ADMIN_APP_ID,
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_060,
    }, 600);
    const local = await signSessionToken({ userId: 7, username: 'local', sessionVersion: 1 });

    for (const method of ['GET', 'HEAD']) {
      const response = await middleware(new NextRequest('https://monitor.example/api/accounts', {
        method,
        headers: { cookie: `rsm_admin_session=${admin}` },
      }));
      assert.equal(response.headers.get('x-middleware-next'), '1', method);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const localResponse = await middleware(new NextRequest('https://monitor.example/api/account-alert-rules/1', {
        method,
        headers: { cookie: `rsm_session=${local}` },
      }));
      assert.equal(localResponse.headers.get('x-middleware-next'), '1', `local ${method}`);

      const fallbackResponse = await middleware(new NextRequest('https://monitor.example/api/account-alert-rules/1', {
        method,
        headers: { cookie: `rsm_admin_session=invalid; rsm_session=${local}` },
      }));
      assert.equal(fallbackResponse.headers.get('x-middleware-next'), '1', `fallback ${method}`);
    }
  } finally {
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('auth endpoints expose the session union safely and keep password local-only', () => {
  const auth = source('src/lib/auth.ts');
  const me = source('src/app/api/auth/me/route.ts');
  const logout = source('src/app/api/auth/logout/route.ts');
  const password = source('src/app/api/auth/password/route.ts');

  assert.match(auth, /AdminApiSession\s*\|\s*LocalApiSession/);
  assert.match(auth, /source:\s*'local'/);
  assert.ok(auth.indexOf('ADMIN_SESSION_COOKIE_NAME') < auth.indexOf('COOKIE_NAME'));
  assert.match(auth, /export async function requireLocalApiSession/);
  assert.match(me, /toMeResponseBody\(auth\.session\)/);
  assert.match(auth, /source:\s*session\.source/);
  assert.match(auth, /session\.source\s*===\s*'sub2api'/);
  assert.match(auth, /csrfToken:\s*session\.csrfToken/);
  assert.doesNotMatch(auth, /email:\s*session\.|role:\s*session\./);
  assert.match(logout, /destroySession/);
  assert.match(password, /requireLocalApiSession/);
  assert.ok(password.indexOf('await requireLocalApiSession()') < password.indexOf('request.json('));
  assert.ok(password.indexOf('await requireLocalApiSession()') < password.indexOf('prisma.$transaction'));
});

test('admin session account UI disables password changes and points to Sub2API', () => {
  const settings = source('src/app/(dashboard)/settings/page.tsx');
  assert.match(settings, /fetch\(['"]\/api\/auth\/me['"]\)/);
  assert.match(settings, /source\s*===\s*['"]sub2api['"]/);
  assert.match(settings, /请在 Sub2API 修改管理员凭据/);
  assert.match(settings, /disabled=\{[^}]*isSub2Api/);
});
