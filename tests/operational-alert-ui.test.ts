import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

function source(path: string): string {
  const file = new URL(path, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('dashboard exposes separate alert and scheduling records destinations', () => {
  const layout = source('src/app/(dashboard)/layout.tsx');
  const legacy = source('src/app/(dashboard)/incidents/page.tsx');

  assert.match(layout, /href: '\/alert-records', label: '告警记录'/);
  assert.match(layout, /href: '\/scheduling-records', label: '调整记录'/);
  assert.doesNotMatch(layout, /href: '\/incidents'/);
  assert.match(legacy, /redirect\('\/alert-records\?type=account'\)/);
});

test('alert records page exposes system and account alert views with query filters', () => {
  const page = source('src/app/(dashboard)/alert-records/page.tsx');
  const view = source('src/components/alert-records/alert-records-view.tsx');

  assert.match(page, /AlertRecordsView/);
  assert.match(view, /value="system"/);
  assert.match(view, /value="account"/);
  assert.doesNotMatch(view, /value="scheduling"/);
  assert.match(view, /\/api\/operational-alert-events/);
  assert.match(view, /\/api\/account-alert-events/);
  assert.match(view, /aria-label="按恢复状态筛选"/);
  assert.match(view, /aria-label="按系统规则筛选"/);
  assert.match(view, /aria-label="按账号 ID 筛选"/);
  assert.match(view, /aria-label="按指标筛选"/);
  assert.match(view, /lastFailedAt/);
  assert.match(view, /failureCount/);
  assert.match(view, /resolvedAt/);
  assert.match(view, /sm:hidden/);
  assert.match(view, /hidden[^\"]*sm:block/);
});

test('scheduling records page is separate and exposes account, action, and result filters', () => {
  const page = source('src/app/(dashboard)/scheduling-records/page.tsx');
  const view = source('src/components/alert-records/alert-records-view.tsx');

  assert.match(page, /SchedulingActions/);
  assert.match(page, /title="调整记录"/);
  assert.match(view, /export function SchedulingActions/);
  assert.match(view, /\/api\/account-scheduling-actions/);
  assert.match(view, /aria-label="按 Sub2API 账号 ID 筛选调度操作"/);
  assert.match(view, /aria-label="按操作类型筛选"/);
  assert.match(view, /aria-label="按操作结果筛选"/);
  assert.match(view, /priorityBefore/);
  assert.match(view, /priorityAfter/);
  assert.match(view, /pausedUntil/);
});

test('settings alert rules include fixed operational rules with severity and enabled controls', () => {
  const settings = source('src/app/(dashboard)/settings/page.tsx');

  assert.match(settings, /function OperationalRulesCard/);
  assert.match(settings, /\/api\/operational-alert-rules/);
  assert.match(settings, /enabled: !rule\.enabled/);
  assert.match(settings, /severity/);
  assert.match(settings, /系统运维规则/);
  assert.match(settings, /只有 CRITICAL 级别的触发与恢复会发送飞书/);
});
