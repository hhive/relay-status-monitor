import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

/** 标记告警已解决 */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '事件 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json().catch(() => ({}));
    const resolved = body.resolved !== false;
    const incident = await prisma.incident.update({
      where: { id: numericId },
      data: { resolved, resolvedAt: resolved ? new Date() : null },
    });
    return NextResponse.json(incident);
  } catch {
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}
