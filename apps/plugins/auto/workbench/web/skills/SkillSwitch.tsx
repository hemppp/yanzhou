// ============================================================
// 技能开关 —— **左关右开**
//
// 为什么不用 checkbox：这个开关是"给某个智能体开一条技能"，
// 左「关」右「开」把两个状态**都写出来**，作者不用靠颜色/位置猜现在是哪一态。
// （纯色滑块那种开关在窄栏里很容易看错，而这个界面里看错的代价是"以为开了其实没开"。）
//
// 可访问性：真按钮 + role="switch" + aria-checked，键盘可操作。
// ============================================================

export function SkillSwitch({
  enabled, onChange, disabled, busy, label,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 请求进行中：按钮禁用但**不回退视觉状态**（否则会有"点完弹回去"的错觉） */
  busy?: boolean;
  /** 无障碍名（如「世界观顾问 技能开关」） */
  label: string;
}) {
  const off = disabled || busy;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={enabled ? '点击关闭' : '点击开启'}
      disabled={off}
      onClick={() => onChange(!enabled)}
      className="relative shrink-0 select-none transition-all"
      style={{
        width: 62,
        height: 26,
        borderRadius: 'var(--r-pill)',
        border: `1px solid ${enabled ? 'hsl(var(--state-done, 142 71% 45%))' : 'hsl(var(--border))'}`,
        background: enabled
          ? 'linear-gradient(135deg, hsl(var(--state-done, 142 71% 45%) / 0.20), hsl(var(--state-done, 142 71% 45%) / 0.10))'
          : 'hsl(var(--muted) / 0.6)',
        opacity: off ? 0.55 : 1,
        cursor: off ? 'not-allowed' : 'pointer',
        padding: 0,
      }}
    >
      {/* 左：关 */}
      <span
        style={{
          position: 'absolute', left: 10, top: 0, height: 24, lineHeight: '24px',
          fontSize: 11, fontWeight: 600,
          color: enabled ? 'hsl(var(--muted-foreground) / 0.7)' : 'hsl(var(--foreground))',
        }}
        aria-hidden="true"
      >
        关
      </span>
      {/* 右：开 */}
      <span
        style={{
          position: 'absolute', right: 10, top: 0, height: 24, lineHeight: '24px',
          fontSize: 11, fontWeight: 600,
          color: enabled ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground) / 0.7)',
        }}
        aria-hidden="true"
      >
        开
      </span>
      {/* 滑块：在左 = 关，在右 = 开 */}
      <span
        data-knob={enabled ? 'on' : 'off'}
        style={{
          position: 'absolute',
          top: 1,
          left: enabled ? 36 : 1,
          width: 22,
          height: 22,
          borderRadius: 'var(--r-pill)',
          background: 'hsl(var(--background))',
          boxShadow: '0 1px 3px hsl(var(--ink-deep, 220 20% 10%) / 0.25)',
          transition: 'left 160ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        aria-hidden="true"
      />
    </button>
  );
}
