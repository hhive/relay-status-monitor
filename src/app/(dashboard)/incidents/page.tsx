'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Bell, Check, CheckCircle2, Loader2, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import { apiFetch } from '@/lib/api-fetch';
import { alertRuleConfigurationHref } from '@/lib/account-observability-ui';
import { beginLatestRequest } from '@/lib/request-sequence';

interface AccountAlertEvent {
  id: number;
  metric: string;
  severity: string;
  metricValue: number | null;
  message: string;
  resolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
  account: { id: number; name: string; platform: string | null };
  rule: { id: number; name: string };
}

type ResolvedFilter = 'open' | 'resolved' | 'all';

const METRICS = [
  'availability_low', 'error_rate_high', 'duration_p95_high', 'first_token_p95_high',
  'cache_hit_low', 'unschedulable', 'sync_stale', 'upstream_rate_multiplier',
] as const;

export default function IncidentsPage() {
  const [events, setEvents] = useState<AccountAlertEvent[]>([]);
  const [resolvedFilter, setResolvedFilter] = useState<ResolvedFilter>('open');
  const [accountInput, setAccountInput] = useState('');
  const [metric, setMetric] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const requestSequence = useRef(0);

  const fetchEvents = useCallback(async () => {
    const isCurrent = beginLatestRequest(requestSequence);
    setLoading(true);
    const params = new URLSearchParams();
    if (resolvedFilter !== 'all') params.set('resolved', String(resolvedFilter === 'resolved'));
    if (/^[1-9]\d*$/.test(accountInput)) params.set('account', accountInput);
    if (metric !== 'all') params.set('metric', metric);
    if (severity !== 'all') params.set('severity', severity);
    try {
      const response = await fetch(`/api/account-alert-events?${params}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '获取账号告警失败');
      if (isCurrent()) setEvents(Array.isArray(body) ? body : []);
    } catch {
      if (isCurrent()) setEvents([]);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [accountInput, metric, resolvedFilter, severity]);

  useEffect(() => { void fetchEvents(); }, [fetchEvents]);

  async function handleResolve(id: number) {
    setResolvingId(id);
    try {
      const response = await apiFetch(`/api/account-alert-events/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      });
      if (response.ok) await fetchEvents();
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <Tabs className="flex flex-col gap-6" value={resolvedFilter} onValueChange={(value) => setResolvedFilter(value as ResolvedFilter)}>
      <PageHeader icon={Bell} title="账号告警事件" />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <TabsList className="grid w-full grid-cols-3 lg:w-auto">
          <TabsTrigger value="open">未解决</TabsTrigger>
          <TabsTrigger value="resolved">已解决</TabsTrigger>
          <TabsTrigger value="all">全部</TabsTrigger>
        </TabsList>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input
            inputMode="numeric"
            aria-label="按账号 ID 筛选"
            placeholder="账号 ID"
            value={accountInput}
            onChange={(event) => setAccountInput(event.target.value.replace(/\D/g, ''))}
          />
          <Select value={metric} onValueChange={setMetric}>
            <SelectTrigger aria-label="按指标筛选"><SelectValue placeholder="全部指标" /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="all">全部指标</SelectItem>
              {METRICS.map((value) => <SelectItem key={value} value={value}>{metricLabel(value)}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger aria-label="按严重级别筛选"><SelectValue placeholder="全部级别" /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="all">全部级别</SelectItem>
              <SelectItem value="INFO">INFO</SelectItem>
              <SelectItem value="WARNING">WARNING</SelectItem>
              <SelectItem value="CRITICAL">CRITICAL</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </div>
      </div>

      <TabsContent value={resolvedFilter} className="mt-0">
        {loading ? (
          <Card className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中...
          </Card>
        ) : events.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-2 p-12 text-center text-muted-foreground">
            {resolvedFilter === 'open' ? <CheckCircle2 className="h-8 w-8 text-emerald-500" /> : <Bell className="h-8 w-8 opacity-40" />}
            <p>{resolvedFilter === 'open' ? '没有未解决的账号告警' : '暂无账号告警记录'}</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {events.map((event) => (
              <Card key={event.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={event.severity} />
                      <Badge variant="outline">{metricLabel(event.metric)}</Badge>
                      <Link href={`/accounts/${event.account.id}`} className="truncate text-sm font-medium hover:text-primary">
                        {event.account.name}
                      </Link>
                      {event.account.platform && <Badge variant="secondary">{event.account.platform}</Badge>}
                      {event.resolved && <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"><Check className="mr-1 h-3 w-3" />已恢复</Badge>}
                    </div>
                    <p className="break-words text-sm">{event.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(event.createdAt).toLocaleString('zh-CN')}
                      {event.resolvedAt ? ` · 恢复于 ${new Date(event.resolvedAt).toLocaleString('zh-CN')}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={alertRuleConfigurationHref(event)}>
                        <SlidersHorizontal data-icon="inline-start" />
                        配置规则
                      </Link>
                    </Button>
                    {!event.resolved && (
                      <Button variant="outline" size="sm" disabled={resolvingId === event.id} onClick={() => void handleResolve(event.id)}>
                        {resolvingId === event.id ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                        标记已解决
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  if (severity === 'CRITICAL') return <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" />CRITICAL</Badge>;
  if (severity === 'WARNING') return <Badge className="border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400"><AlertTriangle className="mr-1 h-3 w-3" />WARNING</Badge>;
  return <Badge variant="secondary">INFO</Badge>;
}

function metricLabel(metric: string): string {
  return {
    availability_low: '可用率低', error_rate_high: '错误率高', duration_p95_high: '总延迟 P95 高',
    first_token_p95_high: '首 Token P95 高', cache_hit_low: '缓存命中率低',
    unschedulable: '不可调度', sync_stale: '同步陈旧', upstream_rate_multiplier: '上游倍率',
  }[metric] ?? metric;
}
