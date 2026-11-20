// ============================================================
// AI 配置服务（kernel）—— 设置页「AI 设置」面板的唯一数据入口
//
// 后端契约真源：apps/server/src/modules/ai.ts
//   GET  /api/ai/config      → { success, data: publicAIConfig(...) }   ← apiClient 自动脱壳成 DTO
//   POST /api/ai/config      → { success, data: publicAIConfig(...) }   ← 同上
//   POST /api/ai/config/test → **恒 200**：{ success:true, data:{ connected:true, latencyMs, response } }
//                                       / { success:false, data:{ connected:false, error } }
//   GET  /api/ai/models      → **响应体内没有 data 键** ⇒ 不脱壳，整体返回
//                              { ok:true, models:[{id,name}] } | { ok:false, status?, error }
//
// 采样参数三态（ai.ts:1602-1610）：
//   number = 设置 · null = 显式清除（恢复服务商默认）· undefined/缺省 = 不改。
//   ⇒「输入框留空」**不等于**「改成 0」：只有服务端原本有值时才发 null。
//
// ⚠️ SSRF：baseUrl 在服务端经 assertSafeOutboundUrlDeep 深度校验，被拦返回 400
//   { error: { code:'VALIDATION_ERROR', message } }；本模块把 message 原样透出，不重写。
// ============================================================

import { apiClient, ApiError } from '@/services/api/apiClient';

// ---------- 类型 ----------

export type AIProvider = 'openai' | 'ollama' | 'custom';

/** 配置来源：user_db=用户已保存 · server_env=服务端环境变量兜底 */
export type AIConfigSource = 'user_db' | 'server_env';

/** 四个可调生成参数（与后端 providerConfigSchema 同名同序） */
export type SamplingKey = 'temperature' | 'topP' | 'frequencyPenalty' | 'presencePenalty';

export const SAMPLING_KEYS: readonly SamplingKey[] = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
];

/** 范围与后端 zod schema 一致（ai.ts:1479-1482），越界后端直接 400 —— 前端先拦一次好给即时反馈 */
export const SAMPLING_SPEC: Record<SamplingKey, {
  label: string; min: number; max: number; step: number; hint: string;
}> = {
  temperature: { label: 'temperature', min: 0, max: 2, step: 0.05, hint: '随机性，越高越发散' },
  topP: { label: 'top_p', min: 0, max: 1, step: 0.05, hint: '核采样，与温度二选一调' },
  frequencyPenalty: { label: '频率惩罚', min: -2, max: 2, step: 0.1, hint: '压制复读用词' },
  presencePenalty: { label: '存在惩罚', min: -2, max: 2, step: 0.1, hint: '鼓励引入新内容' },
};

/** GET/POST /api/ai/config 的 data（API Key 永不出服务端，只有脱敏提示） */
export interface AIConfigDTO {
  baseUrl: string;
  model: string;
  provider: AIProvider;
  apiKeyConfigured: boolean;
  /** 形如 ***abcd（maskApiKey，ai.ts:1433-1435） */
  apiKeyHint: string;
  _source: AIConfigSource | string;
  /** 仅内置线路等场景由服务端下发，用于展示 */
  label?: string;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

/** POST /api/ai/config 请求体（providerConfigSchema，ai.ts:1472-1485） */
export interface AIConfigPatch {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  provider?: AIProvider;
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  clearApiKey?: boolean;
}

export interface AIModelItem { id: string; name: string }

/** GET /api/ai/models 的整体响应（无 data 键 ⇒ apiClient 不脱壳） */
export type AIModelsResult =
  | { ok: true; models: AIModelItem[] }
  | { ok: false; status?: number; error: string };

/** POST /api/ai/config/test 脱壳后的 data */
export type AITestResult =
  | { connected: true; latencyMs: number; response: string }
  | { connected: false; error: string };

/** 表单里的采样参数：字符串（'' = 不干预 / 清除） */
export type SamplingForm = Record<SamplingKey, string>;

export interface AIConfigForm {
  provider: AIProvider;
  baseUrl: string;
  model: string;
  /** '' = 不改动服务端已存密钥（后端只在 trim 非空时覆盖） */
  apiKey: string;
  /** true = 显式删除服务端已存密钥（用户二次确认后置位） */
  clearApiKey: boolean;
  sampling: SamplingForm;
}

export const PROVIDER_KEYS: readonly AIProvider[] = ['openai', 'ollama', 'custom'];

export const PROVIDER_PRESETS: Record<AIProvider, {
  label: string; baseUrlPlaceholder: string; hint: string;
}> = {
  openai: {
    label: 'OpenAI',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    hint: '官方 API，或任何兼容 /v1 的中转站',
  },
  ollama: {
    label: 'Ollama（本地）',
    baseUrlPlaceholder: 'http://localhost:11434/v1',
    hint: '本地模型，通常不需要 API Key',
  },
  custom: {
    label: '自定义',
    baseUrlPlaceholder: 'https://your-endpoint.example.com/v1',
    hint: '任意 OpenAI 兼容端点（含局域网地址）',
  },
};

// ---------- 表单 ↔ 配置 ----------

export function emptySamplingForm(): SamplingForm {
  return { temperature: '', topP: '', frequencyPenalty: '', presencePenalty: '' };
}

/** 服务端只有「有值」的参数才会下发（samplingOf），故缺省即空字符串 */
export function samplingFormFromConfig(cfg: Pick<AIConfigDTO, SamplingKey>): SamplingForm {
  const form = emptySamplingForm();
  for (const key of SAMPLING_KEYS) {
    const value = cfg[key];
    if (typeof value === 'number') form[key] = String(value);
  }
  return form;
}

export function formFromConfig(cfg: AIConfigDTO): AIConfigForm {
  return {
    provider: cfg.provider ?? 'openai',
    baseUrl: cfg.baseUrl ?? '',
    model: cfg.model ?? '',
    apiKey: '',
    clearApiKey: false,
    sampling: samplingFormFromConfig(cfg),
  };
}

/** 表单是否与已加载配置有差异（用于「保存并测试」文案与「未保存」提示） */
export function isFormDirty(form: AIConfigForm, cfg: AIConfigDTO | null): boolean {
  if (!cfg) return true;
  const base = formFromConfig(cfg);
  if (form.provider !== base.provider) return true;
  if (form.baseUrl.trim() !== base.baseUrl.trim()) return true;
  if (form.model.trim() !== base.model.trim()) return true;
  if (form.apiKey.trim() !== '' || form.clearApiKey) return true;
  return SAMPLING_KEYS.some((key) => form.sampling[key].trim() !== base.sampling[key].trim());
}

export type SamplingParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/** 解析单个采样输入：'' → null（清除）；越界/非数字 → 错误 */
export function parseSamplingInput(key: SamplingKey, raw: string): SamplingParse {
  const spec = SAMPLING_SPEC[key];
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: `${spec.label} 需要填数字` };
  if (value < spec.min || value > spec.max) {
    return { ok: false, error: `${spec.label} 超出范围（${spec.min} ~ ${spec.max}）` };
  }
  return { ok: true, value };
}

/**
 * 表单 → 请求体。**纯函数**，无副作用 —— 三态语义全在这里收口：
 *   · baseUrl / model 始终提交（'' 表示清空，服务端回落到环境变量默认）
 *   · apiKey 仅在输入非空（且未勾选清除）时提交；clearApiKey 互斥
 *   · 采样参数：输入非空 → number；输入空且「服务端原本有值」→ null；输入空且原本就无值 → 省略
 * @param baseline 已加载的服务端配置（决定「空输入」要不要发 null）
 */
export function planAIConfigSave(
  form: AIConfigForm,
  baseline: Pick<AIConfigDTO, SamplingKey> | null,
): { patch: AIConfigPatch; errors: string[] } {
  const errors: string[] = [];
  const patch: AIConfigPatch = { provider: form.provider };

  const baseUrl = form.baseUrl.trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    errors.push('服务地址需以 http:// 或 https:// 开头');
  }
  // 空串是合法输入（清空 → 服务端回落默认），schema 对 baseUrl 只要求 string
  patch.baseUrl = baseUrl;
  patch.model = form.model.trim();

  if (form.clearApiKey) {
    patch.clearApiKey = true;
  } else {
    const apiKey = form.apiKey.trim();
    if (apiKey) patch.apiKey = apiKey;
  }

  for (const key of SAMPLING_KEYS) {
    const parsed = parseSamplingInput(key, form.sampling[key]);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    if (parsed.value === null) {
      if (baseline && typeof baseline[key] === 'number') patch[key] = null;
    } else {
      patch[key] = parsed.value;
    }
  }

  return { patch, errors };
}

// ---------- 展示辅助 ----------

/** 非 user_db 来源需要一条显式提示，否则用户会以为「我配的怎么没生效」 */
export function describeConfigSource(cfg: Pick<AIConfigDTO, '_source' | 'label'>): string | null {
  switch (cfg._source) {
    case 'user_db':
      return null;
    case 'server_env':
      return '当前使用服务端环境变量里的默认配置（本机尚未保存过自己的配置）';
    default:
      return cfg._source ? `当前配置来源：${cfg._source}` : null;
  }
}

/**
 * 错误 → 可读文案。
 * 400 VALIDATION_ERROR 的 message 是服务端 SSRF 校验的原话，直接透出最有信息量；
 * 401 在 apiClient 里已触发跳登录，这里补一句人话，避免只剩「未认证」。
 */
export function describeAIError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'TIMEOUT') return '请求超时：模型服务响应太慢，请检查服务地址后重试';
    if (err.status === 401) return '登录状态已失效，请重新登录后再试';
    if (err.status === 403) return '没有权限修改 AI 配置';
    return err.message || `请求失败（HTTP ${err.status}）`;
  }
  return err instanceof Error ? err.message : '未知错误';
}

// ---------- HTTP ----------

/** 读取当前用户配置（含来源与脱敏 Key 提示） */
export function getAIConfig(): Promise<AIConfigDTO> {
  // silent：错误在面板内联展示，不再叠加全局 toast
  return apiClient.get<AIConfigDTO>('/ai/config', undefined, { silent: true });
}

/** 保存配置；返回服务端回显的最新 DTO（可直接覆盖表单基线） */
export function saveAIConfig(patch: AIConfigPatch): Promise<AIConfigDTO> {
  // 服务端保存后要 saveToDisk(true) 落盘 + 重建 Provider 缓存，比普通写接口慢，放宽超时
  return apiClient.post<AIConfigDTO>('/ai/config', patch, { silent: true, timeoutMs: 20000 });
}

/**
 * 测试连接。
 * ⚠️ 打的是**服务端已保存**的配置（ai.ts:2024-2044 从 DB 读），不是表单草稿 ——
 *   调用方必须先落库再测，否则测的是旧配置。探测会真的发一次 chat（maxTokens 256，
 *   见 ai.ts:2050-2054 注释：不能用极小预算，推理模型会误报失败），故超时给足。
 */
export function testAIConnection(): Promise<AITestResult> {
  return apiClient.post<AITestResult>('/ai/config/test', undefined, { silent: true, timeoutMs: 60000 });
}

/** 拉取模型列表；⚠️ 同样基于已保存配置（ai.ts:1922-1935） */
export function listAIModels(): Promise<AIModelsResult> {
  return apiClient.get<AIModelsResult>('/ai/models', undefined, { silent: true, timeoutMs: 30000 });
}
