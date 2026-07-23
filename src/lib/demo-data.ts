export type DemoUpstreamType = 'SUB2API' | 'NEW_API';
export type DemoUpstreamStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';
export type DemoIncidentType =
  | 'BALANCE_LOW'
  | 'LATENCY_HIGH'
  | 'UNAVAILABLE'
  | 'AVAILABILITY_LOW'
  | 'TEST_FAILED';
export type DemoSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface DemoUpstreamRecord {
  slug: string;
  name: string;
  baseUrl: string;
  type: DemoUpstreamType;
  status: DemoUpstreamStatus;
  enabled: boolean;
  priority: number;
  testModel: string;
}

export interface DemoKeyRecord {
  slug: string;
  upstreamSlug: string;
  baseUrl: string;
  group: string;
  label: string;
  keyName: string | null;
  groupName: string | null;
  groupDescription: string | null;
  groupRateMultiplier: number | null;
  remoteKeyId: string | null;
  metadataSyncedAt: Date | null;
  metadataError: string | null;
  hasApiKey: boolean;
  hasAccessToken: boolean;
  status: DemoUpstreamStatus;
  lastBalance: number | null;
  lastLatencyMs: number | null;
  lastCollectedAt: Date | null;
  lastError: string | null;
  testModel: string | null;
  enabled: boolean;
}

export interface DemoMetricRecord {
  keySlug: string;
  balance: number | null;
  latencyMs: number | null;
  modelTestOk: boolean | null;
  modelTestLatMs: number | null;
  streamTps: number | null;
  streamFirstLat: number | null;
  success: boolean;
  errorMessage: string | null;
  recordedAt: Date;
}

export interface DemoIncidentRecord {
  upstreamSlug: string;
  keySlug: string;
  type: DemoIncidentType;
  severity: DemoSeverity;
  message: string;
  metricValue: number | null;
  resolved: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface DemoAlertRuleRecord {
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  severity: DemoSeverity;
  cooldownMin: number;
  enabled: boolean;
}

export interface DemoAlertChannelRecord {
  name: string;
  type: string;
  config: Record<string, string>;
  enabled: boolean;
}

export interface DemoDataset {
  upstreams: DemoUpstreamRecord[];
  keys: DemoKeyRecord[];
  metrics: DemoMetricRecord[];
  incidents: DemoIncidentRecord[];
  alertRules: DemoAlertRuleRecord[];
  alertChannels: DemoAlertChannelRecord[];
  settings: Record<string, string>;
}

export interface DemoSeedEnvironment {
  databaseUrl: string;
  appEncryptionKey: string;
  sessionSecret: string;
  demoAdminPassword: string;
}

export function requireSeedValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} 必须显式设置，seed 不提供默认凭证`);
  return value;
}

export function readDemoSeedEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): DemoSeedEnvironment {
  return {
    databaseUrl: requireSeedValue(environment, 'DATABASE_URL'),
    appEncryptionKey: requireSeedValue(environment, 'APP_ENCRYPTION_KEY'),
    sessionSecret: requireSeedValue(environment, 'SESSION_SECRET'),
    demoAdminPassword: requireSeedValue(environment, 'DEMO_ADMIN_PASSWORD'),
  };
}

const UPSTREAMS: DemoUpstreamRecord[] = [
  upstream('aurora', 'Aurora Relay', 'NEW_API', 'ONLINE', 120, 'gpt-4o-mini'),
  upstream('borealis', 'Borealis Gateway', 'SUB2API', 'DEGRADED', 110, 'claude-3-5-haiku'),
  upstream('citrine', 'Citrine Cloud', 'NEW_API', 'OFFLINE', 100, 'gpt-4o-mini'),
  upstream('dahlia', 'Dahlia Edge', 'SUB2API', 'UNKNOWN', 90, 'gemini-2.0-flash'),
  upstream('ember', 'Ember AI', 'NEW_API', 'ONLINE', 80, 'gpt-4o-mini'),
  upstream('fjord', 'Fjord Bridge', 'SUB2API', 'ONLINE', 70, 'claude-3-5-haiku'),
  upstream('grove', 'Grove Models', 'NEW_API', 'DEGRADED', 60, 'gpt-4o-mini'),
  upstream('harbor', 'Harbor Route', 'SUB2API', 'ONLINE', 50, 'gemini-2.0-flash'),
  upstream('ion', 'Ion Compute', 'NEW_API', 'OFFLINE', 40, 'gpt-4o-mini'),
  upstream('juniper', 'Juniper Hub', 'SUB2API', 'ONLINE', 30, 'claude-3-5-haiku'),
  upstream('kepler', 'Kepler Proxy', 'NEW_API', 'UNKNOWN', 20, 'gpt-4o-mini'),
  upstream('lumen', 'Lumen Relay', 'SUB2API', 'DEGRADED', 10, 'gemini-2.0-flash'),
];

interface KeyTemplate {
  upstreamSlug: string;
  group: string;
  label: string;
  status: DemoUpstreamStatus;
  balance: number | null;
  latency: number | null;
  description: string;
  rate?: number;
  keyName?: string;
  testModel?: string;
  hasApiKey?: boolean;
  hasAccessToken?: boolean;
  lastError?: string;
}

const KEY_TEMPLATES: KeyTemplate[] = [
  key('aurora', 'gptplus', 'Primary traffic', 'ONLINE', 128.42, 312, 'Balanced team pool', 0.06, true),
  key('aurora', 'fast-lane', 'Fast lane', 'ONLINE', 74.18, 228, 'Low-latency premium pool', 0.12, true),
  key('borealis', 'default', 'Default pool', 'DEGRADED', 52.37, 1240, 'General purpose pool', 0.08, false, '间歇性延迟升高'),
  key('borealis', 'economy', 'Economy pool', 'DEGRADED', 31.66, 1668, 'Cost-optimized routing', 0.03, false, '模型测试偶发超时'),
  key('citrine', 'gptplus', 'Primary pool', 'OFFLINE', 12.38, null, 'Primary model pool', 0.07, true, '连接失败（演示）'),
  key('citrine', 'backup', 'Backup pool', 'OFFLINE', 6.2, null, 'Backup capacity', 0.05, true, '连接失败（演示）'),
  key('dahlia', 'default', 'Default route', 'UNKNOWN', null, null, 'Awaiting first collection', undefined, false, '尚未完成首次采集'),
  key('ember', 'team', 'Team workspace', 'ONLINE', 96.14, 405, 'Shared team traffic', 0.09, true),
  key('ember', 'batch', 'Batch jobs', 'ONLINE', 44.8, 690, 'Asynchronous batch pool', 0.04, true),
  key('fjord', 'default', 'Default route', 'ONLINE', 83.6, 540, 'General purpose route', 0.07),
  key('fjord', 'reserve', 'Reserve route', 'ONLINE', 61.25, 620, 'Standby failover capacity', 0.05),
  key('grove', 'vision', 'Vision requests', 'DEGRADED', 24.36, 1790, 'Multimodal request pool', 0.15, true, '视觉模型响应较慢'),
  key('grove', 'reasoning', 'Reasoning jobs', 'DEGRADED', 18.72, 2320, 'Reasoning model pool', 0.25, true, '推理请求偶发超时'),
  key('harbor', 'default', 'Default route', 'ONLINE', 108.56, 470, 'Stable regional route', 0.06),
  key('harbor', 'priority', 'Priority route', 'ONLINE', 76.04, 350, 'Priority support route', 0.11),
  key('ion', 'reasoning', 'Reasoning pool', 'OFFLINE', 3.75, null, 'Offline reasoning pool', 0.2, true, '服务不可用（演示）'),
  key('juniper', 'default', 'Default route', 'ONLINE', 67.91, 580, 'Everyday request route', 0.05),
  key('juniper', 'sandbox', 'Sandbox route', 'ONLINE', 15.44, 760, 'Isolated test route', 0.02, false),
  key('kepler', 'canary', 'Canary token', 'UNKNOWN', null, null, 'Canary route awaiting setup', 0.01, false, '尚未配置 API Key'),
  key('lumen', 'partner', 'Partner route', 'DEGRADED', 27.08, 1480, 'Partner integration route', 0.1, false, '上游响应不稳定'),
];

const ALERT_RULES: DemoAlertRuleRecord[] = [
  rule('余额不足-严重', 'balance', 'lt', 10, 'CRITICAL', 60),
  rule('余额不足-警告', 'balance', 'lt', 30, 'WARNING', 120),
  rule('延迟过高', 'latency', 'gt', 3000, 'WARNING', 30),
  rule('连续失败', 'consecutive_failures', 'gte', 3, 'CRITICAL', 30),
  rule('可用率低', 'availability', 'lt', 95, 'WARNING', 60),
];

function upstream(
  slug: string,
  name: string,
  type: DemoUpstreamType,
  status: DemoUpstreamStatus,
  priority: number,
  testModel: string
): DemoUpstreamRecord {
  return {
    slug,
    name,
    baseUrl: `https://${slug}.example`,
    type,
    status,
    enabled: true,
    priority,
    testModel,
  };
}

function key(
  upstreamSlug: string,
  group: string,
  label: string,
  status: DemoUpstreamStatus,
  balance: number | null,
  latency: number | null,
  description: string,
  rate?: number,
  hasAccessToken = false,
  lastError?: string
): KeyTemplate {
  return {
    upstreamSlug,
    group,
    label,
    status,
    balance,
    latency,
    description,
    rate,
    hasApiKey: status !== 'UNKNOWN' || !lastError?.includes('未配置'),
    hasAccessToken,
    lastError,
  };
}

function rule(
  name: string,
  metric: string,
  operator: string,
  threshold: number,
  severity: DemoSeverity,
  cooldownMin: number
): DemoAlertRuleRecord {
  return { name, metric, operator, threshold, severity, cooldownMin, enabled: true };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildMetrics(keys: DemoKeyRecord[], referenceDate: Date): DemoMetricRecord[] {
  const metrics: DemoMetricRecord[] = [];

  keys.forEach((keyRecord, keyIndex) => {
    for (let day = 0; day < 7; day += 1) {
      for (let sample = 0; sample < 8; sample += 1) {
        const hoursAgo = (6 - day) * 24 + (7 - sample) * 3;
        const recordedAt = new Date(referenceDate.getTime() - hoursAgo * 60 * 60 * 1000);
        const variation = ((day * 8 + sample + keyIndex) % 5) - 2;
        const unavailable = keyRecord.status === 'OFFLINE' || keyRecord.status === 'UNKNOWN';
        const intermittentFailure =
          keyRecord.status === 'DEGRADED' && (sample + day + keyIndex) % 9 === 0;
        const failed = unavailable || intermittentFailure;
        const balance = keyRecord.lastBalance === null
          ? null
          : round(Math.max(0, keyRecord.lastBalance - (6 - day) * 0.35 + variation * 0.08));
        const latency = failed || keyRecord.lastLatencyMs === null
          ? null
          : Math.max(120, keyRecord.lastLatencyMs + variation * 24 + (keyRecord.status === 'DEGRADED' ? day * 45 : 0));

        metrics.push({
          keySlug: keyRecord.slug,
          balance,
          latencyMs: latency,
          modelTestOk: failed ? false : true,
          modelTestLatMs: latency === null ? null : latency + 80,
          streamTps: latency === null ? null : round(Math.max(4, 42 - latency / 80 + variation)),
          streamFirstLat: latency === null ? null : latency + 110,
          success: !failed,
          errorMessage: failed ? keyRecord.lastError : null,
          recordedAt,
        });
      }
    }
  });

  return metrics;
}

function buildIncidents(keys: DemoKeyRecord[], referenceDate: Date): DemoIncidentRecord[] {
  const bySlug = new Map(keys.map((keyRecord) => [keyRecord.slug, keyRecord]));
  const incident = (
    keySlug: string,
    type: DemoIncidentType,
    severity: DemoSeverity,
    message: string,
    metricValue: number | null,
    resolved: boolean,
    ageHours: number,
    resolvedAgeHours?: number
  ): DemoIncidentRecord => {
    const keyRecord = bySlug.get(keySlug);
    if (!keyRecord) throw new Error(`找不到演示告警密钥: ${keySlug}`);
    return {
      upstreamSlug: keyRecord.upstreamSlug,
      keySlug,
      type,
      severity,
      message,
      metricValue,
      resolved,
      resolvedAt: resolved
        ? new Date(referenceDate.getTime() - (resolvedAgeHours ?? ageHours - 2) * 60 * 60 * 1000)
        : null,
      createdAt: new Date(referenceDate.getTime() - ageHours * 60 * 60 * 1000),
    };
  };

  return [
    incident('aurora-gptplus', 'TEST_FAILED', 'INFO', '[Aurora Relay / gptplus] 一次模型测试超时，随后已恢复', 1820, true, 66, 64),
    incident('borealis-default', 'LATENCY_HIGH', 'WARNING', '[Borealis Gateway / default] 延迟 1240ms 高于演示阈值 1000ms', 1240, false, 4),
    incident('grove-vision', 'AVAILABILITY_LOW', 'WARNING', '[Grove Models / vision] 最近1小时可用率 88.0% 低于阈值 95%', 88, false, 7),
    incident('citrine-gptplus', 'UNAVAILABLE', 'CRITICAL', '[Citrine Cloud / gptplus] 连续 6 次采集失败', 6, false, 2),
    incident('citrine-backup', 'BALANCE_LOW', 'WARNING', '[Citrine Cloud / backup] 余额 $6.20 低于阈值 $30', 6.2, false, 20),
    incident('ion-reasoning', 'BALANCE_LOW', 'CRITICAL', '[Ion Compute / reasoning] 余额 $3.75 低于阈值 $10', 3.75, true, 96, 72),
    incident('dahlia-default', 'UNAVAILABLE', 'INFO', '[Dahlia Edge / default] 尚未完成首次采集', null, true, 120, 96),
  ];
}

export function buildDemoDataset(
  referenceDate: Date,
): DemoDataset {
  const now = new Date(referenceDate.getTime());
  if (Number.isNaN(now.getTime())) throw new Error('演示数据参考时间无效');

  const upstreams = UPSTREAMS.map((record) => ({ ...record }));
  const upstreamBySlug = new Map(upstreams.map((record) => [record.slug, record]));
  const keys = KEY_TEMPLATES.map((template, index): DemoKeyRecord => {
    const parent = upstreamBySlug.get(template.upstreamSlug);
    if (!parent) throw new Error(`找不到演示上游: ${template.upstreamSlug}`);
    const isNewApi = parent.type === 'NEW_API';
    const synced = template.status !== 'UNKNOWN';
    return {
      slug: `${template.upstreamSlug}-${template.group}`,
      upstreamSlug: template.upstreamSlug,
      baseUrl: parent.baseUrl,
      group: template.group,
      label: template.label,
      keyName: isNewApi ? template.keyName || `${parent.name} ${template.label}` : null,
      groupName: template.group,
      groupDescription: template.description,
      groupRateMultiplier: template.rate ?? null,
      remoteKeyId: isNewApi ? `demo-${template.upstreamSlug}-${index + 1}` : null,
      metadataSyncedAt: synced ? new Date(now.getTime() - (index + 1) * 60 * 60 * 1000) : null,
      metadataError: synced ? null : template.lastError || '尚未同步元数据',
      hasApiKey: template.hasApiKey ?? true,
      hasAccessToken: isNewApi && Boolean(template.hasAccessToken),
      status: template.status,
      lastBalance: template.balance,
      lastLatencyMs: template.latency,
      lastCollectedAt: synced ? new Date(now.getTime() - (index % 4) * 15 * 60 * 1000) : null,
      lastError: template.lastError || null,
      testModel: template.testModel || null,
      enabled: true,
    };
  });

  return {
    upstreams,
    keys,
    metrics: buildMetrics(keys, now),
    incidents: buildIncidents(keys, now),
    alertRules: ALERT_RULES.map((record) => ({ ...record })),
    alertChannels: [
      {
        name: '演示告警通道',
        type: 'feishu',
        config: { webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-disabled' },
        enabled: false,
      },
    ],
    settings: {
      light_interval_minutes: '1',
      heavy_interval_minutes: '15',
      test_model: 'gpt-4o-mini',
      test_timeout_ms: '15000',
      retention_days: '90',
      timezone: 'Asia/Shanghai',
      demo_mode: 'true',
    },
  };
}
