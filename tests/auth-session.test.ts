import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';

import {
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  sessionMatchesUser,
  signSessionToken,
  verifySessionToken,
} from '../src/lib/session-token';
import {
  ADMIN_SESSION_AUDIENCE,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_ISSUER,
  ADMIN_SESSION_MAX_AGE,
  ADMIN_SESSION_PURPOSE,
  attachAdminSession,
  createAdminSession,
  verifyAdminSession,
} from '../src/lib/admin-session-token';
import { ADMIN_APP_ID, type AdminClaims } from '../src/lib/admin-sso';
import { resolveApplicationSecrets } from '../src/lib/auth-config';
import {
  clearSessionCookies,
  requireLocalApiSession,
  resolveSessionFromTokens,
} from '../src/lib/auth';
import { NextResponse } from 'next/server';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validEnvironment = {
  SESSION_SECRET: 's'.repeat(32),
  APP_ENCRYPTION_KEY: 'e'.repeat(32),
};
const adminClaims: AdminClaims = {
  user_id: 19,
  email: 'owner@example.test',
  username: 'owner',
  role: 'admin',
  app_id: ADMIN_APP_ID,
  issued_at: 1_800_000_000,
  expires_at: 1_800_000_060,
};

test('session and encryption secrets are independent and at least 32 bytes', () => {
  const secrets = resolveApplicationSecrets(validEnvironment);
  assert.equal(secrets.sessionSecret.byteLength, 32);
  assert.equal(secrets.encryptionKey.byteLength, 32);

  assert.throws(() => resolveApplicationSecrets({
    ...validEnvironment,
    SESSION_SECRET: 's'.repeat(31),
  }));
  assert.throws(() => resolveApplicationSecrets({
    ...validEnvironment,
    APP_ENCRYPTION_KEY: 'e'.repeat(31),
  }));
  assert.throws(() => resolveApplicationSecrets({
    SESSION_SECRET: 'x'.repeat(32),
    APP_ENCRYPTION_KEY: 'x'.repeat(32),
  }));

  const multibyte = resolveApplicationSecrets({
    SESSION_SECRET: '密'.repeat(11),
    APP_ENCRYPTION_KEY: '钥'.repeat(11),
  });
  assert.ok(multibyte.sessionSecret.byteLength >= 32);
});

test('signed sessions contain the fixed algorithm and required claims', async () => {
  const token = await signSessionToken(
    { userId: 7, username: 'admin', sessionVersion: 3 },
    validEnvironment,
  );
  const header = decodeProtectedHeader(token);
  const payload = decodeJwt(token);

  assert.equal(header.alg, 'HS256');
  assert.equal(payload.iss, SESSION_ISSUER);
  assert.equal(payload.aud, SESSION_AUDIENCE);
  assert.equal(payload.userId, 7);
  assert.equal(payload.username, 'admin');
  assert.equal(payload.sessionVersion, 3);
  assert.equal(typeof payload.exp, 'number');
  assert.deepEqual(await verifySessionToken(token, validEnvironment), {
    userId: 7,
    username: 'admin',
    sessionVersion: 3,
  });
});

test('verification rejects wrong algorithm, issuer, audience, expiry, and missing claims', async () => {
  const secret = new TextEncoder().encode(validEnvironment.SESSION_SECRET);
  const basePayload = { userId: 7, username: 'admin', sessionVersion: 3 };
  const cases = [
    new SignJWT(basePayload)
      .setProtectedHeader({ alg: 'HS512' })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setExpirationTime('1h')
      .sign(secret),
    new SignJWT(basePayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('wrong-issuer')
      .setAudience(SESSION_AUDIENCE)
      .setExpirationTime('1h')
      .sign(secret),
    new SignJWT(basePayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(SESSION_ISSUER)
      .setAudience('wrong-audience')
      .setExpirationTime('1h')
      .sign(secret),
    new SignJWT(basePayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setExpirationTime(1)
      .sign(secret),
    new SignJWT({ userId: 7, username: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setExpirationTime('1h')
      .sign(secret),
  ];

  for (const pendingToken of cases) {
    assert.equal(await verifySessionToken(await pendingToken, validEnvironment), null);
  }
});

test('admin session uses an isolated fixed JWT contract and an 8 hour default', async () => {
  const token = await createAdminSession(adminClaims, undefined, validEnvironment);
  const header = decodeProtectedHeader(token);
  const payload = decodeJwt(token);

  assert.equal(ADMIN_SESSION_COOKIE_NAME, 'rsm_admin_session');
  assert.equal(ADMIN_SESSION_MAX_AGE, 24 * 60 * 60);
  assert.equal(header.alg, 'HS256');
  assert.equal(payload.iss, ADMIN_SESSION_ISSUER);
  assert.equal(payload.aud, ADMIN_SESSION_AUDIENCE);
  assert.equal(payload.purpose, ADMIN_SESSION_PURPOSE);
  assert.equal(payload.userId, 19);
  assert.equal(payload.email, 'owner@example.test');
  assert.equal(payload.username, 'owner');
  assert.equal(payload.role, 'admin');
  assert.equal(payload.appId, ADMIN_APP_ID);
  assert.equal(typeof payload.csrfToken, 'string');
  assert.ok((payload.csrfToken as string).length >= 32);
  assert.equal((payload.exp as number) - (payload.iat as number), 8 * 60 * 60);
  assert.deepEqual(Object.keys(payload).sort(), [
    'appId', 'aud', 'csrfToken', 'email', 'exp', 'iat', 'iss', 'purpose', 'role', 'userId',
    'username',
  ]);
  assert.deepEqual(await verifyAdminSession(token, validEnvironment), {
    source: 'sub2api',
    userId: 19,
    email: 'owner@example.test',
    username: 'owner',
    csrfToken: payload.csrfToken,
  });
});

test('admin session rejects invalid TTL and every fixed or required claim mismatch', async () => {
  await assert.rejects(() => createAdminSession(adminClaims, 0, validEnvironment));
  await assert.rejects(() => createAdminSession(
    adminClaims,
    ADMIN_SESSION_MAX_AGE + 1,
    validEnvironment,
  ));

  const secret = new TextEncoder().encode(validEnvironment.SESSION_SECRET);
  const basePayload = {
    userId: 19,
    email: 'owner@example.test',
    username: 'owner',
    role: 'admin',
    appId: ADMIN_APP_ID,
    purpose: ADMIN_SESSION_PURPOSE,
    csrfToken: 'c'.repeat(32),
  };
  const variants = [
    { header: 'HS512', issuer: ADMIN_SESSION_ISSUER, audience: ADMIN_SESSION_AUDIENCE, payload: basePayload },
    { header: 'HS256', issuer: 'wrong', audience: ADMIN_SESSION_AUDIENCE, payload: basePayload },
    { header: 'HS256', issuer: ADMIN_SESSION_ISSUER, audience: 'wrong', payload: basePayload },
    { header: 'HS256', issuer: ADMIN_SESSION_ISSUER, audience: ADMIN_SESSION_AUDIENCE, payload: { ...basePayload, purpose: 'local' } },
    { header: 'HS256', issuer: ADMIN_SESSION_ISSUER, audience: ADMIN_SESSION_AUDIENCE, payload: { ...basePayload, role: 'user' } },
    { header: 'HS256', issuer: ADMIN_SESSION_ISSUER, audience: ADMIN_SESSION_AUDIENCE, payload: { ...basePayload, appId: 'other' } },
    { header: 'HS256', issuer: ADMIN_SESSION_ISSUER, audience: ADMIN_SESSION_AUDIENCE, payload: { ...basePayload, email: '' } },
    { header: 'HS256', issuer: ADMIN_SESSION_ISSUER, audience: ADMIN_SESSION_AUDIENCE, payload: { ...basePayload, csrfToken: '' } },
  ] as const;

  for (const variant of variants) {
    const token = await new SignJWT(variant.payload)
      .setProtectedHeader({ alg: variant.header })
      .setIssuer(variant.issuer)
      .setAudience(variant.audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);
    assert.equal(await verifyAdminSession(token, validEnvironment), null);
  }

  const expired = await new SignJWT(basePayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ADMIN_SESSION_ISSUER)
    .setAudience(ADMIN_SESSION_AUDIENCE)
    .setIssuedAt(1)
    .setExpirationTime(2)
    .sign(secret);
  assert.equal(await verifyAdminSession(expired, validEnvironment), null);
});

test('local and admin session tokens cannot cross their verification boundaries', async () => {
  const local = await signSessionToken(
    { userId: 7, username: 'admin', sessionVersion: 3 },
    validEnvironment,
  );
  const admin = await createAdminSession(adminClaims, 600, validEnvironment);

  assert.equal(await verifyAdminSession(local, validEnvironment), null);
  assert.equal(await verifySessionToken(admin, validEnvironment), null);
});

test('admin session cookie has hardened root-scoped attributes', async () => {
  const response = NextResponse.next();
  attachAdminSession(response, 'signed-admin-session', 600, 'production');
  const cookie = response.headers.get('set-cookie') ?? '';

  assert.match(cookie, /^rsm_admin_session=signed-admin-session;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=600/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=lax/i);
});

test('admin session wins over a local cookie without querying the local user', async () => {
  const admin = await createAdminSession(adminClaims, 600, validEnvironment);
  const local = await signSessionToken(
    { userId: 19, username: 'local-owner', sessionVersion: 3 },
    validEnvironment,
  );
  let localUserQueries = 0;

  const session = await resolveSessionFromTokens(
    admin,
    local,
    async () => {
      localUserQueries += 1;
      return { id: 19, username: 'local-owner', sessionVersion: 3 };
    },
    validEnvironment,
  );

  assert.equal(session?.source, 'sub2api');
  assert.equal(session?.username, 'owner');
  assert.equal(localUserQueries, 0);
});

test('invalid admin cookie falls back to a verified local session', async () => {
  const local = await signSessionToken(
    { userId: 7, username: 'local', sessionVersion: 3 },
    validEnvironment,
  );
  let localUserQueries = 0;

  const session = await resolveSessionFromTokens(
    'not-an-admin-token',
    local,
    async () => {
      localUserQueries += 1;
      return { id: 7, username: 'local', sessionVersion: 3 };
    },
    validEnvironment,
  );

  assert.deepEqual(session, {
    source: 'local',
    userId: 7,
    username: 'local',
    sessionVersion: 3,
  });
  assert.equal(localUserQueries, 1);
});

test('local-only API guard rejects an admin session with 403', async () => {
  const auth = await requireLocalApiSession(async () => ({
    source: 'sub2api',
    userId: 19,
    email: 'owner@example.test',
    username: 'owner',
    csrfToken: 'c'.repeat(32),
  }));

  assert.equal(auth.ok, false);
  if (!auth.ok) {
    assert.equal(auth.response.status, 403);
    assert.deepEqual(await auth.response.json(), { error: '禁止访问' });
  }
});

test('logout cookie cleanup deletes both local and admin sessions', () => {
  const deleted: string[] = [];
  clearSessionCookies({ delete: (name) => deleted.push(name) });
  assert.deepEqual(deleted, ['rsm_admin_session', 'rsm_session']);
});

test('session user matching rejects deleted, changed, or stale users', () => {
  const payload = { userId: 7, username: 'admin', sessionVersion: 3 };
  assert.equal(sessionMatchesUser(payload, null), false);
  assert.equal(sessionMatchesUser(payload, { id: 8, username: 'admin', sessionVersion: 3 }), false);
  assert.equal(sessionMatchesUser(payload, { id: 7, username: 'renamed', sessionVersion: 3 }), false);
  assert.equal(sessionMatchesUser(payload, { id: 7, username: 'admin', sessionVersion: 4 }), false);
  assert.equal(sessionMatchesUser(payload, { id: 7, username: 'admin', sessionVersion: 3 }), true);
});

test('schema and handler guard persist and recheck session versions', () => {
  const schema = readFileSync(path.join(projectRoot, 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /sessionVersion\s+Int\s+@default\(1\)/);
  assert.match(schema, /failedLoginAttempts\s+Int\s+@default\(0\)/);
  assert.match(schema, /lockedUntil\s+DateTime\?/);

  const auth = readFileSync(path.join(projectRoot, 'src/lib/auth.ts'), 'utf8');
  assert.match(auth, /prisma\.user\.findUnique/);
  assert.match(auth, /sessionVersion/);
  assert.match(auth, /sessionMatchesUser/);
});
