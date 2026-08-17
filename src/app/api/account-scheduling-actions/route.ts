import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  buildAccountSchedulingActionQuery,
  OperationalAlertValidationError,
  toAccountSchedulingActionDto,
} from '@/lib/operational-alert-management';

export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const { where, skip, take, page, pageSize } = buildAccountSchedulingActionQuery(new URL(request.url).searchParams);
    const [records, total] = await Promise.all([
      prisma.accountSchedulingActionRecord.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      prisma.accountSchedulingActionRecord.count({ where }),
    ]);
    return NextResponse.json({
      items: records.map(toAccountSchedulingActionDto),
      page,
      pageSize,
      total,
    });
  } catch (error) {
    if (error instanceof OperationalAlertValidationError) {
      return NextResponse.json({ error: '调度操作记录查询参数无效' }, { status: 400 });
    }
    return NextResponse.json({ error: '调度操作记录暂不可用' }, { status: 503 });
  }
}
