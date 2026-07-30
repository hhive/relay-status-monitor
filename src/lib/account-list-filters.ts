import {
  ACCOUNT_PAGE_SIZES,
  type AccountPageSize,
  type AccountStatusFilter,
  type AccountWindowKey,
} from '@/lib/account-observability-ui';

export interface AccountFilterPreferences {
  windowKey: AccountWindowKey;
  status: AccountStatusFilter;
  platform: string;
  groupId: number | null;
  alertGroupsOnly: boolean;
  pageSize: AccountPageSize;
}

export interface AccountFilterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const ACCOUNT_FILTER_STORAGE_KEY = 'relay-status-monitor:account-list-filters:v1';
export const DEFAULT_ACCOUNT_FILTER_PREFERENCES: AccountFilterPreferences = {
  windowKey: 'last1h',
  status: 'schedulable',
  platform: '',
  groupId: null,
  alertGroupsOnly: true,
  pageSize: 50,
};

interface AccountFilterFacets {
  platforms: string[];
  groups: Array<{ id: number; name: string }>;
}

const windows = new Set<AccountWindowKey>(['today', 'last1h', 'last24h']);
const statuses = new Set<AccountStatusFilter>(['schedulable', 'all', 'unschedulable']);

function isPreferences(value: unknown): value is AccountFilterPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const validPlatform = typeof candidate.platform === 'string'
    && candidate.platform.length <= 100
    && !/[\u0000-\u001f\u007f]/.test(candidate.platform);
  const validGroup = candidate.groupId === null
    || (typeof candidate.groupId === 'number' && Number.isSafeInteger(candidate.groupId) && candidate.groupId > 0);
  return typeof candidate.windowKey === 'string' && windows.has(candidate.windowKey as AccountWindowKey)
    && typeof candidate.status === 'string' && statuses.has(candidate.status as AccountStatusFilter)
    && validPlatform
    && validGroup
    && (candidate.alertGroupsOnly === undefined || typeof candidate.alertGroupsOnly === 'boolean')
    && typeof candidate.pageSize === 'number'
    && ACCOUNT_PAGE_SIZES.includes(candidate.pageSize as AccountPageSize);
}

export function readAccountFilterPreferences(storage: AccountFilterStorage): AccountFilterPreferences {
  try {
    const raw = storage.getItem(ACCOUNT_FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_ACCOUNT_FILTER_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!isPreferences(parsed)) return DEFAULT_ACCOUNT_FILTER_PREFERENCES;
    return {
      windowKey: parsed.windowKey,
      status: parsed.status,
      platform: parsed.platform,
      groupId: parsed.groupId,
      alertGroupsOnly: parsed.alertGroupsOnly ?? true,
      pageSize: parsed.pageSize,
    };
  } catch {
    return DEFAULT_ACCOUNT_FILTER_PREFERENCES;
  }
}

export function writeAccountFilterPreferences(
  storage: AccountFilterStorage,
  preferences: AccountFilterPreferences,
): void {
  try {
    const next = isPreferences(preferences) ? preferences : DEFAULT_ACCOUNT_FILTER_PREFERENCES;
    storage.setItem(ACCOUNT_FILTER_STORAGE_KEY, JSON.stringify({
      windowKey: next.windowKey,
      status: next.status,
      platform: next.platform,
      groupId: next.groupId,
      alertGroupsOnly: next.alertGroupsOnly,
      pageSize: next.pageSize,
    }));
  } catch {
    // Storage can be unavailable in privacy modes; filters still work in memory.
  }
}

export function readAccountFilterPreferencesSafely(
  getStorage: () => AccountFilterStorage,
): AccountFilterPreferences {
  try {
    return readAccountFilterPreferences(getStorage());
  } catch {
    return DEFAULT_ACCOUNT_FILTER_PREFERENCES;
  }
}

export function writeAccountFilterPreferencesSafely(
  getStorage: () => AccountFilterStorage,
  preferences: AccountFilterPreferences,
): void {
  try {
    writeAccountFilterPreferences(getStorage(), preferences);
  } catch {
    // Accessing the storage property itself can throw before Storage is returned.
  }
}

export function reconcileAccountFilterPreferences(
  preferences: AccountFilterPreferences,
  facets: AccountFilterFacets,
): AccountFilterPreferences {
  const platform = preferences.platform && !facets.platforms.includes(preferences.platform)
    ? ''
    : preferences.platform;
  const groupId = preferences.groupId !== null && !facets.groups.some((group) => group.id === preferences.groupId)
    ? null
    : preferences.groupId;
  return platform === preferences.platform && groupId === preferences.groupId
    ? preferences
    : { ...preferences, platform, groupId };
}
