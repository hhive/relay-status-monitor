import { NextResponse } from 'next/server';
import { createLocalDocument, importZipDocument, isDocsAdminSession, listManagedDocuments } from '@/lib/docs-management';
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
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData(); const file = form.get('file'); const id = String(form.get('id') ?? ''); const title = String(form.get('title') ?? '');
      if (!(file instanceof File) || !id) return NextResponse.json({ error: '请提供 ZIP 文件和文档标识' }, { status: 400 });
      if (file.size > 50 * 1024 * 1024) return NextResponse.json({ error: 'ZIP 文件不能超过 50MB' }, { status: 400 });
      return NextResponse.json(await importZipDocument(Buffer.from(await file.arrayBuffer()), { id, title }), { status: 201 });
    }
    const body = await request.json() as { id?: string; title?: string; content?: string };
    if (!body.id) return NextResponse.json({ error: '缺少文档标识' }, { status: 400 });
    return NextResponse.json(await createLocalDocument({ id: body.id, title: body.title ?? '', content: body.content ?? '' }), { status: 201 });
      } catch (error) { return NextResponse.json({ error: safeErrorMessage(error) }, { status: 400 }); }
}
