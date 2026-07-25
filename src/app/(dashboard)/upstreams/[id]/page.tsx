'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Zap, RefreshCw, Check, AlertTriangle, Wallet, Timer,
  KeyRound, Activity, Trash2, Loader2, Gauge, ServerCog,
} from 'lucide-react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { StatusBadge, StatusDot } from '@/components/StatusBadge';
import { useConfirm } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatGroupMultiplier, getKeyDisplayName, getKeyGroupLabel } from '@/lib/key-display';
import { beginLatestRequest } from '@/lib/request-sequence';
import { apiFetch } from '@/lib/api-fetch';

// ============ 类型 ============

interface UpstreamKey {
  id: number;
  group: string;
  label: string | null;
  keyName: string | null;
  groupName: string | null;
  groupDescription: string | null;
  groupRateMultiplier: number | null;
  remoteKeyId: string | null;
  metadataSyncedAt: string | null;
  metadataError: string | null;
  status: string;
  lastBalance: number | null;
  lastLatencyMs: number | null;
  lastCollectedAt: string | null;
  lastError: string | null;
  hasApiKey: boolean;
  hasAccessToken: boolean;
  enabled: boolean;
}

interface Upstream {
  id: number;
  name: string;
  baseUrl: string;
  type: string;
  status: string;
  enabled: boolean;
  priority: number;
  testModel: string | null;
  keys?: UpstreamKey[];
}

interface Metric {
  id: number;
  balance: number | null;
  latencyMs: number | null;
  modelTestOk: boolean | null;
  modelTestLatMs: number | null;
  streamTps: number | null;
  streamFirstLat: number | null;
  success: boolean;
  errorMessage: string | null;
  recordedAt: string;
}

interface Incident {
  id: number;
  type: string;
  severity: string;
  message: string;
  resolved: boolean;
  createdAt: string;
  upstreamKey?: { id: number; group: string } | null;
}

type Range = '6h' | '24h' | '7d';

// ============ 页面 ============

export default function UpstreamDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [upstream, setUpstream] = useState<Upstream | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [range, setRange] = useState<Range>('24h');
  const [selectedKeyId, setSelectedKeyId] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshingKeyId, setRefreshingKeyId] = useState<number | null>(null);
  const baseRequestSequence = useRef(0);
  const metricRequestSequence = useRef(0);
  const actionInFlight = useRef(false);

  const keys = useMemo(() => upstream?.keys || [], [upstream?.keys]);
  const activeKeyId = selectedKeyId || (keys[0]?.id != null ? String(keys[0].id) : '');
  const activeKeyIdRef = useRef(activeKeyId);
  const rangeRef = useRef(range);
  activeKeyIdRef.current = activeKeyId;
  rangeRef.current = range;

  // 加载上游 + 告警
  const fetchBase = useCallback(async () => {
    const isCurrent = beginLatestRequest(baseRequestSequence);
    const id = params.id;
    try {
      const [uRes, iRes] = await Promise.all([
        fetch(`/api/upstreams/${id}`),
        fetch(`/api/incidents?upstreamId=${id}&limit=50`),
      ]);
      const [nextUpstream, nextIncidents] = await Promise.all([
        uRes.json().catch(() => ({})),
        iRes.json().catch(() => []),
      ]);
      if (!uRes.ok) throw new Error(nextUpstream.error || '获取上游信息失败');
      if (!iRes.ok) throw new Error(nextIncidents.error || '获取告警历史失败');
      if (!isCurrent()) return false;
      setUpstream(nextUpstream);
      setIncidents(Array.isArray(nextIncidents) ? nextIncidents : []);
      return true;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [params.id]);

  // 加载所选分组的指标
  const fetchMetrics = useCallback(async () => {
    const isCurrent = beginLatestRequest(metricRequestSequence);
    const keyId = activeKeyIdRef.current;
    const currentRange = rangeRef.current;
    if (!keyId) {
      if (!isCurrent()) return false;
      setMetrics([]);
      return true;
    }
    const qs = currentRange === '7d' ? 'days=7' : `hours=${currentRange === '6h' ? 6 : 24}`;
    const mRes = await fetch(`/api/metrics?upstreamKeyId=${keyId}&${qs}&limit=2000`);
    const nextMetrics = await mRes.json().catch(() => []);
    if (!mRes.ok) throw new Error(nextMetrics.error || '获取指标失败');
    if (!isCurrent()) return false;
    setMetrics(Array.isArray(nextMetrics) ? nextMetrics : []);
    return true;
  }, []);

  useEffect(() => {
    void fetchBase().catch((error) => toast.error((error as Error).message));
  }, [fetchBase]);
  useEffect(() => {
    void fetchMetrics().catch((error) => toast.error((error as Error).message));
  }, [fetchMetrics, activeKeyId, range]);

  // 上游变化后，若未选择 key 则默认选第一个
  useEffect(() => {
    if (!selectedKeyId && keys.length > 0 && keys[0].id != null) {
      setSelectedKeyId(String(keys[0].id));
    }
  }, [keys, selectedKeyId]);

  async function handleTest() {
    if (!upstream || actionInFlight.current) return;
    actionInFlight.current = true;
    setTesting(true);
    const tid = toast.loading(`正在测试 ${upstream.name} 的所有分组…`);
    try {
      const res = await apiFetch(`/api/upstreams/${upstream.id}/test`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const ok = data.results?.filter((r: { status: string }) => r.status === 'ok').length || 0;
        const total = data.results?.length || 0;
        const fail = total - ok;
        toast.success(`${upstream.name} 测试完成：${ok} 成功${fail > 0 ? `，${fail} 失败` : ''}`, { id: tid });
        await fetchBase();
        await fetchMetrics();
      } else {
        toast.error(data.error || '测试失败', { id: tid });
      }
    } catch (e) {
      toast.error('请求失败: ' + (e as Error).message, { id: tid });
    } finally {
      setTesting(false);
      actionInFlight.current = false;
    }
  }

  async function handleRefresh() {
    if (!upstream || actionInFlight.current) return;
    actionInFlight.current = true;
    setRefreshing(true);
    const tid = toast.loading(`正在刷新 ${upstream.name}…`);
    try {
      const res = await apiFetch(`/api/upstreams/${upstream.id}/refresh`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || '刷新失败', { id: tid });
        return;
      }
      const total = data.results?.length || 0;
      const success = data.successCount ?? data.results?.filter((item: { status: string }) => item.status === 'ok').length ?? 0;
      const failed = data.failureCount ?? total - success;
      await Promise.all([fetchBase(), fetchMetrics()]);
      const message = `${upstream.name} 刷新完成：${success} 成功${failed > 0 ? `，${failed} 失败` : ''}`;
      if (success === 0) {
        toast.error(message, { id: tid });
      } else if (failed > 0) {
        toast.warning(message, { id: tid });
      } else {
        toast.success(message, { id: tid });
      }
    } catch (error) {
      toast.error('请求失败: ' + (error as Error).message, { id: tid });
    } finally {
      setRefreshing(false);
      actionInFlight.current = false;
    }
  }

  async function handleDelete() {
    if (!upstream) return;
    const ok = await confirm({
      title: `删除上游「${upstream.name}」？`,
      description: '该操作会删除该上游及其所有分组、指标和告警数据，不可恢复。',
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/api/upstreams/${upstream.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error || '删除失败');
        return;
      }
      toast.success(`已删除 ${upstream.name}`);
      router.push('/upstreams');
    } catch (e) {
      toast.error('删除失败: ' + (e as Error).message);
    }
  }

  async function handleRefreshMetadata(key: UpstreamKey) {
    setRefreshingKeyId(key.id);
    try {
      const res = await apiFetch(`/api/keys/${key.id}/metadata`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || '远端信息获取失败');
        return;
      }
      toast.success('远端信息已更新');
      await fetchBase();
    } catch (e) {
      toast.error('请求失败: ' + (e as Error).message);
    } finally {
      setRefreshingKeyId(null);
    }
  }

  // ============ 派生数据 ============

  const totalBalance = useMemo(
    () => keys.reduce((s, k) => s + (k.lastBalance || 0), 0),
    [keys],
  );

  const chartData = useMemo(() => metrics.map((m) => ({
    time: new Date(m.recordedAt).toLocaleString('zh-CN', range === '7d'
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }),
    balance: m.balance,
    latency: m.latencyMs,
    tps: m.streamTps,
    success: m.success ? 1 : 0,
  })), [metrics, range]);

  const successCount = metrics.filter((m) => m.success).length;
  const availability = metrics.length > 0 ? (successCount / metrics.length) * 100 : 0;

  // ============ 渲染 ============

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
      </div>
    );
  }
  if (!upstream) {
    return (
      <div className="flex h-96 items-center justify-center text-muted-foreground">
        上游不存在
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      {/* ====== 面包屑 ====== */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/upstreams">上游管理</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{upstream.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* ====== 页头 ====== */}
      <PageHeader
        icon={ServerCog}
        title={upstream.name}
        description={upstream.baseUrl}
        leading={<StatusDot status={upstream.status} size="lg" />}
        meta={
          <>
            <StatusBadge status={upstream.status} />
            <Badge variant="outline">{upstream.type}</Badge>
            {!upstream.enabled && <Badge variant="secondary">已禁用</Badge>}
          </>
        }
        actions={
          <>
            <Button size="sm" onClick={handleTest} disabled={testing || refreshing}>
              {testing ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Zap data-icon="inline-start" />
              )}
              {testing ? '测试中…' : '立即测试'}
            </Button>
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshing || testing}>
              <RefreshCw data-icon="inline-start" className={cn(refreshing && 'animate-spin')} />
              {refreshing ? '刷新中…' : '刷新'}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href="/upstreams">
                <ArrowLeft data-icon="inline-start" />
                返回
              </Link>
            </Button>
            <Button size="sm" variant="destructive" onClick={handleDelete}>
              <Trash2 data-icon="inline-start" />
              删除
            </Button>
          </>
        }
        actionsClassName="grid w-full grid-cols-2 sm:flex sm:w-auto"
      />

      {/* ====== 汇总指标 ====== */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard icon={<Wallet className="h-4 w-4" />} label="总余额"
          value={totalBalance > 0 ? `$${totalBalance.toFixed(2)}` : '—'} />
        <SummaryCard icon={<Gauge className="h-4 w-4" />} label={`${range} 可用率`}
          value={`${availability.toFixed(1)}%`}
          tone={availability >= 99 ? 'good' : availability >= 95 ? 'warn' : 'bad'} />
        <SummaryCard icon={<KeyRound className="h-4 w-4" />} label="分组数"
          value={String(keys.length)} />
        <SummaryCard icon={<Activity className="h-4 w-4" />} label="测速模型"
          value={upstream.testModel || '—'} />
      </div>

      {/* ====== 主体 Tabs ====== */}
      <Tabs defaultValue="groups" className="w-full">
        <TabsList className="grid h-auto w-full grid-cols-3 sm:inline-flex sm:w-auto">
          <TabsTrigger value="groups">分组详情</TabsTrigger>
          <TabsTrigger value="trends">趋势</TabsTrigger>
          <TabsTrigger value="incidents">告警历史</TabsTrigger>
        </TabsList>

        {/* ---- 分组详情 ---- */}
        <TabsContent value="groups" className="space-y-3">
          {keys.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-muted-foreground">
                该上游暂无分组，请到上游管理中添加分组密钥
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {keys.map((k) => (
                <GroupCard
                  key={k.id}
                  k={k}
                  upstreamType={upstream.type}
                  refreshing={refreshingKeyId === k.id}
                  onRefresh={handleRefreshMetadata}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---- 趋势 ---- */}
        <TabsContent value="trends" className="space-y-3">
          <Card>
            <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base">趋势图</CardTitle>
                <CardDescription>选择分组查看余额与延迟趋势</CardDescription>
              </div>
              <div className="w-full sm:w-auto">
                <Select value={activeKeyId} onValueChange={setSelectedKeyId}>
                  <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="选择分组" /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {keys.map((k) => (
                        <SelectItem key={k.id} value={String(k.id)}>
                          {upstream.type === 'NEW_API'
                            ? `${getKeyDisplayName(k)} · ${getKeyGroupLabel(k)}`
                            : k.group}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 时间范围切换 */}
              <div className="flex gap-1">
                {(['6h', '24h', '7d'] as Range[]).map((r) => (
                  <Button
                    key={r}
                    size="sm"
                    variant={range === r ? 'default' : 'outline'}
                    onClick={() => setRange(r)}
                  >
                    {r === '6h' ? '6小时' : r === '24h' ? '24小时' : '7天'}
                  </Button>
                ))}
              </div>

              {!activeKeyId ? (
                <div className="py-10 text-center text-sm text-muted-foreground">请选择分组</div>
              ) : metrics.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">该分组在所选范围内暂无数据</div>
              ) : (
                <>
                  {/* 余额趋势 */}
                  <div>
                    <div className="mb-2 text-sm font-medium">余额趋势</div>
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" strokeOpacity={0.5} />
                        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={40} />
                        <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                        <Tooltip
                          formatter={(v) => (typeof v === 'number' && v != null ? `$${v.toFixed(2)}` : '—')}
                          contentStyle={tooltipStyle}
                        />
                        <Area type="monotone" dataKey="balance"
                          stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#balGrad)" connectNulls />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  {/* 延迟趋势 */}
                  <div>
                    <div className="mb-2 text-sm font-medium">延迟趋势 (ms)</div>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" strokeOpacity={0.5} />
                        <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={40} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip
                          formatter={(v) => (typeof v === 'number' && v != null ? `${v}ms` : '—')}
                          contentStyle={tooltipStyle}
                        />
                        <Line type="monotone" dataKey="latency"
                          stroke="hsl(var(--chart-2))" strokeWidth={1.5} dot={false} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* 流式 TPS（如有） */}
                  {chartData.some((d) => d.tps != null) && (
                    <div>
                      <div className="mb-2 text-sm font-medium">流式测速 TPS (tokens/s)</div>
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" strokeOpacity={0.5} />
                          <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={40} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <Tooltip
                            formatter={(v) => (typeof v === 'number' && v != null ? `${v} t/s` : '—')}
                            contentStyle={tooltipStyle}
                          />
                          <Line type="monotone" dataKey="tps"
                            stroke="hsl(var(--chart-3))" strokeWidth={1.5} dot={false} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- 告警历史 ---- */}
        <TabsContent value="incidents">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">告警历史</CardTitle>
              <CardDescription>展示该上游所有分组的历史告警</CardDescription>
            </CardHeader>
            <CardContent>
              {incidents.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">暂无告警记录</div>
              ) : (
                <div className="space-y-2">
                  {incidents.map((inc) => (
                    <div
                      key={inc.id}
                      className="flex flex-col gap-2 border-b py-2 last:border-0 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityBadge severity={inc.severity} />
                          {inc.upstreamKey?.group && (
                            <Badge variant="outline" className="text-xs">{inc.upstreamKey.group}</Badge>
                          )}
                          {inc.resolved && (
                            <Badge variant="secondary" className="gap-1 text-xs">
                              <Check className="h-3 w-3" />已恢复
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 break-words text-sm">{inc.message}</div>
                      </div>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(inc.createdAt).toLocaleString('zh-CN')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ 子组件 ============

const tooltipStyle = {
  fontSize: '12px',
  borderRadius: '8px',
} as const;

function SummaryCard({ icon, label, value, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  const toneClass = tone === 'good'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'bad'
        ? 'text-red-600 dark:text-red-400'
        : '';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}<span>{label}</span>
        </div>
        <div className={cn('mt-1 text-xl font-bold', toneClass)}>{value}</div>
      </CardContent>
    </Card>
  );
}

function GroupCard({ k, upstreamType, refreshing, onRefresh }: {
  k: UpstreamKey;
  upstreamType: string;
  refreshing: boolean;
  onRefresh: (key: UpstreamKey) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={k.status} size="lg" />
          <div className="min-w-0">
            <CardTitle className="truncate text-base" title={getKeyDisplayName(k)}>
              {upstreamType === 'NEW_API' ? getKeyDisplayName(k) : k.group}
            </CardTitle>
            {k.label && upstreamType !== 'NEW_API' ? (
              <CardDescription>{k.label}</CardDescription>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {upstreamType === 'NEW_API' ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="重新获取远端信息"
              title="重新获取远端信息"
              disabled={refreshing}
              onClick={() => onRefresh(k)}
            >
              <RefreshCw data-icon="inline-start" className={refreshing ? 'animate-spin' : undefined} />
            </Button>
          ) : null}
          <StatusBadge status={k.status} />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {upstreamType === 'NEW_API' ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">秘钥名称</dt>
              <dd className="mt-0.5 break-words">{getKeyDisplayName(k)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">分组名称</dt>
              <dd className="mt-0.5 break-words">{getKeyGroupLabel(k)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">分组说明</dt>
              <dd className="mt-0.5 break-words">{k.groupDescription || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">倍率</dt>
              <dd className="mt-0.5">{formatGroupMultiplier(k.groupRateMultiplier)}</dd>
            </div>
          </dl>
        ) : null}

        <div className="grid grid-cols-2 gap-3 border-y py-3">
          <div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Wallet className="h-3 w-3" />余额
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold">
              {k.lastBalance != null ? `$${k.lastBalance.toFixed(2)}` : '—'}
            </div>
          </div>
          <div className="border-l pl-3">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Timer className="h-3 w-3" />延迟
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold">
              {k.lastLatencyMs != null ? `${k.lastLatencyMs}ms` : '—'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {k.hasApiKey ? (
            <Badge variant="secondary" className="gap-1"><KeyRound className="h-3 w-3" />Key</Badge>
          ) : (
            <Badge variant="outline" className="gap-1 text-warning"><AlertTriangle className="h-3 w-3" />无 Key</Badge>
          )}
          {upstreamType === 'NEW_API' ? (
            k.hasAccessToken
              ? <Badge variant="secondary" className="gap-1"><Check className="h-3 w-3" />令牌</Badge>
              : <Badge variant="outline" className="gap-1 text-warning"><AlertTriangle className="h-3 w-3" />无令牌</Badge>
          ) : null}
          {!k.enabled ? <Badge variant="secondary">已禁用</Badge> : null}
          {k.lastCollectedAt ? (
            <span className="text-muted-foreground">
              采集于 {new Date(k.lastCollectedAt).toLocaleString('zh-CN')}
            </span>
          ) : null}
        </div>

        {k.metadataError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-all">{k.metadataError}</span>
          </div>
        ) : null}

        {k.lastError ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="font-mono break-all">{k.lastError}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { variant: 'destructive' | 'secondary' | 'outline'; cls: string }> = {
    CRITICAL: { variant: 'destructive', cls: '' },
    WARNING: {
      variant: 'outline',
      cls: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400',
    },
    INFO: { variant: 'secondary', cls: '' },
  };
  const conf = map[severity] || map.INFO;
  return (
    <Badge variant={conf.variant} className={cn('gap-1 text-xs', conf.cls)}>
      {severity === 'CRITICAL' && <AlertTriangle className="h-3 w-3" />}
      {severity}
    </Badge>
  );
}
