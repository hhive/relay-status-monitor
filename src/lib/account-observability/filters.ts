import { AccountQueryValidationError } from './window';

export const ACCOUNT_STATUS_FILTERS = ['schedulable', 'all', 'unschedulable'] as const;
export type AccountStatusFilter = typeof ACCOUNT_STATUS_FILTERS[number];

export interface AccountFilters {
  status: AccountStatusFilter;
  platform: string | null;
  group: string | null;
  search: string | null;
}

interface FilterableAccount {
  name: string;
  platform: string | null;
  syncState: string;
  schedulable: boolean | null;
  groupProjection: unknown;
}

function optionalValue(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)?.trim() || null;
  if (value && (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new AccountQueryValidationError(`invalid account ${key}`);
  }
  return value;
}

export function parseAccountFilters(params: URLSearchParams): AccountFilters {
  const status = params.get('status') ?? 'schedulable';
  if (!ACCOUNT_STATUS_FILTERS.includes(status as AccountStatusFilter)) {
    throw new AccountQueryValidationError('invalid account status');
  }
  return {
    status: status as AccountStatusFilter,
    platform: optionalValue(params, 'platform'),
    group: optionalValue(params, 'group'),
    search: optionalValue(params, 'search'),
  };
}

function groupText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    return [row.id, row.name].filter((item) => item != null).map(String);
  }).join(' ');
}

export function filterAccounts<T extends FilterableAccount>(accounts: T[], filters: AccountFilters): T[] {
  const platform = filters.platform?.toLocaleLowerCase();
  const group = filters.group?.toLocaleLowerCase();
  const search = filters.search?.toLocaleLowerCase();
  return accounts.filter((account) => {
    const statusMatches = filters.status === 'all'
      || (filters.status === 'schedulable' && account.syncState === 'ACTIVE' && account.schedulable === true)
      || (filters.status === 'unschedulable' && account.syncState === 'ACTIVE' && account.schedulable === false);
    if (!statusMatches) return false;
    const groups = groupText(account.groupProjection).toLocaleLowerCase();
    if (platform && account.platform?.toLocaleLowerCase() !== platform) return false;
    if (group && !groups.includes(group)) return false;
    if (search && !`${account.name} ${account.platform ?? ''} ${groups}`.toLocaleLowerCase().includes(search)) return false;
    return true;
  });
}
