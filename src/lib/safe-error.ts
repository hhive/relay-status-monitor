const MAX_SAFE_ERROR_LENGTH = 240;

/** Remove credentials and bound untrusted error text before persistence or display. */
export function redactSensitiveText(value: unknown, maxLength = MAX_SAFE_ERROR_LENGTH): string {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._~-]+/g, 'sk-[REDACTED]')
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;"']+/gi,
      '$1[REDACTED]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /(https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/)[^\s?#/]+/gi,
      '$1[REDACTED]',
    );

  const normalized = text.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function safeErrorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof Error && error.name === 'AbortError') return '请求超时';
  const raw = error instanceof Error ? error.message : error;
  return redactSensitiveText(raw) || fallback;
}

/** Return only a stable category for persisted upstream failures. */
export function safeStoredError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'upstream_timeout';
  if (error && typeof error === 'object' && 'category' in error) {
    const category = String((error as { category?: unknown }).category ?? '');
    if (/^[a-z_]{1,40}$/.test(category)) return category;
  }
  const raw = typeof error === 'string' ? error : '';
  const status = raw.match(/^HTTP\s+(\d{3})$/)?.[1];
  return status ? `upstream_http_${status}` : 'upstream_failure';
}
