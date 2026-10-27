// ============================================================
// DocSplitDropZone.test.ts —— 标签拖拽分屏的**收尾契约**（2026-10-26 补）
//
// 为什么要专门锁这份契约（真实缺陷，勿删）：
//   拖拽态原先走**单一槽位**（`let splitDragListener = fn`），而后订阅者会顶掉先订阅者。
//   落点层是在拖拽**开始后**才挂载的，它一订阅就把 DockShell 的订阅顶掉 ⇒ 拖拽结束
//   `cleanup()` 只喊醒落点层，DockShell 的 `dragState` **永远置不回 null** ⇒
//   透明落点层（inset:0 / z-index:20）永久蒙在编辑区上，编辑区里一切点击都被它吃掉：
//   实测「手写台 AI 对话面板看着正常，但输入框点不进去、打不了字」，只能整页刷新。
//   松手落在**中间 50%**（设计上的「不响应区」，也是用户最自然的松手位置）必现。
//
//   故这里断言：**所有订阅者**都收到 `null`（拖拽结束），且失焦这类「收不到的 pointerup」
//   也要收尾 —— 这两条一旦破，编辑区就可能被落点层永久锁死。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { beginSplitDrag, subscribeSplitDrag } from './DocSplitDropZone';

type DragState = { key: string; x: number; y: number } | null;

/** 等一帧：`beginSplitDrag` 的 pointermove 是 rAF 合并的 */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** 一次可断言的指针位移 */
function moveTo(x: number, y: number) {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
}

beforeEach(() => {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('分屏拖拽 · 收尾契约', () => {
  it('★ 两个订阅者（DockShell + 落点层）都要收到「拖拽开始」与「拖拽结束」', async () => {
    const dockShell = vi.fn<(s: DragState) => void>();
    const dropZone = vi.fn<(s: DragState) => void>();
    const un1 = subscribeSplitDrag(dockShell);
    const un2 = subscribeSplitDrag(dropZone);

    const cancel = beginSplitDrag('skills', 0, 0);
    moveTo(60, 60); // 超过 4px 阈值 ⇒ 真的开始拖
    await nextFrame();
    await nextFrame();

    expect(dockShell).toHaveBeenCalledWith({ key: 'skills', x: 60, y: 60 });
    expect(dropZone).toHaveBeenCalledWith({ key: 'skills', x: 60, y: 60 });

    dockShell.mockClear();
    dropZone.mockClear();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 60, clientY: 60 }));

    // ★ 修前：只有后订阅的落点层收到 null，DockShell 收不到 ⇒ 落点层永久留在编辑区上
    expect(dockShell).toHaveBeenCalledWith(null);
    expect(dropZone).toHaveBeenCalledWith(null);

    cancel();
    un1();
    un2();
  });

  it('拖动阈值内的点击不发拖拽态（「单击标签 = 聚焦」语义不许被破坏）', async () => {
    const fn = vi.fn<(s: DragState) => void>();
    const un = subscribeSplitDrag(fn);
    const cancel = beginSplitDrag('memory', 0, 0);

    moveTo(3, 2); // 位移 < 4px ⇒ 只当点击
    await nextFrame();
    await nextFrame();
    expect(fn).not.toHaveBeenCalled();

    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 3, clientY: 2 }));
    cancel();
    un();
  });

  it('松手在中间 50%（不响应区）：不发分屏请求，但拖拽态必须收干净', async () => {
    // jsdom 里所有 rect 都是 0 尺寸，落区判定需要真实几何 —— 这里给落点层量一个 1000×800
    const zone = document.createElement('div');
    zone.className = 'dock-split-dropzone';
    zone.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(zone);
    const onDrop = vi.fn();
    window.addEventListener('novelmuse:split-drop', onDrop);

    const states: DragState[] = [];
    const un = subscribeSplitDrag((s) => states.push(s));
    const cancel = beginSplitDrag('ai-chat', 0, 0);
    moveTo(500, 400); // 正中：ratio = 0.5 ⇒ 不属于左/右 25%
    await nextFrame();
    await nextFrame();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 500, clientY: 400 }));

    expect(onDrop).not.toHaveBeenCalled();
    expect(states[states.length - 1]).toBeNull();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    window.removeEventListener('novelmuse:split-drop', onDrop);
    zone.remove();
    cancel();
    un();
  });

  it('松手在边缘热区：派发分屏请求，且拖拽态同样收干净', async () => {
    const zone = document.createElement('div');
    zone.className = 'dock-split-dropzone';
    zone.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(zone);
    const onDrop = vi.fn();
    window.addEventListener('novelmuse:split-drop', onDrop);

    const states: DragState[] = [];
    const un = subscribeSplitDrag((s) => states.push(s));
    const cancel = beginSplitDrag('ai-chat', 0, 0);
    moveTo(100, 400); // ratio = 0.1 < 0.25 ⇒ 左热区
    await nextFrame();
    await nextFrame();
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 400 }));

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual({ key: 'ai-chat', side: 'left' });
    expect(states[states.length - 1]).toBeNull();

    window.removeEventListener('novelmuse:split-drop', onDrop);
    zone.remove();
    cancel();
    un();
  });

  it('窗口失焦（收不到 pointerup 的情形）也必须收尾，不留拖拽态', async () => {
    const fn = vi.fn<(s: DragState) => void>();
    const un = subscribeSplitDrag(fn);
    const cancel = beginSplitDrag('pipeline', 0, 0);

    moveTo(80, 80);
    await nextFrame();
    await nextFrame();
    expect(fn).toHaveBeenCalledWith({ key: 'pipeline', x: 80, y: 80 });

    fn.mockClear();
    window.dispatchEvent(new Event('blur'));
    expect(fn).toHaveBeenCalledWith(null);
    expect(document.body.style.cursor).toBe('');

    cancel();
    un();
  });
});
