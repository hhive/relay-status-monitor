export type AccountWindowKey = 'today' | 'last1h' | 'last24h';
export type AccountStatusFilter = 'schedulable' | 'all' | 'unschedulable';
export const ACCOUNT_PAGE_SIZES = [20, 50, 100] as const;
export type AccountPageSize = (typeof ACCOUNT_PAGE_SIZES)[number];

export interface AccountWindowDto {
  key: AccountWindowKey;
  label: string;
  start: string;
  end: string;
  lastCompleteMinute: string | null;
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
  balanceUsd?: string | null;
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
  priority: number;
  syncState: string;
  groupProjection: unknown;
  lastSyncedAt: string | null;
  lastCompleteMinute: string | null;
  alertEnabled: boolean;
  billingProbe: AccountBillingProbeDto;
  upstream: {
    balanceUsd: string | null;
    rateMultiplier: string | null;
    apiRateMultiplier: string | null;
    estimatedRateMultiplier: string | null;
    upstreamRateSource: string | null;
    collectedAt: string | null;
  };
  metrics: AccountMetricAggregateDto;
}

export interface AccountListItemDto {
  id: number;
  name: string;
  platform: string | null;
  type: string | null;
  remoteStatus: string | null;
  schedulable: boolean | null;
  priority: number;
  syncState: string;
  groupProjection: unknown;
  lastSyncedAt: string | null;
  lastCompleteMinute: string | null;
  alertEnabled: boolean;
  metrics: Pick<AccountMetricAggregateDto,
    'eligibleCount' | 'availability' | 'errorRate' | 'durationP95Ms' | 'firstTokenP95Ms' |
    'cacheHitRate' | 'userBilledUsd' | 'accountBilledUsd'> & {
      balanceUsd: string | null;
      upstreamRateMultiplier: string | null;
      upstreamApiRateMultiplier: string | null;
      upstreamEstimatedRateMultiplier: string | null;
      upstreamRateSource: string | null;
    };
}

export interface AccountListResponseDto {
  accounts: AccountListItemDto[];
  facets: {
    platforms: string[];
    groups: Array<{ id: number; name: string }>;
  };
  pagination: {
    page: number;
    pageSize: AccountPageSize;
    totalItems: number;
    totalPages: number;
  };
  window: AccountWindowDto;
  snapshot: {
    computedAt: string;
    lastCompleteMinute: string | null;
  };
}

export interface AccountListQueryInput {
  windowKey: AccountWindowKey;
  filters: {
    status: AccountStatusFilter;
    platform: string | null;
    groupId: number | null;
    search: string | null;
    alertGroupsOnly: boolean;
  };
  page: number;
  pageSize: AccountPageSize;
  sort: {
    key: import('./account-list-sort').AccountSortKey;
    order: import('./account-list-sort').AccountSortOrder;
  };
}

export interface AccountOverviewDto {
  window: AccountWindowDto;
  coverage: AccountCoverageDto;
  filters: {
    status: AccountStatusFilter;
    platform: string | null;
    groupId: number | null;
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

export type AccountOverviewResponseDto = Omit<AccountOverviewDto, 'accounts'>;

export interface AccountDetailDto extends AccountSummaryDto {
  window: AccountWindowDto;
  coverage: AccountCoverageDto;
  summary: AccountOverviewDto['summary'];
  trend: AccountTrendPointDto[];
  minutes: AccountTrendPointDto[];
}

interface AlertRuleNavigationEvent {
  metric: string;
  account: { id: number };
  rule: { id: number };
}

export function alertRuleConfigurationHref(event: AlertRuleNavigationEvent): string {
  if (event.metric === 'upstream_rate_multiplier') {
    return `/accounts/${event.account.id}#billing-alert-rule`;
  }
  return `/settings?rule=${event.rule.id}#rule-${event.rule.id}`;
}

export function parseAlertRuleTarget(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
