export type OutboundErrorCategory =
  | 'invalid_destination'
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
