import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { isBackupDue, loadBackupConfig, runRemoteBackup } from '@/lib/remote-backup';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const cronAuthorized = Boolean(secret && request.headers.get('authorization') === `Bearer ${secret}`);
  if (!cronAuthorized) { const auth = await requireApiSession(); if (!auth.ok) return auth.response; }
  try { const config = await loadBackupConfig(); if (!await isBackupDue(config)) return NextResponse.json({ ok: true, skipped: true }); return NextResponse.json({ ok: true, ...(await runRemoteBackup(config)) }); }
  catch { return NextResponse.json({ ok: false, error: '备份任务执行失败' }, { status: 500 }); }
}
