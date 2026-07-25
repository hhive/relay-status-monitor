'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { Bell, Check, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-header';
import { beginLatestRequest } from '@/lib/request-sequence';
import { apiFetch } from '@/lib/api-fetch';

interface Incident {
  id: number;
  type: string;
  severity: string;
  message: string;
  metricValue: number | null;
  resolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
  upstream: { id: number; name: string; baseUrl: string };
  upstreamKey?: { id: number; group: string } | null;
}

type FilterKey = 'open' | 'resolved' | 'all';

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [filter, setFilter] = useState<FilterKey>('open');
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const requestSequence = useRef(0);

  const fetchIncidents = useCallback(async () => {
    const isCurrent = beginLatestRequest(requestSequence);
    setLoading(true);
    const base = '/api/incidents?limit=100';
    const param = filter === 'all' ? '' : `&resolved=${filter === 'resolved'}`;
    try {
      const res = await fetch(`${base}${param}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '获取告警失败');
      if (!isCurrent()) return;
      setIncidents(Array.isArray(data) ? data : []);
    } catch {
      if (isCurrent()) setIncidents([]);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchIncidents();
  }, [fetchIncidents]);

  async function handleResolve(id: number) {
    setResolvingId(id);
    try {
      await apiFetch(`/api/incidents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      });
      await fetchIncidents();
    } finally {
      setResolvingId(null);
    }
  }

  const filters: { key: FilterKey; label: string }[] = [
    { key: 'open', label: '未解决' },
    { key: 'resolved', label: '已解决' },
    { key: 'all', label: '全部' },
  ];

  const openCount = incidents.filter((i) => !i.resolved).length;

  return (
    <Tabs
      className="flex flex-col gap-6"
      value={filter}
      onValueChange={(value) => setFilter(value as FilterKey)}
    >
      <PageHeader
        icon={Bell}
        title="告警事件"
        actionsClassName="w-full justify-start sm:w-auto sm:justify-end"
        actions={(
          <TabsList className="grid w-full grid-cols-3 sm:w-auto">
            {filters.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>
            ))}
          </TabsList>
        )}
      />

      <TabsContent value={filter} className="mt-0">
        {loading ? (
        <Card className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载中…
        </Card>
      ) : incidents.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 p-12 text-center text-muted-foreground">
          {filter === 'open' ? (
            <>
              <CheckCircle2 className="h-8 w-8 text-emerald-500" />
              <p>没有未解决的告警</p>
            </>
          ) : (
            <>
              <Bell className="h-8 w-8 opacity-40" />
              <p>暂无告警记录</p>
            </>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {filter === 'all' && openCount > 0 && (
            <p className="text-xs text-muted-foreground">共 {openCount} 条未解决</p>
          )}
          {incidents.map((inc) => (
            <Card key={inc.id} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={inc.severity} />
                    <Badge variant="outline">{typeLabel(inc.type)}</Badge>
                    <Link
                      href={`/upstreams/${inc.upstream.id}`}
                      className="text-sm font-medium text-foreground hover:text-primary"
                    >
                      {inc.upstream.name}
                    </Link>
                    {inc.upstreamKey != null && inc.upstreamKey.group != null && (
                      <Badge variant="secondary">{inc.upstreamKey.group}</Badge>
                    )}
                    {inc.resolved && (
                      <Badge className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400">
                        <Check className="mr-1 h-3 w-3" />
                        已恢复
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-foreground">{inc.message}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(inc.createdAt).toLocaleString('zh-CN')}
                    {inc.resolvedAt != null &&
                      ` · 恢复于 ${new Date(inc.resolvedAt).toLocaleString('zh-CN')}`}
                  </div>
                </div>
                {!inc.resolved && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resolvingId === inc.id}
                    onClick={() => handleResolve(inc.id)}
                  >
                    {resolvingId === inc.id ? (
                      <Loader2 className="animate-spin" data-icon="inline-start" />
                    ) : (
                      <Check data-icon="inline-start" />
                    )}
                    标记已解决
                  </Button>
                )}
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
  const key = (severity || '').toUpperCase();
  if (key === 'CRITICAL') {
    return (
      <Badge variant="destructive">
        <AlertTriangle className="mr-1 h-3 w-3" />
        CRITICAL
      </Badge>
    );
  }
  if (key === 'WARNING') {
    return (
      <Badge className="border-transparent bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400">
        <AlertTriangle className="mr-1 h-3 w-3" />
        WARNING
      </Badge>
    );
  }
  return <Badge variant="secondary">INFO</Badge>;
}

function typeLabel(type: string): string {
  const map: Record<string, string> = {
    BALANCE_LOW: '余额不足',
    LATENCY_HIGH: '延迟过高',
    UNAVAILABLE: '不可用',
    AVAILABILITY_LOW: '可用率低',
    TEST_FAILED: '测速失败',
  };
  return map[type] || type;
}
