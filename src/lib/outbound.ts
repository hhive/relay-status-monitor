export type UpstreamKind = 'SUB2API' | 'NEW_API';

export type OutboundErrorCategory =
  | 'invalid_destination'
  | 'unsupported_upstream'
  | 'upstream_redirect'
  | 'upstream_network';

export interface OutboundError {
  category: OutboundErrorCategory;
  message: string;
}

export class OutboundRequestError extends Error {
  readonly category: OutboundErrorCategory;

  constructor(category: OutboundErrorCategory, message: string) {
    super(message);
    this.name = 'OutboundRequestError';
    this.category = category;
  }
}

/** Validate the exact destinations enabled by this deployment. */
export function validateUpstreamBaseUrl(kind: UpstreamKind, raw: string): URL {
  if (kind === 'NEW_API') {
    throw new OutboundRequestError('unsupported_upstream', 'NEW_API 上游未启用');
  }

  const trimmed = raw.trim();
  if (trimmed !== 'http://127.0.0.1:8080' && trimmed !== 'http://127.0.0.1:8080/') {
    throw new OutboundRequestError('invalid_destination', 'SUB2API 仅支持 http://127.0.0.1:8080');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OutboundRequestError('invalid_destination', 'SUB2API 上游地址无效');
  }

  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '8080' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new OutboundRequestError('invalid_destination', 'SUB2API 仅支持 http://127.0.0.1:8080');
  }
  return url;
}

export function validateFeishuWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRequestError('invalid_destination', '飞书 Webhook 地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'open.feishu.cn' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    !/^\/open-apis\/bot\/v2\/hook\/[^/]+$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new OutboundRequestError('invalid_destination', '飞书 Webhook 仅支持官方 HTTPS 地址');
  }
  return url;
}

export async function fetchCredentialed(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; response: Response } | { ok: false; error: OutboundError }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: { category: 'upstream_redirect', message: '上游重定向被拒绝' } };
    }
    return { ok: true, response };
  } catch (error) {
    return {
      ok: false,
      error: {
        category: 'upstream_network',
        message: error instanceof Error && error.name === 'AbortError' ? '上游请求超时' : '上游请求失败',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
