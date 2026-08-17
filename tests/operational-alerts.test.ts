import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OPERATIONAL_ALERT_RULE_SPECS,
  OperationalAlertValidationError,
  buildAccountSchedulingActionQuery,
  buildOperationalAlertEventQuery,
  parseOperationalAlertRuleUpdate,
  toAccountSchedulingActionDto,
  toOperationalAlertEventDto,
} from '../src/lib/operational-alert-management';
import {
  createOperationalAlertReporter,
  type OperationalAlertEventRecord,
  type OperationalAlertReporterDependencies,
  type OperationalAlertRuleRecord,
} from '../src/lib/operational-alerts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative: string) => readFileSync(path.join(projectRoot, relative), 'utf8');

test('the four operational rules have stable critical defaults', () => {
  assert.deepEqual(OPERATIONAL_ALERT_RULE_SPECS.map(({ key }) => key), [
    'collection_failed',
    'priority_adjustment_failed',
    'priority_cap_pause_failed',
    'remote_backup_failed',
  ]);
  assert.ok(OPERATIONAL_ALERT_RULE_SPECS.every((rule) => rule.enabled && rule.severity === 'CRITICAL'));
});

test('operational rule updates only accept enabled and severity', () => {
  assert.deepEqual(parseOperationalAlertRuleUpdate({ enabled: false, severity: 'WARNING' }), {
    enabled: false,
    severity: 'WARNING',
  });
  for (const body of [{}, { key: 'changed' }, { severity: 'urgent' }, { enabled: 1 }, null]) {
    assert.throws(() => parseOperationalAlertRuleUpdate(body), OperationalAlertValidationError);
  }
});

test('event query validates filters and bounded pagination', () => {
  assert.deepEqual(buildOperationalAlertEventQuery(new URLSearchParams({
    status: 'open', rule: 'priority_adjustment_failed', severity: 'CRITICAL', page: '2', pageSize: '25',
  })), {
    where: { resolved: false, severity: 'CRITICAL', rule: { key: 'priority_adjustment_failed' } },
    skip: 25,
    take: 25,
    page: 2,
    pageSize: 25,
  });
  for (const query of [
    { status: 'active' }, { rule: 'unknown' }, { severity: 'urgent' },
    { page: '0' }, { page: '01' }, { pageSize: '101' },
  ] as Array<Record<string, string>>) {
    assert.throws(
      () => buildOperationalAlertEventQuery(new URLSearchParams(query)),
      OperationalAlertValidationError,
    );
  }
});

test('scheduling action query validates exact enums and account pagination', () => {
  assert.deepEqual(buildAccountSchedulingActionQuery(new URLSearchParams({
    account: '9', actionType: 'PRIORITY_RESTORE', result: 'SUCCESS', page: '3', pageSize: '20',
  })), {
    where: { sourceAccountId: '9', actionType: 'PRIORITY_RESTORE', result: 'SUCCESS' },
    skip: 40,
    take: 20,
    page: 3,
    pageSize: 20,
  });
  for (const query of [
    { account: '0' }, { actionType: 'DELETE' }, { result: 'UNKNOWN' }, { pageSize: '0' },
  ] as Array<Record<string, string>>) {
    assert.throws(
      () => buildAccountSchedulingActionQuery(new URLSearchParams(query)),
      OperationalAlertValidationError,
    );
  }
});

test('scheduling action DTO prefers the current account name and falls back to its audit snapshot', () => {
  const record = {
    id: 7,
    accountId: 3,
    sourceAccountId: '19',
    accountName: 'Sub2API #19',
    actionType: 'PRIORITY_ADJUST' as const,
    result: 'SUCCESS' as const,
    priorityBefore: 10,
    priorityAfter: 20,
    factor: 2,
    conflictRecomputed: false,
    pausedUntil: null,
    reasonCode: null,
    errorCode: null,
    occurredAt: new Date('2026-08-17T01:00:00Z'),
  };

  assert.equal(toAccountSchedulingActionDto({ ...record, account: { name: '生产 Claude 账号' } }).accountName, '生产 Claude 账号');
  assert.equal(toAccountSchedulingActionDto({ ...record, account: null }).accountName, 'Sub2API #19');
});

function harness(input: {
  enabled?: boolean;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  notify?: (
    recovery: boolean,
    delivered: readonly number[],
    onDelivered: (channelId: number) => Promise<void>,
  ) => Promise<void>;
} = {}) {
  const rule: OperationalAlertRuleRecord = {
    id: 1,
    key: 'collection_failed',
    name: '采集失败',
    description: '完整采集周期执行失败',
    enabled: input.enabled ?? true,
    severity: input.severity ?? 'CRITICAL',
  };
  let event: OperationalAlertEventRecord | null = null;
  const notifications: Array<{ recovery: boolean; delivered: readonly number[] }> = [];
  const dependencies: OperationalAlertReporterDependencies = {
    findRule: async () => rule,
    recordFailure: async ({ subjectKey, subjectName, detail, now }) => {
      if (event && !event.resolved) {
        event = { ...event, subjectName, detail, lastFailedAt: now, failureCount: event.failureCount + 1 };
        return { event, created: false };
      }
      event = {
        id: 10,
        ruleId: rule.id,
        subjectKey,
        subjectName,
        detail,
        severity: rule.severity,
        firstTriggeredAt: now,
        lastFailedAt: now,
        failureCount: 1,
        resolved: false,
        resolvedAt: null,
        notificationDeliveries: { trigger: [], recovery: [] },
      };
      return { event, created: true };
    },
    findOpenEvent: async () => event && !event.resolved ? event : null,
    resolveEvent: async (_id, now) => {
      assert.ok(event);
      event = { ...event, resolved: true, resolvedAt: now };
      return event;
    },
    updateNotificationDeliveries: async (_id, deliveries) => {
      assert.ok(event);
      event = { ...event, notificationDeliveries: deliveries };
    },
    notify: async (_event, _rule, recovery, delivered, onDelivered) => {
      notifications.push({ recovery, delivered });
      if (input.notify) await input.notify(recovery, delivered, onDelivered);
      else await onDelivered(recovery ? 2 : 1);
    },
  };
  return { report: createOperationalAlertReporter(dependencies), current: () => event, notifications };
}

test('same rule and subject deduplicates failures and recovers once', async () => {
  const run = harness();
  const first = await run.report.failure({
    ruleKey: 'collection_failed',
    subjectKey: 'system',
    subjectName: '采集任务',
    detail: 'Authorization: Bearer secret-canary',
    now: new Date('2026-08-17T01:00:00Z'),
  });
  assert.equal(first?.created, true);
  assert.equal(first?.event.failureCount, 1);
  assert.doesNotMatch(first?.event.detail ?? '', /secret-canary/);

  const repeated = await run.report.failure({
    ruleKey: 'collection_failed', subjectKey: 'system', subjectName: '采集任务', detail: 'second failure',
    now: new Date('2026-08-17T01:01:00Z'),
  });
  assert.equal(repeated?.created, false);
  assert.equal(repeated?.event.failureCount, 2);
  assert.deepEqual(run.notifications, [
    { recovery: false, delivered: [] },
    { recovery: false, delivered: [1] },
  ]);

  const recovered = await run.report.success({
    ruleKey: 'collection_failed', subjectKey: 'system', now: new Date('2026-08-17T01:02:00Z'),
  });
  assert.equal(recovered?.resolved, true);
  assert.deepEqual(run.notifications.at(-1), { recovery: true, delivered: [] });
  assert.equal(await run.report.success({ ruleKey: 'collection_failed', subjectKey: 'system' }), null);
});

test('disabled rules and non-critical rules never call notification channels', async () => {
  const disabled = harness({ enabled: false });
  assert.equal(await disabled.report.failure({
    ruleKey: 'collection_failed', subjectKey: 'system', subjectName: '采集任务', detail: 'failed',
  }), null);
  assert.equal(disabled.current(), null);

  const warning = harness({ severity: 'WARNING' });
  await warning.report.failure({
    ruleKey: 'collection_failed', subjectKey: 'system', subjectName: '采集任务', detail: 'failed',
  });
  await warning.report.success({ ruleKey: 'collection_failed', subjectKey: 'system' });
  assert.deepEqual(warning.notifications, []);
});

test('a failed recovery notification stays open and retries only unfinished channels', async () => {
  let recoveryAttempts = 0;
  const run = harness({
    notify: async (recovery, delivered, onDelivered) => {
      if (!recovery) return onDelivered(1);
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) {
        await onDelivered(2);
        throw new Error('one channel failed');
      }
      assert.deepEqual(delivered, [2]);
      await onDelivered(3);
    },
  });
  await run.report.failure({
    ruleKey: 'collection_failed', subjectKey: 'system', subjectName: '采集任务', detail: 'failed',
  });
  await assert.rejects(() => run.report.success({ ruleKey: 'collection_failed', subjectKey: 'system' }));
  assert.equal(run.current()?.resolved, false);

  const recovered = await run.report.success({ ruleKey: 'collection_failed', subjectKey: 'system' });
  assert.equal(recovered?.resolved, true);
  assert.deepEqual(run.current()?.notificationDeliveries, { trigger: [1], recovery: [2, 3] });
});

test('safe event DTO omits notification delivery internals', () => {
  const dto = toOperationalAlertEventDto({
    id: 4,
    subjectKey: 'system',
    subjectName: '采集任务',
    detail: 'safe summary',
    severity: 'CRITICAL',
    firstTriggeredAt: new Date('2026-08-17T01:00:00Z'),
    lastFailedAt: new Date('2026-08-17T01:01:00Z'),
    failureCount: 2,
    resolved: true,
    resolvedAt: new Date('2026-08-17T01:02:00Z'),
    notificationDeliveries: { trigger: [1], recovery: [1] },
    rule: { id: 1, key: 'collection_failed', name: '采集失败' },
  });
  assert.equal('notificationDeliveries' in dto, false);
  assert.equal(dto.failureCount, 2);
});

test('schema, migration, APIs and notification channel expose the operational contracts', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source('prisma/migrations/20260817120000_add_operational_alerts/migration.sql');
  assert.match(schema, /model OperationalAlertRule/);
  assert.match(schema, /model OperationalAlertEvent/);
  assert.match(schema, /model AccountSchedulingActionRecord/);
  assert.match(migration, /collection_failed/);
  assert.match(migration, /priority_adjustment_failed/);
  assert.match(migration, /priority_cap_pause_failed/);
  assert.match(migration, /remote_backup_failed/);
  assert.match(migration, /CREATE UNIQUE INDEX[\s\S]*WHERE "resolved" = false/i);

  const rules = source('src/app/api/operational-alert-rules/route.ts');
  const rule = source('src/app/api/operational-alert-rules/[id]/route.ts');
  const events = source('src/app/api/operational-alert-events/route.ts');
  const actions = source('src/app/api/account-scheduling-actions/route.ts');
  assert.match(rules, /requireApiSession/);
  assert.match(rule, /parseOperationalAlertRuleUpdate/);
  assert.match(events, /buildOperationalAlertEventQuery/);
  assert.match(events, /orderBy:\s*\[\{ lastFailedAt: 'desc' \}/);
  assert.match(actions, /buildAccountSchedulingActionQuery/);
  assert.match(actions, /requireApiSession/);
  assert.match(actions, /account:\s*\{\s*select:\s*\{\s*name:\s*true/);

  const feishu = source('src/lib/alerts/channels/feishu.ts');
  assert.match(feishu, /sendOperationalNotification/);
  assert.match(feishu, /severity\s*!==\s*'CRITICAL'/);
});
