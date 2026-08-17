/**
 * 账号告警的飞书 Webhook 实现
 *
 * 查询启用的渠道并分发账号真实流量告警。
 *
 * 飞书配置格式（AlertChannel.config JSON）：
 * { "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx", "secret": "签名密钥（可选）" }
 */
import { createHmac } from 'crypto';
import { prisma } from '../../db';
import { openAlertChannelConfig } from '../../alert-channel-config';
import { fetchCredentialed, validateFeishuWebhookUrl } from '../../outbound';
import { safeErrorMessage } from '../../safe-error';

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

interface OperationalIncidentLike {
  id: number;
  subjectName: string;
  detail: string;
  recoveryDetail?: string | null;
  severity: string;
}

interface OperationalRuleContext {
  key: string;
  name: string;
}

/** 复用同一组渠道发送账号真实流量告警。 */
export async function sendAccountNotification(
  incident: AccountIncidentLike,
  account: AccountContext,
  isRecovery = false,
  alreadyDeliveredChannelIds: readonly number[] = [],
  onDelivered: (channelId: number) => Promise<void> = async () => {},
): Promise<void> {
  if (incident.severity !== 'CRITICAL') return;
  const channels = await prisma.alertChannel.findMany({ where: { enabled: true } });
  const deliveredChannelIds = new Set(alreadyDeliveredChannelIds);
  let failed = false;
  for (const channel of channels) {
    if (deliveredChannelIds.has(channel.id)) continue;
    try {
      if (channel.type !== 'feishu') {
        throw new Error(`不支持的通知渠道: ${channel.type}`);
      }
      await sendFeishuAccount(openAlertChannelConfig(channel.config).config, incident, account, isRecovery);
      await onDelivered(channel.id);
      deliveredChannelIds.add(channel.id);
    } catch (error) {
      failed = true;
      console.error('[告警] 渠道发送失败:', safeErrorMessage(error));
    }
  }
  if (failed) throw new Error('账号告警通知发送失败');
}

/** 仅向启用渠道发送 CRITICAL 级别的系统运维告警。 */
export async function sendOperationalNotification(
  incident: OperationalIncidentLike,
  rule: OperationalRuleContext,
  isRecovery = false,
  alreadyDeliveredChannelIds: readonly number[] = [],
  onDelivered: (channelId: number) => Promise<void> = async () => {},
): Promise<void> {
  if (incident.severity !== 'CRITICAL') return;
  const channels = await prisma.alertChannel.findMany({ where: { enabled: true } });
  const deliveredChannelIds = new Set(alreadyDeliveredChannelIds);
  let failed = false;
  for (const channel of channels) {
    if (deliveredChannelIds.has(channel.id)) continue;
    try {
      if (channel.type !== 'feishu') throw new Error(`不支持的通知渠道: ${channel.type}`);
      await sendFeishuOperational(openAlertChannelConfig(channel.config).config, incident, rule, isRecovery);
      await onDelivered(channel.id);
      deliveredChannelIds.add(channel.id);
    } catch (error) {
      failed = true;
      console.error('[运维告警] 渠道发送失败:', safeErrorMessage(error));
    }
  }
  if (failed) throw new Error('运维告警通知发送失败');
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
          { is_short: true, text: { tag: 'lark_md', content: `**指标**\n${accountMetricLabel(incident.metric)}` } },
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

async function sendFeishuOperational(
  config: { webhookUrl: string; secret?: string },
  incident: OperationalIncidentLike,
  rule: OperationalRuleContext,
  isRecovery: boolean,
): Promise<void> {
  if (!config?.webhookUrl) return;
  const detail = isRecovery ? incident.recoveryDetail ?? '运行状态已恢复' : incident.detail;
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: isRecovery ? 'green' : severityColor(incident.severity),
      title: { tag: 'plain_text', content: `${isRecovery ? '系统告警恢复' : '系统运维告警'} · ${rule.name}` },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**规则**\n${rule.name}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**规则键**\n${rule.key}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**主题**\n${incident.subjectName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**阶段**\n${isRecovery ? '恢复' : '触发'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**级别**\n${incident.severity}` } },
        ],
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**详情**\n${detail}` } },
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

function accountMetricLabel(metric: string): string {
  if (metric === 'balance_low') return '上游余额低';
  if (metric === 'upstream_rate_deviation') return '上游倍率偏差高';
  return metric;
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
