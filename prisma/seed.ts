/**
 * 安全基础种子：只初始化管理员、告警规则和系统设置。
 * 用法：ADMIN_PASSWORD='<strong-password>' pnpm db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { requireSeedValue } from '../src/lib/demo-data';
import { assertPasswordPolicy } from '../src/lib/login-policy';

const prisma = new PrismaClient();

const defaultRules = [
  { name: '余额不足-严重', metric: 'balance', operator: 'lt', threshold: 10, severity: 'CRITICAL' as const, cooldownMin: 60, enabled: true },
  { name: '余额不足-警告', metric: 'balance', operator: 'lt', threshold: 30, severity: 'WARNING' as const, cooldownMin: 120, enabled: true },
  { name: '延迟过高', metric: 'latency', operator: 'gt', threshold: 3000, severity: 'WARNING' as const, cooldownMin: 30, enabled: true },
  { name: '连续失败', metric: 'consecutive_failures', operator: 'gte', threshold: 3, severity: 'CRITICAL' as const, cooldownMin: 30, enabled: true },
  { name: '可用率低', metric: 'availability', operator: 'lt', threshold: 95, severity: 'WARNING' as const, cooldownMin: 60, enabled: true },
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
  const adminPassword = requireSeedValue(process.env, 'ADMIN_PASSWORD');
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

  for (const rule of defaultRules) {
    await prisma.alertRule.upsert({
      where: { name: rule.name },
      update: rule,
      create: rule,
    });
  }
  console.log(`${defaultRules.length} 条默认告警规则已就绪`);

  for (const [key, value] of Object.entries(defaultSettings)) {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
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
