function groupIds(projection: unknown): number[] | null {
  if (!Array.isArray(projection)) return null;
  const ids: number[] = [];
  for (const entry of projection) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

interface GroupProjectionAccount {
  groupProjection: unknown;
  alertEnabled?: boolean;
}

interface GroupAlertSettingRecord {
  groupId: number;
  alertEnabled: boolean;
}

export interface GroupAlertSettingSummary {
  groupId: number;
  name: string;
  alertEnabled: boolean;
  exclusiveAccountCount: number;
  boundAccountCount: number;
}

export class GroupAlertSettingValidationError extends Error {}

function namedGroups(projection: unknown): Array<{ id: number; name: string }> | null {
  const ids = groupIds(projection);
  if (ids === null) return null;
  const names = new Map<number, string>();
  for (const entry of projection as Array<Record<string, unknown>>) {
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) return null;
    const id = entry.id as number;
    const current = names.get(id);
    if (current == null || name.localeCompare(current, 'zh-CN') < 0) names.set(id, name);
  }
  return ids.map((id) => ({ id, name: names.get(id)! }));
}

export function uniqueGroupId(projection: unknown): number | null {
  const ids = groupIds(projection);
  return ids?.length === 1 ? ids[0] : null;
}

export function shouldSuppressAccountAlerts(
  projection: unknown,
  disabledGroupIds: ReadonlySet<number>,
): boolean {
  const groupId = uniqueGroupId(projection);
  return groupId !== null && disabledGroupIds.has(groupId);
}

export function isAccountInAlertEnabledGroup(
  projection: unknown,
  disabledGroupIds: ReadonlySet<number>,
): boolean {
  const ids = groupIds(projection);
  return ids !== null && ids.length > 0 && ids.some((id) => !disabledGroupIds.has(id));
}

export function buildGroupAlertSettingSummaries(
  accounts: readonly GroupProjectionAccount[],
  settings: readonly GroupAlertSettingRecord[],
): GroupAlertSettingSummary[] {
  const overrides = new Map(settings.map((setting) => [setting.groupId, setting.alertEnabled]));
  const summaries = new Map<number, GroupAlertSettingSummary>();

  for (const account of accounts) {
    const groups = namedGroups(account.groupProjection);
    if (groups === null) continue;
    const exclusiveGroupId = groups.length === 1 ? groups[0].id : null;
    for (const group of groups) {
      const summary = summaries.get(group.id) ?? {
        groupId: group.id,
        name: group.name,
        alertEnabled: overrides.get(group.id) ?? true,
        exclusiveAccountCount: 0,
        boundAccountCount: 0,
      };
      if (group.name.localeCompare(summary.name, 'zh-CN') < 0) summary.name = group.name;
      summary.boundAccountCount += 1;
      if (account.alertEnabled !== false && exclusiveGroupId === group.id) {
        summary.exclusiveAccountCount += 1;
      }
      summaries.set(group.id, summary);
    }
  }

  return [...summaries.values()].sort((left, right) =>
    left.name.localeCompare(right.name, 'zh-CN') || left.groupId - right.groupId);
}

export function parseGroupAlertSettingUpdate(body: unknown): { enabled: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GroupAlertSettingValidationError('分组告警参数无效');
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.enabled !== 'boolean') {
    throw new GroupAlertSettingValidationError('分组告警参数无效');
  }
  return { enabled: record.enabled };
}
