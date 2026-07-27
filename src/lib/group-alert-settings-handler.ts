import { parseStrictPositiveInteger } from '@/lib/security';
import {
  GroupAlertSettingValidationError,
  buildGroupAlertSettingSummaries,
  parseGroupAlertSettingUpdate,
} from '@/lib/account-observability/group-alert-settings';

interface GroupAccountProjection {
  groupProjection: unknown;
  alertEnabled: boolean;
}

interface GroupAlertSettingRecord {
  groupId: number;
  alertEnabled: boolean;
}

export interface GroupAlertSettingsRepository {
  loadAccounts: () => Promise<GroupAccountProjection[]>;
  loadSettings: () => Promise<GroupAlertSettingRecord[]>;
  upsert: (groupId: number, enabled: boolean) => Promise<GroupAlertSettingRecord>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function getGroupAlertSettings(repository: GroupAlertSettingsRepository): Promise<Response> {
  try {
    const [accounts, settings] = await Promise.all([
      repository.loadAccounts(),
      repository.loadSettings(),
    ]);
    return json({ groups: buildGroupAlertSettingSummaries(accounts, settings) });
  } catch {
    return json({ error: '分组告警加载失败' }, 503);
  }
}

export async function putGroupAlertSetting(
  request: Request,
  groupIdValue: string,
  repository: GroupAlertSettingsRepository,
): Promise<Response> {
  const groupId = parseStrictPositiveInteger(groupIdValue);
  if (groupId === null) return json({ error: '分组 ID 无效' }, 400);

  try {
    const update = parseGroupAlertSettingUpdate(await request.json().catch(() => null));
    const accounts = await repository.loadAccounts();
    const groups = buildGroupAlertSettingSummaries(accounts, []);
    if (!groups.some((group) => group.groupId === groupId)) {
      return json({ error: '分组不存在或当前未绑定账号' }, 404);
    }
    const saved = await repository.upsert(groupId, update.enabled);
    const group = buildGroupAlertSettingSummaries(accounts, [saved])
      .find((item) => item.groupId === groupId)!;
    return json(group);
  } catch (error) {
    if (error instanceof GroupAlertSettingValidationError) return json({ error: error.message }, 400);
    return json({ error: '分组告警保存失败' }, 503);
  }
}
