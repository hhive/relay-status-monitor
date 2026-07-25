import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  AccountAlertValidationError,
  buildAccountAlertEventWhere,
  toAccountAlertEventDto,
} from '@/lib/account-observability/alert-management';

export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const where = buildAccountAlertEventWhere(new URL(request.url).searchParams);
    const events = await prisma.accountAlertEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        account: { select: { id: true, name: true, platform: true } },
        rule: { select: { id: true, name: true } },
      },
    });
    return NextResponse.json(events.map(toAccountAlertEventDto));
  } catch (error) {
    if (error instanceof AccountAlertValidationError) {
      return NextResponse.json({ error: '账号告警查询参数无效' }, { status: 400 });
    }
    return NextResponse.json({ error: '账号告警事件暂不可用' }, { status: 503 });
  }
}
