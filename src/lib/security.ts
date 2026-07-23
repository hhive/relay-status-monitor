const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function parseStrictPositiveInteger(value: string): number | null {
  if (!POSITIVE_INTEGER_PATTERN.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function safeRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';

  let decoded = value;
  for (let pass = 0; pass < 5; pass += 1) {
    if (decoded.includes('\\') || CONTROL_CHARACTER_PATTERN.test(decoded)) return '/';
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return '/';
    }
  }

  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(decoded)
  ) {
    return '/';
  }

  return value;
}
