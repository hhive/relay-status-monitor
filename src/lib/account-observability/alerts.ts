export type AccountAlertMetric = 'availability' | 'error_rate' | 'duration_p95' | 'first_token_p95' | 'cache_hit_rate' | 'upstream_rate_multiplier';

export function evaluateAccountMetricAlert(input: {
  metric: AccountAlertMetric;
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
