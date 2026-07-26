import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import {
  AccountAlertValidationError,
  normalizeGlobalAccountAlertMetric,
  parseAccountAlertRuleUpdate,
  toAccountAlertRuleDto,
} from '@/lib/account-observability/alert-management';

type Context = { params: Promise<{ id: string }> };

async function updateRule(request: Request, context: Context) {
  const id = parseStrictPositiveInteger((await context.params).id);
  if (id === null) return NextResponse.json({ error: '规则 ID 无效' }, { status: 400 });
  try {
    const existing = await prisma.accountAlertRule.findFirst({ where: { id, accountId: null } });
    const metric = existing ? normalizeGlobalAccountAlertMetric(existing.metric) : null;
    if (!existing || !metric) {
      return NextResponse.json({ error: '账号告警规则不存在' }, { status: 404 });
    }
    const update = parseAccountAlertRuleUpdate(metric, await request.json().catch(() => null));
    const rule = await prisma.accountAlertRule.update({ where: { id }, data: update });
    return NextResponse.json(toAccountAlertRuleDto(rule));
  } catch (error) {
    if (error instanceof AccountAlertValidationError) {
      return NextResponse.json({ error: '账号告警规则参数无效' }, { status: 400 });
    }
    return NextResponse.json({ error: '更新账号告警规则失败' }, { status: 503 });
  }
}

export async function PUT(request: Request, context: Context) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return updateRule(request, context);
}

export async function PATCH(request: Request, context: Context) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return updateRule(request, context);
}
