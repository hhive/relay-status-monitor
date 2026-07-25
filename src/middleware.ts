import { NextResponse, type NextRequest } from 'next/server';
import { safeRedirectPath } from '@/lib/security';
import { verifySessionToken } from '@/lib/session-token';

/**
 * 路由守卫中间件
 * 保护 /（dashboard）路由，未登录跳转 /login
 * 仅登录、注销、采集、管理员票据入口和 Next.js 框架资源公开
 */

const COOKIE_NAME = 'rsm_session';
const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/cron/collect',
  '/api/sub2api/admin-launch',
]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 公开路径放行
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // 静态资源放行
  if (
    pathname.startsWith('/_next/static/') ||
    pathname === '/_next/image' ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // 校验会话
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return redirectToLogin(request);
  }

  try {
    const session = await verifySessionToken(token);
    if (!session) return redirectToLogin(request);
    return NextResponse.next();
  } catch {
    return redirectToLogin(request);
  }
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
