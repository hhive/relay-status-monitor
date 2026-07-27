import { PrismaClient } from '@prisma/client';

export const ACCOUNT_PROJECTION_SQL = `
  SELECT
    a.id::text AS source_account_id,
    a.name,
    a.platform,
    a.type,
    a.status AS remote_status,
    a.schedulable,
    a.rate_limited_at,
    a.rate_limit_reset_at,
    a.overload_until,
    a.temp_unschedulable_until,
    a.temp_unschedulable_reason,
    groups.group_ids,
    groups.group_projection,
    CASE WHEN jsonb_typeof(a.extra -> 'upstream_billing_probe_enabled') = 'boolean'
      THEN (a.extra ->> 'upstream_billing_probe_enabled')::boolean ELSE false END AS probe_enabled,
    a.extra #>> '{upstream_billing_probe,status}' AS probe_status,
    a.extra #>> '{upstream_billing_probe,received_at}' AS probe_received_at,
    a.extra #>> '{upstream_billing_probe,fresh_until}' AS probe_fresh_until,
    a.extra #>> '{upstream_billing_probe,next_probe_at}' AS probe_next_at,
    a.extra #>> '{upstream_billing_probe,data,billing_scope}' AS probe_billing_scope,
    a.extra #>> '{upstream_billing_probe,data,resolved_rate_multiplier}' AS probe_resolved_rate_multiplier,
    a.extra #>> '{upstream_billing_probe,data,peak_rate_enabled}' AS probe_peak_rate_enabled,
    a.extra #>> '{upstream_billing_probe,data,peak_start}' AS probe_peak_start,
    a.extra #>> '{upstream_billing_probe,data,peak_end}' AS probe_peak_end,
    a.extra #>> '{upstream_billing_probe,data,peak_rate_multiplier}' AS probe_peak_rate_multiplier,
    a.extra #>> '{upstream_billing_probe,data,timezone}' AS probe_timezone,
    a.updated_at AS remote_updated_at
  FROM accounts a
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(jsonb_agg(ag.group_id ORDER BY ag.group_id), '[]'::jsonb) AS group_ids,
      COALESCE(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name), '[]'::jsonb) AS group_projection
    FROM account_groups ag
    JOIN groups g ON g.id = ag.group_id
    WHERE ag.account_id = a.id
  ) groups ON true
  WHERE a.deleted_at IS NULL
`;

export const USAGE_PROJECTION_SQL = `
  SELECT
    id::text AS usage_id,
    account_id::text AS account_id,
    request_id,
    created_at,
    duration_ms,
    first_token_ms,
    input_tokens,
    cache_read_tokens,
    cache_creation_tokens,
    actual_cost,
    account_stats_cost,
    total_cost,
    account_rate_multiplier
  FROM usage_logs
  WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
`;

export const ERROR_PROJECTION_SQL = `
  SELECT
    id::text AS error_id,
    account_id::text AS account_id,
    request_id,
    client_request_id,
    created_at,
    error_phase,
    error_owner,
    status_code
  FROM ops_error_logs
  WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
`;

export const CAPABILITY_PROJECTION_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE table_name = 'accounts') = 14 AS accounts,
    COUNT(*) FILTER (WHERE table_name = 'account_groups') = 2 AS account_groups,
    COUNT(*) FILTER (WHERE table_name = 'groups') = 2 AS groups,
    COUNT(*) FILTER (WHERE table_name = 'usage_logs') = 13 AS usage_logs,
    COUNT(*) FILTER (WHERE table_name = 'ops_error_logs') = 8 AS ops_error_logs
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND (
      (table_name = 'accounts' AND column_name = ANY(ARRAY['id','name','platform','type','status','schedulable','rate_limited_at','rate_limit_reset_at','overload_until','temp_unschedulable_until','temp_unschedulable_reason','extra','updated_at','deleted_at'])) OR
      (table_name = 'account_groups' AND column_name = ANY(ARRAY['account_id','group_id'])) OR
      (table_name = 'groups' AND column_name = ANY(ARRAY['id','name'])) OR
      (table_name = 'usage_logs' AND column_name = ANY(ARRAY['id','account_id','request_id','created_at','duration_ms','first_token_ms','input_tokens','cache_read_tokens','cache_creation_tokens','actual_cost','account_stats_cost','total_cost','account_rate_multiplier'])) OR
      (table_name = 'ops_error_logs' AND column_name = ANY(ARRAY['id','account_id','request_id','client_request_id','created_at','error_phase','error_owner','status_code']))
    )
`;

export interface SchemaCapabilities {
  usageLogs: boolean;
  opsErrorLogs: boolean;
  accounts: boolean;
  accountGroups: boolean;
  groups: boolean;
}

export function assertSchemaCapabilities(capabilities: SchemaCapabilities): void {
  if (!capabilities.accounts || !capabilities.accountGroups || !capabilities.groups ||
      !capabilities.usageLogs || !capabilities.opsErrorLogs) {
    throw new Error('Sub2API observability schema capability check failed');
  }
}

export function buildWindowParams(from: Date, to: Date): { from: string; to: string } {
  if (from >= to) throw new Error('invalid observability window');
  return { from: from.toISOString(), to: to.toISOString() };
}

export type ReadonlyTransaction = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
};

export type ReadonlyClient = ReadonlyTransaction & {
  $transaction: <T>(callback: (tx: ReadonlyTransaction) => Promise<T>) => Promise<T>;
  $disconnect: () => Promise<void>;
};

const STATEMENT_TIMEOUT_MS = 10_000;

export function createSub2ApiReadonlyClient(url = process.env.SUB2API_DATABASE_URL): PrismaClient {
  if (!url) throw new Error('SUB2API_DATABASE_URL is required for account observability');
  return new PrismaClient({ datasourceUrl: url, log: ['error'] });
}

export async function withReadonlyTransaction<T>(
  client: ReadonlyClient,
  operation: (tx: ReadonlyTransaction) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return operation(tx);
  });
}

export async function queryUsageRows<T>(client: ReadonlyClient, from: Date, to: Date): Promise<T[]> {
  const params = buildWindowParams(from, to);
  return withReadonlyTransaction(client, (tx) => tx.$queryRawUnsafe<T[]>(USAGE_PROJECTION_SQL, params.from, params.to));
}

export async function queryAccountRows<T>(client: ReadonlyClient): Promise<T[]> {
  return withReadonlyTransaction(client, (tx) => tx.$queryRawUnsafe<T[]>(ACCOUNT_PROJECTION_SQL));
}

export async function queryProviderErrorRows<T>(client: ReadonlyClient, from: Date, to: Date): Promise<T[]> {
  const params = buildWindowParams(from, to);
  return withReadonlyTransaction(client, (tx) => tx.$queryRawUnsafe<T[]>(ERROR_PROJECTION_SQL, params.from, params.to));
}

export async function querySchemaCapabilities(client: ReadonlyClient): Promise<SchemaCapabilities> {
  const rows = await withReadonlyTransaction(client, (tx) => tx.$queryRawUnsafe<Array<{
    accounts: boolean; account_groups: boolean; groups: boolean; usage_logs: boolean; ops_error_logs: boolean;
  }>>(CAPABILITY_PROJECTION_SQL));
  const row = rows[0];
  const capabilities = {
    accounts: row?.accounts === true,
    accountGroups: row?.account_groups === true,
    groups: row?.groups === true,
    usageLogs: row?.usage_logs === true,
    opsErrorLogs: row?.ops_error_logs === true,
  };
  assertSchemaCapabilities(capabilities);
  return capabilities;
}
