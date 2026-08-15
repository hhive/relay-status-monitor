import assert from 'node:assert/strict';
import test from 'node:test';

import { apiFetch, resetApiFetchCache } from '../src/lib/api-fetch';

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const path = (value: string) => `${basePath}${value}`;

function response(status = 200, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('api fetch sends GET and HEAD directly without loading auth state', async () => {
  resetApiFetchCache();
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return response();
  };

  try {
    await apiFetch('/api/items');
    await apiFetch('/api/items', { method: 'HEAD' });
    assert.deepEqual(calls.map(({ input }) => input), [path('/api/items'), path('/api/items')]);
    assert.deepEqual(calls.map(({ init }) => init?.method), [undefined, 'HEAD']);
  } finally {
    globalThis.fetch = originalFetch;
    resetApiFetchCache();
  }
});
test('api fetch lazily adds the SSO csrf token to writes and preserves caller headers', async () => {
  resetApiFetchCache();
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    if (input === path('/api/auth/me')) {
      return response(200, { ok: true, source: 'sub2api', csrfToken: 'csrf-from-safe-dto' });
    }
    return response();
  };

  try {
    await apiFetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Caller': 'kept' },
      body: '{}',
    });
    await apiFetch('/api/items/1', { method: 'DELETE' });

    assert.deepEqual(calls.map(({ input }) => input), [
      path('/api/auth/me'),
      path('/api/items'),
      path('/api/items/1'),
    ]);
    const firstWriteHeaders = new Headers(calls[1].init?.headers);
    assert.equal(firstWriteHeaders.get('Content-Type'), 'application/json');
    assert.equal(firstWriteHeaders.get('X-Caller'), 'kept');
    assert.equal(firstWriteHeaders.get('X-CSRF-Token'), 'csrf-from-safe-dto');
    assert.equal(new Headers(calls[2].init?.headers).get('X-CSRF-Token'), 'csrf-from-safe-dto');
  } finally {
    globalThis.fetch = originalFetch;
    resetApiFetchCache();
  }
});

test('api fetch leaves local-session writes tokenless and clears cached SSO state on 401', async () => {
  resetApiFetchCache();
  const calls: FetchCall[] = [];
  let authLoads = 0;
  let writeCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    if (input === path('/api/auth/me')) {
      authLoads += 1;
      return response(200, authLoads === 1
        ? { ok: true, source: 'local' }
        : { ok: true, source: 'sub2api', csrfToken: 'new-csrf-token' });
    }
    writeCount += 1;
    return response(writeCount === 2 ? 401 : 200);
  };

  try {
    await apiFetch('/api/local-write', { method: 'PATCH' });
    assert.equal(new Headers(calls[1].init?.headers).has('X-CSRF-Token'), false);

    await apiFetch('/api/sso-write', { method: 'PUT' });
    await apiFetch('/api/unauthorized', { method: 'DELETE' });
    await apiFetch('/api/after-401', { method: 'POST' });

    assert.equal(authLoads, 3);
    assert.equal(new Headers(calls.at(-1)?.init?.headers).get('X-CSRF-Token'), 'new-csrf-token');
  } finally {
    globalThis.fetch = originalFetch;
    resetApiFetchCache();
  }
});
