import { parseStrictPositiveInteger } from './security';

export const OPERATIONAL_ALERT_RULE_SPECS = [
  {
    key: 'collection_failed',
    name: '采集失败',
    description: '完整采集周期执行失败',
    severity: 'CRITICAL',
    enabled: true,
  },
  {
    key: 'priority_adjustment_failed',
    name: '优先级调整失败',
    description: 'Sub2API 账号优先级调整或恢复失败',
    severity: 'CRITICAL',
    enabled: true,
  },
  {
    key: 'priority_cap_pause_failed',
    name: '暂停账号失败',
    description: '优先级封顶后的账号临时暂停失败',
    severity: 'CRITICAL',
    enabled: true,
  },
  {
    key: 'remote_backup_failed',
    name: '远程备份失败',
    description: '已启用且到期的远程备份执行失败',
    severity: 'CRITICAL',
    enabled: true,
  },
] as const;

export type OperationalAlertRuleKey = typeof OPERATIONAL_ALERT_RULE_SPECS[number]['key'];
export type OperationalAlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

const RULE_KEYS = new Set<OperationalAlertRuleKey>(OPERATIONAL_ALERT_RULE_SPECS.map(({ key }) => key));
const SEVERITIES = new Set<OperationalAlertSeverity>(['INFO', 'WARNING', 'CRITICAL']);
const RULE_UPDATE_FIELDS = new Set(['enabled', 'severity']);
const ACTION_TYPES = new Set(['PRIORITY_ADJUST', 'PRIORITY_RESTORE', 'PRIORITY_CAP_PAUSE'] as const);
const ACTION_RESULTS = new Set(['SUCCESS', 'FAILURE', 'SAFE_SKIP'] as const);

export class OperationalAlertValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isOperationalAlertRuleKey(value: string): value is OperationalAlertRuleKey {
  return RULE_KEYS.has(value as OperationalAlertRuleKey);
}

export interface OperationalAlertRuleUpdate {
  enabled?: boolean;
  severity?: OperationalAlertSeverity;
}

export function parseOperationalAlertRuleUpdate(body: unknown): OperationalAlertRuleUpdate {
  if (!isRecord(body)) throw new OperationalAlertValidationError('规则参数无效');
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !RULE_UPDATE_FIELDS.has(key))) {
    throw new OperationalAlertValidationError('包含不允许修改的规则字段');
  }
  const update: OperationalAlertRuleUpdate = {};
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw new OperationalAlertValidationError('启停状态无效');
    update.enabled = body.enabled;
  }
  if ('severity' in body) {
    if (typeof body.severity !== 'string' || !SEVERITIES.has(body.severity as OperationalAlertSeverity)) {
      throw new OperationalAlertValidationError('严重级别无效');
    }
    update.severity = body.severity as OperationalAlertSeverity;
  }
  return update;
}

interface OperationalAlertRuleDtoInput {
  id: number;
  key: string;
  name: string;
  description: string;
  severity: OperationalAlertSeverity;
  enabled: boolean;
}

export function toOperationalAlertRuleDto<T extends OperationalAlertRuleDtoInput>(rule: T) {
  return {
    id: rule.id,
    key: rule.key,
    name: rule.name,
    description: rule.description,
    severity: rule.severity,
    enabled: rule.enabled,
  };
}

export function buildOperationalAlertEventQuery(searchParams: URLSearchParams) {
  const where: {
    resolved?: boolean;
    severity?: OperationalAlertSeverity;
    rule?: { key: OperationalAlertRuleKey };
  } = {};
  const status = searchParams.get('status');
  const rule = searchParams.get('rule');
  const severity = searchParams.get('severity');
  if (status !== null) {
    if (status !== 'open' && status !== 'resolved') throw new OperationalAlertValidationError('状态筛选无效');
    where.resolved = status === 'resolved';
  }
  if (rule !== null) {
    if (!isOperationalAlertRuleKey(rule)) throw new OperationalAlertValidationError('规则筛选无效');
    where.rule = { key: rule };
  }
  if (severity !== null) {
    if (!SEVERITIES.has(severity as OperationalAlertSeverity)) {
      throw new OperationalAlertValidationError('严重级别筛选无效');
    }
    where.severity = severity as OperationalAlertSeverity;
  }

  const pageValue = searchParams.get('page');
  const pageSizeValue = searchParams.get('pageSize');
  const page = pageValue === null ? 1 : parseStrictPositiveInteger(pageValue);
  const pageSize = pageSizeValue === null ? 50 : parseStrictPositiveInteger(pageSizeValue);
  if (page === null || pageSize === null || pageSize > 100) {
    throw new OperationalAlertValidationError('分页参数无效');
  }
  return { where, skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

export type SchedulingActionType = 'PRIORITY_ADJUST' | 'PRIORITY_RESTORE' | 'PRIORITY_CAP_PAUSE';
export type SchedulingActionResult = 'SUCCESS' | 'FAILURE' | 'SAFE_SKIP';

export function buildAccountSchedulingActionQuery(searchParams: URLSearchParams) {
  const where: {
    sourceAccountId?: string;
    actionType?: SchedulingActionType;
    result?: SchedulingActionResult;
  } = {};
  const account = searchParams.get('account');
  const actionType = searchParams.get('actionType');
  const result = searchParams.get('result');
  if (account !== null) {
    const accountId = parseStrictPositiveInteger(account);
    if (accountId === null) throw new OperationalAlertValidationError('账号筛选无效');
    where.sourceAccountId = String(accountId);
  }
  if (actionType !== null) {
    if (!ACTION_TYPES.has(actionType as SchedulingActionType)) {
      throw new OperationalAlertValidationError('操作类型筛选无效');
    }
    where.actionType = actionType as SchedulingActionType;
  }
  if (result !== null) {
    if (!ACTION_RESULTS.has(result as SchedulingActionResult)) {
      throw new OperationalAlertValidationError('操作结果筛选无效');
    }
    where.result = result as SchedulingActionResult;
  }
  const pageValue = searchParams.get('page');
  const pageSizeValue = searchParams.get('pageSize');
  const page = pageValue === null ? 1 : parseStrictPositiveInteger(pageValue);
  const pageSize = pageSizeValue === null ? 50 : parseStrictPositiveInteger(pageSizeValue);
  if (page === null || pageSize === null || pageSize > 100) {
    throw new OperationalAlertValidationError('分页参数无效');
  }
  return { where, skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

interface AccountSchedulingActionDtoInput {
  id: number;
  accountId: number | null;
  sourceAccountId: string;
  accountName: string;
  actionType: SchedulingActionType;
  result: SchedulingActionResult;
  priorityBefore: number | null;
  priorityAfter: number | null;
  factor: number | null;
  conflictRecomputed: boolean;
  pausedUntil: Date | null;
  reasonCode: string | null;
  errorCode: string | null;
  occurredAt: Date;
  account?: { name: string } | null;
}

export function toAccountSchedulingActionDto<T extends AccountSchedulingActionDtoInput>(record: T) {
  return {
    id: record.id,
    accountId: record.accountId,
    sourceAccountId: record.sourceAccountId,
    accountName: record.account?.name ?? record.accountName,
    actionType: record.actionType,
    result: record.result,
    priorityBefore: record.priorityBefore,
    priorityAfter: record.priorityAfter,
    factor: record.factor,
    conflictRecomputed: record.conflictRecomputed,
    pausedUntil: record.pausedUntil,
    reasonCode: record.reasonCode,
    errorCode: record.errorCode,
    occurredAt: record.occurredAt,
  };
}

interface OperationalAlertEventDtoInput {
  id: number;
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
  rule: { id: number; key: string; name: string };
}

export function toOperationalAlertEventDto<T extends OperationalAlertEventDtoInput>(event: T) {
  return {
    id: event.id,
    subjectKey: event.subjectKey,
    subjectName: event.subjectName,
    detail: event.detail,
    recoveryDetail: event.recoveryDetail ?? null,
    severity: event.severity,
    firstTriggeredAt: event.firstTriggeredAt,
    lastFailedAt: event.lastFailedAt,
    failureCount: event.failureCount,
    resolved: event.resolved,
    resolvedAt: event.resolvedAt,
    rule: event.rule,
  };
}
