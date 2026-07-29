import { decrypt, encrypt } from '../crypto';
import type { UpstreamBalanceMode } from './upstream-balance';

const MAX_ACCESS_TOKEN_LENGTH = 4096;

interface StoredBalanceCredential {
  mode: string;
  newApiUserId: string | null;
  newApiAccessTokenCiphertext: string | null;
}

export function normalizeBalanceMode(value: unknown): UpstreamBalanceMode | null {
  if (typeof value !== 'string') return null;
  const mode = value.toLowerCase();
  return mode === 'auto' || mode === 'sub2api' || mode === 'newapi' ? mode : null;
}

export function sealNewApiAccessToken(value: string): string {
  const token = value.trim();
  if (!token || token.length > MAX_ACCESS_TOKEN_LENGTH) throw new Error('invalid New API access token');
  return encrypt(token);
}

export function openNewApiAccessToken(ciphertext: string): string | null {
  try {
    const token = decrypt(ciphertext).trim();
    return token && token.length <= MAX_ACCESS_TOKEN_LENGTH ? token : null;
  } catch {
    return null;
  }
}

export function toSafeBalanceCredential(value: StoredBalanceCredential) {
  return {
    mode: normalizeBalanceMode(value.mode) ?? 'auto',
    newApiUserId: value.newApiUserId,
    accessTokenConfigured: Boolean(value.newApiAccessTokenCiphertext),
  };
}
