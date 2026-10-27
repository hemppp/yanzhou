// ============================================================
// utils/openChapter.ts —— 「打开某一章」的唯一入口（2026-10-26）
//
// 为什么需要它（用户口径「点击章节没有进入章节详情界面」）：
//   停靠布局是**单列**的 —— 左栏那些面板（章节 / 时间线 / 大纲 …）本质上是
//   **中心区的标签页**。当「章节」面板正占着中心区时，只 `setCurrentChapter(id)`
//   不会有任何可见变化：编辑区在别的标签后面，用户点一下"没反应"。
//   实测：点章节行后 URL、高亮、编辑区三者全不动（编辑器压根没渲染）。
//
//   所以「切当前章」这件事必须**同时**把中心区切回「章节正文」：
//     · `openBase()`   —— 确保基础标签是开着的（它可被关掉）
//     · `focusDocBase()` —— 由 DockShell 注册的回调，把中心组切到章节编辑器出口
//
//   收口成一个函数而不是各面板各写一遍：漏掉那两句的表现是「点了没反应」，
//   极难从现象定位（当初就是三处各写一遍才漏掉的）。
//
// 注：URL 不跟着变 —— 本仓设计是「URL 只定初始章，之后切章走 store」
//     （见 ChapterEditor 的 `syncedRouteIdRef` 单向同步）。
// ============================================================

import { useChapterStore } from '@novel-plugins/data-core/stores';
import { focusDocBase, usePanelOpenStore } from '@/stores/panelOpenStore';

/** 打开（切到）某一章，并保证中心区显示的是章节正文编辑器。 */
export function openChapterInEditor(chapterId: string): void {
  useChapterStore.getState().setCurrentChapter(chapterId);
  usePanelOpenStore.getState().openBase();
  focusDocBase();
}
