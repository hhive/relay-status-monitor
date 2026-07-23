export interface ApplicationSecrets {
  sessionSecret: Uint8Array;
  encryptionKey: Uint8Array;
  encryptionSecret: string;
}

type SecretEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveApplicationSecrets(
  environment: SecretEnvironment = process.env,
): ApplicationSecrets {
  const encoder = new TextEncoder();
  const sessionValue = environment.SESSION_SECRET;
  const encryptionValue = environment.APP_ENCRYPTION_KEY;
  const sessionSecret = encoder.encode(sessionValue ?? '');
  const encryptionKey = encoder.encode(encryptionValue ?? '');

  if (sessionSecret.byteLength < 32) {
    throw new Error('SESSION_SECRET 未配置或少于 32 bytes');
  }
  if (encryptionKey.byteLength < 32) {
    throw new Error('APP_ENCRYPTION_KEY 未配置或少于 32 bytes');
  }
  if (sessionValue === encryptionValue) {
    throw new Error('SESSION_SECRET 与 APP_ENCRYPTION_KEY 必须不同');
  }

  return {
    sessionSecret,
    encryptionKey,
    encryptionSecret: encryptionValue!,
  };
}
