export interface UpstreamBalanceCredential {
  baseUrl: string;
  apiKey: string;
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

export function buildUpstreamUsageUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid upstream base URL');
  }
  url.search = '';
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/usage`.replace(/\/+/g, '/');
  return url.toString();
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(buildUpstreamUsageUrl(credential.baseUrl), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential.apiKey}` },
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return null;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) return null;
    const body = JSON.parse(text) as Record<string, unknown>;
    const quota = body.quota && typeof body.quota === 'object' ? body.quota as Record<string, unknown> : null;
    return finiteBalance(body.remaining ?? body.balance ?? quota?.remaining);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
