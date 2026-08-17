import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  isOperationalAlertRuleKey,
  OperationalAlertValidationError,
  parseOperationalAlertRuleUpdate,
  toOperationalAlertRuleDto,
} from '@/lib/operational-alert-management';
import { parseStrictPositiveInteger } from '@/lib/security';

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = parseStrictPositiveInteger((await context.params).id);
  if (id === null) return NextResponse.json({ error: '规则 ID 无效' }, { status: 400 });
  try {
    const existing = await prisma.operationalAlertRule.findUnique({ where: { id } });
    if (!existing || !isOperationalAlertRuleKey(existing.key)) {
      return NextResponse.json({ error: '系统运维告警规则不存在' }, { status: 404 });
    }
    const update = parseOperationalAlertRuleUpdate(await request.json().catch(() => null));
    const rule = await prisma.operationalAlertRule.update({ where: { id }, data: update });
    return NextResponse.json(toOperationalAlertRuleDto(rule));
  } catch (error) {
    if (error instanceof OperationalAlertValidationError) {
      return NextResponse.json({ error: '系统运维告警规则参数无效' }, { status: 400 });
    }
    return NextResponse.json({ error: '更新系统运维告警规则失败' }, { status: 503 });
  }
}
