import {
  decimalToMicroUsd,
  histogramP95,
  isEligibleProviderError,
  providerErrorKey,
  snapshotBillingMicroUsdExact,
  type LatencyHistogram,
} from './metrics';

export interface UsageEvent {
  accountId: string;
  requestId: string | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  actualCost: string;
  totalCost: string;
  accountStatsCost: string | null;
  accountRateMultiplier: string | null;
}

export interface ErrorEvent {
  accountId: string;
  requestId: string | null;
  clientRequestId: string | null;
  errorOwner: string | null;
  errorPhase: string | null;
  statusCode: number | null;
}

export interface MinuteAggregate {
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  durationCount: number;
  durationSumMs: number;
  durationHistogram: LatencyHistogram;
  firstTokenHistogram: LatencyHistogram;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  userBilledMicroUsd: bigint;
  baseBilledMicroUsd: bigint;
  accountBilledMicroUsd: bigint;
  errorStatusCounts: Record<string, number>;
  errorPhaseCounts: Record<string, number>;
}

export function aggregateMinute(input: { usages: UsageEvent[]; errors: ErrorEvent[] }): MinuteAggregate {
  const usages = new Map<string, UsageEvent>();
  for (const usage of input.usages) {
    const key = `${usage.accountId}:${usage.requestId ?? `usage-${usages.size}`}`;
    usages.set(key, usage);
  }
  const errors = new Map<string, ErrorEvent>();
  for (const error of input.errors) {
    if (!isEligibleProviderError({ accountId: Number(error.accountId) || 1, errorOwner: error.errorOwner, errorPhase: error.errorPhase })) continue;
    const key = providerErrorKey({ accountId: Number(error.accountId) || 1, clientRequestId: error.clientRequestId, requestId: error.requestId ?? `error-${errors.size}` });
    errors.set(`${error.accountId}:${key.split(':').slice(1).join(':')}`, error);
  }
  const result: MinuteAggregate = {
    successCount: usages.size,
    upstreamErrorCount: errors.size,
    eligibleCount: usages.size + errors.size,
    durationCount: 0,
    durationSumMs: 0,
    durationHistogram: {},
    firstTokenHistogram: {},
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    userBilledMicroUsd: BigInt(0),
    baseBilledMicroUsd: BigInt(0),
    accountBilledMicroUsd: BigInt(0),
    errorStatusCounts: {},
    errorPhaseCounts: {},
  };
  for (const usage of usages.values()) {
    if (usage.durationMs != null && usage.durationMs >= 0) {
      result.durationCount += 1;
      result.durationSumMs += usage.durationMs;
      result.durationHistogram[String(usage.durationMs)] = (result.durationHistogram[String(usage.durationMs)] ?? 0) + 1;
    }
    if (usage.firstTokenMs != null && usage.firstTokenMs >= 0) {
      result.firstTokenHistogram[String(usage.firstTokenMs)] = (result.firstTokenHistogram[String(usage.firstTokenMs)] ?? 0) + 1;
    }
    result.inputTokens += usage.inputTokens;
    result.cacheReadTokens += usage.cacheReadTokens;
    result.cacheCreationTokens += usage.cacheCreationTokens;
    result.userBilledMicroUsd += decimalToMicroUsd(usage.actualCost);
    result.baseBilledMicroUsd += decimalToMicroUsd(usage.accountStatsCost ?? usage.totalCost);
    result.accountBilledMicroUsd += snapshotBillingMicroUsdExact({
      accountStatsCost: usage.accountStatsCost,
      totalCost: usage.totalCost,
      rateMultiplier: usage.accountRateMultiplier,
    });
  }
  for (const error of errors.values()) {
    const code = String(error.statusCode ?? 'unknown');
    result.errorStatusCounts[code] = (result.errorStatusCounts[code] ?? 0) + 1;
    const phase = error.errorPhase ?? 'unknown';
    result.errorPhaseCounts[phase] = (result.errorPhaseCounts[phase] ?? 0) + 1;
  }
  return result;
}

export { histogramP95 };
