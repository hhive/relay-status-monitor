import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import { defaultTransport, loadBackupConfig, runRemoteBackup } from '@/lib/remote-backup';

export async function POST(_request: Request, context: { params: Promise<{ action: string }> }) {
  const auth = await requireApiSession(); if (!auth.ok) return auth.response;
  const action = (await context.params).action;
  try {
    const config = await loadBackupConfig();
    if (action === 'test') {
      await defaultTransport.list(config.path, config);
      return NextResponse.json({ ok: true, message: '远程备份连接成功' });
    }
    if (action === 'run') {
      if (!config.enabled) return NextResponse.json({ error: '远程备份未启用' }, { status: 400 });
      const result = await runRemoteBackup(config);
      return NextResponse.json({ ok: true, file: result.fileName, deleted: result.deleted });
    }
    return NextResponse.json({ error: '操作不存在' }, { status: 404 });
  } catch {
    return NextResponse.json({ error: '远程备份操作失败' }, { status: 500 });
  }
}
