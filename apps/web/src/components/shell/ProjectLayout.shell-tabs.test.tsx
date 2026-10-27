// ============================================================
// ProjectLayout.shell-tabs.test.tsx —— 外壳改造的运行时自证（t1）
//
// 在 jsdom 里**真的挂载 ProjectLayout**（含 DockShell / 文档标签栏 / 状态栏），断言截图形态：
//   · 顶栏：面包屑「砚舟 / 章节名」+ 重写 · 夜间（m04040：模式切换按钮组已移除）
//   · auto 模式走工作台分支 ⇒ 降级占位自带「小返回键」，点它回书架（m04040）
//   · 文档标签行渲染在中心 dock 组的组头内（t6 去层：不再是顶栏之下的一条独立横带）
//   · 底部细条：左「底部面板」+ 右「N 条问题 Ctrl+J」
//   · 通栏状态栏：真实保存态 / 项目总字数 / 当前模式 + 本机时间（主题档位已于 2026-10-27 删除）
//   · 「夜间」即时切到暗色（<html>.dark + color-scheme），再点回亮色
//
// ⚠️ 这里只补**机制**证据；数据真实性与 API 契约由 acceptance 逐条说明。
// ============================================================

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// apiClient 全量 mock：`get` 永不 resolve（避免测试里触发真实/意外的数据恢复链路），
// `put` 在 m04040 之后已无断言方（壳不再写 project.mode），保留只为兜住意外真实写请求。
const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(() => new Promise(() => {})),
}));

vi.mock('@/services/api/apiClient', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    apiClient: {
      get: mocks.get,
      put: mocks.put,
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

// 参考书加载与本次断言无关，且会真的发请求 —— 直接替身掉（ProjectLayout 只调 getState().loadBooks）
vi.mock('@/stores/referenceStore', () => ({
  useReferenceStore: { getState: () => ({ loadBooks: vi.fn() }) },
}));

import { ProjectLayout } from '@/components/shell/ProjectLayout';
import { useProjectStore, useChapterStore } from '@/stores';
import { usePluginRegistry } from '@/plugin/registry';
import { _resetPanelOpenStore } from '@/stores/panelOpenStore';

const PROJECT = {
  id: 'p1',
  name: '砚舟',
  currentWordCount: 12480,
  mode: 'manual',
  createdAt: 0,
  updatedAt: 0,
};

beforeAll(() => {
  // dockview 依赖 ResizeObserver —— jsdom 未内建（与 DockShell.smoke.test.tsx 同口径）
  if (!('ResizeObserver' in globalThis)) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  }
  if (!('matchMedia' in window)) {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
  }
});

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/project']}>
      <Routes>
        <Route path="/project" element={<ProjectLayout />} />
        {/* 返回键的落点：导航真的发生时用它断言（m04040） */}
        <Route path="/bookshelf" element={<div data-testid="bookshelf-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.put.mockReset();
  act(() => {
    useProjectStore.setState({ currentProject: PROJECT } as never);
    useChapterStore.setState({ chapters: [], currentChapterId: null } as never);
    // 面板打开集合 + 两个内置栏面板定义：真实应用由插件宿主注册（本测试直接种下），
    // 否则标签行只能回落成裸 key（chapters / ai-chat）—— 那是 fallback，不是用户可见形态。
    // ⚠ 必须走 `_resetPanelOpenStore()` 而不是只 setState：播种开关（`seeded`）与
    //   「种子待视图确认」缓冲都是**模块级**状态，只清 state 会让第 2 例起不再播种，
    //   标签行退化成「只有基础标签」（那是测试残留，不是产品行为）。
    _resetPanelOpenStore();
    usePluginRegistry.setState({
      builtinPanels: [
        // `icon` 是 `FloatingPanelDef` 的必填字段（活动栏直接渲染它，缺了会让整壳报错）
        { key: 'chapters', label: '章节', icon: () => null, Component: () => null, modes: ['manual'], dock: { slot: 'left' } },
        { key: 'ai-chat', label: 'AI 对话', icon: () => null, Component: () => null, modes: ['manual'], dock: { slot: 'right' } },
      ],
    } as never);
  });
});

afterEach(() => {
  act(() => {
    useProjectStore.setState({ currentProject: null } as never);
    useChapterStore.setState({ chapters: [], currentChapterId: null } as never);
  });
  document.documentElement.classList.remove('dark');
});

describe('ProjectLayout 外壳（t1 截图形态）', () => {
  it('顶栏：面包屑「项目名 / 章节名」+ 重写/夜间，且不再有模式切换按钮', () => {
    const { container } = renderShell();

    // 面包屑
    const crumb = container.querySelector('.shell-breadcrumb');
    expect(crumb).toBeTruthy();
    expect(container.querySelector('.shell-breadcrumb-root')?.textContent).toBe('砚舟');
    expect(container.querySelector('.shell-breadcrumb-sep')?.textContent).toBe('/');
    // 无当前章节 ⇒ 回落「章节正文」
    expect(container.querySelector('.shell-breadcrumb-leaf')?.textContent).toBe('章节正文');

    // ★ 用户口径（m04040）：顶栏不再出现「手写 / AI 写作」模式切换按钮组 ——
    //   创作模式在开书时定下（书架页新建向导写 project.mode），写作途中不再切换；
    //   当前模式仍在状态栏被动显示（见下方状态栏用例）。
    expect(container.querySelector('.shell-mode-switch')).toBeNull();
    expect(container.querySelectorAll('.shell-mode-btn').length).toBe(0);
    expect(container.querySelectorAll('[aria-label="创作模式"]').length).toBe(0);

    // 重写 / 夜间
    const textBtns = Array.from(container.querySelectorAll('.shell-topbar-text-btn'));
    expect(textBtns.map((b) => b.textContent)).toEqual(['重写', '夜间']);
    // 竖分隔线把「重写 · 夜间」与右侧图标按钮分开（模式按钮组删除后由 2 条降为 1 条）
    expect(container.querySelectorAll('.shell-topbar-divider').length).toBe(1);
  });

  it('mode=auto 走工作台分支：降级占位不渲染顶栏，切回 manual 外壳回来', async () => {
    const { container } = renderShell();
    // 模式在开书时定下，运行时已无切换入口 ⇒ 直接用 store 驱动（真实来源）
    act(() => {
      useProjectStore.getState().updateProject({ mode: 'auto' });
    });

    // 本环境未注册 auto 工作台 ⇒ 降级占位
    await waitFor(() => {
      expect(container.textContent).toContain('未安装');
    });

    // auto 分支在渲染顶栏之前就提前 return（ProjectLayout 的 mode === 'auto' 分支）
    // ⇒ 壳的停靠外壳整体不存在，这条路径上的返回入口只能由占位自己提供（见下一条用例）
    expect(container.querySelector('.shell-topbar')).toBeNull();

    // 切回 manual（store 变更）⇒ 停靠外壳与顶栏回来
    act(() => {
      useProjectStore.getState().updateProject({ mode: 'manual' });
    });
    await waitFor(() => {
      expect(container.querySelector('.shell-topbar')).toBeTruthy();
    });
  });

  it('auto 降级占位的「小返回键」真的回书架（m04040）', async () => {
    const { container } = renderShell();
    act(() => {
      useProjectStore.getState().updateProject({ mode: 'auto' });
    });
    await waitFor(() => {
      expect(container.textContent).toContain('未安装');
    });

    // 与外壳顶栏返回键同款命名：aria-label「返回书架」（顶栏那个是「返回」，
    // 且 auto 分支下顶栏本就不存在 ⇒ 选择器无歧义）
    const back = container.querySelector('button[aria-label="返回书架"]') as HTMLElement | null;
    expect(back).toBeTruthy();

    fireEvent.click(back as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="bookshelf-page"]')).toBeTruthy();
    });
  });

  it('「夜间」即时切暗色（<html>.dark + color-scheme），再点回亮色', () => {
    const { container } = renderShell();
    const btnAt = (i: number) => container.querySelectorAll('.shell-topbar-text-btn')[i] as HTMLElement;

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(btnAt(1).textContent).toBe('夜间');

    fireEvent.click(btnAt(1));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(btnAt(1).textContent).toBe('日间');

    fireEvent.click(btnAt(1));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(btnAt(1).textContent).toBe('夜间');
  });

  it('文档标签行在中心 dock 组头内（不再自成顶栏之下的一条横带）', () => {
    const { container } = renderShell();
    const topbar = container.querySelector('.shell-topbar') as HTMLElement;
    const main = container.querySelector('.shell-main') as HTMLElement;
    const doctabs = container.querySelector('.shell-doctabs') as HTMLElement;
    expect(topbar && main && doctabs).toBeTruthy();
    // ★ t6 去层：顶部由「顶栏 + 独立标签行 + 组头」三层收敛为「顶栏 + 头部带」两层。
    //   `.shell-doctabs` 现在渲染在中心 dock 组的组头里，因此它是 `.shell-main` 的**后代**
    //   （旧断言「位于顶栏之下、主区之上」按新架构已不成立）。
    expect(topbar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.contains(doctabs)).toBe(true);
    // ★ 2026-10-11 全动态标签：某条标签 = 某个已打开的面板（+ 第 1 格基础标签「章节正文」）。
    //   手写台默认打开集合是 `DEFAULT_OPEN_PANEL_KEYS.manual`（章节树 / AI 对话），
    //   因此这里断言的是该集合的标签，而不是旧的「目录三件套」。
    expect(
      Array.from(container.querySelectorAll('.shell-doctab-label')).map((el) => el.textContent),
    ).toEqual(['章节正文', '章节', 'AI 对话']);
  });

  it('底部细条：左「底部面板」+ 右「N 条问题 Ctrl+J」', () => {
    const { container } = renderShell();
    const toggle = container.querySelector('.dock-bottom-toggle') as HTMLElement;
    expect(toggle.textContent).toContain('底部面板');
    const right = container.querySelector('.dock-bottom-right') as HTMLElement;
    // 无当前章节 ⇒ 真实批注来源为空 ⇒ 0 条（不是写死的 3）
    expect(right.textContent).toContain('0 条问题');
    expect(right.textContent).toContain('Ctrl+J');
    expect(container.querySelector('.dock-bottom-area')?.getAttribute('data-open')).toBe('false');
  });

  it('通栏状态栏：真实保存态 / 项目总字数 / 当前模式 + 本机时间', () => {
    const { container } = renderShell();
    const groups = container.querySelectorAll('.shell-statusbar-group');
    expect(groups.length).toBe(2);

    const left = groups[0]?.textContent ?? '';
    expect(left).toContain('已保存'); // useSaveState：无内容差异 ⇒ 已保存
    expect(left).toContain('12,480 字'); // Project.currentWordCount（真实字段）
    expect(left).toContain('手写模式'); // project.mode

    // ★ 2026-10-27 用户口径：右侧那个「主题名 · 亮/暗」指示**已删除**
    //   （与顶栏「夜间」按钮信息重复）。这里改成反向断言 —— 它不该再回来。
    const right = groups[1]?.textContent ?? '';
    expect(right).not.toContain('VS Code Modern');
    expect(right).not.toContain('亮色');
    expect(right).not.toContain('暗色');
    expect(right).toMatch(/\d{2}:\d{2}/); // useClock 的本机时间
  });
});
