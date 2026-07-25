import { NextResponse, type NextRequest } from 'next/server';
import { safeRedirectPath } from '@/lib/security';
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
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/cron/collect',
  '/api/sub2api/admin-launch',
]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
  if (request.headers.get('origin') !== request.nextUrl.origin) return false;
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

function redirectToLogin(request: NextRequest) {
  // API 请求返回 401，页面请求跳转登录
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '未登录' }, { status: 401 });
  }
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set(
    'redirect',
    safeRedirectPath(request.nextUrl.pathname + request.nextUrl.search),
  );
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
