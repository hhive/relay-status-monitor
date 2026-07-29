import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildUpstreamUsageUrl,
  queryUpstreamBalance,
} from '../src/lib/account-observability/upstream-balance';
import { collectBalanceMinute } from '../src/lib/account-observability/balance-collector';

const root = new URL('../', import.meta.url);
const source = (path: string) => {
  const file = new URL(path, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

test('Sub2API balance adapter normalizes usage URLs and accepts finite balances', async () => {
  assert.equal(buildUpstreamUsageUrl('https://relay.example/v1'), 'https://relay.example/v1/usage');
  assert.equal(buildUpstreamUsageUrl('https://relay.example/'), 'https://relay.example/v1/usage');

  for (const [body, expected] of [
    [{ remaining: 0 }, 0],
    [{ balance: -0.25 }, -0.25],
    [{ quota: { remaining: '5.125' } }, 5.125],
  ] as const) {
    let redirect: RequestRedirect | undefined;
    const value = await queryUpstreamBalance({ baseUrl: 'https://relay.example/v1', apiKey: 'secret' }, async (_input, init) => {
      redirect = init?.redirect;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(value, expected);
    assert.equal(redirect, 'manual');
  }
});

test('balance adapter maps unsupported, invalid, oversized, and failed responses to null', async () => {
  const responses = [
    new Response('{}', { status: 200 }),
    new Response('{', { status: 200 }),
    new Response('{"remaining":1}', { status: 401 }),
    new Response(JSON.stringify({ remaining: Number.MAX_VALUE }), { status: 200, headers: { 'content-length': '70000' } }),
  ];
  for (const response of responses) {
    assert.equal(await queryUpstreamBalance(
      { baseUrl: 'https://relay.example', apiKey: 'secret' },
      async () => response,
    ), null);
  }
  assert.equal(await queryUpstreamBalance(
    { baseUrl: 'https://relay.example', apiKey: 'secret' },
    async () => { throw new Error('secret https://relay.example'); },
  ), null);
});

test('balance collection writes only the previous complete minute and preserves per-account nulls', async () => {
  const writes: Array<{ bucketStart: Date; rows: Array<{ accountId: number; balanceUsd: number | null }> }> = [];
  const active = [
    { id: 1, sourceAccountId: 'remote-1' },
    { id: 2, sourceAccountId: 'remote-2' },
    { id: 3, sourceAccountId: 'remote-3' },
  ];
  const result = await collectBalanceMinute(new Date('2026-07-29T12:34:45Z'), {
    loadActiveAccounts: async () => active,
    loadCredentials: async () => [
      { sourceAccountId: 'remote-1', baseUrl: 'https://one.example', apiKey: 'one' },
      { sourceAccountId: 'remote-2', baseUrl: 'https://two.example', apiKey: 'two' },
    ],
    probe: async (credential) => {
      if (credential.sourceAccountId === 'remote-1') return 4.5;
      throw new Error('isolated account failure');
    },
    write: async (bucketStart, rows) => { writes.push({ bucketStart, rows }); },
  });

  assert.deepEqual(result, { attempted: 2, succeeded: 1, unavailable: 2 });
  assert.equal(writes[0].bucketStart.toISOString(), '2026-07-29T12:33:00.000Z');
  assert.deepEqual(writes[0].rows, [
    { accountId: 1, balanceUsd: 4.5 },
    { accountId: 2, balanceUsd: null },
    { accountId: 3, balanceUsd: null },
  ]);
});

test('schema, restricted view, cycle order, and account list expose nullable balance only', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source('prisma/migrations/20260729000000_add_upstream_balance/migration.sql');
  const view = source('scripts/create-upstream-balance-credential-view.sql');
  const readonly = source('src/lib/account-observability/sub2api-readonly.ts');
  const collector = source('src/lib/account-observability/collector.ts');
  const list = source('src/components/account-observability/account-overview.tsx');

  assert.match(schema, /model AccountMetricMinute[\s\S]*balanceUsd\s+Decimal\?/);
  assert.match(schema, /model AccountMetricSnapshot[\s\S]*balanceUsd\s+Decimal\?/);
  assert.match(migration, /ADD COLUMN "balanceUsd" DECIMAL\(24,6\)/);
  assert.match(migration, /balance_low/);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE)|CASCADE/i);
  assert.match(view, /security_barrier/i);
  assert.match(view, /REVOKE ALL[\s\S]*PUBLIC/i);
  assert.match(view, /relay_status_monitor_readonly/);
  assert.match(view, /credentials->>'base_url'/);
  assert.match(view, /credentials->>'api_key'/);
  assert.doesNotMatch(readonly.match(/ACCOUNT_PROJECTION_SQL[\s\S]*?`; /)?.[0] ?? '', /credentials|api_key/i);
  assert.match(readonly, /UPSTREAM_BALANCE_CREDENTIAL_PROJECTION_SQL/);
  assert.match(collector, /await metricRunner[\s\S]*await runUpstreamBalanceCollection[\s\S]*await refreshAccountMetricSnapshots[\s\S]*await evaluateAccountAlerts/);
  assert.match(list, /上游余额/);
});
