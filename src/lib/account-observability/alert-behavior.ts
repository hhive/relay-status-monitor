import { isAccountPriority, MAX_ACCOUNT_PRIORITY } from '../account-priority';

export interface AlertBehaviorSettings {
  confirmationWindowMinutes: number;
  confirmationCount: number;
  priorityFactor: number;
}

export interface AlertCandidateState {
  windowStartedAt: Date;
  lastTriggeredAt: Date;
  triggerCount: number;
}

const MAX_WINDOW_MINUTES = 60;
const MAX_CONFIRMATION_COUNT = 20;
const MAX_PRIORITY_FACTOR = 1_000;

function integerSetting(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value == null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`invalid ${name}`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`invalid ${name}`);
  return parsed;
}

export function parseAlertBehaviorSettings(values: Record<string, unknown>): AlertBehaviorSettings {
  return {
    confirmationWindowMinutes: integerSetting(values.alert_confirmation_window_minutes, 5, 1, MAX_WINDOW_MINUTES, 'confirmation window'),
    confirmationCount: integerSetting(values.alert_confirmation_count, 2, 1, MAX_CONFIRMATION_COUNT, 'confirmation count'),
    priorityFactor: integerSetting(values.alert_priority_factor, 10, 0, MAX_PRIORITY_FACTOR, 'priority factor'),
  };
}

export function advanceAlertCandidate(
  current: AlertCandidateState | null,
  now: Date,
  windowMinutes: number,
  requiredCount: number,
): { confirmed: boolean; state: AlertCandidateState } {
  const expired = !current || now.getTime() - current.windowStartedAt.getTime() > windowMinutes * 60_000;
  const state = expired
    ? { windowStartedAt: now, lastTriggeredAt: now, triggerCount: 1 }
    : { ...current, lastTriggeredAt: now, triggerCount: current.triggerCount + 1 };
  const confirmed = state.triggerCount >= requiredCount;
  return {
    confirmed,
    state: confirmed ? { windowStartedAt: now, lastTriggeredAt: now, triggerCount: 0 } : state,
  };
}

export function calculateAdjustedPriority(currentPriority: number, factor: number): {
  enabled: boolean;
  basePriority: number;
  adjustedPriority: number;
} {
  if (!isAccountPriority(currentPriority)) throw new Error('invalid priority');
  if (!Number.isSafeInteger(factor) || factor < 0) throw new Error('invalid priority factor');
  const basePriority = Math.max(1, currentPriority);
  if (factor === 0) return { enabled: false, basePriority, adjustedPriority: basePriority };
  const adjustedPriority = basePriority * factor;
  if (!Number.isSafeInteger(adjustedPriority) || adjustedPriority > MAX_ACCOUNT_PRIORITY) {
    return { enabled: false, basePriority, adjustedPriority: basePriority };
  }
  return { enabled: true, basePriority, adjustedPriority: Math.max(1, adjustedPriority) };
}

export function calculateRestoredPriority(currentPriority: number, factor: number): number {
  if (!isAccountPriority(currentPriority)) throw new Error('invalid priority');
  if (!Number.isSafeInteger(factor) || factor < 1) throw new Error('invalid priority factor');
  return Math.max(1, Math.floor(currentPriority / factor));
}
