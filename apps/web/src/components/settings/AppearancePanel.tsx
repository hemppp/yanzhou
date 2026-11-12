// ============================================================
// 外观面板 —— 换肤入口（设置页 → 外观）
//
// 三个维度：**主题**（色彩性格 + 自带字体搭配）× **明暗** × **字体覆盖**。
// 清单与状态在 `stores/themeStore.ts`，这里只负责呈现与选择。
//
// 说明：换肤改的是 CSS 变量层 —— ui-kit 的 styles/identity.css 是 `--yz-*` 锚点真源，
//   styles/themes.css 各档以 `html[data-theme='<id>']` 覆盖锚点，vscode-dark-modern.css
//   与 globals.css 全是它的别名（组件不需要知道当前是哪档）。字体同理：
//   `--yz-font-{ui,reading,display,mono}` 由主题档给默认值，本页的字体选择器再以
//   **行内自定义属性**覆盖主题档（行内恒胜样式表，故不必比特异性）。
// ============================================================

import { Check, Moon, Sun } from 'lucide-react';
import {
  THEMES,
  FONTS,
  useThemeStore,
  type ColorMode,
  type FontKind,
} from '@/stores/themeStore';

const MODES: ReadonlyArray<{ key: ColorMode; label: string; icon: typeof Sun }> = [
  { key: 'light', label: '亮色', icon: Sun },
  { key: 'dark', label: '暗色', icon: Moon },
];

/** 字体选择器的三行。mono 刻意不给 —— 等宽字体只用于数据对齐/代码，不是外观项。 */
const FONT_ROWS: ReadonlyArray<{ kind: FontKind; label: string; hint: string }> = [
  { kind: 'ui', label: '界面字体', hint: '顶栏 / 面板 / 按钮等一切界面骨架' },
  { kind: 'reading', label: '正文字体', hint: '编辑器里的章节正文' },
  { kind: 'display', label: '标题字体', hint: '书名 / 章标题 / 书封 / 图谱节点名' },
];

export function AppearancePanel() {
  const theme = useThemeStore((s) => s.theme);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setMode = useThemeStore((s) => s.setMode);
  const fonts = useThemeStore((s) => s.fonts);
  const setFont = useThemeStore((s) => s.setFont);

  const current = THEMES.find((t) => t.id === theme);
  const modeLocked = Boolean(current?.lockedMode);

  return (
    <>
      <section className="nm-card p-6">
        <h2 className="nm-section-title">主题</h2>
        <p
          className="text-[11px] leading-relaxed mb-4"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          换肤只改颜色与形态的变量层，组件代码不动 —— 所以所有页面与插件面板会一起换。
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((t) => {
            const active = theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                aria-pressed={active}
                className="text-left rounded-xl p-3 transition-colors"
                style={{
                  background: active ? 'rgb(var(--glass-tint) / 0.6)' : 'rgb(var(--glass-tint) / 0.3)',
                  border: active
                    ? '1px solid hsl(var(--ring) / 0.8)'
                    : '0.5px solid hsl(var(--border) / 0.7)',
                  cursor: 'pointer',
                }}
              >
                {/* 色卡：底色 / 主色 / 强调色 */}
                <div className="flex items-center gap-1.5 mb-2.5">
                  {t.swatch.map((c) => (
                    <span
                      key={c}
                      className="rounded-md"
                      style={{
                        width: 26,
                        height: 26,
                        background: c,
                        border: '0.5px solid hsl(var(--border) / 0.5)',
                      }}
                      aria-hidden="true"
                    />
                  ))}
                  {active && (
                    <Check size={14} className="ml-auto" style={{ color: 'hsl(var(--primary))' }} />
                  )}
                </div>
                <div className="text-[12px] font-medium mb-0.5" style={{ color: 'hsl(var(--ink))' }}>
                  {t.name}
                </div>
                <div className="text-[10px] leading-snug" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {t.desc}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="nm-card p-6 mt-6">
        <h2 className="nm-section-title">明暗</h2>
        <div className="flex items-center gap-2">
          {MODES.map((m) => {
            const active = mode === m.key;
            const disabled = modeLocked && !active;
            const Icon = m.icon;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                aria-pressed={active}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] transition-colors disabled:opacity-35"
                style={{
                  background: active ? 'rgb(var(--glass-tint) / 0.6)' : 'transparent',
                  border: active
                    ? '1px solid hsl(var(--ring) / 0.7)'
                    : '0.5px solid hsl(var(--border) / 0.7)',
                  color: 'hsl(var(--ink))',
                  cursor: disabled ? 'default' : 'pointer',
                }}
              >
                <Icon size={14} />
                {m.label}
              </button>
            );
          })}
        </div>
        {modeLocked && (
          <p className="text-[10px] mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
            「{current?.name}」自带固定明暗，切换明暗对它无效。
          </p>
        )}
      </section>

      <section className="nm-card p-6 mt-6">
        <h2 className="nm-section-title">字体</h2>
        <p
          className="text-[11px] leading-relaxed mb-4"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          每套主题自带一组字体搭配（如「宣纸」用楷体、「素笺」正文用黑体）。
          留「跟随主题」即用该主题的搭配；单独指定则覆盖它，存本地、刷新不丢。
        </p>

        <div className="space-y-4">
          {FONT_ROWS.map((row) => {
            const active = fonts[row.kind];
            const options = FONTS.filter((f) => f.kinds.includes(row.kind));
            return (
              <div key={row.kind}>
                <div className="flex items-baseline gap-2 mb-1.5">
                  <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--ink))' }}>
                    {row.label}
                  </span>
                  <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {row.hint}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFont(row.kind, undefined)}
                    aria-pressed={active === undefined}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] transition-colors"
                    style={{
                      background: active === undefined ? 'rgb(var(--glass-tint) / 0.6)' : 'transparent',
                      border:
                        active === undefined
                          ? '1px solid hsl(var(--ring) / 0.7)'
                          : '0.5px solid hsl(var(--border) / 0.7)',
                      color: 'hsl(var(--ink))',
                      cursor: 'pointer',
                    }}
                  >
                    跟随主题
                  </button>
                  {options.map((f) => {
                    const on = active === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setFont(row.kind, f.id)}
                        aria-pressed={on}
                        // 按钮**自身**用该字体渲染 —— 选的什么一眼能看见，不必猜名字
                        style={{
                          fontFamily: f.stack,
                          background: on ? 'rgb(var(--glass-tint) / 0.6)' : 'transparent',
                          border: on
                            ? '1px solid hsl(var(--ring) / 0.7)'
                            : '0.5px solid hsl(var(--border) / 0.7)',
                          color: 'hsl(var(--ink))',
                          cursor: 'pointer',
                          padding: '6px 12px',
                          borderRadius: 'var(--r-sm)',
                          fontSize: 12,
                        }}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[10px] leading-snug mt-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
          字体取自**系统已装字体**，不加载任何网络字体（离线可用，也避免首屏等待）。
          若所选字体的字形在本机缺失，会沿字体栈自动回退到宋体/系统默认。
        </p>
      </section>
    </>
  );
}
