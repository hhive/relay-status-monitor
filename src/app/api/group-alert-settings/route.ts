import { requireApiSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getGroupAlertSettings, type GroupAlertSettingsRepository } from '@/lib/group-alert-settings-handler';

const repository: GroupAlertSettingsRepository = {
  loadAccounts: () => prisma.sub2ApiAccount.findMany({
    where: { syncState: 'ACTIVE' },
    select: { groupProjection: true, alertEnabled: true },
  }),
  loadSettings: () => prisma.groupAlertSetting.findMany({
    select: { groupId: true, alertEnabled: true },
  }),
  upsert: (groupId, enabled) => prisma.groupAlertSetting.upsert({
    where: { groupId },
    create: { groupId, alertEnabled: enabled },
    update: { alertEnabled: enabled },
    select: { groupId: true, alertEnabled: true },
  }),
};

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return getGroupAlertSettings(repository);
}
