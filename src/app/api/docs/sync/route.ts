import { NextResponse } from 'next/server';
import { isDocsAdminSession, requestDocsSync } from '@/lib/docs-management';
import { requireApiSession } from '@/lib/auth';

export async function POST() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  return NextResponse.json(requestDocsSync(), { status: 202 });
}
