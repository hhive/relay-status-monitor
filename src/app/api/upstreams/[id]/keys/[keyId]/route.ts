import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { buildKeyUpdateData } from '@/lib/key-input';
import { refreshKeyMetadata } from '@/lib/key-metadata-service';
import { toSafeUpstreamKey } from '@/lib/key-metadata';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string; keyId: string }>;
}

/** 更新 key */
export async function PUT(request: Request, { params }: Params) {
  const { id, keyId } = await params;
  const upstreamId = parseStrictPositiveInteger(id);
  const numericKeyId = parseStrictPositiveInteger(keyId);
  if (upstreamId === null || numericKeyId === null) {
    return NextResponse.json({ error: '上游 ID 或 Key ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const existing = await prisma.upstreamKey.findFirst({
      where: { id: numericKeyId, upstreamId },
      include: { upstream: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Key 不存在' }, { status: 404 });
    }

    const body = await request.json();
    const data = buildKeyUpdateData(body, encrypt);

    const key = await prisma.upstreamKey.update({
      where: { id: numericKeyId },
      data,
    });

    let responseKey = key;
    let metadataRefresh = null;
    if (existing.upstream.type === 'NEW_API') {
      try {
        const refreshed = await refreshKeyMetadata(key.id);
        responseKey = refreshed.key;
        metadataRefresh = refreshed.result;
      } catch (error) {
        metadataRefresh = { ok: false, errorMessage: (error as Error).message };
      }
    }

    return NextResponse.json({ ...toSafeUpstreamKey(responseKey), metadataRefresh });
  } catch (e) {
    return NextResponse.json({ error: '更新失败: ' + (e as Error).message }, { status: 500 });
  }
}

/** 删除 key */
export async function DELETE(_req: Request, { params }: Params) {
  const { id, keyId } = await params;
  const upstreamId = parseStrictPositiveInteger(id);
  const numericKeyId = parseStrictPositiveInteger(keyId);
  if (upstreamId === null || numericKeyId === null) {
    return NextResponse.json({ error: '上游 ID 或 Key ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const existing = await prisma.upstreamKey.findFirst({
      where: { id: numericKeyId, upstreamId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Key 不存在' }, { status: 404 });
    }
    await prisma.upstreamKey.delete({ where: { id: numericKeyId } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: '删除失败: ' + (e as Error).message }, { status: 500 });
  }
}
