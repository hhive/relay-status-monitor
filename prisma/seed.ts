/**
 * 安全基础种子：只初始化管理员、账号告警规则和系统设置。
 * 用法：ADMIN_PASSWORD='<strong-password>' pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { assertPasswordPolicy } from '../src/lib/login-policy';

const prisma = new PrismaClient();

const defaultAccountRules = [
  { name: '账号可用率低', metric: 'availability_low', operator: 'lt', threshold: 0.95, minRequests: 20, cooldownMin: 60 },
  { name: '账号错误率高', metric: 'error_rate_high', operator: 'gt', threshold: 0.1, minRequests: 20, cooldownMin: 30 },
  { name: '账号总延迟P95高', metric: 'duration_p95_high', operator: 'gt', threshold: 5000, minRequests: 10, cooldownMin: 30 },
  { name: '账号首TokenP95高', metric: 'first_token_p95_high', operator: 'gt', threshold: 3000, minRequests: 10, cooldownMin: 30 },
  { name: '账号缓存命中率低', metric: 'cache_hit_low', operator: 'lt', threshold: 0.1, minRequests: 20, minPromptTokens: 10000, cooldownMin: 60 },
  { name: '账号持续不可调度', metric: 'unschedulable', operator: 'eq', threshold: 1, minRequests: 0, cooldownMin: 30 },
  { name: '账号同步陈旧', metric: 'sync_stale', operator: 'gt', threshold: 10, minRequests: 0, cooldownMin: 30 },
  { name: '上游余额低', metric: 'balance_low', operator: 'lte', threshold: 5, minRequests: 0, cooldownMin: 0 },
  { name: '上游倍率偏差高', metric: 'upstream_rate_deviation', operator: 'gt', threshold: 0.10, minRequests: 0, cooldownMin: 30 },
];

const defaultSettings: Record<string, string> = {
  light_interval_minutes: '1',
  heavy_interval_minutes: '15',
  test_model: 'gpt-4o-mini',
  test_timeout_ms: '15000',
  retention_days: '90',
  timezone: 'Asia/Shanghai',
};

async function main() {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.trim().length === 0) {
    throw new Error('ADMIN_PASSWORD 必须通过进程环境显式提供且不能为空');
  }
  assertPasswordPolicy(adminPassword, 'ADMIN_PASSWORD');
  const adminPasswordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {
      password: adminPasswordHash,
      sessionVersion: { increment: 1 },
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
    create: { username: 'admin', password: adminPasswordHash },
  });
  console.log('默认管理员已就绪（密码来自 ADMIN_PASSWORD）');

  for (const rule of defaultAccountRules) {
    await prisma.accountAlertRule.upsert({
      where: { name: rule.name },
      update: {},
      create: { ...rule, enabled: true },
    });
  }
  console.log(`${defaultAccountRules.length} 条账号告警规则已就绪`);

  for (const [key, value] of Object.entries(defaultSettings)) {
    await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
  }
  console.log(`${Object.keys(defaultSettings).length} 项默认设置已就绪`);
}

main()
  .catch((error) => {
    console.error('基础种子初始化失败:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
