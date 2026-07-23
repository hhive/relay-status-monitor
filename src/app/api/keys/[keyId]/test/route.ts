import { NextResponse } from 'next/server';
import { collectOneKeyManual } from '@/lib/collector';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ keyId: string }>;
}

/** 手动触发单个 key 的完整采集 */
export async function POST(_req: Request, { params }: Params) {
  const { keyId } = await params;
  const numericKeyId = parseStrictPositiveInteger(keyId);
  if (numericKeyId === null) {
    return NextResponse.json({ error: 'Key ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const metric = await collectOneKeyManual(numericKeyId);
    if (!metric) {
      return NextResponse.json({ error: '采集失败：未配置凭证' }, { status: 400 });
    }
    return NextResponse.json(metric);
  } catch (e) {
    return NextResponse.json({ error: '测试失败: ' + (e as Error).message }, { status: 500 });
  }
}
