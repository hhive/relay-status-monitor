'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, ChartNoAxesCombined } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';

type Detail = { name: string; platform: string | null; remoteStatus: string | null; windows: { last24h: { availability: number | null; errorRate: number | null; durationP95Ms: number | null; firstTokenP95Ms: number | null; cacheHitRate: number | null; userBilledUsd: string; accountBilledUsd: string; successCount: number; upstreamErrorCount: number } }; trend: Array<{ bucketStart: string; availability: number | null; durationP95Ms: number | null; firstTokenP95Ms: number | null }> };

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [data, setData] = useState<Detail | null>(null);
  useEffect(() => { params.then(({ id }) => fetch(`/api/accounts/${id}`).then((response) => response.ok ? response.json() : null).then(setData)); }, [params]);
  if (!data) return <div className="p-8 text-sm text-muted-foreground">正在加载账号指标...</div>;
  const summary = data.windows.last24h;
  return <div className="space-y-6"><PageHeader icon={ChartNoAxesCombined} title={data.name} description={`${data.platform ?? '未知平台'} · ${data.remoteStatus ?? '未知状态'}`} actions={<Button asChild variant="outline"><Link href="/accounts"><ArrowLeft className="mr-2 h-4 w-4" />返回账号列表</Link></Button>} /><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['可用率', summary.availability == null ? '暂无数据' : `${(summary.availability * 100).toFixed(1)}%`], ['错误率', summary.errorRate == null ? '暂无数据' : `${(summary.errorRate * 100).toFixed(1)}%`], ['总延迟 P95', summary.durationP95Ms == null ? '暂无数据' : `${summary.durationP95Ms} ms`], ['首 Token P95', summary.firstTokenP95Ms == null ? '暂无数据' : `${summary.firstTokenP95Ms} ms`]].map(([label, value]) => <div key={label} className="rounded-lg border bg-card p-4"><div className="text-sm text-muted-foreground">{label}</div><div className="mt-2 text-xl font-semibold">{value}</div></div>)}</div><div className="rounded-lg border bg-card"><div className="border-b px-4 py-3 font-medium">近 24 小时分钟趋势</div><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="px-3 py-3">北京时间</th><th className="px-3 py-3">可用率</th><th className="px-3 py-3">总延迟 P95</th><th className="px-3 py-3">首 Token P95</th></tr></thead><tbody>{data.trend.slice(-60).map((point) => <tr key={point.bucketStart} className="border-b last:border-0"><td className="px-3 py-2">{new Date(point.bucketStart).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td><td className="px-3 py-2">{point.availability == null ? '暂无数据' : `${(point.availability * 100).toFixed(1)}%`}</td><td className="px-3 py-2">{point.durationP95Ms == null ? '暂无数据' : `${point.durationP95Ms} ms`}</td><td className="px-3 py-2">{point.firstTokenP95Ms == null ? '暂无数据' : `${point.firstTokenP95Ms} ms`}</td></tr>)}</tbody></table></div></div></div>;
}
