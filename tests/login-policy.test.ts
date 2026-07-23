import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LOCK_DURATION_MS,
  MAX_FAILED_LOGIN_ATTEMPTS,
  MIN_PASSWORD_CHARACTERS,
  isAccountLocked,
  lockUntilAfterFailure,
  passwordMeetsPolicy,
} from '../src/lib/login-policy';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('password policy requires at least 14 characters', () => {
  assert.equal(MIN_PASSWORD_CHARACTERS, 14);
  assert.equal(passwordMeetsPolicy('a'.repeat(13)), false);
  assert.equal(passwordMeetsPolicy('a'.repeat(14)), true);
  assert.equal(passwordMeetsPolicy('密'.repeat(14)), true);
  assert.equal(passwordMeetsPolicy(null), false);
});

test('the fifth consecutive failure locks the account for 15 minutes', () => {
  assert.equal(MAX_FAILED_LOGIN_ATTEMPTS, 5);
  assert.equal(LOCK_DURATION_MS, 15 * 60 * 1000);
  const now = new Date('2026-07-23T12:00:00.000Z');

  for (let attempts = 1; attempts < MAX_FAILED_LOGIN_ATTEMPTS; attempts += 1) {
    assert.equal(lockUntilAfterFailure(attempts, now), null);
  }
  assert.equal(
    lockUntilAfterFailure(MAX_FAILED_LOGIN_ATTEMPTS, now)?.toISOString(),
    '2026-07-23T12:15:00.000Z',
  );
});

test('account lock applies only while lockedUntil is in the future', () => {
  const now = new Date('2026-07-23T12:00:00.000Z');
  assert.equal(isAccountLocked(null, now), false);
  assert.equal(isAccountLocked(new Date('2026-07-23T11:59:59.999Z'), now), false);
  assert.equal(isAccountLocked(new Date('2026-07-23T12:00:00.001Z'), now), true);
});

test('login uses an atomic generic failure policy and clears failures on success', () => {
  const login = source('src/app/api/auth/login/route.ts');
  assert.match(login, /prisma\.\$transaction/);
  assert.match(login, /failedLoginAttempts:[\s\S]*?\{\s*increment:\s*1\s*\}/);
  assert.match(login, /failedLoginAttempts:\s*0/);
  assert.match(login, /lockedUntil:\s*null/);
  assert.match(login, /LOGIN_FAILURE_MESSAGE/);
  assert.doesNotMatch(login, /用户不存在|账号已锁定|登录失败:\s*['"]?\s*\+/);
});

test('password change rotates the session version and signs the replacement cookie', () => {
  const password = source('src/app/api/auth/password/route.ts');
  assert.match(password, /passwordMeetsPolicy\(/);
  assert.match(password, /prisma\.\$transaction/);
  assert.match(password, /sessionVersion:[\s\S]*?\{\s*increment:\s*1\s*\}/);
  assert.match(password, /createSession\(\{[\s\S]*sessionVersion:/);
  assert.doesNotMatch(password, /\.length\s*<\s*6/);
  assert.doesNotMatch(password, /修改失败:\s*['"]?\s*\+/);
});

test('seed paths enforce the same password policy and invalidate old sessions', () => {
  for (const seed of ['prisma/seed.ts', 'prisma/seed-demo.ts']) {
    const contents = source(seed);
    assert.match(contents, /assertPasswordPolicy\(/, seed);
    assert.match(contents, /sessionVersion:[\s\S]*?\{\s*increment:\s*1\s*\}/, seed);
    assert.match(contents, /failedLoginAttempts:\s*0/, seed);
    assert.match(contents, /lockedUntil:\s*null/, seed);
  }
});
