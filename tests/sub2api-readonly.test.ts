import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACCOUNT_PROJECTION_SQL,
  CAPABILITY_PROJECTION_SQL,
  ERROR_PROJECTION_SQL,
  USAGE_PROJECTION_SQL,
  assertSchemaCapabilities,
  buildWindowParams,
} from '../src/lib/account-observability/sub2api-readonly';

test('readonly adapter selects only approved projections and never credential or body columns', () => {
  const sql = `${ACCOUNT_PROJECTION_SQL}\n${USAGE_PROJECTION_SQL}\n${ERROR_PROJECTION_SQL}`;
  assert.match(sql, /account_id/);
  assert.match(USAGE_PROJECTION_SQL, /created_at >= \$1::timestamptz AND created_at < \$2::timestamptz/);
  assert.match(ERROR_PROJECTION_SQL, /created_at >= \$1::timestamptz AND created_at < \$2::timestamptz/);
  assert.match(sql, /duration_ms/);
  assert.match(sql, /first_token_ms/);
  assert.match(sql, /actual_cost/);
  assert.match(ACCOUNT_PROJECTION_SQL, /schedulable/);
  assert.match(ACCOUNT_PROJECTION_SQL, /rate_limit_reset_at/);
  assert.match(ACCOUNT_PROJECTION_SQL, /temp_unschedulable_reason/);
  assert.match(ACCOUNT_PROJECTION_SQL, /group_ids/);
  assert.match(ACCOUNT_PROJECTION_SQL, /g\.status = 'active'/);
  assert.match(ACCOUNT_PROJECTION_SQL, /g\.deleted_at IS NULL/);
  assert.match(ACCOUNT_PROJECTION_SQL, /upstream_billing_probe,received_at/);
  assert.match(ACCOUNT_PROJECTION_SQL, /upstream_billing_probe,fresh_until/);
  assert.match(ACCOUNT_PROJECTION_SQL, /peak_rate_enabled/);
  assert.match(CAPABILITY_PROJECTION_SQL, /information_schema\.columns/);
  assert.match(CAPABILITY_PROJECTION_SQL, /usage_logs/);
  assert.match(CAPABILITY_PROJECTION_SQL, /ops_error_logs/);
  assert.match(CAPABILITY_PROJECTION_SQL, /deleted_at/);
  assert.match(CAPABILITY_PROJECTION_SQL, /account_groups/);
  assert.match(CAPABILITY_PROJECTION_SQL, /table_name = 'groups'/);
  assert.match(CAPABILITY_PROJECTION_SQL, /column_name = ANY\(ARRAY\['account_id','group_id'\]\)/);
  assert.match(CAPABILITY_PROJECTION_SQL, /column_name = ANY\(ARRAY\['id','name','status','deleted_at'\]\)/);
  assert.doesNotMatch(sql, /credentials|api_key|request_body|error_body|prompt/i);
});

test('deployment example declares the separate server-only source database URL', () => {
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^SUB2API_DATABASE_URL=/m);
});

test('readonly adapter binds a UTC window and schema capability failures are explicit', () => {
  const params = buildWindowParams(new Date('2026-07-25T00:00:00.000Z'), new Date('2026-07-25T01:00:00.000Z'));
  assert.deepEqual(params, {
    from: '2026-07-25T00:00:00.000Z',
    to: '2026-07-25T01:00:00.000Z',
  });
  assert.throws(() => assertSchemaCapabilities({ usageLogs: false, opsErrorLogs: true, accounts: true, accountGroups: true, groups: true }), /schema/i);
  assert.throws(() => assertSchemaCapabilities({ usageLogs: true, opsErrorLogs: true, accounts: true, accountGroups: false, groups: true }), /schema/i);
  assert.doesNotThrow(() => assertSchemaCapabilities({ usageLogs: true, opsErrorLogs: true, accounts: true, accountGroups: true, groups: true }));
});
