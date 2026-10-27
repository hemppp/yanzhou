// ============================================================
// 外观面板 —— 换肤入口（设置页 → 外观）
//
// 两个正交维度：**主题**（色彩性格 / 形态）× **明暗**。
// 主题清单与状态在 `stores/themeStore.ts`，这里只负责呈现与选择。
//
// 说明：换肤改的是 CSS 变量层（ui-kit 的 styles/vscode-dark-modern.css 在
//   `:root, html.dark` 定义 --vscode-* 真源，每个颜色写成 light-dark(浅, 深)、
//   按 <html> 的 color-scheme 取档；globals.css 的语义层引用它），
//   组件本身不需要知道当前是哪个主题 —— 所以新增主题不必碰组件代码。
// ============================================================

import { Check, Moon, Sun } from 'lucide-react';
import { THEMES, useThemeStore, type ColorMode } from '@/stores/themeStore';

const MODES: ReadonlyArray<{ key: ColorMode; label: string; icon: typeof Sun }> = [
  { key: 'light', label: '亮色', icon: Sun },
  { key: 'dark', label: '暗色', icon: Moon },
];

export function AppearancePanel() {
  const theme = useThemeStore((s) => s.theme);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setMode = useThemeStore((s) => s.setMode);

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
    </>
  );
}
