import { NextResponse } from 'next/server';

import {
  exchangeAdminLaunchTicket,
  resolveAdminSsoConfig,
  type AdminClaims,
} from '@/lib/admin-sso';
import { attachAdminSession, createAdminSession } from '@/lib/admin-session-token';

interface ExchangeResult {
  claims: AdminClaims;
  sessionTtlSeconds: number;
}

interface AdminLaunchDependencies {
  exchangeAdminTicket(token: string): Promise<ExchangeResult>;
  createAdminSession(claims: AdminClaims, ttlSeconds: number): Promise<string>;
  attachAdminSession(response: NextResponse, token: string, ttlSeconds: number): void;
}

const defaultDependencies: AdminLaunchDependencies = {
  async exchangeAdminTicket(token) {
    const config = resolveAdminSsoConfig();
    const claims = await exchangeAdminLaunchTicket(token);
    return { claims, sessionTtlSeconds: config.sessionTtlSeconds };
  },
  createAdminSession,
  attachAdminSession,
};

function protectLaunchResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export function createAdminLaunchHandler(dependencies: AdminLaunchDependencies) {
  return async function handleAdminLaunch(request: Request): Promise<NextResponse> {
    try {
      const tokens = new URL(request.url).searchParams.getAll('token');
      const token = tokens[0];
      if (tokens.length !== 1 || !token || token.trim() !== token) {
        throw new Error('Invalid admin launch');
      }

      const { claims, sessionTtlSeconds } = await dependencies.exchangeAdminTicket(token);
      const sessionToken = await dependencies.createAdminSession(claims, sessionTtlSeconds);
      const response = NextResponse.redirect(new URL('/', request.url), 303);
      dependencies.attachAdminSession(response, sessionToken, sessionTtlSeconds);
      return protectLaunchResponse(response);
    } catch {
      return protectLaunchResponse(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    }
  };
}

export const GET = createAdminLaunchHandler(defaultDependencies);
