'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChartNoAxesCombined, LayoutDashboard, RefreshCw, Search } from 'lucide-react';
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
import { PageHeader } from '@/components/page-header';
import { formatAccountMetric, type AccountAggregateMetricKey, type AccountMetricKey } from '@/lib/account-metric-definitions';
import type { AccountOverviewDto, AccountStatusFilter, AccountSummaryDto, AccountWindowKey } from '@/lib/account-observability-ui';
import { accountDataIsStale, formatAccountGroups } from '@/lib/account-observability/presentation';
import { runAccountAlertToggle } from '@/lib/account-alert-toggle';
import { apiFetch } from '@/lib/api-fetch';
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

export function AccountOverview({ listOnly = false }: { listOnly?: boolean }) {
  const [data, setData] = useState<AccountOverviewDto | null>(null);
  const [windowKey, setWindowKey] = useState<AccountWindowKey>('last1h');
  const [status, setStatus] = useState<AccountStatusFilter>('schedulable');
  const [platform, setPlatform] = useState('');
  const [group, setGroup] = useState('');
  const [search, setSearch] = useState('');
  const [deferredSearch, setDeferredSearch] = useState('');
  const [trendView, setTrendView] = useState<keyof typeof TREND_VIEWS>('quality');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAlertAccounts, setPendingAlertAccounts] = useState<Set<number>>(() => new Set());
  const pendingAlertAccountsRef = useRef(new Set<number>());
  const requestSequence = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDeferredSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const fetchOverview = useCallback(async () => {
    const isCurrent = beginLatestRequest(requestSequence);
    const params = new URLSearchParams({ window: windowKey, status });
    if (platform) params.set('platform', platform);
    if (group.trim()) params.set('group', group.trim());
    if (deferredSearch) params.set('search', deferredSearch);
    try {
      const response = await apiFetch(`/api/accounts/overview?${params.toString()}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '账号指标暂不可用');
      if (!isCurrent()) return;
      setData(body as AccountOverviewDto);
      setError(null);
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : '账号指标暂不可用');
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [deferredSearch, group, platform, status, windowKey]);

  useEffect(() => { void fetchOverview(); }, [fetchOverview]);

  const toggleAlert = useCallback(async (accountId: number, previous: boolean, enabled: boolean) => {
    const patch = (value: boolean) => setData((prev) => prev
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
    if (result === 'saved') void fetchOverview();
    if (result === 'failed') toast.error('账号告警开关保存失败');
  }, [fetchOverview]);

  const platforms = useMemo(() => Array.from(new Set((data?.accounts ?? []).map((item) => item.platform).filter((value): value is string => Boolean(value)))).sort(), [data]);
  const PageIcon = listOnly ? ChartNoAxesCombined : LayoutDashboard;
  const title = listOnly ? '账号' : '总览';

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        icon={PageIcon}
        title={title}
        description={data ? `${data.window.label} · 最后完整分钟 ${formatBeijing(data.window.lastCompleteMinute)}` : '账号真实流量'}
        actions={<Button variant="outline" size="sm" disabled={refreshing || loading} onClick={() => { setRefreshing(true); void fetchOverview(); }}><RefreshCw data-icon="inline-start" className={cn(refreshing && 'animate-spin')} />刷新</Button>}
      />

      <div className="flex min-w-0 flex-col gap-3 border-y py-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <Tabs value={windowKey} onValueChange={(value) => setWindowKey(value as AccountWindowKey)} aria-label="筛选时间窗口">
            <TabsList className="grid h-auto w-full grid-cols-3">
              {WINDOW_OPTIONS.map((option) => <TabsTrigger key={option.value} value={option.value} className="px-2">{option.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
        <div className="min-w-0">
          <Tabs value={status} onValueChange={(value) => setStatus(value as AccountStatusFilter)} aria-label="筛选状态">
            <TabsList className="grid h-auto w-full grid-cols-3">
              {STATUS_OPTIONS.map((option) => <TabsTrigger key={option.value} value={option.value} className="px-2">{option.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {error ? <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{error}{data ? '，已保留上次数据' : ''}</div> : null}
      {data && !data.coverage.complete ? <CoverageNotice data={data} /> : null}

      {loading && !data ? <OverviewSkeleton /> : data ? (
        <>
          {!listOnly ? <>
            <SummaryGrid data={data} />
            <section className="space-y-3 border-y py-4" aria-labelledby="overview-trend-heading">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 id="overview-trend-heading" className="text-sm font-semibold">总体趋势</h2>
                <Tabs value={trendView} onValueChange={(value) => setTrendView(value as keyof typeof TREND_VIEWS)}>
                  <TabsList className="grid h-auto w-full grid-cols-3 sm:w-auto">
                    {Object.entries(TREND_VIEWS).map(([key, view]) => <TabsTrigger key={key} value={key}>{view.label}</TabsTrigger>)}
                  </TabsList>
                </Tabs>
              </div>
              <AccountTrendChart data={data.trend} series={TREND_VIEWS[trendView].series} window={data.window} coverage={data.coverage} />
            </section>
          </> : null}

          <section className="min-w-0 space-y-3" aria-labelledby="account-list-heading">
            <div className="flex items-center justify-between gap-3">
              <h2 id="account-list-heading" className="text-sm font-semibold">账号列表</h2>
              <span className="text-xs text-muted-foreground">{data.summary.selectedAccountCount} 个账号</span>
            </div>
            <AccountFilters search={search} onSearch={setSearch} platform={platform} onPlatform={setPlatform} group={group} onGroup={setGroup} platforms={platforms} />
            <AccountList data={data} pendingAlertAccounts={pendingAlertAccounts} onToggleAlert={toggleAlert} />
          </section>
        </>
      ) : <div className="py-16 text-center text-sm text-muted-foreground">无法加载账号数据</div>}
    </div>
  );
}

function SummaryGrid({ data }: { data: AccountOverviewDto }) {
  const values: Record<AccountMetricKey, number | string | null> = {
    ...data.summary,
    selectedAccountCount: data.summary.selectedAccountCount,
    openAlertCount: data.openAlertCount,
  };
  return <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
    <div className="flex min-h-28 flex-col justify-between rounded-md border bg-card p-3"><MetricDefinitionTooltip metric="selectedAccountCount" value={`${data.summary.schedulableAccountCount} / ${data.summary.selectedAccountCount}`} window={data.window} coverage={data.coverage} /><span className="text-xs text-muted-foreground">可调度 / 当前筛选</span></div>
    {SUMMARY_METRICS.map((key) => <div key={key} className="flex min-h-28 flex-col justify-between rounded-md border bg-card p-3"><MetricDefinitionTooltip metric={key} value={formatAccountMetric(key, values[key])} window={data.window} coverage={data.coverage} /><span className="text-xs text-muted-foreground">{data.coverage.complete ? data.window.label : '已覆盖部分'}</span></div>)}
    <div className="flex min-h-28 flex-col justify-between rounded-md border bg-card p-3"><MetricDefinitionTooltip metric="openAlertCount" value={formatAccountMetric('openAlertCount', data.openAlertCount)} window={data.window} coverage={data.coverage} /><span className="text-xs text-muted-foreground">当前筛选账号</span></div>
  </div>;
}

function AccountFilters({ search, onSearch, platform, onPlatform, group, onGroup, platforms }: { search: string; onSearch: (value: string) => void; platform: string; onPlatform: (value: string) => void; group: string; onGroup: (value: string) => void; platforms: string[] }) {
  return <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_12rem_12rem]">
    <div className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索账号、平台或分组" className="pl-9" /></div>
    <Select value={platform || 'all'} onValueChange={(value) => onPlatform(value === 'all' ? '' : value)}><SelectTrigger aria-label="筛选平台"><SelectValue placeholder="筛选平台" /></SelectTrigger><SelectContent><SelectItem value="all">全部平台</SelectItem>{platforms.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
    <Input value={group} onChange={(event) => onGroup(event.target.value)} placeholder="筛选分组" aria-label="筛选分组" />
  </div>;
}

function AccountList({ data, pendingAlertAccounts, onToggleAlert }: { data: AccountOverviewDto; pendingAlertAccounts: Set<number>; onToggleAlert: (accountId: number, previous: boolean, enabled: boolean) => void }) {
  if (data.accounts.length === 0) return <div className="rounded-md border py-12 text-center text-sm text-muted-foreground">暂无账号数据</div>;
  return <>
    <div className="hidden max-h-[34rem] overflow-auto rounded-md border md:block">
      <table className="w-full min-w-[1180px] text-sm">
        <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_hsl(var(--border))]"><tr className="text-left">
          <th className="px-3 py-3 font-medium">账号</th><th className="px-3 py-3 font-medium">平台 / 分组</th><th className="px-3 py-3 font-medium">调度</th>
          {(['availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'userBilledUsd', 'accountBilledUsd', 'eligibleCount'] as AccountAggregateMetricKey[]).map((key) => <th key={key} className="px-3 py-3 font-medium"><MetricDefinitionTooltip metric={key} compact window={data.window} coverage={data.coverage} /></th>)}
          <th className="px-3 py-3 font-medium">同步</th><th className="px-3 py-3 font-medium">告警</th>
        </tr></thead>
        <tbody>{data.accounts.map((account) => <AccountTableRow key={account.id} account={account} pending={pendingAlertAccounts.has(account.id)} onToggleAlert={onToggleAlert} />)}</tbody>
      </table>
    </div>
    <div className="space-y-2 md:hidden">{data.accounts.map((account) => <AccountMobileRow key={account.id} account={account} window={data.window} coverage={data.coverage} pending={pendingAlertAccounts.has(account.id)} onToggleAlert={onToggleAlert} />)}</div>
  </>;
}

function AccountTableRow({ account, pending, onToggleAlert }: { account: AccountSummaryDto; pending: boolean; onToggleAlert: (accountId: number, previous: boolean, enabled: boolean) => void }) {
  const metrics = account.metrics;
  return <tr className="border-b last:border-0 hover:bg-muted/40">
    <td className="px-3 py-3"><Link href={`/accounts/${account.id}`} className="font-medium text-primary hover:underline">{account.name}</Link><div className="text-xs text-muted-foreground">{account.type ?? '未知类型'}</div></td>
    <td className="max-w-56 px-3 py-3"><div>{account.platform ?? '未知平台'}</div><div className="truncate text-xs text-muted-foreground">{formatAccountGroups(account.groupProjection)}</div></td>
    <td className="px-3 py-3"><Badge variant={account.schedulable ? 'outline' : 'destructive'}>{account.schedulable ? '可调度' : '不可调度'}</Badge></td>
    {(['availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'userBilledUsd', 'accountBilledUsd', 'eligibleCount'] as AccountAggregateMetricKey[]).map((key) => <td key={key} className="whitespace-nowrap px-3 py-3 tabular-nums">{formatAccountMetric(key, metrics[key])}</td>)}
    <td className="px-3 py-3">{accountDataIsStale(account) ? <Badge variant="destructive">数据同步延迟</Badge> : <span className="whitespace-nowrap text-xs text-muted-foreground">{formatBeijing(account.lastSyncedAt)}</span>}</td>
    <td className="px-3 py-3"><Switch checked={account.alertEnabled} disabled={pending} onCheckedChange={(value) => onToggleAlert(account.id, account.alertEnabled, value)} aria-label={`账号 ${account.name} 告警开关`} /></td>
  </tr>;
}

function AccountMobileRow({ account, window, coverage, pending, onToggleAlert }: { account: AccountSummaryDto; window: AccountOverviewDto['window']; coverage: AccountOverviewDto['coverage']; pending: boolean; onToggleAlert: (accountId: number, previous: boolean, enabled: boolean) => void }) {
  return <article className="rounded-md border bg-card p-3">
    <div className="flex min-w-0 items-start justify-between gap-2"><div className="min-w-0"><Link href={`/accounts/${account.id}`} className="block truncate font-medium text-primary">{account.name}</Link><p className="truncate text-xs text-muted-foreground">{account.platform ?? '未知平台'} · {formatAccountGroups(account.groupProjection)}</p></div><Badge variant={account.schedulable ? 'outline' : 'destructive'} className="shrink-0">{account.schedulable ? '可调度' : '不可调度'}</Badge></div>
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">{(['availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'userBilledUsd', 'accountBilledUsd'] as AccountAggregateMetricKey[]).map((key) => <div key={key} className="min-w-0"><dt><MetricDefinitionTooltip metric={key} compact window={window} coverage={coverage} /></dt><dd className="truncate font-medium tabular-nums">{formatAccountMetric(key, account.metrics[key])}</dd></div>)}</dl>
    <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{accountDataIsStale(account) ? <span className="text-destructive">数据同步延迟</span> : `同步 ${formatBeijing(account.lastSyncedAt)}`}</span>
      <label className="flex items-center gap-2"><span>告警</span><Switch checked={account.alertEnabled} disabled={pending} onCheckedChange={(value) => onToggleAlert(account.id, account.alertEnabled, value)} aria-label={`账号 ${account.name} 告警开关`} /></label>
    </div>
  </article>;
}

function CoverageNotice({ data }: { data: AccountOverviewDto }) {
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
