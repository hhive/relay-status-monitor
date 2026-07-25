import { NextResponse } from 'next/server';
import { requireApiSession, type ApiSession } from '@/lib/auth';

export function toMeResponseBody(session: ApiSession) {
  if (session.source === 'sub2api') {
    return {
      ok: true,
      username: session.username,
      userId: session.userId,
      source: session.source,
      csrfToken: session.csrfToken,
    };
  }
  return {
    ok: true,
    username: session.username,
    userId: session.userId,
    source: session.source,
  };
}

/** 获取当前登录用户 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return NextResponse.json(toMeResponseBody(auth.session));
}
