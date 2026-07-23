/**
 * 告警引擎（多分组版）：按 UpstreamKey 维度评估告警规则
 */
import type { AlertRule, IncidentType, Upstream, UpstreamKey } from '@prisma/client';
import { prisma } from '../db';
import { sendNotification } from './channels/feishu';
import { safeErrorMessage } from '../safe-error';

interface EvalResult {
  rule: AlertRule;
  triggered: boolean;
  currentValue: number | null;
  incidentType: IncidentType;
  message: string;
}

type KeyWithContext = UpstreamKey & { upstream: Upstream };

/** 对单个 key 评估所有启用的告警规则 */
export async function evaluateAlerts(upstreamKeyId: number): Promise<void> {
  const key = await prisma.upstreamKey.findUnique({
    where: { id: upstreamKeyId },
    include: { upstream: true },
  });
  if (!key) return;

  const rules = await prisma.alertRule.findMany({ where: { enabled: true } });
  if (rules.length === 0) return;

  const evaluations: EvalResult[] = [];
  for (const rule of rules) {
    evaluations.push(await evaluateRule(rule, key));
  }

  for (const e of evaluations) {
    if (!e.triggered) continue;

    // 冷却检查
    const cooldownWindow = new Date(Date.now() - e.rule.cooldownMin * 60 * 1000);
    const existing = await prisma.incident.findFirst({
      where: { upstreamKeyId, type: e.incidentType, createdAt: { gt: cooldownWindow } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) continue;

    const incident = await prisma.incident.create({
      data: {
        upstreamId: key.upstreamId,
        upstreamKeyId: key.id,
        type: e.incidentType,
        severity: e.rule.severity,
        message: e.message,
        metricValue: e.currentValue,
      },
    });

    void sendNotification(incident, key.upstream, key, false).catch((err) => {
      console.error(`[告警] 发送通知失败 (incident ${incident.id}):`, safeErrorMessage(err));
    });
  }

  // 自动恢复
  await autoResolveIncidents(key);
}

async function evaluateRule(rule: AlertRule, key: KeyWithContext): Promise<EvalResult> {
  const base: EvalResult = { rule, triggered: false, currentValue: null, incidentType: 'BALANCE_LOW', message: '' };
  const display = `${key.upstream.name} / ${key.group}`;

  switch (rule.metric) {
    case 'balance': {
      const value = key.lastBalance;
      if (value === null) return base;
      const triggered = rule.operator === 'lt' ? value < rule.threshold : value > rule.threshold;
      return { ...base, triggered, currentValue: value, incidentType: 'BALANCE_LOW',
        message: `[${display}] 余额 $${value.toFixed(2)} ${rule.operator === 'lt' ? '低于' : '高于'} 阈值 $${rule.threshold}` };
    }
    case 'latency': {
      const value = key.lastLatencyMs;
      if (value === null) return base;
      const triggered = rule.operator === 'gt' ? value > rule.threshold : value < rule.threshold;
      return { ...base, triggered, currentValue: value, incidentType: 'LATENCY_HIGH',
        message: `[${display}] 延迟 ${value}ms ${rule.operator === 'gt' ? '高于' : '低于'} 阈值 ${rule.threshold}ms` };
    }
    case 'consecutive_failures': {
      const recent = await prisma.metric.findMany({
        where: { upstreamKeyId: key.id },
        orderBy: { recordedAt: 'desc' },
        take: Math.ceil(rule.threshold) + 2,
      });
      let failures = 0;
      for (const m of recent) { if (!m.success) failures++; else break; }
      const triggered = failures >= rule.threshold;
      return { ...base, triggered, currentValue: failures, incidentType: 'UNAVAILABLE',
        message: `[${display}] 连续 ${failures} 次采集失败` };
    }
    case 'availability': {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const total = await prisma.metric.count({ where: { upstreamKeyId: key.id, recordedAt: { gt: oneHourAgo } } });
      if (total === 0) return base;
      const ok = await prisma.metric.count({ where: { upstreamKeyId: key.id, recordedAt: { gt: oneHourAgo }, success: true } });
      const availability = (ok / total) * 100;
      const triggered = availability < rule.threshold;
      return { ...base, triggered, currentValue: availability, incidentType: 'AVAILABILITY_LOW',
        message: `[${display}] 最近1小时可用率 ${availability.toFixed(1)}% 低于阈值 ${rule.threshold}%` };
    }
    default:
      return base;
  }
}

async function autoResolveIncidents(key: KeyWithContext): Promise<void> {
  if (key.status !== 'ONLINE') return;
  const open = await prisma.incident.findMany({ where: { upstreamKeyId: key.id, resolved: false } });
  for (const inc of open) {
    await prisma.incident.update({ where: { id: inc.id }, data: { resolved: true, resolvedAt: new Date() } });
    void sendNotification(
      { id: inc.id, upstreamId: key.upstreamId, upstreamKeyId: key.id, type: inc.type, severity: 'INFO', message: `[已恢复] ${inc.message}`, metricValue: inc.metricValue },
      key.upstream, key, true
    ).catch(() => {});
  }
}
