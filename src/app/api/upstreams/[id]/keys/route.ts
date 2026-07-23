import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { refreshKeyMetadata } from '@/lib/key-metadata-service';
import { toSafeUpstreamKey } from '@/lib/key-metadata';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

/** 列出某上游下所有 keys */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const upstreamId = parseStrictPositiveInteger(id);
  if (upstreamId === null) {
    return NextResponse.json({ error: '上游 ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const keys = await prisma.upstreamKey.findMany({
    where: { upstreamId },
    orderBy: { id: 'asc' },
  });
  // 不返回加密原文
  const safe = keys.map(toSafeUpstreamKey);
  return NextResponse.json(safe);
}

/** 新增 key */
export async function POST(request: Request, { params }: Params) {
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
      select: { type: true },
    });
    if (!upstream) {
      return NextResponse.json({ error: '上游不存在' }, { status: 404 });
    }

    const body = await request.json();
    const { group, label, apiKey, accessToken, userId, testModel, enabled } = body;

    if (!group) {
      return NextResponse.json({ error: '分组名不能为空' }, { status: 400 });
    }

    const key = await prisma.upstreamKey.create({
      data: {
        upstreamId,
        group,
        label: label || null,
        userId: userId || null,
        testModel: testModel || null,
        enabled: enabled !== false,
        apiKeyEnc: apiKey ? encrypt(apiKey) : undefined,
        accessTokenEnc: accessToken ? encrypt(accessToken) : undefined,
      },
    });

    let responseKey = key;
    let metadataRefresh = null;
    if (upstream.type === 'NEW_API') {
      try {
        const refreshed = await refreshKeyMetadata(key.id);
        responseKey = refreshed.key;
        metadataRefresh = refreshed.result;
      } catch {
        metadataRefresh = { ok: false, errorMessage: '元数据刷新失败' };
      }
    }

    return NextResponse.json(
      { ...toSafeUpstreamKey(responseKey), metadataRefresh },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ error: '创建 Key 失败' }, { status: 500 });
  }
}
