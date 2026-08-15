const PUBLIC_ORIGIN_ENV = 'NEXT_PUBLIC_APP_URL';

function configuredPublicOrigin(): string | null {
  const value = process.env[PUBLIC_ORIGIN_ENV]?.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function publicOrigin(requestUrl: string): string {
  return configuredPublicOrigin() ?? new URL(requestUrl).origin;
}
