import { useState, useCallback, useEffect, useRef } from 'react';
import { PenTool, X, Sparkles } from 'lucide-react';

interface ContinueWriteModalProps {
  visible: boolean;
  chapterTitle: string;
  onConfirm: (prompt: string) => void;
  onClose: () => void;
}

const DEFAULT_PROMPT = '请根据前文风格和故事走向，为当前章节提供自然的续写内容。';

export function ContinueWriteModal({ visible, chapterTitle, onConfirm, onClose }: ContinueWriteModalProps) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (visible) {
      setPrompt(DEFAULT_PROMPT);
      // 弹窗打开后自动聚焦输入框
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [visible]);

  const handleConfirm = useCallback(() => {
    const text = prompt.trim() || DEFAULT_PROMPT;
    onConfirm(text);
    setPrompt(DEFAULT_PROMPT);
  }, [prompt, onConfirm]);

  const handleClose = useCallback(() => {
    onClose();
    setPrompt(DEFAULT_PROMPT);
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleConfirm();
    }
    if (e.key === 'Escape') {
      handleClose();
    }
  }, [handleConfirm, handleClose]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgb(0 0 0 / 0.5)' }}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="智能续写"
    >
      <div
        className="relative w-full max-w-lg mx-4 rounded-3xl overflow-hidden"
        style={{
          background: 'rgb(var(--glass-tint) / 0.85)',
          backdropFilter: 'blur(32px) saturate(180%)',
          WebkitBackdropFilter: 'blur(32px) saturate(180%)',
          border: '1px solid hsl(var(--border) / 0.5)',
          boxShadow:
            '0 24px 80px hsl(var(--ink-deep) / 0.2), 0 8px 32px hsl(var(--ink-deep) / 0.1), inset 0 1px 0 hsl(var(--glass-highlight) / 0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 关闭按钮 */}
        <button
          onClick={handleClose}
          className="absolute top-3 right-3 p-1.5 rounded-xl hover:bg-muted/50 transition-colors"
          aria-label="关闭"
        >
          <X size={16} className="text-muted-foreground" />
        </button>

        {/* 头部 */}
        <div className="px-6 pt-6 pb-3">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, hsl(var(--primary) / 0.15), hsl(var(--primary) / 0.05))',
                border: '1px solid hsl(var(--primary) / 0.2)',
              }}
            >
              <PenTool size={18} className="text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold" style={{ fontFamily: "'Noto Serif SC', serif" }}>
                智能续写
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                当前章节：{chapterTitle}
              </p>
            </div>
          </div>
        </div>

        {/* 提示文本 */}
        <div className="px-6 pb-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            请描述你希望 AI 如何续写当前章节，或使用默认提示直接生成。
          </p>
        </div>

        {/* 输入区 */}
        <div className="px-6 pb-4">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full resize-none rounded-2xl p-4 text-sm leading-relaxed outline-none transition-all"
            rows={4}
            style={{
              background: 'rgb(var(--glass-tint) / 0.4)',
              border: '1px solid hsl(var(--border) / 0.4)',
              color: 'hsl(var(--foreground))',
            }}
            placeholder="输入续写方向或要求..."
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px] text-muted-foreground">
              <kbd className="px-1.5 py-0.5 rounded-md text-[11px]" style={{ background: 'rgb(var(--glass-tint) / 0.3)', border: '1px solid hsl(var(--border) / 0.3)' }}>⌘Enter</kbd> 发送
            </span>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="px-6 pb-6 flex gap-3">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02] active:scale-95"
            style={{
              background: 'rgb(var(--glass-tint) / 0.5)',
              // ★ 必须拆长写：`border` 简写会把 border-image 重置为 none，
              // 而 shuimo 主题的毛笔笔触边框正是用 border-image 画的 —— 一简写就被静默吃掉。
              // 别改回 `border: '1px solid ...'`，那会让这个按钮在 shuimo 主题下丢笔触。
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'hsl(var(--border) / 0.4)',
              boxShadow: 'inset 0 1px 0 hsl(var(--glass-highlight) / 0.5)',
            }}
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-center gap-1.5"
            style={{
              background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary) / 0.85))',
              color: 'hsl(var(--primary-foreground))',
              boxShadow: '0 4px 16px hsl(var(--primary) / 0.3)',
            }}
          >
            <Sparkles size={14} />
            <span>开始续写</span>
          </button>
        </div>
      </div>
    </div>
  );
}