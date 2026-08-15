import assert from 'node:assert/strict';
import test from 'node:test';

import { publicOrigin } from '../src/lib/public-origin';

test('public origin prefers the configured deployment URL', () => {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = 'https://cmonitor.xiaoni-ai.top';
  try {
    assert.equal(publicOrigin('http://127.0.0.1:3305/'), 'https://cmonitor.xiaoni-ai.top');
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previous;
  }
});

test('public origin rejects configured paths and falls back to the request origin', () => {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = 'https://evil.example/path';
  try {
    assert.equal(publicOrigin('https://monitor.example.test/accounts'), 'https://monitor.example.test');
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previous;
  }
});
