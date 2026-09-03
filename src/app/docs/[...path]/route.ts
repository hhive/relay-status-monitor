import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

const DOCS_ROOT = '/var/lib/relay-status-monitor/docs';
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const parts = (await context.params).path;
  const relative = parts.join('/');
  const file = path.resolve(DOCS_ROOT, relative);
  if (file !== DOCS_ROOT && !file.startsWith(`${DOCS_ROOT}${path.sep}`)) return new NextResponse('Not Found', { status: 404 });
  try {
    const body = await readFile(file);
    const extension = path.extname(file).slice(1).toLowerCase();
    return new NextResponse(body, { headers: { 'content-type': TYPES[extension] ?? 'application/octet-stream', 'cache-control': 'no-cache' } });
  } catch { return new NextResponse('Not Found', { status: 404 }); }
}
