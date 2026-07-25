'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';

type Account = { id: number; name: string; platform: string | null; type: string | null; remoteStatus: string | null; schedulable: boolean | null; lastSyncedAt: string | null; metrics24h: { availability: number | null; errorRate: number | null; durationP95Ms: number | null; firstTokenP95Ms: number | null; cacheHitRate: number | null; userBilledUsd: string; accountBilledUsd: string; successCount: number; upstreamErrorCount: number } };
const pct = (value: number | null) => value == null ? '暂无数据' : `${(value * 100).toFixed(1)}%`;
const metric = (value: number | null, suffix = '') => value == null ? '暂无数据' : `${Math.round(value)}${suffix}`;

export default function AccountsPage() {
  const [items, setItems] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetch('/api/accounts').then(async (response) => { if (!response.ok) throw new Error('账号指标暂不可用'); setItems((await response.json()).items as Account[]); }).catch((reason) => setError(reason instanceof Error ? reason.message : '账号指标暂不可用')); }, []);
  return <div className="space-y-6"><PageHeader icon={ChartNoAxesCombined} title="账号真实流量" description="Sub2API 上游账号近 24 小时业务指标" />
    {error ? <div className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error}</div> : null}
    <div className="overflow-x-auto rounded-lg border bg-card"><table className="w-full min-w-[980px] text-sm"><thead><tr className="border-b text-left text-muted-foreground">{['账号','平台','远端状态','调度','可用率','错误率','总延迟 P95','首 Token P95','缓存命中','用户计费','账号计费','请求'].map((label) => <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{items.map((account) => <tr key={account.id} className="border-b last:border-0 hover:bg-muted/40"><td className="px-3 py-3"><Link className="font-medium text-primary hover:underline" href={`/accounts/${account.id}`}>{account.name}</Link><div className="text-xs text-muted-foreground">{account.type ?? '未知类型'}</div></td><td className="px-3 py-3">{account.platform ?? '未知'}</td><td className="px-3 py-3">{account.remoteStatus ?? '未知'}</td><td className="px-3 py-3"><Badge variant={account.schedulable ? 'outline' : 'destructive'}>{account.schedulable ? '可调度' : '不可调度'}</Badge></td><td className="px-3 py-3">{pct(account.metrics24h.availability)}</td><td className="px-3 py-3">{pct(account.metrics24h.errorRate)}</td><td className="px-3 py-3">{metric(account.metrics24h.durationP95Ms, ' ms')}</td><td className="px-3 py-3">{metric(account.metrics24h.firstTokenP95Ms, ' ms')}</td><td className="px-3 py-3">{pct(account.metrics24h.cacheHitRate)}</td><td className="px-3 py-3">${account.metrics24h.userBilledUsd}</td><td className="px-3 py-3">${account.metrics24h.accountBilledUsd}</td><td className="px-3 py-3">{account.metrics24h.successCount + account.metrics24h.upstreamErrorCount}</td></tr>)}</tbody></table>{!items.length && !error ? <div className="p-8 text-center text-sm text-muted-foreground">暂无账号数据</div> : null}</div>
  </div>;
}
