'use client';

import { useEffect, useState } from 'react';
import { BookOpen, ExternalLink, RefreshCw, Save, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-fetch';

type DocsState = { status: string; lastRunAt: string | null; message: string };
type Doc = { id: string; title: string; source: 'feishu' | 'local'; content: string };
type FeishuConfig = { url: string; appId: string; apiBase: string; output: string; secretConfigured: boolean };

export default function DocsManagementPage() {
  const [state, setState] = useState<DocsState | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [draft, setDraft] = useState({ id: '', title: '', content: '' });
  const [config, setConfig] = useState({ url: '', appId: '', appSecret: '', apiBase: 'https://open.feishu.cn', output: '' });
  const [configState, setConfigState] = useState<FeishuConfig | null>(null);
  async function load() { const response = await apiFetch('/api/docs/status'); if (response.ok) setState(await response.json()); }
  async function loadDocuments() { const response = await apiFetch('/api/docs/documents'); if (response.ok) setDocuments((await response.json()).documents); }
  async function sync() {
    setLoading(true);
    setSyncError(null);
    try {
      const response = await apiFetch('/api/docs/sync', { method: 'POST' });
      const body = await response.json().catch(() => ({})) as DocsState & { error?: string };
      if (!response.ok) { setSyncError(body.error ?? `同步请求失败（HTTP ${response.status}）`); return; }
      setState(body);
      if (body.status === 'failed') setSyncError(body.message || '同步失败');
      await loadDocuments();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : '同步请求失败');
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { void loadDocuments(); }, []);
  useEffect(() => { apiFetch('/api/docs/config').then((response) => response.ok ? response.json() : null).then((value) => { if (value) { setConfigState(value); setConfig((current) => ({ ...current, url: value.url, appId: value.appId, apiBase: value.apiBase, output: value.output })); } }); }, []);
  async function saveConfig() { const response = await apiFetch('/api/docs/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) }); if (response.ok) { setConfigState(await response.json()); setConfig((current) => ({ ...current, appSecret: '' })); } }
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
        <Card><CardHeader><CardTitle>飞书同步</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-muted-foreground">{state?.message ?? '正在读取状态'}</p>{state?.lastRunAt && <p className="text-xs text-muted-foreground">最近请求：{new Date(state.lastRunAt).toLocaleString()}</p>}{syncError && <p role="alert" className="text-sm text-destructive">{syncError}</p>}<Button onClick={sync} disabled={loading || state?.status === 'running'}><RefreshCw className={loading ? 'animate-spin' : ''} />立即同步</Button></CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>飞书配置</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>文档链接</span><input className="w-full rounded border px-2 py-1" value={config.url} onChange={(e) => setConfig({ ...config, url: e.target.value })} placeholder="https://example.feishu.cn/docx/..." /></label>
        <label className="space-y-1 text-sm"><span>App ID</span><input className="w-full rounded border px-2 py-1" value={config.appId} onChange={(e) => setConfig({ ...config, appId: e.target.value })} /></label>
        <label className="space-y-1 text-sm"><span>App Secret {configState?.secretConfigured ? '(已配置，留空保持不变)' : ''}</span><input type="password" className="w-full rounded border px-2 py-1" value={config.appSecret} onChange={(e) => setConfig({ ...config, appSecret: e.target.value })} autoComplete="new-password" /></label>
        <label className="space-y-1 text-sm"><span>API 地址</span><input className="w-full rounded border px-2 py-1" value={config.apiBase} onChange={(e) => setConfig({ ...config, apiBase: e.target.value })} /></label>
        <label className="space-y-1 text-sm md:col-span-2"><span>同步输出路径（可选）</span><input className="w-full rounded border px-2 py-1" value={config.output} onChange={(e) => setConfig({ ...config, output: e.target.value })} placeholder="默认 docs-site/feishu.md" /></label>
        <div><Button onClick={saveConfig}><Save />保存飞书配置</Button></div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>本地文档</CardTitle></CardHeader><CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-3"><input className="rounded border px-2 py-1 text-sm" placeholder="文档标识" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} disabled={documents.some((doc) => doc.id === draft.id && doc.source === 'local')} /><input className="rounded border px-2 py-1 text-sm" placeholder="标题" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /><Button size="sm" onClick={saveDocument}><Save />保存</Button></div>
        <textarea className="min-h-40 w-full rounded border p-2 font-mono text-sm" placeholder="Markdown 内容" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
        <div className="divide-y rounded border">{documents.map((doc) => <div key={`${doc.source}-${doc.id}`} className="flex items-center justify-between gap-2 p-2 text-sm"><button className="text-left hover:underline" onClick={() => doc.source === 'local' && setDraft({ id: doc.id, title: doc.title, content: doc.content })}>{doc.title} <span className="text-xs text-muted-foreground">({doc.source === 'feishu' ? '飞书' : '本地'})</span></button>{doc.source === 'local' && <Button variant="ghost" size="icon" onClick={() => removeDocument(doc.id)} aria-label="删除"><Trash2 /></Button>}</div>)}</div>
      </CardContent></Card>
    </div>
  );
}
