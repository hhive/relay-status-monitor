/**
 * 告警渠道发送入口 + 飞书 Webhook 实现
 *
 * engine.ts 调用 sendNotification()，本模块负责：
 * 1. 查询所有启用的渠道
 * 2. 分发到具体渠道（当前只有飞书，架构可扩展）
 *
 * 飞书配置格式（AlertChannel.config JSON）：
 * { "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx", "secret": "签名密钥（可选）" }
 */
import { createHmac } from 'crypto';
import type { AlertChannel, Upstream, UpstreamKey } from '@prisma/client';
import { prisma } from '../../db';
import { openAlertChannelConfig } from '../../alert-channel-config';
import { fetchCredentialed, validateFeishuWebhookUrl } from '../../outbound';
import { safeErrorMessage } from '../../safe-error';

interface IncidentLike {
  id: number;
  upstreamId: number;
  upstreamKeyId?: number | null;
  type: string;
  severity: string;
  message: string;
  metricValue?: number | null;
}

interface AccountIncidentLike {
  id: number;
  metric: string;
  severity?: string;
  message: string;
  metricValue?: number | null;
}

interface AccountContext {
  name: string;
  sourceAccountId: string;
  platform: string | null;
}

/** 发送告警通知到所有启用的渠道 */
export async function sendNotification(
  incident: IncidentLike,
  upstream: Upstream,
  key: UpstreamKey | null,
  isRecovery = false
): Promise<void> {
  const channels = await prisma.alertChannel.findMany({ where: { enabled: true } });
  if (channels.length === 0) {
    console.log('[告警] 无启用的通知渠道，跳过发送:', incident.message);
    return;
  }
  const results = await Promise.allSettled(
    channels.map((ch) => sendToChannel(ch, incident, upstream, key, isRecovery))
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[告警] 渠道发送失败:', safeErrorMessage(result.reason));
    }
  }
}

/** 复用同一组渠道发送账号真实流量告警。 */
export async function sendAccountNotification(
  incident: AccountIncidentLike,
  account: AccountContext,
  isRecovery = false,
): Promise<void> {
  const channels = await prisma.alertChannel.findMany({ where: { enabled: true } });
  const results = await Promise.allSettled(channels.map(async (channel) => {
    if (channel.type !== 'feishu') {
      console.warn(`[告警] 未知渠道类型: ${channel.type}`);
      return;
    }
    await sendFeishuAccount(openAlertChannelConfig(channel.config).config, incident, account, isRecovery);
  }));
  for (const result of results) {
    if (result.status === 'rejected') console.error('[告警] 渠道发送失败:', safeErrorMessage(result.reason));
  }
}

async function sendToChannel(
  channel: AlertChannel,
  incident: IncidentLike,
  upstream: Upstream,
  key: UpstreamKey | null,
  isRecovery: boolean
): Promise<void> {
  switch (channel.type) {
    case 'feishu':
      await sendFeishu(openAlertChannelConfig(channel.config).config, incident, upstream, key, isRecovery);
      break;
    default:
      console.warn(`[告警] 未知渠道类型: ${channel.type}`);
  }
}

/** 发送飞书交互式卡片 */
async function sendFeishu(
  config: { webhookUrl: string; secret?: string },
  incident: IncidentLike,
  upstream: Upstream,
  key: UpstreamKey | null,
  isRecovery: boolean
): Promise<void> {
  if (!config?.webhookUrl) {
    console.warn('[飞书] webhookUrl 未配置');
    return;
  }

  const color = isRecovery ? 'green' : severityColor(incident.severity);
  const titlePrefix = isRecovery ? '告警恢复' : '监控告警';
  const groupLabel = key ? key.group : '-';

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: { tag: 'plain_text', content: `${titlePrefix} · ${upstream.name} / ${groupLabel}` },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**上游**\n${upstream.name}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**分组**\n${groupLabel}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**地址**\n${upstream.baseUrl}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**级别**\n${incident.severity}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**类型**\n${formatType(incident.type)}` } },
        ],
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**详情**\n${incident.message}` } },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` },
        ],
      },
    ],
  };

  const body: Record<string, unknown> = { msg_type: 'interactive', card };

  // 飞书签名校验（配置了 secret 时）
  if (config.secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = genSign(timestamp, config.secret);
  }

  const webhookUrl = validateFeishuWebhookUrl(config.webhookUrl);
  const outbound = await fetchCredentialed(
    webhookUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    10_000,
  );
  if (!outbound.ok) throw new Error(outbound.error.message);
  const res = outbound.response;

  if (!res.ok) throw new Error(`飞书 Webhook 发送失败: HTTP ${res.status}`);
  const responseBody = await res.json().catch(() => null) as { code?: unknown } | null;
  if (typeof responseBody?.code === 'number' && responseBody.code !== 0) {
    throw new Error(`飞书返回错误: code=${responseBody.code}`);
  }
}

async function sendFeishuAccount(
  config: { webhookUrl: string; secret?: string },
  incident: AccountIncidentLike,
  account: AccountContext,
  isRecovery: boolean,
): Promise<void> {
  if (!config?.webhookUrl) return;
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: isRecovery ? 'green' : severityColor(incident.severity ?? 'WARNING'),
      title: { tag: 'plain_text', content: `${isRecovery ? '告警恢复' : '监控告警'} · ${account.name}` },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**账号**\n${account.name}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**平台**\n${account.platform ?? '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**账号 ID**\n${account.sourceAccountId}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**指标**\n${incident.metric}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**级别**\n${incident.severity ?? 'WARNING'}` } },
        ],
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**详情**\n${incident.message}` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` }] },
    ],
  };
  const body: Record<string, unknown> = { msg_type: 'interactive', card };
  if (config.secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = genSign(timestamp, config.secret);
  }
  const outbound = await fetchCredentialed(validateFeishuWebhookUrl(config.webhookUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 10_000);
  if (!outbound.ok) throw new Error(outbound.error.message);
  if (!outbound.response.ok) throw new Error(`飞书 Webhook 发送失败: HTTP ${outbound.response.status}`);
  const responseBody = await outbound.response.json().catch(() => null) as { code?: unknown } | null;
  if (typeof responseBody?.code === 'number' && responseBody.code !== 0) throw new Error(`飞书返回错误: code=${responseBody.code}`);
}

function genSign(timestamp: number, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).digest('base64');
}

function severityColor(severity: string): string {
  switch (severity) {
    case 'CRITICAL': return 'red';
    case 'WARNING': return 'orange';
    case 'INFO': return 'blue';
    default: return 'grey';
  }
}

function formatType(type: string): string {
  const map: Record<string, string> = {
    BALANCE_LOW: '余额不足',
    LATENCY_HIGH: '延迟过高',
    UNAVAILABLE: '不可用',
    AVAILABILITY_LOW: '可用率低',
    TEST_FAILED: '测速失败',
  };
  return map[type] || type;
}
