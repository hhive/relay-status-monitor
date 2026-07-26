export interface AccountAlertToggleOptions {
  accountId: number;
  previous: boolean;
  requested: boolean;
  pending: Set<number>;
  apply: (enabled: boolean) => void;
  setPending: (accountId: number, pending: boolean) => void;
  save: (enabled: boolean) => Promise<boolean>;
}

export type AccountAlertToggleResult = 'saved' | 'failed' | 'ignored';

export async function runAccountAlertToggle(options: AccountAlertToggleOptions): Promise<AccountAlertToggleResult> {
  if (options.pending.has(options.accountId)) return 'ignored';

  options.pending.add(options.accountId);
  options.setPending(options.accountId, true);
  options.apply(options.requested);
  try {
    const enabled = await options.save(options.requested);
    options.apply(enabled);
    return 'saved';
  } catch {
    options.apply(options.previous);
    return 'failed';
  } finally {
    options.pending.delete(options.accountId);
    options.setPending(options.accountId, false);
  }
}
