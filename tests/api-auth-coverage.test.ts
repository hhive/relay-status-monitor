import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { toMeResponseBody } from '../src/lib/auth';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(projectRoot, 'src/app/api');
const publicRoutes = new Set([
  'auth/login/route.ts',
  'auth/logout/route.ts',
  'cron/collect/route.ts',
  'sub2api/admin-launch/route.ts',
]);

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    return statSync(absolute).isDirectory()
      ? routeFiles(absolute)
      : entry === 'route.ts'
        ? [absolute]
        : [];
  });
}

test('every non-public API handler performs a session guard before protected work', () => {
  const protectedRoutes = routeFiles(apiRoot)
    .map((absolute) => path.relative(apiRoot, absolute).replaceAll(path.sep, '/'))
    .filter((relative) => !publicRoutes.has(relative));

  assert.ok(protectedRoutes.length > 0);
  assert.ok(protectedRoutes.includes('accounts/list/route.ts'), 'accounts/list/route.ts must exist and be protected');
  for (const relative of protectedRoutes) {
    const contents = readFileSync(path.join(apiRoot, relative), 'utf8');
    const requiredGuard = relative === 'auth/password/route.ts'
      ? 'requireLocalApiSession'
      : 'requireApiSession';
    assert.match(
      contents,
      new RegExp(`import\\s+\\{[^}]*\\b${requiredGuard}\\b[^}]*\\}\\s+from\\s+['\"]@\\/lib\\/auth['\"]`),
      relative,
    );

    const handlers = Array.from(
      contents.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g),
    );
    assert.ok(handlers.length > 0, relative);
    for (let index = 0; index < handlers.length; index += 1) {
      const start = handlers[index].index!;
      const end = handlers[index + 1]?.index ?? contents.length;
      const handler = contents.slice(start, end);
      const guardIndex = handler.indexOf(`await ${requiredGuard}()`);
      assert.ok(guardIndex >= 0, `${relative}:${handlers[index][1]} lacks ${requiredGuard}`);

      for (const protectedOperation of [
        'request.json(',
        'prisma.',
        'fetch(',
        'collectUpstreamKeys(',
        'collectOneKeyManual(',
        'refreshKeyMetadata(',
      ]) {
        const operationIndex = handler.indexOf(protectedOperation);
        if (operationIndex >= 0) {
          assert.ok(
            guardIndex < operationIndex,
            `${relative}:${handlers[index][1]} guards after ${protectedOperation}`,
          );
        }
      }
    }
  }
});

test('API handler for auth me returns source-specific safe DTOs', () => {
  assert.deepEqual(toMeResponseBody({
    source: 'sub2api',
    userId: 19,
    email: 'owner@example.test',
    username: 'owner',
    csrfToken: 'csrf-value',
  }), {
    ok: true,
    username: 'owner',
    userId: 19,
    source: 'sub2api',
    csrfToken: 'csrf-value',
  });
  assert.deepEqual(toMeResponseBody({
    source: 'local',
    userId: 7,
    username: 'local',
    sessionVersion: 3,
  }), {
    ok: true,
    username: 'local',
    userId: 7,
    source: 'local',
  });
});
