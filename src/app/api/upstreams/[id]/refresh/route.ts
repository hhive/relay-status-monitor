import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { collectUpstreamKeys } from '@/lib/collector';
import { summarizeCollectionResults } from '@/lib/collection-result';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

/** 对该上游所有启用 key 执行不消耗生成额度的轻量采集。 */
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

    const collection = await collectUpstreamKeys(upstream, 'light');
    const summary = summarizeCollectionResults(collection.results);
    const results = collection.results.map((result, index) => ({
      keyId: upstream.keys[index].id,
      group: upstream.keys[index].group,
      status:
        result.status === 'fulfilled' && result.value?.success === true
          ? 'ok'
          : 'failed',
    }));

    return NextResponse.json({
      ok: summary.successCount > 0,
      status: collection.status,
      results,
      ...summary,
    });
  } catch (error) {
    return NextResponse.json(
      { error: '刷新失败: ' + (error as Error).message },
      { status: 500 }
    );
  }
}
