const secret = process.env.CRON_SECRET?.trim();

if (!secret) {
  console.error('relay monitor backup failed: CRON_SECRET is not configured');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch('http://127.0.0.1:3305/api/cron/backup', {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(55_000),
    });
    if (!response.ok) {
      console.error(`relay monitor backup failed: HTTP ${response.status}`);
      process.exitCode = 1;
    }
  } catch {
    console.error('relay monitor backup failed: request error');
    process.exitCode = 1;
  }
}
