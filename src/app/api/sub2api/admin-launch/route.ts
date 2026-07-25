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
};

export const GET = createAdminLaunchHandler(defaultDependencies);
