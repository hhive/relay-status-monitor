import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

/** 获取单个上游（含 keys） */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '上游 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const upstream = await prisma.upstream.findUnique({
    where: { id: numericId },
    include: { keys: { orderBy: { id: 'asc' } } },
  });
  if (!upstream) {
    return NextResponse.json({ error: '上游不存在' }, { status: 404 });
  }
  // 处理 keys 的凭证标志
  const keys = upstream.keys.map(({ apiKeyEnc, accessTokenEnc, ...rest }) => ({
    ...rest,
    hasApiKey: !!apiKeyEnc,
    hasAccessToken: !!accessTokenEnc,
  }));
  return NextResponse.json({ ...upstream, keys });
}

/** 更新上游元信息 */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '上游 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const { name, baseUrl, type, testModel, enabled, priority } = body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (baseUrl !== undefined) data.baseUrl = String(baseUrl).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (type !== undefined) data.type = type;
    if (testModel !== undefined) data.testModel = testModel || null;
    if (enabled !== undefined) data.enabled = enabled;
    if (priority !== undefined) data.priority = priority;

    const upstream = await prisma.upstream.update({ where: { id: numericId }, data });
    return NextResponse.json(upstream);
  } catch (e) {
    return NextResponse.json({ error: '更新失败: ' + (e as Error).message }, { status: 500 });
  }
}

/** 删除上游（级联删除 keys/metrics/incidents） */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const numericId = parseStrictPositiveInteger(id);
  if (numericId === null) {
    return NextResponse.json({ error: '上游 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    await prisma.upstream.delete({ where: { id: numericId } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: '删除失败: ' + (e as Error).message }, { status: 500 });
  }
}
