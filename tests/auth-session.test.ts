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
import { resolveApplicationSecrets } from '../src/lib/auth-config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validEnvironment = {
  SESSION_SECRET: 's'.repeat(32),
  APP_ENCRYPTION_KEY: 'e'.repeat(32),
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
