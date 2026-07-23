export function buildSettingsUpdatePayload(
  settings: Record<string, string | boolean>,
): Record<string, string> {
  const payload = Object.fromEntries(
    Object.entries(settings).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  delete payload.cron_secret;
  delete payload.cron_secret_configured;
  return payload;
}
