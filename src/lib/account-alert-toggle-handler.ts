import { parseStrictPositiveInteger } from '@/lib/security';

export interface AccountAlertToggleRepository {
  find: (id: number) => Promise<{ alertEnabled: boolean } | null>;
  update: (id: number, enabled: boolean) => Promise<{ alertEnabled: boolean }>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function getAccountAlertEnabled(idValue: string, repository: AccountAlertToggleRepository): Promise<Response> {
  const id = parseStrictPositiveInteger(idValue);
  if (id == null) return json({ error: '账号 ID 无效' }, 400);
  const account = await repository.find(id);
  if (!account) return json({ error: '账号不存在' }, 404);
  return json({ enabled: account.alertEnabled });
}

export async function putAccountAlertEnabled(request: Request, idValue: string, repository: AccountAlertToggleRepository): Promise<Response> {
  const id = parseStrictPositiveInteger(idValue);
  if (id == null) return json({ error: '账号 ID 无效' }, 400);
  const body = await request.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return json({ error: '告警开关参数无效' }, 400);
  const account = await repository.find(id);
  if (!account) return json({ error: '账号不存在' }, 404);
  const updated = await repository.update(id, body.enabled);
  return json({ enabled: updated.alertEnabled });
}
