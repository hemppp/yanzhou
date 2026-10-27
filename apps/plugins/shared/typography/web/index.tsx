// 字体排版 —— 编辑器中文字的显示粗细与颜色
// Web 面：面板（实时调节）+ 设置区（默认值）+ 命令（快速切换粗细）
import React from 'react';
import { Type, Palette, RotateCcw, Check } from 'lucide-react';
import type { WebPluginContext, WebApiFetch } from '@novel/core/web';

// ★ 带鉴权 API（C7）：由 apply() 注入 ctx.api，组件与命令统一走此封装（自动带 JWT/项目头），
//   禁止使用裸 fetch——服务端 /api/plugins/* 已默认要求登录。
let apiFetch: WebApiFetch = (path, init) => fetch(path, init);

// ════════════ 样式注入与实时应用（模块级共享） ════════════

const STYLE_ID = 'novel-typography-style';

export interface TypographySettings {
  weight: number;
  color: string | null; // null = 跟随主题
}

const WEIGHTS = [
  { value: 300, label: '细' },
  { value: 400, label: '常规' },
  { value: 500, label: '中' },
  { value: 600, label: '半粗' },
  { value: 700, label: '粗' },
] as const;

/** 预设色板（深浅主题均可用） */
const PALETTE: Array<{ value: string | null; label: string }> = [
  { value: null, label: '跟随主题' },
  { value: '#1f2328', label: '墨黑' },
  { value: '#6b4f2e', label: '暖棕' },
  { value: '#3d6b4f', label: '护眼绿' },
  { value: '#4a5d8f', label: '靛蓝' },
  { value: '#8f4a4a', label: '暗红' },
  { value: '#f2ead8', label: '纸白' },
];

const DEFAULT_SETTINGS: TypographySettings = { weight: 600, color: null };

/** 当前生效设置（命令与面板共享） */
let current: TypographySettings = { ...DEFAULT_SETTINGS };

/** 确保样式注入（特异性 .nm-editor-content .ProseMirror 压过宿主 .ProseMirror） */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    :root {
      --nm-typography-weight: 600;
      --nm-typography-color: hsl(var(--ink));
    }
    .nm-editor-content .ProseMirror,
    .nm-editor-card .ProseMirror {
      font-weight: var(--nm-typography-weight, 600) !important;
      color: var(--nm-typography-color, hsl(var(--ink))) !important;
    }
  `;
  document.head.appendChild(el);
}

/** 应用设置到 CSS 变量（实时生效） */
export function applySettings(s: TypographySettings): void {
  current = { ...s };
  ensureStyle();
  const root = document.documentElement;
  root.style.setProperty('--nm-typography-weight', String(s.weight));
  if (s.color) {
    root.style.setProperty('--nm-typography-color', s.color);
  } else {
    root.style.removeProperty('--nm-typography-color'); // 回退跟随主题
  }
}

function hexToDisplay(hex: string | null): string {
  return hex ?? '跟随主题';
}

/** 解析任意 hex 输入（宽松校验） */
function normalizeHex(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v.toLowerCase();
  if (/^[0-9a-fA-F]{3,8}$/.test(v)) return `#${v.toLowerCase()}`;
  return null;
}

// ════════════ 面板 ════════════

function TypographyPanel() {
  const [settings, setSettings] = React.useState<TypographySettings>({ ...DEFAULT_SETTINGS });
  const [loaded, setLoaded] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [customHex, setCustomHex] = React.useState('');

  // 加载服务器配置
  React.useEffect(() => {
    apiFetch('/api/plugins/typography/settings')
      .then((r) => r.json())
      .then((data) => {
        const s = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) } as TypographySettings;
        setSettings(s);
        setCustomHex(s.color ?? '');
        applySettings(s);
      })
      .catch((err) => console.warn('[novel.typography] 加载配置失败', err))
      .finally(() => setLoaded(true));
  }, []);

  // 保存（防抖 600ms）
  const save = React.useCallback((s: TypographySettings) => {
    const t = setTimeout(() => {
      apiFetch('/api/plugins/typography/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      })
        .then((r) => r.json())
        .then(() => setSaved(true))
        .catch((err) => console.warn('[novel.typography] 保存失败', err));
    }, 600);
    return () => clearTimeout(t);
  }, []);

  const update = (next: TypographySettings) => {
    setSettings(next);
    applySettings(next); // 实时预览
    setSaved(false);
    save(next); // 防抖保存
  };

  const reset = async () => {
    await apiFetch('/api/plugins/typography/settings', { method: 'DELETE' });
    update({ ...DEFAULT_SETTINGS });
    setCustomHex('');
  };

  const pickCustom = (hex: string | null) => {
    setCustomHex(hex ?? '');
    if (hex) update({ ...settings, color: hex });
  };

  return (
    <div className="p-4 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 140px)' }}>
      <p className="text-xs" style={{ color: 'hsl(var(--ink-light))' }}>
        实时应用到编辑器正文（.ProseMirror），保存为用户级偏好
      </p>

      {/* 粗细 */}
      <div>
        <div className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Type size={13} /> 显示粗细：{settings.weight}
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {WEIGHTS.map((w) => (
            <button
              key={w.value}
              onClick={() => update({ ...settings, weight: w.value })}
              style={{
                fontWeight: w.value,
                padding: 'var(--space-3) var(--space-1)',
                // ★ 内联样式优先级最高、与特异性无关 —— 主题里的
                //   外层主题层的 `button { border-radius: … }` 压不过它。
                //   所以走变量引用 + 原值 fallback：未定义该变量时保持原圆角。
                borderRadius: 'var(--r-2xs, 8px)',
                // ★ 必须拆成 longhand！`border: '0.5px solid'` 是**简写**，
                //   按规范会把 border-image 重置为 none —— 笔触边框就画不出来了。
                //   （2026-09-18 实测：设置页 5 个粗细按钮全部丢笔触，就是这个原因）
                borderWidth: '0.5px',
                borderStyle: 'solid',
                borderColor: settings.weight === w.value ? 'hsl(var(--primary))' : 'hsl(var(--border) / 0.6)',
                background: settings.weight === w.value ? 'hsl(var(--primary) / 0.12)' : 'transparent',
                color: 'hsl(var(--ink))',
                cursor: 'pointer',
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* 颜色 */}
      <div>
        <div className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Palette size={13} /> 文字颜色：{hexToDisplay(settings.color)}
        </div>
        <div className="flex flex-wrap gap-2">
          {PALETTE.map((c) => (
            <button
              key={c.label}
              title={c.label}
              onClick={() => update({ ...settings, color: c.value })}
              /* ★ `nm-color-swatch` 是给主题的**显式钩子**：
                 色板的 border 承载「选中」语义（选中 = primary 环），
                 所以它刻意**不**加装饰性外框 —— 外框会盖掉选中环。
                 不要依赖 `border` 简写重置 border-image 这个副作用来表达意图，
                 那是隐式的，改成长写就会静默失效。 */
              className="nm-color-swatch"
              style={{
                width: 30,
                height: 30,
                borderRadius: 'var(--r-2xs, 8px)',
                border: '2px solid',
                borderColor: settings.color === c.value ? 'hsl(var(--primary))' : 'hsl(var(--border) / 0.6)',
                background: c.value ?? 'repeating-linear-gradient(45deg, rgb(var(--glass-tint)), rgb(var(--glass-tint)) 4px, transparent 4px, transparent 8px)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {settings.color === c.value && <Check size={14} color="#fff" style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.7))' }} />}
            </button>
          ))}
          {/* 自定义色 */}
          <label
            title="自定义颜色"
            className="nm-color-swatch"
            style={{
              width: 30,
              height: 30,
              borderRadius: 'var(--r-2xs, 8px)',
              border: '2px solid hsl(var(--border) / 0.6)',
              background: customHex && /^#[0-9a-fA-F]{3,8}$/.test(customHex) ? customHex : 'linear-gradient(45deg, #f00 0%, #0f0 50%, #00f 100%)',
              cursor: 'pointer',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <input
              type="color"
              value={normalizeHex(customHex) ?? '#000000'}
              onChange={(e) => pickCustom(e.target.value)}
              style={{ position: 'absolute', inset: -8, opacity: 0, cursor: 'pointer' }}
            />
          </label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={customHex}
            onChange={(e) => {
              const v = e.target.value;
              setCustomHex(v);
              const hex = normalizeHex(v);
              if (hex) update({ ...settings, color: hex });
            }}
            placeholder="#rrggbb 自定义"
            className="flex-1 px-2 py-1 text-xs font-mono rounded border"
            style={{ borderColor: 'hsl(var(--border) / 0.6)', background: 'transparent', color: 'hsl(var(--ink))' }}
          />
          <button
            onClick={reset}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded"
            // ★ 拆长写：`border` 简写会重置 border-image 相关长写属性。
            //   ⚠️ 本文件里「恢复默认」有**两处**（面板一处、设置区一处），
            //   第一轮只改了设置区那个，面板这个漏了 —— 被浮窗面板扫描抓出来。
            //   以后改这种"同款按钮出现多次"的地方，务必 grep 全文数一遍。
            style={{
              borderWidth: '0.5px',
              borderStyle: 'solid',
              borderColor: 'hsl(var(--border) / 0.6)',
              color: 'hsl(var(--ink-light))',
              cursor: 'pointer',
            }}
          >
            <RotateCcw size={11} /> 恢复默认
          </button>
        </div>
      </div>

      {/* 实时预览 */}
      <div
        className="rounded-lg p-3"
        style={{
          background: 'rgb(var(--glass-tint) / 0.35)',
          border: '0.5px solid hsl(var(--border) / 0.5)',
        }}
      >
        <div className="text-xs mb-1" style={{ color: 'hsl(var(--ink-light))' }}>实时预览</div>
        <div style={{ fontWeight: settings.weight, color: settings.color ?? 'hsl(var(--ink))', fontFamily: "'Noto Serif SC', serif", lineHeight: 1.9 }}>
          墨色的风掠过书页，故事在灯火里悄然生长。
        </div>
      </div>

      {saved && <div className="text-xs" style={{ color: 'var(--state-done, #22c55e)' }}>✓ 已保存</div>}
      {!loaded && <div className="text-xs opacity-60">加载中...</div>}
    </div>
  );
}

// ════════════ 设置区（设置页「通用」栏目）════════════

/**
 * 精简设置区：只给粗细快捷选择 + 恢复默认，完整色板留在面板里。
 * 与面板共享同一份服务端配置，改完立刻应用到编辑器。
 */
function TypographySettingsSection() {
  const [settings, setSettings] = React.useState<TypographySettings>({ ...current });
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    apiFetch('/api/plugins/typography/settings')
      .then((r) => r.json())
      .then((data) => {
        const s = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) } as TypographySettings;
        setSettings(s);
        applySettings(s);
      })
      .catch((err) => console.warn('[novel.typography] 加载配置失败', err))
      .finally(() => setLoaded(true));
  }, []);

  const persist = (s: TypographySettings) => {
    setSettings(s);
    applySettings(s);
    apiFetch('/api/plugins/typography/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }).catch((err) => console.warn('[novel.typography] 保存失败', err));
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-5 gap-1.5">
        {WEIGHTS.map((w) => (
          <button
            key={w.value}
            onClick={() => persist({ ...settings, weight: w.value })}
            style={{
              fontWeight: w.value,
              padding: 'var(--space-3) var(--space-1)',
              borderRadius: 'var(--r-2xs, 8px)',
              // 拆长写，别用 `border` 简写（会重置 border-image，笔触就没了）
              borderWidth: '0.5px',
              borderStyle: 'solid',
              borderColor: settings.weight === w.value ? 'hsl(var(--primary))' : 'hsl(var(--border) / 0.6)',
              background: settings.weight === w.value ? 'hsl(var(--primary) / 0.12)' : 'transparent',
              color: 'hsl(var(--ink))',
              cursor: 'pointer',
            }}
          >
            {w.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs" style={{ color: 'hsl(var(--ink-light))' }}>
          当前颜色：{hexToDisplay(settings.color)}（完整色板在工作台「字体排版」面板）
        </span>
        <button
          onClick={async () => {
            await apiFetch('/api/plugins/typography/settings', { method: 'DELETE' });
            persist({ ...DEFAULT_SETTINGS });
          }}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded"
          // 拆长写：`border` 简写会重置 border-image 相关长写属性
          style={{ borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--border) / 0.6)', color: 'hsl(var(--ink-light))', cursor: 'pointer' }}
        >
          <RotateCcw size={11} /> 恢复默认
        </button>
      </div>
      {!loaded && <div className="text-xs opacity-60">加载中...</div>}
    </div>
  );
}

// ════════════ 模块出口 ════════════

export const name = 'novel.typography';
export const inject = ['projectPanels', 'commands', 'settings'];

export function apply(ctx: WebPluginContext): void {
  apiFetch = ctx.api; // 注入带鉴权 fetch（C7）
  applySettings(current); // 初始化注入样式

  ctx.registerProjectPanel({ key: 'typography', label: '字体排版', icon: Type, Component: TypographyPanel, width: 420, height: 640 });
  ctx.registerSettingsSection({
    key: 'novel.typography.settings',
    title: '字体排版',
    description: '编辑器正文的显示粗细（用户级偏好，与工作台面板共享同一份配置）',
    icon: Type,
    category: 'general',
    Component: TypographySettingsSection,
  });
  ctx.registerCommand({
    id: 'novel.typography.cycle-weight',
    title: '字体排版：切换显示粗细',
    keywords: ['字体', '粗细', '排版'],
    run: () => {
      const order = WEIGHTS.map((w) => w.value);
      const idx = order.indexOf(current.weight);
      const nextWeight = order[(idx + 1) % order.length];
      const next = { ...current, weight: nextWeight };
      applySettings(next);
      apiFetch('/api/plugins/typography/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => undefined);
      ctx.logger.info(`[novel.typography] 显示粗细 → ${nextWeight}`);
    },
  });
  ctx.logger.info('字体排版 Web 面已挂载');
}
