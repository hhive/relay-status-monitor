'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import { ACCOUNT_METRIC_DEFINITIONS, formatAccountMetric, type AccountAggregateMetricKey } from '@/lib/account-metric-definitions';
import type { AccountCoverageDto, AccountTrendPointDto, AccountWindowDto } from '@/lib/account-observability-ui';
import { MetricDefinitionTooltip } from './metric-definition-tooltip';

export interface AccountTrendSeries {
  key: AccountAggregateMetricKey;
  color: string;
}

interface AccountTrendChartProps {
  data: AccountTrendPointDto[];
  series: AccountTrendSeries[];
  window: AccountWindowDto;
  coverage: AccountCoverageDto;
}

export function AccountTrendChart({ data, series, window, coverage }: AccountTrendChartProps) {
  const chartData = data.map((point) => ({
    ...point,
    ...Object.fromEntries(series.map(({ key }) => [key, point.complete ? point[key] : null])),
  }));
  const hasSamples = chartData.some((point) => point.complete && series.some(({ key }) => point[key] != null));

  if (!hasSamples) {
    return <div className="flex h-64 items-center justify-center border-y text-sm text-muted-foreground">暂无数据：当前窗口没有可用样本</div>;
  }

  return (
    <div className="space-y-3" role="region" aria-label={`${window.label}账号指标趋势`}>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {series.map(({ key, color }) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
            <MetricDefinitionTooltip metric={key} compact window={window} coverage={coverage} />
          </span>
        ))}
      </div>
      <div className="h-72 min-h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
            <XAxis dataKey="bucketStart" minTickGap={36} tickFormatter={formatAxisTime} tick={{ fontSize: 11 }} />
            <YAxis width={54} tick={{ fontSize: 11 }} />
            <RechartsTooltip content={<TrendTooltip series={series} />} />
            {series.map(({ key, color }) => (
              <Line key={key} type="monotone" dataKey={key} name={ACCOUNT_METRIC_DEFINITIONS[key].label} stroke={color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TrendTooltip({ active, payload, series }: { active?: boolean; payload?: Array<{ payload: AccountTrendPointDto }>; series: AccountTrendSeries[] }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="max-w-72 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
      <p className="mb-2 font-medium">{formatBeijing(point.bucketStart)}</p>
      {series.map(({ key, color }) => <p key={key} className="mt-1" style={{ color }}>{ACCOUNT_METRIC_DEFINITIONS[key].label}：{formatAccountMetric(key, point[key] as number | string | null)}</p>)}
      <p className="mt-2 text-muted-foreground">样本：{series.some(({ key }) => key === 'cacheHitRate' || key === 'promptTokens') ? `${point.promptTokens} Prompt Token` : `${point.eligibleCount} 个有效请求`}</p>
      <p className="text-muted-foreground">完整性：{point.complete ? '完整' : '数据不完整'}</p>
    </div>
  );
}

function formatAxisTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatBeijing(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
