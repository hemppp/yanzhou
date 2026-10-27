// ============================================================
// openChapter.test.ts —— 「打开某一章」必须做全三件事（回归）
//
// 背景（用户口径「点击章节没有进入章节详情界面」）：
//   单列停靠布局下，「章节」面板本身占着中心区。若只 `setCurrentChapter(id)`，
//   编辑区还在别的标签后面 ⇒ 用户点章节行"没反应"（实测：URL / 高亮 / 编辑区全不动）。
//   所以这三件事缺一不可：
//     ① 切当前章  ② 确保基础标签开着（baseOpen）  ③ 把中心组切回章节编辑器（focusDocBase）
//
// 本测试把「三件都做」钉死。它同时是那份"容易漏"的文档：漏掉 ②/③ 的表现都是
// 「点了没反应」，从现象极难反推，所以宁可让单测替我们记住。
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChapterStore } from '@novel-plugins/data-core/stores';
import { registerPanelViewBase, usePanelOpenStore } from '@/stores/panelOpenStore';
import { openChapterInEditor } from '../openChapter';

beforeEach(() => {
  useChapterStore.setState({ currentChapterId: null } as never);
  usePanelOpenStore.setState({ baseOpen: false } as never);
});

afterEach(() => {
  registerPanelViewBase(null);
  vi.restoreAllMocks();
});

describe('openChapterInEditor', () => {
  it('切当前章 + 打开基础标签 + 把中心组切回章节编辑器（三件都做）', () => {
    const focusBase = vi.fn();
    registerPanelViewBase(focusBase);

    openChapterInEditor('chapter-b');

    expect(useChapterStore.getState().currentChapterId).toBe('chapter-b');
    expect(usePanelOpenStore.getState().baseOpen).toBe(true);
    expect(focusBase).toHaveBeenCalledTimes(1);
  });

  it('视图层缺席（没有注册 focusDocBase 回调）时不抛错，前两件照做', () => {
    registerPanelViewBase(null);
    expect(() => openChapterInEditor('chapter-c')).not.toThrow();
    expect(useChapterStore.getState().currentChapterId).toBe('chapter-c');
    expect(usePanelOpenStore.getState().baseOpen).toBe(true);
  });
});
