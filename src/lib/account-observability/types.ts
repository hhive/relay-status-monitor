export type ProviderErrorPhase = 'upstream' | 'account_auth' | 'network' | string;

export interface ProviderErrorCandidate {
  accountId: number | null;
  errorOwner: string | null;
  errorPhase: ProviderErrorPhase | null;
}

export interface ProviderErrorIdentity {
  accountId: number;
  clientRequestId: string | null;
  requestId: string;
}

export interface BillingSnapshot {
  accountStatsCost: string | null;
  totalCost: string | null;
  rateMultiplier: string | null;
}

export interface TokenSnapshot {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AccountMetricAggregate {
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  durationSumMs: number;
  userBilledUsd: string;
  accountBilledUsd: string;
}
