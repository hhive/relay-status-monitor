import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  mergeAndSealAlertChannelConfig,
  openAlertChannelConfig,
  sealAlertChannelConfig,
  toSafeAlertChannel,
} from '../src/lib/alert-channel-config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/webhook-token-canary';

process.env.SESSION_SECRET = 'session-secret-for-tests-only-123456789';
process.env.APP_ENCRYPTION_KEY = 'encryption-key-for-tests-only-123456';

function source(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('webhook configuration is sealed as versioned ciphertext and returned write-only', () => {
  const stored = sealAlertChannelConfig({ webhookUrl, secret: 'SEC-canary-signing-secret' });
  assert.deepEqual(Object.keys(stored).sort(), ['ciphertext', 'version']);
  assert.equal(stored.version, 1);
  assert.doesNotMatch(JSON.stringify(stored), /webhook-token-canary|SEC-canary/);

  const opened = openAlertChannelConfig(stored);
  assert.deepEqual(opened.config, { webhookUrl, secret: 'SEC-canary-signing-secret' });
  assert.equal(opened.needsMigration, false);

  const safe = toSafeAlertChannel({
    id: 1,
    name: 'ops',
    type: 'feishu',
    config: stored,
    enabled: true,
    createdAt: new Date('2026-07-23T00:00:00.000Z'),
    updatedAt: new Date('2026-07-23T00:00:00.000Z'),
  });
  assert.equal(safe.webhookConfigured, true);
  assert.equal(safe.secretConfigured, true);
  assert.doesNotMatch(JSON.stringify(safe), /ciphertext|webhook-token-canary|SEC-canary|last4/i);
});

test('legacy plaintext opens once and blank secret updates preserve the existing value', () => {
  const legacy = { webhookUrl, secret: 'SEC-existing-secret' };
  assert.equal(openAlertChannelConfig(legacy).needsMigration, true);

  const updated = mergeAndSealAlertChannelConfig(legacy, {
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/new-token',
    secret: '   ',
  });
  assert.deepEqual(openAlertChannelConfig(updated).config, {
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/new-token',
    secret: 'SEC-existing-secret',
  });
});

test('cron secret is environment-only in API, collector, settings form, and documentation', () => {
  const settingsRoute = source('src/app/api/settings/route.ts');
  assert.match(settingsRoute, /cron_secret_configured/);
  assert.doesNotMatch(settingsRoute, /SettingKeys\.CRON_SECRET|resolveCronSecret/);

  const cronRoute = source('src/app/api/cron/collect/route.ts');
  assert.match(cronRoute, /process\.env\.CRON_SECRET/);
  assert.doesNotMatch(cronRoute, /getCronSecret/);

  const settingsForm = source('src/lib/settings-form.ts');
  assert.doesNotMatch(settingsForm, /includeCronSecret/);
  assert.match(settingsForm, /delete payload\.cron_secret/);

  const settingsPage = source('src/app/(dashboard)/settings/page.tsx');
  assert.doesNotMatch(settingsPage, /buildCronCommand|cronSecretDirty|value=\{cronSecret\}/);
  assert.match(settingsPage, /cron_secret_configured/);

  const readme = source('README.md');
  assert.doesNotMatch(readme, /数据库设置优先于环境变量|设置页保存.*CRON_SECRET/);
});

test('alert channel routes expose only safe DTOs and migration is idempotent by format', () => {
  const listRoute = source('src/app/api/alert-channels/route.ts');
  const itemRoute = source('src/app/api/alert-channels/[id]/route.ts');
  const migration = source('prisma/migrate-alert-channel-config.ts');
  assert.match(listRoute, /toSafeAlertChannel/);
  assert.match(itemRoute, /toSafeAlertChannel/);
  assert.doesNotMatch(listRoute, /NextResponse\.json\(channels\)/);
  assert.match(migration, /version\s*===\s*1/);
  assert.doesNotMatch(migration, /console\.log\([^\n]*(webhook|secret|ciphertext)/i);
});
