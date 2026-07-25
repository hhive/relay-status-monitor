import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';

async function accountId(context: { params: Promise<{ id: string }> }): Promise<number | null> {
  return parseStrictPositiveInteger((await context.params).id);
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = await accountId(context);
  if (id == null) return NextResponse.json({ error: '账号 ID 无效' }, { status: 400 });
  const rule = await prisma.accountAlertRule.findUnique({ where: { accountId_metric: { accountId: id, metric: 'upstream_rate_multiplier' } } });
  return NextResponse.json({ enabled: rule?.enabled ?? false, threshold: rule?.threshold ?? null });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = await accountId(context);
  if (id == null) return NextResponse.json({ error: '账号 ID 无效' }, { status: 400 });
  const body = await request.json().catch(() => null) as { threshold?: unknown; enabled?: unknown } | null;
  const threshold = Number(body?.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1000 || typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: '倍率告警参数无效' }, { status: 400 });
  }
  const exists = await prisma.sub2ApiAccount.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!exists) return NextResponse.json({ error: '账号不存在' }, { status: 404 });
  const rule = await prisma.accountAlertRule.upsert({
    where: { accountId_metric: { accountId: id, metric: 'upstream_rate_multiplier' } },
    create: { accountId: id, name: `账号 ${id} 上游倍率`, metric: 'upstream_rate_multiplier', operator: 'gt', threshold, minRequests: 0, cooldownMin: 30, enabled: body.enabled },
    update: { threshold, enabled: body.enabled },
  });
  return NextResponse.json({ enabled: rule.enabled, threshold: rule.threshold });
}
