import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getAdapter } from '@/lib/adapters/registry';
import { tryDecrypt } from '@/lib/crypto';
import { getCollectConfig } from '@/lib/settings';
import type { AdapterContext } from '@/lib/adapters/base';
import { parseStrictPositiveInteger } from '@/lib/security';
import { requireApiSession } from '@/lib/auth';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * 实时拉取上游可用模型列表
 * GET /api/upstreams/[id]/models?keyId=xxx
 * 用指定 key（或第一个 enabled key）的凭证调 /v1/models
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const upstreamId = parseStrictPositiveInteger(id);
  const { searchParams } = new URL(request.url);
  const keyId = searchParams.get('keyId');
  const numericKeyId = keyId === null ? null : parseStrictPositiveInteger(keyId);
  if (upstreamId === null || (keyId !== null && numericKeyId === null)) {
    return NextResponse.json({ error: '上游 ID 或 Key ID 无效' }, { status: 400 });
  }
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;

  const upstream = await prisma.upstream.findUnique({ where: { id: upstreamId } });
  if (!upstream) {
    return NextResponse.json({ error: '上游不存在' }, { status: 404 });
  }

  // 取指定 key 或第一个有 apiKey 的 enabled key
  let key;
  if (numericKeyId !== null) {
    key = await prisma.upstreamKey.findFirst({
      where: { id: numericKeyId, upstreamId },
    });
  } else {
    key = await prisma.upstreamKey.findFirst({
      where: { upstreamId, enabled: true, apiKeyEnc: { not: null } },
    });
  }

  if (numericKeyId !== null && !key) {
    return NextResponse.json({ error: 'Key 不存在' }, { status: 404 });
  }
  if (!key?.apiKeyEnc) {
    return NextResponse.json({ error: '未找到带 API Key 的分组' }, { status: 400 });
  }

  const apiKey = tryDecrypt(key.apiKeyEnc);
  if (!apiKey) {
    return NextResponse.json({ error: 'API Key 解密失败' }, { status: 500 });
  }

  const config = await getCollectConfig();
  const adapter = getAdapter(upstream.type);
  const ctx: AdapterContext = {
    baseUrl: upstream.baseUrl,
    apiKey,
    accessToken: key.accessTokenEnc ? tryDecrypt(key.accessTokenEnc) || undefined : undefined,
    userId: key.userId || undefined,
    timeoutMs: config.timeoutMs,
    testModel: key.testModel || upstream.testModel || config.testModel,
  };

  const result = await adapter.listModels(ctx);
  if (!result.ok) {
    return NextResponse.json({ error: result.errorMessage || '拉取失败' }, { status: 502 });
  }

  return NextResponse.json({ models: result.models || [] });
}
