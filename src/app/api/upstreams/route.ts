import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { UpstreamType } from '@prisma/client';
import { parsePaginationParams } from '@/lib/pagination';
import { toSafeUpstreamKey } from '@/lib/key-metadata';
import {
  buildUpstreamOrderBy,
  buildUpstreamWhere,
  calculateTotalBalance,
  parseUpstreamQueryParams,
  sortAndPaginateByBalance,
} from '@/lib/upstream-query';
import { requireApiSession } from '@/lib/auth';
import { validateUpstreamBaseUrl } from '@/lib/outbound';

/** 分页获取上游（含 keys 列表） */
export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const searchParams = new URL(request.url).searchParams;
  const { page, pageSize } = parsePaginationParams(searchParams);
  const query = parseUpstreamQueryParams(searchParams);
  const where = buildUpstreamWhere(query);

  if (query.sort === 'totalBalance') {
    const upstreams = await prisma.upstream.findMany({
      where,
      orderBy: { id: 'asc' },
      include: {
        keys: {
          orderBy: { id: 'asc' },
        },
      },
    });
    const result = sortAndPaginateByBalance(upstreams, query.direction, page, pageSize);

    return NextResponse.json({
      items: result.items.map((upstream) => ({
        ...upstream,
        keys: upstream.keys.map(toSafeUpstreamKey),
      })),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  }

  const total = await prisma.upstream.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const upstreams = await prisma.upstream.findMany({
    where,
    orderBy: buildUpstreamOrderBy(query),
    skip: (currentPage - 1) * pageSize,
    take: pageSize,
    include: {
      keys: {
        orderBy: { id: 'asc' },
      },
    },
  });

  // 去掉加密原文，计算 hasApiKey/hasAccessToken 标志
  const result = upstreams.map((u) => ({
    ...u,
    totalBalance: calculateTotalBalance(u.keys),
    keys: u.keys.map(toSafeUpstreamKey),
  }));

  return NextResponse.json({
    items: result,
    pagination: {
      page: currentPage,
      pageSize,
      total,
      totalPages,
    },
  });
}

/** 新建上游（不含凭证，凭证通过 keys 端点添加） */
export async function POST(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const { name, baseUrl, type, testModel, enabled, priority } = body;

    if (!name || !baseUrl) {
      return NextResponse.json({ error: '名称和地址不能为空' }, { status: 400 });
    }
    const upstreamType: UpstreamType = type === undefined ? 'SUB2API' : type;
    if (upstreamType !== 'SUB2API' && upstreamType !== 'NEW_API') {
      return NextResponse.json({ error: '上游类型无效' }, { status: 400 });
    }
    let validatedUrl: URL;
    try {
      validatedUrl = validateUpstreamBaseUrl(upstreamType, String(baseUrl));
    } catch {
      return NextResponse.json({ error: '上游地址不受支持' }, { status: 400 });
    }

    const upstream = await prisma.upstream.create({
      data: {
        name,
        baseUrl: validatedUrl.origin,
        type: upstreamType,
        testModel: testModel || null,
        enabled: enabled !== false,
        priority: priority ?? 0,
      },
    });
    return NextResponse.json(upstream, { status: 201 });
  } catch {
    return NextResponse.json({ error: '创建上游失败' }, { status: 500 });
  }
}
