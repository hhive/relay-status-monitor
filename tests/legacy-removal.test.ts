import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const legacyPaths = [
  'src/app/(dashboard)/upstreams/page.tsx',
  'src/app/(dashboard)/upstreams/[id]/page.tsx',
  'src/app/api/dashboard/route.ts',
  'src/app/api/metrics/route.ts',
  'src/app/api/alert-rules/route.ts',
  'src/app/api/alert-rules/[id]/route.ts',
  'src/app/api/upstreams/route.ts',
  'src/app/api/upstreams/[id]/route.ts',
  'src/app/api/upstreams/[id]/test/route.ts',
  'src/app/api/upstreams/[id]/refresh/route.ts',
  'src/app/api/upstreams/[id]/models/route.ts',
  'src/app/api/upstreams/[id]/keys/route.ts',
  'src/app/api/upstreams/[id]/keys/[keyId]/route.ts',
  'src/app/api/keys/[keyId]/test/route.ts',
  'src/app/api/keys/[keyId]/metadata/route.ts',
  'src/lib/adapters/base.ts',
  'src/lib/adapters/newapi.ts',
  'src/lib/adapters/sub2api.ts',
  'src/lib/adapters/registry.ts',
  'src/lib/collector.ts',
  'src/lib/alerts/engine.ts',
  'src/lib/key-metadata-service.ts',
  'src/lib/key-metadata.ts',
  'src/lib/key-display.ts',
  'src/lib/key-input.ts',
  'src/lib/upstream-query.ts',
  'src/lib/collection-result.ts',
  'src/lib/demo-data.ts',
  'src/components/upstreams-columns.tsx',
  'src/components/upstreams-data-table.tsx',
  'src/components/Sparkline.tsx',
  'prisma/seed-demo.ts',
] as const;

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('legacy upstream pages, APIs, probes, and dead helpers are absent', () => {
  for (const relativePath of legacyPaths) {
    assert.equal(existsSync(path.join(projectRoot, relativePath)), false, relativePath);
  }
});

test('cron collection runs only account observability', () => {
  const cronRoute = source('src/app/api/cron/collect/route.ts');
  assert.match(cronRoute, /runAccountObservabilityCycle/);
  assert.doesNotMatch(cronRoute, /runCollectCycle|@\/lib\/collector|collected:\s*result|mode:\s*result/);
});

test('Prisma schema retains account and shared models but removes exact legacy models and enums', () => {
  const schema = source('prisma/schema.prisma');
  for (const model of ['Upstream', 'UpstreamKey', 'Metric', 'Incident', 'AlertRule']) {
    assert.doesNotMatch(schema, new RegExp(`\\bmodel\\s+${model}\\b`), model);
  }
  for (const enumName of ['UpstreamType', 'UpstreamStatus', 'IncidentType']) {
    assert.doesNotMatch(schema, new RegExp(`\\benum\\s+${enumName}\\b`), enumName);
  }
  for (const retained of [
    'Severity', 'Sub2ApiAccount', 'AccountMetricMinute', 'AccountSyncRun',
    'AccountAlertRule', 'AccountAlertEvent', 'AlertChannel', 'Setting', 'User',
  ]) {
    assert.match(schema, new RegExp(`\\b(?:enum|model)\\s+${retained}\\b`), retained);
  }
  assert.match(schema, /model AccountAlertEvent[\s\S]*notificationDeliveries\s+Json\?/);
});

test('destructive migration drops exactly the five approved legacy tables', () => {
  const migration = source('prisma/migrations/20260725000000_remove_legacy_upstream/migration.sql');
  const dropped = Array.from(migration.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?"([^"]+)"/gi), (match) => match[1]).sort();
  assert.deepEqual(dropped, ['AlertRule', 'Incident', 'Metric', 'Upstream', 'UpstreamKey'].sort());
  assert.equal(new Set(dropped).size, 5);
  assert.doesNotMatch(migration, /DROP\s+(?:SCHEMA|DATABASE)|CASCADE/i);
  assert.equal(migration.match(/^BEGIN;$/gim)?.length, 1);
  assert.equal(migration.match(/^COMMIT;$/gim)?.length, 1);
  assert.ok(migration.indexOf('BEGIN;') < migration.indexOf('DROP TABLE'));
  assert.ok(migration.lastIndexOf('COMMIT;') > migration.lastIndexOf('DROP TABLE'));
});

test('demo seed, demo password, and legacy table dependency are removed', () => {
  const packageJson = JSON.parse(source('package.json')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };
  assert.equal(packageJson.scripts['db:seed:demo'], undefined);
  assert.equal(packageJson.dependencies['@tanstack/react-table'], undefined);
  assert.doesNotMatch(source('.env.example'), /^DEMO_ADMIN_PASSWORD=/m);
  assert.doesNotMatch(source('prisma/seed.ts'), /prisma\.alertRule|demo-data/);
});

test('shared Feishu notifications no longer depend on legacy upstream Prisma types', () => {
  const feishu = source('src/lib/alerts/channels/feishu.ts');
  assert.match(feishu, /sendAccountNotification/);
  assert.doesNotMatch(feishu, /\b(?:Upstream|UpstreamKey|IncidentLike|sendNotification|sendFeishu)\b/);
});
