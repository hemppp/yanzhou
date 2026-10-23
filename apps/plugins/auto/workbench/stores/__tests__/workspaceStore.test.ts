/**
 * @fileoverview workspaceStore —— 分页工作区的状态机
 *
 * 这是整套标签语义的地基，四条最容易写歪的规则在这里钉死：
 *   1. **正文不在 tabs 里** —— 它没有 key，任何操作都碰不到它（"永不被替换"从数据层就成立）
 *   2. **气泡二次点击只收起分页区**，标签与面板状态保留（不销毁）
 *   3. **关掉当前标签 → 激活右邻，其次左邻**；全关光 → 分页区收起（正文占满）
 *   4. **不设打开数量上限**：开 30 个也不许静默挤掉最早的
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore, clampPaneWidth, PANE_MIN, PANE_MAX, PANE_DEFAULT } from '../workspaceStore';

const s = () => useWorkspaceStore.getState();

beforeEach(() => {
  s().reset();
  s().setWidth(PANE_DEFAULT);
});

describe('workspaceStore · 打开与激活', () => {
  it('openPanel：追加到末尾并激活、展开分页区', () => {
    s().openPanel('a');
    s().openPanel('b');
    expect(s().tabs).toEqual(['a', 'b']);
    expect(s().active).toBe('b');
    expect(s().paneOpen).toBe(true);
  });

  it('openPanel 幂等：同一面板不会出现第二个标签', () => {
    s().openPanel('a');
    s().openPanel('b');
    s().openPanel('a');
    expect(s().tabs).toEqual(['a', 'b']);
    expect(s().active).toBe('a');
  });

  it('activate(null)：回到正文 —— 收起分页区，但标签全部保留', () => {
    s().openPanel('a');
    s().openPanel('b');
    s().activate(null);
    expect(s().active).toBeNull();
    expect(s().paneOpen).toBe(false);
    expect(s().tabs).toEqual(['a', 'b']);
  });

  it('activate 一个没打开的 key：忽略（不偷偷新建）', () => {
    s().openPanel('a');
    s().activate('zzz');
    expect(s().tabs).toEqual(['a']);
    expect(s().active).toBe('a');
  });

  it('不设打开数量上限：开 30 个也不许挤掉最早的', () => {
    for (let i = 0; i < 30; i++) s().openPanel(`p${i}`);
    expect(s().tabs).toHaveLength(30);
    expect(s().tabs[0]).toBe('p0');
  });

  it('MRU 记录最近使用顺序（Ctrl+Tab 用）', () => {
    s().openPanel('a');
    s().openPanel('b');
    s().openPanel('a');
    expect(s().mru[0]).toBe('a');
    expect(s().mru[1]).toBe('b');
  });
});

describe('workspaceStore · 气泡三态点击', () => {
  it('状态 1：没有标签 → 新建 + 激活 + 展开', () => {
    s().toggleBubble('characters');
    expect(s().tabs).toEqual(['characters']);
    expect(s().active).toBe('characters');
    expect(s().paneOpen).toBe(true);
  });

  it('状态 2：有标签但不是当前 → 切过去（不新建）', () => {
    s().openPanel('a');
    s().openPanel('b');
    s().toggleBubble('a');
    expect(s().active).toBe('a');
    expect(s().tabs).toEqual(['a', 'b']);
    expect(s().paneOpen).toBe(true);
  });

  it('状态 3：就是当前标签 → 只收起分页区，**标签与面板都不销毁**', () => {
    s().openPanel('a');
    expect(s().paneOpen).toBe(true);
    s().toggleBubble('a');
    expect(s().paneOpen).toBe(false);
    expect(s().tabs).toEqual(['a']);   // ★ 标签还在
    expect(s().active).toBe('a');      // ★ 激活态也还在 —— 再点一次能原地恢复
  });

  it('状态 3\'：收起后再点一次 → 恢复展开', () => {
    s().openPanel('a');
    s().toggleBubble('a');
    s().toggleBubble('a');
    expect(s().paneOpen).toBe(true);
    expect(s().active).toBe('a');
  });
});

describe('workspaceStore · 关闭语义', () => {
  it('关掉当前标签 → 激活右邻', () => {
    s().openPanel('a'); s().openPanel('b'); s().openPanel('c');
    s().activate('b');
    s().closePanel('b');
    expect(s().tabs).toEqual(['a', 'c']);
    expect(s().active).toBe('c');
  });

  it('关掉最后一个位置的当前标签 → 没有右邻，取左邻', () => {
    s().openPanel('a'); s().openPanel('b');
    s().activate('b');
    s().closePanel('b');
    expect(s().active).toBe('a');
  });

  it('关掉非当前标签：当前激活不变', () => {
    s().openPanel('a'); s().openPanel('b'); s().openPanel('c');
    s().activate('c');
    s().closePanel('a');
    expect(s().active).toBe('c');
    expect(s().tabs).toEqual(['b', 'c']);
  });

  it('★ 全关光 → 分页区收起（正文占满），不是把工作区关掉', () => {
    s().openPanel('a');
    s().closePanel('a');
    expect(s().tabs).toEqual([]);
    expect(s().active).toBeNull();
    expect(s().paneOpen).toBe(false);
  });

  it('closeOthers：只留一个', () => {
    s().openPanel('a'); s().openPanel('b'); s().openPanel('c');
    s().closeOthers('b');
    expect(s().tabs).toEqual(['b']);
    expect(s().active).toBe('b');
  });

  it('moveTab：重排顺序', () => {
    s().openPanel('a'); s().openPanel('b'); s().openPanel('c');
    s().moveTab(0, 2);
    expect(s().tabs).toEqual(['b', 'c', 'a']);
    s().moveTab(2, 0);
    expect(s().tabs).toEqual(['a', 'b', 'c']);
  });

  it('moveTab：越界不炸、不改动', () => {
    s().openPanel('a');
    s().moveTab(0, 5);
    s().moveTab(-1, 0);
    expect(s().tabs).toEqual(['a']);
  });
});

describe('workspaceStore · IDE 语义：预览标签', () => {
  it('预览标签只有一个槽位：新的预览**顶掉**旧的，且沿用原位置', () => {
    s().openPanel('a', { preview: false });
    s().openPanel('b', { preview: true });
    expect(s().tabs).toEqual(['a', 'b']);
    expect(s().previewKey).toBe('b');
    // 再预览第三个：b 被顶掉，位置不跳（还是第 2 个）
    s().openPanel('c', { preview: true });
    expect(s().tabs).toEqual(['a', 'c']);
    expect(s().previewKey).toBe('c');
  });

  it('双击（固定打开）会把预览晋级：previewKey 清空、标签留下', () => {
    s().openPanel('a', { preview: true });
    expect(s().previewKey).toBe('a');
    s().promote('a');
    expect(s().previewKey).toBeNull();
    expect(s().tabs).toEqual(['a']);
  });

  it('固定打开不占用预览槽（预览标签继续存在）', () => {
    s().openPanel('a', { preview: true });
    s().openPanel('b', { preview: false });
    expect(s().previewKey).toBe('a');
    expect(s().tabs).toEqual(['a', 'b']);
  });

  it('对同一个 key 再次固定打开 = 把它从预览晋级', () => {
    s().openPanel('a', { preview: true });
    s().openPanel('a', { preview: false });
    expect(s().previewKey).toBeNull();
    expect(s().tabs).toEqual(['a']);
  });

  it('关掉预览标签会释放槽位', () => {
    s().openPanel('a', { preview: true });
    s().closePanel('a');
    expect(s().previewKey).toBeNull();
  });

  // ★ 2026-09-15 行为变更：气泡单击由「预览打开」改为「**直接固定打开**」——
  //   看板改成全屏页面切换后，预览态（斜体 + 会被下一个预览顶掉）与「正文」标签的
  //   常驻感不一致，作者明确要求「像正文一样打开」。断言随之更新。
  it('气泡单击 = 直接固定打开（不再是预览态）', () => {
    s().toggleBubble('entities');
    expect(s().previewKey).toBeNull();
    expect(s().tabs).toEqual(['entities']);
  });
});

describe('workspaceStore · IDE 语义：关闭右侧 / 重置', () => {
  it('closeToRight：只留它和它左边的', () => {
    s().openPanel('a'); s().openPanel('b'); s().openPanel('c'); s().openPanel('d');
    s().closeToRight('b');
    expect(s().tabs).toEqual(['a', 'b']);
    // 当前标签被关掉时，回落到 key 自己
    expect(s().active).toBe('b');
  });

  it('reset 连预览槽一起清空', () => {
    s().openPanel('a', { preview: true });
    s().reset();
    expect(s().tabs).toEqual([]);
    expect(s().previewKey).toBeNull();
    expect(s().paneOpen).toBe(false);
  });
});

describe('workspaceStore · 分页区尺寸与展开', () => {
  it('宽度钳制在 320–720', () => {
    s().setWidth(100);
    expect(s().paneWidth).toBe(PANE_MIN);
    s().setWidth(9999);
    expect(s().paneWidth).toBe(PANE_MAX);
    expect(clampPaneWidth(500)).toBe(500);
  });

  it('展开时若没有激活项，回到第一个标签（避免"展开了却没有内容"）', () => {
    s().openPanel('a');
    s().activate(null);
    s().setPaneOpen(true);
    expect(s().active).toBe('a');
    expect(s().paneOpen).toBe(true);
  });

  it('没有标签时展开：paneOpen=true 但 active 仍为 null（界面显示空态）', () => {
    s().setPaneOpen(true);
    expect(s().paneOpen).toBe(true);
    expect(s().active).toBeNull();
  });
});
