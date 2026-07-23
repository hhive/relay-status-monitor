import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  SettingKeys,
  clearSettingsCache,
  resolveCronSecret,
  setSetting,
} from '@/lib/settings';
import { requireApiSession } from '@/lib/auth';

/** 获取所有设置 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const settings = await prisma.setting.findMany();
  const map: Record<string, string> = {};
  for (const s of settings) map[s.key] = s.value;
  map[SettingKeys.CRON_SECRET] = resolveCronSecret(
    map[SettingKeys.CRON_SECRET],
    process.env.CRON_SECRET
  );
  return NextResponse.json(map);
}

/** 批量更新设置（键值对） */
export async function PUT(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = (await request.json()) as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      await setSetting(key, String(value));
    }
    clearSettingsCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: '更新失败: ' + (e as Error).message }, { status: 500 });
  }
}
