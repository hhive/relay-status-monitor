/**
 * 独立演示种子：生成虚构上游、密钥、7 天指标、告警和设置。
 * 用法：
 * DATABASE_URL='<demo-database>' APP_ENCRYPTION_KEY='<demo-key>' \
 * SESSION_SECRET='<demo-session-key>' DEMO_ADMIN_PASSWORD='<strong-password>' pnpm db:seed:demo
 */
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { buildDemoDataset, readDemoSeedEnvironment } from '../src/lib/demo-data';
import { assertPasswordPolicy } from '../src/lib/login-policy';

async function main() {
  // Read the process environment before importing Prisma so project .env files
  // cannot silently choose the target database for demo seeding.
  const seedEnvironment = readDemoSeedEnvironment(process.env);
  const [{ PrismaClient }, { encrypt }, { sealAlertChannelConfig }] = await Promise.all([
    import('@prisma/client'),
    import('../src/lib/crypto'),
    import('../src/lib/alert-channel-config'),
  ]);
  process.env.APP_ENCRYPTION_KEY = seedEnvironment.appEncryptionKey;
  process.env.SESSION_SECRET = seedEnvironment.sessionSecret;

  const prisma = new PrismaClient({
    datasources: { db: { url: seedEnvironment.databaseUrl } },
  });
  assertPasswordPolicy(seedEnvironment.demoAdminPassword, 'DEMO_ADMIN_PASSWORD');
  const passwordHash = await bcrypt.hash(seedEnvironment.demoAdminPassword, 10);
  const dataset = buildDemoDataset(new Date());

  try {
    await prisma.$transaction(
      async (tx) => {
      await tx.user.upsert({
        where: { username: 'demo' },
        update: {
          password: passwordHash,
          sessionVersion: { increment: 1 },
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
        create: { username: 'demo', password: passwordHash },
      });

      for (const rule of dataset.alertRules) {
        await tx.alertRule.upsert({
          where: { name: rule.name },
          update: rule,
          create: rule,
        });
      }

      for (const channel of dataset.alertChannels) {
        const data = {
          ...channel,
          config: sealAlertChannelConfig(channel.config) as unknown as Prisma.InputJsonValue,
        };
        await tx.alertChannel.upsert({
          where: { name: channel.name },
          update: data,
          create: data,
        });
      }

      for (const [key, value] of Object.entries(dataset.settings)) {
        await tx.setting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }

      const upstreamIds = new Map<string, number>();
      const keyIds = new Map<string, number>();

      for (const upstream of dataset.upstreams) {
        const { slug, ...data } = upstream;
        const saved = await tx.upstream.upsert({
          where: { name: upstream.name },
          update: data,
          create: data,
        });
        upstreamIds.set(slug, saved.id);

        await tx.incident.deleteMany({ where: { upstreamId: saved.id } });
        await tx.metric.deleteMany({ where: { upstreamId: saved.id } });
        await tx.upstreamKey.deleteMany({ where: { upstreamId: saved.id } });
      }

      for (const key of dataset.keys) {
        const upstreamId = upstreamIds.get(key.upstreamSlug);
        if (!upstreamId) throw new Error(`找不到演示上游: ${key.upstreamSlug}`);

        const {
          slug,
          upstreamSlug: _upstreamSlug,
          baseUrl: _baseUrl,
          hasApiKey,
          hasAccessToken,
          ...data
        } = key;
        const saved = await tx.upstreamKey.create({
          data: {
            ...data,
            upstreamId,
            apiKeyEnc: hasApiKey ? encrypt(`sk-demo-${slug}`) : null,
            accessTokenEnc: hasAccessToken ? encrypt(`access-demo-${slug}`) : null,
            userId: hasAccessToken ? `demo-user-${slug}` : null,
          },
        });
        keyIds.set(slug, saved.id);
      }

      await tx.metric.createMany({
        data: dataset.metrics.map((metric) => {
          const upstreamKeyId = keyIds.get(metric.keySlug);
          if (!upstreamKeyId) throw new Error(`找不到演示密钥: ${metric.keySlug}`);
          const key = dataset.keys.find((item) => item.slug === metric.keySlug)!;
          const upstreamId = upstreamIds.get(key.upstreamSlug)!;
          const { keySlug: _keySlug, ...data } = metric;
          return { ...data, upstreamId, upstreamKeyId };
        }),
      });

      await tx.incident.createMany({
        data: dataset.incidents.map((incident) => {
          const upstreamId = upstreamIds.get(incident.upstreamSlug);
          const upstreamKeyId = keyIds.get(incident.keySlug);
          if (!upstreamId || !upstreamKeyId) {
            throw new Error(`找不到演示告警关联: ${incident.keySlug}`);
          }
          const {
            upstreamSlug: _upstreamSlug,
            keySlug: _keySlug,
            ...data
          } = incident;
          return { ...data, upstreamId, upstreamKeyId };
        }),
      });
      },
      { timeout: 60_000 }
    );

    console.log(
      `演示数据已就绪：${dataset.upstreams.length} 个上游、${dataset.keys.length} 个密钥、${dataset.metrics.length} 条指标、${dataset.incidents.length} 条告警`
    );
    console.log('演示登录用户名：demo（密码来自 DEMO_ADMIN_PASSWORD）');
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error('演示种子初始化失败:', (error as Error).message);
    process.exitCode = 1;
  });
