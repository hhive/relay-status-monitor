import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { getBackupRecords, getBackupStatus, loadBackupConfig, redactBackupConfig, runRemoteBackup, saveBackupConfig } from '@/lib/remote-backup';

export async function GET(request: Request) {
  const auth = await requireApiSession(); if (!auth.ok) return auth.response;
  const url = new URL(request.url); const limit = Number(url.searchParams.get('limit') ?? 30); const offset = Number(url.searchParams.get('offset') ?? 0); const status = url.searchParams.get('status') ?? undefined;
  try { const config = await loadBackupConfig(); return NextResponse.json({ config: redactBackupConfig(config), status: await getBackupStatus(), records: await getBackupRecords({ limit, offset, status }) }); }
  catch { return NextResponse.json({ config: null, status: await getBackupStatus() }); }
}

export async function PUT(request: Request) {
  const auth = await requireApiSession(); if (!auth.ok) return auth.response;
  try { const body = await request.json(); const config = await saveBackupConfig(body); return NextResponse.json({ config: redactBackupConfig(config) }); }
  catch { return NextResponse.json({ error: '备份配置无效' }, { status: 400 }); }
}

export async function POST() {
  const auth = await requireApiSession(); if (!auth.ok) return auth.response;
  try { const config = await loadBackupConfig(); if (!config.enabled) return NextResponse.json({ error: '远程备份未启用' }, { status: 400 }); return NextResponse.json({ ok: true, ...(await runRemoteBackup(config)) }); }
  catch { return NextResponse.json({ error: '备份执行失败' }, { status: 500 }); }
}
