// ============================================================
// aiConfigService.test.ts —— AI 设置面板的数据层自证
//
// 锁住三件**只有跑起来才知道**的事：
//   ① 采样参数三态（ai.ts:1602-1610）：空输入 ≠ 0 —— 无基线时省略、有基线时发 null
//      （错发 null 会静默清掉用户设过的值；错发 0 会把随机性钉死）
//   ② 密钥互斥：apiKey 与 clearApiKey 不能同时进请求体
//   ③ HTTP 契约：四个端点路径与超时参数，以及「models 无 data 键」依赖的整体响应类型
//
// apiClient 全量替身（沿用 ProjectLayout.shell-tabs.test.tsx 的 vi.hoisted 口径）：
// 单元测试不外呼网络，只断言「发什么」。
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@/services/api/apiClient', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    apiClient: {
      get: mocks.get,
      post: mocks.post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

import { ApiError } from '@/services/api/apiClient';
import {
  describeAIError,
  describeConfigSource,
  emptySamplingForm,
  formFromConfig,
  getAIConfig,
  isFormDirty,
  listAIModels,
  parseSamplingInput,
  planAIConfigSave,
  samplingFormFromConfig,
  saveAIConfig,
  testAIConnection,
  type AIConfigDTO,
  type AIConfigForm,
} from '@/services/api/aiConfigService';

function makeForm(overrides: Partial<AIConfigForm> = {}): AIConfigForm {
  return {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    clearApiKey: false,
    sampling: emptySamplingForm(),
    ...overrides,
  };
}

const CONFIG: AIConfigDTO = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  provider: 'openai',
  apiKeyConfigured: true,
  apiKeyHint: '***abcd',
  _source: 'user_db',
  temperature: 0.7,
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe('parseSamplingInput —— 空字符串是「清除」而不是 0', () => {
  it('空字符串 / 纯空白 → value:null（交由调用方决定省略还是清除）', () => {
    expect(parseSamplingInput('temperature', '')).toEqual({ ok: true, value: null });
    expect(parseSamplingInput('temperature', '   ')).toEqual({ ok: true, value: null });
  });

  it('合法数字按原值返回（含负数与小数）', () => {
    expect(parseSamplingInput('temperature', '0.7')).toEqual({ ok: true, value: 0.7 });
    expect(parseSamplingInput('frequencyPenalty', '-1.5')).toEqual({ ok: true, value: -1.5 });
    expect(parseSamplingInput('temperature', '0')).toEqual({ ok: true, value: 0 });
  });

  it('非数字/半数字文本 → 报错，不静默当成 0', () => {
    expect(parseSamplingInput('temperature', 'abc').ok).toBe(false);
    expect(parseSamplingInput('temperature', '0.7abc').ok).toBe(false);
  });

  it('越界 → 报错（范围与后端 zod 一致：temp 0~2 / topP 0~1 / 惩罚 -2~2）', () => {
    expect(parseSamplingInput('temperature', '2').ok).toBe(true);
    expect(parseSamplingInput('temperature', '2.1').ok).toBe(false);
    expect(parseSamplingInput('temperature', '-0.1').ok).toBe(false);
    expect(parseSamplingInput('topP', '1').ok).toBe(true);
    expect(parseSamplingInput('topP', '1.5').ok).toBe(false);
    expect(parseSamplingInput('frequencyPenalty', '2.5').ok).toBe(false);
  });
});

describe('planAIConfigSave —— 请求体三态', () => {
  it('无基线且输入留空：**省略**该字段（不发 null，避免无意义写库）', () => {
    const { patch, errors } = planAIConfigSave(makeForm(), null);
    expect(errors).toEqual([]);
    expect('temperature' in patch).toBe(false);
    expect('topP' in patch).toBe(false);
    expect('frequencyPenalty' in patch).toBe(false);
    expect('presencePenalty' in patch).toBe(false);
  });

  it('有基线且输入留空：**发 null** 显式清除（恢复服务商默认）', () => {
    const { patch } = planAIConfigSave(makeForm(), { temperature: 0.7 });
    expect(patch.temperature).toBeNull();
    // 基线里没有的项仍然省略
    expect('topP' in patch).toBe(false);
  });

  it('输入非空：发数字（temperature 走 number，不是字符串）', () => {
    const form = makeForm({ sampling: { ...emptySamplingForm(), temperature: '1.25', topP: '0.9' } });
    const { patch } = planAIConfigSave(form, { temperature: 0.7 });
    expect(patch.temperature).toBe(1.25);
    expect(patch.topP).toBe(0.9);
    expect(typeof patch.temperature).toBe('number');
  });

  it('越界输入只进 errors，不写进 patch', () => {
    const form = makeForm({ sampling: { ...emptySamplingForm(), temperature: '9' } });
    const { patch, errors } = planAIConfigSave(form, null);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('temperature');
    expect('temperature' in patch).toBe(false);
  });

  it('apiKey 留空 → 不提交（后端只在非空时覆盖，留空即保持现有密钥）', () => {
    const { patch } = planAIConfigSave(makeForm({ apiKey: '   ' }), CONFIG);
    expect('apiKey' in patch).toBe(false);
    expect('clearApiKey' in patch).toBe(false);
  });

  it('apiKey 有值 → trim 后提交', () => {
    const { patch } = planAIConfigSave(makeForm({ apiKey: '  sk-test  ' }), CONFIG);
    expect(patch.apiKey).toBe('sk-test');
    expect('clearApiKey' in patch).toBe(false);
  });

  it('clearApiKey 与 apiKey **互斥**：置位时只提交清除标记', () => {
    const { patch } = planAIConfigSave(makeForm({ apiKey: 'sk-should-be-ignored', clearApiKey: true }), CONFIG);
    expect(patch.clearApiKey).toBe(true);
    expect('apiKey' in patch).toBe(false);
  });

  it('baseUrl 缺协议前缀 → 报错（服务端 SSRF 校验之前先给即时反馈）', () => {
    const { errors } = planAIConfigSave(makeForm({ baseUrl: 'api.openai.com/v1' }), CONFIG);
    expect(errors.some((e) => e.includes('http'))).toBe(true);
  });

  it('baseUrl 留空是合法输入（空串 = 清空并回落服务端默认），不是错误', () => {
    const { patch, errors } = planAIConfigSave(makeForm({ baseUrl: '   ' }), CONFIG);
    expect(errors).toEqual([]);
    expect(patch.baseUrl).toBe('');
  });
});

describe('表单 ↔ 配置 往返', () => {
  it('samplingFormFromConfig：只有服务端下发的数字才回填，其余留空', () => {
    const form = samplingFormFromConfig({ temperature: 0.7, topP: undefined, frequencyPenalty: 0, presencePenalty: null as unknown as undefined });
    expect(form.temperature).toBe('0.7');
    expect(form.frequencyPenalty).toBe('0'); // 0 是「有值」，不能当成空
    expect(form.topP).toBe('');
    expect(form.presencePenalty).toBe('');
  });

  it('formFromConfig + isFormDirty：刚加载的表单不算脏', () => {
    const form = formFromConfig(CONFIG);
    expect(isFormDirty(form, CONFIG)).toBe(false);
    expect(form.apiKey).toBe(''); // 密钥永不回填
    expect(form.clearApiKey).toBe(false);
  });

  it('isFormDirty：改采样 / 填密钥 / 勾清除 都算脏', () => {
    const base = formFromConfig(CONFIG);
    expect(isFormDirty({ ...base, sampling: { ...base.sampling, temperature: '0.8' } }, CONFIG)).toBe(true);
    expect(isFormDirty({ ...base, apiKey: 'sk-new' }, CONFIG)).toBe(true);
    expect(isFormDirty({ ...base, clearApiKey: true }, CONFIG)).toBe(true);
    expect(isFormDirty({ ...base, baseUrl: '  https://api.openai.com/v1  ' }, CONFIG)).toBe(false);
    expect(isFormDirty(base, null)).toBe(true);
  });
});

describe('describeConfigSource —— 非 user_db 来源必须给提示', () => {
  it('user_db 不提示（就是用户自己的配置）', () => {
    expect(describeConfigSource({ _source: 'user_db' })).toBeNull();
  });

  it('server_env 说明是环境变量兜底', () => {
    expect(describeConfigSource({ _source: 'server_env' })).toContain('环境变量');
  });
});

describe('describeAIError —— 已知错误给人话', () => {
  it('ApiError 超时（status 0 / code TIMEOUT）', () => {
    expect(describeAIError(new ApiError(0, 'TIMEOUT', '请求超时 (20s)'))).toContain('超时');
  });

  it('401 不只剩「未认证」', () => {
    expect(describeAIError(new ApiError(401, 'UNAUTHORIZED', '未认证'))).toContain('登录');
  });

  it('其它 ApiError 原样透出服务端 message（如 SSRF 校验原话）', () => {
    expect(describeAIError(new ApiError(400, 'VALIDATION_ERROR', 'baseUrl 指向内网地址，已拒绝')))
      .toBe('baseUrl 指向内网地址，已拒绝');
  });

  it('非 Error 值也有文案', () => {
    expect(describeAIError('boom')).toBe('未知错误');
  });
});

describe('HTTP 契约', () => {
  it('getAIConfig → GET /ai/config（silent，不叠全局 toast）', async () => {
    mocks.get.mockResolvedValue(CONFIG);
    await expect(getAIConfig()).resolves.toBe(CONFIG);
    expect(mocks.get).toHaveBeenCalledWith('/ai/config', undefined, { silent: true });
  });

  it('saveAIConfig → POST /ai/config，超时放宽到 20s（服务端要落盘 + 重建缓存）', async () => {
    mocks.post.mockResolvedValue(CONFIG);
    await saveAIConfig({ temperature: null });
    expect(mocks.post).toHaveBeenCalledWith('/ai/config', { temperature: null }, { silent: true, timeoutMs: 20000 });
  });

  it('testAIConnection → POST /ai/config/test，超时 60s（会真的发一次 chat）', async () => {
    mocks.post.mockResolvedValue({ connected: true, latencyMs: 12, response: 'Hi' });
    await expect(testAIConnection()).resolves.toEqual({ connected: true, latencyMs: 12, response: 'Hi' });
    expect(mocks.post).toHaveBeenCalledWith('/ai/config/test', undefined, { silent: true, timeoutMs: 60000 });
  });

  it('listAIModels → GET /ai/models（该端点无 data 键，整体返回 { ok, models }）', async () => {
    mocks.get.mockResolvedValue({ ok: true, models: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }] });
    const result = await listAIModels();
    expect(mocks.get).toHaveBeenCalledWith('/ai/models', undefined, { silent: true, timeoutMs: 30000 });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.models.map((m) => m.id) : []).toEqual(['gpt-4o-mini']);
  });
});
