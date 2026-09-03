'use client';

import { useEffect, useState } from 'react';
import { BookOpen, ExternalLink, RefreshCw, Save, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-fetch';

type DocsState = { status: string; lastRunAt: string | null; message: string };
type Doc = { id: string; title: string; source: 'feishu' | 'local'; content: string };

export default function DocsManagementPage() {
  const [state, setState] = useState<DocsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [draft, setDraft] = useState({ id: '', title: '', content: '' });
  async function load() { const response = await apiFetch('/api/docs/status'); if (response.ok) setState(await response.json()); }
  async function loadDocuments() { const response = await apiFetch('/api/docs/documents'); if (response.ok) setDocuments((await response.json()).documents); }
  async function sync() {
    setLoading(true);
    try { const response = await apiFetch('/api/docs/sync', { method: 'POST' }); if (response.ok) setState(await response.json()); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { void loadDocuments(); }, []);
  async function saveDocument() {
    const method = draft.id && documents.some((doc) => doc.id === draft.id && doc.source === 'local') ? 'PUT' : 'POST';
    const endpoint = method === 'POST' ? '/api/docs/documents' : `/api/docs/documents/${encodeURIComponent(draft.id)}`;
    const response = await apiFetch(endpoint, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
    if (response.ok) { setDraft({ id: '', title: '', content: '' }); await loadDocuments(); }
  }
  async function removeDocument(id: string) { if ((await apiFetch(`/api/docs/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })).ok) await loadDocuments(); }
  return (
    <div className="space-y-6">
      <PageHeader icon={BookOpen} title="文档管理" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle>VitePress 文档站</CardTitle></CardHeader><CardContent className="flex items-center justify-between gap-4"><p className="text-sm text-muted-foreground">独立静态站点展示已发布的 Sub2API 文档。</p><Button asChild variant="outline" size="sm"><a href="/docs/" target="_blank" rel="noreferrer">打开站点 <ExternalLink /></a></Button></CardContent></Card>
        <Card><CardHeader><CardTitle>飞书同步</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">{state?.message ?? '正在读取状态'}</p>{state?.lastRunAt && <p className="text-xs text-muted-foreground">最近请求：{new Date(state.lastRunAt).toLocaleString()}</p>}<Button onClick={sync} disabled={loading || state?.status === 'running'}><RefreshCw className={loading ? 'animate-spin' : ''} />立即同步</Button></CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>本地文档</CardTitle></CardHeader><CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-3"><input className="rounded border px-2 py-1 text-sm" placeholder="文档标识" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} disabled={documents.some((doc) => doc.id === draft.id && doc.source === 'local')} /><input className="rounded border px-2 py-1 text-sm" placeholder="标题" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /><Button size="sm" onClick={saveDocument}><Save />保存</Button></div>
        <textarea className="min-h-40 w-full rounded border p-2 font-mono text-sm" placeholder="Markdown 内容" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
        <div className="divide-y rounded border">{documents.map((doc) => <div key={`${doc.source}-${doc.id}`} className="flex items-center justify-between gap-2 p-2 text-sm"><button className="text-left hover:underline" onClick={() => doc.source === 'local' && setDraft({ id: doc.id, title: doc.title, content: doc.content })}>{doc.title} <span className="text-xs text-muted-foreground">({doc.source === 'feishu' ? '飞书' : '本地'})</span></button>{doc.source === 'local' && <Button variant="ghost" size="icon" onClick={() => removeDocument(doc.id)} aria-label="删除"><Trash2 /></Button>}</div>)}</div>
      </CardContent></Card>
    </div>
  );
}
