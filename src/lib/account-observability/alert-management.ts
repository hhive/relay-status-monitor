import { parseStrictPositiveInteger } from '../security';

export const ACCOUNT_ALERT_RULE_SPECS = [
  { metric: 'availability_low', name: '账号可用率低', operators: ['lt', 'lte'], threshold: [0, 1], samples: true },
  { metric: 'error_rate_high', name: '账号错误率高', operators: ['gt', 'gte'], threshold: [0, 1], samples: true },
  { metric: 'duration_p95_high', name: '账号总延迟P95高', operators: ['gt', 'gte'], threshold: [0, 3_600_000], samples: true },
  { metric: 'first_token_p95_high', name: '账号首TokenP95高', operators: ['gt', 'gte'], threshold: [0, 3_600_000], samples: true },
  { metric: 'cache_hit_low', name: '账号缓存命中率低', operators: ['lt', 'lte'], threshold: [0, 1], samples: true, promptTokens: true },
  { metric: 'unschedulable', name: '账号持续不可调度', operators: ['eq'], threshold: [1, 1], samples: false },
  { metric: 'sync_stale', name: '账号同步陈旧', operators: ['gt', 'gte'], threshold: [0, 10_080], samples: false },
] as const;

export type GlobalAccountAlertMetric = typeof ACCOUNT_ALERT_RULE_SPECS[number]['metric'];
export type AccountAlertEventMetric = GlobalAccountAlertMetric | 'upstream_rate_multiplier';
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

const LEGACY_GLOBAL_ACCOUNT_ALERT_METRICS = {
  availability: 'availability_low',
  error_rate: 'error_rate_high',
  duration_p95: 'duration_p95_high',
  first_token_p95: 'first_token_p95_high',
  cache_hit_rate: 'cache_hit_low',
} as const satisfies Record<string, GlobalAccountAlertMetric>;

export const ACCOUNT_ALERT_RULE_STORAGE_METRICS = [
  ...ACCOUNT_ALERT_RULE_SPECS.map(({ metric }) => metric),
  ...Object.keys(LEGACY_GLOBAL_ACCOUNT_ALERT_METRICS),
];

const RULE_UPDATE_FIELDS = new Set([
  'operator', 'threshold', 'severity', 'minRequests', 'minPromptTokens', 'cooldownMin', 'enabled',
]);
const EVENT_METRICS = new Set<string>([
  ...ACCOUNT_ALERT_RULE_SPECS.map(({ metric }) => metric),
  'upstream_rate_multiplier',
]);
const SEVERITIES = new Set<AlertSeverity>(['INFO', 'WARNING', 'CRITICAL']);

export class AccountAlertValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;
}

export function isGlobalAccountAlertMetric(value: string): value is GlobalAccountAlertMetric {
  return ACCOUNT_ALERT_RULE_SPECS.some(({ metric }) => metric === value);
}

export function normalizeGlobalAccountAlertMetric(value: string): GlobalAccountAlertMetric | null {
  if (isGlobalAccountAlertMetric(value)) return value;
  return LEGACY_GLOBAL_ACCOUNT_ALERT_METRICS[value as keyof typeof LEGACY_GLOBAL_ACCOUNT_ALERT_METRICS] ?? null;
}

export interface AccountAlertRuleUpdate {
  operator?: string;
  threshold?: number;
  severity?: AlertSeverity;
  minRequests?: number;
  minPromptTokens?: number;
  cooldownMin?: number;
  enabled?: boolean;
}

export function parseAccountAlertRuleUpdate(
  metric: GlobalAccountAlertMetric,
  body: unknown,
): AccountAlertRuleUpdate {
  if (!isRecord(body)) throw new AccountAlertValidationError('规则参数无效');
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.some((key) => !RULE_UPDATE_FIELDS.has(key))) {
    throw new AccountAlertValidationError('包含不允许修改的规则字段');
  }
  const spec = ACCOUNT_ALERT_RULE_SPECS.find((item) => item.metric === metric)!;
  const update: AccountAlertRuleUpdate = {};

  if ('operator' in body) {
    if (typeof body.operator !== 'string' || !(spec.operators as readonly string[]).includes(body.operator)) {
      throw new AccountAlertValidationError('比较符不适用于此规则');
    }
    update.operator = body.operator;
  }
  if ('threshold' in body) {
    const [minimum, maximum] = spec.threshold;
    if (typeof body.threshold !== 'number' || !Number.isFinite(body.threshold) || body.threshold < minimum || body.threshold > maximum) {
      throw new AccountAlertValidationError('阈值超出允许范围');
    }
    update.threshold = body.threshold;
  }
  if ('severity' in body) {
    if (typeof body.severity !== 'string' || !SEVERITIES.has(body.severity as AlertSeverity)) {
      throw new AccountAlertValidationError('严重级别无效');
    }
    update.severity = body.severity as AlertSeverity;
  }
  if ('minRequests' in body) {
    if (!spec.samples || !nonNegativeInteger(body.minRequests, 1_000_000)) {
      throw new AccountAlertValidationError('最小请求数无效');
    }
    update.minRequests = body.minRequests;
  }
  if ('minPromptTokens' in body) {
    if (!('promptTokens' in spec) || !nonNegativeInteger(body.minPromptTokens, Number.MAX_SAFE_INTEGER)) {
      throw new AccountAlertValidationError('最小 Prompt Token 数无效');
    }
    update.minPromptTokens = body.minPromptTokens;
  }
  if ('cooldownMin' in body) {
    if (!nonNegativeInteger(body.cooldownMin, 10_080)) {
      throw new AccountAlertValidationError('冷却时间无效');
    }
    update.cooldownMin = body.cooldownMin;
  }
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw new AccountAlertValidationError('启停状态无效');
    update.enabled = body.enabled;
  }
  return update;
}

interface RuleDtoInput {
  id: number;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  severity: AlertSeverity;
  minRequests: number;
  minPromptTokens: number;
  cooldownMin: number;
  enabled: boolean;
}

export function toAccountAlertRuleDto<T extends RuleDtoInput>(rule: T) {
  return {
    id: rule.id, name: rule.name, metric: normalizeGlobalAccountAlertMetric(rule.metric) ?? rule.metric, operator: rule.operator,
    threshold: rule.threshold, severity: rule.severity, minRequests: rule.minRequests,
    minPromptTokens: rule.minPromptTokens, cooldownMin: rule.cooldownMin, enabled: rule.enabled,
  };
}

export function buildAccountAlertEventWhere(searchParams: URLSearchParams) {
  const where: { accountId?: number; metric?: string; severity?: AlertSeverity; resolved?: boolean } = {};
  const account = searchParams.get('account');
  const metric = searchParams.get('metric');
  const severity = searchParams.get('severity');
  const resolved = searchParams.get('resolved');
  if (account !== null) {
    const accountId = parseStrictPositiveInteger(account);
    if (accountId === null) throw new AccountAlertValidationError('账号筛选无效');
    where.accountId = accountId;
  }
  if (metric !== null) {
    if (!EVENT_METRICS.has(metric)) throw new AccountAlertValidationError('指标筛选无效');
    where.metric = metric;
  }
  if (severity !== null) {
    if (!SEVERITIES.has(severity as AlertSeverity)) throw new AccountAlertValidationError('严重级别筛选无效');
    where.severity = severity as AlertSeverity;
  }
  if (resolved !== null) {
    if (resolved !== 'true' && resolved !== 'false') throw new AccountAlertValidationError('解决状态筛选无效');
    where.resolved = resolved === 'true';
  }
  return where;
}

interface EventDtoInput {
  id: number;
  metric: string;
  severity: AlertSeverity;
  metricValue: number | null;
  message: string;
  resolved: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
  account: { id: number; name: string; platform: string | null };
  rule: { id: number; name: string };
}

export function toAccountAlertEventDto<T extends EventDtoInput>(event: T) {
  return {
    id: event.id, metric: event.metric, severity: event.severity, metricValue: event.metricValue,
    message: event.message, resolved: event.resolved, resolvedAt: event.resolvedAt,
    createdAt: event.createdAt, account: event.account, rule: event.rule,
  };
}
