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

test('account overview and detail expose the approved operational controls and windows', () => {
  const overview = [
    '../src/app/(dashboard)/accounts/page.tsx',
    '../src/components/account-observability/account-overview.tsx',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  const detail = [
    '../src/app/(dashboard)/accounts/[id]/page.tsx',
    '../src/lib/account-metric-definitions.ts',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

  assert.match(overview, /placeholder="搜索账号、平台或分组"/);
  assert.match(overview, /筛选平台/);
  assert.match(overview, /筛选状态/);
  assert.match(overview, /筛选分组/);
  assert.match(overview, /数据同步延迟/);
  assert.match(overview, /accountDataIsStale\(account\)/);
  assert.match(overview, /lastCompleteMinute/);
  assert.match(overview, /durationP95Ms/);
  assert.match(overview, /\/api\/accounts\/overview/);
  assert.match(detail, /北京时间今日/);
  assert.match(detail, /近 1 小时/);
  assert.match(detail, /近 24 小时/);
  assert.match(detail, /平均总延迟/);
  assert.match(detail, /缓存命中/);
  assert.match(detail, /用户计费/);
  assert.match(detail, /账号计费/);
  assert.match(detail, /成功请求/);
  assert.match(detail, /上游责任错误/);
  assert.match(detail, /错误码分布/);
  assert.match(detail, /错误阶段分布/);

  const query = readFileSync(new URL('../src/lib/account-observability/query.ts', import.meta.url), 'utf8');
  assert.match(query, /groupProjection: account\.groupProjection/);
  assert.match(query, /averageDurationMs:/);
  assert.match(query, /errorRate:/);
  assert.match(query, /cacheHitRate:/);
  assert.match(query, /lastCompleteMinute:/);
  assert.match(query, /bucketStart: \{ gte: window\.start, lt: window\.end \}/);
  assert.doesNotMatch(query, /take: 1440/);

  const alertRoute = readFileSync(new URL('../src/app/api/accounts/[id]/billing-alert/route.ts', import.meta.url), 'utf8');
  assert.match(alertRoute, /requireApiSession/);
  assert.match(alertRoute, /upstream_rate_multiplier/);
  assert.match(detail, /倍率告警阈值/);
  assert.match(detail, /保存倍率告警/);
});

test('seed creates traffic defaults but leaves account multiplier alerts opt-in', () => {
  const seed = readFileSync(new URL('../prisma/seed.ts', import.meta.url), 'utf8');
  assert.match(seed, /defaultAccountRules/);
  assert.match(seed, /accountAlertRule\.upsert/);
  assert.doesNotMatch(seed, /defaultAccountRules[\s\S]*upstream_rate_multiplier/);
});

test('seed creates missing defaults without overwriting operator configuration', () => {
  const seed = readFileSync(new URL('../prisma/seed.ts', import.meta.url), 'utf8');
  const ruleUpsert = seed.match(/prisma\.accountAlertRule\.upsert\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? '';
  const settingUpsert = seed.match(/prisma\.setting\.upsert\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? '';
  assert.match(ruleUpsert, /update:\s*\{\s*\}/);
  assert.match(settingUpsert, /update:\s*\{\s*\}/);
});
