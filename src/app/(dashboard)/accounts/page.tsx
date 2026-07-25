'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ChartNoAxesCombined, Search } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { accountDataIsStale, formatAccountGroups } from '@/lib/account-observability/presentation';

type Metrics = { availability: number | null; errorRate: number | null; averageDurationMs: number | null; durationP95Ms: number | null; firstTokenP95Ms: number | null; cacheHitRate: number | null; userBilledUsd: string; accountBilledUsd: string; successCount: number; upstreamErrorCount: number };
type Account = { id: number; name: string; platform: string | null; type: string | null; remoteStatus: string | null; schedulable: boolean | null; syncState: 'ACTIVE' | 'RETIRED'; groupProjection: unknown; lastSyncedAt: string | null; lastCompleteMinute: string | null; billingProbe: { currentEffectiveRate: number | null; resolvedRateMultiplier: string | null }; metrics24h: Metrics };
const pct = (value: number | null) => value == null ? '暂无数据' : `${(value * 100).toFixed(1)}%`;
const metric = (value: number | null, suffix = '') => value == null ? '暂无数据' : `${Math.round(value)}${suffix}`;

export default function AccountsPage() {
  const [items, setItems] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('all');
  const [status, setStatus] = useState('all');
  useEffect(() => { fetch('/api/accounts').then(async (response) => { if (!response.ok) throw new Error('账号指标暂不可用'); setItems((await response.json()).items as Account[]); }).catch((reason) => setError(reason instanceof Error ? reason.message : '账号指标暂不可用')); }, []);
  const platforms = useMemo(() => [...new Set(items.map((item) => item.platform).filter(Boolean) as string[])].sort(), [items]);
  const visible = useMemo(() => items.filter((item) => {
    const haystack = `${item.name} ${item.platform ?? ''} ${formatAccountGroups(item.groupProjection)}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase()) && (platform === 'all' || item.platform === platform) &&
      (status === 'all' || (status === 'unschedulable' ? !item.schedulable : item.syncState === status));
  }).sort((a, b) => {
    const risk = (item: Account) => Number(accountDataIsStale(item)) * 8 + Number(!item.schedulable) * 4 + (item.metrics24h.errorRate ?? 0) * 2 + (item.metrics24h.durationP95Ms ?? 0) / 100_000;
    return risk(b) - risk(a) || a.name.localeCompare(b.name, 'zh-CN');
  }), [items, platform, search, status]);

  return <div className="space-y-6"><PageHeader icon={ChartNoAxesCombined} title="账号真实流量" description="Sub2API 上游账号近 24 小时业务指标" />
    {error ? <div className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error}</div> : null}
    <div className="flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索账号、平台或分组" /></div>
      <Select value={platform} onValueChange={setPlatform}><SelectTrigger className="w-full sm:w-40" aria-label="筛选平台"><SelectValue placeholder="筛选平台" /></SelectTrigger><SelectContent><SelectItem value="all">全部平台</SelectItem>{platforms.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
      <Select value={status} onValueChange={setStatus}><SelectTrigger className="w-full sm:w-44" aria-label="筛选状态"><SelectValue placeholder="筛选状态" /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="ACTIVE">监控中</SelectItem><SelectItem value="RETIRED">已退役</SelectItem><SelectItem value="unschedulable">不可调度</SelectItem></SelectContent></Select></div>
    <div className="overflow-x-auto rounded-lg border bg-card"><table className="w-full min-w-[1420px] text-sm"><thead><tr className="border-b text-left text-muted-foreground">{['账号','平台','分组','远端状态','调度','可用率','错误率','平均延迟','总延迟 P95','首 Token P95','缓存命中','用户计费','账号计费','当前倍率','请求','同步'].map((label) => <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{visible.map((account) => <tr key={account.id} className="border-b last:border-0 hover:bg-muted/40"><td className="px-3 py-3"><Link className="font-medium text-primary hover:underline" href={`/accounts/${account.id}`}>{account.name}</Link><div className="text-xs text-muted-foreground">{account.type ?? '未知类型'}</div></td><td className="px-3 py-3">{account.platform ?? '未知'}</td><td className="max-w-48 px-3 py-3 text-muted-foreground">{formatAccountGroups(account.groupProjection)}</td><td className="px-3 py-3">{account.remoteStatus ?? '未知'}</td><td className="px-3 py-3"><Badge variant={account.schedulable ? 'outline' : 'destructive'}>{account.schedulable ? '可调度' : '不可调度'}</Badge></td><td className="px-3 py-3">{pct(account.metrics24h.availability)}</td><td className="px-3 py-3">{pct(account.metrics24h.errorRate)}</td><td className="px-3 py-3">{metric(account.metrics24h.averageDurationMs, ' ms')}</td><td className="px-3 py-3">{metric(account.metrics24h.durationP95Ms, ' ms')}</td><td className="px-3 py-3">{metric(account.metrics24h.firstTokenP95Ms, ' ms')}</td><td className="px-3 py-3">{pct(account.metrics24h.cacheHitRate)}</td><td className="px-3 py-3">${account.metrics24h.userBilledUsd}</td><td className="px-3 py-3">${account.metrics24h.accountBilledUsd}</td><td className="px-3 py-3">{account.billingProbe.currentEffectiveRate ?? '暂无数据'}</td><td className="px-3 py-3">{account.metrics24h.successCount + account.metrics24h.upstreamErrorCount}</td><td className="px-3 py-3">{accountDataIsStale(account) ? <Badge variant="destructive">数据同步延迟</Badge> : new Date(account.lastSyncedAt as string).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td></tr>)}</tbody></table>{!visible.length && !error ? <div className="p-8 text-center text-sm text-muted-foreground">暂无账号数据</div> : null}</div>
  </div>;
}
