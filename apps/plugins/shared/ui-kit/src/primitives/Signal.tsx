import type { ReactNode } from 'react';
import { cn, TONE_BG, TONE_LABEL, TONE_TEXT, type SignalTone } from './utils';

/**
 * 状态指示三件套 —— 本体系唯一的彩色出口。
 *
 * 视觉口径：远看仍是墨点（彩度极低），近看才有颜色。
 * 颜色只承载"状态"，不承载"分类" —— 分类请用形状/图标/文字区分。
 */

/** 状态圆点：6px 实心 + 一圈同色淡晕。 */
export function SignalDot({
  tone = 'idle',
  className,
  pulse = false,
}: {
  tone?: SignalTone;
  className?: string;
  /** 进行中时呼吸，静态状态不要开 */
  pulse?: boolean;
}) {
  return (
    <span
      className={cn('mc-dot', TONE_TEXT[tone], pulse && 'animate-pulse', className)}
      role="img"
      aria-label={TONE_LABEL[tone]}
    />
  );
}

/** 状态胶囊：极淡同色底 + 同色文字（11px，实测过 AA）。 */
export function SignalChip({
  tone = 'idle',
  children,
  className,
  icon,
}: {
  tone?: SignalTone;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <span className={cn('mc-sig-chip', TONE_BG[tone], TONE_TEXT[tone], 'mc-num', className)}>
      {icon}
      {children}
    </span>
  );
}

/**
 * 像素网格加载器（该库 signature）——
 * 3×3 方格交错呼吸。比转圈更有"工序感"，且不占额外空间。
 * 装饰性元素，给 aria-hidden 避免读屏员念出无意义内容。
 */
export function LoadingPixels({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span className="mc-pixels" aria-hidden="true">
        <i /> <i /> <i /> <i /> <i /> <i /> <i /> <i /> <i />
      </span>
      {label ? <span className="text-[10.5px] text-tone-2">{label}</span> : null}
    </span>
  );
}

/**
 * 收起 / 展开容器。
 *
 * 用 grid-template-rows 0fr→1fr 做动画：**内容自然高度，不需要量高度、
 * 不需要猜 max-height**，所以动态内容（流式增长的思考文本）也不会截断。
 * 动画本身定义在 globals.css 的 .mc-collapse 里。
 */
export function Collapse({
  open,
  children,
  id,
  className,
}: {
  open: boolean;
  children: ReactNode;
  /** 与触发按钮的 aria-controls 配对 */
  id?: string;
  className?: string;
}) {
  return (
    <div
      id={id}
      className={cn('mc-collapse', className)}
      data-open={open ? 'true' : 'false'}
      // 收起时不进无障碍树：否则 Tab 键能聚焦到那些被压成 0 高的隐藏按钮
      // （React 19 起 inert 是原生布尔属性）
      inert={!open}
    >
      <div>{children}</div>
    </div>
  );
}
