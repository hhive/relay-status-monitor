'use client';

import { useEffect, useState } from 'react';
import { BookOpen, ExternalLink, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-fetch';

type DocsState = { status: string; lastRunAt: string | null; message: string };

export default function DocsManagementPage() {
  const [state, setState] = useState<DocsState | null>(null);
  const [loading, setLoading] = useState(false);
  async function load() { const response = await apiFetch('/api/docs/status'); if (response.ok) setState(await response.json()); }
  async function sync() {
    setLoading(true);
    try { const response = await apiFetch('/api/docs/sync', { method: 'POST' }); if (response.ok) setState(await response.json()); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  return (
    <div className="space-y-6">
      <PageHeader icon={BookOpen} title="文档管理" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>VitePress 文档站</CardTitle></CardHeader><CardContent className="flex items-center justify-between gap-4"><p className="text-sm text-muted-foreground">独立静态站点展示已发布的 Sub2API 文档。</p><Button asChild variant="outline" size="sm"><a href="/docs/" target="_blank" rel="noreferrer">打开站点 <ExternalLink /></a></Button></CardContent></Card>
        <Card><CardHeader><CardTitle>飞书同步</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">{state?.message ?? '正在读取状态'}</p>{state?.lastRunAt && <p className="text-xs text-muted-foreground">最近请求：{new Date(state.lastRunAt).toLocaleString()}</p>}<Button onClick={sync} disabled={loading || state?.status === 'running'}><RefreshCw className={loading ? 'animate-spin' : ''} />立即同步</Button></CardContent></Card>
      </div>
    </div>
  );
}
