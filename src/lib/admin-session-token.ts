import { SignJWT, jwtVerify } from 'jose';
import type { NextResponse } from 'next/server';

import { resolveApplicationSecrets } from '@/lib/auth-config';
import { ADMIN_APP_ID, type AdminClaims } from '@/lib/admin-sso';

export const ADMIN_SESSION_COOKIE_NAME = 'rsm_admin_session';
export const ADMIN_SESSION_ISSUER = 'relay-status-monitor';
export const ADMIN_SESSION_AUDIENCE = 'upstream-monitor-admin';
export const ADMIN_SESSION_PURPOSE = 'admin_sso';
export const ADMIN_SESSION_DEFAULT_AGE = 3 * 24 * 60 * 60;
export const ADMIN_SESSION_MAX_AGE = 3 * 24 * 60 * 60;

type SecretEnvironment = Readonly<Record<string, string | undefined>>;

export interface AdminApiSession {
  source: 'sub2api';
  userId: number;
  username: string;
  email: string;
  csrfToken: string;
}

function validateTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > ADMIN_SESSION_MAX_AGE) {
    throw new Error('Admin session TTL invalid');
  }
}

export async function createAdminSession(
  claims: AdminClaims,
  ttlSeconds: number = ADMIN_SESSION_DEFAULT_AGE,
  environment: SecretEnvironment = process.env,
): Promise<string> {
  validateTtl(ttlSeconds);
  const { sessionSecret } = resolveApplicationSecrets(environment);
  return new SignJWT({
    userId: claims.user_id,
    email: claims.email,
    username: claims.username,
    role: claims.role,
    appId: claims.app_id,
    purpose: ADMIN_SESSION_PURPOSE,
    csrfToken: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ADMIN_SESSION_ISSUER)
    .setAudience(ADMIN_SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(sessionSecret);
}

export async function verifyAdminSession(
  token: string,
  environment: SecretEnvironment = process.env,
): Promise<AdminApiSession | null> {
  try {
    const { sessionSecret } = resolveApplicationSecrets(environment);
    const { payload } = await jwtVerify(token, sessionSecret, {
      algorithms: ['HS256'],
      issuer: ADMIN_SESSION_ISSUER,
      audience: ADMIN_SESSION_AUDIENCE,
    });
    if (
      payload.purpose !== ADMIN_SESSION_PURPOSE ||
      payload.role !== 'admin' ||
      payload.appId !== ADMIN_APP_ID ||
      !Number.isSafeInteger(payload.userId) ||
      (payload.userId as number) <= 0 ||
      typeof payload.email !== 'string' ||
      payload.email.length === 0 ||
      typeof payload.username !== 'string' ||
      payload.username.length === 0 ||
      typeof payload.csrfToken !== 'string' ||
      payload.csrfToken.length < 32 ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > ADMIN_SESSION_MAX_AGE
    ) {
      return null;
    }
    return {
      source: 'sub2api',
      userId: payload.userId as number,
      username: payload.username,
      email: payload.email,
      csrfToken: payload.csrfToken,
    };
  } catch {
    return null;
  }
}

export function attachAdminSession(
  response: NextResponse,
  token: string,
  ttlSeconds: number,
  nodeEnvironment: string | undefined = process.env.NODE_ENV,
): void {
  validateTtl(ttlSeconds);
  response.cookies.set(ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: nodeEnvironment === 'production',
    sameSite: 'lax',
    maxAge: ttlSeconds,
    path: '/',
  });
}
