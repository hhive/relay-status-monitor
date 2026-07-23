import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiSession } from '@/lib/auth';

/** 获取所有告警渠道 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const channels = await prisma.alertChannel.findMany({ orderBy: { id: 'asc' } });
  return NextResponse.json(channels);
}

/** 新建告警渠道 */
export async function POST(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const channel = await prisma.alertChannel.create({ data: body });
    return NextResponse.json(channel, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: '创建失败: ' + (e as Error).message }, { status: 500 });
  }
}
