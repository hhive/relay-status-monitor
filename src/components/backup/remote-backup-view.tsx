'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, ShieldCheck, Webhook } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';

type BackupSettings = Record<string, string | boolean>;

export function RemoteBackupView() {
  const [settings, setSettings] = useState<BackupSettings>({});
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [records, setRecords] = useState<Array<{ id: number; status: string; startedAt: string; fileName?: string | null; fileSize?: number | null; deletedCount: number; errorMessage?: string | null }>>([]);
  const [recordOffset, setRecordOffset] = useState(0);
  const [recordTotal, setRecordTotal] = useState(0);
  const [recordStatus, setRecordStatus] = useState('ALL');
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<'test' | 'run' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const value = (key: string, fallback: string) => typeof settings[key] === 'string' ? settings[key] as string : fallback;
  const enabled = settings.remote_backup_enabled === true || settings.remote_backup_enabled === 'true';

  useEffect(() => {
    apiFetch('/api/remote-backup?limit=10&offset=0')
      .then((response) => response.json())
      .then((body) => {
        const config = body.config;
        if (!config) return;
        setSettings({
          remote_backup_enabled: config.enabled,
          remote_backup_host: String(config.host ?? ''),
          remote_backup_port: String(config.port ?? 22),
          remote_backup_username: String(config.username ?? ''),
          remote_backup_path: String(config.path ?? ''),
          remote_backup_time: String(config.time ?? '02:00'),
          remote_backup_retention: String(config.retention ?? 7),
          remote_backup_password_configured: config.passwordConfigured === true,
          remote_backup_last_at: String(body.status?.at ?? ''),
          remote_backup_last_status: String(body.status?.status ?? ''),
          remote_backup_last_file: String(body.status?.fileName ?? ''),
          remote_backup_last_error: String(body.status?.error ?? ''),
        });
      })
      .catch(() => toast.error('加载远程备份配置失败'))
      .finally(() => setLoading(false));
  }, []);

  const loadRecords = useCallback(async (offset = recordOffset, status = recordStatus) => {
    const query = new URLSearchParams({ limit: '10', offset: String(offset) }); if (status !== 'ALL') query.set('status', status);
    const body = await apiFetch(`/api/remote-backup?${query}`).then((response) => response.json());
    setRecords(body.records?.items ?? []); setRecordTotal(body.records?.total ?? 0);
  }, [recordOffset, recordStatus]);

  useEffect(() => { void loadRecords(); }, [loadRecords]);

  const updateBackup = (key: string, next: string | boolean) => {
    setSettings((current) => ({ ...current, [key]: next }));
    setMessage(null);
  };

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, string | boolean> = {
        enabled,
        host: value('remote_backup_host', ''),
        port: value('remote_backup_port', '22'),
        username: value('remote_backup_username', ''),
        path: value('remote_backup_path', ''),
        time: value('remote_backup_time', '02:00'),
        retention: value('remote_backup_retention', '7'),
      };
      if (password.trim()) payload.password = password;
      const response = await apiFetch('/api/remote-backup', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '保存远程备份配置失败');
      setPassword('');
      updateBackup('remote_backup_password_configured', body.config?.passwordConfigured === true);
      toast.success('远程备份配置已保存');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runAction(kind: 'test' | 'run') {
    setAction(kind);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/remote-backup/${kind}`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || (kind === 'test' ? '连接测试失败' : '立即备份失败'));
      setMessage(body.message || (kind === 'test' ? '连接测试成功' : '备份任务已完成'));
      if (body.file) updateBackup('remote_backup_last_file', body.file);
      if (kind === 'run') {
        setRecordOffset(0); await loadRecords(0, recordStatus);
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setAction(null);
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />远程数据库备份</CardTitle>
        <CardDescription>通过 SFTP 上传 Sub2API PostgreSQL `.sql.gz` 每日备份；可用 `gzip -dc | psql` 一次恢复。时间按 UTC 执行。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <div><Label htmlFor="remote-backup-enabled">启用每日备份</Label><p className="text-xs text-muted-foreground">关闭后不会执行定时任务</p></div>
          <Switch id="remote-backup-enabled" checked={enabled} onCheckedChange={(checked) => updateBackup('remote_backup_enabled', checked)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="remote-backup-host" label="目标服务器 IP"><Input id="remote-backup-host" value={value('remote_backup_host', '')} onChange={(e) => updateBackup('remote_backup_host', e.target.value)} /></Field>
          <Field id="remote-backup-port" label="SSH 端口"><Input id="remote-backup-port" type="number" min={1} max={65535} value={value('remote_backup_port', '22')} onChange={(e) => updateBackup('remote_backup_port', e.target.value)} /></Field>
          <Field id="remote-backup-user" label="用户名"><Input id="remote-backup-user" value={value('remote_backup_username', '')} onChange={(e) => updateBackup('remote_backup_username', e.target.value)} /></Field>
          <Field id="remote-backup-password" label="用户密码" hint={settings.remote_backup_password_configured === true ? '密码已配置，留空表示不修改' : undefined}><Input id="remote-backup-password" type="password" autoComplete="new-password" value={password} placeholder={settings.remote_backup_password_configured === true ? '已配置' : ''} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field id="remote-backup-path" label="备份路径"><Input id="remote-backup-path" value={value('remote_backup_path', '')} onChange={(e) => updateBackup('remote_backup_path', e.target.value)} /></Field>
          <Field id="remote-backup-time" label="每日备份时间（UTC）"><Input id="remote-backup-time" type="time" value={value('remote_backup_time', '02:00')} onChange={(e) => updateBackup('remote_backup_time', e.target.value)} /></Field>
          <Field id="remote-backup-retention" label="保留备份数量" hint="超过数量后清理最早的备份"><Input id="remote-backup-retention" type="number" min={1} max={10000} value={value('remote_backup_retention', '7')} onChange={(e) => updateBackup('remote_backup_retention', e.target.value)} /></Field>
        </div>
        {(settings.remote_backup_last_at || settings.remote_backup_last_status || settings.remote_backup_last_error) && <p className="text-xs text-muted-foreground">最近执行：{value('remote_backup_last_at', '未知')} · {value('remote_backup_last_status', '未知')}{settings.remote_backup_last_file ? ` · ${value('remote_backup_last_file', '')}` : ''}{settings.remote_backup_last_error ? ` · ${value('remote_backup_last_error', '')}` : ''}</p>}
        <div className="flex items-center justify-between gap-3"><Select value={recordStatus} onValueChange={(next) => { setRecordStatus(next); setRecordOffset(0); }}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部记录</SelectItem><SelectItem value="SUCCEEDED">成功</SelectItem><SelectItem value="FAILED">失败</SelectItem><SelectItem value="RUNNING">执行中</SelectItem></SelectContent></Select><span className="text-xs text-muted-foreground">共 {recordTotal} 条</span></div>
        {records.length > 0 && <div className="overflow-x-auto rounded-md border"><table className="w-full text-left text-xs"><thead><tr className="border-b"><th className="px-3 py-2">时间</th><th className="px-3 py-2">状态</th><th className="px-3 py-2">文件</th><th className="px-3 py-2">大小</th><th className="px-3 py-2">清理</th></tr></thead><tbody>{records.map((record) => <tr key={record.id} className="border-b last:border-0"><td className="px-3 py-2">{new Date(record.startedAt).toLocaleString()}</td><td className="px-3 py-2">{record.status}</td><td className="px-3 py-2">{record.fileName ?? record.errorMessage ?? '-'}</td><td className="px-3 py-2">{record.fileSize == null ? '-' : `${(record.fileSize / (1024 * 1024)).toFixed(2)} MB`}</td><td className="px-3 py-2">{record.deletedCount}</td></tr>)}</tbody></table></div>}
        <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={recordOffset === 0} onClick={() => setRecordOffset(Math.max(0, recordOffset - 10))}>上一页</Button><Button size="sm" variant="outline" disabled={recordOffset + 10 >= recordTotal} onClick={() => setRecordOffset(recordOffset + 10)}>下一页</Button></div>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => void runAction('test')} disabled={action != null || saving}><Webhook data-icon="inline-start" />{action === 'test' ? '测试中…' : '立即测试'}</Button>
          <Button variant="outline" onClick={() => void runAction('run')} disabled={action != null || saving}><Loader2 data-icon="inline-start" className={action === 'run' ? 'animate-spin' : undefined} />{action === 'run' ? '备份中…' : '立即备份'}</Button>
          <Button onClick={() => void save()} disabled={saving || action != null}>{saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}保存备份配置</Button>
        </div>
      </CardContent>
    </Card>
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
