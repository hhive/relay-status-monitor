'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, ChartNoAxesCombined, LayoutDashboard, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { AccountTrendChart, type AccountTrendSeries } from './account-trend-chart';
import { MetricDefinitionTooltip } from './metric-definition-tooltip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { PageHeader } from '@/components/page-header';
import {
  ACCOUNT_SORT_KEYS,
  ACCOUNT_SORT_LABELS,
  DEFAULT_ACCOUNT_SORT,
  readAccountSortStateSafely,
  writeAccountSortStateSafely,
  type AccountSortKey,
  type AccountSortState,
} from '@/lib/account-list-sort';
import {
  readAccountFilterPreferencesSafely,
  reconcileAccountFilterPreferences,
  writeAccountFilterPreferencesSafely,
  type AccountFilterPreferences,
} from '@/lib/account-list-filters';
import { formatAccountMetric, type AccountAggregateMetricKey, type AccountMetricKey } from '@/lib/account-metric-definitions';
import {
  ACCOUNT_PAGE_SIZES,
  type AccountCoverageDto,
  type AccountListItemDto,
  type AccountListResponseDto,
  type AccountOverviewResponseDto,
  type AccountPageSize,
  type AccountStatusFilter,
  type AccountWindowDto,
  type AccountWindowKey,
} from '@/lib/account-observability-ui';
import { accountDataIsStale, formatAccountGroups } from '@/lib/account-observability/presentation';
import { runAccountAlertToggle } from '@/lib/account-alert-toggle';
import { apiFetch } from '@/lib/api-fetch';
import { getPaginationItems, type PaginationItem as AccountPaginationItem } from '@/lib/pagination';
import { beginLatestRequest } from '@/lib/request-sequence';
import { cn } from '@/lib/utils';

const WINDOW_OPTIONS: Array<{ value: AccountWindowKey; label: string }> = [
  { value: 'today', label: '今日' },
  { value: 'last1h', label: '近 1 小时' },
  { value: 'last24h', label: '近 24 小时' },
];

const STATUS_OPTIONS: Array<{ value: AccountStatusFilter; label: string }> = [
  { value: 'schedulable', label: '可调度' },
  { value: 'all', label: '全部' },
  { value: 'unschedulable', label: '不可调度' },
];

const TREND_VIEWS: Record<'quality' | 'latency' | 'billing', { label: string; series: AccountTrendSeries[] }> = {
  quality: { label: '流量质量', series: [{ key: 'availability', color: 'hsl(var(--success))' }, { key: 'errorRate', color: 'hsl(var(--destructive))' }, { key: 'eligibleCount', color: 'hsl(var(--chart-2))' }] },
  latency: { label: '延迟与缓存', series: [{ key: 'averageDurationMs', color: 'hsl(var(--chart-2))' }, { key: 'durationP95Ms', color: 'hsl(var(--warning))' }, { key: 'firstTokenP95Ms', color: 'hsl(var(--chart-1))' }, { key: 'cacheHitRate', color: 'hsl(var(--success))' }] },
  billing: { label: '计费', series: [{ key: 'userBilledUsd', color: 'hsl(var(--chart-1))' }, { key: 'accountBilledUsd', color: 'hsl(var(--warning))' }] },
};

const SUMMARY_METRICS: AccountAggregateMetricKey[] = ['eligibleCount', 'availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'userBilledUsd', 'accountBilledUsd'];
const ACCOUNT_LIST_METRICS = ['availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'userBilledUsd', 'accountBilledUsd', 'balanceUsd', 'eligibleCount'] as const;

export function AccountOverview({ listOnly = false }: { listOnly?: boolean }) {
  const [overview, setOverview] = useState<AccountOverviewResponseDto | null>(null);
  const [list, setList] = useState<AccountListResponseDto | null>(null);
  const [windowKey, setWindowKey] = useState<AccountWindowKey>('last1h');
  const [status, setStatus] = useState<AccountStatusFilter>('schedulable');
  const [platform, setPlatform] = useState('');
  const [groupId, setGroupId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [deferredSearch, setDeferredSearch] = useState('');
  const [trendView, setTrendView] = useState<keyof typeof TREND_VIEWS>('quality');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<AccountPageSize>(50);
  const [sortReady, setSortReady] = useState(false);
  const [filtersReady, setFiltersReady] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(!listOnly);
  const [listLoading, setListLoading] = useState(true);
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pendingAlertAccounts, setPendingAlertAccounts] = useState<Set<number>>(() => new Set());
  const [sortState, setSortState] = useState<AccountSortState>(DEFAULT_ACCOUNT_SORT);
  const pendingAlertAccountsRef = useRef(new Set<number>());
  const overviewSequence = useRef(0);
  const listSequence = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDeferredSearch(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const filters = readAccountFilterPreferencesSafely(() => window.localStorage);
    setWindowKey(filters.windowKey);
    setStatus(filters.status);
    setPlatform(filters.platform);
    setGroupId(filters.groupId);
    setPageSize(filters.pageSize);
    setFiltersReady(true);
  }, []);

  useEffect(() => {
    setSortState(readAccountSortStateSafely(() => window.localStorage));
    setSortReady(true);
  }, []);

  const persistFilters = useCallback((overrides: Partial<AccountFilterPreferences> = {}) => {
    writeAccountFilterPreferencesSafely(() => window.localStorage, {
      windowKey,
      status,
      platform,
      groupId,
      pageSize,
      ...overrides,
    });
  }, [groupId, pageSize, platform, status, windowKey]);

  const fetchOverview = useCallback(async () => {
    if (!filtersReady || listOnly) return;
    const isCurrent = beginLatestRequest(overviewSequence);
    setOverviewLoading(true);
    const params = new URLSearchParams({ window: windowKey, status });
    if (platform) params.set('platform', platform);
    if (groupId !== null) params.set('groupId', String(groupId));
    if (deferredSearch) params.set('search', deferredSearch);
    try {
      const response = await apiFetch(`/api/accounts/overview?${params.toString()}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '账号指标暂不可用');
      if (!isCurrent()) return;
      setOverview(body as AccountOverviewResponseDto);
      setOverviewError(null);
    } catch (reason) {
      if (isCurrent()) setOverviewError(reason instanceof Error ? reason.message : '账号指标暂不可用');
    } finally {
      if (isCurrent()) {
        setOverviewLoading(false);
        setOverviewRefreshing(false);
      }
    }
  }, [deferredSearch, filtersReady, groupId, listOnly, platform, status, windowKey]);

  const fetchList = useCallback(async () => {
    if (!filtersReady || !sortReady) return;
    const isCurrent = beginLatestRequest(listSequence);
    setListLoading(true);
    const params = new URLSearchParams({
      window: windowKey,
      status,
      sortKey: sortState.key,
      sortOrder: sortState.order,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (platform) params.set('platform', platform);
    if (groupId !== null) params.set('groupId', String(groupId));
    if (deferredSearch) params.set('search', deferredSearch);
    try {
      const response = await apiFetch(`/api/accounts/list?${params}`);
      const body = await response.json() as AccountListResponseDto & { error?: string };
      if (!response.ok) throw new Error(body.error || '账号列表暂不可用');
      if (!isCurrent()) return;
      const currentFilters = { windowKey, status, platform, groupId, pageSize };
      const nextFilters = reconcileAccountFilterPreferences(currentFilters, body.facets);
      const correctedFilters = nextFilters !== currentFilters;
      if (nextFilters.platform !== platform) setPlatform('');
      if (nextFilters.groupId !== groupId) setGroupId(null);
      if (correctedFilters) persistFilters(nextFilters);
      setList(body);
      setPage(correctedFilters ? 1 : body.pagination.page);
      setListError(null);
    } catch (reason) {
      if (isCurrent()) setListError(reason instanceof Error ? reason.message : '账号列表暂不可用');
    } finally {
      if (isCurrent()) {
        setListLoading(false);
        setListRefreshing(false);
      }
    }
  }, [deferredSearch, filtersReady, groupId, page, pageSize, persistFilters, platform, sortReady, sortState, status, windowKey]);

  useEffect(() => { void fetchOverview(); }, [fetchOverview]);
  useEffect(() => { void fetchList(); }, [fetchList]);

  const toggleAlert = useCallback(async (accountId: number, previous: boolean, enabled: boolean) => {
    const patch = (value: boolean) => setList((prev) => prev
      ? { ...prev, accounts: prev.accounts.map((account) => account.id === accountId ? { ...account, alertEnabled: value } : account) }
      : prev);
    const result = await runAccountAlertToggle({
      accountId,
      previous,
      requested: enabled,
      pending: pendingAlertAccountsRef.current,
      apply: patch,
      setPending: (id, pending) => setPendingAlertAccounts((current) => {
        const next = new Set(current);
        if (pending) next.add(id); else next.delete(id);
        return next;
      }),
      save: async (value) => {
        const response = await apiFetch(`/api/accounts/${accountId}/alert-enabled`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: value }),
        });
        const body = await response.json().catch(() => null) as { enabled?: unknown } | null;
        if (!response.ok || typeof body?.enabled !== 'boolean') throw new Error();
        return body.enabled;
      },
    });
    if (result === 'saved') void fetchList();
    if (result === 'failed') toast.error('账号告警开关保存失败');
  }, [fetchList]);

  const changeWindow = (value: AccountWindowKey) => { setPage(1); setWindowKey(value); persistFilters({ windowKey: value }); };
  const changeStatus = (value: AccountStatusFilter) => { setPage(1); setStatus(value); persistFilters({ status: value }); };
  const changePlatform = (value: string) => {
    const next = value === 'all' ? '' : value;
    setPage(1); setPlatform(next); persistFilters({ platform: next });
  };
  const changeGroup = (value: string) => {
    const next = value === 'all' ? null : Number(value);
    setPage(1); setGroupId(next); persistFilters({ groupId: next });
  };
  const changePageSize = (value: string) => {
    const next = Number(value) as AccountPageSize;
    setPage(1); setPageSize(next); persistFilters({ pageSize: next });
  };
  const updateSort = useCallback((next: AccountSortState) => {
    setPage(1);
    setSortState(next);
    writeAccountSortStateSafely(() => window.localStorage, next);
  }, []);
  const toggleSortKey = useCallback((key: AccountSortKey) => {
    updateSort(sortState.key === key
      ? { key, order: sortState.order === 'asc' ? 'desc' : 'asc' }
      : { key, order: 'asc' });
  }, [sortState, updateSort]);
  const PageIcon = listOnly ? ChartNoAxesCombined : LayoutDashboard;
  const title = listOnly ? '账号' : '总览';
  const activeWindow = list?.window ?? overview?.window;
  const loading = listLoading || (!listOnly && overviewLoading);
  const refreshing = listRefreshing || (!listOnly && overviewRefreshing);
  const refresh = () => {
    setListRefreshing(true);
    void fetchList();
    if (!listOnly) {
      setOverviewRefreshing(true);
      void fetchOverview();
    }
  };

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        icon={PageIcon}
        title={title}
        description={activeWindow ? `${activeWindow.label} · 最后完整分钟 ${formatBeijing(activeWindow.lastCompleteMinute)}` : '账号真实流量'}
        actions={<Button variant="outline" size="sm" disabled={refreshing || loading} onClick={refresh}><RefreshCw data-icon="inline-start" className={cn(refreshing && 'animate-spin')} />刷新</Button>}
      />

      <div className="flex min-w-0 flex-col gap-3 border-y py-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <Tabs value={windowKey} onValueChange={(value) => changeWindow(value as AccountWindowKey)} aria-label="筛选时间窗口">
            <TabsList className="grid h-auto w-full grid-cols-3">
              {WINDOW_OPTIONS.map((option) => <TabsTrigger key={option.value} value={option.value} className="px-2">{option.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
        <div className="min-w-0">
          <Tabs value={status} onValueChange={(value) => changeStatus(value as AccountStatusFilter)} aria-label="筛选状态">
            <TabsList className="grid h-auto w-full grid-cols-3">
              {STATUS_OPTIONS.map((option) => <TabsTrigger key={option.value} value={option.value} className="px-2">{option.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {overviewError ? <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{overviewError}{overview ? '，已保留上次总览' : ''}</div> : null}
      {!listOnly && overview && !overview.coverage.complete ? <CoverageNotice data={overview} /> : null}

      {!listOnly ? overviewLoading && !overview ? <OverviewSkeleton /> : overview ? <>
            <SummaryGrid data={overview} />
            <section className="space-y-3 border-y py-4" aria-labelledby="overview-trend-heading">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 id="overview-trend-heading" className="text-sm font-semibold">总体趋势</h2>
                <Tabs value={trendView} onValueChange={(value) => setTrendView(value as keyof typeof TREND_VIEWS)}>
                  <TabsList className="grid h-auto w-full grid-cols-3 sm:w-auto">
                    {Object.entries(TREND_VIEWS).map(([key, view]) => <TabsTrigger key={key} value={key}>{view.label}</TabsTrigger>)}
                  </TabsList>
                </Tabs>
              </div>
              <AccountTrendChart data={overview.trend} series={TREND_VIEWS[trendView].series} window={overview.window} coverage={overview.coverage} />
            </section>
          </> : <div className="py-10 text-center text-sm text-muted-foreground">无法加载总览数据</div> : null}

      <section className="min-w-0 space-y-3" aria-labelledby="account-list-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="account-list-heading" className="text-sm font-semibold">账号列表</h2>
          <span className="text-xs text-muted-foreground">{list?.pagination.totalItems ?? 0} 个账号</span>
        </div>
        <AccountFilters search={search} onSearch={setSearch} platform={platform} onPlatform={changePlatform} groupId={groupId} onGroup={changeGroup} platforms={list?.facets.platforms ?? []} groups={list?.facets.groups ?? []} />
        {listError ? <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{listError}{list ? '，已保留上次列表' : ''}</div> : null}
        {listLoading && !list ? <Skeleton className="h-64" /> : list
          ? <AccountList data={list} accounts={list.accounts} coverage={overview?.coverage} pageSize={pageSize} onPageSizeChange={changePageSize} onPageChange={setPage} sortState={sortState} onSort={toggleSortKey} onSortChange={updateSort} pendingAlertAccounts={pendingAlertAccounts} onToggleAlert={toggleAlert} />
          : <div className="rounded-md border py-12 text-center text-sm text-muted-foreground">无法加载账号列表</div>}
      </section>
    </div>
  );
}

function SummaryGrid({ data }: { data: AccountOverviewResponseDto }) {
  const values: Record<AccountMetricKey, number | string | null> = {
    ...data.summary,
    balanceUsd: data.summary.balanceUsd ?? null,
    selectedAccountCount: data.summary.selectedAccountCount,
    openAlertCount: data.openAlertCount,
  };
  return <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
    <div className="flex min-h-28 flex-col justify-between rounded-md border bg-card p-3"><MetricDefinitionTooltip metric="selectedAccountCount" value={`${data.summary.schedulableAccountCount} / ${data.summary.selectedAccountCount}`} window={data.window} coverage={data.coverage} /><span className="text-xs text-muted-foreground">可调度 / 当前筛选</span></div>
    {SUMMARY_METRICS.map((key) => <div key={key} className="flex min-h-28 flex-col justify-between rounded-md border bg-card p-3"><MetricDefinitionTooltip metric={key} value={formatAccountMetric(key, values[key])} window={data.window} coverage={data.coverage} /><span className="text-xs text-muted-foreground">{data.coverage.complete ? data.window.label : '已覆盖部分'}</span></div>)}
    <div className="flex min-h-28 flex-col justify-between rounded-md border bg-card p-3"><MetricDefinitionTooltip metric="openAlertCount" value={formatAccountMetric('openAlertCount', data.openAlertCount)} window={data.window} coverage={data.coverage} /><span className="text-xs text-muted-foreground">当前筛选账号</span></div>
  </div>;
}

function AccountFilters({ search, onSearch, platform, onPlatform, groupId, onGroup, platforms, groups }: { search: string; onSearch: (value: string) => void; platform: string; onPlatform: (value: string) => void; groupId: number | null; onGroup: (value: string) => void; platforms: string[]; groups: Array<{ id: number; name: string }> }) {
  return <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_12rem_12rem]">
    <div className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索账号、平台或分组" className="pl-9" /></div>
    <Select value={platform || 'all'} onValueChange={(value) => onPlatform(value === 'all' ? '' : value)}><SelectTrigger aria-label="筛选平台"><SelectValue placeholder="筛选平台" /></SelectTrigger><SelectContent><SelectItem value="all">全部平台</SelectItem>{platforms.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
    <Select value={groupId === null ? 'all' : String(groupId)} onValueChange={onGroup}><SelectTrigger aria-label="筛选分组"><SelectValue placeholder="筛选分组" /></SelectTrigger><SelectContent><SelectItem value="all">全部分组</SelectItem>{groups.map((group) => <SelectItem key={group.id} value={String(group.id)}>{group.name}</SelectItem>)}</SelectContent></Select>
  </div>;
}

function AccountList({ data, accounts, coverage, pageSize, onPageSizeChange, onPageChange, sortState, onSort, onSortChange, pendingAlertAccounts, onToggleAlert }: {
  data: AccountListResponseDto;
  accounts: AccountListItemDto[];
  coverage?: AccountCoverageDto;
  pageSize: AccountPageSize;
  onPageSizeChange: (value: string) => void;
  onPageChange: (page: number) => void;
  sortState: AccountSortState;
  onSort: (key: AccountSortKey) => void;
  onSortChange: (state: AccountSortState) => void;
  pendingAlertAccounts: Set<number>;
  onToggleAlert: (accountId: number, previous: boolean, enabled: boolean) => void;
}) {
  const { page, totalItems, totalPages } = data.pagination;
  const rangeStart = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = totalItems === 0 ? 0 : Math.min(page * pageSize, totalItems);
  const paginationItems = getPaginationItems(page, totalPages);
  const changePage = (next: number) => onPageChange(Math.min(Math.max(1, next), Math.max(1, totalPages)));
  const renderAccountPageItem = (item: AccountPaginationItem, index: number) => item === 'ellipsis'
    ? <PaginationItem key={`ellipsis-${index}`}><PaginationEllipsis /></PaginationItem>
    : <PaginationItem key={item}>
      <PaginationLink href="#account-list-heading" isActive={item === page} onClick={(event) => { event.preventDefault(); changePage(item); }}>{item}</PaginationLink>
    </PaginationItem>;

  return <>
    <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] gap-2 md:hidden">
      <Select value={sortState.key} onValueChange={(key) => onSortChange({ key: key as AccountSortKey, order: 'asc' })}>
        <SelectTrigger aria-label="选择账号排序字段" className="h-10"><SelectValue /></SelectTrigger>
        <SelectContent>{ACCOUNT_SORT_KEYS.map((key) => <SelectItem key={key} value={key}>{ACCOUNT_SORT_LABELS[key]}</SelectItem>)}</SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="outline" size="icon" className="size-10" aria-label={`切换为${sortState.order === 'asc' ? '降序' : '升序'}`} onClick={() => onSortChange({ ...sortState, order: sortState.order === 'asc' ? 'desc' : 'asc' })}>
            {sortState.order === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{sortState.order === 'asc' ? '当前升序' : '当前降序'}</TooltipContent>
      </Tooltip>
    </div>
    {accounts.length === 0 ? <div className="rounded-md border py-12 text-center text-sm text-muted-foreground">暂无账号数据</div> : <>
    <div className="hidden overflow-x-auto rounded-md border md:block">
      <table className="w-full min-w-[1180px] text-sm">
        <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_hsl(var(--border))]"><tr className="text-left">
          <SortableAccountHeader sortKey="account" state={sortState} onSort={onSort} />
          <SortableAccountHeader sortKey="platformGroup" state={sortState} onSort={onSort} />
          <SortableAccountHeader sortKey="schedulable" state={sortState} onSort={onSort} />
          <SortableAccountHeader sortKey="availability" metric="availability" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="errorRate" metric="errorRate" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="durationP95Ms" metric="durationP95Ms" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="firstTokenP95Ms" metric="firstTokenP95Ms" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="cacheHitRate" metric="cacheHitRate" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="userBilledUsd" metric="userBilledUsd" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="accountBilledUsd" metric="accountBilledUsd" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="balanceUsd" metric="balanceUsd" state={sortState} onSort={onSort} window={data.window} coverage={coverage} title="上游余额" />
          <SortableAccountHeader sortKey="eligibleCount" metric="eligibleCount" state={sortState} onSort={onSort} window={data.window} coverage={coverage} />
          <SortableAccountHeader sortKey="sync" state={sortState} onSort={onSort} />
          <SortableAccountHeader sortKey="alertEnabled" state={sortState} onSort={onSort} />
        </tr></thead>
        <tbody>{accounts.map((account) => <AccountTableRow key={account.id} account={account} pending={pendingAlertAccounts.has(account.id)} onToggleAlert={onToggleAlert} />)}</tbody>
      </table>
    </div>
    <div className="space-y-2 md:hidden">{accounts.map((account) => <AccountMobileRow key={account.id} account={account} window={data.window} coverage={coverage} pending={pendingAlertAccounts.has(account.id)} onToggleAlert={onToggleAlert} />)}</div>
    </>}
    <div className="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>第 {rangeStart}-{rangeEnd} 条，共 {totalItems} 条</span>
        <Select value={String(pageSize)} onValueChange={onPageSizeChange}>
          <SelectTrigger aria-label="每页账号数" className="h-9 w-24"><SelectValue /></SelectTrigger>
          <SelectContent>{ACCOUNT_PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} / 页</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Pagination className="mx-0 w-auto justify-start sm:justify-end">
        <PaginationContent>
          <PaginationItem><PaginationPrevious href="#account-list-heading" aria-disabled={page <= 1} tabIndex={page <= 1 ? -1 : 0} className={cn(page <= 1 && 'pointer-events-none opacity-50')} onClick={(event) => { event.preventDefault(); changePage(page - 1); }} /></PaginationItem>
          {(totalPages === 0 ? [] : paginationItems).map(renderAccountPageItem)}
          <PaginationItem><PaginationNext href="#account-list-heading" aria-disabled={page >= totalPages} tabIndex={page >= totalPages ? -1 : 0} className={cn(page >= totalPages && 'pointer-events-none opacity-50')} onClick={(event) => { event.preventDefault(); changePage(page + 1); }} /></PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  </>;
}

function SortableAccountHeader({ sortKey, metric, state, onSort, window, coverage, title }: { sortKey: AccountSortKey; metric?: AccountAggregateMetricKey; state: AccountSortState; onSort: (key: AccountSortKey) => void; window?: AccountWindowDto; coverage?: AccountCoverageDto; title?: string }) {
  const active = state.key === sortKey;
  const SortIcon = active ? state.order === 'asc' ? ArrowUp : ArrowDown : ArrowUpDown;
  const label = ACCOUNT_SORT_LABELS[sortKey];
  return <th className="px-3 py-3 font-medium" title={title} aria-sort={active ? state.order === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <button type="button" className="inline-flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSort(sortKey)} aria-label={`${label}，点击切换排序`}>
        {label}<SortIcon className="size-3.5" aria-hidden="true" />
      </button>
      {metric ? <MetricDefinitionTooltip metric={metric} compact iconOnly window={window} coverage={coverage} /> : null}
    </span>
  </th>;
}

function AccountTableRow({ account, pending, onToggleAlert }: { account: AccountListItemDto; pending: boolean; onToggleAlert: (accountId: number, previous: boolean, enabled: boolean) => void }) {
  const metrics = account.metrics;
  return <tr className="border-b last:border-0 hover:bg-muted/40">
    <td className="px-3 py-3"><Link href={`/accounts/${account.id}`} className="font-medium text-primary hover:underline">{account.name}</Link><div className="text-xs text-muted-foreground">{account.type ?? '未知类型'}</div></td>
    <td className="max-w-56 px-3 py-3"><div>{account.platform ?? '未知平台'}</div><div className="truncate text-xs text-muted-foreground">{formatAccountGroups(account.groupProjection)}</div></td>
    <td className="px-3 py-3"><Badge variant={account.schedulable ? 'outline' : 'destructive'}>{account.schedulable ? '可调度' : '不可调度'}</Badge></td>
    {ACCOUNT_LIST_METRICS.map((key) => <td key={key} className="whitespace-nowrap px-3 py-3 tabular-nums">{formatAccountMetric(key, metrics[key])}</td>)}
    <td className="px-3 py-3">{accountDataIsStale(account) ? <Badge variant="destructive">数据同步延迟</Badge> : <span className="whitespace-nowrap text-xs text-muted-foreground">{formatBeijing(account.lastSyncedAt)}</span>}</td>
    <td className="px-3 py-3"><Switch checked={account.alertEnabled} disabled={pending} onCheckedChange={(value) => onToggleAlert(account.id, account.alertEnabled, value)} aria-label={`账号 ${account.name} 告警开关`} /></td>
  </tr>;
}

function AccountMobileRow({ account, window, coverage, pending, onToggleAlert }: { account: AccountListItemDto; window: AccountWindowDto; coverage?: AccountCoverageDto; pending: boolean; onToggleAlert: (accountId: number, previous: boolean, enabled: boolean) => void }) {
  return <article className="rounded-md border bg-card p-3">
    <div className="flex min-w-0 items-start justify-between gap-2"><div className="min-w-0"><Link href={`/accounts/${account.id}`} className="block truncate font-medium text-primary">{account.name}</Link><p className="truncate text-xs text-muted-foreground">{account.platform ?? '未知平台'} · {formatAccountGroups(account.groupProjection)}</p></div><Badge variant={account.schedulable ? 'outline' : 'destructive'} className="shrink-0">{account.schedulable ? '可调度' : '不可调度'}</Badge></div>
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">{ACCOUNT_LIST_METRICS.filter((key) => key !== 'eligibleCount').map((key) => <div key={key} className="min-w-0"><dt><MetricDefinitionTooltip metric={key} compact window={window} coverage={coverage} /></dt><dd className="truncate font-medium tabular-nums">{formatAccountMetric(key, account.metrics[key])}</dd></div>)}</dl>
    <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{accountDataIsStale(account) ? <span className="text-destructive">数据同步延迟</span> : `同步 ${formatBeijing(account.lastSyncedAt)}`}</span>
      <label className="flex items-center gap-2"><span>告警</span><Switch checked={account.alertEnabled} disabled={pending} onCheckedChange={(value) => onToggleAlert(account.id, account.alertEnabled, value)} aria-label={`账号 ${account.name} 告警开关`} /></label>
    </div>
  </article>;
}

function CoverageNotice({ data }: { data: AccountOverviewResponseDto }) {
  const reason = data.coverage.status === 'before_backfill' ? '上线前未回填' : data.coverage.status === 'collection_delay' ? '采集延迟' : '中间时段存在缺口';
  return <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm"><Badge className="bg-warning text-warning-foreground">数据不完整</Badge><span>{reason}，已覆盖 {data.coverage.actualMinutes}/{data.coverage.expectedMinutes} 分钟</span></div>;
}

function OverviewSkeleton() {
  return <div className="space-y-4"><div className="grid grid-cols-2 gap-2 lg:grid-cols-5">{Array.from({ length: 10 }, (_, index) => <Skeleton key={index} className="h-28" />)}</div><Skeleton className="h-72" /><Skeleton className="h-64" /></div>;
}

function formatBeijing(value: string | null): string {
  if (!value) return '暂无数据';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
