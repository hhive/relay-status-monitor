import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { listAccountSummaries } from '@/lib/account-observability/query';

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try { return NextResponse.json({ items: await listAccountSummaries() }); }
  catch { return NextResponse.json({ error: '账号指标暂不可用' }, { status: 503 }); }
}
