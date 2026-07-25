import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_PROJECTION_SQL,
  ERROR_PROJECTION_SQL,
  USAGE_PROJECTION_SQL,
  assertSchemaCapabilities,
  buildWindowParams,
} from '../src/lib/account-observability/sub2api-readonly';

test('readonly adapter selects only approved projections and never credential or body columns', () => {
  const sql = `${ACCOUNT_PROJECTION_SQL}\n${USAGE_PROJECTION_SQL}\n${ERROR_PROJECTION_SQL}`;
  assert.match(sql, /account_id/);
  assert.match(sql, /duration_ms/);
  assert.match(sql, /first_token_ms/);
  assert.match(sql, /actual_cost/);
  assert.doesNotMatch(sql, /credentials|api_key|request_body|error_body|prompt/i);
});

test('readonly adapter binds a UTC window and schema capability failures are explicit', () => {
  const params = buildWindowParams(new Date('2026-07-25T00:00:00.000Z'), new Date('2026-07-25T01:00:00.000Z'));
  assert.deepEqual(params, {
    from: '2026-07-25T00:00:00.000Z',
    to: '2026-07-25T01:00:00.000Z',
  });
  assert.throws(() => assertSchemaCapabilities({ usageLogs: false, opsErrorLogs: true, accounts: true }), /schema/i);
  assert.doesNotThrow(() => assertSchemaCapabilities({ usageLogs: true, opsErrorLogs: true, accounts: true }));
});
