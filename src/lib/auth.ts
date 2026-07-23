import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
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
export async function getSession(): Promise<SessionPayload | null> {
  try {
    const store = await cookies();
    const token = store.get(COOKIE_NAME)?.value;
    if (!token) return null;
    const payload = await verifySessionToken(token);
    if (!payload) return null;
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, username: true, sessionVersion: true },
    });
    return sessionMatchesUser(payload, user) ? payload : null;
  } catch {
    return null;
  }
}

export async function requireApiSession(): Promise<
  | { ok: true; session: SessionPayload }
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

/** 注销：删除 cookie */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** 校验密码（bcrypt） */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 哈希密码 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
