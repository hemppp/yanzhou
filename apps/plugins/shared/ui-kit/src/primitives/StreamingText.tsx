import type { ReactNode } from 'react';
import { cn } from './utils';

/**
 * 流式文本（Streaming Text）
 *
 * 只干两件事：**在生成中的文本尾部挂一个光标**，以及**在下方挂来源/后续动作**。
 * 正文的 Markdown 解析交给调用方（ChatPanel 有自己的 memo 化渲染器），
 * 这样原语层不引入 markdown 依赖，也不破坏那边的 memo 边界。
 *
 * 光标用 CSS 动画（.mc-caret），不用 React 状态逐帧渲染 —— 后者会在
 * 流式过程中制造大量无意义的重渲染。
 */

export function StreamingText({
  streaming,
  children,
  className,
}: {
  streaming?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      {children}
      {streaming && (
        <span className="mc-caret" aria-hidden="true" />
      )}
      {streaming && <span className="sr-only">正在生成回复</span>}
    </div>
  );
}

export interface SourceRef {
  id: string;
  /** 显示用的名字首字，如「角」「地」 */
  short: string;
  /** 完整名称，用于 title / aria-label */
  name: string;
}

/**
 * 来源堆叠（Source Stack）
 *
 * 该库手法：重叠的头像圈（-space-x-1）+ 每圈一道 1.5px 底色描边把彼此切开。
 * 这里换成"墨圈" —— 单色下靠描边而非颜色区分谁是谁。
 */
export function SourceStack({ sources, className }: { sources: SourceRef[]; className?: string }) {
  if (!sources.length) return null;
  const shown = sources.slice(0, 4);
  const rest = sources.length - shown.length;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex -space-x-1" role="list" aria-label="参考来源">
        {shown.map((s) => (
          <span
            key={s.id}
            role="listitem"
            title={s.name}
            aria-label={s.name}
            className={cn(
              'flex size-4 items-center justify-center rounded-full',
              'bg-paper text-[10px] font-medium text-tone-2',
              'shadow-[0_0_0_1.5px_hsl(var(--paper-canvas))]',
            )}
          >
            {s.short}
          </span>
        ))}
      </div>
      <span className="mc-num text-[10px] text-tone-3">
        {sources.length} 处来源{rest > 0 ? `（+${rest}）` : ''}
      </span>
    </div>
  );
}

/**
 * 行内后续动作 —— 该库的 animated-underline：
 * 常态无底线，hover 时从左划出一道墨线。比按钮更轻，适合挂在段落末尾。
 */
export function InlineActions({
  actions,
  className,
}: {
  actions: Array<{ key: string; label: string; onClick: () => void; disabled?: boolean }>;
  className?: string;
}) {
  if (!actions.length) return null;
  return (
    <div className={cn('mt-2.5 flex flex-wrap items-center gap-1', className)}>
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={a.onClick}
          disabled={a.disabled}
          className={cn(
            'mc-focus group/ia relative rounded-chip px-1.5 py-0.5 text-[10.5px] font-medium',
            'text-tone-2 transition-colors duration-150 ease-out hover:text-tone',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {a.label}
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-x-1.5 bottom-0 h-px origin-left scale-x-0 bg-paper-line-strong',
              'transition-transform duration-200 ease-link group-hover/ia:scale-x-100',
            )}
          />
        </button>
      ))}
    </div>
  );
}
