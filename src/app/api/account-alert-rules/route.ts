import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ACCOUNT_ALERT_RULE_SPECS, toAccountAlertRuleDto } from '@/lib/account-observability/alert-management';

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const rules = await prisma.accountAlertRule.findMany({
      where: { accountId: null, metric: { in: ACCOUNT_ALERT_RULE_SPECS.map(({ metric }) => metric) } },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(rules.map(toAccountAlertRuleDto));
  } catch {
    return NextResponse.json({ error: '账号告警规则暂不可用' }, { status: 503 });
  }
}
