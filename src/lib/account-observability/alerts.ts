import { prisma } from '../db';
import type { Severity } from '@prisma/client';
import { sendAccountNotification } from '../alerts/channels/feishu';
import { effectiveBillingRate, histogramP95, mergeLatencyHistogram, minuteBucket } from './metrics';

export type AccountAlertMetric =
  | 'availability'
  | 'error_rate'
  | 'duration_p95'
  | 'first_token_p95'
  | 'cache_hit_rate'
  | 'upstream_rate_multiplier'
  | 'unschedulable'
  | 'sync_stale';

export interface AccountAlertRuleRecord {
  id: number;
  accountId?: number | null;
  name: string;
  metric: AccountAlertMetric;
  operator: string;
  threshold: number;
  severity?: Severity;
  minRequests: number;
  minPromptTokens: number;
  cooldownMin: number;
  enabled: boolean;
}

export interface AccountMetricMinuteRecord {
  bucketStart: Date;
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  durationHistogram: unknown;
  firstTokenHistogram: unknown;
  inputTokens: bigint;
  cacheReadTokens: bigint;
  cacheCreationTokens: bigint;
}

export interface AccountAlertAccountRecord {
  id: number;
  sourceAccountId: string;
  name: string;
  platform: string | null;
  schedulable: boolean | null;
  syncState: string;
  lastSyncedAt: Date | null;
  probeFreshAt: Date | null;
  probeLastSuccessAt: Date | null;
  probeStatus: string | null;
  probeBillingScope: string | null;
  probeResolvedRateMultiplier: unknown;
  probePeakRateEnabled: boolean | null;
  probePeakStart: string | null;
  probePeakEnd: string | null;
  probePeakRateMultiplier: unknown;
  probeTimezone: string | null;
  metricMinutes: AccountMetricMinuteRecord[];
}

export interface AccountAlertEventRecord {
  id: number;
  accountId: number;
  ruleId: number;
  metric: string;
  severity?: Severity;
  metricValue?: number | null;
  message: string;
}

interface NewAccountAlertEvent extends Omit<AccountAlertEventRecord, 'id'> {
  severity: Severity;
  metricValue: number | null;
  createdAt: Date;
}

export interface AccountAlertDependencies {
  loadRules: () => Promise<AccountAlertRuleRecord[]>;
  loadAccounts: (window: { start: Date; end: Date }) => Promise<AccountAlertAccountRecord[]>;
  findOpenEvent: (accountId: number, ruleId: number) => Promise<AccountAlertEventRecord | null>;
  findRecentEvent: (accountId: number, ruleId: number, since: Date) => Promise<AccountAlertEventRecord | null>;
  createEvent: (event: NewAccountAlertEvent) => Promise<AccountAlertEventRecord>;
  resolveEvent: (id: number, at: Date) => Promise<void>;
  notify: (event: AccountAlertEventRecord, account: AccountAlertAccountRecord, recovery: boolean) => Promise<void>;
}

const ALERT_WINDOW_MINUTES = 10;

export function evaluateAccountMetricAlert(input: {
  metric: Exclude<AccountAlertMetric, 'unschedulable' | 'sync_stale'>;
  value: number | null;
  threshold: number;
  eligibleCount: number;
  minRequests: number;
  promptTokens?: number;
  minPromptTokens?: number;
  snapshotFresh?: boolean;
}): { triggered: true; metric: AccountAlertMetric; value: number } | null {
  if (input.value == null || input.eligibleCount < input.minRequests) return null;
  if (input.metric === 'cache_hit_rate' && (input.promptTokens ?? 0) < (input.minPromptTokens ?? 0)) return null;
  if (input.metric === 'upstream_rate_multiplier' && input.snapshotFresh !== true) return null;
  const lowerIsBad = input.metric === 'availability' || input.metric === 'cache_hit_rate';
  const triggered = lowerIsBad ? input.value < input.threshold : input.value > input.threshold;
  return triggered ? { triggered: true, metric: input.metric, value: input.value } : null;
}

function compare(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'eq': return value === threshold;
    default: return false;
  }
}

function metricLabel(metric: AccountAlertMetric): string {
  const labels: Record<AccountAlertMetric, string> = {
    availability: '可用率', error_rate: '上游错误率', duration_p95: '总耗时 P95',
    first_token_p95: '首字耗时 P95', cache_hit_rate: '缓存命中率',
    upstream_rate_multiplier: '上游倍率', unschedulable: '不可调度', sync_stale: '同步陈旧分钟数',
  };
  return labels[metric];
}

function evaluateRule(rule: AccountAlertRuleRecord, account: AccountAlertAccountRecord, now: Date): { available: boolean; triggered: boolean; value: number | null } {
  if (rule.metric === 'unschedulable') {
    const value = account.schedulable === false ? 1 : 0;
    return { available: account.schedulable != null, triggered: compare(value, rule.operator, rule.threshold), value };
  }
  if (rule.metric === 'sync_stale') {
    const latestMetricMinute = account.metricMinutes.reduce<Date | null>((latest, minute) =>
      latest == null || minute.bucketStart > latest ? minute.bucketStart : latest, null);
    if (!account.lastSyncedAt || !latestMetricMinute) return { available: true, triggered: true, value: null };
    const value = Math.max(
      0,
      (now.getTime() - account.lastSyncedAt.getTime()) / 60_000,
      (now.getTime() - latestMetricMinute.getTime()) / 60_000,
    );
    return { available: true, triggered: compare(value, rule.operator, rule.threshold), value };
  }
  if (rule.metric === 'upstream_rate_multiplier') {
    if (rule.accountId == null || rule.accountId !== account.id) return { available: false, triggered: false, value: null };
    const resolved = account.probeResolvedRateMultiplier == null ? null : Number(account.probeResolvedRateMultiplier);
    const peak = account.probePeakRateMultiplier == null ? null : Number(account.probePeakRateMultiplier);
    const value = effectiveBillingRate({ status: account.probeStatus, billingScope: account.probeBillingScope,
      resolvedRateMultiplier: resolved, peakRateEnabled: account.probePeakRateEnabled,
      peakStart: account.probePeakStart, peakEnd: account.probePeakEnd, peakRateMultiplier: peak,
      timezone: account.probeTimezone, receivedAt: account.probeLastSuccessAt, freshUntil: account.probeFreshAt }, now);
    if (value == null || !Number.isFinite(value)) return { available: false, triggered: false, value: null };
    return { available: true, triggered: compare(value, rule.operator, rule.threshold), value };
  }

  const minutes = account.metricMinutes;
  const eligibleCount = minutes.reduce((sum, item) => sum + item.eligibleCount, 0);
  if (eligibleCount < rule.minRequests) return { available: false, triggered: false, value: null };
  const promptTokens = minutes.reduce((sum, item) => sum + item.inputTokens + item.cacheReadTokens + item.cacheCreationTokens, BigInt(0));
  let value: number | null = null;
  switch (rule.metric) {
    case 'availability': value = eligibleCount ? minutes.reduce((sum, item) => sum + item.successCount, 0) / eligibleCount : null; break;
    case 'error_rate': value = eligibleCount ? minutes.reduce((sum, item) => sum + item.upstreamErrorCount, 0) / eligibleCount : null; break;
    case 'duration_p95': value = histogramP95(mergeLatencyHistogram(minutes.map((item) => (item.durationHistogram ?? {}) as Record<string, number>))); break;
    case 'first_token_p95': value = histogramP95(mergeLatencyHistogram(minutes.map((item) => (item.firstTokenHistogram ?? {}) as Record<string, number>))); break;
    case 'cache_hit_rate': {
      if (promptTokens < BigInt(rule.minPromptTokens)) return { available: false, triggered: false, value: null };
      const cacheRead = minutes.reduce((sum, item) => sum + item.cacheReadTokens, BigInt(0));
      value = promptTokens === BigInt(0) ? null : Number(cacheRead) / Number(promptTokens);
      break;
    }
  }
  if (value == null) return { available: false, triggered: false, value: null };
  return { available: true, triggered: compare(value, rule.operator, rule.threshold), value };
}

export function createAccountAlertEvaluator(dependencies: AccountAlertDependencies) {
  return async (now = new Date()): Promise<void> => {
    const end = minuteBucket(now);
    const start = new Date(end.getTime() - ALERT_WINDOW_MINUTES * 60_000);
    const [rules, accounts] = await Promise.all([dependencies.loadRules(), dependencies.loadAccounts({ start, end })]);
    for (const account of accounts) {
      for (const rule of rules) {
        if (!rule.enabled) continue;
        if (rule.accountId != null && rule.accountId !== account.id) continue;
        const result = evaluateRule(rule, account, now);
        const open = await dependencies.findOpenEvent(account.id, rule.id);
        if (!result.available) continue;
        if (!result.triggered) {
          if (open) {
            await dependencies.resolveEvent(open.id, now);
            await dependencies.notify(open, account, true);
          }
          continue;
        }
        if (open) continue;
        const cooldownStart = new Date(now.getTime() - rule.cooldownMin * 60_000);
        if (await dependencies.findRecentEvent(account.id, rule.id, cooldownStart)) continue;
        const event = await dependencies.createEvent({
          accountId: account.id, ruleId: rule.id, metric: rule.metric,
          severity: rule.severity ?? 'WARNING', metricValue: result.value,
          message: `[${account.name}] ${metricLabel(rule.metric)} ${result.value ?? '-'} ${rule.operator} ${rule.threshold}`,
          createdAt: now,
        });
        await dependencies.notify(event, account, false);
      }
    }
  };
}

export async function evaluateAccountAlerts(now = new Date()): Promise<void> {
  return createAccountAlertEvaluator({
    loadRules: async () => (await prisma.accountAlertRule.findMany({ where: { enabled: true } })) as AccountAlertRuleRecord[],
    loadAccounts: async ({ start, end }) => (await prisma.sub2ApiAccount.findMany({
      where: { syncState: 'ACTIVE' },
      include: { metricMinutes: { where: { bucketStart: { gte: start, lt: end } } } },
    })) as AccountAlertAccountRecord[],
    findOpenEvent: async (accountId, ruleId) => prisma.accountAlertEvent.findFirst({ where: { accountId, ruleId, resolved: false }, orderBy: { createdAt: 'desc' } }),
    findRecentEvent: async (accountId, ruleId, since) => prisma.accountAlertEvent.findFirst({ where: { accountId, ruleId, createdAt: { gt: since } }, orderBy: { createdAt: 'desc' } }),
    createEvent: async (event) => prisma.accountAlertEvent.create({ data: event }),
    resolveEvent: async (id, at) => { await prisma.accountAlertEvent.update({ where: { id }, data: { resolved: true, resolvedAt: at } }); },
    notify: async (event, account, recovery) => sendAccountNotification(event, account, recovery),
  })(now);
}
