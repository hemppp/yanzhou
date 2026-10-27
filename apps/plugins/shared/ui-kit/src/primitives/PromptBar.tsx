import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Loader2, Square } from 'lucide-react';
import { cn } from './utils';

/**
 * 提示栏（Prompt Bar）—— 对话的输入区，也是整个 AI 面观感的"门面"。
 *
 * 该库的几个关键手法，这里都保留了：
 *   · 圆角取 window 档（14px），是这套体系里最大的圆角 —— 输入区要"厚"。
 *   · 常态只有一根墨线，聚焦时墨线加粗（focus-within:border-line-strong），
 *     不做发光/描彩 —— 单色体系里"变粗"比"变色"更有效。
 *   · 输入框自动长高（autoGrow），到上限内部滚动，不撑破面板。
 *
 * ★ 中文输入法：composition 期间回车**不能**当发送。
 *   IME 选字候选框上按回车是"确认候选"，若此时发送会直接把半截拼音发出去。
 *   这是中文写作工具最容易漏的一处（项目内此前也没有处理）。
 */

export function PromptBar({
  value,
  onChange,
  onSubmit,
  /** 工具条：放技能开关、@ 引用、模型选择器等业务控件 */
  toolbar,
  /** 右侧按钮左侧的附加控件，如字数 */
  accessory,
  placeholder = '说点什么…',
  disabled = false,
  /** 生成中：主按钮变成"停止" */
  streaming = false,
  onStop,
  /** 输入区下方的一行提示，如「Enter 发送 · Shift+Enter 换行」 */
  hint,
  /** 自动长高的行数上限，默认 8 */
  maxRows = 8,
  className,
  autoFocus = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  toolbar?: ReactNode;
  accessory?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  streaming?: boolean;
  onStop?: () => void;
  hint?: ReactNode;
  maxRows?: number;
  className?: string;
  autoFocus?: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [composing, setComposing] = useState(false);

  // 自动长高：先归零再读 scrollHeight，否则高度只增不减
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const style = window.getComputedStyle(ta);
    const lineHeight = Number.parseFloat(style.lineHeight) || 18;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const max = lineHeight * maxRows + padding;

    ta.style.height = 'auto';
    const next = Math.min(ta.scrollHeight, max);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, maxRows]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const canSubmit = !disabled && !streaming && value.trim().length > 0;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ★ 输入法合成中：一律不处理回车（让 IME 自己确认候选）
      if (e.key === 'Enter' && (composing || e.nativeEvent.isComposing)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }
    },
    [canSubmit, composing, onSubmit],
  );

  return (
    <div
      className={cn(
        'group/pb w-full rounded-window border border-paper-line bg-paper shadow-card',
        'transition-[border-color] duration-150 ease-out focus-within:border-paper-line-strong',
        disabled && 'opacity-60',
        className,
      )}
    >
      {/* 输入区 */}
      <div className="px-2.5 pt-2.5">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="输入消息"
          className={cn(
            'mc-scroll block w-full resize-none bg-transparent text-[11.5px] leading-[1.55] text-tone',
            'outline-none [overflow-wrap:anywhere] placeholder:text-tone-3',
          )}
        />
      </div>

      {/* 底栏：工具条 + 附件 + 主按钮 */}
      <div className="flex items-end gap-1.5 px-1.5 pb-1.5 pt-1">
        {toolbar && <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{toolbar}</div>}
        {!toolbar && <span className="flex-1" />}

        {accessory && <span className="mc-num shrink-0 text-[10px] text-tone-3">{accessory}</span>}

        {streaming && onStop ? (
          <button
            type="button"
            onClick={onStop}
            title="停止生成"
            aria-label="停止生成"
            className={cn(
              'mc-press mc-focus flex size-7 shrink-0 items-center justify-center rounded-control',
              'bg-paper-hover-2 text-tone-2 transition-colors duration-150 ease-out',
              'hover:bg-paper-line-strong hover:text-tone',
            )}
          >
            <Square size={11} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            title="发送（Enter）"
            aria-label="发送"
            className={cn(
              'mc-press mc-focus mc-sheen flex size-7 shrink-0 items-center justify-center rounded-control',
              'bg-primary text-primary-foreground transition-opacity duration-150 ease-out',
              'enabled:hover:opacity-90 disabled:opacity-30 disabled:pointer-events-none',
            )}
          >
            {disabled && !streaming ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUp size={14} aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      {hint && <div className="border-t border-paper-line px-3 py-1.5 text-[10px] text-tone-3">{hint}</div>}
    </div>
  );
}
