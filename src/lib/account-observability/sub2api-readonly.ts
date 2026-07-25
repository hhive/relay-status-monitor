import { PrismaClient } from '@prisma/client';

export const ACCOUNT_PROJECTION_SQL = `
  SELECT
    id::text AS source_account_id,
    name,
    platform,
    type,
    status AS remote_status,
    CASE WHEN jsonb_typeof(extra -> 'upstream_billing_probe_enabled') = 'boolean'
      THEN (extra ->> 'upstream_billing_probe_enabled')::boolean ELSE false END AS probe_enabled,
    extra #>> '{upstream_billing_probe,status}' AS probe_status,
    extra #>> '{upstream_billing_probe,data,resolved_rate_multiplier}' AS probe_resolved_rate_multiplier,
    extra #>> '{upstream_billing_probe,data,peak_rate_multiplier}' AS probe_peak_rate_multiplier,
    extra #>> '{upstream_billing_probe,data,timezone}' AS probe_timezone,
    extra #>> '{upstream_billing_probe,data,next_probe_at}' AS probe_next_at,
    updated_at AS remote_updated_at
  FROM accounts
  WHERE deleted_at IS NULL
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
  WHERE created_at >= $1 AND created_at < $2
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
  WHERE created_at >= $1 AND created_at < $2
`;

export interface SchemaCapabilities {
  usageLogs: boolean;
  opsErrorLogs: boolean;
  accounts: boolean;
}

export function assertSchemaCapabilities(capabilities: SchemaCapabilities): void {
  if (!capabilities.accounts || !capabilities.usageLogs || !capabilities.opsErrorLogs) {
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
