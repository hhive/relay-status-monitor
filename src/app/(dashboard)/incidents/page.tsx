import { redirect } from 'next/navigation';

export default function LegacyIncidentsPage() {
  redirect('/alert-records?type=account');
}
