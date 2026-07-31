import { NextResponse } from 'next/server';

import { adminSsoFailureReason, type AdminClaims, type AdminSsoFailureReason } from '@/lib/admin-sso';

export type AdminLaunchFailureStage =
  | 'token_validation'
  | 'ticket_exchange'
  | 'session_creation'
  | 'session_attachment';

export interface AdminLaunchFailure {
  event: 'relay_monitor_admin_sso_failed';
  stage: AdminLaunchFailureStage;
  reason: AdminSsoFailureReason | 'invalid_launch_token';
}

export interface AdminLaunchExchangeResult {
  claims: AdminClaims;
  sessionTtlSeconds: number;
}

export interface AdminLaunchDependencies {
  exchangeAdminTicket(token: string): Promise<AdminLaunchExchangeResult>;
  createAdminSession(claims: AdminClaims, ttlSeconds: number): Promise<string>;
  attachAdminSession(response: NextResponse, token: string, ttlSeconds: number): void;
  onFailure?(failure: AdminLaunchFailure): void;
}

function protectLaunchResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export function createAdminLaunchHandler(dependencies: AdminLaunchDependencies) {
  return async function handleAdminLaunch(request: Request): Promise<NextResponse> {
    let stage: AdminLaunchFailureStage = 'token_validation';
    try {
      const tokens = new URL(request.url).searchParams.getAll('token');
      const token = tokens[0];
      if (tokens.length !== 1 || !token || token.trim() !== token) {
        throw new Error('Invalid admin launch');
      }

      stage = 'ticket_exchange';
      const { claims, sessionTtlSeconds } = await dependencies.exchangeAdminTicket(token);
      stage = 'session_creation';
      const sessionToken = await dependencies.createAdminSession(claims, sessionTtlSeconds);
      stage = 'session_attachment';
      const response = NextResponse.redirect(new URL('/', request.url), 303);
      dependencies.attachAdminSession(response, sessionToken, sessionTtlSeconds);
      return protectLaunchResponse(response);
    } catch (error) {
      try {
        dependencies.onFailure?.({
          event: 'relay_monitor_admin_sso_failed',
          stage,
          reason: stage === 'token_validation' ? 'invalid_launch_token' : adminSsoFailureReason(error),
        });
      } catch { /* Failure reporting must not alter the public authentication response. */ }
      return protectLaunchResponse(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    }
  };
}
