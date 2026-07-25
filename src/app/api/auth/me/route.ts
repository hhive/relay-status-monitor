import { NextResponse } from 'next/server';
import { requireApiSession, toMeResponseBody } from '@/lib/auth';

/** 获取当前登录用户 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return NextResponse.json(toMeResponseBody(auth.session));
}
