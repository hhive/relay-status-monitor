export const MAX_ACCOUNT_PRIORITY = 1_000_000;

export function isAccountPriority(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= MAX_ACCOUNT_PRIORITY;
}
