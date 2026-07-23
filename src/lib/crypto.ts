import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { resolveApplicationSecrets } from '@/lib/auth-config';

/**
 * AES-256-GCM 加密工具
 * 用于安全存储上游 API Key
 * 密钥派生自 APP_ENCRYPTION_KEY（scrypt）
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 12 字节
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

function getSecret(): string {
  return resolveApplicationSecrets().encryptionSecret;
}

/**
 * 加密明文，返回 base64 字符串
 * 格式：base64(salt + iv + ciphertext + authTag)
 */
export function encrypt(plaintext: string): string {
  const secret = getSecret();
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(secret, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, encrypted, authTag]).toString('base64');
}

/**
 * 解密 base64 字符串
 */
export function decrypt(ciphertextB64: string): string {
  const secret = getSecret();
  const data = Buffer.from(ciphertextB64, 'base64');
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(data.length - 16);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH, data.length - 16);
  const key = deriveKey(secret, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * 安全解密，失败返回 null（不抛异常）
 */
export function tryDecrypt(ciphertextB64: string): string | null {
  try {
    return decrypt(ciphertextB64);
  } catch {
    return null;
  }
}
