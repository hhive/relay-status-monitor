'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Pencil, Trash2, Zap, KeyRound, RefreshCw, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { StatusDot } from '@/components/StatusBadge';
import { useConfirm } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { formatGroupMultiplier, getKeyDisplayName, getKeyGroupLabel } from '@/lib/key-display';
import { beginLatestRequest } from '@/lib/request-sequence';
import {
  UpstreamsDataTable,
  type UpstreamTableQuery,
  type UpstreamTableSorting,
} from '@/components/upstreams-data-table';
import type { UpstreamKeyRow, UpstreamRow } from '@/components/upstreams-columns';
import { buildUpstreamListSearchParams } from '@/lib/upstream-query';
import { PageHeader } from '@/components/page-header';
import { apiFetch } from '@/lib/api-fetch';

type UpstreamKey = UpstreamKeyRow;
type Upstream = UpstreamRow;

export default function UpstreamsPage() {
  const { confirm, dialog } = useConfirm();
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Upstream | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [query, setQuery] = useState<UpstreamTableQuery>({
    search: '',
    type: 'ALL',
    status: 'ALL',
  });
  const [sorting, setSorting] = useState<UpstreamTableSorting>({ direction: 'asc' });
  const requestSequence = useRef(0);
  const lastRequestedSearch = useRef('');

  const fetchData = useCallback(async () => {
    const isCurrent = beginLatestRequest(requestSequence);
    setLoading(true);
    try {
      const params = buildUpstreamListSearchParams({
        page,
        pageSize,
        search: query.search,
        type: query.type,
        status: query.status,
        sort: sorting.sort,
        direction: sorting.direction,
      });
      const res = await fetch(`/api/upstreams?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '获取上游失败');
      if (!isCurrent()) return;
      const nextPagination = data.pagination || { page, pageSize, total: 0, totalPages: 1 };
      setUpstreams(Array.isArray(data.items) ? data.items : []);
      setPagination(nextPagination);
      if (nextPagination.page !== page) setPage(nextPagination.page);
    } catch (error) {
      if (isCurrent()) toast.error((error as Error).message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [page, pageSize, query, sorting]);

  useEffect(() => {
    requestSequence.current += 1;
    const delay = query.search === lastRequestedSearch.current ? 0 : 300;
    const timer = window.setTimeout(() => {
      lastRequestedSearch.current = query.search;
      void fetchData();
    }, delay);

    return () => window.clearTimeout(timer);
  }, [fetchData, query.search]);

  function handleEdit(u: Upstream) { setEditing(u); setShowForm(true); }
  function handleAdd() { setEditing(null); setShowForm(true); }

  async function handleDelete(id: number, name: string) {
    const ok = await confirm({
      title: `删除上游「${name}」？`,
      description: '该操作会删除该上游及其所有分组、指标和告警数据，不可恢复。',
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    const res = await apiFetch(`/api/upstreams/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      toast.error(data?.error || `删除 ${name} 失败`);
      return;
    }
    toast.success(`已删除 ${name}`);
    if (upstreams.length === 1 && pagination.page > 1) {
      setPage(pagination.page - 1);
    } else {
      fetchData();
    }
  }

  async function handleToggle(id: number, enabled: boolean) {
    await apiFetch(`/api/upstreams/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    });
    fetchData();
  }

  async function handleTest(id: number, name: string) {
    const tid = toast.loading(`正在测试 ${name}…`);
    try {
      const res = await apiFetch(`/api/upstreams/${id}/test`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        const okCount = data.results?.filter((r: { status: string }) => r.status === 'ok').length || 0;
        const failCount = data.results?.length - okCount || 0;
        toast.success(`${name} 测试完成：${okCount} 成功${failCount > 0 ? `，${failCount} 失败` : ''}`, { id: tid });
      } else {
        toast.error(data.error || '测试失败', { id: tid });
      }
      fetchData();
    } catch (e) {
      toast.error('请求失败: ' + (e as Error).message, { id: tid });
    }
  }

  return (
    <div className="space-y-6">
      {dialog}
      <PageHeader
        icon={Server}
        title="上游管理"
        actions={(
          <Button size="sm" onClick={handleAdd}>
            <Plus data-icon="inline-start" />
            添加上游
          </Button>
        )}
      />

      <UpstreamsDataTable
        data={upstreams}
        query={query}
        sorting={sorting}
        pagination={pagination}
        loading={loading}
        onQueryChange={setQuery}
        onSortingChange={setSorting}
        onPaginationChange={({ page: nextPage, pageSize: nextPageSize }) => {
          setPage(nextPage);
          setPageSize(nextPageSize);
        }}
        onTest={(upstream) => handleTest(upstream.id, upstream.name)}
        onEdit={handleEdit}
        onToggle={(upstream) => handleToggle(upstream.id, upstream.enabled)}
        onDelete={(upstream) => handleDelete(upstream.id, upstream.name)}
      />

      {showForm && (
        <UpstreamFormDialog upstream={editing} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); fetchData(); }} />
      )}
    </div>
  );
}

// ============ 上游编辑弹窗 ============
function UpstreamFormDialog({ upstream, onClose, onSaved }: {
  upstream: Upstream | null; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(upstream?.name || '');
  const [baseUrl, setBaseUrl] = useState(upstream?.baseUrl || '');
  const [type, setType] = useState(upstream?.type || 'SUB2API');
  const [testModel, setTestModel] = useState(upstream?.testModel || '');
  const [enabled, setEnabled] = useState(upstream?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      const body = { name, baseUrl, type, testModel, enabled };
      const url = upstream ? `/api/upstreams/${upstream.id}` : '/api/upstreams';
      const method = upstream ? 'PUT' : 'POST';
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json(); setError(d.error || '保存失败'); return; }
      onSaved();
    } catch (e) { setError('保存失败: ' + (e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{upstream ? `编辑上游 - ${upstream.name}` : '添加上游'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：聪明AI" required />
            </div>
            <div className="space-y-1.5">
              <Label>地址</Label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="relay.example.com" required />
            </div>
            <div className="space-y-1.5">
              <Label>类型</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="SUB2API">SUB2API</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>默认测速模型</Label>
              <Input value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder="gpt-4o-mini" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="ue-enabled" />
            <Label htmlFor="ue-enabled">启用监控</Label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={onClose}>取消</Button>
            <Button type="submit" size="sm" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </form>
        {upstream && (
          <>
            <Separator />
            <KeyManager upstreamId={upstream.id} type={type} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============ 分组 Keys 管理器 ============
function KeyManager({ upstreamId, type }: { upstreamId: number; type: string }) {
  const { confirm, dialog } = useConfirm();
  const [keys, setKeys] = useState<UpstreamKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [editingKey, setEditingKey] = useState<UpstreamKey | null>(null);
  const [refreshingKeyId, setRefreshingKeyId] = useState<number | null>(null);

  const fetchKeys = useCallback(async () => {
    const res = await fetch(`/api/upstreams/${upstreamId}/keys`);
    setKeys(await res.json());
    setLoading(false);
  }, [upstreamId]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  async function handleDeleteKey(keyId: number, group: string) {
    const ok = await confirm({
      title: `删除分组「${group}」？`,
      description: '该分组的所有指标数据将被删除。',
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    await apiFetch(`/api/upstreams/${upstreamId}/keys/${keyId}`, { method: 'DELETE' });
    toast.success(`已删除分组 ${group}`);
    fetchKeys();
  }

  async function handleTestKey(keyId: number, group: string) {
    const tid = toast.loading(`正在测试 ${group}…`);
    try {
      const res = await apiFetch(`/api/keys/${keyId}/test`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast.success(`${group}: 余额 ${data.balance != null ? `$${data.balance.toFixed(2)}` : '—'}, 延迟 ${data.latencyMs != null ? `${data.latencyMs}ms` : '—'}`, { id: tid });
      } else {
        toast.error(`${group}: ${data.error}`, { id: tid });
      }
      fetchKeys();
    } catch (e) { toast.error((e as Error).message, { id: tid }); }
  }

  async function handleRefreshKey(key: UpstreamKey) {
    setRefreshingKeyId(key.id);
    try {
      const res = await apiFetch(`/api/keys/${key.id}/metadata`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || '远端信息获取失败');
        return;
      }
      toast.success('远端信息已更新');
      await fetchKeys();
    } catch (e) {
      toast.error('请求失败: ' + (e as Error).message);
    } finally {
      setRefreshingKeyId(null);
    }
  }

  if (loading) return <div className="text-sm text-muted-foreground">加载分组…</div>;

  return (
    <div className="space-y-3">
      {dialog}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><KeyRound className="h-4 w-4" />分组密钥</h3>
        <Button size="sm" variant="outline" onClick={() => { setEditingKey(null); setShowKeyForm(true); }}>
          <Plus data-icon="inline-start" />
          添加分组
        </Button>
      </div>
      {keys.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">暂无分组</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex flex-col items-stretch gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot status={k.status} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium" title={getKeyDisplayName(k)}>
                    {type === 'NEW_API' ? getKeyDisplayName(k) : k.group}
                  </div>
                  <div className="break-words text-xs text-muted-foreground">
                    {type === 'NEW_API' && (
                      <>
                        分组：{getKeyGroupLabel(k)} · 倍率：{formatGroupMultiplier(k.groupRateMultiplier)}
                        {k.groupDescription ? ` · ${k.groupDescription}` : ''}
                        {' · '}
                      </>
                    )}
                    {k.lastBalance != null && `$${k.lastBalance.toFixed(2)} · `}
                    {k.hasApiKey ? 'Key' : '无Key'}
                    {type === 'NEW_API' && (k.hasAccessToken ? ' + 令牌' : ' + 无令牌')}
                  </div>
                </div>
              </div>
              <div className="flex w-full flex-wrap justify-end gap-1 sm:w-auto sm:shrink-0">
                {type === 'NEW_API' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="重新获取远端信息"
                    title="重新获取远端信息"
                    disabled={refreshingKeyId === k.id}
                    onClick={() => handleRefreshKey(k)}
                  >
                    <RefreshCw data-icon="inline-start" className={refreshingKeyId === k.id ? 'animate-spin' : undefined} />
                    {refreshingKeyId === k.id ? '刷新中…' : '刷新'}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => handleTestKey(k.id, k.group)}>
                  <Zap data-icon="inline-start" />
                  测试
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditingKey(k); setShowKeyForm(true); }}>
                  <Pencil data-icon="inline-start" />
                  编辑
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-destructive"
                  aria-label={`删除分组 ${k.group}`}
                  title={`删除分组 ${k.group}`}
                  onClick={() => handleDeleteKey(k.id, k.group)}
                >
                  <Trash2 data-icon="inline-start" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showKeyForm && (
        <KeyFormDialog upstreamId={upstreamId} upstreamType={type} keyData={editingKey} onClose={() => setShowKeyForm(false)} onSaved={() => { setShowKeyForm(false); fetchKeys(); }} />
      )}
    </div>
  );
}

// ============ 单个 Key 表单 ============
function KeyFormDialog({ upstreamId, upstreamType, keyData, onClose, onSaved }: {
  upstreamId: number; upstreamType: string; keyData: UpstreamKey | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [group, setGroup] = useState(keyData?.group || '');
  const [label, setLabel] = useState(keyData?.label || '');
  const [apiKey, setApiKey] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [userId, setUserId] = useState(keyData?.userId || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      const body: Record<string, unknown> = { group, label, userId };
      if (apiKey) body.apiKey = apiKey;
      if (accessToken) body.accessToken = accessToken;
      const url = keyData ? `/api/upstreams/${upstreamId}/keys/${keyData.id}` : `/api/upstreams/${upstreamId}/keys`;
      const method = keyData ? 'PUT' : 'POST';
      const res = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json(); setError(d.error || '保存失败'); return; }
      toast.success(keyData ? '分组已更新' : '分组已创建');
      onSaved();
    } catch (e) { setError('保存失败: ' + (e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{keyData ? `编辑分组 - ${keyData.group}` : '添加分组'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>分组名</Label>
              <Input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="default" required />
              <p className="text-xs text-muted-foreground">采集后自动更新为上游真实分组名</p>
            </div>
            <div className="space-y-1.5">
              <Label>标签</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备注" />
            </div>
          </div>
          {upstreamType === 'NEW_API' && keyData && (
            <div className="rounded-md border p-3 text-sm">
              <div className="mb-2 font-medium">远端信息</div>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">秘钥名称</dt>
                  <dd className="mt-0.5 break-words">{getKeyDisplayName(keyData)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">分组名称</dt>
                  <dd className="mt-0.5 break-words">{getKeyGroupLabel(keyData)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">分组说明</dt>
                  <dd className="mt-0.5 break-words">{keyData.groupDescription || '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">倍率</dt>
                  <dd className="mt-0.5">{formatGroupMultiplier(keyData.groupRateMultiplier)}</dd>
                </div>
              </dl>
              {keyData.metadataError && (
                <p className="mt-2 text-xs text-destructive">{keyData.metadataError}</p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>API Key {keyData?.hasApiKey && <span className="text-xs text-muted-foreground">（留空保持不变）</span>}</Label>
            <Input type="password" className="font-mono text-xs" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyData?.hasApiKey ? '已配置' : 'sk-xxx'} />
          </div>
          {upstreamType === 'NEW_API' && (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <KeyRound className="h-3.5 w-3.5" />New API 查余额凭证
              </div>
              <div className="space-y-1.5">
                <Label>AccessToken {keyData?.hasAccessToken && <span className="text-xs text-muted-foreground">（留空不变）</span>}</Label>
                <Input type="password" className="font-mono text-xs" value={accessToken} onChange={(e) => setAccessToken(e.target.value)}
                  placeholder={keyData?.hasAccessToken ? '已配置' : '系统访问令牌'} />
              </div>
              <div className="space-y-1.5">
                <Label>用户 ID</Label>
                <Input className="font-mono" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="数字ID" />
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" onClick={onClose}>取消</Button>
            <Button type="submit" size="sm" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
