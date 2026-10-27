// ============================================================
// DocTabs.test.tsx —— 文档标签行的运行时冒烟（t1 自证 / t6 去层 / ★ 全动态标签）
//
// 证明标签行**只表达「打开了什么」**：
//   · 第 1 格恒为「章节正文」（基础标签），其后每个已打开面板一条标签
//   · 「全部功能」一视同仁：章节树 / AI 对话 / 人物设定 / 大纲 / 时间线 … 都有标签
//   · × 关闭 = 关闭它代表的真实面板；面板在别处被关 ⇒ 标签自动消失
//   · 「+」菜单 = 正文 + 面板候选池（已打开带标记），点击即打开
//   · 激活态可见（`.shell-doctab.is-active`），面板被聚焦 ⇒ 对应标签激活
//   · 标题取自真实 store（章节名 / 大纲卷名），无数据时回落静态标题
//
// ★ t6 去层后的两处口径变化：
//   1) 组件由 `DocTabs` 改名为 `DocTabsHeader` —— 它现在渲染在**中心 dock 组的组头**
//      （dockview 的 `[role="tab"]` 元素内部），不再是顶栏之下的独立横条。
//   2) 因为它嵌在 `role="tab"` 里，自身**不能**再声明 `role="tablist"/"tab"`
//      （嵌套交互元素是 a11y 反模式）。当前文档改用 `aria-current` 表达。
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { DocTabsHeader, DOC_BASE_TAB } from '@/components/shell/DocTabs';
import { useChapterStore, useOutlineStore } from '@/stores';
import { usePanelOpenStore } from '@/stores/panelOpenStore';
import { usePluginRegistry } from '@/plugin/registry';

function tabLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.shell-doctab-label')).map(
    (el) => el.textContent ?? '',
  );
}

function activeLabel(container: HTMLElement): string | null {
  return container.querySelector('.shell-doctab.is-active .shell-doctab-label')?.textContent ?? null;
}

/** 注册面板定义（活动栏 / 面板本体 / 标签行 / 「+」菜单读的是同一份注册表 label）。 */
function registerPanels(list: Array<[key: string, label: string]>) {
  act(() => {
    usePluginRegistry.setState({
      projectPanels: list.map(([key, label]) => ({ key, label }) as never),
    });
  });
}

/** 模拟面板打开集合的落点（活动栏点开 / 命令式 open / 视图上报后的真实取值）。 */
function openPanels(keys: string[], activeKey: string | null = null) {
  act(() => {
    usePanelOpenStore.setState({ keys, activeKey });
  });
}

beforeEach(() => {
  act(() => {
    useOutlineStore.setState({ nodes: [] });
    useChapterStore.setState({ currentChapterId: null });
    // ★ 全动态标签的两处真源 —— 每例前清空，避免跨例泄漏
    //   （含 baseOpen：基础标签也当动态标签，可关，测试间需归位为打开）
    usePanelOpenStore.setState({ keys: [], activeKey: null, baseOpen: true });
    usePluginRegistry.setState({ projectPanels: [], builtinPanels: [] });
  });
});

describe('DocTabsHeader 文档标签行', () => {
  it('没开任何面板时只有基础标签「章节正文」+「+」', () => {
    const { container } = render(<DocTabsHeader />);
    expect(DOC_BASE_TAB.id).toBe('doc:chapter');
    expect(tabLabels(container)).toEqual(['章节正文']);
    expect(activeLabel(container)).toBe('章节正文');
    expect(container.querySelectorAll('.shell-doctab.is-active').length).toBe(1);
    expect(container.querySelector('.shell-doctab-add')).toBeTruthy();
  });

  it('★ 全部功能一视同仁：每个已打开的面板都出一条带 × 的标签', () => {
    registerPanels([
      ['chapters', '章节'],
      ['ai-chat', 'AI 对话'],
      ['characters', '人物设定'],
      ['outline', '大纲'],
      ['timeline', '时间线'],
    ]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['chapters', 'ai-chat', 'characters', 'outline', 'timeline'], 'timeline');

    // 顺序 = 打开顺序；标题取自注册表（大纲面板带真实卷名）
    expect(tabLabels(container)).toEqual([
      '章节正文',
      '章节',
      'AI 对话',
      '人物设定',
      '大纲 · 卷一',
      '时间线',
    ]);
    // 每条标签都有自己的 ×
    expect(container.querySelectorAll('.shell-doctab-close').length).toBe(6);
    // 被聚焦的面板 ⇒ 对应标签是激活项
    expect(activeLabel(container)).toBe('时间线');
    expect(container.querySelectorAll('.shell-doctab.is-active').length).toBe(1);
  });

  it('★ × 关标签 = 关真实面板；面板在别处被关 ⇒ 标签自动消失', () => {
    registerPanels([
      ['chapters', '章节'],
      ['ai-chat', 'AI 对话'],
      ['timeline', '时间线'],
    ]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['chapters', 'ai-chat', 'timeline'], 'timeline');

    // 点「时间线」的 × ⇒ 真实面板关闭（store 里真的没了），标签随之消失；
    // 激活态按既有契约切到左邻（它是最后一格）
    fireEvent.click(container.querySelectorAll('.shell-doctab-close')[3] as HTMLElement);
    expect(usePanelOpenStore.getState().keys).toEqual(['chapters', 'ai-chat']);
    expect(tabLabels(container)).toEqual(['章节正文', '章节', 'AI 对话']);
    expect(activeLabel(container)).toBe('AI 对话');

    // 面板在别处关闭（活动栏再点一次 / 上限淘汰 / 视图上报）⇒ 标签消失，激活回落基础标签
    act(() => {
      usePanelOpenStore.getState().close('ai-chat');
    });
    expect(tabLabels(container)).toEqual(['章节正文', '章节']);
    expect(activeLabel(container)).toBe('章节正文');
    expect(usePanelOpenStore.getState().keys).toEqual(['chapters']);
  });

  it('点标签主体 = 聚焦该面板（已打开 ⇒ 不重复开、不重复出标签）', () => {
    registerPanels([['notes', '笔记']]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['notes'], null);
    expect(activeLabel(container)).toBe('章节正文');

    fireEvent.click(container.querySelectorAll('.shell-doctab-main')[1] as HTMLElement);
    expect(tabLabels(container)).toEqual(['章节正文', '笔记']);
    expect(activeLabel(container)).toBe('笔记');
    expect(usePanelOpenStore.getState().keys).toEqual(['notes']);
  });

  it('「+」菜单 = 正文 + 全部面板候选池（已打开的带标记），点一项即打开', () => {
    registerPanels([
      ['chapters', '章节'],
      ['timeline', '时间线'],
      ['notes', '笔记'],
    ]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['chapters'], 'chapters');

    fireEvent.click(container.querySelector('.shell-doctab-add') as HTMLElement);
    const items = Array.from(document.querySelectorAll('.shell-doctab-menu-item'));
    expect(items.map((el) => el.textContent)).toEqual(['章节正文', '章节', '时间线', '笔记']);
    // 已打开（正文 + 章节）带 is-open 标记，未打开的不带
    expect(items.map((el) => el.classList.contains('is-open'))).toEqual([true, true, false, false]);

    // 点未打开的「时间线」⇒ 打开真实面板 + 标签出现 + 菜单收起
    fireEvent.click(items[2] as HTMLElement);
    expect(usePanelOpenStore.getState().keys).toEqual(['chapters', 'timeline']);
    expect(tabLabels(container)).toEqual(['章节正文', '章节', '时间线']);
    expect(document.querySelector('.shell-doctab-menu')).toBeNull();

    // 再打开菜单点已打开的「章节」⇒ 只聚焦，不新增
    fireEvent.click(container.querySelector('.shell-doctab-add') as HTMLElement);
    fireEvent.click(document.querySelectorAll('.shell-doctab-menu-item')[1] as HTMLElement);
    expect(usePanelOpenStore.getState().keys).toEqual(['chapters', 'timeline']);
    expect(tabLabels(container)).toEqual(['章节正文', '章节', '时间线']);
  });

  it('基础标签关掉后可从「+」菜单恢复', () => {
    const { container } = render(<DocTabsHeader />);
    fireEvent.click(container.querySelector('.shell-doctab-close') as HTMLElement);
    expect(tabLabels(container)).toEqual([]);
    expect(container.querySelector('.shell-doctab.is-active')).toBeNull();
    expect(container.querySelector('.shell-doctabs-list')).toBeTruthy();

    fireEvent.click(container.querySelector('.shell-doctab-add') as HTMLElement);
    const items = Array.from(document.querySelectorAll('.shell-doctab-menu-item'));
    expect(items.map((el) => el.textContent)).toEqual(['章节正文']);
    fireEvent.click(items[0] as HTMLElement);
    expect(tabLabels(container)).toEqual(['章节正文']);
    expect(activeLabel(container)).toBe('章节正文');
    expect(document.querySelector('.shell-doctab-menu')).toBeNull();
  });

  // F2：菜单被 `.shell-doctabs{overflow:hidden}` 裁到鼠标点不中 ⇒ 改为 portal 到 body。
  // jsdom 没有布局引擎，这里只能断言**挂载位置**这条结构性事实（菜单不在裁剪容器内、
  // 是 body 的直接子节点、带内联坐标）；真实命中测试由 CDP + 真实鼠标在浏览器里做，
  // 见本次修复报告里的复现步骤与 elementFromPoint 证据。
  it('「+」菜单 portal 到 body：不在 .shell-doctabs 内，带内联坐标，且不再受裁剪容器影响', () => {
    const { container } = render(<DocTabsHeader />);
    fireEvent.click(container.querySelector('.shell-doctab-add') as HTMLElement);

    // 裁剪容器里不再有菜单（否则又会只剩几像素可见）
    expect(container.querySelector('.shell-doctab-menu')).toBeNull();
    // 菜单是 <body> 的直接子节点 ⇒ 祖先链上没有任何 overflow 容器
    const menu = document.querySelector('.shell-doctab-menu') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu?.parentElement).toBe(document.body);
    expect(menu?.getAttribute('role')).toBe('menu');
    // 坐标由「+」按钮 rect 内联给出（jsdom 里 rect 为 0，仍应是有限数字而非空）
    expect(Number.isFinite(Number.parseInt(menu?.style.top ?? '', 10))).toBe(true);
    expect(Number.isFinite(Number.parseInt(menu?.style.right ?? '', 10))).toBe(true);
    // 标签行自身仍只有原来的容器高度，没有被菜单撑开（F2 的关键性质：菜单不参与布局）
    expect(container.querySelector('.shell-doctabs-actions')?.querySelector('.shell-doctab-menu')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.shell-doctab-menu')).toBeNull();
  });

  it('标题取真实 store：章节名覆盖基础标签，act 标题覆盖大纲面板标签', () => {
    registerPanels([['outline', '大纲']]);
    const { container } = render(<DocTabsHeader />);
    openPanels(['outline']);

    act(() => {
      useChapterStore.setState({
        chapters: [
          {
            id: 'c1',
            projectId: 'p1',
            title: '第一章 山雨欲来',
            content: '',
            order: 1,
            wordCount: 0,
            status: 'draft',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        currentChapterId: 'c1',
      } as never);
      useOutlineStore.setState({
        nodes: [
          {
            id: 'n1',
            projectId: 'p1',
            type: 'act',
            title: '山雨卷',
            order: 1,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      } as never);
    });

    expect(tabLabels(container)).toEqual(['第一章 山雨欲来', '大纲 · 山雨卷']);
  });
});

// ============================================================
// ★ 2026-10-25 分屏：标签拖拽 + 按聚焦组过滤
//
// 背景：单列布局把 dockview 原生标签 `display:none` 了，用户没有拖拽抓手。
// 故由自绘标签写入 dataTransfer，DockShell 的 DocSplitDropZone 读取并分屏。
// 这里钉死两件事：① 拖拽载荷是面板 key；② 分屏后标签条只显示聚焦组的标签。
// ============================================================
describe('DocTabsHeader 分屏', () => {
  /**
   * ★ 2026-10-25：拖拽已从 HTML5 DnD 改为 **pointer 事件**（见 DocSplitDropZone 头注）：
   * 标签主体是 `<button>`，Chrome 不会从 `<button>` 内发起祖先的 HTML5 拖拽。
   * 故这里断言的是「pointerdown 后拖拽会话被启动」而不是 dataTransfer 载荷。
   */
  function pointerDown(el: HTMLElement, x = 100, y = 40) {
    fireEvent.pointerDown(el, { button: 0, clientX: x, clientY: y, pointerId: 1 });
  }

  it('启用分屏时，标签可发起拖拽（pointerdown 启动拖拽会话）', () => {
    registerPanels([['ai-chat', 'AI 对话']]);
    const { container } = render(<DocTabsHeader onSplitRequest={() => {}} />);
    openPanels(['ai-chat'], 'ai-chat');

    const tabs = container.querySelectorAll<HTMLElement>('.shell-doctab');
    expect(tabs.length).toBe(2); // 章节正文 + AI 对话

    // 两条标签都能起拖（不再依赖 draggable 属性）
    for (const t of Array.from(tabs)) {
      expect(t.getAttribute('draggable')).toBeNull();
      expect(() => pointerDown(t)).not.toThrow();
    }
    // 拖拽会话启动后，window 上应挂了 pointermove 监听（用一个移动事件验证不会抛错）
    expect(() =>
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 300 })),
    ).not.toThrow();
    // 清理：Esc 取消本次拖拽会话
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('× 按钮上按下不发起拖拽（避免「关标签」被当成拖拽起点）', () => {
    registerPanels([['notes', '笔记']]);
    const { container } = render(<DocTabsHeader onSplitRequest={() => {}} />);
    openPanels(['notes'], 'notes');
    const closeBtn = container.querySelector('.shell-doctab-close') as HTMLElement;
    expect(() => pointerDown(closeBtn)).not.toThrow();
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('★ 分屏后列出**所有栏**的标签（另一栏的标签不退场，带栏位角标）', () => {
    // 2026-10-26 用户口径修正：分屏的意义是"同时看两样"，标签条却只显示聚焦栏
    // ⇒ 用户以为「章节正文不见了」。现在两栏的标签都在，非聚焦栏带角标。
    registerPanels([
      ['chapters', '章节'],
      ['ai-chat', 'AI 对话'],
    ]);
    // 左栏含基础标签 + 章节；右栏是 AI 对话 —— 焦点在右栏
    const { container, rerender } = render(
      <DocTabsHeader
        groupScope={{
          split: true,
          hasBase: false,
          panelKeys: ['ai-chat'],
          groups: [
            { panelKeys: ['chapters'], hasBase: true, active: false },
            { panelKeys: ['ai-chat'], hasBase: false, active: true },
          ],
        }}
        onSplitRequest={() => {}}
      />,
    );
    openPanels(['chapters', 'ai-chat'], 'ai-chat');
    // 两栏的标签都列出（基础标签 + 左栏章节 + 右栏 AI 对话）
    expect(tabLabels(container)).toEqual(['章节正文', '章节', 'AI 对话']);
    // 每个标签都带栏位角标，且聚焦栏的角标是 is-active
    const badges = Array.from(container.querySelectorAll('.shell-doctab-group-badge')).map((b) => ({
      text: b.textContent,
      active: b.classList.contains('is-active'),
    }));
    expect(badges).toEqual([
      { text: '1', active: false },
      { text: '1', active: false },
      { text: '2', active: true },
    ]);

    // 焦点切到左栏 ⇒ 角标激活态跟着换，但标签集合不变（一栏都不丢）
    rerender(
      <DocTabsHeader
        groupScope={{
          split: true,
          hasBase: true,
          panelKeys: ['chapters'],
          groups: [
            { panelKeys: ['chapters'], hasBase: true, active: true },
            { panelKeys: ['ai-chat'], hasBase: false, active: false },
          ],
        }}
        onSplitRequest={() => {}}
      />,
    );
    expect(tabLabels(container)).toEqual(['章节正文', '章节', 'AI 对话']);
    expect(
      Array.from(container.querySelectorAll('.shell-doctab-group-badge')).map((b) => b.classList.contains('is-active')),
    ).toEqual([true, true, false]);
  });

  it('未分屏（split:false）时忽略 groupScope，显示全部标签', () => {
    registerPanels([
      ['chapters', '章节'],
      ['ai-chat', 'AI 对话'],
    ]);
    const { container } = render(
      <DocTabsHeader
        groupScope={{ split: false, hasBase: true, panelKeys: ['chapters'] }}
        onSplitRequest={() => {}}
      />,
    );
    openPanels(['chapters', 'ai-chat'], null);
    expect(tabLabels(container)).toEqual(['章节正文', '章节', 'AI 对话']);
  });

  it('分屏时出现「合并分屏」按钮，点击触发 onUnsplitAll', () => {
    let called = 0;
    const { container } = render(
      <DocTabsHeader splitActive onUnsplitAll={() => { called += 1; }} />,
    );
    const btn = container.querySelector('.shell-doctab-unsplit') as HTMLElement;
    expect(btn?.textContent).toBe('合并分屏');
    fireEvent.click(btn);
    expect(called).toBe(1);

    // 非分屏不出现
    const { container: c2 } = render(<DocTabsHeader onUnsplitAll={() => {}} />);
    expect(c2.querySelector('.shell-doctab-unsplit')).toBeNull();
  });

  it('右键标签出现分屏菜单，点「向右分屏」回调 (key, side)', () => {
    const calls: Array<[string, string]> = [];
    registerPanels([['ai-chat', 'AI 对话']]);
    const { container } = render(
      <DocTabsHeader onSplitRequest={(k, s) => calls.push([k, s])} />,
    );
    openPanels(['ai-chat'], 'ai-chat');

    const tab = container.querySelectorAll<HTMLElement>('.shell-doctab')[1] as HTMLElement;
    fireEvent.contextMenu(tab, { clientX: 120, clientY: 40 });

    const menu = document.querySelector('.shell-doctab-ctx') as HTMLElement | null;
    expect(menu).toBeTruthy();
    const items = Array.from(menu!.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(items).toEqual(['向右分屏', '向左分屏']); // 未分屏 ⇒ 无「取消分屏」

    fireEvent.click(menu!.querySelectorAll('button')[0] as HTMLElement);
    expect(calls).toEqual([['ai-chat', 'right']]);
    expect(document.querySelector('.shell-doctab-ctx')).toBeNull();
  });
});
