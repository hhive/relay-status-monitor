import { NextResponse } from 'next/server';
import { getFeishuConfig, isDocsAdminSession, saveFeishuConfig } from '@/lib/docs-management';
import { requireApiSession } from '@/lib/auth';
import { safeErrorMessage } from '@/lib/safe-error';

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  return NextResponse.json(await getFeishuConfig());
}

export async function PUT(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    return NextResponse.json(await saveFeishuConfig({
      url: String(body.url ?? ''), appId: String(body.appId ?? ''), appSecret: typeof body.appSecret === 'string' ? body.appSecret : '',
      apiBase: typeof body.apiBase === 'string' ? body.apiBase : '', output: typeof body.output === 'string' ? body.output : '',
    }));
  } catch (error) { return NextResponse.json({ error: safeErrorMessage(error) }, { status: 400 }); }
}
