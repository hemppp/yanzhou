// ============================================================
// DocTabs.shortcuts.test.tsx —— 标签键盘快捷键（VS Code 对齐 · P4）
//
// | 键 | 行为 |
// |---|---|
// | Ctrl/Cmd + 1..9 | 跳到第 N 个标签（9 = 最后一个） |
// | Ctrl/Cmd + W    | 关闭当前标签 |
// | Ctrl/Cmd + Tab  | 切到下一个 / 上一个（Shift 反向） |
//
// 重点锁**不抢**的边界：这三个键浏览器都有默认行为（切浏览器标签页 / 关标签页），
// 所以必须满足「焦点在 #root 内」且「不在输入框里」才拦截。
// 这条边界破了会很烦人：用户在地址栏按 Ctrl+W 想关浏览器标签，结果关了我们面板。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { DocTabsHeader } from '@/components/shell/DocTabs';
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

const labels = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.shell-doctab-label')).map((e) => e.textContent ?? '');

const activeLabel = (c: HTMLElement) =>
  c.querySelector('.shell-doctab.is-active .shell-doctab-label')?.textContent ?? null;

/** 模拟「焦点在应用内」：把焦点放到容器里一个可聚焦元素上 */
function focusInApp(container: HTMLElement) {
  const btn = container.querySelector('.shell-doctab-main') as HTMLElement;
  btn?.focus();
}

beforeEach(() => {
  act(() => {
    usePanelOpenStore.setState({ keys: [], baseOpen: true, activeKey: null } as never);
  });
});
afterEach(() => {
  act(() => {
    usePanelOpenStore.setState({ keys: [], baseOpen: true, activeKey: null } as never);
  });
});

describe('DocTabsHeader · 键盘快捷键', () => {
  it('Ctrl+2 跳到第 2 个标签', () => {
    registerPanels([['notes', '笔记'], ['outline', '大纲']]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes', 'outline'], 'notes');
    focusInApp(container);

    act(() => {
      fireEvent.keyDown(document, { key: '2', ctrlKey: true });
    });
    // 第 1 格是「章节正文」，第 2 格是「笔记」
    expect(activeLabel(container)).toBe('笔记');
  });

  it('Ctrl+9 跳到**最后一个**标签（VS Code 惯例）', () => {
    registerPanels([['notes', '笔记'], ['outline', '大纲'], ['stats', '统计']]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes', 'outline', 'stats'], 'notes');
    focusInApp(container);

    act(() => {
      fireEvent.keyDown(document, { key: '9', ctrlKey: true });
    });
    expect(activeLabel(container)).toBe('统计');
  });

  it('Ctrl+W 关闭当前标签（面板从 store 移除）', () => {
    registerPanels([['notes', '笔记'], ['outline', '大纲']]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes', 'outline'], 'outline');
    focusInApp(container);
    expect(labels(container).some((l) => l.startsWith('大纲'))).toBe(true);

    act(() => {
      fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
    });
    expect(usePanelOpenStore.getState().keys).not.toContain('outline');
    expect(labels(container).some((l) => l.startsWith('大纲'))).toBe(false);
  });

  it('★ 焦点不在应用内（模拟地址栏）⇒ **不拦截**，浏览器默认行为保留', () => {
    registerPanels([['notes', '笔记'], ['outline', '大纲']]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes', 'outline'], 'outline');
    // 不调用 focusInApp：显式清空焦点，让 activeElement 回落到 body
    //（jsdom 里 body.focus() 不保证改变 activeElement，必须 blur 当前焦点）
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });

    act(() => {
      fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
    });
    // 面板没被关掉 ⇒ 说明没抢这个键
    expect(usePanelOpenStore.getState().keys).toContain('outline');
    expect(container.querySelectorAll('.shell-doctab').length).toBeGreaterThan(0);
  });

  it('★ 输入框里按 Ctrl+W ⇒ **不拦截**（那里是"删前一个词"）', () => {
    registerPanels([['notes', '笔记'], ['outline', '大纲']]);
    const { container } = render(
      <div>
        <DocTabsHeader />
        <input data-testid="probe-input" />
      </div>,
    );
    openPanels(['notes', 'outline'], 'outline');
    const input = container.querySelector('[data-testid="probe-input"]') as HTMLInputElement;
    act(() => {
      input.focus();
    });

    act(() => {
      fireEvent.keyDown(document, { key: 'w', ctrlKey: true });
    });
    expect(usePanelOpenStore.getState().keys).toContain('outline');
  });
});
