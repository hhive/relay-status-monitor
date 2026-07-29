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
  assert.equal(definitions.formatAccountMetric('balanceUsd', '-0.25'), '$-0.25');
  assert.equal(definitions.formatAccountMetric('balanceUsd', null), '暂无数据');
  assert.equal(definitions.formatAccountMetric('durationP95Ms', 1234.6), '1,235 ms');
  assert.match(definitions.ACCOUNT_METRIC_DEFINITIONS.cacheHitRate.formula, /cacheReadTokens/);
  assert.match(definitions.ACCOUNT_METRIC_DEFINITIONS.accountBilledUsd.formula, /rate_multiplier/i);
});

test('root overview and account list split server-authoritative overview and list responses', () => {
  const dashboard = source('src/app/(dashboard)/page.tsx');
  const accounts = source('src/app/(dashboard)/accounts/page.tsx');
  const shared = source('src/components/account-observability/account-overview.tsx');

  assert.match(dashboard, /AccountOverview/);
  assert.doesNotMatch(dashboard, /\/api\/dashboard|upstreamKeyId/);
  assert.match(accounts, /AccountOverview/);
  assert.match(shared, /\/api\/accounts\/overview\?/);
  assert.match(shared, /\/api\/accounts\/list\?/);
  assert.match(shared, /useState<AccountWindowKey>\('last1h'\)/);
  assert.match(shared, /useState<AccountStatusFilter>\('schedulable'\)/);
  assert.match(shared, /params\.set\('platform'/);
  assert.match(shared, /params\.set\('groupId'/);
  assert.match(shared, /params\.set\('search'/);
  assert.match(shared, /sticky top-0/);
  assert.match(shared, /md:hidden/);
  assert.match(shared, /const SUMMARY_METRICS[^\n]*'firstTokenP95Ms'/);
  assert.match(shared, /const TREND_VIEWS[\s\S]*?'firstTokenP95Ms'/);
  assert.match(shared, /const ACCOUNT_LIST_METRICS[^\n]*'firstTokenP95Ms'/);

  const tableRow = shared.match(/function AccountTableRow[\s\S]*?\n\}/)?.[0] ?? '';
  const mobileRow = shared.match(/function AccountMobileRow[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(tableRow, /ACCOUNT_LIST_METRICS\.map/);
  assert.match(mobileRow, /ACCOUNT_LIST_METRICS\.filter\(\(key\) => key !== 'eligibleCount'\)\.map/);
});

test('account filters restore reusable preferences and render exact bound-group options', () => {
  const shared = source('src/components/account-observability/account-overview.tsx');

  assert.match(shared, /readAccountFilterPreferencesSafely\(\(\) => window\.localStorage\)/);
  assert.match(shared, /const \[filtersReady, setFiltersReady\] = useState\(false\)/);
  assert.match(shared, /if \(!filtersReady/);
  assert.match(shared, /writeAccountFilterPreferencesSafely\(\(\) => window\.localStorage/);
  assert.match(shared, /groupId: number \| null/);
  assert.match(shared, /aria-label="筛选分组"/);
  assert.match(shared, /全部分组/);
  assert.match(shared, /facets\.groups/);
  assert.match(shared, /group\.id/);
  assert.match(shared, /group\.name/);
  assert.match(shared, /setPlatform\(''\)/);
  assert.match(shared, /setGroupId\(null\)/);
  assert.doesNotMatch(shared, /<Input value=\{group/);
});

test('account list and detail expose a per-account alert master switch', () => {
  const shared = source('src/components/account-observability/account-overview.tsx');
  assert.match(shared, /alert-enabled/);
  assert.match(shared, /Switch/);
  assert.match(shared, /account\.alertEnabled/);
  assert.match(shared, /告警/);
  assert.match(shared, /result === 'saved'[\s\S]*?fetchList\(\)/, 'a successful toggle must refresh the current server page');

  const detail = source('src/app/(dashboard)/accounts/[id]/page.tsx');
  assert.match(detail, /masterAlertEnabled/);
  assert.match(detail, /\/api\/accounts\/\$\{accountId\}\/alert-enabled/);
  assert.match(detail, /告警总开关/);
  assert.match(detail, /result === 'saved'[\s\S]*?fetchDetail\(\)/, 'a successful toggle must supersede stale detail requests');
});

test('account list exposes persisted sorting on desktop and mobile', async () => {
  const sort = await import('../src/lib/account-list-sort');
  const shared = source('src/components/account-observability/account-overview.tsx');
  const tooltip = source('src/components/account-observability/metric-definition-tooltip.tsx');

  assert.equal(sort.ACCOUNT_SORT_KEYS.length, 14);
  assert.match(shared, /readAccountSortStateSafely\(\(\) => window\.localStorage\)/);
  assert.match(shared, /setSortState\(next\);[\s\S]*?writeAccountSortStateSafely\(\(\) => window\.localStorage, next\)/);
  assert.doesNotMatch(shared, /sortAccountSummaries/);
  assert.match(shared, /sortKey: sortState\.key/);
  assert.match(shared, /sortOrder: sortState\.order/);
  assert.match(shared, /aria-sort=/);
  assert.match(shared, /ArrowUpDown/);
  assert.match(shared, /ArrowUp/);
  assert.match(shared, /ArrowDown/);
  assert.match(shared, /aria-label="选择账号排序字段"/);
  assert.match(shared, /ACCOUNT_SORT_KEYS\.map/);
  assert.match(shared, /grid-cols-\[minmax\(0,1fr\)_2\.5rem\]/);
  assert.match(shared, /className="size-10"/);
  assert.match(tooltip, /iconOnly\??:/);
  for (const key of sort.ACCOUNT_SORT_KEYS) assert.match(shared, new RegExp(`sortKey=['"]${key}['"]`));
});

test('account detail requests each selected window and exposes five trend views plus minute details', () => {
  const detail = source('src/app/(dashboard)/accounts/[id]/page.tsx');
  assert.match(detail, /useState<AccountWindowKey>\('last1h'\)/);
  assert.match(detail, /\/api\/accounts\/\$\{accountId\}\?window=\$\{windowKey\}/);
  assert.doesNotMatch(detail, /data\.trend\.filter/);
  for (const label of ['流量质量', '延迟', '缓存', '计费', '错误分布', '分钟明细']) {
    assert.match(detail, new RegExp(label));
  }
  assert.match(detail, /<details/);
  assert.match(detail, /数据不完整/);
  assert.match(detail, /promptTokens/);
});

test('notification channel save reports API failures and successful creation', () => {
  const settings = source('src/app/(dashboard)/settings/page.tsx');
  const handleAdd = settings.match(/async function handleAdd\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

  assert.match(handleAdd, /if \(!response\.ok\)/);
  assert.match(handleAdd, /toast\.error/);
  assert.match(handleAdd, /toast\.success/);
  assert.match(handleAdd, /setDialogOpen\(false\)/);
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

test('root layout provides the global tooltip context used by dashboard metrics', () => {
  const layout = source('src/app/layout.tsx');

  assert.match(layout, /TooltipProvider/);
  assert.match(layout, /<TooltipProvider[^>]*>\s*\{children\}/);
});

test('dashboard navigation contains accounts and no upstream management entry', () => {
  const layout = source('src/app/(dashboard)/layout.tsx');
  assert.match(layout, /href: '\/accounts', label: '账号'/);
  assert.doesNotMatch(layout, /上游管理|href: '\/upstreams'/);
});
