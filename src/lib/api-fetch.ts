type AuthMeDto = {
  source?: unknown;
  csrfToken?: unknown;
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let csrfToken: string | undefined;

export function resetApiFetchCache(): void {
  csrfToken = undefined;
}

async function loadCsrfToken(): Promise<string | undefined> {
  if (csrfToken) return csrfToken;

  const response = await fetch('/api/auth/me');
  if (!response.ok) {
    resetApiFetchCache();
    return undefined;
  }
  const body = await response.json().catch(() => ({})) as AuthMeDto;
  if (body.source === 'sub2api' && typeof body.csrfToken === 'string') {
    csrfToken = body.csrfToken;
  }
  return csrfToken;
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let requestInit = init;

  if (WRITE_METHODS.has(method)) {
    const token = await loadCsrfToken();
    if (token) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      headers.set('X-CSRF-Token', token);
      requestInit = { ...init, headers };
    }
  }

  const response = await fetch(input, requestInit);
  if (response.status === 401) resetApiFetchCache();
  return response;
}
