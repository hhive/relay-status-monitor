import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildUnifiedAlertEventQuery,
  mergeUnifiedAlertEvents,
  toUnifiedAccountAlertEventDto,
  toUnifiedOperationalAlertEventDto,
  UnifiedAlertValidationError,
} from '../src/lib/unified-alert-management';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative: string) => readFileSync(path.join(projectRoot, relative), 'utf8');

test('unified query builds exact source filters with Sub2API account IDs', () => {
  assert.deepEqual(buildUnifiedAlertEventQuery(new URLSearchParams({
    type: 'account', status: 'open', severity: 'CRITICAL', account: '42',
    rule: 'error_rate_high', page: '2', pageSize: '25',
  })), {
    sources: { operational: false, account: true },
    operationalWhere: { resolved: false, severity: 'CRITICAL' },
    accountWhere: {
      resolved: false,
      severity: 'CRITICAL',
      account: { sourceAccountId: '42' },
      metric: 'error_rate_high',
    },
    page: 2,
    pageSize: 25,
    fetchTake: 50,
  });

  assert.deepEqual(buildUnifiedAlertEventQuery(new URLSearchParams({
    type: 'operational', status: 'resolved', rule: 'collection_failed',
  })), {
    sources: { operational: true, account: false },
    operationalWhere: { resolved: true, rule: { key: 'collection_failed' } },
    accountWhere: { resolved: true },
    page: 1,
    pageSize: 50,
    fetchTake: 50,
  });
});

test('unified query returns no sources for empty intersections and rejects unknown filters', () => {
  assert.deepEqual(buildUnifiedAlertEventQuery(new URLSearchParams({ type: 'all', status: 'all' })), {
    sources: { operational: true, account: true },
    operationalWhere: {},
    accountWhere: {},
    page: 1,
    pageSize: 50,
    fetchTake: 50,
  });

  for (const params of [
    { type: 'system' }, { status: 'active' }, { severity: 'urgent' }, { account: '01' },
    { rule: 'unknown' }, { metric: 'unknown' }, { rule: 'collection_failed', metric: 'error_rate_high' },
    { page: '0' }, { pageSize: '101' },
  ] as Array<Record<string, string>>) {
    assert.throws(
      () => buildUnifiedAlertEventQuery(new URLSearchParams(params)),
      UnifiedAlertValidationError,
    );
  }

  for (const params of [
    { type: 'account', rule: 'collection_failed' },
    { type: 'operational', rule: 'error_rate_high' },
    { type: 'operational', account: '42' },
    { account: '42', rule: 'collection_failed' },
  ] as Array<Record<string, string>>) {
    assert.deepEqual(
      buildUnifiedAlertEventQuery(new URLSearchParams(params)).sources,
      { operational: false, account: false },
    );
  }
});

test('unified DTOs expose one stable shape without delivery internals', () => {
  const operational = toUnifiedOperationalAlertEventDto({
    id: 7,
    subjectKey: 'system',
    subjectName: '采集任务',
    detail: 'timeout',
    recoveryDetail: null,
    severity: 'CRITICAL',
    firstTriggeredAt: new Date('2026-08-17T02:00:00Z'),
    lastFailedAt: new Date('2026-08-17T02:05:00Z'),
    failureCount: 2,
    resolved: false,
    resolvedAt: null,
    notificationDeliveries: { trigger: [1] },
    rule: { id: 1, key: 'collection_failed', name: '采集失败' },
  });
  const account = toUnifiedAccountAlertEventDto({
    id: 8,
    metric: 'error_rate_high',
    severity: 'WARNING',
    metricValue: 0.4,
    message: '错误率过高',
    resolved: true,
    resolvedAt: new Date('2026-08-17T02:08:00Z'),
    createdAt: new Date('2026-08-17T02:03:00Z'),
    notificationDeliveries: { recovery: [1] },
    account: { id: 3, sourceAccountId: '42', name: 'Claude 主账号', platform: 'anthropic' },
    rule: { id: 2, name: '账号错误率高' },
  });

  assert.deepEqual(operational, {
    id: 7, type: 'operational', occurredAt: new Date('2026-08-17T02:00:00Z'),
    lastOccurredAt: new Date('2026-08-17T02:05:00Z'),
    severity: 'CRITICAL', resolved: false, resolvedAt: null,
    rule: { id: 1, key: 'collection_failed', name: '采集失败' }, account: null,
    metric: null, metricValue: null, subjectKey: 'system', subjectName: '采集任务',
    detail: 'timeout', recoveryDetail: null, occurrenceCount: 2, canResolve: false,
  });
  assert.deepEqual(account, {
    id: 8, type: 'account', occurredAt: new Date('2026-08-17T02:03:00Z'),
    lastOccurredAt: new Date('2026-08-17T02:03:00Z'),
    severity: 'WARNING', resolved: true, resolvedAt: new Date('2026-08-17T02:08:00Z'),
    rule: { id: 2, key: 'error_rate_high', name: '账号错误率高' },
    account: { id: 3, sourceAccountId: '42', name: 'Claude 主账号', platform: 'anthropic' },
    metric: 'error_rate_high', metricValue: 0.4, subjectKey: '42', subjectName: 'Claude 主账号',
    detail: '错误率过高', recoveryDetail: null, occurrenceCount: 1, canResolve: false,
  });
  assert.equal('notificationDeliveries' in operational, false);
  assert.equal('notificationDeliveries' in account, false);
});

test('merge sorts across sources with stable ties before slicing the requested page', () => {
  const at = new Date('2026-08-17T03:00:00Z');
  const earlier = new Date('2026-08-17T02:00:00Z');
  const make = (type: 'operational' | 'account', id: number, occurredAt: Date) => ({
    id, type, occurredAt, severity: 'CRITICAL' as const, resolved: false, resolvedAt: null,
    lastOccurredAt: occurredAt, rule: { id, key: `rule-${id}`, name: `Rule ${id}` }, account: null,
    metric: null, metricValue: null, subjectKey: `subject-${id}`, subjectName: `Subject ${id}`,
    detail: '', recoveryDetail: null, occurrenceCount: 1, canResolve: false,
  });
  const items = mergeUnifiedAlertEvents(
    [make('operational', 2, earlier), make('operational', 3, at)],
    [make('account', 5, at), make('account', 4, at)],
    2,
    2,
  );
  assert.deepEqual(items.map(({ type, id }) => `${type}:${id}`), ['account:4', 'operational:2']);
});

test('unified API authenticates, queries both sources, and returns accurate pagination metadata', () => {
  const route = source('src/app/api/alert-events/route.ts');
  assert.match(route, /requireApiSession/);
  assert.match(route, /buildUnifiedAlertEventQuery/);
  assert.match(route, /prisma\.operationalAlertEvent\.count/);
  assert.match(route, /prisma\.accountAlertEvent\.count/);
  assert.match(route, /mergeUnifiedAlertEvents/);
  assert.match(route, /sourceAccountId:\s*true/);
  assert.match(route, /pageSize/);
  assert.match(route, /total/);
});
