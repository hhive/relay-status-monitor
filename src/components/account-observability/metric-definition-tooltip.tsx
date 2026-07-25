'use client';

import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ACCOUNT_METRIC_DEFINITIONS, type AccountMetricKey } from '@/lib/account-metric-definitions';
import type { AccountCoverageDto, AccountWindowDto } from '@/lib/account-observability-ui';
import { cn } from '@/lib/utils';

interface MetricDefinitionTooltipProps {
  metric: AccountMetricKey;
  value?: React.ReactNode;
  window?: AccountWindowDto;
  coverage?: AccountCoverageDto;
  compact?: boolean;
  className?: string;
}

export function MetricDefinitionTooltip({ metric, value, window, coverage, compact = false, className }: MetricDefinitionTooltipProps) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const definition = ACCOUNT_METRIC_DEFINITIONS[metric];
  const coverageText = coverage?.complete ? '完整' : '数据不完整';

  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={180}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn('group inline-flex max-w-full items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
          aria-label={`查看${definition.label}统计口径`}
          aria-describedby={open ? contentId : undefined}
          onClick={() => setOpen((current) => !current)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen((current) => !current);
            }
          }}
        >
          <span className={cn(compact ? 'text-xs font-medium text-muted-foreground' : 'min-w-0', !compact && value != null && 'flex flex-col gap-1')}>
            <span className="inline-flex items-center gap-1">
              {definition.label}
              <Info className="size-3.5 shrink-0 opacity-55 group-hover:opacity-100" aria-hidden="true" />
            </span>
            {!compact && value != null ? <span className="break-words text-xl font-semibold text-foreground">{value}</span> : null}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent id={contentId} side="top" collisionPadding={12} className="max-w-[min(22rem,calc(100vw-1.5rem))] space-y-1.5 bg-popover p-3 text-popover-foreground shadow-lg">
        <p className="font-semibold">{definition.label}</p>
        <p>当前窗口：{window?.label ?? '当前查询窗口'}</p>
        <p>公式：{definition.formula}</p>
        <p>数据源：{definition.source}</p>
        <p>样本：{definition.sample}</p>
        {coverage ? <p>实际覆盖：{coverage.earliestBucket ? formatBeijing(coverage.earliestBucket) : '无'} 至 {coverage.latestBucket ? formatBeijing(coverage.latestBucket) : '无'}</p> : null}
        <p>完整性：{coverage ? coverageText : '按数据点显示'}</p>
        <p>空值：{definition.empty}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function formatBeijing(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
