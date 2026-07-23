import { Prisma, PrismaClient } from '@prisma/client';
import {
  isSealedAlertChannelConfig,
  openAlertChannelConfig,
  sealAlertChannelConfig,
} from '../src/lib/alert-channel-config';

async function main() {
  const prisma = new PrismaClient();
  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const channels = await prisma.alertChannel.findMany({
      where: { type: 'feishu' },
      select: { id: true, config: true },
      orderBy: { id: 'asc' },
    });
    scanned = channels.length;
    for (const channel of channels) {
      if (isSealedAlertChannelConfig(channel.config) && channel.config.version === 1) {
        skipped += 1;
        continue;
      }
      try {
        const opened = openAlertChannelConfig(channel.config);
        await prisma.alertChannel.update({
          where: { id: channel.id },
          data: {
            config: sealAlertChannelConfig(opened.config) as unknown as Prisma.InputJsonValue,
          },
        });
        migrated += 1;
      } catch {
        failed += 1;
      }
    }
    console.log(JSON.stringify({ scanned, migrated, skipped, failed }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error('配置迁移失败');
  process.exitCode = 1;
});
