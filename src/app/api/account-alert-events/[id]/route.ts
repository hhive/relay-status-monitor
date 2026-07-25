import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import { toAccountAlertEventDto } from '@/lib/account-observability/alert-management';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = parseStrictPositiveInteger((await context.params).id);
  if (id === null) return NextResponse.json({ error: '事件 ID 无效' }, { status: 400 });
  const body = await request.json().catch(() => null) as unknown;
  if (
    body === null || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).length !== 1 || typeof (body as { resolved?: unknown }).resolved !== 'boolean'
  ) {
    return NextResponse.json({ error: '事件更新参数无效' }, { status: 400 });
  }
  const resolved = (body as { resolved: boolean }).resolved;
  try {
    const event = await prisma.accountAlertEvent.update({
      where: { id },
      data: { resolved, resolvedAt: resolved ? new Date() : null },
      include: {
        account: { select: { id: true, name: true, platform: true } },
        rule: { select: { id: true, name: true } },
      },
    });
    return NextResponse.json(toAccountAlertEventDto(event));
  } catch {
    return NextResponse.json({ error: '更新账号告警事件失败' }, { status: 503 });
  }
}
