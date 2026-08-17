import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  buildUnifiedAlertEventQuery,
  mergeUnifiedAlertEvents,
  toUnifiedAccountAlertEventDto,
  toUnifiedOperationalAlertEventDto,
  UnifiedAlertValidationError,
} from '@/lib/unified-alert-management';

export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;

  try {
    const query = buildUnifiedAlertEventQuery(new URL(request.url).searchParams);
    const [operationalEvents, operationalTotal, accountEvents, accountTotal] = await Promise.all([
      query.sources.operational
        ? prisma.operationalAlertEvent.findMany({
            where: query.operationalWhere,
            orderBy: [{ firstTriggeredAt: 'desc' }, { id: 'desc' }],
            take: query.fetchTake,
            include: { rule: { select: { id: true, key: true, name: true } } },
          })
        : Promise.resolve([]),
      query.sources.operational
        ? prisma.operationalAlertEvent.count({ where: query.operationalWhere })
        : Promise.resolve(0),
      query.sources.account
        ? prisma.accountAlertEvent.findMany({
            where: query.accountWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: query.fetchTake,
            include: {
              account: { select: { id: true, sourceAccountId: true, name: true, platform: true } },
              rule: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
      query.sources.account
        ? prisma.accountAlertEvent.count({ where: query.accountWhere })
        : Promise.resolve(0),
    ]);

    return NextResponse.json({
      items: mergeUnifiedAlertEvents(
        operationalEvents.map(toUnifiedOperationalAlertEventDto),
        accountEvents.map(toUnifiedAccountAlertEventDto),
        query.page,
        query.pageSize,
      ),
      page: query.page,
      pageSize: query.pageSize,
      total: operationalTotal + accountTotal,
    });
  } catch (error) {
    if (error instanceof UnifiedAlertValidationError) {
      return NextResponse.json({ error: '告警记录查询参数无效' }, { status: 400 });
    }
    return NextResponse.json({ error: '告警记录暂不可用' }, { status: 503 });
  }
}
