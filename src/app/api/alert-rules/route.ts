import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiSession } from '@/lib/auth';

/** 获取所有告警规则 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const rules = await prisma.alertRule.findMany({ orderBy: { id: 'asc' } });
  return NextResponse.json(rules);
}

/** 新建告警规则 */
export async function POST(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const rule = await prisma.alertRule.create({ data: body });
    return NextResponse.json(rule, { status: 201 });
  } catch {
    return NextResponse.json({ error: '创建失败' }, { status: 500 });
  }
}
