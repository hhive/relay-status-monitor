import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiSession } from '@/lib/auth';
import { sealAlertChannelConfig, toSafeAlertChannel } from '@/lib/alert-channel-config';
import type { Prisma } from '@prisma/client';

/** 获取所有告警渠道 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const channels = await prisma.alertChannel.findMany({ orderBy: { id: 'asc' } });
  return NextResponse.json(channels.map(toSafeAlertChannel));
}

/** 新建告警渠道 */
export async function POST(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.type !== 'feishu' || typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: '渠道配置无效' }, { status: 400 });
    }
    let config;
    try {
      config = sealAlertChannelConfig(body.config);
    } catch {
      return NextResponse.json({ error: 'Webhook 配置无效' }, { status: 400 });
    }
    const channel = await prisma.alertChannel.create({
      data: {
        name: body.name.trim(),
        type: 'feishu',
        config: config as unknown as Prisma.InputJsonValue,
        enabled: body.enabled !== false,
      },
    });
    return NextResponse.json(toSafeAlertChannel(channel), { status: 201 });
  } catch {
    return NextResponse.json({ error: '创建渠道失败' }, { status: 500 });
  }
}
