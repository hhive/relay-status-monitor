import { ListRestart } from 'lucide-react';
import { SchedulingActions } from '@/components/alert-records/alert-records-view';
import { PageHeader } from '@/components/page-header';

export default function SchedulingRecordsPage() {
  return (
    <div className="space-y-6">
      <PageHeader icon={ListRestart} title="调整记录" />
      <SchedulingActions />
    </div>
  );
}
