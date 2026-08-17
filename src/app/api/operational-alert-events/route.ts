import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  buildOperationalAlertEventQuery,
  OperationalAlertValidationError,
  toOperationalAlertEventDto,
} from '@/lib/operational-alert-management';

export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const { where, skip, take, page, pageSize } = buildOperationalAlertEventQuery(new URL(request.url).searchParams);
    const [events, total] = await Promise.all([
      prisma.operationalAlertEvent.findMany({
        where,
        orderBy: [{ lastFailedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        include: { rule: { select: { id: true, key: true, name: true } } },
      }),
      prisma.operationalAlertEvent.count({ where }),
    ]);
    return NextResponse.json({
      items: events.map(toOperationalAlertEventDto),
      page,
      pageSize,
      total,
    });
  } catch (error) {
    if (error instanceof OperationalAlertValidationError) {
      return NextResponse.json({ error: '系统运维告警查询参数无效' }, { status: 400 });
    }
    return NextResponse.json({ error: '系统运维告警记录暂不可用' }, { status: 503 });
  }
}
