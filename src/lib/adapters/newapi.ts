import type {
  AdapterContext,
  BalanceResult,
  KeyMetadataResult,
  LatencyResult,
  ModelTestResult,
  StreamTestResult,
  UpstreamAdapter,
} from './base';

const DISABLED_MESSAGE = 'NEW_API 上游未启用，本次部署不支持该功能';

function disabled<T extends { ok: false; errorMessage: string }>(): T {
  return { ok: false, errorMessage: DISABLED_MESSAGE } as T;
}

/** This deployment intentionally exposes no NEW_API outbound destination. */
export class NewApiAdapter implements UpstreamAdapter {
  readonly type = 'NEW_API' as const;

  async queryBalance(_ctx: AdapterContext): Promise<BalanceResult> {
    return disabled();
  }

  async fetchKeyMetadata(_ctx: AdapterContext): Promise<KeyMetadataResult> {
    return disabled();
  }

  async testLatency(_ctx: AdapterContext): Promise<LatencyResult> {
    return disabled();
  }

  async listModels(
    _ctx: AdapterContext,
  ): Promise<{ ok: boolean; models?: string[]; errorMessage?: string }> {
    return disabled();
  }

  async testModel(_ctx: AdapterContext, _model: string): Promise<ModelTestResult> {
    return disabled();
  }

  async testStream(_ctx: AdapterContext, _model: string): Promise<StreamTestResult> {
    return disabled();
  }
}
