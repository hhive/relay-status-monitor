import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';

import { parseStrictPositiveInteger, safeRedirectPath } from '../src/lib/security';
import { middleware } from '../src/middleware';

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
  for (const value of ['/', '/upstreams', '/upstreams/1?tab=keys']) {
    assert.equal(safeRedirectPath(value), value);
  }

  for (const value of [
    null,
    '',
    'upstreams',
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
    'src/app/api/alert-rules/[id]/route.ts',
    'src/app/api/incidents/[id]/route.ts',
    'src/app/api/keys/[keyId]/metadata/route.ts',
    'src/app/api/keys/[keyId]/test/route.ts',
    'src/app/api/upstreams/[id]/keys/[keyId]/route.ts',
    'src/app/api/upstreams/[id]/keys/route.ts',
    'src/app/api/upstreams/[id]/models/route.ts',
    'src/app/api/upstreams/[id]/refresh/route.ts',
    'src/app/api/upstreams/[id]/route.ts',
    'src/app/api/upstreams/[id]/test/route.ts',
  ];

  for (const route of routes) {
    const contents = source(route);
    assert.match(contents, /parseStrictPositiveInteger\(/, route);
    assert.doesNotMatch(contents, /Number\((?:id|keyId)\)/, route);
  }
});

test('metrics and incidents validate every numeric query parameter strictly', () => {
  for (const route of ['src/app/api/metrics/route.ts', 'src/app/api/incidents/route.ts']) {
    const contents = source(route);
    assert.match(contents, /parseStrictPositiveInteger\(/, route);
    assert.doesNotMatch(contents, /Number\(searchParams\.get/, route);
    assert.doesNotMatch(contents, /Number\((?:upstreamId|upstreamKeyId|keyId)\)/, route);
  }
});

test('models key lookup is scoped to both key id and upstream id', () => {
  const contents = source('src/app/api/upstreams/[id]/models/route.ts');
  assert.match(contents, /upstreamKey\.findFirst/);
  assert.match(contents, /where:[\s\S]*?\{\s*id:\s*numericKeyId,\s*upstreamId\s*\}/);
  assert.doesNotMatch(contents, /upstreamKey\.findUnique/);
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
    new NextRequest('https://monitor.example/api/dashboard'),
  );
  assert.equal(apiResponse.status, 401);
  assert.deepEqual(await apiResponse.json(), { error: '未登录' });

  const pageResponse = await middleware(
    new NextRequest('https://monitor.example/upstreams?view=all'),
  );
  assert.equal(pageResponse.status, 307);
  const location = new URL(pageResponse.headers.get('location')!);
  assert.equal(location.pathname, '/login');
  assert.equal(location.searchParams.get('redirect'), '/upstreams?view=all');
});
