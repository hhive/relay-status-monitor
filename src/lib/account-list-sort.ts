import type { AccountListItemDto, AccountSummaryDto } from '@/lib/account-observability-ui';
import { accountDataIsStale, formatAccountGroups } from '@/lib/account-observability/presentation';

export const ACCOUNT_SORT_KEYS = [
  'account',
  'platformGroup',
  'schedulable',
  'availability',
  'errorRate',
  'durationP95Ms',
  'firstTokenP95Ms',
  'cacheHitRate',
  'userBilledUsd',
  'accountBilledUsd',
  'balanceUsd',
  'eligibleCount',
  'sync',
  'alertEnabled',
] as const;

export type AccountSortKey = (typeof ACCOUNT_SORT_KEYS)[number];
export type AccountSortOrder = 'asc' | 'desc';

export interface AccountSortState {
  key: AccountSortKey;
  order: AccountSortOrder;
}

export const ACCOUNT_SORT_LABELS: Record<AccountSortKey, string> = {
  account: '账号',
  platformGroup: '平台 / 分组',
  schedulable: '调度',
  availability: '可用率',
  errorRate: '错误率',
  durationP95Ms: '总延迟 P95',
  firstTokenP95Ms: '首 Token P95',
  cacheHitRate: '缓存命中率',
  userBilledUsd: '用户计费',
  accountBilledUsd: '账号计费',
  balanceUsd: '上游余额',
  eligibleCount: '有效请求',
  sync: '同步',
  alertEnabled: '告警',
};

export const DEFAULT_ACCOUNT_SORT: AccountSortState = { key: 'alertEnabled', order: 'desc' };
export const ACCOUNT_SORT_STORAGE_KEY = 'relay-status-monitor:account-list-sort:v1';

export interface AccountSortStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const sortKeySet = new Set<string>(ACCOUNT_SORT_KEYS);
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function isAccountSortState(value: unknown): value is AccountSortState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { key?: unknown; order?: unknown };
  return typeof candidate.key === 'string' && sortKeySet.has(candidate.key) &&
    (candidate.order === 'asc' || candidate.order === 'desc');
}

export function readAccountSortState(storage: AccountSortStorage): AccountSortState {
  try {
    const raw = storage.getItem(ACCOUNT_SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_ACCOUNT_SORT;
    const parsed: unknown = JSON.parse(raw);
    return isAccountSortState(parsed) ? { key: parsed.key, order: parsed.order } : DEFAULT_ACCOUNT_SORT;
  } catch {
    return DEFAULT_ACCOUNT_SORT;
  }
}

export function writeAccountSortState(storage: AccountSortStorage, state: AccountSortState): void {
  try {
    const next = isAccountSortState(state) ? state : DEFAULT_ACCOUNT_SORT;
    storage.setItem(ACCOUNT_SORT_STORAGE_KEY, JSON.stringify({ key: next.key, order: next.order }));
  } catch {
    // Storage can be unavailable in privacy modes; sorting still works in memory.
  }
}

export function readAccountSortStateSafely(getStorage: () => AccountSortStorage): AccountSortState {
  try {
    return readAccountSortState(getStorage());
  } catch {
    return DEFAULT_ACCOUNT_SORT;
  }
}

export function writeAccountSortStateSafely(getStorage: () => AccountSortStorage, state: AccountSortState): void {
  try {
    writeAccountSortState(getStorage(), state);
  } catch {
    // Accessing the storage property itself can throw before a Storage object is returned.
  }
}

function compareNullable<T>(
  left: T | null | undefined,
  right: T | null | undefined,
  compare: (a: T, b: T) => number,
  order: AccountSortOrder,
): number {
  const leftMissing = left == null;
  const rightMissing = right == null;
  if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  const result = compare(left, right);
  return order === 'asc' ? result : -result;
}

function compareText(left: string, right: string): number {
  return collator.compare(left, right);
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteNumber(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface DecimalParts {
  digits: bigint;
  scale: number;
}

function decimalParts(value: string): DecimalParts | null {
  const match = /^\s*([+-]?)(\d+)(?:\.(\d+))?\s*$/.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? '';
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return { digits: match[1] === '-' ? -magnitude : magnitude, scale: fraction.length };
}

function compareDecimals(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return compareText(left, right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.digits * BigInt(10) ** BigInt(scale - a.scale);
  const bv = b.digits * BigInt(10) ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

type SortableAccount = AccountSummaryDto | AccountListItemDto;

function comparePrimary(left: SortableAccount, right: SortableAccount, state: AccountSortState, now: Date): number {
  const { key, order } = state;
  if (key === 'account') {
    return compareNullable(left.name, right.name, compareText, order) ||
      compareNullable(left.type, right.type, compareText, order);
  }
  if (key === 'platformGroup') {
    return compareNullable(left.platform, right.platform, compareText, order) ||
      compareNullable(formatAccountGroups(left.groupProjection), formatAccountGroups(right.groupProjection), compareText, order);
  }
  if (key === 'schedulable') {
    return compareNullable(left.schedulable, right.schedulable, (a, b) => compareNumber(Number(a), Number(b)), order);
  }
  if (key === 'sync') {
    const leftSyncedAt = timestamp(left.lastSyncedAt);
    const rightSyncedAt = timestamp(right.lastSyncedAt);
    const missingResult = compareNullable(leftSyncedAt, rightSyncedAt, () => 0, order);
    if (leftSyncedAt == null || rightSyncedAt == null) return missingResult;
    return compareNullable(accountDataIsStale(left, now), accountDataIsStale(right, now), (a, b) => compareNumber(Number(a), Number(b)), order) ||
      compareNullable(leftSyncedAt, rightSyncedAt, compareNumber, order);
  }
  if (key === 'alertEnabled') {
    return compareNullable(left.alertEnabled, right.alertEnabled, (a, b) => compareNumber(Number(a), Number(b)), order);
  }
  if (key === 'userBilledUsd' || key === 'accountBilledUsd' || key === 'balanceUsd') {
    return compareNullable(left.metrics[key], right.metrics[key], compareDecimals, order);
  }
  return compareNullable(finiteNumber(left.metrics[key]), finiteNumber(right.metrics[key]), compareNumber, order);
}

export function sortAccountSummaries<T extends SortableAccount>(accounts: T[], state: AccountSortState, now = new Date()): T[] {
  return [...accounts].sort((left, right) => {
    const primary = comparePrimary(left, right, state, now);
    if (primary !== 0) return primary;
    return compareText(left.name, right.name) || compareNumber(left.id, right.id);
  });
}
