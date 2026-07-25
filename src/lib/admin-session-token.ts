import type { NextResponse } from 'next/server';

import type { AdminClaims } from '@/lib/admin-sso';

/** Task 2 replaces this fail-closed boundary with signed admin session handling. */
export async function createAdminSession(
  _claims: AdminClaims,
  _ttlSeconds: number,
): Promise<string> {
  throw new Error('Admin session signing is not implemented');
}

/** Task 2 replaces this fail-closed boundary with the hardened session cookie. */
export function attachAdminSession(
  _response: NextResponse,
  _token: string,
  _ttlSeconds: number,
): void {
  throw new Error('Admin session attachment is not implemented');
}
