import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  OPERATIONAL_ALERT_RULE_SPECS,
  toOperationalAlertRuleDto,
} from '@/lib/operational-alert-management';

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const rules = await prisma.operationalAlertRule.findMany({
      where: { key: { in: OPERATIONAL_ALERT_RULE_SPECS.map(({ key }) => key) } },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(rules.map(toOperationalAlertRuleDto));
  } catch {
    return NextResponse.json({ error: '系统运维告警规则暂不可用' }, { status: 503 });
  }
}
