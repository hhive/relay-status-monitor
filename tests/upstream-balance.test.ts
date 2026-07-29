import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildUpstreamBillingUrl,
  buildUpstreamUsageUrl,
  estimateUpstreamRateMultiplier,
  queryConfiguredUpstreamUsageSnapshot,
  queryUpstreamBalance,
  queryUpstreamRateMultiplier,
  queryUpstreamUsageSnapshot,
  queryNewApiKeyUsedUsd,
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

test('Sub2API usage snapshot exposes only the authenticated key cumulative costs', async () => {
  const snapshot = await queryUpstreamUsageSnapshot(
    { baseUrl: 'https://relay.example', apiKey: 'secret' },
    async () => new Response(JSON.stringify({
      remaining: 8,
      usage: { total: { cost: 2, actual_cost: 3 } },
    }), { status: 200 }),
  );
  assert.deepEqual(snapshot, { balanceUsd: 8, keyUsedUsd: 3, keyStandardUsd: 2 });
});

test('New API key usage converts the authenticated token used quota with instance units', async () => {
  const calls: string[] = [];
  const used = await queryNewApiKeyUsedUsd(
    { baseUrl: 'https://new.example/v1', apiKey: 'sk-key' },
    async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/status')) {
        return new Response(JSON.stringify({ success: true, data: { quota_per_unit: 500000 } }), { status: 200 });
      }
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-key');
      return new Response(JSON.stringify({ success: true, data: { used_quota: 750000 } }), { status: 200 });
    },
  );
  assert.equal(used, 1.5);
  assert.deepEqual(calls, ['https://new.example/api/status', 'https://new.example/api/usage/token/']);
});

test('configured New API mode collects key usage without dashboard wallet credentials', async () => {
  const snapshot = await queryConfiguredUpstreamUsageSnapshot(
    { baseUrl: 'https://new.example', apiKey: 'sk-key', mode: 'newapi' },
    async (input) => String(input).endsWith('/api/status')
      ? new Response(JSON.stringify({ success: true, data: { quota_per_unit: 500000 } }), { status: 200 })
      : new Response(JSON.stringify({ success: true, data: { used_quota: 1000000 } }), { status: 200 }),
  );
  assert.deepEqual(snapshot, { balanceUsd: null, keyUsedUsd: 2, keyStandardUsd: null });
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

test('Sub2API billing adapter reads the API-key effective multiplier and rejects invalid responses', async () => {
  assert.equal(buildUpstreamBillingUrl('https://relay.example/v1'), 'https://relay.example/v1/sub2api/billing');
  assert.equal(buildUpstreamBillingUrl('https://relay.example/'), 'https://relay.example/v1/sub2api/billing');
  let authorization = '';
  assert.equal(await queryUpstreamRateMultiplier(
    { baseUrl: 'https://relay.example', apiKey: 'secret' },
    async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({
        object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token',
        effective_rate_multiplier: 1.75,
      }), { status: 200 });
    },
  ), 1.75);
  assert.equal(authorization, 'Bearer secret');
  for (const body of [
    { effective_rate_multiplier: 2 },
    { object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'request', effective_rate_multiplier: 2 },
    { object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token', effective_rate_multiplier: -1 },
  ]) {
    assert.equal(await queryUpstreamRateMultiplier(
      { baseUrl: 'https://relay.example', apiKey: 'secret' },
      async () => new Response(JSON.stringify(body), { status: 200 }),
    ), null);
  }
});

test('rate estimation uses deltas from the same API key cumulative counters only', () => {
  assert.equal(estimateUpstreamRateMultiplier({ previousKeyUsedUsd: 10, currentKeyUsedUsd: 11.5, baseBilledUsd: 1 }), 1.5);
  assert.equal(estimateUpstreamRateMultiplier({ previousKeyUsedUsd: 10, currentKeyUsedUsd: 10, baseBilledUsd: 1 }), null);
  assert.equal(estimateUpstreamRateMultiplier({ previousKeyUsedUsd: 10, currentKeyUsedUsd: 9, baseBilledUsd: 1 }), null);
  assert.equal(estimateUpstreamRateMultiplier({ previousKeyUsedUsd: 10, currentKeyUsedUsd: 11, baseBilledUsd: 0 }), null);
});

test('balance collection writes balance and direct-or-estimated rate for the previous complete minute', async () => {
  const writes: Array<{ bucketStart: Date; rows: Array<{ accountId: number; balanceUsd: number | null; upstreamKeyUsedUsd: number | null; upstreamKeyStandardUsd: number | null; upstreamRateMultiplier: number | null; upstreamRateSource: string | null }> }> = [];
  const active = [
    { id: 1, sourceAccountId: 'remote-1' },
    { id: 2, sourceAccountId: 'remote-2' },
    { id: 3, sourceAccountId: 'remote-3' },
    { id: 4, sourceAccountId: 'remote-4' },
  ];
  const result = await collectBalanceMinute(new Date('2026-07-29T12:34:45Z'), {
    loadActiveAccounts: async () => active,
    loadCredentials: async () => [
      { sourceAccountId: 'remote-1', baseUrl: 'https://one.example', apiKey: 'one' },
      { sourceAccountId: 'remote-2', baseUrl: 'https://two.example', apiKey: 'two' },
      { sourceAccountId: 'remote-4', baseUrl: 'https://four.example', apiKey: 'four' },
    ],
    probe: async (credential) => {
      if (credential.sourceAccountId === 'remote-1') return { balanceUsd: 4.5, keyUsedUsd: 3, keyStandardUsd: 2 };
      if (credential.sourceAccountId === 'remote-4') return { balanceUsd: 7, keyUsedUsd: 4, keyStandardUsd: null };
      throw new Error('isolated account failure');
    },
    rateProbe: async (credential) => ['remote-1', 'remote-4'].includes(credential.sourceAccountId) ? null : 2,
    estimateRate: async (_accountId, _bucketStart, snapshot) => snapshot.keyUsedUsd === 3 ? 1.25 : snapshot.keyUsedUsd === 4 ? 1.1 : null,
    write: async (bucketStart, rows) => { writes.push({ bucketStart, rows }); },
  });

  assert.deepEqual(result, { attempted: 3, succeeded: 2, unavailable: 2 });
  assert.equal(writes[0].bucketStart.toISOString(), '2026-07-29T12:33:00.000Z');
  assert.deepEqual(writes[0].rows, [
    { accountId: 1, balanceUsd: 4.5, upstreamKeyUsedUsd: 3, upstreamKeyStandardUsd: 2, upstreamRateMultiplier: 1.25, upstreamRateSource: 'estimated' },
    { accountId: 2, balanceUsd: null, upstreamKeyUsedUsd: null, upstreamKeyStandardUsd: null, upstreamRateMultiplier: 2, upstreamRateSource: 'api' },
    { accountId: 3, balanceUsd: null, upstreamKeyUsedUsd: null, upstreamKeyStandardUsd: null, upstreamRateMultiplier: null, upstreamRateSource: null },
    { accountId: 4, balanceUsd: 7, upstreamKeyUsedUsd: 4, upstreamKeyStandardUsd: null, upstreamRateMultiplier: 1.1, upstreamRateSource: 'estimated' },
  ]);
});

test('schema, restricted view, cycle order, and account list expose nullable balance only', () => {
  const schema = source('prisma/schema.prisma');
  const migration = source('prisma/migrations/20260729000000_add_upstream_balance/migration.sql');
  const rateMigration = source('prisma/migrations/20260729160000_add_upstream_rate/migration.sql');
  const view = source('scripts/create-upstream-balance-credential-view.sql');
  const readonly = source('src/lib/account-observability/sub2api-readonly.ts');
  const collector = source('src/lib/account-observability/collector.ts');
  const list = source('src/components/account-observability/account-overview.tsx');

  assert.match(schema, /model AccountMetricMinute[\s\S]*balanceUsd\s+Decimal\?/);
  assert.match(schema, /model AccountMetricSnapshot[\s\S]*balanceUsd\s+Decimal\?/);
  assert.match(schema, /model AccountMetricMinute[\s\S]*upstreamKeyUsedUsd\s+Decimal\?/);
  assert.match(schema, /model AccountMetricMinute[\s\S]*baseBilledUsd\s+Decimal/);
  assert.match(schema, /model AccountMetricMinute[\s\S]*upstreamRateMultiplier\s+Decimal\?/);
  assert.match(schema, /model AccountMetricSnapshot[\s\S]*upstreamRateMultiplier\s+Decimal\?/);
  assert.match(rateMigration, /ADD COLUMN "baseBilledUsd" DECIMAL\(24,6\) NOT NULL DEFAULT 0/);
  assert.match(rateMigration, /ADD COLUMN "upstreamKeyUsedUsd" DECIMAL\(24,6\)/);
  assert.match(rateMigration, /ADD COLUMN "upstreamRateMultiplier" DECIMAL\(20,8\)/);
  assert.doesNotMatch(rateMigration, /DROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE)|CASCADE/i);
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
