import { NextResponse } from 'next/server';

import type { AdminClaims } from '@/lib/admin-sso';

export interface AdminLaunchExchangeResult {
  claims: AdminClaims;
  sessionTtlSeconds: number;
}

export interface AdminLaunchDependencies {
  exchangeAdminTicket(token: string): Promise<AdminLaunchExchangeResult>;
  createAdminSession(claims: AdminClaims, ttlSeconds: number): Promise<string>;
  attachAdminSession(response: NextResponse, token: string, ttlSeconds: number): void;
}

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
