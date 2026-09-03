import { NextResponse } from 'next/server';
import { deleteLocalDocument, isDocsAdminSession, updateLocalDocument } from '@/lib/docs-management';
import { requireApiSession } from '@/lib/auth';
import { safeErrorMessage } from '@/lib/safe-error';

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  try {
    const { id } = await context.params;
    const body = await request.json() as { title?: string; content?: string };
    return NextResponse.json(await updateLocalDocument(decodeURIComponent(id), { title: body.title ?? '', content: body.content ?? '' }));
  } catch (error) { return NextResponse.json({ error: safeErrorMessage(error) }, { status: 400 }); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!isDocsAdminSession(auth.session)) return NextResponse.json({ error: '禁止访问' }, { status: 403 });
  try { await deleteLocalDocument(decodeURIComponent((await context.params).id)); return new NextResponse(null, { status: 204 }); }
  catch (error) { return NextResponse.json({ error: safeErrorMessage(error) }, { status: 400 }); }
}
