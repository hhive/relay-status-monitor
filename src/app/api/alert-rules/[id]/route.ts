import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

/** 更新告警规则 */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '规则 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const rule = await prisma.alertRule.update({
      where: { id: numericId },
      data: body,
    });
    return NextResponse.json(rule);
  } catch {
    return NextResponse.json({ error: '更新失败' }, { status: 500 });
  }
}

/** 删除告警规则 */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '规则 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    await prisma.alertRule.delete({ where: { id: numericId } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: '删除失败' }, { status: 500 });
  }
}
