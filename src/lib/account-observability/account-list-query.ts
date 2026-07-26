import { Prisma } from '@prisma/client';

import type {
  AccountListItemDto,
  AccountListQueryInput,
  AccountListResponseDto,
  AccountPageSize,
  AccountWindowDto,
} from '../account-observability-ui';
import { ACCOUNT_PAGE_SIZES } from '../account-observability-ui';
import { ACCOUNT_SORT_KEYS, type AccountSortKey, type AccountSortOrder } from '../account-list-sort';
import { prisma } from '../db';
import { parseAccountFilters, type AccountFilters } from './filters';
import { SNAPSHOT_WINDOWS } from './snapshot';
import { AccountQueryValidationError, parseAccountWindow } from './window';

export class AccountSnapshotUnavailableError extends Error {}

interface SnapshotBatchRow {
  id: number;
  windowStart: Date;
  windowEnd: Date;
  lastCompleteMinute: Date | null;
  computedAt: Date;
}

interface AccountListRawRow {
  id: number;
  name: string;
  platform: string | null;
  type: string | null;
  remoteStatus: string | null;
  schedulable: boolean | null;
  syncState: string;
  groupProjection: unknown;
  lastSyncedAt: Date | null;
  alertEnabled: boolean;
  snapshotId: number | null;
  eligibleCount: number | null;
  availability: number | null;
  errorRate: number | null;
  durationP95Ms: number | null;
  firstTokenP95Ms: number | null;
  cacheHitRate: number | null;
  userBilledUsd: unknown;
  accountBilledUsd: unknown;
  lastCompleteMinute: Date | null;
}

interface AccountListTransaction {
  accountMetricSnapshotBatch: {
    findFirst(args: Record<string, unknown>): Promise<SnapshotBatchRow | null>;
  };
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}

interface AccountListClient {
  $transaction<T>(
    work: (tx: AccountListTransaction) => Promise<T>,
    options: { isolationLevel: 'RepeatableRead' },
  ): Promise<T>;
}

const WINDOW_LABELS = {
  today: '北京时间今日',
  last1h: '近 1 小时',
  last24h: '近 24 小时',
} as const;

function positiveInteger(value: string | null, fallback: number, name: string): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new AccountQueryValidationError(`invalid account ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AccountQueryValidationError(`invalid account ${name}`);
  return parsed;
}

export function parseAccountListQuery(params: URLSearchParams): AccountListQueryInput {
  const page = positiveInteger(params.get('page'), 1, 'page');
  const pageSize = positiveInteger(params.get('pageSize'), 50, 'page size');
  if (!ACCOUNT_PAGE_SIZES.includes(pageSize as AccountPageSize)) {
    throw new AccountQueryValidationError('invalid account page size');
  }
  const sortKey = params.get('sortKey') ?? 'alertEnabled';
  const sortOrder = params.get('sortOrder') ?? 'desc';
  if (!ACCOUNT_SORT_KEYS.includes(sortKey as AccountSortKey)) {
    throw new AccountQueryValidationError('invalid account sort key');
  }
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new AccountQueryValidationError('invalid account sort order');
  }
  return {
    windowKey: parseAccountWindow(params.get('window')),
    filters: parseAccountFilters(params),
    page,
    pageSize: pageSize as AccountPageSize,
    sort: { key: sortKey as AccountSortKey, order: sortOrder },
  };
}

function accountTextCte(): Prisma.Sql {
  return Prisma.sql`
    WITH account_text AS (
      SELECT a.*, COALESCE(groups.group_sort_text, '无分组') AS group_sort_text,
        COALESCE(groups.group_filter_text, '') AS group_filter_text
      FROM "Sub2ApiAccount" a
      LEFT JOIN LATERAL (
        SELECT
          string_agg(group_item.label, '、' ORDER BY group_item.ordinality)
            FILTER (WHERE group_item.label IS NOT NULL) AS group_sort_text,
          string_agg(group_item.filter_text, ' ' ORDER BY group_item.ordinality) AS group_filter_text
        FROM (
          SELECT item.ordinality,
            CASE
              WHEN jsonb_typeof(item.value->'name') = 'string' AND BTRIM(item.value->>'name') <> ''
                THEN BTRIM(item.value->>'name')
              WHEN jsonb_typeof(item.value->'id') IN ('number', 'string')
                THEN concat('分组 #', item.value->>'id')
              ELSE NULL
            END AS label,
            concat_ws(' ', item.value->>'id', item.value->>'name') AS filter_text
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(a."groupProjection") = 'array' THEN a."groupProjection" ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS item(value, ordinality)
        ) group_item
      ) groups ON TRUE
    )`;
}

function accountFilterSql(filters: AccountFilters, includePlatform: boolean): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filters.status === 'schedulable') {
    conditions.push(Prisma.sql`a."syncState" = 'ACTIVE' AND a."schedulable" = true`);
  } else if (filters.status === 'unschedulable') {
    conditions.push(Prisma.sql`a."syncState" = 'ACTIVE' AND a."schedulable" = false`);
  }
  if (includePlatform && filters.platform) {
    conditions.push(Prisma.sql`lower(a."platform") = lower(${filters.platform})`);
  }
  if (filters.group) {
    conditions.push(Prisma.sql`strpos(lower(a.group_filter_text), lower(${filters.group})) > 0`);
  }
  if (filters.search) {
    conditions.push(Prisma.sql`strpos(lower(concat_ws(' ', a."name", a."platform", a.group_filter_text)), lower(${filters.search})) > 0`);
  }
  return conditions.length === 0 ? Prisma.sql`TRUE` : Prisma.join(conditions, ' AND ');
}

function fixedSortExpression(key: AccountSortKey, requestNow: Date): Prisma.Sql[] {
  switch (key) {
    case 'account': return [Prisma.sql`LOWER(a."name")`];
    case 'platformGroup': return [Prisma.sql`LOWER(a."platform")`, Prisma.sql`LOWER(a.group_sort_text)`];
    case 'schedulable': return [Prisma.sql`a."schedulable"`];
    case 'availability': return [Prisma.sql`s."availability"`];
    case 'errorRate': return [Prisma.sql`s."errorRate"`];
    case 'durationP95Ms': return [Prisma.sql`s."durationP95Ms"`];
    case 'firstTokenP95Ms': return [Prisma.sql`s."firstTokenP95Ms"`];
    case 'cacheHitRate': return [Prisma.sql`s."cacheHitRate"`];
    case 'userBilledUsd': return [Prisma.sql`s."userBilledUsd"`];
    case 'accountBilledUsd': return [Prisma.sql`s."accountBilledUsd"`];
    case 'eligibleCount': return [Prisma.sql`s."eligibleCount"`];
    case 'sync': return [Prisma.sql`CASE
      WHEN a."lastSyncedAt" IS NULL OR s."lastCompleteMinute" IS NULL THEN NULL
      WHEN a."lastSyncedAt" < ${new Date(requestNow.getTime() - 10 * 60_000)}
        OR s."lastCompleteMinute" < ${new Date(requestNow.getTime() - 3 * 60_000)} THEN 1
      ELSE 0 END`];
    case 'alertEnabled': return [Prisma.sql`a."alertEnabled"`];
    default: throw new AccountQueryValidationError('invalid account sort key');
  }
}

function orderBySql(key: AccountSortKey, order: AccountSortOrder, requestNow: Date): Prisma.Sql {
  if (!ACCOUNT_SORT_KEYS.includes(key) || (order !== 'asc' && order !== 'desc')) {
    throw new AccountQueryValidationError('invalid account sort');
  }
  const direction = order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const expressions = fixedSortExpression(key, requestNow);
  const snapshotMetric = ['availability', 'errorRate', 'durationP95Ms', 'firstTokenP95Ms', 'cacheHitRate',
    'userBilledUsd', 'accountBilledUsd', 'eligibleCount'].includes(key);
  const parts = expressions.map((expression) => Prisma.sql`${expression} ${direction} NULLS LAST`);
  return Prisma.join([
    ...(snapshotMetric ? [Prisma.sql`CASE WHEN s."id" IS NULL THEN 1 ELSE 0 END ASC`] : []),
    ...parts,
    Prisma.sql`LOWER(a."name") ASC`,
    Prisma.sql`a."id" ASC`,
  ], ', ');
}

function buildPlatformFacetQuery(input: AccountListQueryInput): Prisma.Sql {
  const where = accountFilterSql(input.filters, false);
  return Prisma.sql`${accountTextCte()}
    SELECT a."platform" AS platform
    FROM account_text a
    WHERE ${where} AND a."platform" IS NOT NULL AND a."platform" <> ''
    GROUP BY a."platform"
    ORDER BY LOWER(a."platform") ASC`;
}

function buildAccountCountQuery(input: AccountListQueryInput): Prisma.Sql {
  const where = accountFilterSql(input.filters, true);
  return Prisma.sql`${accountTextCte()}
    SELECT COUNT(*)::bigint AS total FROM account_text a WHERE ${where}`;
}

export function buildAccountListPageQuery(
  input: AccountListQueryInput,
  batchId: number,
  offset: number,
  requestNow = new Date(),
): Prisma.Sql {
  const orderBy = orderBySql(input.sort.key, input.sort.order, requestNow);
  const where = accountFilterSql(input.filters, true);
  return Prisma.sql`${accountTextCte()}
    SELECT a."id", a."name", a."platform", a."type", a."remoteStatus", a."schedulable",
      a."syncState", a."groupProjection", a."lastSyncedAt", a."alertEnabled",
      s."id" AS "snapshotId", s."eligibleCount", s."availability", s."errorRate",
      s."durationP95Ms", s."firstTokenP95Ms", s."cacheHitRate", s."userBilledUsd",
      s."accountBilledUsd", s."lastCompleteMinute"
    FROM account_text a
    LEFT JOIN "AccountMetricSnapshot" s ON s."accountId" = a."id" AND s."batchId" = ${batchId}
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${input.pageSize} OFFSET ${offset}`;
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function decimalString(value: unknown, missing: string): string {
  if (value == null) return missing;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') return value.toString();
  throw new Error('invalid account monetary value');
}

function listItem(row: AccountListRawRow): AccountListItemDto {
  const hasSnapshot = row.snapshotId !== null;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    type: row.type,
    remoteStatus: row.remoteStatus,
    schedulable: row.schedulable,
    syncState: row.syncState,
    groupProjection: row.groupProjection,
    lastSyncedAt: toIso(row.lastSyncedAt),
    lastCompleteMinute: hasSnapshot ? toIso(row.lastCompleteMinute) : null,
    alertEnabled: row.alertEnabled,
    metrics: {
      eligibleCount: hasSnapshot ? row.eligibleCount ?? 0 : 0,
      availability: hasSnapshot ? row.availability : null,
      errorRate: hasSnapshot ? row.errorRate : null,
      durationP95Ms: hasSnapshot ? row.durationP95Ms : null,
      firstTokenP95Ms: hasSnapshot ? row.firstTokenP95Ms : null,
      cacheHitRate: hasSnapshot ? row.cacheHitRate : null,
      userBilledUsd: decimalString(hasSnapshot ? row.userBilledUsd : null, '0.000000'),
      accountBilledUsd: decimalString(hasSnapshot ? row.accountBilledUsd : null, '0.000000'),
    },
  };
}

function windowDto(input: AccountListQueryInput, batch: SnapshotBatchRow): AccountWindowDto {
  return {
    key: input.windowKey,
    label: WINDOW_LABELS[input.windowKey],
    start: batch.windowStart.toISOString(),
    end: batch.windowEnd.toISOString(),
    lastCompleteMinute: toIso(batch.lastCompleteMinute),
    expectedMinutes: Math.max(0, Math.floor((batch.windowEnd.getTime() - batch.windowStart.getTime()) / 60_000)),
  };
}

export async function getAccountList(
  input: AccountListQueryInput,
  client: AccountListClient = prisma as unknown as AccountListClient,
  requestNow = new Date(),
): Promise<AccountListResponseDto> {
  return client.$transaction(async (tx) => {
    const batch = await tx.accountMetricSnapshotBatch.findFirst({
      where: { windowKey: SNAPSHOT_WINDOWS[input.windowKey], active: true },
      orderBy: { windowEnd: 'desc' },
    });
    if (!batch) throw new AccountSnapshotUnavailableError();

    const platformRows = await tx.$queryRaw<Array<{ platform: string }>>(buildPlatformFacetQuery(input));
    const countRows = await tx.$queryRaw<Array<{ total: bigint }>>(buildAccountCountQuery(input));
    const totalValue = countRows[0]?.total ?? BigInt(0);
    if (totalValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('account count exceeds safe integer range');
    const totalItems = Number(totalValue);
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / input.pageSize);
    const page = totalPages === 0 ? 1 : Math.min(input.page, totalPages);
    const rows = await tx.$queryRaw<AccountListRawRow[]>(
      buildAccountListPageQuery(input, batch.id, (page - 1) * input.pageSize, requestNow),
    );
    return {
      accounts: rows.map(listItem),
      facets: { platforms: platformRows.map((row) => row.platform) },
      pagination: { page, pageSize: input.pageSize, totalItems, totalPages },
      window: windowDto(input, batch),
      snapshot: {
        computedAt: batch.computedAt.toISOString(),
        lastCompleteMinute: toIso(batch.lastCompleteMinute),
      },
    };
  }, { isolationLevel: 'RepeatableRead' });
}
