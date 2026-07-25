export type ProviderErrorPhase = 'upstream' | 'account_auth' | 'network' | string;

export interface ProviderErrorInput {
  accountId: number;
  errorOwner?: string | null;
  errorPhase?: ProviderErrorPhase | null;
}

export interface ProviderErrorKeyInput {
  accountId: number;
  clientRequestId?: string | null;
  requestId: string;
}

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface BillingSnapshot {
  accountStatsCost?: string | number | null;
  totalCost?: string | number | null;
  rateMultiplier?: string | number | null;
}

export type LatencyHistogram = Record<string, number>;

export interface BillingRateSnapshot {
  status: string | null;
  billingScope: string | null;
  resolvedRateMultiplier: number | null;
  peakRateEnabled: boolean | null;
  peakStart: string | null;
  peakEnd: string | null;
  peakRateMultiplier: number | null;
  timezone: string | null;
  receivedAt: Date | null;
  freshUntil: Date | null;
}

export function isEligibleProviderError(input: ProviderErrorInput): boolean {
  return input.accountId > 0
    && input.errorOwner === 'provider'
    && ['upstream', 'account_auth', 'network'].includes(input.errorPhase ?? '');
}

export function providerErrorKey(input: ProviderErrorKeyInput): string {
  const requestId = input.clientRequestId?.trim() || input.requestId;
  return `${input.accountId}:${requestId}`;
}

export function cacheHitRate(tokens: TokenUsage): number | null {
  const denominator = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens;
  return denominator === 0 ? null : tokens.cacheReadTokens / denominator;
}

export function decimalToMicroUsd(value: string | number | null | undefined): bigint {
  const text = String(value ?? '0').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return BigInt(0);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const padded = `${fraction}000000`;
  const micro = BigInt(whole) * BigInt(1000000) + BigInt(padded.slice(0, 6));
  const rounded = fraction.length > 6 && Number(padded[6]) >= 5 ? micro + BigInt(1) : micro;
  return negative ? -rounded : rounded;
}

export function snapshotBillingMicroUsd(snapshot: BillingSnapshot): number {
  const base = decimalToMicroUsd(snapshot.accountStatsCost ?? snapshot.totalCost);
  const multiplier = decimalToMicroUsd(snapshot.rateMultiplier ?? 1);
  const result = (base * multiplier + BigInt(500000)) / BigInt(1000000);
  return Number(result);
}

export function effectiveBillingRate(snapshot: BillingRateSnapshot, now = new Date()): number | null {
  const base = snapshot.resolvedRateMultiplier;
  if (snapshot.status !== 'ok' || snapshot.billingScope !== 'token' || base == null || base < 0 ||
      !snapshot.receivedAt || !snapshot.freshUntil || snapshot.receivedAt.getTime() > now.getTime() + 5 * 60_000 ||
      snapshot.freshUntil <= snapshot.receivedAt || now > snapshot.freshUntil) return null;
  if (snapshot.peakRateEnabled === false) return base;
  if (snapshot.peakRateEnabled !== true || !snapshot.timezone || snapshot.peakRateMultiplier == null || snapshot.peakRateMultiplier < 0) return null;
  const parseMinute = (value: string | null) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value ?? '');
    if (!match) return null;
    const hour = Number(match[1]); const minute = Number(match[2]);
    return hour < 24 && minute < 60 ? hour * 60 + minute : null;
  };
  const start = parseMinute(snapshot.peakStart); const end = parseMinute(snapshot.peakEnd);
  if (start == null || end == null || start >= end) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: snapshot.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const minute = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
    return minute >= start && minute < end ? base * snapshot.peakRateMultiplier : base;
  } catch {
    return null;
  }
}

export function minuteBucket(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 60_000) * 60_000);
}

export function beijingTodayWindow(now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const start = new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - 8 * 60 * 60 * 1000);
  return { start, end: now };
}

export function mergeLatencyHistogram(histograms: LatencyHistogram[]): LatencyHistogram {
  return histograms.reduce<LatencyHistogram>((merged, histogram) => {
    for (const [bucket, count] of Object.entries(histogram)) merged[bucket] = (merged[bucket] ?? 0) + count;
    return merged;
  }, {});
}

export function histogramP95(histogram: LatencyHistogram): number | null {
  const entries = Object.entries(histogram)
    .map(([bucket, count]) => [Number(bucket), count] as const)
    .filter(([bucket, count]) => Number.isFinite(bucket) && count > 0)
    .sort(([left], [right]) => left - right);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * 0.95);
  let seen = 0;
  for (const [bucket, count] of entries) {
    seen += count;
    if (seen >= target) return bucket;
  }
  return entries.at(-1)?.[0] ?? null;
}
