import { SignJWT, jwtVerify } from 'jose';

import { resolveApplicationSecrets } from '@/lib/auth-config';

export const SESSION_ISSUER = 'relay-status-monitor';
export const SESSION_AUDIENCE = 'relay-status-monitor-web';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

type SecretEnvironment = Readonly<Record<string, string | undefined>>;

export interface SessionPayload {
  userId: number;
  username: string;
  sessionVersion: number;
}

export interface SessionUser {
  id: number;
  username: string;
  sessionVersion: number;
}

export async function signSessionToken(
  payload: SessionPayload,
  environment: SecretEnvironment = process.env,
): Promise<string> {
  const { sessionSecret } = resolveApplicationSecrets(environment);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(sessionSecret);
}

export async function verifySessionToken(
  token: string,
  environment: SecretEnvironment = process.env,
): Promise<SessionPayload | null> {
  try {
    const { sessionSecret } = resolveApplicationSecrets(environment);
    const { payload } = await jwtVerify(token, sessionSecret, {
      algorithms: ['HS256'],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });

    if (
      !Number.isSafeInteger(payload.userId) ||
      (payload.userId as number) <= 0 ||
      typeof payload.username !== 'string' ||
      payload.username.length === 0 ||
      !Number.isSafeInteger(payload.sessionVersion) ||
      (payload.sessionVersion as number) <= 0 ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }

    return {
      userId: payload.userId as number,
      username: payload.username,
      sessionVersion: payload.sessionVersion as number,
    };
  } catch {
    return null;
  }
}

export function sessionMatchesUser(
  payload: SessionPayload,
  user: SessionUser | null,
): boolean {
  return Boolean(
    user &&
    user.id === payload.userId &&
    user.username === payload.username &&
    user.sessionVersion === payload.sessionVersion,
  );
}
