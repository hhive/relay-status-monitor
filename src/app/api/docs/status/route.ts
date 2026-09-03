import { NextResponse } from 'next/server';
import { getDocsSyncState, isDocsAdminSession } from '@/lib/docs-management';
import { requireApiSession } from '@/lib/auth';

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  return NextResponse.json(getDocsSyncState());
}
