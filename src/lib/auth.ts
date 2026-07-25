import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  ADMIN_SESSION_COOKIE_NAME,
  verifyAdminSession,
  type AdminApiSession,
} from '@/lib/admin-session-token';
import {
  SESSION_MAX_AGE,
  sessionMatchesUser,
  signSessionToken,
  verifySessionToken,
  type SessionPayload,
} from '@/lib/session-token';

/**
 * 会话与认证工具
 * 使用 jose（Edge 兼容）签发 JWT，存在 httpOnly cookie
 */

const COOKIE_NAME = 'rsm_session';
export type { SessionPayload } from '@/lib/session-token';

export interface LocalApiSession extends SessionPayload {
  source: 'local';
}

export type ApiSession = AdminApiSession | LocalApiSession;

type LocalSessionUser = {
  id: number;
  username: string;
  sessionVersion: number;
};

export async function resolveSessionFromTokens(
  adminToken: string | undefined,
  localToken: string | undefined,
  findLocalUser: (payload: SessionPayload) => Promise<LocalSessionUser | null>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ApiSession | null> {
  if (adminToken) {
    const adminSession = await verifyAdminSession(adminToken, environment);
    if (adminSession) return adminSession;
  }
  if (!localToken) return null;
  const payload = await verifySessionToken(localToken, environment);
  if (!payload) return null;
  const user = await findLocalUser(payload);
  return sessionMatchesUser(payload, user) ? { source: 'local', ...payload } : null;
}

/** 签发 JWT 并写入 cookie */
export async function createSession(user: SessionPayload): Promise<void> {
  const token = await signSessionToken(user);

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

/** 验证当前请求的会话，返回 payload 或 null */
export async function getSession(): Promise<ApiSession | null> {
  try {
    const store = await cookies();
    const adminToken = store.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    const token = store.get(COOKIE_NAME)?.value;
    return resolveSessionFromTokens(adminToken, token, (payload) => prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, sessionVersion: true },
    }));
  } catch {
    return null;
  }
}

export async function requireApiSession(): Promise<
  | { ok: true; session: ApiSession }
  | { ok: false; response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: '未登录' }, { status: 401 }),
    };
  }
  return { ok: true, session };
}

export async function requireLocalApiSession(
  sessionProvider: () => Promise<ApiSession | null> = getSession,
): Promise<
  | { ok: true; session: LocalApiSession }
  | { ok: false; response: NextResponse }
> {
  const session = await sessionProvider();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: '未登录' }, { status: 401 }),
    };
  }
  if (session.source !== 'local') {
    return {
      ok: false,
      response: NextResponse.json({ error: '禁止访问' }, { status: 403 }),
    };
  }
  return { ok: true, session };
}

/** 注销：删除 cookie */
type SessionCookieStore = {
  delete(name: string): unknown;
  set?(name: string, value: string, options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax';
    maxAge: number;
    path: '/';
  }): unknown;
};

export function clearSessionCookies(store: SessionCookieStore): void {
  if (store.set) {
    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 0,
      path: '/' as const,
    };
    store.set(ADMIN_SESSION_COOKIE_NAME, '', options);
    store.set(COOKIE_NAME, '', options);
    return;
  }
  store.delete(ADMIN_SESSION_COOKIE_NAME);
  store.delete(COOKIE_NAME);
}

export async function destroySession(): Promise<void> {
  clearSessionCookies(await cookies());
}

/** 校验密码（bcrypt） */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 哈希密码 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
