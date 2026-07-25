'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChartNoAxesCombined, Save } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiFetch } from '@/lib/api-fetch';

type Summary = { availability: number | null; errorRate: number | null; averageDurationMs: number | null; durationP95Ms: number | null; firstTokenP95Ms: number | null; cacheHitRate: number | null; userBilledUsd: string; accountBilledUsd: string; successCount: number; upstreamErrorCount: number };
type WindowKey = 'today' | 'last1h' | 'last24h';
type TrendPoint = { bucketStart: string; successCount: number; upstreamErrorCount: number; availability: number | null; errorRate: number | null; averageDurationMs: number | null; durationP95Ms: number | null; firstTokenP95Ms: number | null; cacheHitRate: number | null; userBilledUsd: string; accountBilledUsd: string; errorStatusCounts: Record<string, number> | null; errorPhaseCounts: Record<string, number> | null };
type Detail = { name: string; platform: string | null; remoteStatus: string | null; billingProbe: { status: string | null; freshAt: string | null; resolvedRateMultiplier: string | null; currentEffectiveRate: number | null }; windows: Record<WindowKey, Summary>; trend: TrendPoint[] };
const pct = (value: number | null) => value == null ? '暂无数据' : `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null) => value == null ? '暂无数据' : `${Math.round(value)} ms`;

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<Detail | null>(null);
  const [windowKey, setWindowKey] = useState<WindowKey>('last24h');
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [alertThreshold, setAlertThreshold] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void params.then(async ({ id }) => {
    setAccountId(id);
    const [detailResponse, alertResponse] = await Promise.all([fetch(`/api/accounts/${id}`), fetch(`/api/accounts/${id}/billing-alert`)]);
    if (detailResponse.ok) setData(await detailResponse.json());
    if (alertResponse.ok) { const alert = await alertResponse.json(); setAlertEnabled(alert.enabled); setAlertThreshold(alert.threshold == null ? '' : String(alert.threshold)); }
  }); }, [params]);
  const trend = useMemo(() => {
    if (!data) return [];
    const now = Date.now();
    const start = windowKey === 'last1h' ? now - 60 * 60_000 : windowKey === 'today'
      ? new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) + 'T00:00:00+08:00').getTime()
      : now - 24 * 60 * 60_000;
    return data.trend.filter((point) => new Date(point.bucketStart).getTime() >= start);
  }, [data, windowKey]);
  const errorDistributions = useMemo(() => {
    const merge = (field: 'errorStatusCounts' | 'errorPhaseCounts') => trend.reduce<Record<string, number>>((result, point) => {
      for (const [key, count] of Object.entries(point[field] ?? {})) result[key] = (result[key] ?? 0) + count;
      return result;
    }, {});
    return { statuses: merge('errorStatusCounts'), phases: merge('errorPhaseCounts') };
  }, [trend]);
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
  if (!data) return <div className="p-8 text-sm text-muted-foreground">正在加载账号指标...</div>;
  const summary = data.windows[windowKey];
  return <div className="space-y-6">
    <PageHeader icon={ChartNoAxesCombined} title={data.name} description={`${data.platform ?? '未知平台'} · ${data.remoteStatus ?? '未知状态'}`} actions={<Button asChild variant="outline"><Link href="/accounts"><ArrowLeft className="mr-2 h-4 w-4" />返回账号列表</Link></Button>} />
    <Tabs value={windowKey} onValueChange={(value) => setWindowKey(value as WindowKey)}><TabsList><TabsTrigger value="today">北京时间今日</TabsTrigger><TabsTrigger value="last1h">近 1 小时</TabsTrigger><TabsTrigger value="last24h">近 24 小时</TabsTrigger></TabsList></Tabs>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[['可用率', pct(summary.availability)], ['错误率', pct(summary.errorRate)], ['平均延迟', ms(summary.averageDurationMs)], ['总延迟 P95', ms(summary.durationP95Ms)], ['首 Token P95', ms(summary.firstTokenP95Ms)], ['缓存命中', pct(summary.cacheHitRate)], ['用户计费', `$${summary.userBilledUsd}`], ['账号计费', `$${summary.accountBilledUsd}`], ['成功请求', String(summary.successCount)], ['错误请求', String(summary.upstreamErrorCount)]].map(([label, value]) => <div key={label} className="rounded-lg border bg-card p-4"><div className="text-sm text-muted-foreground">{label}</div><div className="mt-2 text-xl font-semibold">{value}</div></div>)}</div>
    <div className="grid gap-4 border-y py-4 lg:grid-cols-[1fr_auto] lg:items-end"><div><div className="font-medium">上游计费倍率</div><div className="mt-1 text-sm text-muted-foreground">当前有效倍率：{data.billingProbe.currentEffectiveRate ?? '暂无数据'} · 最近探测：{data.billingProbe.resolvedRateMultiplier ?? '暂无数据'} · 状态：{data.billingProbe.status ?? '未探测'}</div></div><div className="flex flex-col gap-2 sm:flex-row sm:items-center"><label className="flex items-center gap-2 text-sm"><Switch checked={alertEnabled} onCheckedChange={setAlertEnabled} />启用倍率告警</label><Input className="w-full sm:w-36" type="number" min="0" step="0.01" value={alertThreshold} onChange={(event) => setAlertThreshold(event.target.value)} placeholder="倍率告警阈值" /><Button onClick={() => void saveBillingAlert()} disabled={saving || !accountId}><Save className="mr-2 h-4 w-4" />保存倍率告警</Button></div></div>
    <div className="grid gap-4 sm:grid-cols-2"><div><div className="text-sm font-medium">错误码分布</div><div className="mt-2 text-sm text-muted-foreground">{Object.entries(errorDistributions.statuses).map(([key, count]) => `${key}: ${count}`).join(' · ') || '暂无数据'}</div></div><div><div className="text-sm font-medium">错误阶段分布</div><div className="mt-2 text-sm text-muted-foreground">{Object.entries(errorDistributions.phases).map(([key, count]) => `${key}: ${count}`).join(' · ') || '暂无数据'}</div></div></div>
    <div className="rounded-lg border bg-card"><div className="border-b px-4 py-3 font-medium">分钟趋势</div><div className="overflow-x-auto"><table className="w-full min-w-[1180px] text-sm"><thead><tr className="border-b text-left text-muted-foreground">{['北京时间','可用率','错误率','平均延迟','总延迟 P95','首 Token P95','缓存命中','成功','错误','用户计费','账号计费'].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead><tbody>{trend.map((point) => <tr key={point.bucketStart} className="border-b last:border-0"><td className="px-3 py-2">{new Date(point.bucketStart).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td><td className="px-3 py-2">{pct(point.availability)}</td><td className="px-3 py-2">{pct(point.errorRate)}</td><td className="px-3 py-2">{ms(point.averageDurationMs)}</td><td className="px-3 py-2">{ms(point.durationP95Ms)}</td><td className="px-3 py-2">{ms(point.firstTokenP95Ms)}</td><td className="px-3 py-2">{pct(point.cacheHitRate)}</td><td className="px-3 py-2">{point.successCount}</td><td className="px-3 py-2">{point.upstreamErrorCount}</td><td className="px-3 py-2">${point.userBilledUsd}</td><td className="px-3 py-2">${point.accountBilledUsd}</td></tr>)}</tbody></table>{!trend.length ? <div className="p-8 text-center text-sm text-muted-foreground">暂无数据</div> : null}</div></div>
  </div>;
}
