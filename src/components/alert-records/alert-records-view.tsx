'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  History,
  Loader2,
  SlidersHorizontal,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/page-header';
import { apiFetch } from '@/lib/api-fetch';
import { alertRuleConfigurationHref } from '@/lib/account-observability-ui';
import { beginLatestRequest } from '@/lib/request-sequence';

type ResolvedFilter = 'open' | 'resolved' | 'all';

interface PageResult<T> {
  items: T[];
  total: number;
}

interface UnifiedAlertEvent {
  id: number;
  type: 'operational' | 'account';
  subjectKey: string;
  subjectName: string;
  severity: string;
  detail: string | null;
  recoveryDetail: string | null;
  resolved: boolean;
  occurrenceCount: number;
  occurredAt: string;
  lastOccurredAt: string;
  resolvedAt: string | null;
  rule: { id: number; key: string; name: string };
  account: { id: number; sourceAccountId: string; name: string; platform: string | null } | null;
  metric: string | null;
  metricValue: number | null;
  canResolve: boolean;
}

interface AccountSchedulingAction {
  id: number;
  accountId: number | null;
  sourceAccountId: string;
  accountName: string | null;
  actionType: string;
  result: string;
  priorityBefore: number | null;
  priorityAfter: number | null;
  factor: number | null;
  conflictRecomputed: boolean;
  pausedUntil: string | null;
  reasonCode: string | null;
  errorCode: string | null;
  occurredAt: string;
}

const PAGE_SIZE = 20;
const METRICS = [
  'availability_low', 'error_rate_high', 'duration_p95_high', 'first_token_p95_high',
  'cache_hit_low', 'balance_low', 'upstream_rate_deviation', 'unschedulable', 'sync_stale', 'upstream_rate_multiplier',
] as const;

export function AlertRecordsView() {
  const [items, setItems] = useState<UnifiedAlertEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ResolvedFilter>('open');
  const [type, setType] = useState('all');
  const [rule, setRule] = useState('all');
  const [accountInput, setAccountInput] = useState('');
  const [severity, setSeverity] = useState('all');
  const [loading, setLoading] = useState(true);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const isCurrent = beginLatestRequest(requestSequence);
    setLoading(true);
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (status !== 'all') query.set('status', status);
    if (type !== 'all') query.set('type', type);
    if (rule !== 'all') query.set('rule', rule);
    if (/^[1-9]\d*$/.test(accountInput)) query.set('account', accountInput);
    if (severity !== 'all') query.set('severity', severity);
    try {
      const response = await apiFetch(`/api/alert-events?${query}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '获取告警记录失败');
      const result = normalizePage<UnifiedAlertEvent>(body);
      if (isCurrent()) { setItems(result.items); setTotal(result.total); }
    } catch {
      if (isCurrent()) { setItems([]); setTotal(0); }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [accountInput, page, rule, severity, status, type]);

  useEffect(() => { void load(); }, [load]);
  const updateFilter = (setter: (value: string) => void) => (value: string) => { setPage(1); setter(value); };

  async function handleResolve(event: UnifiedAlertEvent) {
    if (event.type !== 'account' || !event.canResolve) return;
    const key = `${event.type}-${event.id}`;
    setResolvingKey(key);
    try {
      const response = await apiFetch(`/api/account-alert-events/${event.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      });
      if (response.ok) await load();
    } finally {
      setResolvingKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={History} title="告警记录" />
      <section className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Select value={type} onValueChange={updateFilter(setType)}>
          <SelectTrigger aria-label="按告警类型筛选"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">全部类型</SelectItem><SelectItem value="operational">运维告警</SelectItem><SelectItem value="account">账号告警</SelectItem></SelectContent>
        </Select>
        <Select value={status} onValueChange={updateFilter((value) => setStatus(value as ResolvedFilter))}>
          <SelectTrigger aria-label="按恢复状态筛选"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="open">未恢复</SelectItem><SelectItem value="resolved">已恢复</SelectItem><SelectItem value="all">全部状态</SelectItem></SelectContent>
        </Select>
        <Select value={rule} onValueChange={updateFilter(setRule)}>
          <SelectTrigger aria-label="按规则或指标筛选"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">全部规则与指标</SelectItem>
              <SelectItem value="collection_failed">采集失败</SelectItem>
              <SelectItem value="priority_adjustment_failed">优先级调整失败</SelectItem>
              <SelectItem value="priority_cap_pause_failed">暂停账号失败</SelectItem>
              <SelectItem value="remote_backup_failed">备份失败</SelectItem>
              {METRICS.map((value) => <SelectItem key={value} value={value}>{metricLabel(value)}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Input inputMode="numeric" aria-label="按 Sub2API 账号 ID 筛选告警" placeholder="Sub2API 账号 ID" value={accountInput} onChange={(event) => { setPage(1); setAccountInput(event.target.value.replace(/\D/g, '')); }} />
        <SeverityFilter value={severity} onChange={updateFilter(setSeverity)} />
      </div>
      <RecordState loading={loading} empty={items.length === 0} emptyText={status === 'open' ? '当前没有未恢复告警' : '暂无告警记录'}>
        <div className="hidden overflow-x-auto rounded-md border sm:block">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead><tr className="border-b bg-muted/40"><Th>告警类型</Th><Th>规则 / 主题</Th><Th>账号</Th><Th>级别</Th><Th>触发时间</Th><Th>最近发生</Th><Th>次数</Th><Th>恢复时间</Th><Th>详情 / 操作</Th></tr></thead>
            <tbody>{items.map((event) => <tr key={`${event.type}-${event.id}`} className="border-b last:border-0">
              <Td><Badge variant="outline">{alertTypeLabel(event.type)}</Badge></Td>
              <Td><div className="font-medium">{event.rule.name}</div><div className="text-xs text-muted-foreground">{event.subjectName}</div></Td>
              <Td><AlertAccount event={event} /></Td><Td><SeverityBadge severity={event.severity} /></Td><Td>{formatTime(event.occurredAt)}</Td><Td>{formatTime(event.lastOccurredAt)}</Td>
              <Td>{event.occurrenceCount}</Td><Td>{formatTime(event.resolvedAt)}</Td><Td className="max-w-sm"><AlertDetail event={event} resolving={resolvingKey === `${event.type}-${event.id}`} onResolve={() => void handleResolve(event)} /></Td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="space-y-2 sm:hidden">{items.map((event) => <Card key={`${event.type}-${event.id}`} className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{alertTypeLabel(event.type)}</Badge><SeverityBadge severity={event.severity} /><span className="font-medium">{event.rule.name}</span>{event.resolved && <ResolvedBadge />}</div>
          <p className="text-sm">{event.subjectName}</p><AlertAccount event={event} /><AlertDetail event={event} resolving={resolvingKey === `${event.type}-${event.id}`} onResolve={() => void handleResolve(event)} />
          <dl className="grid grid-cols-2 gap-2 text-xs"><Fact label="触发" value={formatTime(event.occurredAt)} /><Fact label="最近发生" value={formatTime(event.lastOccurredAt)} /><Fact label="次数" value={String(event.occurrenceCount)} /><Fact label="恢复" value={formatTime(event.resolvedAt)} /></dl>
        </Card>)}</div>
      </RecordState>
      <Pagination page={page} total={total} onPage={setPage} />
      </section>
    </div>
  );
}

function AlertAccount({ event }: { event: UnifiedAlertEvent }) {
  if (!event.account) return <span className="text-muted-foreground">-</span>;
  return (
    <div className="min-w-0">
      <Link href={`/accounts/${event.account.id}`} className="block truncate font-medium hover:text-primary">{event.account.name}</Link>
      <div className="text-xs text-muted-foreground">Sub2API ID: {event.account.sourceAccountId}</div>
    </div>
  );
}

function AlertDetail({ event, resolving, onResolve }: { event: UnifiedAlertEvent; resolving: boolean; onResolve: () => void }) {
  const canConfigure = isConfigurableAccountAlert(event);
  return (
    <div className="space-y-2">
      <p className="break-words text-sm">{event.detail || '-'}</p>
      {(canConfigure || event.canResolve) && <div className="flex flex-wrap gap-2">
        {canConfigure && <Button asChild variant="outline" size="sm"><Link href={alertRuleConfigurationHref(event)}><SlidersHorizontal data-icon="inline-start" />配置规则</Link></Button>}
        {event.canResolve && <Button variant="outline" size="sm" disabled={resolving} onClick={onResolve}>{resolving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Check data-icon="inline-start" />}标记已解决</Button>}
      </div>}
    </div>
  );
}

function isConfigurableAccountAlert(event: UnifiedAlertEvent): event is UnifiedAlertEvent & {
  type: 'account';
  account: NonNullable<UnifiedAlertEvent['account']>;
  metric: string;
} {
  return event.type === 'account' && event.account !== null && event.metric !== null;
}

export function SchedulingActions() {
  const [items, setItems] = useState<AccountSchedulingAction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [accountInput, setAccountInput] = useState('');
  const [actionType, setActionType] = useState('all');
  const [result, setResult] = useState('all');
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    const isCurrent = beginLatestRequest(requestSequence);
    setLoading(true);
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (/^[1-9]\d*$/.test(accountInput)) query.set('account', accountInput);
    if (actionType !== 'all') query.set('actionType', actionType);
    if (result !== 'all') query.set('result', result);
    try {
      const response = await apiFetch(`/api/account-scheduling-actions?${query}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '获取调度记录失败');
      const normalized = normalizePage<AccountSchedulingAction>(body);
      if (isCurrent()) { setItems(normalized.items); setTotal(normalized.total); }
    } catch {
      if (isCurrent()) { setItems([]); setTotal(0); }
    } finally { if (isCurrent()) setLoading(false); }
  }, [accountInput, actionType, page, result]);
  useEffect(() => { void load(); }, [load]);

  return <section className="space-y-3">
    <div className="grid gap-2 sm:grid-cols-3">
      <Input inputMode="numeric" aria-label="按 Sub2API 账号 ID 筛选调度操作" placeholder="Sub2API 账号 ID" value={accountInput} onChange={(event) => { setPage(1); setAccountInput(event.target.value.replace(/\D/g, '')); }} />
      <Select value={actionType} onValueChange={(value) => { setPage(1); setActionType(value); }}><SelectTrigger aria-label="按操作类型筛选"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部操作</SelectItem><SelectItem value="PRIORITY_ADJUST">优先级增加</SelectItem><SelectItem value="PRIORITY_RESTORE">优先级恢复</SelectItem><SelectItem value="PRIORITY_CAP_PAUSE">封顶暂停</SelectItem></SelectContent></Select>
      <Select value={result} onValueChange={(value) => { setPage(1); setResult(value); }}><SelectTrigger aria-label="按操作结果筛选"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部结果</SelectItem><SelectItem value="SUCCESS">成功</SelectItem><SelectItem value="FAILURE">失败</SelectItem><SelectItem value="SAFE_SKIP">安全跳过</SelectItem></SelectContent></Select>
    </div>
    <RecordState loading={loading} empty={items.length === 0} emptyText="暂无调度操作记录">
      <div className="hidden overflow-x-auto rounded-md border sm:block"><table className="w-full min-w-[860px] text-left text-sm"><thead><tr className="border-b bg-muted/40"><Th>账号</Th><Th>操作</Th><Th>结果</Th><Th>变化</Th><Th>原因</Th><Th>时间</Th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-b last:border-0"><Td><AccountLink item={item} /></Td><Td>{actionLabel(item.actionType)}</Td><Td><ResultBadge result={item.result} /></Td><Td>{actionChange(item)}</Td><Td>{item.reasonCode || item.errorCode || (item.conflictRecomputed ? '冲突后重算' : '-')}</Td><Td>{formatTime(item.occurredAt)}</Td></tr>)}</tbody></table></div>
      <div className="space-y-2 sm:hidden">{items.map((item) => <Card key={item.id} className="space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium"><AccountLink item={item} /></span><ResultBadge result={item.result} /></div><p className="text-sm">{actionLabel(item.actionType)} · {actionChange(item)}</p><p className="break-words text-sm text-muted-foreground">{item.reasonCode || item.errorCode || (item.conflictRecomputed ? '冲突后重算' : '-')}</p><p className="text-xs text-muted-foreground">{formatTime(item.occurredAt)}</p></Card>)}</div>
    </RecordState>
    <Pagination page={page} total={total} onPage={setPage} />
  </section>;
}

function RecordState({ loading, empty, emptyText, children }: { loading: boolean; empty: boolean; emptyText: string; children: React.ReactNode }) {
  if (loading) return <Card className="flex h-40 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中...</Card>;
  if (empty) return <Card className="flex flex-col items-center justify-center gap-2 p-12 text-center text-muted-foreground"><CheckCircle2 className="h-8 w-8 opacity-40" /><p>{emptyText}</p></Card>;
  return children;
}

function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  if (total <= PAGE_SIZE) return null;
  return <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">共 {total} 条</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button><Button size="sm" variant="outline" disabled={page * PAGE_SIZE >= total} onClick={() => onPage(page + 1)}>下一页</Button></div></div>;
}

function SeverityFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label="按严重级别筛选"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部级别</SelectItem><SelectItem value="INFO">INFO</SelectItem><SelectItem value="WARNING">WARNING</SelectItem><SelectItem value="CRITICAL">CRITICAL</SelectItem></SelectContent></Select>;
}

function SeverityBadge({ severity }: { severity: string }) {
  if (severity === 'CRITICAL') return <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" />CRITICAL</Badge>;
  if (severity === 'WARNING') return <Badge className="border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400"><AlertTriangle className="mr-1 h-3 w-3" />WARNING</Badge>;
  return <Badge variant="secondary">INFO</Badge>;
}

function ResolvedBadge() { return <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"><Check className="mr-1 h-3 w-3" />已恢复</Badge>; }
function ResultBadge({ result }: { result: string }) {
  if (result === 'FAILURE') return <Badge variant="destructive">失败</Badge>;
  if (result === 'SUCCESS') return <Badge className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">成功</Badge>;
  return <Badge variant="secondary">安全跳过</Badge>;
}
function AccountLink({ item }: { item: AccountSchedulingAction }) {
  const name = item.accountName || `账号 ${item.sourceAccountId}`;
  const content = <div><div className="font-medium">{name}</div><div className="text-xs text-muted-foreground">Sub2API ID: {item.sourceAccountId}</div></div>;
  return item.accountId ? <Link href={`/accounts/${item.accountId}`} className="block hover:text-primary">{content}</Link> : content;
}
function Fact({ label, value }: { label: string; value: string }) { return <div><dt className="text-muted-foreground">{label}</dt><dd className="mt-0.5 break-words">{value}</dd></div>; }
function Th({ children }: { children: React.ReactNode }) { return <th className="whitespace-nowrap px-3 py-2 font-medium text-muted-foreground">{children}</th>; }
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) { return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>; }
function formatTime(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN') : '-'; }
function normalizePage<T>(body: unknown): PageResult<T> {
  if (Array.isArray(body)) return { items: body as T[], total: body.length };
  if (body && typeof body === 'object') {
    const candidate = body as {
      items?: unknown;
      events?: unknown;
      actions?: unknown;
      total?: unknown;
      pagination?: { totalItems?: unknown };
    };
    const collection = candidate.items ?? candidate.events ?? candidate.actions;
    const items = Array.isArray(collection) ? collection as T[] : [];
    const totalValue = candidate.total ?? candidate.pagination?.totalItems;
    return { items, total: typeof totalValue === 'number' ? totalValue : items.length };
  }
  return { items: [], total: 0 };
}
function actionLabel(value: string): string { return { PRIORITY_ADJUST: '优先级增加', PRIORITY_RESTORE: '优先级恢复', PRIORITY_CAP_PAUSE: '封顶暂停' }[value] ?? value; }
function actionChange(item: AccountSchedulingAction): string {
  if (item.pausedUntil) return `暂停至 ${formatTime(item.pausedUntil)}`;
  if (item.priorityBefore != null || item.priorityAfter != null) return `${item.priorityBefore ?? '-'} → ${item.priorityAfter ?? '-'}${item.factor == null ? '' : ` · 系数 ${item.factor}`}`;
  return '-';
}

function alertTypeLabel(type: UnifiedAlertEvent['type']): string {
  return type === 'operational' ? '运维告警' : '账号告警';
}

function metricLabel(metric: string): string {
  return {
    availability_low: '可用率低', error_rate_high: '错误率高', duration_p95_high: '总延迟 P95 高',
    first_token_p95_high: '首 Token P95 高', cache_hit_low: '缓存命中率低', balance_low: '上游余额低',
    upstream_rate_deviation: '上游倍率偏差高', unschedulable: '不可调度', sync_stale: '同步陈旧',
    upstream_rate_multiplier: '上游倍率',
  }[metric] ?? metric;
}
