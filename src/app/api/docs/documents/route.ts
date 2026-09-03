import { NextResponse } from 'next/server';
import { createLocalDocument, isDocsAdminSession, listManagedDocuments } from '@/lib/docs-management';
import { requireApiSession } from '@/lib/auth';
import { safeErrorMessage } from '@/lib/safe-error';

export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  return NextResponse.json({ documents: await listManagedDocuments() });
}

export async function POST(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  try {
    const body = await request.json() as { id?: string; title?: string; content?: string };
    if (!body.id) return NextResponse.json({ error: '缺少文档标识' }, { status: 400 });
    return NextResponse.json(await createLocalDocument({ id: body.id, title: body.title ?? '', content: body.content ?? '' }), { status: 201 });
      } catch (error) { return NextResponse.json({ error: safeErrorMessage(error) }, { status: 400 }); }
}
