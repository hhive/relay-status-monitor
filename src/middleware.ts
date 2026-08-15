import { NextResponse, type NextRequest } from 'next/server';
import { safeRedirectPath } from '@/lib/security';
import { publicOrigin } from '@/lib/public-origin';
import { verifySessionToken } from '@/lib/session-token';
import { ADMIN_SESSION_COOKIE_NAME, verifyAdminSession } from '@/lib/admin-session-token';

/**
 * 路由守卫中间件
 * 保护 /（dashboard）路由，未登录跳转 /login
 * 仅登录、注销、采集、管理员票据入口和 Next.js 框架资源公开
 */

const COOKIE_NAME = 'rsm_session';
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ADMIN_CSRF_TOKEN_BYTES = 36;
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/cron/collect',
  '/api/cron/backup',
  '/api/sub2api/admin-launch',
]);

export async function middleware(request: NextRequest) {
  const pathname = stripBasePath(request.nextUrl.pathname);

  try {
    const adminToken = request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    const adminSession = adminToken ? await verifyAdminSession(adminToken) : null;
    if (adminSession) {
      if (STATE_CHANGING_METHODS.has(request.method) && !validAdminCsrf(request, adminSession.csrfToken)) {
        return NextResponse.json({ error: '禁止访问' }, { status: 403 });
      }
      return NextResponse.next();
    }

    // 公开路径和静态资源无需本地会话。
    if (
      PUBLIC_PATHS.has(pathname) ||
      pathname.startsWith('/_next/static/') ||
      pathname === '/_next/image' ||
      pathname === '/favicon.ico'
    ) {
      return NextResponse.next();
    }

    const token = request.cookies.get(COOKIE_NAME)?.value;
    if (token && await verifySessionToken(token)) return NextResponse.next();
    return redirectToLogin(request);
  } catch {
    return redirectToLogin(request);
  }
}

function validAdminCsrf(request: NextRequest, expectedToken: string): boolean {
  if (request.headers.get('origin') !== expectedRequestOrigin(request)) return false;
  const suppliedToken = request.headers.get('x-csrf-token') ?? '';
  const encoder = new TextEncoder();
  const expected = encoder.encode(expectedToken);
  const supplied = encoder.encode(suppliedToken);
  let difference = expected.length ^ supplied.length;

  if (expected.length !== ADMIN_CSRF_TOKEN_BYTES) return false;
  for (let index = 0; index < ADMIN_CSRF_TOKEN_BYTES; index += 1) {
    difference |= expected[index] ^ (supplied[index] ?? 0);
  }
  return difference === 0;
}

function expectedRequestOrigin(request: NextRequest): string | null {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto === null) return request.nextUrl.origin;
  if (forwardedProto !== 'http' && forwardedProto !== 'https') return null;

  const host = request.headers.get('host');
  if (!host) return null;
  try {
    const externalUrl = new URL(`${forwardedProto}://${host}`);
    if (externalUrl.username || externalUrl.password || externalUrl.pathname !== '/') return null;
    return externalUrl.origin;
  } catch {
    return null;
  }
}

function redirectToLogin(request: NextRequest) {
  // API 请求返回 401，页面请求跳转登录
  if (stripBasePath(request.nextUrl.pathname).startsWith('/api/')) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  const loginUrl = new URL(request.nextUrl.pathname, publicOrigin(request.url));
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set(
    'redirect',
    safeRedirectPath(request.nextUrl.pathname + request.nextUrl.search),
  );
  return NextResponse.redirect(loginUrl);
}

function stripBasePath(pathname: string): string {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH) return '/';
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
