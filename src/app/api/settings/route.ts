import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { clearSettingsCache, InvalidEditableSettingValueError, isEditableSettingKey, setSetting, validateEditableSettingValue, type EditableSettingKey } from '@/lib/settings';
import { requireApiSession } from '@/lib/auth';

/** 获取所有设置 */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const settings = await prisma.setting.findMany();
  const map: Record<string, string | boolean> = {};
  for (const setting of settings) {
    if (isEditableSettingKey(setting.key)) map[setting.key] = setting.value;
  }
  map.cron_secret_configured = Boolean(process.env.CRON_SECRET?.trim());
  return NextResponse.json(map);
}

/** 批量更新设置（键值对） */
export async function PUT(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: '设置格式无效' }, { status: 400 });
    }
    const keys = Object.keys(body);
    if (!keys.every(isEditableSettingKey)) {
      return NextResponse.json({ error: '包含不允许修改的设置项' }, { status: 400 });
    }
    for (const [key, value] of Object.entries(body)) {
      await setSetting(key, validateEditableSettingValue(key as EditableSettingKey, value));
    }
    clearSettingsCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    const invalid = error instanceof InvalidEditableSettingValueError;
    return NextResponse.json({ error: invalid ? '告警行为配置无效' : '更新设置失败' }, { status: invalid ? 400 : 500 });
  }
}
