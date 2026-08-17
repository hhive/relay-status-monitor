import { Prisma } from '@prisma/client';
import { sendOperationalNotification } from './alerts/channels/feishu';
import { prisma } from './db';
import {
  type OperationalAlertRuleKey,
  type OperationalAlertSeverity,
} from './operational-alert-management';
import { redactSensitiveText, safeErrorMessage } from './safe-error';

export interface OperationalAlertRuleRecord {
  id: number;
  key: OperationalAlertRuleKey;
  name: string;
  description: string;
  severity: OperationalAlertSeverity;
  enabled: boolean;
}

export interface OperationalNotificationDeliveries extends Prisma.JsonObject {
  trigger: number[];
  recovery: number[];
}

export interface OperationalAlertEventRecord {
  id: number;
  ruleId: number;
  subjectKey: string;
  subjectName: string;
  detail: string;
  recoveryDetail?: string | null;
  severity: OperationalAlertSeverity;
  firstTriggeredAt: Date;
  lastFailedAt: Date;
  failureCount: number;
  resolved: boolean;
  resolvedAt: Date | null;
  notificationDeliveries?: unknown;
}

interface RecordOperationalFailureInput {
  ruleId: number;
  severity: OperationalAlertSeverity;
  subjectKey: string;
  subjectName: string;
  detail: string;
  now: Date;
}

export interface OperationalAlertReporterDependencies {
  findRule: (key: OperationalAlertRuleKey) => Promise<OperationalAlertRuleRecord | null>;
  recordFailure: (input: RecordOperationalFailureInput) => Promise<{
    event: OperationalAlertEventRecord;
    created: boolean;
  }>;
  findOpenEvent: (ruleId: number, subjectKey: string) => Promise<OperationalAlertEventRecord | null>;
  resolveEvent: (id: number, now: Date, recoveryDetail: string | null) => Promise<OperationalAlertEventRecord | null>;
  updateNotificationDeliveries: (
    id: number,
    deliveries: OperationalNotificationDeliveries,
  ) => Promise<void>;
  notify: (
    event: OperationalAlertEventRecord,
    rule: OperationalAlertRuleRecord,
    recovery: boolean,
    deliveredChannelIds: readonly number[],
    onDelivered: (channelId: number) => Promise<void>,
  ) => Promise<void>;
}

function parseNotificationDeliveries(value: unknown): OperationalNotificationDeliveries {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const channelIds = (phase: unknown) => Array.isArray(phase)
    ? [...new Set(phase.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
    : [];
  return { trigger: channelIds(record.trigger), recovery: channelIds(record.recovery) };
}

function safeLabel(value: unknown, fallback: string, maxLength = 120): string {
  return redactSensitiveText(value, maxLength) || fallback;
}

async function notifyEvent(
  dependencies: OperationalAlertReporterDependencies,
  event: OperationalAlertEventRecord,
  rule: OperationalAlertRuleRecord,
  recovery: boolean,
): Promise<void> {
  if (event.severity !== 'CRITICAL') return;
  let deliveries = parseNotificationDeliveries(event.notificationDeliveries);
  const phase = recovery ? 'recovery' : 'trigger';
  await dependencies.notify(event, rule, recovery, deliveries[phase], async (channelId) => {
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || deliveries[phase].includes(channelId)) return;
    deliveries = { ...deliveries, [phase]: [...deliveries[phase], channelId] };
    await dependencies.updateNotificationDeliveries(event.id, deliveries);
    event.notificationDeliveries = deliveries;
  });
}

export function createOperationalAlertReporter(dependencies: OperationalAlertReporterDependencies) {
  return {
    failure: async (input: {
      ruleKey: OperationalAlertRuleKey;
      subjectKey: string;
      subjectName: string;
      detail: unknown;
      now?: Date;
    }) => {
      const rule = await dependencies.findRule(input.ruleKey);
      if (!rule?.enabled) return null;
      const result = await dependencies.recordFailure({
        ruleId: rule.id,
        severity: rule.severity,
        subjectKey: safeLabel(input.subjectKey, 'unknown'),
        subjectName: safeLabel(input.subjectName, '未知主题'),
        detail: redactSensitiveText(input.detail) || '操作失败',
        now: input.now ?? new Date(),
      });
      await notifyEvent(dependencies, result.event, rule, false);
      return result;
    },
    success: async (input: {
      ruleKey: OperationalAlertRuleKey;
      subjectKey: string;
      detail?: unknown;
      now?: Date;
    }) => {
      const rule = await dependencies.findRule(input.ruleKey);
      if (!rule) return null;
      const subjectKey = safeLabel(input.subjectKey, 'unknown');
      const open = await dependencies.findOpenEvent(rule.id, subjectKey);
      if (!open) return null;
      const detail = input.detail == null ? null : redactSensitiveText(input.detail) || null;
      await notifyEvent(dependencies, { ...open, recoveryDetail: detail }, rule, true);
      const resolved = await dependencies.resolveEvent(open.id, input.now ?? new Date(), detail);
      if (!resolved) return null;
      return resolved;
    },
  };
}

type FailureUpsertRow = OperationalAlertEventRecord & { created: boolean };

const productionReporter = createOperationalAlertReporter({
  findRule: async (key) => prisma.operationalAlertRule.findUnique({ where: { key } }) as Promise<OperationalAlertRuleRecord | null>,
  recordFailure: async (input) => {
    const deliveries = JSON.stringify({ trigger: [], recovery: [] });
    const [row] = await prisma.$queryRaw<FailureUpsertRow[]>(Prisma.sql`
      INSERT INTO "OperationalAlertEvent" (
        "ruleId", "subjectKey", "subjectName", "detail", "severity",
        "firstTriggeredAt", "lastFailedAt", "failureCount", "resolved", "notificationDeliveries"
      ) VALUES (
        ${input.ruleId}, ${input.subjectKey}, ${input.subjectName}, ${input.detail},
        ${input.severity}::"Severity", ${input.now}, ${input.now}, 1, false, ${deliveries}::jsonb
      )
      ON CONFLICT ("ruleId", "subjectKey") WHERE "resolved" = false
      DO UPDATE SET
        "subjectName" = EXCLUDED."subjectName",
        "detail" = EXCLUDED."detail",
        "lastFailedAt" = EXCLUDED."lastFailedAt",
        "failureCount" = "OperationalAlertEvent"."failureCount" + 1
      RETURNING *, (xmax = 0) AS "created"
    `);
    if (!row) throw new Error('运维告警事件保存失败');
    return { event: row, created: row.created };
  },
  findOpenEvent: async (ruleId, subjectKey) => prisma.operationalAlertEvent.findFirst({
    where: { ruleId, subjectKey, resolved: false },
  }) as Promise<OperationalAlertEventRecord | null>,
  resolveEvent: async (id, now, recoveryDetail) => {
    const update = await prisma.operationalAlertEvent.updateMany({
      where: { id, resolved: false },
      data: { resolved: true, resolvedAt: now, recoveryDetail },
    });
    if (update.count === 0) return null;
    return prisma.operationalAlertEvent.findUnique({ where: { id } }) as Promise<OperationalAlertEventRecord | null>;
  },
  updateNotificationDeliveries: async (id, notificationDeliveries) => {
    await prisma.operationalAlertEvent.update({
      where: { id },
      data: { notificationDeliveries: notificationDeliveries as Prisma.InputJsonValue },
    });
  },
  notify: (event, rule, recovery, deliveredChannelIds, onDelivered) =>
    sendOperationalNotification(event, rule, recovery, deliveredChannelIds, onDelivered),
});

/** Best-effort operational alert entry point. Monitoring must not break the operation it observes. */
export async function recordOperationalFailure(
  ruleKey: OperationalAlertRuleKey,
  subjectKey: string,
  subjectName: string,
  detail: unknown,
): Promise<void> {
  try {
    await productionReporter.failure({ ruleKey, subjectKey, subjectName, detail });
  } catch (error) {
    console.error('[运维告警] 记录失败:', safeErrorMessage(error));
  }
}

/** Resolve the matching open event, if any. This is intentionally best-effort. */
export async function recoverOperationalAlert(
  ruleKey: OperationalAlertRuleKey,
  subjectKey: string,
  detail?: unknown,
): Promise<void> {
  try {
    await productionReporter.success({ ruleKey, subjectKey, detail });
  } catch (error) {
    console.error('[运维告警] 恢复失败:', safeErrorMessage(error));
  }
}

export type AccountSchedulingActionType = 'PRIORITY_ADJUST' | 'PRIORITY_RESTORE' | 'PRIORITY_CAP_PAUSE';
export type AccountSchedulingActionResult = 'SUCCESS' | 'FAILURE' | 'SAFE_SKIP';

export interface AccountSchedulingActionInput {
  accountId?: number | null;
  sourceAccountId: string;
  accountName: string;
  actionType: AccountSchedulingActionType;
  result: AccountSchedulingActionResult;
  priorityBefore?: number | null;
  priorityAfter?: number | null;
  factor?: number | null;
  conflictRecomputed?: boolean;
  pausedUntil?: Date | null;
  reasonCode?: string | null;
  errorCode?: string | null;
  occurredAt?: Date;
}

function stableCode(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'unknown';
}

/** Persist one immutable scheduling attempt. Audit write failures never change scheduling behavior. */
export async function recordAccountSchedulingAction(input: AccountSchedulingActionInput): Promise<void> {
  try {
    await prisma.accountSchedulingActionRecord.create({
      data: {
        accountId: input.accountId ?? null,
        sourceAccountId: safeLabel(input.sourceAccountId, 'unknown'),
        accountName: safeLabel(input.accountName, '未知账号'),
        actionType: input.actionType,
        result: input.result,
        priorityBefore: input.priorityBefore ?? null,
        priorityAfter: input.priorityAfter ?? null,
        factor: input.factor ?? null,
        conflictRecomputed: input.conflictRecomputed ?? false,
        pausedUntil: input.pausedUntil ?? null,
        reasonCode: stableCode(input.reasonCode),
        errorCode: stableCode(input.errorCode),
        occurredAt: input.occurredAt ?? new Date(),
      },
    });
  } catch (error) {
    console.error('[调度审计] 记录失败:', safeErrorMessage(error));
  }
}
