import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('account API is session guarded and does not expose raw database or sensitive projections', () => {
  const route = readFileSync(new URL('../src/app/api/accounts/route.ts', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../src/app/api/accounts/[id]/route.ts', import.meta.url), 'utf8');
  assert.match(route, /requireApiSession/);
  assert.match(detail, /requireApiSession/);
  assert.doesNotMatch(`${route}\n${detail}`, /credentials|request_body|error_body|DATABASE_URL|histogram/i);
});
