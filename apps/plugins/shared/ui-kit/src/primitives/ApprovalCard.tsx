import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { SignalDot } from './Signal';
import { cn, type SignalTone } from './utils';

/**
 * 审批卡片（Approval Card）—— 人机回环（human-in-the-loop）。
 *
 * 用于 Agent 在"动手改你的稿子/设定"之前请你确认。
 *
 * 设计取舍（来自 2026-09-16 审计的教训）：
 *   · 审批是**阻塞性**的，所以必须视觉上"压住"对话流：给 shadow-card + 显式边框，
 *     而不是像普通气泡那样融在背景里 —— 用户漏看一次就白跑一回合。
 *   · 两个动作**不能等重**：同意是主按钮（浓墨实心），驳回是次按钮（只有勾线）。
 *     等重会让误点概率翻倍，而驳回是破坏性的。
 *   · 键盘焦点默认落在**驳回**上吗？不 —— 落在卡片本身，让用户先读完。
 */

export function ApprovalCard({
  title,
  description,
  /** 待确认的具体内容（diff / 文本预览 / 清单），可为空 */
  preview,
  /** 附加元信息，如「影响 3 个角色 · 2 处伏笔」 */
  meta,
  tone = 'warn',
  approveLabel = '同意',
  rejectLabel = '驳回',
  onApprove,
  onReject,
  /** 提交中：两个按钮同时禁用，防止重复提交 */
  busy = false,
  className,
}: {
  title: string;
  description?: string;
  preview?: ReactNode;
  meta?: string;
  tone?: SignalTone;
  approveLabel?: string;
  rejectLabel?: string;
  onApprove: () => void;
  onReject: () => void;
  busy?: boolean;
  className?: string;
}) {
  return (
    <section
      aria-label={`待审批：${title}`}
      className={cn(
        'w-full max-w-[22rem] overflow-hidden rounded-card bg-paper shadow-card',
        'border border-paper-line-strong',
        className,
      )}
    >
      {/* 顶部：状态点 + 标题 */}
      <header className="flex items-start gap-2 px-3 pb-2 pt-3">
        <span className="mt-1.5 shrink-0">
          <SignalDot tone={tone} pulse={busy} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[11.5px] font-semibold leading-tight text-tone">{title}</h3>
            <span className="mc-eyebrow">待确认</span>
          </div>
          {description && (
            <p className="mt-1 text-[10.5px] leading-relaxed text-tone-2">{description}</p>
          )}
        </div>
      </header>

      {/* 待确认内容 */}
      {preview && (
        <div className="mc-scroll mx-3 mb-2.5 max-h-56 overflow-auto rounded-card bg-paper-inset">
          {preview}
        </div>
      )}

      {/* 底部：元信息 + 两个不等重的动作 */}
      <footer className="flex items-center justify-between gap-3 border-t border-paper-line px-3 py-2.5">
        <span className="mc-num min-w-0 truncate text-[10px] text-tone-3">{meta}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className={cn(
              'mc-press mc-focus inline-flex h-[27px] items-center rounded-control px-2.5',
              'text-[11px] font-medium text-tone-2 transition-colors duration-150 ease-out',
              'bg-paper-hover-2 hover:bg-paper-line-strong hover:text-tone',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <X size={12} className="mr-1" aria-hidden="true" />
            {rejectLabel}
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className={cn(
              'mc-press mc-focus mc-sheen inline-flex h-[27px] items-center rounded-control px-3',
              'text-[11px] font-medium transition-opacity duration-150 ease-out',
              'bg-primary text-primary-foreground hover:opacity-90',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <Check size={12} className="mr-1" aria-hidden="true" />
            {approveLabel}
          </button>
        </span>
      </footer>
    </section>
  );
}

/**
 * 审批占位态：Agent 还在准备待审内容时的骨架。
 * 用同一套卡片骨架，避免"加载中"和"已就绪"之间发生布局跳动。
 */
export function ApprovalCardSkeleton({ title, className }: { title: string; className?: string }) {
  return (
    <section
      className={cn(
        'flex w-full max-w-[22rem] items-center gap-2 rounded-card bg-paper px-3 py-3 shadow-card',
        'border border-paper-line',
        className,
      )}
      aria-busy="true"
      aria-label={`${title}（准备中）`}
    >
      <SignalDot tone="run" pulse />
      <span className="text-[10.5px] text-tone-2">{title}，正在准备…</span>
    </section>
  );
}

/** 供外部拼 meta 文案用，保证口径一致（空值自动跳过）。 */
export function approvalMeta(parts: Array<string | number | undefined | null>): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(' · ');
}
