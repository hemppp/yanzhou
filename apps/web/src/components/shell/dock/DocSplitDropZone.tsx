// ============================================================
// dock/DocSplitDropZone.tsx —— 文档标签拖拽分屏（2026-10-25，★ pointer 事件驱动）
//
// 背景：单列布局把**所有** dockview 原生组头 `display:none` 了（DOM 仍在但不可见），
// 用户没有可拖拽的抓手。于是由自绘的顶部文档标签充当抓手。
//
// ## 为什么不用 HTML5 DnD（重要，勿改回）
//   标签内部是 `<button class="shell-doctab-main">`（点它 = 聚焦面板）。
//   Chrome 对 `<button>` 内的 mousedown **不发起祖先元素的 HTML5 拖拽** ——
//   标签 `draggable="true"` 只有左右各 5px 的 padding 区能拖到，中间 50px 的文字区
//   完全拖不动。模拟 `dispatchEvent(dragstart)` 的测试能过，真实鼠标必然失败。
//
//   故改用 **pointer 事件 + setPointerCapture** 自建拖拽：
//     · 标签上 `onPointerDown` 记录起点，移动超过阈值（4px）才算「开始拖」
//       （阈值保证「单击聚焦」的既有语义不被破坏）；
//     · 拖拽中用 `document.elementFromPoint` / 几何计算判定落区；
//     · 松手时回调 `onSplit(key, side)`。
//   不依赖任何原生 DnD，`<button>` 也拦不住。
//
// ## 落区口径（用户口径「标签页可以同时看两个页面」= 左右并排）
//   左 25% / 右 25% 为有效热区，中间 50% 不响应（避免误触）。
//   预览块用 `--vscode-panel-dropBackground` + `--vscode-focusBorder`，
//   与 dockview 原生 drag-over 主题（dock-theme.css `--dv-drag-over-*`）同源。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';

/** 有效落区（左右并排）。未来若要支持上下分屏，把 'top' | 'bottom' 加进来即可。 */
export type SplitSide = 'left' | 'right';

/** 热区宽度占容器宽度的比例（左右各 25%，中间 50% 不响应）。 */
const EDGE_RATIO = 0.25;

/** 移动超过这个距离才算「拖拽」，否则视为点击（保住「点标签 = 聚焦」）。 */
const DRAG_THRESHOLD_PX = 4;

export interface DocSplitDropZoneProps {
  /** 是否处于拖拽中（false 时本组件不渲染，避免吞事件）。 */
  active: boolean;
  /** 正在被拖拽的面板 key（预览文案用）。 */
  draggingKey?: string | null;
  /** 松手：把 `key` 代表的面板拆到 `side`。 */
  onSplit: (key: string, side: SplitSide) => void;
  /** 拖拽结束 / 取消（清掉外部的高亮态）。 */
  onDragEnd?: () => void;
}

/** 根据鼠标在容器内的相对 x 判定落区；中间区返回 null。 */
function hitTest(rect: DOMRect, clientX: number): SplitSide | null {
  const ratio = (clientX - rect.left) / Math.max(1, rect.width);
  if (ratio < EDGE_RATIO) return 'left';
  if (ratio > 1 - EDGE_RATIO) return 'right';
  return null;
}

/**
 * 拖拽会话的唯一入口 —— 由 `DocTabs` 在标签 `pointerdown` 时调用。
 *
 * 为什么做成模块级单例：拖拽是**跨组件**的（起点在标签条，落点在编辑区），
 * 且必须挂 window 级监听才能跟踪到标签条以外的移动。用 React 状态逐帧同步会
 * 引入大量无谓渲染，模块级最小状态 + 「订阅者集合」更直接。
 */
type SplitDragListener = (state: { key: string; x: number; y: number } | null) => void;

/**
 * 拖拽态的订阅者**集合**（多订阅者，语义与 DOM 事件一致）。
 *
 * ⚠️ 2026-10-26 修（**勿改回单槽位**）：原实现是 `let splitDragListener = fn`
 *   的**单一槽位**，后订阅者顶掉先订阅者。而这里天然有两个订阅者：
 *     · `DockShell` —— 持有「是否在拖」的视图态（决定落点层挂不挂载）；
 *     · `DocSplitDropZone` —— 由它算左/右落区（决定灰底预览画在哪一侧）。
 *   落点层是在拖拽**开始后**才挂载的（`active` 为真才渲染）⇒ 它的订阅会顶掉
 *   DockShell 的订阅 ⇒ 拖拽结束 `cleanup()` 只喊醒了落点层（`setSide(null)`），
 *   **DockShell 的 `dragState` 永远置不回 null** ⇒ 透明落点层
 *   （`inset:0` / `z-index:20`）**永久蒙在编辑区上**，编辑区里一切点击都被它吃掉
 *   —— 实测表现：AI 对话面板看着正常，但输入框点不进去、打不了字，只能整页刷新
 *   才恢复（「中间 50% 不响应」的兜底区松手必现，那是用户最自然的松手位置）。
 *   附带修掉一个次要缺陷：落点层卸载时会把槽位清空，导致**下一次拖拽再也不出现
 *   落点层、也再也分不了屏**（首次拖拽之后整条链路静默失效）。
 */
const splitDragListeners = new Set<SplitDragListener>();

/** 把拖拽态播给所有订阅者（`null` = 拖拽结束）。 */
function emitSplitDrag(state: { key: string; x: number; y: number } | null): void {
  for (const fn of [...splitDragListeners]) fn(state);
}

/**
 * 开始一次分屏拖拽（`DocTabs` 的标签 `pointerdown` 调用）。
 * 返回一个「取消」函数（组件卸载时调用）。
 */
export function beginSplitDrag(key: string, startX: number, startY: number): () => void {
  let started = false;
  let raf = 0;

  const cleanup = () => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    emitSplitDrag(null);
  };

  const onMove = (e: PointerEvent) => {
    if (!started) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      started = true;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    }
    // 逐帧合并，避免 pointermove 高频触发 React 渲染
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      emitSplitDrag({ key, x: e.clientX, y: e.clientY });
    });
  };

  const onUp = (e: PointerEvent) => {
    // ★ 松手一定要收尾（`finally`）：落点判定/派发里若抛错（dockview 建组失败等），
    //   异常会顺着 `dispatchEvent` 冒到这里 —— 少了 finally 就跳过 cleanup()，
    //   落点层与 `body.cursor=grabbing` / `user-select:none` 全部卡死，编辑区点不动。
    try {
      if (started) {
        // 松手位置交给落点层自行判定（它持有 .dock-main 的几何）
        const zone = document.querySelector<HTMLElement>('.dock-split-dropzone');
        const rect = zone?.getBoundingClientRect();
        const side = rect ? hitTest(rect, e.clientX) : null;
        if (side) window.dispatchEvent(new CustomEvent('novelmuse:split-drop', {
          detail: { key, side },
        }));
      }
    } finally {
      cleanup();
    }
  };

  const onCancel = () => cleanup();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cleanup();
  };
  /**
   * ★ 兜底收尾（2026-10-26）：`pointerup` 并非总能收到 —— 松手在浏览器窗口之外、
   *   系统弹窗抢走指针、切到别的应用……任何一种都会让拖拽会话**永远开着**，
   *   于是落点层留在编辑区上（同上面的卡死表现）。窗口失焦 / 页面转后台时一并收尾，
   *   让「拖拽态」不可能跨出一次真实交互而残留。
   */
  const onBlur = () => cleanup();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') cleanup();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  return cleanup;
}

/** 订阅分屏拖拽状态（`DockShell` / `DocSplitDropZone` 用）。返回注销函数。 */
export function subscribeSplitDrag(fn: SplitDragListener): () => void {
  splitDragListeners.add(fn);
  return () => {
    splitDragListeners.delete(fn);
  };
}

export function DocSplitDropZone({ active, draggingKey, onSplit, onDragEnd }: DocSplitDropZoneProps) {
  const [side, setSide] = useState<SplitSide | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 订阅拖拽位置 → 算落区
  useEffect(() => {
    if (!active) {
      setSide(null);
      return;
    }
    return subscribeSplitDrag((state) => {
      if (!state) {
        setSide(null);
        return;
      }
      const rect = rootRef.current?.getBoundingClientRect();
      setSide(rect ? hitTest(rect, state.x) : null);
    });
  }, [active]);

  // 松手：由 beginSplitDrag 派发的自定义事件驱动（落区已在那里算好）
  useEffect(() => {
    if (!active) return;
    const onDrop = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; side: SplitSide }>).detail;
      setSide(null);
      onDragEnd?.();
      if (detail?.key && detail?.side) onSplit(detail.key, detail.side);
    };
    window.addEventListener('novelmuse:split-drop', onDrop);
    return () => window.removeEventListener('novelmuse:split-drop', onDrop);
  }, [active, onSplit, onDragEnd]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 兜底：若浏览器仍发起原生 HTML5 拖拽（例如从 padding 区开始），也让它能落
    const rect = e.currentTarget.getBoundingClientRect();
    if (!hitTest(rect, e.clientX)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  if (!active) return null;

  return (
    <div
      ref={rootRef}
      className="dock-split-dropzone"
      data-side={side ?? 'none'}
      data-dragging-key={draggingKey ?? undefined}
      onDragOver={onDragOver}
      aria-hidden="true"
    >
      {side ? (
        <div
          className="dock-split-preview"
          style={
            side === 'left'
              ? { left: 0, top: 0, bottom: 0, width: '50%' }
              : { right: 0, top: 0, bottom: 0, width: '50%' }
          }
        />
      ) : null}
    </div>
  );
}
