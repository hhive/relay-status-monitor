import { prisma } from './db';
import { parseAlertBehaviorSettings } from './account-observability/alert-behavior';

/**
 * 系统设置读写（Setting 表的封装）
 * 带内存缓存，避免频繁查库
 */

const cache = new Map<string, string>();

/** 获取设置值，不存在则返回默认值 */
export async function getSetting(key: string, defaultValue: string = ''): Promise<string> {
  if (cache.has(key)) {
    return cache.get(key)!;
  }
  const row = await prisma.setting.findUnique({ where: { key } });
  const value = row?.value ?? defaultValue;
  cache.set(key, value);
  return value;
}

/** 获取数值型设置 */
export async function getSettingNumber(key: string, defaultValue: number): Promise<number> {
  const v = await getSetting(key, String(defaultValue));
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

/** 设置值，更新缓存 */
export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  cache.set(key, value);
}

/** 清除缓存（设置更新后调用） */
export function clearSettingsCache(): void {
  cache.clear();
}

/** 系统设置的常用键 */
export const SettingKeys = {
  LIGHT_INTERVAL_MIN: 'light_interval_minutes', // 轻量采集间隔（分钟）
  HEAVY_INTERVAL_MIN: 'heavy_interval_minutes', // 重量采集间隔（分钟）
  TEST_MODEL: 'test_model',                     // 测速模型
  TEST_TIMEOUT_MS: 'test_timeout_ms',           // 测试超时
  RETENTION_DAYS: 'retention_days',             // 数据保留天数
  TIMEZONE: 'timezone',
  ALERT_CONFIRMATION_WINDOW_MIN: 'alert_confirmation_window_minutes',
  ALERT_CONFIRMATION_COUNT: 'alert_confirmation_count',
  ALERT_PRIORITY_FACTOR: 'alert_priority_factor',
  ALERT_PRIORITY_CAP_PAUSE_ENABLED: 'alert_priority_cap_pause_enabled',
  ALERT_PRIORITY_CAP_PAUSE_DURATION_MIN: 'alert_priority_cap_pause_duration_minutes',
  ALERT_PRIORITY_CAP_PAUSE_COOLDOWN_MIN: 'alert_priority_cap_pause_cooldown_minutes',
  BACKUP_ENABLED: 'remote_backup_enabled',
  BACKUP_HOST: 'remote_backup_host',
  BACKUP_PORT: 'remote_backup_port',
  BACKUP_USERNAME: 'remote_backup_username',
  BACKUP_PASSWORD: 'remote_backup_password',
  BACKUP_PATH: 'remote_backup_path',
  BACKUP_TIME: 'remote_backup_time',
  BACKUP_RETENTION: 'remote_backup_retention',
  BACKUP_LAST_STATUS: 'remote_backup_last_status',
  BACKUP_LAST_AT: 'remote_backup_last_at',
  BACKUP_LAST_FILE: 'remote_backup_last_file',
  BACKUP_LAST_ERROR: 'remote_backup_last_error',
} as const;

export type EditableSettingKey = typeof SettingKeys[keyof typeof SettingKeys];

export const EDITABLE_SETTING_KEYS: readonly EditableSettingKey[] = Object.freeze(
  Object.values(SettingKeys).filter((key) => key !== SettingKeys.BACKUP_PASSWORD),
);

const editableSettingKeySet = new Set<string>(EDITABLE_SETTING_KEYS);

export function isEditableSettingKey(key: string): key is EditableSettingKey {
  return editableSettingKeySet.has(key);
}

export class InvalidEditableSettingValueError extends Error {}

export function validateEditableSettingValue(key: EditableSettingKey, value: unknown): string {
  const text = String(value);
  try {
    if (key === SettingKeys.ALERT_CONFIRMATION_WINDOW_MIN) {
      parseAlertBehaviorSettings({ alert_confirmation_window_minutes: text });
    } else if (key === SettingKeys.ALERT_CONFIRMATION_COUNT) {
      parseAlertBehaviorSettings({ alert_confirmation_count: text });
    } else if (key === SettingKeys.ALERT_PRIORITY_FACTOR) {
      parseAlertBehaviorSettings({ alert_priority_factor: text });
    } else if (key === SettingKeys.ALERT_PRIORITY_CAP_PAUSE_ENABLED) {
      parseAlertBehaviorSettings({ alert_priority_cap_pause_enabled: text });
    } else if (key === SettingKeys.ALERT_PRIORITY_CAP_PAUSE_DURATION_MIN) {
      parseAlertBehaviorSettings({ alert_priority_cap_pause_duration_minutes: text });
    } else if (key === SettingKeys.ALERT_PRIORITY_CAP_PAUSE_COOLDOWN_MIN) {
      parseAlertBehaviorSettings({ alert_priority_cap_pause_cooldown_minutes: text });
    } else if (key === SettingKeys.BACKUP_ENABLED) {
      if (text !== 'true' && text !== 'false') throw new Error();
    } else if (key === SettingKeys.BACKUP_PORT) {
      const n = Number(text); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error();
    } else if (key === SettingKeys.BACKUP_RETENTION) {
      const n = Number(text); if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error();
    } else if (key === SettingKeys.BACKUP_TIME) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error();
    } else if (key === SettingKeys.BACKUP_HOST || key === SettingKeys.BACKUP_USERNAME || key === SettingKeys.BACKUP_PATH) {
      if (!text.trim() || text.length > 512 || /[\r\n]/.test(text)) throw new Error();
    }
  } catch {
    throw new InvalidEditableSettingValueError();
  }
  return text;
}

/** 获取采集相关配置的聚合方法 */
export async function getCollectConfig() {
  const [lightMin, heavyMin, testModel, timeoutMs, retentionDays] = await Promise.all([
    getSettingNumber(SettingKeys.LIGHT_INTERVAL_MIN, 1),
    getSettingNumber(SettingKeys.HEAVY_INTERVAL_MIN, 15),
    getSetting(SettingKeys.TEST_MODEL, 'gpt-4o-mini'),
    getSettingNumber(SettingKeys.TEST_TIMEOUT_MS, 15000),
    getSettingNumber(SettingKeys.RETENTION_DAYS, 90),
  ]);
  return { lightMin, heavyMin, testModel, timeoutMs, retentionDays };
}
