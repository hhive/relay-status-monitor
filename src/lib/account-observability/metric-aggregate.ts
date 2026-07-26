import { decimalToMicroUsd, histogramP95, mergeLatencyHistogram, microUsdToDecimal } from './metrics';

export interface MetricMinuteAggregateInput {
  bucketStart: Date;
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  durationCount: number;
  durationSumMs: bigint;
  durationHistogram: unknown;
  firstTokenHistogram: unknown;
  inputTokens: bigint;
  cacheReadTokens: bigint;
  cacheCreationTokens: bigint;
  userBilledUsd: unknown;
  accountBilledUsd: unknown;
  errorStatusCounts?: unknown;
  errorPhaseCounts?: unknown;
}

function mergeCounts(values: unknown[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count)) result[key] = (result[key] ?? 0) + count;
    }
  }
  return result;
}

export function aggregateMetricMinutes(minutes: MetricMinuteAggregateInput[]) {
  const successCount = minutes.reduce((sum, row) => sum + row.successCount, 0);
  const upstreamErrorCount = minutes.reduce((sum, row) => sum + row.upstreamErrorCount, 0);
  const eligibleCount = minutes.reduce((sum, row) => sum + row.eligibleCount, 0);
  const durationCount = minutes.reduce((sum, row) => sum + row.durationCount, 0);
  const durationSumMs = minutes.reduce((sum, row) => sum + row.durationSumMs, BigInt(0));
  const inputTokens = minutes.reduce((sum, row) => sum + row.inputTokens, BigInt(0));
  const cacheReadTokens = minutes.reduce((sum, row) => sum + row.cacheReadTokens, BigInt(0));
  const cacheCreationTokens = minutes.reduce((sum, row) => sum + row.cacheCreationTokens, BigInt(0));
  const tokenDenominator = inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    successCount,
    upstreamErrorCount,
    eligibleCount,
    availability: eligibleCount === 0 ? null : successCount / eligibleCount,
    errorRate: eligibleCount === 0 ? null : upstreamErrorCount / eligibleCount,
    averageDurationMs: durationCount === 0 ? null : Number(durationSumMs) / durationCount,
    durationP95Ms: histogramP95(mergeLatencyHistogram(minutes.map((row) => (row.durationHistogram ?? {}) as Record<string, number>))),
    firstTokenP95Ms: histogramP95(mergeLatencyHistogram(minutes.map((row) => (row.firstTokenHistogram ?? {}) as Record<string, number>))),
    cacheHitRate: tokenDenominator === BigInt(0) ? null : Number(cacheReadTokens) / Number(tokenDenominator),
    promptTokens: tokenDenominator.toString(),
    userBilledUsd: microUsdToDecimal(minutes.reduce((sum, row) => sum + decimalToMicroUsd(String(row.userBilledUsd)), BigInt(0))),
    accountBilledUsd: microUsdToDecimal(minutes.reduce((sum, row) => sum + decimalToMicroUsd(String(row.accountBilledUsd)), BigInt(0))),
    errorStatusCounts: mergeCounts(minutes.map((row) => row.errorStatusCounts)),
    errorPhaseCounts: mergeCounts(minutes.map((row) => row.errorPhaseCounts)),
  };
}
