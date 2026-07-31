import { isAccountPriority } from '../account-priority';

const PRIORITY_PATH = '/api/v1/internal/relay-monitor/accounts';

export class Sub2ApiPriorityError extends Error {
  constructor(readonly code: string, readonly currentPriority?: number) {
    super(code);
  }
}

export interface Sub2ApiPriorityClient {
  getPriority(sourceAccountId: string): Promise<number>;
  setPriority(sourceAccountId: string, expectedPriority: number, targetPriority: number): Promise<number>;
}

function accountId(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) throw new Sub2ApiPriorityError('invalid_account_id');
  return value;
}

function priority(value: unknown, minimum: number): number {
  if (!isAccountPriority(value, minimum)) {
    throw new Sub2ApiPriorityError('invalid_priority_response');
  }
  return Number(value);
}

export function createSub2ApiPriorityClient(input: {
  baseUrl?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
} = {}): Sub2ApiPriorityClient {
  const baseUrl = (input.baseUrl ?? process.env.SUB2API_PRIORITY_API_BASE_URL ?? '').replace(/\/+$/, '');
  const secret = input.secret ?? process.env.SUB2API_RELAY_MONITOR_PRIORITY_SECRET ?? '';
  const fetchImpl = input.fetchImpl ?? fetch;
  if (!/^https?:\/\//.test(baseUrl) || secret.trim().length < 32) throw new Sub2ApiPriorityError('priority_integration_unavailable');
  const request = async (sourceAccountId: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${baseUrl}${PRIORITY_PATH}/${accountId(sourceAccountId)}/priority`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Sub2API-Relay-Monitor-Secret': secret },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 409) throw new Sub2ApiPriorityError('priority_conflict', priority(body.priority, 0));
    if (!response.ok) throw new Sub2ApiPriorityError(`priority_http_${response.status}`);
    return body;
  };
  return {
    getPriority: async (sourceAccountId) => priority((await request(sourceAccountId)).priority, 0),
    setPriority: async (sourceAccountId, expectedPriority, targetPriority) => {
      priority(expectedPriority, 0);
      priority(targetPriority, 1);
      const body = await request(sourceAccountId, {
        method: 'PUT', body: JSON.stringify({ expected_priority: expectedPriority, target_priority: targetPriority }),
      });
      return priority(body.priority, 1);
    },
  };
}
