import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';

/** 获取当前登录用户 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const session = auth.session;
  return NextResponse.json({ ok: true, username: session.username, userId: session.userId });
}
