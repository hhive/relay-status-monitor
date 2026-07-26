import { NextResponse } from 'next/server';

import { requireApiSession } from '@/lib/auth';
import {
  AccountSnapshotUnavailableError,
  getAccountList,
  parseAccountListQuery,
} from '@/lib/account-observability/account-list-query';
import { AccountQueryValidationError } from '@/lib/account-observability/window';

export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await getAccountList(parseAccountListQuery(new URL(request.url).searchParams)));
  } catch (error) {
    if (error instanceof AccountQueryValidationError) {
      return NextResponse.json({ error: '账号查询参数无效' }, { status: 400 });
    }
    if (error instanceof AccountSnapshotUnavailableError) {
      return NextResponse.json({ error: '账号指标快照暂不可用' }, { status: 503 });
    }
    return NextResponse.json({ error: '账号列表暂不可用' }, { status: 503 });
  }
}
