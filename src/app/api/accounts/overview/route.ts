import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { parseAccountFilters } from '@/lib/account-observability/filters';
import { getAccountOverview } from '@/lib/account-observability/query';
import { AccountQueryValidationError, parseAccountWindow } from '@/lib/account-observability/window';

export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    return NextResponse.json(await getAccountOverview(parseAccountWindow(params.get('window')), parseAccountFilters(params)));
  } catch (error) {
    if (error instanceof AccountQueryValidationError) {
      return NextResponse.json({ error: '账号查询参数无效' }, { status: 400 });
    }
    return NextResponse.json({ error: '账号指标暂不可用' }, { status: 503 });
  }
}
