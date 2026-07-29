export interface UpstreamBalanceCredential {
  baseUrl: string;
  apiKey: string;
}

export interface UpstreamUsageSnapshot {
  balanceUsd: number | null;
  keyUsedUsd: number | null;
  keyStandardUsd: number | null;
}

export type UpstreamBalanceMode = 'auto' | 'sub2api' | 'newapi';

export interface NewApiBalanceCredential {
  baseUrl: string;
  accessToken: string;
  userId: string;
}

export interface ConfiguredUpstreamBalanceCredential extends UpstreamBalanceCredential {
  mode?: UpstreamBalanceMode;
  newApiAccessToken?: string | null;
  newApiUserId?: string | null;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ABSOLUTE_BALANCE = 1_000_000_000_000_000;
const MAX_RATE_MULTIPLIER = 1_000_000;

function buildSub2ApiUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid upstream base URL');
  }
  url.search = '';
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}${endpoint}`.replace(/\/+/g, '/');
  return url.toString();
}

export function buildUpstreamUsageUrl(baseUrl: string): string {
  return buildSub2ApiUrl(baseUrl, '/usage');
}

export function buildUpstreamBillingUrl(baseUrl: string): string {
  return buildSub2ApiUrl(baseUrl, '/sub2api/billing');
}

function finiteBalance(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_ABSOLUTE_BALANCE ? parsed : null;
}

function buildNewApiUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid upstream base URL');
  }
  url.search = '';
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  url.pathname = `${path}${endpoint}`.replace(/\/+/g, '/');
  return url.toString();
}

async function requestJson(url: string, headers: HeadersInit, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return null;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) return null;
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryUpstreamBalance(
  credential: UpstreamBalanceCredential,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  return (await queryUpstreamUsageSnapshot(credential, fetchImpl))?.balanceUsd ?? null;
}

export async function queryUpstreamUsageSnapshot(
  credential: UpstreamBalanceCredential,
  fetchImpl: FetchLike = fetch,
): Promise<UpstreamUsageSnapshot | null> {
  const body = await requestJson(
    buildUpstreamUsageUrl(credential.baseUrl),
    { Accept: 'application/json', Authorization: `Bearer ${credential.apiKey}` },
    fetchImpl,
  );
  if (!body) return null;
  const quota = body.quota && typeof body.quota === 'object' ? body.quota as Record<string, unknown> : null;
  const usage = body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : null;
  const total = usage?.total && typeof usage.total === 'object' ? usage.total as Record<string, unknown> : null;
  const snapshot = {
    balanceUsd: finiteBalance(body.remaining ?? body.balance ?? quota?.remaining),
    keyUsedUsd: finiteBalance(total?.actual_cost ?? quota?.used),
    keyStandardUsd: finiteBalance(total?.cost),
  };
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

export async function queryUpstreamRateMultiplier(
  credential: UpstreamBalanceCredential,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  const body = await requestJson(
    buildUpstreamBillingUrl(credential.baseUrl),
    { Accept: 'application/json', Authorization: `Bearer ${credential.apiKey}` },
    fetchImpl,
  );
  if (body?.object !== 'sub2api.key_billing' || body.schema_version !== 1 || body.billing_scope !== 'token') return null;
  const value = finiteBalance(body.effective_rate_multiplier);
  return value != null && value >= 0 && value <= MAX_RATE_MULTIPLIER ? value : null;
}

export function estimateUpstreamRateMultiplier(input: {
  previousKeyUsedUsd: number;
  currentKeyUsedUsd: number;
  baseBilledUsd: number;
}): number | null {
  const values = [input.previousKeyUsedUsd, input.currentKeyUsedUsd, input.baseBilledUsd];
  if (!values.every(Number.isFinite)) return null;
  const usedDelta = input.currentKeyUsedUsd - input.previousKeyUsedUsd;
  if (usedDelta <= 0 || input.baseBilledUsd <= 0) return null;
  const value = usedDelta / input.baseBilledUsd;
  return value > 0 && value <= MAX_RATE_MULTIPLIER ? value : null;
}

export async function queryNewApiBalance(
  credential: NewApiBalanceCredential,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  const status = await requestJson(
    buildNewApiUrl(credential.baseUrl, '/api/status'),
    { Accept: 'application/json' },
    fetchImpl,
  );
  const statusData = status?.data && typeof status.data === 'object'
    ? status.data as Record<string, unknown>
    : null;
  const quotaPerUnit = finiteBalance(statusData?.quota_per_unit);
  if (status?.success !== true || quotaPerUnit == null || quotaPerUnit <= 0) return null;

  const account = await requestJson(
    buildNewApiUrl(credential.baseUrl, '/api/user/self'),
    {
      Accept: 'application/json',
      Authorization: `Bearer ${credential.accessToken}`,
      'New-Api-User': credential.userId,
    },
    fetchImpl,
  );
  const accountData = account?.data && typeof account.data === 'object'
    ? account.data as Record<string, unknown>
    : null;
  const quota = finiteBalance(accountData?.quota);
  if (account?.success !== true || quota == null) return null;
  return finiteBalance(quota / quotaPerUnit);
}

export async function queryNewApiKeyUsedUsd(
  credential: UpstreamBalanceCredential,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  const status = await requestJson(
    buildNewApiUrl(credential.baseUrl, '/api/status'),
    { Accept: 'application/json' },
    fetchImpl,
  );
  const statusData = status?.data && typeof status.data === 'object'
    ? status.data as Record<string, unknown>
    : null;
  const quotaPerUnit = finiteBalance(statusData?.quota_per_unit);
  if (status?.success !== true || quotaPerUnit == null || quotaPerUnit <= 0) return null;
  const usage = await requestJson(
    buildNewApiUrl(credential.baseUrl, '/api/usage/token/'),
    { Accept: 'application/json', Authorization: `Bearer ${credential.apiKey}` },
    fetchImpl,
  );
  const data = usage?.data && typeof usage.data === 'object' ? usage.data as Record<string, unknown> : null;
  const usedQuota = usage?.success === true
    ? finiteBalance(data?.used_quota)
    : usage?.code === true
      ? finiteBalance(data?.total_used)
      : null;
  return usedQuota != null ? finiteBalance(usedQuota / quotaPerUnit) : null;
}

export async function queryConfiguredUpstreamBalance(
  credential: ConfiguredUpstreamBalanceCredential,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  const mode = credential.mode ?? 'auto';
  if (mode !== 'newapi') {
    const balance = await queryUpstreamBalance(credential, fetchImpl);
    if (balance != null || mode === 'sub2api') return balance;
  }
  if (!credential.newApiAccessToken || !credential.newApiUserId) return null;
  return queryNewApiBalance({
    baseUrl: credential.baseUrl,
    accessToken: credential.newApiAccessToken,
    userId: credential.newApiUserId,
  }, fetchImpl);
}

export async function queryConfiguredUpstreamUsageSnapshot(
  credential: ConfiguredUpstreamBalanceCredential,
  fetchImpl: FetchLike = fetch,
): Promise<UpstreamUsageSnapshot | null> {
  const mode = credential.mode ?? 'auto';
  if (mode !== 'newapi') {
    const snapshot = await queryUpstreamUsageSnapshot(credential, fetchImpl);
    if (snapshot || mode === 'sub2api') return snapshot;
  }
  const [balanceUsd, keyUsedUsd] = await Promise.all([
    credential.newApiAccessToken && credential.newApiUserId
      ? queryNewApiBalance({
        baseUrl: credential.baseUrl,
        accessToken: credential.newApiAccessToken,
        userId: credential.newApiUserId,
      }, fetchImpl)
      : Promise.resolve(null),
    queryNewApiKeyUsedUsd(credential, fetchImpl),
  ]);
  if (balanceUsd == null && keyUsedUsd == null) return null;
  return {
    balanceUsd,
    keyUsedUsd,
    keyStandardUsd: null,
  };
}
