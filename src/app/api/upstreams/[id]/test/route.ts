import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { collectUpstreamKeys } from '@/lib/collector';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

/** 手动触发该上游所有 key 的完整采集 */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const upstreamId = parseStrictPositiveInteger(id);
  if (upstreamId === null) {
    return NextResponse.json({ error: '上游 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const upstream = await prisma.upstream.findUnique({
      where: { id: upstreamId },
      include: { keys: { where: { enabled: true } } },
    });
    if (!upstream) {
      return NextResponse.json({ error: '上游不存在' }, { status: 404 });
    }
    if (upstream.keys.length === 0) {
      return NextResponse.json({ error: '该上游没有启用的分组 Key' }, { status: 400 });
    }

    const collection = await collectUpstreamKeys(upstream, 'heavy');

    const summary = collection.results.map((r, i) => ({
      keyId: upstream.keys[i].id,
      group: upstream.keys[i].group,
      status: r.status === 'fulfilled' && r.value ? 'ok' : 'failed',
    }));

    return NextResponse.json({ ok: true, status: collection.status, results: summary });
  } catch {
    return NextResponse.json({ error: '上游测试失败' }, { status: 500 });
  }
}
