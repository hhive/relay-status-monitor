export const ADMIN_APP_ID = 'upstream-monitor';
export const ADMIN_EXCHANGE_PATH = '/api/v1/external-apps/upstream-monitor/exchange';
export const ADMIN_EXCHANGE_TIMEOUT_MS = 10_000;

const DEFAULT_ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_ADMIN_SESSION_TTL_SECONDS = 24 * 60 * 60;
const MIN_SECRET_BYTES = 32;
const CLAIM_KEYS = [
  'app_id',
  'email',
  'expires_at',
  'issued_at',
  'role',
  'user_id',
  'username',
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export interface AdminClaims {
  user_id: number;
  email: string;
  username: string;
  role: 'admin';
  app_id: typeof ADMIN_APP_ID;
  issued_at: number;
  expires_at: number;
}

export interface AdminSsoConfig {
  exchangeUrl: string;
  exchangeSecret: string;
  sessionTtlSeconds: number;
}

export interface AdminExchangeOptions {
  environment?: Environment;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}

function invalidConfiguration(): never {
  throw new Error('Admin SSO configuration invalid');
}

function invalidClaims(): never {
  throw new Error('Admin SSO claims invalid');
}

function isAllowedBaseUrl(url: URL): boolean {
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function parseSessionTtl(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_ADMIN_SESSION_TTL_SECONDS;
  if (!/^[1-9]\d*$/.test(value)) invalidConfiguration();
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl > MAX_ADMIN_SESSION_TTL_SECONDS) {
    invalidConfiguration();
  }
  return ttl;
}

export function resolveAdminSsoConfig(
  environment: Environment = process.env,
): AdminSsoConfig {
  const baseUrlValue = environment.SUB2API_ADMIN_EXCHANGE_BASE_URL;
  const exchangeSecret = environment.SUB2API_ADMIN_EXCHANGE_SECRET;
  if (!baseUrlValue || !exchangeSecret) invalidConfiguration();
  if (
    exchangeSecret.startsWith('replace-with-') ||
    new TextEncoder().encode(exchangeSecret).byteLength < MIN_SECRET_BYTES
  ) {
    invalidConfiguration();
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    invalidConfiguration();
  }
  if (!isAllowedBaseUrl(baseUrl)) invalidConfiguration();

  return {
    exchangeUrl: new URL(ADMIN_EXCHANGE_PATH, baseUrl).toString(),
    exchangeSecret,
    sessionTtlSeconds: parseSessionTtl(environment.RSM_ADMIN_SESSION_TTL_SECONDS),
  };
}

export function validateAdminClaims(value: unknown, nowSeconds: number): AdminClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidClaims();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((key, index) => key !== CLAIM_KEYS[index])) {
    invalidClaims();
  }

  if (
    !Number.isSafeInteger(record.user_id) ||
    (record.user_id as number) <= 0 ||
    typeof record.email !== 'string' ||
    record.email.length === 0 ||
    typeof record.username !== 'string' ||
    record.username.length === 0 ||
    record.role !== 'admin' ||
    record.app_id !== ADMIN_APP_ID ||
    !Number.isSafeInteger(record.issued_at) ||
    !Number.isSafeInteger(record.expires_at) ||
    (record.issued_at as number) > nowSeconds ||
    (record.expires_at as number) <= nowSeconds
  ) {
    invalidClaims();
  }

  return record as unknown as AdminClaims;
}

export async function exchangeAdminLaunchTicket(
  token: string,
  options: AdminExchangeOptions = {},
): Promise<AdminClaims> {
  const config = resolveAdminSsoConfig(options.environment);
  const response = await (options.fetchImpl ?? fetch)(config.exchangeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sub2API-External-App-Secret': config.exchangeSecret,
    },
    body: JSON.stringify({ token }),
    redirect: 'error',
    signal: AbortSignal.timeout(ADMIN_EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Admin SSO exchange failed');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Admin SSO exchange failed');
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  return validateAdminClaims(body, nowSeconds);
}
