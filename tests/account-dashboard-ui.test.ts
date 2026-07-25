import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

function source(path: string): string {
  const file = new URL(path, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('metric definitions are centralized and preserve no-data versus zero-cost semantics', async () => {
  const path = new URL('src/lib/account-metric-definitions.ts', root);
  assert.equal(existsSync(path), true, 'account metric definition registry is missing');
  if (!existsSync(path)) return;

  const definitions = await import('../src/lib/account-metric-definitions');
  assert.equal(definitions.formatAccountMetric('availability', null), '暂无数据');
  assert.equal(definitions.formatAccountMetric('userBilledUsd', '0'), '$0.00');
  assert.equal(definitions.formatAccountMetric('durationP95Ms', 1234.6), '1,235 ms');
  assert.match(definitions.ACCOUNT_METRIC_DEFINITIONS.cacheHitRate.formula, /cacheReadTokens/);
  assert.match(definitions.ACCOUNT_METRIC_DEFINITIONS.accountBilledUsd.formula, /rate_multiplier/i);
});

test('root overview and account list use the server-authoritative overview response', () => {
  const dashboard = source('src/app/(dashboard)/page.tsx');
  const accounts = source('src/app/(dashboard)/accounts/page.tsx');
  const shared = source('src/components/account-observability/account-overview.tsx');

  assert.match(dashboard, /AccountOverview/);
  assert.doesNotMatch(dashboard, /\/api\/dashboard|upstreamKeyId/);
  assert.match(accounts, /AccountOverview/);
  assert.match(shared, /\/api\/accounts\/overview\?/);
  assert.match(shared, /useState<AccountWindowKey>\('last24h'\)/);
  assert.match(shared, /useState<AccountStatusFilter>\('schedulable'\)/);
  assert.match(shared, /params\.set\('platform'/);
  assert.match(shared, /params\.set\('group'/);
  assert.match(shared, /params\.set\('search'/);
  assert.match(shared, /sticky top-0/);
  assert.match(shared, /md:hidden/);
});

test('account detail requests each selected window and exposes five trend views plus minute details', () => {
  const detail = source('src/app/(dashboard)/accounts/[id]/page.tsx');
  assert.match(detail, /\/api\/accounts\/\$\{accountId\}\?window=\$\{windowKey\}/);
  assert.doesNotMatch(detail, /data\.trend\.filter/);
  for (const label of ['流量质量', '延迟', '缓存', '计费', '错误分布', '分钟明细']) {
    assert.match(detail, new RegExp(label));
  }
  assert.match(detail, /<details/);
  assert.match(detail, /数据不完整/);
  assert.match(detail, /promptTokens/);
});

test('shared trend and definition tooltip keep gaps and expose keyboard semantics', () => {
  const chart = source('src/components/account-observability/account-trend-chart.tsx');
  const tooltip = source('src/components/account-observability/metric-definition-tooltip.tsx');

  assert.match(chart, /connectNulls=\{false\}/);
  assert.match(chart, /样本/);
  assert.match(chart, /完整性/);
  assert.match(tooltip, /Info/);
  assert.match(tooltip, /aria-describedby/);
  assert.match(tooltip, /event\.key === 'Enter'/);
  assert.match(tooltip, /event\.key === ' '/);
  assert.match(tooltip, /onBlur/);
  assert.doesNotMatch(tooltip, /title=/);
});

test('dashboard navigation contains accounts and no upstream management entry', () => {
  const layout = source('src/app/(dashboard)/layout.tsx');
  assert.match(layout, /href: '\/accounts', label: '账号'/);
  assert.doesNotMatch(layout, /上游管理|href: '\/upstreams'/);
});
