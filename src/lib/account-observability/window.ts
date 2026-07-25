import { beijingTodayWindow, minuteBucket } from './metrics';

export const ACCOUNT_WINDOW_KEYS = ['today', 'last1h', 'last24h'] as const;
export type AccountWindowKey = typeof ACCOUNT_WINDOW_KEYS[number];

export interface AccountWindow {
  key: AccountWindowKey;
  label: string;
  start: Date;
  end: Date;
  lastCompleteMinute: Date;
  expectedMinutes: number;
}

export class AccountQueryValidationError extends Error {}

export function resolveAccountWindow(key: AccountWindowKey, now = new Date()): AccountWindow {
  if (!ACCOUNT_WINDOW_KEYS.includes(key)) throw new AccountQueryValidationError('invalid account window');
  const end = minuteBucket(now);
  const start = key === 'today'
    ? beijingTodayWindow(end).start
    : new Date(end.getTime() - (key === 'last1h' ? 60 : 1440) * 60_000);
  const expectedMinutes = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
  return {
    key,
    label: key === 'today' ? '北京时间今日' : key === 'last1h' ? '近 1 小时' : '近 24 小时',
    start,
    end,
    lastCompleteMinute: new Date(end.getTime() - 60_000),
    expectedMinutes,
  };
}

export function parseAccountWindow(value: string | null): AccountWindowKey {
  const key = value ?? 'last24h';
  if (!ACCOUNT_WINDOW_KEYS.includes(key as AccountWindowKey)) throw new AccountQueryValidationError('invalid account window');
  return key as AccountWindowKey;
}
