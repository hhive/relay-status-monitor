export type AccountMetricKey =
  | 'selectedAccountCount'
  | 'eligibleCount'
  | 'availability'
  | 'errorRate'
  | 'averageDurationMs'
  | 'durationP95Ms'
  | 'firstTokenP95Ms'
  | 'cacheHitRate'
  | 'promptTokens'
  | 'userBilledUsd'
  | 'accountBilledUsd'
  | 'successCount'
  | 'upstreamErrorCount'
  | 'openAlertCount';

export type AccountAggregateMetricKey = Exclude<AccountMetricKey, 'selectedAccountCount' | 'openAlertCount'>;

export interface AccountMetricDefinition {
  label: string;
  source: string;
  formula: string;
  sample: string;
  empty: string;
  unit: 'count' | 'percent' | 'milliseconds' | 'usd';
}

export const ACCOUNT_METRIC_DEFINITIONS: Record<AccountMetricKey, AccountMetricDefinition> = {
  selectedAccountCount: { label: '账号数', source: 'Sub2ApiAccount', formula: 'COUNT(filtered accounts)', sample: '当前筛选账号', empty: '无账号时为 0', unit: 'count' },
  eligibleCount: { label: '有效请求', source: 'AccountMetricMinute.eligibleCount', formula: 'SUM(eligibleCount)', sample: '纳入可用率口径的请求', empty: '无请求时为 0', unit: 'count' },
  availability: { label: '可用率', source: 'AccountMetricMinute', formula: 'SUM(successCount) / SUM(eligibleCount)', sample: '有效请求数', empty: '无有效请求时暂无数据', unit: 'percent' },
  errorRate: { label: '错误率', source: 'AccountMetricMinute', formula: 'SUM(upstreamErrorCount) / SUM(eligibleCount)', sample: '有效请求数', empty: '无有效请求时暂无数据', unit: 'percent' },
  averageDurationMs: { label: '平均总延迟', source: 'AccountMetricMinute.durationSumMs', formula: 'SUM(durationSumMs) / SUM(durationCount)', sample: '有总延迟的请求', empty: '无延迟样本时暂无数据', unit: 'milliseconds' },
  durationP95Ms: { label: '总延迟 P95', source: 'AccountMetricMinute.durationHistogram', formula: 'P95(merged duration histogram)', sample: '有总延迟的请求', empty: '无延迟样本时暂无数据', unit: 'milliseconds' },
  firstTokenP95Ms: { label: '首 Token P95', source: 'AccountMetricMinute.firstTokenHistogram', formula: 'P95(merged first-token histogram)', sample: '有首 Token 延迟的请求', empty: '无首 Token 样本时暂无数据', unit: 'milliseconds' },
  cacheHitRate: { label: '缓存命中率', source: 'AccountMetricMinute token fields', formula: 'cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreationTokens)', sample: 'Prompt Token 总数', empty: 'Token 分母为 0 时暂无数据', unit: 'percent' },
  promptTokens: { label: 'Prompt Token 样本', source: 'AccountMetricMinute token fields', formula: 'SUM(inputTokens + cacheReadTokens + cacheCreationTokens)', sample: 'Prompt Token 总数', empty: '无 Token 时为 0', unit: 'count' },
  userBilledUsd: { label: '用户计费', source: 'usage_logs.actual_cost', formula: 'SUM(actual_cost)', sample: '成功计费记录', empty: '无成功计费记录时为 $0', unit: 'usd' },
  accountBilledUsd: { label: '账号计费', source: 'usage_logs billing snapshots', formula: 'SUM(COALESCE(account_stats_cost,total_cost) * COALESCE(account_rate_multiplier,1))', sample: '成功计费记录', empty: '无成功计费记录时为 $0', unit: 'usd' },
  successCount: { label: '成功请求', source: 'AccountMetricMinute.successCount', formula: 'SUM(successCount)', sample: '请求数', empty: '无请求时为 0', unit: 'count' },
  upstreamErrorCount: { label: '上游责任错误', source: 'AccountMetricMinute.upstreamErrorCount', formula: 'SUM(upstreamErrorCount)', sample: '请求数', empty: '无错误时为 0', unit: 'count' },
  openAlertCount: { label: '未解决告警', source: 'AccountAlertEvent', formula: 'COUNT(resolved = false)', sample: '当前筛选账号', empty: '无告警时为 0', unit: 'count' },
};

export function formatAccountMetric(key: AccountMetricKey, value: number | string | null | undefined): string {
  if (value == null || value === '') return '暂无数据';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return '暂无数据';
  const unit = ACCOUNT_METRIC_DEFINITIONS[key].unit;
  if (unit === 'percent') return `${(numeric * 100).toFixed(1)}%`;
  if (unit === 'milliseconds') return `${Math.round(numeric).toLocaleString('en-US')} ms`;
  if (unit === 'usd') return `$${numeric.toFixed(2)}`;
  return Math.round(numeric).toLocaleString('en-US');
}
