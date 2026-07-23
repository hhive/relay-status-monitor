import { decrypt, encrypt } from './crypto';
import { validateFeishuWebhookUrl } from './outbound';

export interface FeishuAlertChannelConfig {
  webhookUrl: string;
  secret?: string;
}

export interface SealedAlertChannelConfig {
  version: 1;
  ciphertext: string;
}

export interface OpenedAlertChannelConfig {
  config: FeishuAlertChannelConfig;
  needsMigration: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConfig(value: unknown): FeishuAlertChannelConfig {
  if (!isRecord(value) || typeof value.webhookUrl !== 'string') {
    throw new Error('飞书 Webhook 配置无效');
  }
  const webhookUrl = validateFeishuWebhookUrl(value.webhookUrl.trim()).toString();
  const secret = typeof value.secret === 'string' ? value.secret.trim() : '';
  return secret ? { webhookUrl, secret } : { webhookUrl };
}

export function isSealedAlertChannelConfig(value: unknown): value is SealedAlertChannelConfig {
  return isRecord(value) && value.version === 1 && typeof value.ciphertext === 'string';
}

export function sealAlertChannelConfig(value: unknown): SealedAlertChannelConfig {
  const config = normalizeConfig(value);
  return { version: 1, ciphertext: encrypt(JSON.stringify(config)) };
}

/** Open versioned ciphertext; legacy plaintext is accepted only for migration. */
export function openAlertChannelConfig(value: unknown): OpenedAlertChannelConfig {
  if (isSealedAlertChannelConfig(value)) {
    const plaintext = decrypt(value.ciphertext);
    return { config: normalizeConfig(JSON.parse(plaintext)), needsMigration: false };
  }
  return { config: normalizeConfig(value), needsMigration: true };
}

export function mergeAndSealAlertChannelConfig(
  existing: unknown,
  patch: unknown,
): SealedAlertChannelConfig {
  const current = openAlertChannelConfig(existing).config;
  if (!isRecord(patch)) throw new Error('飞书 Webhook 配置无效');
  const webhookUrl = typeof patch.webhookUrl === 'string' && patch.webhookUrl.trim()
    ? patch.webhookUrl
    : current.webhookUrl;
  const nextSecret = typeof patch.secret === 'string' && patch.secret.trim()
    ? patch.secret
    : current.secret;
  return sealAlertChannelConfig({ webhookUrl, secret: nextSecret });
}

export function toSafeAlertChannel<T extends { config: unknown }>(channel: T) {
  const { config, ...safeFields } = channel;
  let webhookConfigured = false;
  let secretConfigured = false;
  try {
    const opened = openAlertChannelConfig(config).config;
    webhookConfigured = Boolean(opened.webhookUrl);
    secretConfigured = Boolean(opened.secret);
  } catch {
    // Invalid legacy/ciphertext config stays write-only and is reported as unconfigured.
  }
  return { ...safeFields, webhookConfigured, secretConfigured };
}
