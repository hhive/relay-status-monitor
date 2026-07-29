'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChartNoAxesCombined, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AccountTrendChart, type AccountTrendSeries } from '@/components/account-observability/account-trend-chart';
import { MetricDefinitionTooltip } from '@/components/account-observability/metric-definition-tooltip';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatAccountMetric, type AccountAggregateMetricKey } from '@/lib/account-metric-definitions';
import type { AccountDetailDto, AccountTrendPointDto, AccountWindowKey } from '@/lib/account-observability-ui';
import { formatAccountGroups } from '@/lib/account-observability/presentation';
import { runAccountAlertToggle } from '@/lib/account-alert-toggle';
import { apiFetch } from '@/lib/api-fetch';
import { beginLatestRequest } from '@/lib/request-sequence';

const WINDOW_OPTIONS: Array<{ value: AccountWindowKey; label: string }> = [
  { value: 'today', label: '北京时间今日' },
  { value: 'last1h', label: '近 1 小时' },
  { value: 'last24h', label: '近 24 小时' },
];

const DETAIL_TRENDS: Record<'quality' | 'latency' | 'cache' | 'billing' | 'errors', { label: string; series: AccountTrendSeries[] }> = {
  quality: { label: '流量质量', series: [{ key: 'availability', color: 'hsl(var(--success))' }, { key: 'errorRate', color: 'hsl(var(--destructive))' }, { key: 'eligibleCount', color: 'hsl(var(--chart-2))' }] },
  latency: { label: '延迟', series: [{ key: 'averageDurationMs', color: 'hsl(var(--chart-2))' }, { key: 'durationP95Ms', color: 'hsl(var(--warning))' }, { key: 'firstTokenP95Ms', color: 'hsl(var(--chart-1))' }] },
  cache: { label: '缓存', series: [{ key: 'cacheHitRate', color: 'hsl(var(--success))' }, { key: 'promptTokens', color: 'hsl(var(--chart-2))' }] },
  billing: { label: '计费', series: [{ key: 'userBilledUsd', color: 'hsl(var(--chart-1))' }, { key: 'accountBilledUsd', color: 'hsl(var(--warning))' }] },
  errors: { label: '错误分布', series: [{ key: 'successCount', color: 'hsl(var(--success))' }, { key: 'upstreamErrorCount', color: 'hsl(var(--destructive))' }] },
};

const SUMMARY_KEYS: AccountAggregateMetricKey[] = ['availability', 'errorRate', 'averageDurationMs', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'userBilledUsd', 'accountBilledUsd', 'successCount', 'upstreamErrorCount'];

type BalanceMode = 'auto' | 'sub2api' | 'newapi';

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<AccountDetailDto | null>(null);
  const [windowKey, setWindowKey] = useState<AccountWindowKey>('last1h');
  const [trendView, setTrendView] = useState<keyof typeof DETAIL_TRENDS>('quality');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [alertThreshold, setAlertThreshold] = useState('');
  const [masterAlertEnabled, setMasterAlertEnabled] = useState(true);
  const [masterAlertPending, setMasterAlertPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [balanceMode, setBalanceMode] = useState<BalanceMode>('auto');
  const [newApiUserId, setNewApiUserId] = useState('');
  const [newApiAccessToken, setNewApiAccessToken] = useState('');
  const [accessTokenConfigured, setAccessTokenConfigured] = useState(false);
  const [balanceCredentialPending, setBalanceCredentialPending] = useState(false);
  const masterAlertPendingRef = useRef(new Set<number>());
  const requestSequence = useRef(0);
  const billingAlertRuleRef = useRef<HTMLElement | null>(null);
  const billingAlertRuleFocused = useRef(false);

  useEffect(() => { void params.then(({ id }) => setAccountId(id)); }, [params]);

  const fetchDetail = useCallback(async () => {
    if (!accountId) return;
    const isCurrent = beginLatestRequest(requestSequence);
    setLoading(true);
    await apiFetch(`/api/accounts/${accountId}?window=${windowKey}`).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '账号指标暂不可用');
      if (isCurrent()) { setData(body as AccountDetailDto); setError(null); }
    }).catch((reason) => {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : '账号指标暂不可用');
    }).finally(() => { if (isCurrent()) setLoading(false); });
  }, [accountId, windowKey]);

  useEffect(() => { void fetchDetail(); }, [fetchDetail]);

  useEffect(() => {
    if (!accountId) return;
    void apiFetch(`/api/accounts/${accountId}/billing-alert`).then(async (response) => {
      if (!response.ok) return;
      const alert = await response.json();
      setAlertEnabled(Boolean(alert.enabled));
      setAlertThreshold(alert.threshold == null ? '' : String(alert.threshold));
    });
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    void apiFetch(`/api/accounts/${accountId}/balance-credential`).then(async (response) => {
      if (!response.ok) return;
      const config = await response.json() as {
        mode: BalanceMode; newApiUserId: string | null; accessTokenConfigured: boolean;
      };
      setBalanceMode(config.mode);
      setNewApiUserId(config.newApiUserId ?? '');
      setAccessTokenConfigured(config.accessTokenConfigured);
      setNewApiAccessToken('');
    });
  }, [accountId]);

  useEffect(() => { if (data) setMasterAlertEnabled(data.alertEnabled); }, [data]);

  const errorDistributions = useMemo(() => ({
    statuses: mergeDistribution(data?.trend ?? [], 'errorStatusCounts'),
    phases: mergeDistribution(data?.trend ?? [], 'errorPhaseCounts'),
  }), [data]);

  async function toggleMasterAlert(enabled: boolean) {
    const result = await runAccountAlertToggle({
      accountId: Number(accountId),
      previous: masterAlertEnabled,
      requested: enabled,
      pending: masterAlertPendingRef.current,
      apply: setMasterAlertEnabled,
      setPending: (_id, pending) => setMasterAlertPending(pending),
      save: async (value) => {
        const response = await apiFetch(`/api/accounts/${accountId}/alert-enabled`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: value }) });
        const body = await response.json().catch(() => null) as { enabled?: unknown } | null;
        if (!response.ok || typeof body?.enabled !== 'boolean') throw new Error();
        return body.enabled;
      },
    });
    if (result === 'saved') {
      toast.success('账号告警开关已保存');
      void fetchDetail();
    }
    if (result === 'failed') toast.error('账号告警开关保存失败');
  }

  useEffect(() => {
    if (!data || billingAlertRuleFocused.current || window.location.hash !== '#billing-alert-rule') return;
    const target = billingAlertRuleRef.current;
    if (!target) return;
    billingAlertRuleFocused.current = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
  }, [data]);

  async function saveBillingAlert() {
    const threshold = Number(alertThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) { toast.error('请输入有效的倍率阈值'); return; }
    setSaving(true);
    try {
      const response = await apiFetch(`/api/accounts/${accountId}/billing-alert`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: alertEnabled, threshold }) });
      if (!response.ok) throw new Error();
      toast.success('倍率告警已保存');
    } catch { toast.error('倍率告警保存失败'); } finally { setSaving(false); }
  }

  async function saveBalanceCredential() {
    setBalanceCredentialPending(true);
    try {
      const response = await apiFetch(`/api/accounts/${accountId}/balance-credential`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: balanceMode,
          newApiUserId,
          ...(newApiAccessToken.trim() ? { accessToken: newApiAccessToken } : {}),
        }),
      });
      const body = await response.json() as { error?: string; accessTokenConfigured?: boolean };
      if (!response.ok) throw new Error(body.error || '余额凭据保存失败');
      setAccessTokenConfigured(Boolean(body.accessTokenConfigured));
      setNewApiAccessToken('');
      toast.success('余额接口配置已保存');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '余额凭据保存失败');
    } finally {
      setBalanceCredentialPending(false);
    }
  }

  async function clearBalanceCredential() {
    setBalanceCredentialPending(true);
    try {
      const response = await apiFetch(`/api/accounts/${accountId}/balance-credential`, { method: 'DELETE' });
      if (!response.ok) throw new Error();
      setBalanceMode('auto');
      setNewApiUserId('');
      setNewApiAccessToken('');
      setAccessTokenConfigured(false);
      toast.success('余额接口配置已清除');
    } catch {
      toast.error('余额接口配置清除失败');
    } finally {
      setBalanceCredentialPending(false);
    }
  }

  if (loading && !data) return <DetailSkeleton />;
  if (!data) return <div className="py-16 text-center text-sm text-muted-foreground">{error || '账号数据暂不可用'}</div>;

  const probeStale = data.billingProbe.freshAt != null && new Date(data.billingProbe.freshAt).getTime() < Date.now();
  return <div className="min-w-0 space-y-5">
    <PageHeader
      icon={ChartNoAxesCombined}
      title={data.name}
      description={`${data.platform ?? '未知平台'} · ${data.type ?? '未知类型'} · ${formatAccountGroups(data.groupProjection)}`}
      actions={<Button asChild variant="outline" size="sm"><Link href="/accounts"><ArrowLeft data-icon="inline-start" />返回账号列表</Link></Button>}
    />

    <div className="grid gap-3 border-y py-3 lg:grid-cols-[1fr_auto] lg:items-center">
      <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>远端状态：{data.remoteStatus ?? '未知'}</span><span>调度：{data.schedulable ? '可调度' : '不可调度'}</span><span>账号同步：{formatBeijing(data.lastSyncedAt)}</span><span>完整分钟：{formatBeijing(data.window.lastCompleteMinute)}</span>
      </div>
      <Tabs value={windowKey} onValueChange={(value) => setWindowKey(value as AccountWindowKey)}><TabsList className="grid h-auto w-full grid-cols-3">{WINDOW_OPTIONS.map((option) => <TabsTrigger key={option.value} value={option.value} className="px-2">{option.label}</TabsTrigger>)}</TabsList></Tabs>
    </div>

    {error ? <div role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}，已保留上次数据</div> : null}
    {!data.coverage.complete ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm"><Badge className="bg-warning text-warning-foreground">数据不完整</Badge><span>已覆盖 {data.coverage.actualMinutes}/{data.coverage.expectedMinutes} 分钟，累计值仅代表已覆盖部分</span></div> : null}

    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">{SUMMARY_KEYS.map((key) => <div key={key} className="flex min-h-24 items-start rounded-md border bg-card p-3"><MetricDefinitionTooltip metric={key} value={formatAccountMetric(key, data.summary[key])} window={data.window} coverage={data.coverage} /></div>)}</div>

    <section className="space-y-3 border-y py-4" aria-labelledby="account-trend-heading">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"><h2 id="account-trend-heading" className="text-sm font-semibold">账号趋势</h2><Tabs value={trendView} onValueChange={(value) => setTrendView(value as keyof typeof DETAIL_TRENDS)}><TabsList className="grid h-auto w-full grid-cols-3 gap-1 sm:grid-cols-5">{Object.entries(DETAIL_TRENDS).map(([key, view]) => <TabsTrigger key={key} value={key}>{view.label}</TabsTrigger>)}</TabsList></Tabs></div>
      <AccountTrendChart data={data.trend} series={DETAIL_TRENDS[trendView].series} window={data.window} coverage={data.coverage} />
      {trendView === 'errors' ? <div className="grid gap-3 sm:grid-cols-2"><Distribution title="错误码分布" values={errorDistributions.statuses} /><Distribution title="错误阶段分布" values={errorDistributions.phases} /></div> : null}
    </section>

    <section className="space-y-2 border-y py-4" aria-labelledby="account-alert-heading">
      <div className="flex flex-col gap-1"><h2 id="account-alert-heading" className="text-sm font-semibold">账号告警总开关</h2><p className="text-xs text-muted-foreground">关闭后该账号的全部告警（全局规则与倍率告警）都不再触发或推送。</p></div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={masterAlertEnabled} disabled={masterAlertPending} onCheckedChange={(value) => void toggleMasterAlert(value)} aria-label="账号告警总开关" />{masterAlertEnabled ? '告警已开启' : '告警已关闭'}</label>
    </section>

    <section className="space-y-3 border-y py-4" aria-labelledby="upstream-billing-heading">
      <h2 id="upstream-billing-heading" className="text-sm font-semibold">上游计费状态</h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-muted-foreground">上游余额</dt><dd className="mt-1 font-medium tabular-nums">{formatAccountMetric('balanceUsd', data.upstream.balanceUsd)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">接口倍率</dt><dd className="mt-1 font-medium tabular-nums">{formatAccountMetric('upstreamRateMultiplier', data.upstream.apiRateMultiplier)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">估算倍率</dt><dd className="mt-1 font-medium tabular-nums">{formatAccountMetric('upstreamRateMultiplier', data.upstream.estimatedRateMultiplier)}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">采集分钟：{formatBeijing(data.upstream.collectedAt)}</p>
    </section>

    <section className="space-y-3 border-y py-4" aria-labelledby="balance-credential-heading">
      <div className="flex flex-col gap-1">
        <h2 id="balance-credential-heading" className="text-sm font-semibold">上游余额接口</h2>
        <p className="text-xs text-muted-foreground">Access Token：{accessTokenConfigured ? '已配置' : '未配置'}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span>余额接口模式</span>
          <Select value={balanceMode} onValueChange={(value) => setBalanceMode(value as BalanceMode)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">自动识别</SelectItem>
              <SelectItem value="sub2api">Sub2API</SelectItem>
              <SelectItem value="newapi">New API</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          <span>New API User ID</span>
          <Input inputMode="numeric" value={newApiUserId} onChange={(event) => setNewApiUserId(event.target.value)} disabled={balanceMode === 'sub2api'} />
        </label>
        <label className="space-y-1 text-sm">
          <span>New API Access Token</span>
          <Input type="password" autoComplete="new-password" value={newApiAccessToken} onChange={(event) => setNewApiAccessToken(event.target.value)} disabled={balanceMode === 'sub2api'} placeholder={accessTokenConfigured ? '留空则保留原 Token' : '请输入 Access Token'} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void saveBalanceCredential()} disabled={balanceCredentialPending || !accountId}><Save data-icon="inline-start" />保存余额接口</Button>
        <Button variant="outline" onClick={() => void clearBalanceCredential()} disabled={balanceCredentialPending || !accountId}><Trash2 data-icon="inline-start" />清除配置</Button>
      </div>
    </section>

    <section
      ref={billingAlertRuleRef}
      id="billing-alert-rule"
      tabIndex={-1}
      className="scroll-mt-4 space-y-3 border-y py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-labelledby="billing-probe-heading"
    >
      <div className="flex flex-col gap-1"><h2 id="billing-probe-heading" className="text-sm font-semibold">上游倍率设置</h2><p className="text-xs text-muted-foreground">当前有效倍率：{data.billingProbe.currentEffectiveRate ?? '暂无数据'} · 最近成功：{formatBeijing(data.billingProbe.lastSuccessAt)} · 探测状态：{probeStale ? '已过期' : data.billingProbe.status ?? '未探测'}</p>{probeStale ? <p className="text-xs text-warning">保留最后倍率 {data.billingProbe.resolvedRateMultiplier ?? '暂无数据'}，过期快照不用于当前倍率或告警。</p> : null}</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center"><label className="flex items-center gap-2 text-sm"><Switch checked={alertEnabled} onCheckedChange={setAlertEnabled} />启用倍率告警</label><Input className="w-full sm:w-36" type="number" min="0" step="0.01" value={alertThreshold} onChange={(event) => setAlertThreshold(event.target.value)} placeholder="倍率告警阈值" /><Button onClick={() => void saveBillingAlert()} disabled={saving || !accountId}><Save data-icon="inline-start" />保存倍率告警</Button></div>
    </section>

    <details className="rounded-md border bg-card" open={false}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">分钟明细（{data.minutes.length}）</summary>
      <div className="max-h-[32rem] overflow-auto border-t"><table className="w-full min-w-[980px] text-sm"><thead className="sticky top-0 bg-card"><tr className="border-b text-left text-muted-foreground">{['北京时间', '可用率', '错误率', '总延迟 P95', '首 Token P95', '缓存命中', '成功', '错误', '用户计费', '账号计费'].map((label) => <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{data.minutes.map((point) => <MinuteRow key={point.bucketStart} point={point} />)}</tbody></table>{data.minutes.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">暂无数据</div> : null}</div>
    </details>
  </div>;
}

function MinuteRow({ point }: { point: AccountTrendPointDto }) {
  return <tr className="border-b last:border-0"><td className="whitespace-nowrap px-3 py-2">{formatBeijing(point.bucketStart)}</td>{(['availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate', 'successCount', 'upstreamErrorCount', 'userBilledUsd', 'accountBilledUsd'] as AccountAggregateMetricKey[]).map((key) => <td key={key} className="whitespace-nowrap px-3 py-2 tabular-nums">{formatAccountMetric(key, point[key])}</td>)}</tr>;
}

function Distribution({ title, values }: { title: string; values: Record<string, number> }) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return <div className="rounded-md border p-3"><h3 className="text-sm font-medium">{title}</h3><p className="mt-2 text-xs text-muted-foreground">{entries.map(([key, count]) => `${key}: ${count}`).join(' · ') || '暂无数据'}</p></div>;
}

function mergeDistribution(points: AccountTrendPointDto[], field: 'errorStatusCounts' | 'errorPhaseCounts'): Record<string, number> {
  return points.reduce<Record<string, number>>((result, point) => {
    for (const [key, count] of Object.entries(point[field] ?? {})) result[key] = (result[key] ?? 0) + count;
    return result;
  }, {});
}

function formatBeijing(value: string | null): string {
  if (!value) return '暂无数据';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function DetailSkeleton() {
  return <div className="space-y-4"><Skeleton className="h-16" /><div className="grid grid-cols-2 gap-2 lg:grid-cols-5">{Array.from({ length: 10 }, (_, index) => <Skeleton key={index} className="h-24" />)}</div><Skeleton className="h-80" /></div>;
}
