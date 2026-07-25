import { NextResponse } from 'next/server';
import { runAccountObservabilityCycle } from '@/lib/account-observability/collector';

/**
 * 定时采集入口
 * 由外部 crontab 每分钟触发：
 *   * * * * * curl -H "Authorization: Bearer $CRON_SECRET" https://your-monitor.example/api/cron/collect
 */
export async function GET(request: Request) {
  const start = Date.now();
  try {
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET 未配置' }, { status: 500 });
    }
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const accountObservability = await runAccountObservabilityCycle();
    const elapsed = Date.now() - start;
    return NextResponse.json({
      ok: true,
      elapsedMs: elapsed,
      time: new Date().toISOString(),
      accountObservability,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: '采集任务执行失败' },
      { status: 500 }
    );
  }
}
