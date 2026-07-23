import { NextResponse } from 'next/server';
import { refreshKeyMetadata } from '@/lib/key-metadata-service';
import { toSafeUpstreamKey } from '@/lib/key-metadata';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ keyId: string }>;
}

export async function POST(_request: Request, { params }: Params) {
  const { keyId } = await params;
  const numericKeyId = parseStrictPositiveInteger(keyId);
  if (numericKeyId === null) {
    return NextResponse.json({ error: 'Key ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const refreshed = await refreshKeyMetadata(numericKeyId);
    const key = toSafeUpstreamKey(refreshed.key);
    if (!refreshed.result.ok) {
      return NextResponse.json(
        { error: refreshed.result.errorMessage || '远端信息获取失败', key },
        { status: 400 }
      );
    }
    return NextResponse.json({ key, metadataRefresh: refreshed.result });
  } catch (error) {
    const message = (error as Error).message;
    return NextResponse.json(
      { error: message },
      { status: message === 'Key 不存在' ? 404 : 500 }
    );
  }
}
