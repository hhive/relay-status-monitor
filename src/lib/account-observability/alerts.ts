import { prisma } from '../db';
import type { Prisma, Severity } from '@prisma/client';
import { sendAccountNotification } from '../alerts/channels/feishu';
import { effectiveBillingRate, histogramP95, mergeLatencyHistogram, minuteBucket } from './metrics';
import { normalizeGlobalAccountAlertMetric } from './alert-management';
import { shouldSuppressAccountAlerts } from './group-alert-settings';

export type AccountAlertMetric =
  | 'availability_low'
  | 'error_rate_high'
  | 'duration_p95_high'
  | 'first_token_p95_high'
  | 'cache_hit_low'
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
  /** 账号告警总开关；为 false 时该账号的所有规则都不评估、不推送。缺省视为开启。 */
  alertEnabled?: boolean;
  groupProjection?: unknown;
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
  notificationDeliveries?: unknown;
  recoveryNormalCount: number;
}

interface NewAccountAlertEvent extends Omit<AccountAlertEventRecord, 'id' | 'notificationDeliveries'> {
  severity: Severity;
  metricValue: number | null;
  notificationDeliveries: NotificationDeliveries;
  createdAt: Date;
}

export interface AccountAlertDependencies {
  loadRules: () => Promise<AccountAlertRuleRecord[]>;
  loadAccounts: (window: { start: Date; end: Date }) => Promise<AccountAlertAccountRecord[]>;
  loadDisabledGroupIds: () => Promise<ReadonlySet<number>>;
  loadLatestMetricBucket: (accountId: number) => Promise<Date | null>;
  findOpenEvent: (accountId: number, ruleId: number) => Promise<AccountAlertEventRecord | null>;
  findRecentEvent: (accountId: number, ruleId: number, since: Date) => Promise<AccountAlertEventRecord | null>;
  createEvent: (event: NewAccountAlertEvent) => Promise<AccountAlertEventRecord>;
  updateNotificationDeliveries: (id: number, deliveries: NotificationDeliveries) => Promise<void>;
  updateRecoveryNormalCount: (id: number, count: number) => Promise<void>;
  resolveEvent: (id: number, at: Date) => Promise<void>;
  notify: (
    event: AccountAlertEventRecord,
    account: AccountAlertAccountRecord,
    recovery: boolean,
    deliveredChannelIds: readonly number[],
    onDelivered: (channelId: number) => Promise<void>,
  ) => Promise<void>;
}

interface NotificationDeliveries extends Prisma.JsonObject {
  trigger: number[];
  recovery: number[];
}

const ALERT_WINDOW_MINUTES = 10;

function parseNotificationDeliveries(value: unknown): NotificationDeliveries {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const channelIds = (phase: unknown) => Array.isArray(phase)
    ? [...new Set(phase.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
    : [];
  return { trigger: channelIds(record.trigger), recovery: channelIds(record.recovery) };
}

async function notifyEvent(
  dependencies: AccountAlertDependencies,
  event: AccountAlertEventRecord,
  account: AccountAlertAccountRecord,
  recovery: boolean,
): Promise<void> {
  let deliveries = parseNotificationDeliveries(event.notificationDeliveries);
  const phase = recovery ? 'recovery' : 'trigger';
  await dependencies.notify(event, account, recovery, deliveries[phase], async (channelId) => {
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || deliveries[phase].includes(channelId)) return;
    deliveries = { ...deliveries, [phase]: [...deliveries[phase], channelId] };
    await dependencies.updateNotificationDeliveries(event.id, deliveries);
    event.notificationDeliveries = deliveries;
  });
}

function boundedRecoveryNormalCount(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(3, value)) : 0;
}

async function setRecoveryNormalCount(
  dependencies: AccountAlertDependencies,
  event: AccountAlertEventRecord,
  count: number,
): Promise<void> {
  const next = boundedRecoveryNormalCount(count);
  if (next === event.recoveryNormalCount) return;
  await dependencies.updateRecoveryNormalCount(event.id, next);
  event.recoveryNormalCount = next;
}

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
  if (input.metric === 'cache_hit_low' && (input.promptTokens ?? 0) < (input.minPromptTokens ?? 0)) return null;
  if (input.metric === 'upstream_rate_multiplier' && input.snapshotFresh !== true) return null;
  const lowerIsBad = input.metric === 'availability_low' || input.metric === 'cache_hit_low';
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
    availability_low: '可用率', error_rate_high: '上游错误率', duration_p95_high: '总耗时 P95',
    first_token_p95_high: '首字耗时 P95', cache_hit_low: '缓存命中率',
    upstream_rate_multiplier: '上游倍率', unschedulable: '不可调度', sync_stale: '同步陈旧分钟数',
  };
  return labels[metric];
}

function alertMessage(accountName: string, rule: AccountAlertRuleRecord, value: number | null): string {
  return `[${accountName}] ${metricLabel(rule.metric)} ${value ?? '-'} ${rule.operator} ${rule.threshold}`;
}

function evaluateRule(
  rule: AccountAlertRuleRecord,
  account: AccountAlertAccountRecord,
  now: Date,
  latestMetricBucketStart: Date | null,
): { available: boolean; triggered: boolean; value: number | null } {
  if (rule.metric === 'unschedulable') {
    const value = account.schedulable === false ? 1 : 0;
    return { available: account.schedulable != null, triggered: compare(value, rule.operator, rule.threshold), value };
  }
  if (rule.metric === 'sync_stale') {
    if (!account.lastSyncedAt || !latestMetricBucketStart) return { available: true, triggered: true, value: null };
    const value = Math.max(
      0,
      (now.getTime() - account.lastSyncedAt.getTime()) / 60_000,
      (now.getTime() - latestMetricBucketStart.getTime()) / 60_000,
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
    case 'availability_low': value = eligibleCount ? minutes.reduce((sum, item) => sum + item.successCount, 0) / eligibleCount : null; break;
    case 'error_rate_high': value = eligibleCount ? minutes.reduce((sum, item) => sum + item.upstreamErrorCount, 0) / eligibleCount : null; break;
    case 'duration_p95_high': value = histogramP95(mergeLatencyHistogram(minutes.map((item) => (item.durationHistogram ?? {}) as Record<string, number>))); break;
    case 'first_token_p95_high': value = histogramP95(mergeLatencyHistogram(minutes.map((item) => (item.firstTokenHistogram ?? {}) as Record<string, number>))); break;
    case 'cache_hit_low': {
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
    const [storedRules, accounts, disabledGroupIds] = await Promise.all([
      dependencies.loadRules(),
      dependencies.loadAccounts({ start, end }),
      dependencies.loadDisabledGroupIds(),
    ]);
    const rules = storedRules.flatMap((rule) => {
      const metric = rule.metric === 'upstream_rate_multiplier'
        ? rule.metric
        : normalizeGlobalAccountAlertMetric(rule.metric);
      return metric ? [{ ...rule, metric }] : [];
    });
    for (const account of accounts) {
      if (account.alertEnabled === false) continue;
      if (shouldSuppressAccountAlerts(account.groupProjection, disabledGroupIds)) continue;
      const needsLatestMetricBucket = rules.some((rule) =>
        rule.enabled && rule.metric === 'sync_stale' && (rule.accountId == null || rule.accountId === account.id));
      const latestMetricBucketStart = needsLatestMetricBucket
        ? await dependencies.loadLatestMetricBucket(account.id)
        : null;
      for (const rule of rules) {
        if (!rule.enabled) continue;
        if (rule.accountId != null && rule.accountId !== account.id) continue;
        const result = evaluateRule(rule, account, now, latestMetricBucketStart);
        const open = await dependencies.findOpenEvent(account.id, rule.id);
        if (!result.available) {
          if (open) await setRecoveryNormalCount(dependencies, open, 0);
          continue;
        }
        if (!result.triggered && open) {
          const normalCount = Math.min(3, boundedRecoveryNormalCount(open.recoveryNormalCount) + 1);
          await setRecoveryNormalCount(dependencies, open, normalCount);
          if (normalCount < 3) continue;
          if (open.notificationDeliveries != null) {
            await notifyEvent(dependencies, open, account, false);
          }
          await notifyEvent(dependencies, {
            ...open,
            metricValue: result.value,
            message: alertMessage(account.name, rule, result.value),
          }, account, true);
          await dependencies.resolveEvent(open.id, now);
          continue;
        }
        if (!result.triggered) continue;
        if (open) {
          await setRecoveryNormalCount(dependencies, open, 0);
          if (open.notificationDeliveries != null) {
            await notifyEvent(dependencies, open, account, false);
          }
          continue;
        }
        const cooldownStart = new Date(now.getTime() - rule.cooldownMin * 60_000);
        if (await dependencies.findRecentEvent(account.id, rule.id, cooldownStart)) continue;
        const event = await dependencies.createEvent({
          accountId: account.id, ruleId: rule.id, metric: rule.metric,
          severity: rule.severity ?? 'WARNING', metricValue: result.value,
          message: alertMessage(account.name, rule, result.value),
          notificationDeliveries: { trigger: [], recovery: [] },
          recoveryNormalCount: 0,
          createdAt: now,
        });
        await notifyEvent(dependencies, event, account, false);
      }
    }
  };
}

export async function evaluateAccountAlerts(now = new Date()): Promise<void> {
  return createAccountAlertEvaluator({
    loadRules: async () => (await prisma.accountAlertRule.findMany({ where: { enabled: true } })) as AccountAlertRuleRecord[],
    loadAccounts: async ({ start, end }) => (await prisma.sub2ApiAccount.findMany({
      where: { syncState: 'ACTIVE', alertEnabled: true },
      include: { metricMinutes: { where: { bucketStart: { gte: start, lt: end } } } },
    })) as AccountAlertAccountRecord[],
    loadDisabledGroupIds: async () => new Set((await prisma.groupAlertSetting.findMany({
      where: { alertEnabled: false },
      select: { groupId: true },
    })).map((setting) => setting.groupId)),
    loadLatestMetricBucket: async (accountId) => {
      const latest = await prisma.accountMetricMinute.findFirst({
        where: { accountId },
        orderBy: { bucketStart: 'desc' },
        select: { bucketStart: true },
      });
      return latest?.bucketStart ?? null;
    },
    findOpenEvent: async (accountId, ruleId) => prisma.accountAlertEvent.findFirst({ where: { accountId, ruleId, resolved: false }, orderBy: { createdAt: 'desc' } }),
    findRecentEvent: async (accountId, ruleId, since) => prisma.accountAlertEvent.findFirst({ where: { accountId, ruleId, createdAt: { gt: since } }, orderBy: { createdAt: 'desc' } }),
    createEvent: async (event) => prisma.accountAlertEvent.create({
      data: { ...event, notificationDeliveries: event.notificationDeliveries as Prisma.InputJsonValue },
    }),
    updateNotificationDeliveries: async (id, notificationDeliveries) => {
      await prisma.accountAlertEvent.update({
        where: { id },
        data: { notificationDeliveries: notificationDeliveries as Prisma.InputJsonValue },
      });
    },
    updateRecoveryNormalCount: async (id, recoveryNormalCount) => {
      await prisma.accountAlertEvent.update({ where: { id }, data: { recoveryNormalCount } });
    },
    resolveEvent: async (id, at) => { await prisma.accountAlertEvent.update({ where: { id }, data: { resolved: true, resolvedAt: at } }); },
    notify: async (event, account, recovery, deliveredChannelIds, onDelivered) =>
      sendAccountNotification(event, account, recovery, deliveredChannelIds, onDelivered),
  })(now);
}
