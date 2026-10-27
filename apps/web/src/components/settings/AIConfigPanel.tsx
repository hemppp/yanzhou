// ============================================================
// AI 设置面板（kernel）—— 设置页 → AI 设置
//
// 为什么在 kernel（而不是 D5 原计划的 auto 模块）：
//   docs/architecture/web-workbench-split.md:462 把 AIConfigPanel / LocalModelPanel
//   划给 auto，但 auto 的 web 入口（apps/plugins/auto/workbench/web/index.tsx）是
//   有意为之的空实现 ⇒ 该分类下没有任何注册项，PluginSettingsSections 空集返回 null，
//   整页一片空白。而 apps/desktop/src/env.ts:55-62 又把 AI_PROVIDER / OPENAI_* /
//   OLLAMA_* / CUSTOM_AI_* 冻结为「不注入」，意即提供商**只能**在应用内配置 ——
//   入口不存在，便携版就完全用不了 AI。故回归 kernel，全模式可用（手写台也能配）。
//
// 数据源：GET/POST /api/ai/config、POST /api/ai/config/test、GET /api/ai/models
//   契约与三态语义集中在 services/api/aiConfigService.ts。
//
// ⚠️ 目录归属（隔离门禁）：**不要**把这个服务放回 `@/services/ai/`。
//   契约 §5 把 `@/services/ai/**` 冻结为 **auto 域飞地**（
//   docs/architecture/web-workbench-split-contract.md:18,185、:202 t5 行），
//   scripts/verify/verify-workbench-isolation.mjs:167 的 DOMAIN_BY_PATH 同口径。
//   kernel 侧放该前缀会同时触发 K2A（kernel→auto 跨域 import）与 B-ENTRY
//   （kernel 深引模块内部路径）。本服务是 kernel 自有，故与 authApi.ts 同放
//   `services/api/`（DOMAIN_BY_PATH:162 明列 kernel）。
//
// ⚠️ 「测试连接」与「拉取模型列表」都读**服务端已保存**的配置 ⇒ 有未保存改动时
//   这两颗按钮会先落库（文案也随之变为「保存并测试」），否则测的是旧配置、结果会骗人。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Bot, Check, Loader2, RefreshCw, Save, Trash2, Zap } from 'lucide-react';
import {
  PROVIDER_KEYS,
  PROVIDER_PRESETS,
  SAMPLING_KEYS,
  SAMPLING_SPEC,
  describeAIError,
  describeConfigSource,
  emptySamplingForm,
  getAIConfig,
  isFormDirty,
  listAIModels,
  planAIConfigSave,
  samplingFormFromConfig,
  saveAIConfig,
  testAIConnection,
  type AIConfigDTO,
  type AIConfigForm,
  type AIModelItem,
  type AIProvider,
  type AITestResult,
  type SamplingForm,
} from '@/services/api/aiConfigService';

type Notice = { kind: 'ok' | 'warn' | 'err'; text: string };

const MUTED = 'hsl(var(--muted-foreground))';
const INK = 'hsl(var(--ink))';
const BORDER = 'hsl(var(--border) / 0.7)';

/** 小输入框：与设置页其它面板同口径（nm-input-sm 只给底色与边框，尺寸靠 Tailwind） */
const INPUT_CLASS = 'nm-input-sm w-full px-3 py-2 text-sm';
const BTN_PRIMARY = 'nm-btn-mist-primary px-4 py-1.5 text-sm rounded-md font-medium inline-flex items-center gap-1.5 disabled:opacity-40';
const BTN_SOFT = 'nm-btn-mist-soft px-4 py-1.5 text-sm rounded-md font-medium inline-flex items-center gap-1.5 disabled:opacity-40';
const BTN_TINY = 'nm-btn-mist-soft px-3 py-1 rounded-md text-xs disabled:opacity-40';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <span className="nm-label">{label}</span>
      {children}
      {hint && (
        <span className="block text-[10px] mt-1" style={{ color: MUTED }}>{hint}</span>
      )}
    </div>
  );
}

export function AIConfigPanel() {
  const [config, setConfig] = useState<AIConfigDTO | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const [provider, setProvider] = useState<AIProvider>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [sampling, setSampling] = useState<SamplingForm>(emptySamplingForm);

  const [models, setModels] = useState<AIModelItem[]>([]);
  const [modelListError, setModelListError] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  /** 自绘模型下拉的展开态（原生 datalist 不会自动弹，见下方 Field 里的注释） */
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelBoxRef = useRef<HTMLDivElement | null>(null);
  /**
   * 过滤词：**只有用户真的在打字时**才过滤（null = 不过滤，列全部）。
   * 为什么要区分：输入框里通常已经存着一个模型名，若一律按它过滤，
   * 拉取成功后只会列出"和当前值匹配的那一条"，看着像"只拉到一个"（实测踩到）。
   * 点按钮 / 点输入框 / 按 ↓ 打开时一律 null ⇒ 看到的是**拉到的一整份列表**。
   */
  const [modelQuery, setModelQuery] = useState<string | null>(null);

  const filteredModels = useMemo(() => {
    if (modelQuery === null) return models;
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q),
    );
  }, [models, modelQuery]);

  // 点面板外 / Esc 关掉下拉（与仓内其它浮层同款处理）
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (modelBoxRef.current?.contains(ev.target as Node)) return;
      setModelMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelMenuOpen]);

  const [testResult, setTestResult] = useState<AITestResult | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const applyConfig = useCallback((cfg: AIConfigDTO) => {
    setConfig(cfg);
    setProvider(cfg.provider ?? 'openai');
    setBaseUrl(cfg.baseUrl ?? '');
    setModel(cfg.model ?? '');
    setApiKey('');
    setClearApiKey(false);
    setSampling(samplingFormFromConfig(cfg));
    setTestResult(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError('');
    getAIConfig()
      .then((cfg) => {
        if (cancelled) return;
        applyConfig(cfg);
        setLoadState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(describeAIError(err));
        setLoadState('error');
      });
    return () => { cancelled = true; };
  }, [reloadToken, applyConfig]);

  const form: AIConfigForm = { provider, baseUrl, model, apiKey, clearApiKey, sampling };
  const dirty = isFormDirty(form, config);
  const preset = PROVIDER_PRESETS[provider];

  /** 把表单落库；返回是否成功（供「测试/拉模型」在需要时先保存） */
  const persist = useCallback(async (): Promise<boolean> => {
    const { patch, errors } = planAIConfigSave(form, config);
    if (errors.length > 0) {
      setNotice({ kind: 'err', text: errors.join('；') });
      return false;
    }
    setBusy('save');
    try {
      const saved = await saveAIConfig(patch);
      applyConfig(saved);
      setNotice({ kind: 'ok', text: '已保存' });
      return true;
    } catch (err) {
      setNotice({ kind: 'err', text: `保存失败：${describeAIError(err)}` });
      return false;
    } finally {
      setBusy(null);
    }
  }, [form, config, applyConfig]);

  const handleSave = useCallback(async () => {
    setNotice(null);
    await persist();
  }, [persist]);

  const handleTest = useCallback(async () => {
    setNotice(null);
    setTestResult(null);
    if (dirty && !(await persist())) return;
    setBusy('test');
    try {
      const result = await testAIConnection();
      setTestResult(result);
      setNotice(result.connected
        ? { kind: 'ok', text: `连接成功（${result.latencyMs} ms）` }
        : { kind: 'err', text: `连接失败：${result.error}` });
    } catch (err) {
      setNotice({ kind: 'err', text: `测试失败：${describeAIError(err)}` });
    } finally {
      setBusy(null);
    }
  }, [dirty, persist]);

  const handleFetchModels = useCallback(async () => {
    setNotice(null);
    setModelListError('');
    if (dirty && !(await persist())) return;
    setFetchingModels(true);
    try {
      const result = await listAIModels();
      if (result.ok) {
        setModels(result.models);
        if (result.models.length === 0) setModelListError('服务端返回了空模型列表，请手动填写模型名');
        // ★ 拉到了就**直接摊开**（原生 datalist 不弹，用户以为"没显示"）
        else { setModelQuery(null); setModelMenuOpen(true); }
      } else {
        setModels([]);
        setModelListError(result.error);
      }
    } catch (err) {
      setModels([]);
      setModelListError(`拉取失败：${describeAIError(err)}`);
    } finally {
      setFetchingModels(false);
    }
  }, [dirty, persist]);

  if (loadState === 'loading') {
    return (
      <section className="nm-card p-6">
        <h2 className="nm-section-title">AI 设置</h2>
        <p className="text-[11px] inline-flex items-center gap-2" style={{ color: MUTED }}>
          <Loader2 size={14} className="animate-spin" /> 正在读取配置…
        </p>
      </section>
    );
  }

  if (loadState === 'error') {
    return (
      <section className="nm-card p-6">
        <h2 className="nm-section-title">AI 设置</h2>
        <p className="text-[11px] inline-flex items-center gap-2" style={{ color: 'hsl(var(--destructive))' }}>
          <AlertTriangle size={14} /> {loadError}
        </p>
        <button type="button" onClick={() => setReloadToken((t) => t + 1)} className={`${BTN_SOFT} mt-4`}>
          <RefreshCw size={14} /> 重试
        </button>
      </section>
    );
  }

  const sourceNote = config ? describeConfigSource(config) : null;
  const keyMissing = Boolean(config) && !config!.apiKeyConfigured && !clearApiKey && provider !== 'ollama';

  return (
    <>
      <section className="nm-card p-6">
        <h2 className="nm-section-title flex items-center gap-2">
          <Bot size={15} /> 模型提供商
        </h2>
        <p className="text-[11px] leading-relaxed" style={{ color: MUTED }}>
          配置保存在本机数据库。API Key 只存服务端、从不回传明文 —— 界面上看到的
          {' '}<code style={{ color: INK }}>***xxxx</code>{' '}
          是后 4 位脱敏提示。
        </p>

        {(sourceNote || keyMissing) && (
          <div className="mt-4 rounded-lg px-3 py-2 text-[11px] leading-relaxed"
            style={{
              background: 'rgb(var(--glass-tint) / 0.35)',
              border: `0.5px solid ${BORDER}`,
              color: MUTED,
            }}
          >
            {sourceNote && <div className="inline-flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{sourceNote}</span>
            </div>}
            {keyMissing && <div className="inline-flex items-start gap-1.5 mt-1">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>未配置 API Key —— 除本地 Ollama 外，AI 调用会以 401 失败。</span>
            </div>}
          </div>
        )}

        <div className="mt-5">
          <span className="nm-label">提供商</span>
          <div className="flex flex-wrap items-center gap-2">
            {PROVIDER_KEYS.map((key) => {
              const active = provider === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setProvider(key)}
                  aria-pressed={active}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] transition-colors"
                  style={{
                    background: active ? 'rgb(var(--glass-tint) / 0.6)' : 'transparent',
                    border: active ? '1px solid hsl(var(--ring) / 0.7)' : `0.5px solid ${BORDER}`,
                    color: INK,
                    cursor: 'pointer',
                  }}
                >
                  {active && <Check size={13} />}
                  {PROVIDER_PRESETS[key].label}
                </button>
              );
            })}
          </div>
          <span className="block text-[10px] mt-1.5" style={{ color: MUTED }}>{preset.hint}</span>
        </div>

        <Field
          label="服务地址（baseUrl）"
          hint="留空则回落到服务端默认地址；被服务端 SSRF 校验拦截的地址会直接拒绝保存"
        >
          <input
            type="text"
            className={INPUT_CLASS}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset.baseUrlPlaceholder}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>

        <Field
          label="API Key"
          hint={clearApiKey
            ? '已勾选清除：保存后会删除服务端已存密钥'
            : config?.apiKeyConfigured
              ? `已配置 ${config.apiKeyHint}；留空表示不改动`
              : 'Ollama 通常不需要；其它提供商必填'}
        >
          <div className="flex items-center gap-2">
            <input
              type="password"
              className={`${INPUT_CLASS} ${clearApiKey ? 'opacity-40' : ''}`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={clearApiKey}
              placeholder={config?.apiKeyConfigured ? '留空 = 保持现有密钥' : 'sk-...'}
              spellCheck={false}
              autoComplete="off"
            />
            {config?.apiKeyConfigured && !clearApiKey && (
              <button type="button" className="nm-btn-danger-outline px-3 py-2 text-xs rounded-md shrink-0"
                onClick={() => { setClearApiKey(true); setApiKey(''); }}>
                <span className="inline-flex items-center gap-1"><Trash2 size={12} /> 清除</span>
              </button>
            )}
            {clearApiKey && (
              <button type="button" className={`${BTN_TINY} shrink-0`} onClick={() => setClearApiKey(false)}>
                撤消
              </button>
            )}
          </div>
        </Field>

        <Field label="模型" hint="拉取列表失败时可直接手填（部分中转站不开放 /models）">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0" ref={modelBoxRef}>
              <input
                type="text"
                className={INPUT_CLASS}
                value={model}
                onChange={(e) => { setModel(e.target.value); setModelQuery(e.target.value); setModelMenuOpen(true); }}
                onFocus={() => { setModelQuery(null); if (models.length > 0) setModelMenuOpen(true); }}
                // ★ 用 onClick 而不是只靠 onFocus：选完一项后菜单关掉、但输入框**没失焦**，
                //   再点它不会再触发 focus ⇒ 想换一个模型时列表不弹（实测发现）。
                onClick={() => { setModelQuery(null); if (models.length > 0) setModelMenuOpen(true); }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setModelMenuOpen(false);
                  // ↓ 直接拉出列表（原生 datalist 的老习惯，保留）：列全部，不做过滤
                  if (e.key === 'ArrowDown' && models.length > 0) { e.preventDefault(); setModelQuery(null); setModelMenuOpen(true); }
                }}
                placeholder="gpt-4o-mini"
                spellCheck={false}
                autoComplete="off"
                role="combobox"
                aria-expanded={modelMenuOpen}
                aria-controls="nm-ai-model-menu"
                aria-autocomplete="list"
              />
              {/* ★ 2026-10-26 自绘下拉（替代原生 <datalist>）：
                  原生 datalist 只在「点进输入框 + 打字/按 ↓」时才弹 —— 点「拉取列表」
                  拉到了模型也**看不到任何东西**（用户口径"获取模型下拉没有显示"）。
                  自绘列表在**拉取成功后自动展开**，点一项即填入，且支持输入即过滤。 */}
              {modelMenuOpen && filteredModels.length > 0 && (
                <ul
                  id="nm-ai-model-menu"
                  role="listbox"
                  aria-label="可用模型"
                  className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border py-1 shadow-lg"
                  style={{ background: 'hsl(var(--card))', borderColor: BORDER }}
                >
                  {filteredModels.map((m) => (
                    <li key={m.id} role="option" aria-selected={m.id === model}>
                      <button
                        type="button"
                        // mousedown 阻止默认：否则输入框先失焦，click 还没落地列表就被关掉
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setModel(m.id); setModelQuery(null); setModelMenuOpen(false); }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[hsl(var(--mist-pale))]"
                        style={{ color: INK }}
                      >
                        <Check
                          size={12}
                          aria-hidden="true"
                          style={{ color: m.id === model ? 'hsl(var(--primary))' : 'transparent' }}
                        />
                        <span className="truncate">{m.name || m.id}</span>
                        {m.name && m.name !== m.id && (
                          <span className="ml-auto shrink-0 truncate text-[9.5px]" style={{ color: MUTED }}>{m.id}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button type="button" className={`${BTN_TINY} shrink-0`}
              onClick={handleFetchModels} disabled={busy !== null || fetchingModels}>
              <span className="inline-flex items-center gap-1">
                {fetchingModels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                拉取列表{models.length > 0 ? `（${models.length}）` : ''}
              </span>
            </button>
          </div>
          {modelListError && (
            <span className="block text-[10px] mt-1.5" style={{ color: 'hsl(var(--destructive) / 0.9)' }}>
              {modelListError}
            </span>
          )}
          {!modelListError && models.length > 0 && (
            <span className="block text-[10px] mt-1.5" style={{ color: MUTED }}>
              已拉取 {models.length} 个模型 —— 点输入框（或按 ↓）挑一个；打字可过滤，也可直接手填
            </span>
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-2 mt-6">
          <button type="button" className={BTN_PRIMARY} onClick={handleSave} disabled={busy !== null}>
            {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
          <button type="button" className={BTN_SOFT} onClick={handleTest} disabled={busy !== null}>
            {busy === 'test' ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {dirty ? '保存并测试连接' : '测试连接'}
          </button>
          {dirty && <span className="text-[10px]" style={{ color: MUTED }}>有未保存的改动</span>}
        </div>

        {notice && (
          <p className="text-[11px] mt-3 leading-relaxed"
            style={{
              color: notice.kind === 'err'
                ? 'hsl(var(--destructive) / 0.9)'
                : notice.kind === 'warn' ? MUTED : 'hsl(var(--primary))',
            }}
          >
            {notice.text}
          </p>
        )}

        {testResult?.connected && (
          <div className="mt-3 rounded-lg px-3 py-2 text-[10px] font-mono break-all"
            style={{ background: 'rgb(var(--glass-tint) / 0.35)', border: `0.5px solid ${BORDER}`, color: MUTED }}>
            模型回包：{testResult.response || '（空）'}
          </div>
        )}
      </section>

      <section className="nm-card p-6 mt-6">
        <h2 className="nm-section-title">生成参数</h2>
        <p className="text-[11px] leading-relaxed" style={{ color: MUTED }}>
          留空 = 不干预，由服务商默认值决定（不是 0）。已填的数值保存后对所有 AI 请求生效。
        </p>

        <div className="grid gap-4 sm:grid-cols-2 mt-4">
          {SAMPLING_KEYS.map((key) => {
            const spec = SAMPLING_SPEC[key];
            return (
              <div key={key}>
                <span className="nm-label">
                  {spec.label}
                  <span className="ml-1.5 font-normal text-[10px]" style={{ color: MUTED }}>{spec.hint}</span>
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    className={INPUT_CLASS}
                    value={sampling[key]}
                    onChange={(e) => setSampling((s) => ({ ...s, [key]: e.target.value }))}
                    placeholder="服务商默认"
                  />
                  <button type="button" className={`${BTN_TINY} shrink-0`}
                    onClick={() => setSampling((s) => ({ ...s, [key]: '' }))}
                    disabled={sampling[key] === ''}>
                    清空
                  </button>
                </div>
                <span className="block text-[10px] mt-1" style={{ color: MUTED }}>
                  范围 {spec.min} ~ {spec.max}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-6">
          <button type="button" className={BTN_PRIMARY} onClick={handleSave} disabled={busy !== null}>
            {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
          {dirty && <span className="text-[10px]" style={{ color: MUTED }}>有未保存的改动</span>}
        </div>
      </section>
    </>
  );
}
