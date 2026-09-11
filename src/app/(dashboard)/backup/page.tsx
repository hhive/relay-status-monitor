'use client';

import { DatabaseBackup } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { RemoteBackupView } from '@/components/backup/remote-backup-view';

export default function BackupPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={DatabaseBackup}
        title="数据备份"
        description="Sub2API PostgreSQL 每日远程备份：配置、执行记录与保留策略。备份按 UTC 时间执行，超过保留数量后清理最早的备份。"
      />
      <RemoteBackupView />
    </div>
  );
}
