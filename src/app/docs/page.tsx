import { redirect } from 'next/navigation';

/** Keep the clean public docs URL stable when the proxy removes the trailing slash. */
export default function PublicDocsEntry() {
  redirect('/docs/index.html');
}
