import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { clearSettingsCache, setSetting } from '@/lib/settings';
import { requireApiSession } from '@/lib/auth';

/** 获取所有设置 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const settings = await prisma.setting.findMany();
  const map: Record<string, string | boolean> = {};
  for (const setting of settings) {
    if (setting.key !== 'cron_secret') map[setting.key] = setting.value;
  }
  map.cron_secret_configured = Boolean(process.env.CRON_SECRET?.trim());
  return NextResponse.json(map);
}

/** 批量更新设置（键值对） */
export async function PUT(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = (await request.json()) as Record<string, string>;
    if (Object.prototype.hasOwnProperty.call(body, 'cron_secret')) {
      return NextResponse.json({ error: 'CRON_SECRET 只能通过服务器环境变量配置' }, { status: 400 });
    }
    for (const [key, value] of Object.entries(body)) {
      if (key === 'cron_secret_configured') continue;
      await setSetting(key, String(value));
    }
    clearSettingsCache();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: '更新设置失败' }, { status: 500 });
  }
}
