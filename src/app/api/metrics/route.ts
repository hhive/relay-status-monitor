import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

/**
 * 查询指标数据
 * GET /api/metrics?upstreamKeyId=1&hours=24
 * GET /api/metrics?upstreamId=1&days=7  (该上游所有 key 的数据)
 */
export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(request.url);
  const rawUpstreamKeyId = searchParams.get('upstreamKeyId');
  const rawUpstreamId = searchParams.get('upstreamId');
  const rawHours = searchParams.get('hours');
  const rawDays = searchParams.get('days');
  const rawLimit = searchParams.get('limit');

  const upstreamKeyId = rawUpstreamKeyId === null ? null : parseStrictPositiveInteger(rawUpstreamKeyId);
  const upstreamId = rawUpstreamId === null ? null : parseStrictPositiveInteger(rawUpstreamId);
  const hours = rawHours === null ? null : parseStrictPositiveInteger(rawHours);
  const days = rawDays === null ? null : parseStrictPositiveInteger(rawDays);
  const limit = rawLimit === null ? 2000 : parseStrictPositiveInteger(rawLimit);

  if (
    (rawUpstreamKeyId !== null && upstreamKeyId === null) ||
    (rawUpstreamId !== null && upstreamId === null) ||
    (rawHours !== null && hours === null) ||
    (rawDays !== null && days === null) ||
    limit === null
  ) {
    return NextResponse.json({ error: '数字查询参数无效' }, { status: 400 });
  }

  if (upstreamKeyId === null && upstreamId === null) {
    return NextResponse.json({ error: '缺少 upstreamKeyId 或 upstreamId 参数' }, { status: 400 });
  }

  let since: Date;
  if (days !== null) since = new Date(Date.now() - days * 86400000);
  else if (hours !== null) since = new Date(Date.now() - hours * 3600000);
  else since = new Date(Date.now() - 24 * 3600000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { recordedAt: { gte: since } };
  if (upstreamKeyId !== null) where.upstreamKeyId = upstreamKeyId;
  else if (upstreamId !== null) where.upstreamId = upstreamId;

  const metrics = await prisma.metric.findMany({
    where,
    orderBy: { recordedAt: 'asc' },
    take: limit,
  });

  return NextResponse.json(metrics);
}

/** 清理过期指标 */
export async function DELETE(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(request.url);
  const rawDays = searchParams.get('days');
  const days = rawDays === null ? 90 : parseStrictPositiveInteger(rawDays);
  if (days === null) {
    return NextResponse.json({ error: 'days 参数无效' }, { status: 400 });
  }
  const cutoff = new Date(Date.now() - days * 86400000);
  const result = await prisma.metric.deleteMany({ where: { recordedAt: { lt: cutoff } } });
  return NextResponse.json({ deleted: result.count });
}
