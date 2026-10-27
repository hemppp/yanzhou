import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Code2, Copy, Check, FileText, Search, Sparkles } from 'lucide-react';
import { Collapse, LoadingPixels, SignalChip } from './Signal';
import { cn, TONE_TEXT, type SignalTone } from './utils';

/**
 * 思维轨迹（Thinking Trace）
 *
 * 两种用法：
 *   1. 裸文本 —— 传 `text`，兼容 ChatPanel 现有的 thinking 字段（推理型模型只给一段文本）
 *   2. 结构化 —— 传 `steps`，按「步骤」渲染：每步一根竖轨节点 + 图标 + 说明
 *
 * 为什么用 grid-template-rows 做展开（.mc-collapse）：
 *   思考文本是**流式增长**的，用 max-height 动画会在长思考时截断，
 *   用 grid 0fr→1fr 则是内容自然高度，边流边撑，不需要任何高度魔法。
 */

export type ThinkingKind = 'reasoning' | 'search' | 'code' | 'note';

export interface ThinkingStep {
  id: string;
  kind?: ThinkingKind;
  /** 一行短标题，如「检索角色设定」 */
  label: string;
  /** 折叠区里的细节，可多行 */
  detail?: string;
  tone?: SignalTone;
}

const KIND_ICON: Record<ThinkingKind, typeof Sparkles> = {
  reasoning: Sparkles,
  search: Search,
  code: Code2,
  note: FileText,
};

const KIND_TEXT: Record<ThinkingKind, string> = {
  reasoning: '推理',
  search: '检索',
  code: '代码',
  note: '笔记',
};

/** 流式过程中的计时器：只在 isStreaming 时跑，卸载/结束即清。 */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startedRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!active) return;
    startedRef.current = Date.now();
    setSeconds(0);
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  return seconds;
}

export function ThinkingTrace({
  text,
  steps,
  isStreaming = false,
  defaultOpen = false,
  className,
  /** 流式结束后自动收起（长思考不占屏）。默认不自动收，避免用户正在读时被抢走。 */
  collapseOnDone = false,
}: {
  text?: string;
  steps?: ThinkingStep[];
  isStreaming?: boolean;
  defaultOpen?: boolean;
  className?: string;
  collapseOnDone?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasStreamingRef = useRef(isStreaming);
  const seconds = useElapsed(isStreaming);

  // 卸载时清掉复制态的重置定时器（避免 setState after unmount）
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (collapseOnDone && wasStreamingRef.current && !isStreaming) setOpen(false);
    wasStreamingRef.current = isStreaming;
  }, [collapseOnDone, isStreaming]);

  const copyPayload = useMemo(() => {
    if (steps?.length) {
      return steps
        .map((s) => `[${KIND_TEXT[s.kind ?? 'reasoning']}] ${s.label}${s.detail ? `\n${s.detail}` : ''}`)
        .join('\n\n');
    }
    return text ?? '';
  }, [steps, text]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyPayload);
    } catch {
      // 降级：clipboard API 在非安全上下文/旧环境不可用
      const ta = document.createElement('textarea');
      ta.value = copyPayload;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  }, [copyPayload]);

  const hasContent = Boolean(steps?.length) || Boolean(text?.trim());
  if (!hasContent && !isStreaming) return null;

  const panelId = 'thinking-trace-body';

  return (
    <div className={cn('mb-2', className)}>
      {/* 头部：眉标风格按钮 —— 等宽小字 + 状态 + 计时 */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(
            'mc-press inline-flex items-center gap-1.5 rounded-control px-1.5 py-1',
            'text-[10.5px] text-tone-2 transition-colors duration-150 ease-out',
            'hover:bg-paper-hover hover:text-tone mc-focus',
          )}
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          {isStreaming ? (
            <LoadingPixels />
          ) : (
            <Sparkles size={12} className="text-tone-3" aria-hidden="true" />
          )}
          <span>{isStreaming ? '思考中' : '已深度思考'}</span>
          {seconds > 0 && <span className="mc-num text-tone-3">{seconds}s</span>}
        </button>

        {open && copyPayload && (
          <button
            type="button"
            onClick={handleCopy}
            title="复制思考内容"
            aria-label="复制思考内容"
            className={cn(
              'mc-press mc-focus rounded-control p-1 text-tone-3',
              'transition-colors duration-150 ease-out hover:bg-paper-hover hover:text-tone-2',
            )}
          >
            {copied ? (
              <Check size={12} className="text-sig-done" aria-hidden="true" />
            ) : (
              <Copy size={12} aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      <Collapse open={open} id={panelId} className="mt-1.5">
        {steps?.length ? (
          /* 结构化：一根 1px 墨线竖轨，每步一个节点 */
          <div className="mc-rail py-0.5">
            {steps.map((step) => {
              const kind = step.kind ?? 'reasoning';
              const Icon = KIND_ICON[kind];
              const tone = step.tone ?? (isStreaming ? 'run' : 'idle');
              return (
                <div key={step.id} className="relative py-1.5">
                  <span className="mc-rail-node" style={{ top: 8 }} aria-hidden="true" />
                  <div className="flex items-center gap-1.5">
                    <Icon size={12} className={cn(TONE_TEXT[tone], 'shrink-0')} aria-hidden="true" />
                    <span className="text-[11px] font-medium text-tone">{step.label}</span>
                    <span className="mc-eyebrow">{KIND_TEXT[kind]}</span>
                  </div>
                  {step.detail && (
                    <div className="mt-1 whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-tone-2">
                      {step.detail}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* 裸文本：整体内缩在一根竖轨右侧，读起来像"旁注" */
          <div className="mc-rail">
            <div
              className={cn(
                'whitespace-pre-wrap break-words rounded-card bg-paper-inset px-3 py-2.5',
                'text-[11px] leading-relaxed text-tone-2 select-text',
                isStreaming && 'mc-shimmer-text',
              )}
            >
              {text}
            </div>
          </div>
        )}
      </Collapse>
    </div>
  );
}

/** 供外部复用的状态胶囊组合，省得各处自己拼 tone 文案 */
export function ThinkingStateChip({ isStreaming }: { isStreaming: boolean }) {
  return (
    <SignalChip tone={isStreaming ? 'run' : 'idle'}>{isStreaming ? '推理中' : '已归档'}</SignalChip>
  );
}
