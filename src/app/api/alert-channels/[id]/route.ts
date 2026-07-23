import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';
import { mergeAndSealAlertChannelConfig, toSafeAlertChannel } from '@/lib/alert-channel-config';
import type { Prisma } from '@prisma/client';

interface Params {
  params: Promise<{ id: string }>;
}

/** 更新告警渠道 */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '渠道 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const existing = await prisma.alertChannel.findUnique({ where: { id: numericId } });
    if (!existing) {
      return NextResponse.json({ error: '渠道不存在' }, { status: 404 });
    }
    const body = await request.json() as Record<string, unknown>;
    const data: Prisma.AlertChannelUpdateInput = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (body.config !== undefined) {
      try {
        data.config = mergeAndSealAlertChannelConfig(existing.config, body.config) as unknown as Prisma.InputJsonValue;
      } catch {
        return NextResponse.json({ error: 'Webhook 配置无效' }, { status: 400 });
      }
    }
    const channel = await prisma.alertChannel.update({
      where: { id: numericId },
      data,
    });
    return NextResponse.json(toSafeAlertChannel(channel));
  } catch {
    return NextResponse.json({ error: '更新渠道失败' }, { status: 500 });
  }
}

/** 删除告警渠道 */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '渠道 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    await prisma.alertChannel.delete({ where: { id: numericId } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: '删除渠道失败' }, { status: 500 });
  }
}
