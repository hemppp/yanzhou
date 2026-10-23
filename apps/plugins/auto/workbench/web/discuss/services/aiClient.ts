// ============================================================
// AI Client - 统一 AI 配置管理
// 所有 AI 请求均通过后端 API 代理，前端不直接调用 AI Provider
// ============================================================

import { apiClient } from '@novel-plugins/data-core/api/apiClient';

// ---- 类型定义 ----

/** AI 提供商类型 */
export type AIProvider = 'openai' | 'ollama' | 'custom';

/** 统一 AI 配置接口（apiKey 仅表示当前草稿；服务端读取配置时不会回传完整 Key） */
export interface AIConfig {
  baseUrl: string;
  /** 新 Key 草稿；从服务端加载的已保存 Key 始终为空字符串 */
  apiKey: string;
  model: string;
  provider: AIProvider;
  apiKeyConfigured?: boolean;
  apiKeyHint?: string;
  /** 服务商标签（如「公益中转站（内置）」）；仅展示用，Key 不回传 */
  label?: string;
  /**
   * 生成参数（可选）。未设 = 不干预，由服务商默认值决定。
   * temperature 影响文风发挥（对话章可高、设定章宜低）；
   * frequencyPenalty 是「车轱辘话 / 重复用词」的靶子。
   */
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface AIConfigPatch extends Partial<Omit<AIConfig, 'temperature' | 'topP' | 'frequencyPenalty' | 'presencePenalty'>> {
  /** 显式清除服务端保存的 Key；省略 apiKey 则保留已有 Key */
  clearApiKey?: boolean;
  /** 生成参数：数字=设置；null=显式清除（恢复服务商默认）；undefined=不改（JSON 会丢弃） */
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
}

/** AI 连接测试结果 */
export interface AITestResult {
  connected: boolean;
  latencyMs?: number;
  response?: string;
  error?: string;
}

/** 模型列表项（兼容旧接口） */
export interface ModelListItem {
  id: string;
  name: string;
}

// ---- 错误类型 ----

/**
 * AI 配置错误（兼容旧接口，现由后端管理配置）
 */
export class AIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIConfigError';
  }
}

/**
 * AI API 错误（兼容旧接口，现由后端代理 AI 请求）
 */
export class AIAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'AIAPIError';
  }
}

// ---- 配置管理（通过后端 API）----

/** 本地缓存的 AI 配置 */
let cachedConfig: AIConfig | null = null;

/**
 * 获取 AI 配置。
 * 首次调用时从后端获取并缓存；后续返回缓存值。
 * 若需强制刷新，请传入 forceRefresh = true。
 */
export async function getAIConfig(forceRefresh = false): Promise<AIConfig> {
  if (cachedConfig && !forceRefresh) {
    return cachedConfig;
  }

  try {
    const response = await apiClient.get<{
      baseUrl: string;
      model: string;
      provider: AIProvider;
      apiKeyConfigured?: boolean;
      apiKeyHint?: string;
      label?: string;
      _source: string;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
    }>('/ai/config', undefined, { silent: true });

    if (response) {
      cachedConfig = {
        baseUrl: response.baseUrl,
        apiKey: '',
        model: response.model,
        provider: response.provider,
        apiKeyConfigured: response.apiKeyConfigured,
        apiKeyHint: response.apiKeyHint,
        label: response.label,
        ...(typeof response.temperature === 'number' ? { temperature: response.temperature } : {}),
        ...(typeof response.topP === 'number' ? { topP: response.topP } : {}),
        ...(typeof response.frequencyPenalty === 'number' ? { frequencyPenalty: response.frequencyPenalty } : {}),
        ...(typeof response.presencePenalty === 'number' ? { presencePenalty: response.presencePenalty } : {}),
      };
      return cachedConfig;
    }
  } catch {
    // 后端不可用时返回默认配置
  }

  return cachedConfig ?? {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4-turbo',
    provider: 'openai',
  };
}

/**
 * 获取当前 AI 配置的同步版本（仅返回本地缓存，不发起请求）
 * 用于不需要实时配置的场景（如判断是否已配置 AI）
 */
export function getCachedConfig(): AIConfig | null {
  return cachedConfig;
}

/**
 * 保存 AI 配置到后端。
 * 调用后会更新本地缓存。
 */
export async function setAIConfig(config: AIConfigPatch): Promise<void> {
  // apiKey 为空表示“未修改”，避免已保存的 Key 被空字符串覆盖。
  // 需要清除时由调用方显式传 clearApiKey=true。
  const payload: AIConfigPatch = { ...config };
  if (!payload.apiKey) delete payload.apiKey;
  await apiClient.post('/ai/config', payload);
  cachedConfig = null;
  await getAIConfig(true);
}

/**
 * 测试 AI 连接
 * 后端会真实调用 LLM Provider 的 chat/completions，LLM 首字延迟通常 2-15s，
 * 因此使用 30s 超时（与 listModels 对齐），避免默认 8s 超时误报。
 */
export async function testAIConnection(): Promise<AITestResult> {
  try {
    const response = await apiClient.post<{
      connected: boolean;
      latencyMs?: number;
      response?: string;
      error?: string;
    }>('/ai/config/test', undefined, { timeoutMs: 30_000 });
    return {
      connected: response.connected,
      latencyMs: response.latencyMs,
      response: response.response,
      error: response.error,
    };
  } catch (e) {
    return {
      connected: false,
      error: e instanceof Error ? e.message : '连接测试失败',
    };
  }
}

/**
 * 获取可用模型列表（通过后端代理调用 LLM Provider 的 /v1/models）
 * LLM Provider 响应可能较慢，使用 30s 超时
 */
export async function listModels(): Promise<{
  ok: boolean;
  models: ModelListItem[];
  status?: number;
  error?: string;
}> {
  return apiClient.get('/ai/models', undefined, { timeoutMs: 30_000 });
}

// ---- 工具函数 ----

/**
 * 将 HTML 转换为纯文本
 */
export function toText(html: string): string {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}

/**
 * 解析 AI Agent 返回的 JSON 字符串
 * 处理 LLM 输出中常见的 markdown 代码块包裹
 */
export function parseAIJson(content: string): Record<string, unknown> {
  const cleaned = content
    .replace(/`json\s*\n?/gi, '')
    .replace(/`/g, '')
    .trim();

  try {
    return JSON.parse(cleaned || '{}');
  } catch {
    console.warn('[aiClient] JSON parse failed, returning empty object');
    return {};
  }
}

/**
 * 标准化 Base URL（去除尾部空格、确保格式统一）
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** API Key 脱敏：只显示末 4 位，短 Key 也不回显完整值 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  return '***' + apiKey.slice(-4);
}