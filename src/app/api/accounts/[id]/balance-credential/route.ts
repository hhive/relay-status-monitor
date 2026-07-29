import { AccountBalanceMode } from '@prisma/client';
import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/auth';
import {
  normalizeBalanceMode,
  sealNewApiAccessToken,
  toSafeBalanceCredential,
} from '@/lib/account-observability/balance-credential-config';
import { prisma } from '@/lib/db';
import { parseStrictPositiveInteger } from '@/lib/security';

const DEFAULT_CONFIG = { mode: 'auto' as const, newApiUserId: null, accessTokenConfigured: false };

async function parseAccountId(context: { params: Promise<{ id: string }> }) {
  return parseStrictPositiveInteger((await context.params).id);
}

async function accountExists(id: number) {
  return Boolean(await prisma.sub2ApiAccount.findUnique({ where: { id }, select: { id: true } }));
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = await parseAccountId(context);
  if (id == null) return NextResponse.json({ error: '账号 ID 无效' }, { status: 400 });
  if (!await accountExists(id)) return NextResponse.json({ error: '账号不存在' }, { status: 404 });
  const config = await prisma.accountBalanceCredential.findUnique({ where: { accountId: id } });
  return NextResponse.json(config ? toSafeBalanceCredential(config) : DEFAULT_CONFIG);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = await parseAccountId(context);
  if (id == null) return NextResponse.json({ error: '账号 ID 无效' }, { status: 400 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const mode = normalizeBalanceMode(body?.mode);
  const newApiUserId = typeof body?.newApiUserId === 'string' && body.newApiUserId.trim()
    ? body.newApiUserId.trim()
    : null;
  if (!mode || (newApiUserId != null && !/^[1-9]\d*$/.test(newApiUserId))) {
    return NextResponse.json({ error: '余额凭据参数无效' }, { status: 400 });
  }
  if (!await accountExists(id)) return NextResponse.json({ error: '账号不存在' }, { status: 404 });

  const existing = await prisma.accountBalanceCredential.findUnique({ where: { accountId: id } });
  let ciphertext = existing?.newApiAccessTokenCiphertext ?? null;
  try {
    if (body?.clearAccessToken === true) ciphertext = null;
    else if (typeof body?.accessToken === 'string' && body.accessToken.trim()) {
      ciphertext = sealNewApiAccessToken(body.accessToken);
    }
  } catch {
    return NextResponse.json({ error: 'New API Access Token 无效' }, { status: 400 });
  }
  if (mode === 'newapi' && (!newApiUserId || !ciphertext)) {
    return NextResponse.json({ error: 'New API 模式需要 Access Token 和 User ID' }, { status: 400 });
  }
  if ((newApiUserId == null) !== (ciphertext == null)) {
    return NextResponse.json({ error: 'New API Access Token 和 User ID 必须同时配置' }, { status: 400 });
  }

  const saved = await prisma.accountBalanceCredential.upsert({
    where: { accountId: id },
    create: {
      accountId: id,
      mode: mode.toUpperCase() as AccountBalanceMode,
      newApiUserId,
      newApiAccessTokenCiphertext: ciphertext,
    },
    update: {
      mode: mode.toUpperCase() as AccountBalanceMode,
      newApiUserId,
      newApiAccessTokenCiphertext: ciphertext,
    },
  });
  return NextResponse.json(toSafeBalanceCredential(saved));
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const id = await parseAccountId(context);
  if (id == null) return NextResponse.json({ error: '账号 ID 无效' }, { status: 400 });
  if (!await accountExists(id)) return NextResponse.json({ error: '账号不存在' }, { status: 404 });
  await prisma.accountBalanceCredential.deleteMany({ where: { accountId: id } });
  return NextResponse.json(DEFAULT_CONFIG);
}
