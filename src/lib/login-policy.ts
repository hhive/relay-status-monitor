export const MIN_PASSWORD_CHARACTERS = 14;
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export function passwordMeetsPolicy(password: unknown): password is string {
  return typeof password === 'string' && Array.from(password).length >= MIN_PASSWORD_CHARACTERS;
}

export function assertPasswordPolicy(password: unknown, name = '密码'): asserts password is string {
  if (!passwordMeetsPolicy(password)) {
    throw new Error(`${name}至少需要 ${MIN_PASSWORD_CHARACTERS} 个字符`);
  }
}

export function isAccountLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

export function lockUntilAfterFailure(
  failedLoginAttempts: number,
  now: Date,
): Date | null {
  return failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS
    ? new Date(now.getTime() + LOCK_DURATION_MS)
    : null;
}
