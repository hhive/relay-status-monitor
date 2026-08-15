'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  BellRing,
  Layers3,
  MessageSquare,
  SlidersHorizontal,
  KeyRound,
  Plus,
  Trash2,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Webhook,
  ShieldCheck,
  Settings,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { resolveRuleNumberDraft } from '@/lib/rule-number-draft';
import { buildSettingsUpdatePayload } from '@/lib/settings-form';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { parseAlertRuleTarget } from '@/lib/account-observability-ui';

interface AlertRule {
  id: number;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  severity: string;
  minRequests: number;
  minPromptTokens: number;
  cooldownMin: number;
  enabled: boolean;
}

interface AlertChannel {
  id: number;
  name: string;
  type: string;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  enabled: boolean;
}

interface GroupAlertSetting {
  groupId: number;
  name: string;
  alertEnabled: boolean;
  exclusiveAccountCount: number;
  boundAccountCount: number;
}

type NumericRuleField = 'threshold' | 'minRequests' | 'minPromptTokens' | 'cooldownMin';
type RuleDraft = Record<NumericRuleField, string>;
type RuleDrafts = Record<number, RuleDraft>;

function createRuleDrafts(rules: AlertRule[]): RuleDrafts {
  return Object.fromEntries(
    rules.map((rule) => [
      rule.id,
      {
        threshold: String(rule.threshold),
        minRequests: String(rule.minRequests),
        minPromptTokens: String(rule.minPromptTokens),
        cooldownMin: String(rule.cooldownMin),
      },
    ])
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader icon={Settings} title="设置" />

      <Tabs defaultValue="rules" className="w-full">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-5">
          <TabsTrigger value="rules">
            <BellRing />
            告警规则
          </TabsTrigger>
          <TabsTrigger value="group-alerts">
            <Layers3 />
            分组告警
          </TabsTrigger>
          <TabsTrigger value="channels">
            <MessageSquare />
            通知渠道
          </TabsTrigger>
          <TabsTrigger value="system">
            <SlidersHorizontal />
            系统配置
          </TabsTrigger>
          <TabsTrigger value="password">
            <KeyRound />
            修改密码
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-4">
          <RulesTab />
        </TabsContent>
        <TabsContent value="group-alerts" className="mt-4">
          <GroupAlertsTab />
        </TabsContent>
        <TabsContent value="channels" className="mt-4">
          <ChannelsTab />
        </TabsContent>
        <TabsContent value="system" className="mt-4">
          <SystemTab />
        </TabsContent>
        <TabsContent value="password" className="mt-4">
          <PasswordTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============ 告警规则 ============
function RulesTab() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [drafts, setDrafts] = useState<RuleDrafts>({});
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [targetRuleId, setTargetRuleId] = useState<number | null>(null);
  const scrolledRuleId = useRef<number | null>(null);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/account-alert-rules');
      const data = await res.json();
      const nextRules = Array.isArray(data) ? data : [];
      setRules(nextRules);
      setDrafts(createRuleDrafts(nextRules));
    } catch {
      setRules([]);
      setDrafts({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  useEffect(() => {
    setTargetRuleId(parseAlertRuleTarget(new URLSearchParams(window.location.search).get('rule')));
  }, []);

  useEffect(() => {
    if (loading || targetRuleId === null || scrolledRuleId.current === targetRuleId) return;
    if (!rules.some((rule) => rule.id === targetRuleId)) return;
    const target = document.getElementById(`rule-${targetRuleId}`);
    if (!target) return;
    scrolledRuleId.current = targetRuleId;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [loading, rules, targetRuleId]);

  async function toggleRule(rule: AlertRule) {
    setUpdatingId(rule.id);
    try {
      await apiFetch(`/api/account-alert-rules/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await fetchRules();
    } finally {
      setUpdatingId(null);
    }
  }

  async function updateRule(id: number, field: string, value: string | number) {
    setUpdatingId(id);
    try {
      const payload: Record<string, unknown> = { [field]: value };
      await apiFetch(`/api/account-alert-rules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await fetchRules();
    } finally {
      setUpdatingId(null);
    }
  }

  function updateRuleDraft(rule: AlertRule, field: NumericRuleField, value: string) {
    setDrafts((current) => ({
      ...current,
      [rule.id]: {
        threshold: current[rule.id]?.threshold ?? String(rule.threshold),
        minRequests: current[rule.id]?.minRequests ?? String(rule.minRequests),
        minPromptTokens: current[rule.id]?.minPromptTokens ?? String(rule.minPromptTokens),
        cooldownMin: current[rule.id]?.cooldownMin ?? String(rule.cooldownMin),
        [field]: value,
      },
    }));
  }

  async function commitRuleDraft(rule: AlertRule, field: NumericRuleField) {
    const serverValue = rule[field];
    const currentDraft = drafts[rule.id]?.[field] ?? String(serverValue);
    const resolved = resolveRuleNumberDraft(currentDraft, serverValue);

    updateRuleDraft(rule, field, resolved.draft);
    if (resolved.value == null || resolved.value === serverValue) return;

    setUpdatingId(rule.id);
    try {
      const res = await apiFetch(`/api/account-alert-rules/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: resolved.value }),
      });
      if (!res.ok) throw new Error('更新失败');

      const updatedRule = (await res.json()) as AlertRule;
      setRules((current) => current.map((item) => (item.id === updatedRule.id ? updatedRule : item)));
      setDrafts((current) => ({
        ...current,
        [updatedRule.id]: {
          threshold: String(updatedRule.threshold),
          minRequests: String(updatedRule.minRequests),
          minPromptTokens: String(updatedRule.minPromptTokens),
          cooldownMin: String(updatedRule.cooldownMin),
        },
      }));
    } catch {
      updateRuleDraft(rule, field, String(serverValue));
    } finally {
      setUpdatingId(null);
    }
  }

  if (loading) {
    return (
      <Card className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中…
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        配置账号真实流量与同步状态告警。规则身份由系统固定，只能调整适用参数。
      </p>

      <AlertBehaviorCard />

      {rules.length === 0 ? (
        <Card className="flex h-32 items-center justify-center text-muted-foreground">
          暂无告警规则
        </Card>
      ) : (
        rules.map((r) => (
          <Card
            key={r.id}
            id={`rule-${r.id}`}
            className={cn(
              'scroll-mt-4',
              updatingId === r.id && 'opacity-70',
              targetRuleId === r.id && 'border-primary ring-1 ring-primary/30',
            )}
          >
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={r.severity} />
                  <span className="font-medium">{r.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`rule-switch-${r.id}`} className="sr-only">
                    启用
                  </Label>
                  <Switch
                    id={`rule-switch-${r.id}`}
                    checked={r.enabled}
                    onCheckedChange={() => toggleRule(r)}
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">当</span>
                <Badge variant="secondary">{metricLabel(r.metric)}</Badge>

                <Select
                  value={r.operator}
                  onValueChange={(v) => updateRule(r.id, 'operator', v)}
                >
                  <SelectTrigger className="h-8 w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {ruleOperators(r.metric).map((operator) => (
                        <SelectItem key={operator} value={operator}>{operatorLabel(operator)}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Input
                  type="number"
                  className="h-8 w-24"
                  value={drafts[r.id]?.threshold ?? String(r.threshold)}
                  disabled={updatingId === r.id}
                  onChange={(e) => updateRuleDraft(r, 'threshold', e.target.value)}
                  onBlur={() => void commitRuleDraft(r, 'threshold')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                />

                <span className="mx-1 text-muted-foreground">·</span>
                <span className="text-muted-foreground">级别</span>
                <Select value={r.severity} onValueChange={(value) => updateRule(r.id, 'severity', value)}>
                  <SelectTrigger className="h-8 w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="INFO">INFO</SelectItem>
                      <SelectItem value="WARNING">WARNING</SelectItem>
                      <SelectItem value="CRITICAL">CRITICAL</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>

                {ruleUsesTrafficSamples(r.metric) && (
                  <>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">最小请求</span>
                    <RuleNumberInput rule={r} field="minRequests" drafts={drafts} updatingId={updatingId}
                      onChange={updateRuleDraft} onCommit={commitRuleDraft} />
                  </>
                )}

                {r.metric === 'cache_hit_low' && (
                  <>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">最小 Prompt Token</span>
                    <RuleNumberInput rule={r} field="minPromptTokens" drafts={drafts} updatingId={updatingId}
                      onChange={updateRuleDraft} onCommit={commitRuleDraft} wide />
                  </>
                )}

                <span className="mx-1 text-muted-foreground">·</span>
                <span className="text-muted-foreground">冷却</span>
                <RuleNumberInput rule={r} field="cooldownMin" drafts={drafts} updatingId={updatingId}
                  onChange={updateRuleDraft} onCommit={commitRuleDraft} />
                <span className="text-muted-foreground">分钟</span>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function AlertBehaviorCard() {
  const [values, setValues] = useState({
    window: '5', count: '2', factor: '10', pauseEnabled: true, pauseDuration: '1', pauseCooldown: '5',
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    apiFetch('/api/settings').then((response) => response.json()).then((settings) => setValues({
      window: settings.alert_confirmation_window_minutes ?? '5',
      count: settings.alert_confirmation_count ?? '2',
      factor: settings.alert_priority_factor ?? '10',
      pauseEnabled: settings.alert_priority_cap_pause_enabled !== 'false',
      pauseDuration: settings.alert_priority_cap_pause_duration_minutes ?? '1',
      pauseCooldown: settings.alert_priority_cap_pause_cooldown_minutes ?? '5',
    })).catch(() => undefined);
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      const response = await apiFetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alert_confirmation_window_minutes: values.window,
          alert_confirmation_count: values.count,
          alert_priority_factor: values.factor,
          alert_priority_cap_pause_enabled: values.pauseEnabled,
          alert_priority_cap_pause_duration_minutes: values.pauseDuration,
          alert_priority_cap_pause_cooldown_minutes: values.pauseCooldown,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '保存告警行为失败');
      toast.success('告警行为已保存');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return <Card>
    <CardHeader><CardTitle className="text-base">告警行为</CardTitle><CardDescription>配置确认、优先级调整和封顶暂停策略</CardDescription></CardHeader>
    <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:items-end">
      <label className="space-y-1 text-sm"><span>确认窗口（分钟）</span><Input type="number" min="1" max="60" value={values.window} onChange={(event) => setValues({ ...values, window: event.target.value })} /></label>
      <label className="space-y-1 text-sm"><span>窗口内命中次数</span><Input type="number" min="1" max="20" value={values.count} onChange={(event) => setValues({ ...values, count: event.target.value })} /></label>
      <label className="space-y-1 text-sm"><span>优先级系数（0 禁用）</span><Input type="number" min="0" max="1000" value={values.factor} onChange={(event) => setValues({ ...values, factor: event.target.value })} /></label>
      <div className="flex h-10 items-center justify-between gap-3 rounded-md border px-3">
        <Label htmlFor="priority-cap-pause-enabled">允许封顶后暂停调度</Label>
        <Switch id="priority-cap-pause-enabled" checked={values.pauseEnabled} onCheckedChange={(checked) => setValues({ ...values, pauseEnabled: checked })} />
      </div>
      <label className="space-y-1 text-sm"><span>暂停时间（分钟）</span><Input type="number" min="1" max="60" disabled={!values.pauseEnabled} value={values.pauseDuration} onChange={(event) => setValues({ ...values, pauseDuration: event.target.value })} /></label>
      <label className="space-y-1 text-sm"><span>暂停后冷却（分钟）</span><Input type="number" min="0" max="1440" disabled={!values.pauseEnabled} value={values.pauseCooldown} onChange={(event) => setValues({ ...values, pauseCooldown: event.target.value })} /></label>
      <Button className="sm:col-start-2 lg:col-start-3" onClick={() => void save()} disabled={saving}><Save data-icon="inline-start" />保存</Button>
    </CardContent>
  </Card>;
}

function RuleNumberInput({ rule, field, drafts, updatingId, onChange, onCommit, wide = false }: {
  rule: AlertRule;
  field: NumericRuleField;
  drafts: RuleDrafts;
  updatingId: number | null;
  onChange: (rule: AlertRule, field: NumericRuleField, value: string) => void;
  onCommit: (rule: AlertRule, field: NumericRuleField) => Promise<void>;
  wide?: boolean;
}) {
  return (
    <Input
      type="number"
      min={0}
      className={cn('h-8', wide ? 'w-28' : 'w-20')}
      value={drafts[rule.id]?.[field] ?? String(rule[field])}
      disabled={updatingId === rule.id}
      onChange={(event) => onChange(rule, field, event.target.value)}
      onBlur={() => void onCommit(rule, field)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

// ============ 分组告警 ============
function GroupAlertsTab() {
  const [groups, setGroups] = useState<GroupAlertSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingGroupIds, setPendingGroupIds] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    let active = true;
    apiFetch('/api/group-alert-settings')
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '分组告警加载失败');
        if (active) setGroups(Array.isArray(data.groups) ? data.groups : []);
      })
      .catch((error) => {
        if (active) setLoadError(error instanceof Error ? error.message : '分组告警加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function toggleGroup(group: GroupAlertSetting, enabled: boolean) {
    if (pendingGroupIds.has(group.groupId)) return;
    setPendingGroupIds((current) => new Set(current).add(group.groupId));
    setGroups((current) => current.map((item) =>
      item.groupId === group.groupId ? { ...item, alertEnabled: enabled } : item));
    try {
      const response = await apiFetch(`/api/group-alert-settings/${group.groupId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '分组告警保存失败');
      setGroups((current) => current.map((item) => item.groupId === group.groupId ? data : item));
    } catch (error) {
      setGroups((current) => current.map((item) =>
        item.groupId === group.groupId ? { ...item, alertEnabled: group.alertEnabled } : item));
      toast.error(error instanceof Error ? error.message : '分组告警保存失败');
    } finally {
      setPendingGroupIds((current) => {
        const next = new Set(current);
        next.delete(group.groupId);
        return next;
      });
    }
  }

  if (loading) {
    return <Card className="flex h-32 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中…</Card>;
  }
  if (loadError) {
    return <Card className="flex h-32 items-center justify-center text-destructive">{loadError}</Card>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        关闭后，仅唯一属于该分组的账号停止告警；同时属于多个分组的账号不受影响。
      </p>
      {groups.length === 0 ? (
        <Card className="flex h-32 items-center justify-center text-muted-foreground">暂无已绑定分组</Card>
      ) : groups.map((group) => (
        <Card key={group.groupId} className={cn(pendingGroupIds.has(group.groupId) && 'opacity-70')}>
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium" title={group.name}>{group.name}</span>
                <Badge variant="secondary" className="shrink-0">#{group.groupId}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                实际影响 {group.exclusiveAccountCount} 个账号 · 共绑定 {group.boundAccountCount} 个账号
              </p>
            </div>
            <Switch
              checked={group.alertEnabled}
              disabled={pendingGroupIds.has(group.groupId)}
              onCheckedChange={(enabled) => void toggleGroup(group, enabled)}
              aria-label={`分组 ${group.name} 告警开关`}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ============ 通知渠道 ============
function ChannelsTab() {
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/alert-channels');
      const data = await res.json();
      setChannels(Array.isArray(data) ? data : []);
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  function resetForm() {
    setName('');
    setWebhookUrl('');
    setSecret('');
  }

  async function handleAdd() {
    if (!webhookUrl) return;
    setSaving(true);
    try {
      const response = await apiFetch('/api/alert-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || '飞书 Webhook',
          type: 'feishu',
          config: { webhookUrl, secret: secret || undefined },
          enabled: true,
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : '通知渠道保存失败');
      }
      toast.success('通知渠道已保存');
      resetForm();
      setDialogOpen(false);
      await fetchChannels();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '通知渠道保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    const ok = await confirm({
      title: '删除此通知渠道？',
      description: '删除后将不再向该渠道推送告警。',
      destructive: true,
      confirmText: '删除',
    });
    if (!ok) return;
    setUpdatingId(id);
    try {
      await apiFetch(`/api/alert-channels/${id}`, { method: 'DELETE' });
      await fetchChannels();
    } finally {
      setUpdatingId(null);
    }
  }

  async function toggleChannel(ch: AlertChannel) {
    setUpdatingId(ch.id);
    try {
      await apiFetch(`/api/alert-channels/${ch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      await fetchChannels();
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {confirmDialog}
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          配置告警推送目标（当前支持飞书 Webhook）
        </p>
        <Button onClick={() => setDialogOpen(true)} size="sm" className="sm:shrink-0">
          <Plus data-icon="inline-start" />
          添加渠道
        </Button>
      </div>

      {/* 添加渠道对话框 */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) resetForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Webhook className="h-4 w-4" />
              添加飞书 Webhook
            </DialogTitle>
            <DialogDescription>
              配置飞书自定义机器人的 Webhook 地址，告警将推送到对应群组。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ch-name">名称</Label>
              <Input
                id="ch-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="飞书 Webhook"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-url">Webhook URL</Label>
              <Input
                id="ch-url"
                className="font-mono text-xs"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-secret">签名密钥（可选）</Label>
              <Input
                id="ch-secret"
                className="font-mono text-xs"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="SEC-xxx"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                resetForm();
              }}
            >
              取消
            </Button>
            <Button onClick={handleAdd} disabled={!webhookUrl || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading ? (
        <Card className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载中…
        </Card>
      ) : channels.length === 0 ? (
        <Card className="flex h-32 items-center justify-center text-muted-foreground">
          暂无通知渠道。点击「添加渠道」配置飞书 Webhook。
        </Card>
      ) : (
        channels.map((ch) => (
          <Card key={ch.id} className={cn(updatingId === ch.id && 'opacity-70')}>
            <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-medium" title={ch.name}>{ch.name}</span>
                  <Badge variant="secondary" className="shrink-0">{ch.type}</Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  Webhook {ch.webhookConfigured ? '已配置' : '未配置'}
                  {ch.secretConfigured ? '，签名密钥已配置' : ''}
                </div>
              </div>
              <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
                <Switch
                  checked={ch.enabled}
                  onCheckedChange={() => toggleChannel(ch)}
                />
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDelete(ch.id)}
                >
                  <Trash2 data-icon="inline-start" />
                  删除
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ============ 系统配置 ============
function SystemTab() {
  const [settings, setSettings] = useState<Record<string, string | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        setSettings(data ?? {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function update(key: string, value: string) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = buildSettingsUpdatePayload(settings);
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存配置失败');
      setSaved(true);
    } catch (error) {
      setSaved(false);
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中…
      </Card>
    );
  }

  const cronConfigured = settings.cron_secret_configured === true;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        采集频率配置。轻量采集（余额+延迟）建议 1 分钟，重量采集（模型实测+流式测速）建议 15 分钟以免消耗过多额度。
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <SlidersHorizontal className="h-4 w-4" />
            定时采集配置
          </CardTitle>
          <CardDescription>调整各采集任务的运行参数</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="light-interval"
              label="轻量采集间隔（分钟）"
              hint="余额查询 + 延迟测试，不消耗额度"
            >
              <Input
                id="light-interval"
                type="number"
                min={1}
                value={typeof settings.light_interval_minutes === 'string' ? settings.light_interval_minutes : '1'}
                onChange={(e) => update('light_interval_minutes', e.target.value)}
              />
            </Field>
            <Field
              id="heavy-interval"
              label="重量采集间隔（分钟）"
              hint="模型实测 + 流式测速，消耗少量额度"
            >
              <Input
                id="heavy-interval"
                type="number"
                min={5}
                value={typeof settings.heavy_interval_minutes === 'string' ? settings.heavy_interval_minutes : '15'}
                onChange={(e) => update('heavy_interval_minutes', e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="test-model" label="默认测速模型">
              <Input
                id="test-model"
                value={typeof settings.test_model === 'string' ? settings.test_model : 'gpt-4o-mini'}
                onChange={(e) => update('test_model', e.target.value)}
              />
            </Field>
            <Field id="test-timeout" label="测试超时（ms）">
              <Input
                id="test-timeout"
                type="number"
                value={typeof settings.test_timeout_ms === 'string' ? settings.test_timeout_ms : '15000'}
                onChange={(e) => update('test_timeout_ms', e.target.value)}
              />
            </Field>
            <Field id="retention-days" label="数据保留（天）">
              <Input
                id="retention-days"
                type="number"
                value={typeof settings.retention_days === 'string' ? settings.retention_days : '90'}
                onChange={(e) => update('retention_days', e.target.value)}
              />
            </Field>
          </div>

          <div className="max-w-xl space-y-1.5">
            <Label>CRON_SECRET</Label>
            <div className="flex items-center gap-2 text-sm">
              {cronConfigured ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-amber-600" />
              )}
              <span>{cronConfigured ? '服务器环境变量已配置' : '服务器环境变量未配置'}</span>
            </div>
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <div className="flex items-center gap-2 text-sm">
              {saved && (
                <span className="flex items-center gap-1 text-emerald-600">
                  <CheckCircle2 className="h-4 w-4" />
                  已保存
                </span>
              )}
            </div>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              保存配置
            </Button>
          </div>
        </CardContent>
      </Card>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4" />
        定时采集密钥仅由服务器环境变量管理。
      </p>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint != null && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ============ 修改密码 ============
function PasswordTab() {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isSub2Api, setIsSub2Api] = useState(false);

  useEffect(() => {
    apiFetch('/api/auth/me')
      .then((response) => response.json())
      .then((session) => setIsSub2Api(session?.source === 'sub2api'))
      .catch(() => setIsSub2Api(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSub2Api) return;
    setMsg(null);
    if (newPw !== confirmPw) {
      setMsg({ type: 'error', text: '两次输入的新密码不一致' });
      return;
    }
    if (newPw.length < 6) {
      setMsg({ type: 'error', text: '新密码至少 6 位' });
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ type: 'success', text: '密码修改成功' });
        setOldPw('');
        setNewPw('');
        setConfirmPw('');
      } else {
        setMsg({ type: 'error', text: data.error || '修改失败' });
      }
    } catch (err) {
      setMsg({ type: 'error', text: '请求失败: ' + (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full">
      <Card>
        <CardHeader className="mx-auto w-full max-w-xl">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            修改登录密码
          </CardTitle>
          <CardDescription>
            {isSub2Api ? '请在 Sub2API 修改管理员凭据' : '新密码至少 6 位字符'}
          </CardDescription>
        </CardHeader>
        <CardContent className="mx-auto w-full max-w-xl">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="old-pw">旧密码</Label>
              <Input
                id="old-pw"
                type="password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                disabled={isSub2Api}
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-pw">新密码（至少 6 位）</Label>
              <Input
                id="new-pw"
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                disabled={isSub2Api}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-pw">确认新密码</Label>
              <Input
                id="confirm-pw"
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                disabled={isSub2Api}
                required
              />
            </div>

            {msg != null && (
              <div
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
                  msg.type === 'success'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-destructive/10 text-destructive'
                )}
              >
                {msg.type === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0" />
                )}
                {msg.text}
              </div>
            )}

            <Button type="submit" disabled={saving || isSub2Api} className="w-full">
              {saving ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <KeyRound data-icon="inline-start" />
              )}
              修改密码
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ============ 公共组件 ============
function SeverityBadge({ severity }: { severity: string }) {
  const key = (severity || '').toUpperCase();
  if (key === 'CRITICAL') {
    return <Badge variant="destructive">CRITICAL</Badge>;
  }
  if (key === 'WARNING') {
    return (
      <Badge className="border-transparent bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400">
        WARNING
      </Badge>
    );
  }
  return <Badge variant="secondary">INFO</Badge>;
}

function metricLabel(metric: string): string {
  const map: Record<string, string> = {
    availability_low: '可用率',
    error_rate_high: '错误率',
    duration_p95_high: '总延迟 P95',
    first_token_p95_high: '首 Token P95',
    cache_hit_low: '缓存命中率',
    unschedulable: '不可调度状态',
    sync_stale: '同步陈旧分钟数',
    balance_low: '上游余额',
    upstream_rate_deviation: '上游倍率偏差率（0.10 = 10%）',
  };
  return map[metric] || metric;
}

function ruleUsesTrafficSamples(metric: string): boolean {
  return !['unschedulable', 'sync_stale', 'balance_low', 'upstream_rate_deviation'].includes(metric);
}

function ruleOperators(metric: string): string[] {
  if (metric === 'unschedulable') return ['eq'];
  if (['availability_low', 'cache_hit_low', 'balance_low'].includes(metric)) return ['lt', 'lte'];
  return ['gt', 'gte'];
}

function operatorLabel(operator: string): string {
  return { lt: '小于', lte: '小于等于', gt: '大于', gte: '大于等于', eq: '等于' }[operator] ?? operator;
}
