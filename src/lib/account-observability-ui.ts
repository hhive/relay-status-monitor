export type AccountWindowKey = 'today' | 'last1h' | 'last24h';
export type AccountStatusFilter = 'schedulable' | 'all' | 'unschedulable';

export interface AccountWindowDto {
  key: AccountWindowKey;
  label: string;
  start: string;
  end: string;
  lastCompleteMinute: string;
  expectedMinutes: number;
}

export interface AccountCoverageDto {
  earliestBucket: string | null;
  latestBucket: string | null;
  expectedMinutes: number;
  actualMinutes: number;
  missingMinutes: number;
  complete: boolean;
  status: 'complete' | 'before_backfill' | 'collection_delay' | 'gap';
}

export interface AccountMetricAggregateDto {
  successCount: number;
  upstreamErrorCount: number;
  eligibleCount: number;
  availability: number | null;
  errorRate: number | null;
  averageDurationMs: number | null;
  durationP95Ms: number | null;
  firstTokenP95Ms: number | null;
  cacheHitRate: number | null;
  promptTokens: string;
  userBilledUsd: string;
  accountBilledUsd: string;
  errorStatusCounts: Record<string, number>;
  errorPhaseCounts: Record<string, number>;
}

export interface AccountTrendPointDto extends AccountMetricAggregateDto {
  bucketStart: string;
  complete: boolean;
}

export interface AccountBillingProbeDto {
  enabled: boolean;
  status: string | null;
  freshAt: string | null;
  lastSuccessAt: string | null;
  resolvedRateMultiplier: string | null;
  peakRateMultiplier: string | null;
  currentEffectiveRate: number | null;
}

export interface AccountSummaryDto {
  id: number;
  sourceAccountId?: string;
  name: string;
  platform: string | null;
  type: string | null;
  remoteStatus: string | null;
  schedulable: boolean | null;
  syncState: string;
  groupProjection: unknown;
  lastSyncedAt: string | null;
  lastCompleteMinute: string | null;
  billingProbe: AccountBillingProbeDto;
  metrics: AccountMetricAggregateDto;
}

export interface AccountOverviewDto {
  window: AccountWindowDto;
  coverage: AccountCoverageDto;
  filters: {
    status: AccountStatusFilter;
    platform: string | null;
    group: string | null;
    search: string | null;
  };
  summary: AccountMetricAggregateDto & {
    selectedAccountCount: number;
    schedulableAccountCount: number;
  };
  trend: AccountTrendPointDto[];
  accounts: AccountSummaryDto[];
  openAlertCount: number;
}

export interface AccountDetailDto extends AccountSummaryDto {
  window: AccountWindowDto;
  coverage: AccountCoverageDto;
  summary: AccountOverviewDto['summary'];
  trend: AccountTrendPointDto[];
  minutes: AccountTrendPointDto[];
}
