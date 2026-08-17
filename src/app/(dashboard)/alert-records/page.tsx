import { Suspense } from 'react';
import { AlertRecordsView } from '@/components/alert-records/alert-records-view';

export default function AlertRecordsPage() {
  return (
    <Suspense>
      <AlertRecordsView />
    </Suspense>
  );
}
