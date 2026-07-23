/**
 * 上游适配器接口定义
 * 所有上游类型（SUB2API / NEW_API 等）都需实现此接口
 * 新增上游类型只需实现此接口，无需改动采集器和 UI
 */
import type { UpstreamType } from '@prisma/client';
import { fetchCredentialed, OutboundRequestError } from '../outbound';

/** 适配器运行所需的上下文 */
export interface AdapterContext {
  /** 上游基础 URL（不含协议，如 relay.example.com） */
  baseUrl: string;
  /** 已解密的 API Key（sk-xxx），用于测速/延迟测试 */
  apiKey: string;
  /** new-api 系统访问令牌（用于查余额，sub2api 不需要） */
  accessToken?: string;
  /** new-api 用户 ID（配合 accessToken 使用） */
  userId?: string;
  /** 测试超时（毫秒） */
  timeoutMs: number;
  /** 测速模型名 */
  testModel: string;
}

/** 余额查询结果 */
export interface BalanceResult {
  ok: boolean;
  /** 剩余余额（美元） */
  balance?: number;
  /** 额度上限（美元），可选 */
  limit?: number;
  /** 已用额度（美元），可选 */
  used?: number;
  /** 原始模式（quota_limited / unrestricted），可选 */
  mode?: string;
  /** 从上游响应自动提取的真实分组名（sub2api=planName, new-api=data.group） */
  groupName?: string;
  errorMessage?: string;
}

/** API Key 远端元数据（名称、分组及分组展示信息） */
export interface KeyMetadataResult {
  ok: boolean;
  keyName?: string;
  groupName?: string;
  groupDescription?: string;
  groupRateMultiplier?: number;
  remoteKeyId?: string;
  errorMessage?: string;
}

/** 延迟测试结果 */
export interface LatencyResult {
  ok: boolean;
  /** HTTP 响应延迟（毫秒） */
  latencyMs?: number;
  /** 可用模型数量，可选 */
  modelCount?: number;
  errorMessage?: string;
}

/** 模型实测结果 */
export interface ModelTestResult {
  ok: boolean;
  /** 总延迟（毫秒） */
  latencyMs?: number;
  /** 返回内容片段 */
  content?: string;
  errorMessage?: string;
}

/** 流式测速结果 */
export interface StreamTestResult {
  ok: boolean;
  /** 首 token 延迟（TTFB，毫秒） */
  firstTokenLatMs?: number;
  /** 总耗时（毫秒） */
  totalMs?: number;
  /** 生成的 token 数 */
  tokenCount?: number;
  /** 每秒 token 数 */
  tps?: number;
  errorMessage?: string;
}

/** 上游适配器接口 */
export interface UpstreamAdapter {
  /** 上游类型标识 */
  readonly type: UpstreamType;

  /** 查询余额（轻量，不消耗额度） */
  queryBalance(ctx: AdapterContext): Promise<BalanceResult>;

  /** 延迟测试（轻量，GET 模型列表） */
  testLatency(ctx: AdapterContext): Promise<LatencyResult>;

  /** 模型实测（重量，消耗少量额度） */
  testModel(ctx: AdapterContext, model: string): Promise<ModelTestResult>;

  /** 流式测速（重量，消耗少量额度） */
  testStream(ctx: AdapterContext, model: string): Promise<StreamTestResult>;

  /** 拉取可用模型列表（轻量，不消耗额度） */
  listModels(ctx: AdapterContext): Promise<{ ok: boolean; models?: string[]; errorMessage?: string }>;

  /** 拉取 API Key 的远端名称、分组和分组展示信息（按需调用） */
  fetchKeyMetadata?(ctx: AdapterContext): Promise<KeyMetadataResult>;
}

/** 辅助：构造规范的 base URL（带协议） */
export function buildBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  // 去掉末尾斜杠
  return url.replace(/\/+$/, '');
}

/** 辅助：带超时的 fetch */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const result = await fetchCredentialed(url, init, timeoutMs);
  if (!result.ok) throw new OutboundRequestError(result.error.category, result.error.message);
  return result.response;
}
