import { ACCOUNT_ALERT_RULE_SPECS, type AlertSeverity } from './account-observability/alert-management';
import {
  OPERATIONAL_ALERT_RULE_SPECS,
  type OperationalAlertRuleKey,
} from './operational-alert-management';
import { parseStrictPositiveInteger } from './security';

export type UnifiedAlertType = 'operational' | 'account';

const ALERT_TYPES = new Set(['all', 'operational', 'account']);
const STATUSES = new Set(['all', 'open', 'resolved']);
const SEVERITIES = new Set<AlertSeverity>(['INFO', 'WARNING', 'CRITICAL']);
const OPERATIONAL_RULE_KEYS = new Set<string>(OPERATIONAL_ALERT_RULE_SPECS.map(({ key }) => key));
const ACCOUNT_METRICS = new Set<string>([
  ...ACCOUNT_ALERT_RULE_SPECS.map(({ metric }) => metric),
  'upstream_rate_multiplier',
]);

export class UnifiedAlertValidationError extends Error {}

export function buildUnifiedAlertEventQuery(searchParams: URLSearchParams) {
  const type = searchParams.get('type') ?? 'all';
  const status = searchParams.get('status') ?? 'all';
  const severity = searchParams.get('severity');
  const account = searchParams.get('account');
  const rule = searchParams.get('rule');
  const metric = searchParams.get('metric');

  if (!ALERT_TYPES.has(type)) throw new UnifiedAlertValidationError('告警类型筛选无效');
  if (!STATUSES.has(status)) throw new UnifiedAlertValidationError('状态筛选无效');
  if (severity !== null && !SEVERITIES.has(severity as AlertSeverity)) {
    throw new UnifiedAlertValidationError('严重级别筛选无效');
  }
  if (rule !== null && !OPERATIONAL_RULE_KEYS.has(rule) && !ACCOUNT_METRICS.has(rule)) {
    throw new UnifiedAlertValidationError('规则筛选无效');
  }
  if (metric !== null && !ACCOUNT_METRICS.has(metric)) {
    throw new UnifiedAlertValidationError('指标筛选无效');
  }
  if (rule !== null && metric !== null) {
    throw new UnifiedAlertValidationError('规则与指标不能同时筛选');
  }
  const operationalRule = rule !== null && OPERATIONAL_RULE_KEYS.has(rule) ? rule : null;
  const accountMetric = metric ?? (rule !== null && ACCOUNT_METRICS.has(rule) ? rule : null);
  const sourceAccountId = account === null ? null : parseStrictPositiveInteger(account);
  if (account !== null && sourceAccountId === null) {
    throw new UnifiedAlertValidationError('账号筛选无效');
  }

  const pageValue = searchParams.get('page');
  const pageSizeValue = searchParams.get('pageSize');
  const page = pageValue === null ? 1 : parseStrictPositiveInteger(pageValue);
  const pageSize = pageSizeValue === null ? 50 : parseStrictPositiveInteger(pageSizeValue);
  if (page === null || pageSize === null || pageSize > 100) {
    throw new UnifiedAlertValidationError('分页参数无效');
  }

  const operationalWhere: {
    resolved?: boolean;
    severity?: AlertSeverity;
    rule?: { key: OperationalAlertRuleKey };
  } = {};
  const accountWhere: {
    resolved?: boolean;
    severity?: AlertSeverity;
    account?: { sourceAccountId: string };
    metric?: string;
  } = {};
  if (status !== 'all') {
    operationalWhere.resolved = status === 'resolved';
    accountWhere.resolved = status === 'resolved';
  }
  if (severity !== null) {
    operationalWhere.severity = severity as AlertSeverity;
    accountWhere.severity = severity as AlertSeverity;
  }
  if (operationalRule !== null) operationalWhere.rule = { key: operationalRule as OperationalAlertRuleKey };
  if (accountMetric !== null) accountWhere.metric = accountMetric;
  if (sourceAccountId !== null) accountWhere.account = { sourceAccountId: String(sourceAccountId) };

  return {
    sources: {
      operational: type !== 'account' && account === null && accountMetric === null,
      account: type !== 'operational' && operationalRule === null,
    },
    operationalWhere,
    accountWhere,
    page,
    pageSize,
    fetchTake: page * pageSize,
  };
}

interface UnifiedRule {
  id: number;
  key: string;
  name: string;
}

interface UnifiedAccount {
  id: number;
  sourceAccountId: string;
  name: string;
  platform: string | null;
}

export interface UnifiedAlertEventDto {
  id: number;
  type: UnifiedAlertType;
  occurredAt: Date;
  lastOccurredAt: Date;
  severity: AlertSeverity;
  resolved: boolean;
  resolvedAt: Date | null;
  rule: UnifiedRule;
  account: UnifiedAccount | null;
  metric: string | null;
  metricValue: number | null;
  subjectKey: string;
  subjectName: string;
  detail: string | null;
  recoveryDetail: string | null;
  occurrenceCount: number;
  canResolve: boolean;
}

interface OperationalEventInput {
  id: number;
  subjectKey: string;
  subjectName: string;
  detail: string;
  recoveryDetail?: string | null;
  severity: AlertSeverity;
  firstTriggeredAt: Date;
  lastFailedAt: Date;
  failureCount: number;
  resolved: boolean;
  resolvedAt: Date | null;
  rule: { id: number; key: string; name: string };
}

export function toUnifiedOperationalAlertEventDto<T extends OperationalEventInput>(event: T): UnifiedAlertEventDto {
  return {
    id: event.id,
    type: 'operational',
    occurredAt: event.firstTriggeredAt,
    lastOccurredAt: event.lastFailedAt,
    severity: event.severity,
    resolved: event.resolved,
    resolvedAt: event.resolvedAt,
    rule: event.rule,
    account: null,
    metric: null,
    metricValue: null,
    subjectKey: event.subjectKey,
    subjectName: event.subjectName,
    detail: event.detail,
    recoveryDetail: event.recoveryDetail ?? null,
    occurrenceCount: event.failureCount,
    canResolve: false,
  };
}

interface AccountEventInput {
  id: number;
  metric: string;
  severity: AlertSeverity;
  metricValue: number | null;
  message: string;
  resolved: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
  account: UnifiedAccount;
  rule: { id: number; name: string };
}

export function toUnifiedAccountAlertEventDto<T extends AccountEventInput>(event: T): UnifiedAlertEventDto {
  return {
    id: event.id,
    type: 'account',
    occurredAt: event.createdAt,
    lastOccurredAt: event.createdAt,
    severity: event.severity,
    resolved: event.resolved,
    resolvedAt: event.resolvedAt,
    rule: { ...event.rule, key: event.metric },
    account: event.account,
    metric: event.metric,
    metricValue: event.metricValue,
    subjectKey: event.account.sourceAccountId,
    subjectName: event.account.name,
    detail: event.message,
    recoveryDetail: null,
    occurrenceCount: 1,
    canResolve: !event.resolved,
  };
}

export function mergeUnifiedAlertEvents(
  operationalEvents: UnifiedAlertEventDto[],
  accountEvents: UnifiedAlertEventDto[],
  page: number,
  pageSize: number,
) {
  const offset = (page - 1) * pageSize;
  return [...operationalEvents, ...accountEvents]
    .sort((left, right) => {
      const timeDifference = right.occurredAt.getTime() - left.occurredAt.getTime();
      if (timeDifference !== 0) return timeDifference;
      if (left.type !== right.type) return left.type === 'operational' ? -1 : 1;
      return right.id - left.id;
    })
    .slice(offset, offset + pageSize);
}
