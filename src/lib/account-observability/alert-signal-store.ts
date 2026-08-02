import { prisma } from '../db';
import { getSetting, SettingKeys } from '../settings';
import { advanceAlertCandidate, parseAlertBehaviorSettings, type AlertBehaviorSettings } from './alert-behavior';

export interface AlertSignalTransition {
  confirmed: boolean;
  activated: boolean;
  deactivated: boolean;
}

export async function loadAlertBehaviorSettings(): Promise<AlertBehaviorSettings> {
  const [window, count, factor] = await Promise.all([
    getSetting(SettingKeys.ALERT_CONFIRMATION_WINDOW_MIN, '5'),
    getSetting(SettingKeys.ALERT_CONFIRMATION_COUNT, '2'),
    getSetting(SettingKeys.ALERT_PRIORITY_FACTOR, '10'),
  ]);
  return parseAlertBehaviorSettings({
    alert_confirmation_window_minutes: window,
    alert_confirmation_count: count,
    alert_priority_factor: factor,
  });
}

export async function recordTriggeredSignal(input: {
  accountId: number;
  ruleId: number;
  now: Date;
  settings: AlertBehaviorSettings;
  allowStart: boolean;
}): Promise<AlertSignalTransition> {
  return prisma.$transaction(async (tx) => {
    const key = { accountId_ruleId: { accountId: input.accountId, ruleId: input.ruleId } };
    const current = await tx.accountAlertCandidate.findUnique({ where: key });
    if (!current && !input.allowStart) return { confirmed: false, activated: false, deactivated: false };
    const advanced = advanceAlertCandidate(current ? {
      windowStartedAt: current.windowStartedAt,
      lastTriggeredAt: current.lastTriggeredAt,
      triggerCount: current.triggerCount,
    } : null, input.now, input.settings.confirmationWindowMinutes, input.settings.confirmationCount);
    const adjustmentLevel = (current?.adjustmentLevel ?? 0) + (advanced.confirmed ? 1 : 0);
    const activated = advanced.confirmed;
    await tx.accountAlertCandidate.upsert({
      where: key,
      create: {
        accountId: input.accountId, ruleId: input.ruleId,
        ...advanced.state, active: adjustmentLevel > 0, adjustmentLevel, recoveryNormalCount: 0,
      },
      update: { ...advanced.state, active: adjustmentLevel > 0, adjustmentLevel, recoveryNormalCount: 0 },
    });
    return { confirmed: advanced.confirmed, activated, deactivated: false };
  });
}

export async function recordNormalSignal(accountId: number, ruleId: number): Promise<AlertSignalTransition> {
  return prisma.$transaction(async (tx) => {
    const key = { accountId_ruleId: { accountId, ruleId } };
    const current = await tx.accountAlertCandidate.findUnique({ where: key });
    if (!current?.active || current.adjustmentLevel < 1) return { confirmed: false, activated: false, deactivated: false };
    const next = Math.min(3, current.recoveryNormalCount + 1);
    if (next < 3) {
      await tx.accountAlertCandidate.update({ where: key, data: { recoveryNormalCount: next } });
      return { confirmed: true, activated: false, deactivated: false };
    }
    const adjustmentLevel = current.adjustmentLevel - 1;
    if (adjustmentLevel === 0) await tx.accountAlertCandidate.delete({ where: key });
    else await tx.accountAlertCandidate.update({
      where: key,
      data: { adjustmentLevel, active: true, recoveryNormalCount: 0 },
    });
    return { confirmed: adjustmentLevel > 0, activated: false, deactivated: true };
  });
}

export async function discardActivatedSignal(accountId: number, ruleId: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const key = { accountId_ruleId: { accountId, ruleId } };
    const current = await tx.accountAlertCandidate.findUnique({ where: key });
    if (!current?.active || current.adjustmentLevel < 1) return;
    const adjustmentLevel = current.adjustmentLevel - 1;
    if (adjustmentLevel === 0 && current.triggerCount === 0) {
      await tx.accountAlertCandidate.delete({ where: key });
      return;
    }
    await tx.accountAlertCandidate.update({
      where: key,
      data: { adjustmentLevel, active: adjustmentLevel > 0, recoveryNormalCount: 0 },
    });
  });
}

export async function discardLatestActivatedSignal(accountId: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.accountAlertCandidate.findFirst({
      where: { accountId, active: true, adjustmentLevel: { gt: 0 } },
      orderBy: [{ updatedAt: 'desc' }, { ruleId: 'asc' }],
      select: { ruleId: true },
    });
    if (!current) return;
    const key = { accountId_ruleId: { accountId, ruleId: current.ruleId } };
    const candidate = await tx.accountAlertCandidate.findUnique({ where: key });
    if (!candidate?.active || candidate.adjustmentLevel < 1) return;
    const adjustmentLevel = candidate.adjustmentLevel - 1;
    if (adjustmentLevel === 0 && candidate.triggerCount === 0) {
      await tx.accountAlertCandidate.delete({ where: key });
      return;
    }
    await tx.accountAlertCandidate.update({
      where: key,
      data: { adjustmentLevel, active: adjustmentLevel > 0, recoveryNormalCount: 0 },
    });
  });
}

export async function resetSignalRecovery(accountId: number, ruleId: number): Promise<void> {
  await prisma.accountAlertCandidate.updateMany({
    where: { accountId, ruleId, active: true, recoveryNormalCount: { not: 0 } },
    data: { recoveryNormalCount: 0 },
  });
}
