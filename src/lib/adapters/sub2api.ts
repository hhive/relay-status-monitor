/**
 * SUB2API 上游适配器（完整实现）
 *
 * 参考 sub2api 项目（https://github.com/Wei-Shaw/sub2api）的接口：
 * - 余额查询：GET /v1/usage（Bearer API Key），取 remaining ?? balance ?? quota.remaining
 * - 延迟测试：GET /v1/models（Bearer API Key）
 * - 模型实测：POST /v1/chat/completions（非流式，max_tokens=5）
 * - 流式测速：POST /v1/chat/completions（stream=true，SSE 解析 TPS）
 *
 * 这是最稳定的查询方式（API Key 长期有效，无登录限流、无 JWT 过期）
 */
import type {
  AdapterContext,
  BalanceResult,
  LatencyResult,
  ModelTestResult,
  StreamTestResult,
  UpstreamAdapter,
} from './base';
import { fetchWithTimeout } from './base';
import { validateUpstreamBaseUrl } from '../outbound';
import { safeStoredError } from '../safe-error';

export class Sub2ApiAdapter implements UpstreamAdapter {
  readonly type = 'SUB2API' as const;

  private headers(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** 查询余额：GET /v1/usage */
  async queryBalance(ctx: AdapterContext): Promise<BalanceResult> {
    try {
      const url = `${validateUpstreamBaseUrl('SUB2API', ctx.baseUrl).origin}/v1/usage`;
      const res = await fetchWithTimeout(url, { headers: this.headers(ctx.apiKey) }, ctx.timeoutMs);
      if (!res.ok) {
        return { ok: false, errorMessage: `HTTP ${res.status}` };
      }
      const data = await res.json();

      // 提取金额，字段优先级：remaining → balance → quota.remaining → subscription 内 remaining
      const balance =
        pickNum(data.remaining) ??
        pickNum(data.balance) ??
        pickNum(data.quota?.remaining) ??
        (data.subscription ? pickNum(data.subscription.remaining) : undefined);

      if (balance === undefined) {
        return { ok: false, errorMessage: '响应中未找到余额字段', mode: data.mode };
      }

      return {
        ok: true,
        balance,
        limit: pickNum(data.quota?.limit),
        used: pickNum(data.quota?.used),
        mode: data.mode,
        // 自动提取真实分组名：planName 字段（订阅型分组为分组名，钱包型为"钱包余额"）
        groupName: typeof data.planName === 'string' && data.planName ? data.planName : undefined,
      };
    } catch (e) {
      return { ok: false, errorMessage: errMsg(e) };
    }
  }

  /** 延迟测试：GET /v1/models */
  async testLatency(ctx: AdapterContext): Promise<LatencyResult> {
    const start = Date.now();
    try {
      const url = `${validateUpstreamBaseUrl('SUB2API', ctx.baseUrl).origin}/v1/models`;
      const res = await fetchWithTimeout(url, { headers: this.headers(ctx.apiKey) }, ctx.timeoutMs);
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return { ok: false, errorMessage: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const modelCount = Array.isArray(data.data) ? data.data.length : undefined;
      return { ok: true, latencyMs, modelCount };
    } catch (e) {
      return { ok: false, errorMessage: errMsg(e) };
    }
  }

  /** 拉取可用模型列表：GET /v1/models */
  async listModels(ctx: AdapterContext): Promise<{ ok: boolean; models?: string[]; errorMessage?: string }> {
    try {
      const url = `${validateUpstreamBaseUrl('SUB2API', ctx.baseUrl).origin}/v1/models`;
      const res = await fetchWithTimeout(url, { headers: this.headers(ctx.apiKey) }, ctx.timeoutMs);
      if (!res.ok) {
        return { ok: false, errorMessage: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const models = Array.isArray(data.data)
        ? data.data.map((m: { id?: string; name?: string }) => m.id || m.name).filter(Boolean)
        : [];
      return { ok: true, models };
    } catch (e) {
      return { ok: false, errorMessage: errMsg(e) };
    }
  }

  /** 模型实测：POST /v1/chat/completions（非流式） */
  async testModel(ctx: AdapterContext, model: string): Promise<ModelTestResult> {
    const start = Date.now();
    try {
      const url = `${validateUpstreamBaseUrl('SUB2API', ctx.baseUrl).origin}/v1/chat/completions`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: this.headers(ctx.apiKey),
          body: JSON.stringify({
            model: model || ctx.testModel,
            messages: [{ role: 'user', content: 'Say "ok" in one word.' }],
            max_tokens: 5,
            stream: false,
          }),
        },
        ctx.timeoutMs
      );
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return { ok: false, errorMessage: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      return { ok: true, latencyMs, content: String(content).slice(0, 50) };
    } catch (e) {
      return { ok: false, errorMessage: errMsg(e) };
    }
  }

  /** 流式测速：POST /v1/chat/completions（stream=true） */
  async testStream(ctx: AdapterContext, model: string): Promise<StreamTestResult> {
    const start = Date.now();
    try {
      const url = `${validateUpstreamBaseUrl('SUB2API', ctx.baseUrl).origin}/v1/chat/completions`;
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: this.headers(ctx.apiKey),
          body: JSON.stringify({
            model: model || ctx.testModel,
            messages: [{ role: 'user', content: 'Count from 1 to 20, one number per line.' }],
            max_tokens: 100,
            stream: true,
          }),
        },
        ctx.timeoutMs
      );
      if (!res.ok) {
        return { ok: false, errorMessage: `HTTP ${res.status}` };
      }
      if (!res.body) {
        return { ok: false, errorMessage: '响应无 body 流' };
      }

      // 解析 SSE 流，统计 token 数和首 token 延迟
      let tokenCount = 0;
      let firstTokenTime: number | null = null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const delta = json.choices?.[0]?.delta;
            const content = delta?.content ?? '';
            if (content) {
              if (firstTokenTime === null) {
                firstTokenTime = Date.now() - start;
              }
              // 粗略统计 token 数（按字符数估算，中文1字≈1token，英文按词）
              tokenCount += estimateTokens(content);
            }
            // 部分 API 会返回 usage
            if (json.usage?.completion_tokens) {
              tokenCount = json.usage.completion_tokens;
            }
          } catch {
            // 单行解析失败忽略
          }
        }
      }

      const totalMs = Date.now() - start;
      if (tokenCount === 0) {
        return { ok: false, errorMessage: '流式响应未产生任何 token', totalMs };
      }
      const tps = tokenCount / (totalMs / 1000);
      return {
        ok: true,
        firstTokenLatMs: firstTokenTime ?? undefined,
        totalMs,
        tokenCount,
        tps: Math.round(tps * 10) / 10,
      };
    } catch (e) {
      return { ok: false, errorMessage: errMsg(e) };
    }
  }
}

// ============ 辅助函数 ============

/** 安全地取一个可能是数字的值 */
function pickNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 粗略估算 token 数 */
function estimateTokens(text: string): number {
  // 中文按字数，英文按 4 字符 ≈ 1 token 混合估算
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = text.length - cjk;
  return cjk + Math.ceil(other / 4);
}

function errMsg(e: unknown): string {
  return safeStoredError(e);
}
