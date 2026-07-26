import { requireApiSession } from '@/lib/auth';
import { getAccountAlertEnabled, putAccountAlertEnabled, type AccountAlertToggleRepository } from '@/lib/account-alert-toggle-handler';
import { prisma } from '@/lib/db';

const repository: AccountAlertToggleRepository = {
  find: (id) => prisma.sub2ApiAccount.findUnique({ where: { id }, select: { alertEnabled: true } }),
  update: (id, enabled) => prisma.sub2ApiAccount.update({ where: { id }, data: { alertEnabled: enabled }, select: { alertEnabled: true } }),
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return getAccountAlertEnabled((await context.params).id, repository);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  return putAccountAlertEnabled(request, (await context.params).id, repository);
}
