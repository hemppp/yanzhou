import { useCallback } from 'react';
import { FileText, ListChecks, ArrowRight, X } from 'lucide-react';

interface OutlineCheckModalProps {
  visible: boolean;
  onClose: () => void;
  /** 当前正在执行的操作名称（如"智能续写"、"章节分析"） */
  actionName: string;
}

/**
 * 大纲校验弹窗 — 当用户触发智能续写/章节分析等需要大纲的功能时，
 * 若大纲为空则弹出此窗，引导用户填写大纲事件。
 */
export function OutlineCheckModal({ visible, onClose, actionName }: OutlineCheckModalProps) {
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgb(0 0 0 / 0.5)' }}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="大纲为空"
    >
      <div
        className="relative w-full max-w-md mx-4 rounded-3xl overflow-hidden"
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
        <div className="px-6 pt-6 pb-3 text-center">
          <div className="mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-3"
            style={{
              background: 'linear-gradient(135deg, hsl(var(--primary) / 0.15), hsl(var(--primary) / 0.05))',
              border: '1px solid hsl(var(--primary) / 0.2)',
            }}
          >
            <ListChecks size={22} className="text-primary" />
          </div>
          <h2 className="text-base font-semibold mb-1" style={{ fontFamily: "'Noto Serif SC', serif" }}>
            尚未填写大纲
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            「{actionName}」功能需要先完成大纲规划才能提供精准建议。
          </p>
        </div>

        {/* 步骤说明 */}
        <div className="px-6 py-2 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
              style={{
                background: 'linear-gradient(135deg, hsl(var(--primary) / 0.2), hsl(var(--primary) / 0.05))',
                border: '1px solid hsl(var(--primary) / 0.25)',
                color: 'hsl(var(--primary))',
              }}
            >
              1
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">打开大纲模块</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                在左侧面板中找到「大纲」模块，点击进入
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
              style={{
                background: 'linear-gradient(135deg, hsl(var(--primary) / 0.2), hsl(var(--primary) / 0.05))',
                border: '1px solid hsl(var(--primary) / 0.25)',
                color: 'hsl(var(--primary))',
              }}
            >
              2
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">添加大纲事件</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                为你的故事添加核心事件节点，如开场、冲突、转折、高潮、结局等
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
              style={{
                background: 'linear-gradient(135deg, hsl(var(--primary) / 0.2), hsl(var(--primary) / 0.05))',
                border: '1px solid hsl(var(--primary) / 0.25)',
                color: 'hsl(var(--primary))',
              }}
            >
              3
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">关联章节</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                将每个事件关联到对应章节，AI 就能根据大纲规划给出更精准的续写建议
              </div>
            </div>
          </div>
        </div>

        {/* 提示 */}
        <div className="px-6 py-3">
          <div className="rounded-2xl p-3 text-xs"
            style={{
              background: 'hsl(var(--primary) / 0.06)',
              border: '1px solid hsl(var(--primary) / 0.12)',
            }}
          >
            <div className="flex items-start gap-2">
              <FileText size={14} className="shrink-0 mt-0.5 text-primary/70" />
              <span className="text-muted-foreground leading-relaxed">
                填写大纲后，AI 能理解你的故事走向，在续写和分析时给出更贴合你意图的建议。
              </span>
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="px-6 pb-6 pt-2 flex gap-3">
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
            知道了
          </button>
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-center gap-1.5"
            style={{
              background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary) / 0.85))',
              color: 'hsl(var(--primary-foreground))',
              boxShadow: '0 4px 16px hsl(var(--primary) / 0.3)',
            }}
          >
            <span>先去填写</span>
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}