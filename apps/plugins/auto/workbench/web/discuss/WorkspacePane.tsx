// ============================================================
// WorkspacePane —— 辅助分页区外壳（AI 写作模式）
//
// 承载：标签栏 + 活动面板内容 + 拖宽分隔条。
// 两种档位（由宿主按可用宽度决定，**都不覆盖正文**）：
//   · 'right'  右侧竖栏（默认，宽 320–720）
//   · 'bottom' 正文下方横栏（宽度不够时退到这里：正文保持完整宽度，只是变矮）
//
// ★ 绝对不允许的第三种档位是"浮在正文上的覆盖层/抽屉" —— 2026-09-13 明确否掉了
//   （作者要求正文不能被挡住）。要加新档位请先问一句：它会不会盖住正文。
//
// 面板崩溃由 ErrorBoundary 兜住：只把**这个面板**换成占位，绝不牵连正文与其它标签。
// ============================================================

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { ErrorBoundary } from '@novel-plugins/ui-kit';
import { TabBar } from '../shell/TabBar';
import { EDITOR_BG, PANE_H_DEFAULT, PANE_H_MAX, PANE_H_MIN, PANE_W_DEFAULT, type WorkbenchPanel } from '../pipeline/workspaceDefs';

export type PaneMode = 'right' | 'bottom';

interface WorkspacePaneProps {
  panels: WorkbenchPanel[];
  tabs: string[];
  active: string | null;
  /** 预览标签 key（斜体） */
  previewKey?: string | null;
  open: boolean;
  mode: PaneMode;
  /** 右栏模式：宽度（下方模式可省） */
  width?: number;
  onWidthChange?: (w: number) => void;
  /** 下方模式：高度（右栏模式可省） */
  height?: number;
  onHeightChange?: (h: number) => void;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onCloseOthers?: (key: string) => void;
  onCloseRight?: (key: string) => void;
  onPromote?: (key: string) => void;
  /** 溢出下拉里的「显示全部看板」（接 Ctrl+P） */
  onOpenQuick?: () => void;
  /** 标签拖动重排（注意别和分隔条拖拽的 onMove 重名 —— 那个是 pointer 事件 */
  onMoveTab?: (from: number, to: number) => void;
  /** 给活动面板传的实时 props（宿主绑定的） */
  panelProps?: Record<string, unknown>;
}

export function WorkspacePane({
  panels, tabs, active, previewKey, open, mode, width, height,
  onWidthChange, onHeightChange, onActivate, onClose, onCloseOthers, onCloseRight, onPromote, onOpenQuick, onMoveTab,
  panelProps,
}: WorkspacePaneProps) {
  const horizontal = mode === 'right';
  /** 当前档位的尺寸（右栏看宽、下方看高） */
  const size = horizontal ? (width ?? PANE_W_DEFAULT) : (height ?? PANE_H_DEFAULT);

  const dragRef = useRef<null | { start: number; origin: number }>(null);

  const onDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { start: horizontal ? e.clientX : e.clientY, origin: size };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.classList.add('nm-dragging-active');
  }, [horizontal, size]);

  const onMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (horizontal) {
      // 往左拖 = 分页区变宽（它与正文之间的分隔条）
      onWidthChange?.(d.origin - (e.clientX - d.start));
    } else {
      // 往上拖 = 分页区变高
      onHeightChange?.(d.origin - (e.clientY - d.start));
    }
  }, [horizontal, onWidthChange, onHeightChange]);

  const onUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove('nm-dragging-active');
  }, []);

  if (!open) return null;

  const activePanel = active ? panels.find((p) => p.key === active) : undefined;
  const PanelComponent = activePanel?.Component;

  return (
    <section
      aria-label="辅助分页区"
      data-pane-mode={mode}
      /* 勾线从内联 style 提到工具类：原来写 `0.5px solid hsl(var(--border)/0.6)`，
         0.5px 在非 retina 屏上要么被舍成 1px、要么整条消失，本就不稳。
         改用 1px 墨线，与全站 --shadow-hairline 的勾线粗细一致。 */
      className={`flex shrink-0 flex-col overflow-hidden ${horizontal ? 'border-l' : 'border-t'} border-paper-line`}
      style={horizontal
        ? { position: 'relative', width: size, background: EDITOR_BG }
        : { position: 'relative', height: size, background: EDITOR_BG }}
    >
      {/* 分隔条：横向档在上缘、竖向档在左缘。
          ★ 2026-09-15 改为**绝对定位**（原来是 flex 流里的实体 5px 条）。
          原实现把本区标签栏整体推低 5px —— 实测组 1 标签栏 top=48、组 2 top=53，
          作者反馈「打开看板后标签跟正文对不齐」。浮起来后两条标签栏同高，
          拖拽热区依然有 5px 宽，不损失可用性。 */}
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={horizontal ? '调整分页区宽度' : '调整分页区高度'}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className={`absolute z-[5] bg-transparent ${horizontal ? 'border-l' : 'border-t'} border-paper-line`}
        style={{
          cursor: horizontal ? 'col-resize' : 'row-resize',
          touchAction: 'none',
          ...(horizontal ? { top: 0, bottom: 0, left: -3, width: 5 } : { left: 0, right: 0, top: -3, height: 5 }),
        }}
      />

      <TabBar
        panels={panels}
        tabs={tabs}
        active={active}
        previewKey={previewKey}
        variant="side"
        onActivate={onActivate}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseRight={onCloseRight}
        onPromote={onPromote}
        onOpenQuick={onOpenQuick}
        onMove={onMoveTab}
      />

      <div className="flex-1 min-h-0 overflow-y-auto" role="tabpanel" data-pane-content={active ?? ''}>
        {PanelComponent ? (
          <ErrorBoundary
            fallback={(
              /* 错误文案用 sig-stop —— 这是本体系里"失败"的指定色。
                 原来用 --destructive，而按水墨迁移的注释，--destructive 在亮色下
                 就是 16% 明度的深墨，跟正文几乎同色，读不出"这是错误"。 */
              <div className="p-4 text-[11px] text-sig-stop">
                「{activePanel?.label}」面板出错了 —— 正文与其它标签不受影响，可关闭此标签后重开。
              </div>
            )}
          >
            <PanelComponent {...(panelProps ?? {})} />
          </ErrorBoundary>
        ) : (
          <div className="p-6 text-center text-[11px] text-tone-2">
            没有打开的看板 —— 点左侧气泡即可打开。
          </div>
        )}
      </div>
    </section>
  );
}

/** 下方档位的高度钳制（导出给宿主用，避免两处各写一遍范围） */
export const clampPaneHeight = (h: number): number =>
  Math.max(PANE_H_MIN, Math.min(PANE_H_MAX, Math.round(h)));
