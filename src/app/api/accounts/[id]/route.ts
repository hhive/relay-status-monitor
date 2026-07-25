import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { getAccountDetail } from '@/lib/account-observability/query';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: '账号 ID 无效' }, { status: 400 });
  const account = await getAccountDetail(id);
  return account ? NextResponse.json(account) : NextResponse.json({ error: '账号不存在' }, { status: 404 });
}
