const ACCOUNT_SYNC_STALE_MS = 10 * 60_000;
const METRIC_MINUTE_STALE_MS = 3 * 60_000;

interface AccountFreshness {
  lastSyncedAt: string | Date | null;
  lastCompleteMinute: string | Date | null;
}

function isOlderThan(value: string | Date | null, maximumAgeMs: number, now: Date): boolean {
  if (!value) return true;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return !Number.isFinite(timestamp) || now.getTime() - timestamp > maximumAgeMs;
}

export function accountDataIsStale(freshness: AccountFreshness, now = new Date()): boolean {
  return isOlderThan(freshness.lastSyncedAt, ACCOUNT_SYNC_STALE_MS, now) ||
    isOlderThan(freshness.lastCompleteMinute, METRIC_MINUTE_STALE_MS, now);
}

export function formatAccountGroups(projection: unknown): string {
  if (!Array.isArray(projection)) return '无分组';
  const labels = projection.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as { id?: unknown; name?: unknown };
    if (typeof value.name === 'string' && value.name.trim()) return [value.name.trim()];
    if (typeof value.id === 'number' || typeof value.id === 'string') return [`分组 #${value.id}`];
    return [];
  });
  return labels.length ? labels.join('、') : '无分组';
}
