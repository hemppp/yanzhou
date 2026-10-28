// ============================================================
// DocTabs.overflow.test.tsx —— 标签「多页同时打开」的溢出交互（2026-10-28）
//
// 背景（作者口径：「标签需要改成 vs code 那种多个同时打开」）：
//   面板上限从 3 提到 **5 个功能面板**（正文不占名额），屏幕上一共最多 6 个标签。
//   一多就必然溢出 —— 而标签条横向滚动条是**隐藏**的（`scrollbar-width:none`），
//   用户既看不到"还有几个"，也没法跳到被挤出视野的那个。
//
//   VS Code 的解法是右上角「▾ N」：列出**全部**已打开标签、当前激活的打勾。
//   本测试锁的就是这条：
//     · 不溢出 ⇒ 不渲染「▾」（不占位置）
//     · 溢出   ⇒ 渲染「▾」且数字 = 标签总数
//     · 点开   ⇒ 列出全部标签（含正文），激活项有 aria-checked
//
// ⚠️ jsdom 没有布局引擎：`scrollWidth`/`clientWidth` 恒为 0 ⇒ 天然"不溢出"。
//   故测试里显式覆写这两个只读属性来模拟溢出状态。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { DocTabsHeader, DOC_BASE_TAB } from '@/components/shell/DocTabs';
import { usePanelOpenStore } from '@/stores/panelOpenStore';
import { usePluginRegistry } from '@/plugin/registry';

function registerPanels(list: Array<[key: string, label: string]>) {
  act(() => {
    usePluginRegistry.setState({
      projectPanels: list.map(([key, label]) => ({ key, label }) as never),
    } as never);
  });
}

function openPanels(keys: string[], active?: string) {
  act(() => {
    usePanelOpenStore.setState({
      keys,
      baseOpen: true,
      activeKey: active ?? keys[keys.length - 1] ?? null,
    } as never);
  });
}

/** 模拟「标签条溢出」：把容器的 scrollWidth 撑得比 clientWidth 大 */
function mockOverflow(container: HTMLElement, overflow: boolean) {
  const list = container.querySelector('.shell-doctabs-list') as HTMLElement;
  expect(list).toBeTruthy();
  Object.defineProperty(list, 'scrollWidth', { configurable: true, value: overflow ? 900 : 400 });
  Object.defineProperty(list, 'clientWidth', { configurable: true, value: 400 });
}

beforeEach(() => {
  act(() => {
    usePanelOpenStore.setState({ keys: [], baseOpen: true, activeKey: null } as never);
  });
});

describe('DocTabsHeader · 标签溢出（VS Code 多页手感）', () => {
  it('不溢出时**不渲染**「▾」按钮（标签少时不占位置）', () => {
    registerPanels([['notes', '笔记']]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes'], 'notes');
    mockOverflow(container, false);
    act(() => {
      fireEvent(window, new Event('resize'));
    });
    expect(container.querySelector('.shell-doctab-overflow')).toBeNull();
  });

  it('溢出时渲染「▾ N」，N = 标签总数（含「章节正文」）', () => {
    registerPanels([
      ['notes', '笔记'],
      ['outline', '大纲'],
      ['stats', '统计'],
    ]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes', 'outline', 'stats'], 'stats');
    mockOverflow(container, true);
    act(() => {
      fireEvent(window, new Event('resize'));
    });
    const btn = container.querySelector('.shell-doctab-overflow');
    expect(btn).toBeTruthy();
    // 3 个面板 + 1 个基础标签 = 4
    expect(btn?.textContent).toContain('4');
  });

  it('点开「▾」列出**全部**标签，当前激活项有 aria-checked（VS Code 的 open editors 口径）', () => {
    registerPanels([
      ['notes', '笔记'],
      ['outline', '大纲'],
    ]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes', 'outline'], 'outline');
    mockOverflow(container, true);
    act(() => {
      fireEvent(window, new Event('resize'));
    });

    const btn = container.querySelector('.shell-doctab-overflow') as HTMLElement;
    act(() => {
      fireEvent.click(btn);
    });

    // 菜单是 portal 到 body 的，故从 document 查
    const menu = document.querySelector('.shell-doctab-overflow-menu');
    expect(menu).toBeTruthy();
    const items = Array.from(menu!.querySelectorAll('[role="menuitemradio"]'));
    // 正文 + 笔记 + 大纲 = 3 项
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining(DOC_BASE_TAB.title === '章节正文' ? '章节正文' : ''),
      expect.stringContaining('笔记'),
      expect.stringContaining('大纲'),
    ]);
    // 只有「大纲」是激活项
    const checked = items.filter((i) => i.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toContain('大纲');

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(document.querySelector('.shell-doctab-overflow-menu')).toBeNull();
  });
});
