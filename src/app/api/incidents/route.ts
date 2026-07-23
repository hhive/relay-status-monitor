import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

/**
 * 告警事件列表
 * GET /api/incidents?resolved=false&upstreamId=1&keyId=2&limit=50
 */
export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(request.url);
  const resolvedParam = searchParams.get('resolved');
  const rawLimit = searchParams.get('limit');
  const rawUpstreamId = searchParams.get('upstreamId');
  const rawKeyId = searchParams.get('keyId') ?? searchParams.get('upstreamKeyId');
  const limit = rawLimit === null ? 50 : parseStrictPositiveInteger(rawLimit);
  const upstreamId = rawUpstreamId === null ? null : parseStrictPositiveInteger(rawUpstreamId);
  const keyId = rawKeyId === null ? null : parseStrictPositiveInteger(rawKeyId);

  if (
    limit === null ||
    (rawUpstreamId !== null && upstreamId === null) ||
    (rawKeyId !== null && keyId === null)
  ) {
    return NextResponse.json({ error: '数字查询参数无效' }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};
  if (resolvedParam === 'false') where.resolved = false;
  else if (resolvedParam === 'true') where.resolved = true;
  if (upstreamId !== null) where.upstreamId = upstreamId;
  if (keyId !== null) where.upstreamKeyId = keyId;

  const incidents = await prisma.incident.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      upstream: { select: { id: true, name: true, baseUrl: true } },
      upstreamKey: { select: { id: true, group: true } },
    },
  });

  return NextResponse.json(incidents);
}
