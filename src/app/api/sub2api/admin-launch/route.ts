import {
  exchangeAdminLaunchTicket,
  resolveAdminSsoConfig,
} from '@/lib/admin-sso';
import { createAdminLaunchHandler, type AdminLaunchDependencies } from '@/lib/admin-launch';
import { attachAdminSession, createAdminSession } from '@/lib/admin-session-token';

const defaultDependencies: AdminLaunchDependencies = {
  async exchangeAdminTicket(token) {
    const config = resolveAdminSsoConfig();
    const claims = await exchangeAdminLaunchTicket(token);
    return { claims, sessionTtlSeconds: config.sessionTtlSeconds };
  },
  createAdminSession,
  attachAdminSession,
  onFailure(failure) {
    if (failure.stage !== 'token_validation') console.warn(JSON.stringify(failure));
  },
};

export const GET = createAdminLaunchHandler(defaultDependencies);
