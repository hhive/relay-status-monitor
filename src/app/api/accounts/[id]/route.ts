import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { getAccountDetail } from '@/lib/account-observability/query';
import { parseStrictPositiveInteger } from '@/lib/security';
import { AccountQueryValidationError, parseAccountWindow } from '@/lib/account-observability/window';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = parseStrictPositiveInteger((await context.params).id);
  if (id === null) return NextResponse.json({ error: '账号 ID 无效' }, { status: 400 });
  try {
    const account = await getAccountDetail(id, parseAccountWindow(new URL(request.url).searchParams.get('window')));
    return account ? NextResponse.json(account) : NextResponse.json({ error: '账号不存在' }, { status: 404 });
  } catch (error) {
    if (error instanceof AccountQueryValidationError) return NextResponse.json({ error: '账号查询参数无效' }, { status: 400 });
    return NextResponse.json({ error: '账号指标暂不可用' }, { status: 503 });
  }
}
