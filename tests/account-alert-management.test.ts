import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNT_ALERT_RULE_SPECS,
  ACCOUNT_ALERT_RULE_STORAGE_METRICS,
  AccountAlertValidationError,
  buildAccountAlertEventWhere,
  normalizeGlobalAccountAlertMetric,
  parseAccountAlertRuleUpdate,
  toAccountAlertEventDto,
  toAccountAlertRuleDto,
} from '../src/lib/account-observability/alert-management';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative: string) => readFileSync(path.join(projectRoot, relative), 'utf8');

test('global account alert rules expose exactly seven server-owned identities', () => {
  assert.deepEqual(
    ACCOUNT_ALERT_RULE_SPECS.map(({ metric }) => metric),
    [
      'availability_low',
      'error_rate_high',
      'duration_p95_high',
      'first_token_p95_high',
      'cache_hit_low',
      'unschedulable',
      'sync_stale',
    ],
  );
  assert.equal(new Set(ACCOUNT_ALERT_RULE_SPECS.map(({ name }) => name)).size, 7);
});

test('legacy stored rule metrics normalize to the seven canonical event metrics', () => {
  assert.deepEqual(
    ['availability', 'error_rate', 'duration_p95', 'first_token_p95', 'cache_hit_rate']
      .map(normalizeGlobalAccountAlertMetric),
    ['availability_low', 'error_rate_high', 'duration_p95_high', 'first_token_p95_high', 'cache_hit_low'],
  );
  assert.equal(normalizeGlobalAccountAlertMetric('unschedulable'), 'unschedulable');
  assert.equal(normalizeGlobalAccountAlertMetric('arbitrary'), null);
  assert.deepEqual(new Set(ACCOUNT_ALERT_RULE_STORAGE_METRICS), new Set([
    ...ACCOUNT_ALERT_RULE_SPECS.map(({ metric }) => metric),
    'availability', 'error_rate', 'duration_p95', 'first_token_p95', 'cache_hit_rate',
  ]));
});

test('rule updates use a field allowlist and metric-specific operators', () => {
  assert.deepEqual(
    parseAccountAlertRuleUpdate('availability_low', {
      operator: 'lte', threshold: 0.95, severity: 'WARNING', minRequests: 20,
      cooldownMin: 60, enabled: true,
    }),
    { operator: 'lte', threshold: 0.95, severity: 'WARNING', minRequests: 20, cooldownMin: 60, enabled: true },
  );
  assert.throws(
    () => parseAccountAlertRuleUpdate('availability_low', { metric: 'arbitrary' }),
    AccountAlertValidationError,
  );
  assert.throws(
    () => parseAccountAlertRuleUpdate('availability_low', { operator: 'gt' }),
    AccountAlertValidationError,
  );
  assert.throws(
    () => parseAccountAlertRuleUpdate('unschedulable', { operator: 'gte' }),
    AccountAlertValidationError,
  );
});

test('rule updates enforce ranges, integer samples, and cache-only prompt tokens', () => {
  assert.throws(() => parseAccountAlertRuleUpdate('error_rate_high', { threshold: 1.01 }), AccountAlertValidationError);
  assert.throws(() => parseAccountAlertRuleUpdate('duration_p95_high', { threshold: -1 }), AccountAlertValidationError);
  assert.throws(() => parseAccountAlertRuleUpdate('error_rate_high', { minRequests: 1.5 }), AccountAlertValidationError);
  assert.throws(() => parseAccountAlertRuleUpdate('error_rate_high', { cooldownMin: -1 }), AccountAlertValidationError);
  assert.throws(() => parseAccountAlertRuleUpdate('error_rate_high', { minPromptTokens: 1 }), AccountAlertValidationError);
  assert.throws(() => parseAccountAlertRuleUpdate('sync_stale', { minRequests: 1 }), AccountAlertValidationError);
  assert.deepEqual(
    parseAccountAlertRuleUpdate('cache_hit_low', { minPromptTokens: 0, minRequests: 0, cooldownMin: 0 }),
    { minPromptTokens: 0, minRequests: 0, cooldownMin: 0 },
  );
});

test('safe rule and event DTOs expose no relation internals', () => {
  assert.deepEqual(toAccountAlertRuleDto({
    id: 1, name: '账号错误率高', metric: 'error_rate_high', operator: 'gt', threshold: 0.1,
    severity: 'WARNING', minRequests: 20, minPromptTokens: 0, cooldownMin: 30, enabled: true,
    accountId: null, createdAt: new Date('2026-07-25T00:00:00Z'), updatedAt: new Date('2026-07-25T01:00:00Z'),
  }), {
    id: 1, name: '账号错误率高', metric: 'error_rate_high', operator: 'gt', threshold: 0.1,
    severity: 'WARNING', minRequests: 20, minPromptTokens: 0, cooldownMin: 30, enabled: true,
  });

  assert.equal(toAccountAlertRuleDto({
    id: 2, name: '账号错误率高', metric: 'error_rate', operator: 'gt', threshold: 0.1,
    severity: 'WARNING', minRequests: 20, minPromptTokens: 0, cooldownMin: 30, enabled: true,
  }).metric, 'error_rate_high');

  assert.deepEqual(toAccountAlertEventDto({
    id: 9, accountId: 3, ruleId: 1, metric: 'error_rate_high', severity: 'CRITICAL', metricValue: 0.4,
    message: '错误率过高', resolved: false, resolvedAt: null, createdAt: new Date('2026-07-25T02:00:00Z'),
    notificationDeliveries: { trigger: [1], recovery: [] },
    account: { id: 3, name: 'Account 3', platform: 'anthropic' },
    rule: { id: 1, name: '账号错误率高' },
  }), {
    id: 9, metric: 'error_rate_high', severity: 'CRITICAL', metricValue: 0.4, message: '错误率过高',
    resolved: false, resolvedAt: null, createdAt: new Date('2026-07-25T02:00:00Z'),
    account: { id: 3, name: 'Account 3', platform: 'anthropic' }, rule: { id: 1, name: '账号错误率高' },
  });
});

test('event filters reject unknown values and build an exact Prisma where clause', () => {
  assert.deepEqual(buildAccountAlertEventWhere(new URLSearchParams({
    account: '3', metric: 'cache_hit_low', severity: 'WARNING', resolved: 'false',
  })), {
    accountId: 3, metric: 'cache_hit_low', severity: 'WARNING', resolved: false,
  });
  for (const params of [
    { account: '0' }, { metric: 'arbitrary' }, { severity: 'urgent' }, { resolved: 'yes' },
  ] as Array<Record<string, string>>) {
    assert.throws(() => buildAccountAlertEventWhere(new URLSearchParams(params)), AccountAlertValidationError);
  }
});

test('account alert routes and pages use the new account-only endpoints', () => {
  const ruleList = source('src/app/api/account-alert-rules/route.ts');
  const ruleItem = source('src/app/api/account-alert-rules/[id]/route.ts');
  const eventList = source('src/app/api/account-alert-events/route.ts');
  const eventItem = source('src/app/api/account-alert-events/[id]/route.ts');
  const settings = source('src/app/(dashboard)/settings/page.tsx');
  const incidents = source('src/app/(dashboard)/incidents/page.tsx');

  assert.match(ruleList, /requireApiSession/);
  assert.match(ruleList, /ACCOUNT_ALERT_RULE_STORAGE_METRICS/);
  assert.doesNotMatch(ruleList, /export async function POST/);
  assert.match(ruleItem, /parseAccountAlertRuleUpdate/);
  assert.match(ruleItem, /normalizeGlobalAccountAlertMetric/);
  assert.doesNotMatch(ruleItem, /data:\s*body/);
  assert.match(eventList, /buildAccountAlertEventWhere/);
  assert.match(eventItem, /resolvedAt/);
  assert.match(settings, /\/api\/account-alert-rules/);
  assert.doesNotMatch(settings, /\/api\/alert-rules/);
  assert.match(incidents, /\/api\/account-alert-events/);
  assert.doesNotMatch(incidents, /\/api\/incidents/);
  assert.match(incidents, /href=\{`\/accounts\/\$\{event\.account\.id\}`\}/);
});

test('every alert event resolves to its owning rule configuration', async () => {
  const helperPath = path.join(projectRoot, 'src/lib/account-observability-ui.ts');
  assert.equal(existsSync(helperPath), true, 'alert rule navigation helper is missing');
  if (!existsSync(helperPath)) return;

  const { alertRuleConfigurationHref, parseAlertRuleTarget } = await import('../src/lib/account-observability-ui');
  for (const [index, spec] of ACCOUNT_ALERT_RULE_SPECS.entries()) {
    const ruleId = index + 1;
    assert.equal(alertRuleConfigurationHref({
      metric: spec.metric,
      account: { id: 92 },
      rule: { id: ruleId },
    }), `/settings?rule=${ruleId}#rule-${ruleId}`);
  }
  assert.equal(alertRuleConfigurationHref({
    metric: 'upstream_rate_multiplier',
    account: { id: 92 },
    rule: { id: 88 },
  }), '/accounts/92#billing-alert-rule');

  assert.equal(parseAlertRuleTarget('17'), 17);
  for (const invalid of [null, '', '0', '-1', '01', '1.5', '9007199254740992']) {
    assert.equal(parseAlertRuleTarget(invalid), null);
  }
});

test('event and rule pages expose configuration actions and async navigation targets', () => {
  const incidents = source('src/app/(dashboard)/incidents/page.tsx');
  const settings = source('src/app/(dashboard)/settings/page.tsx');
  const detail = source('src/app/(dashboard)/accounts/[id]/page.tsx');

  assert.match(incidents, /alertRuleConfigurationHref\(event\)/);
  assert.match(incidents, /配置规则/);
  assert.match(settings, /parseAlertRuleTarget/);
  assert.match(settings, /id=\{`rule-\$\{r\.id\}`\}/);
  assert.match(settings, /scrollIntoView/);
  assert.match(detail, /id="billing-alert-rule"/);
  assert.match(detail, /scrollIntoView/);
});
