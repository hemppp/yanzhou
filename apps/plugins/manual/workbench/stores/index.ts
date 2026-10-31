// ============================================================
// @novel-plugins/manual-workbench/stores —— 手写台专属 store
//
// 由 `apps/web/src/stores/index.ts` 切分而来（D1/D33）：
//   · 实体 / 领域 store → @novel-plugins/data-core/stores（共享）
//   · 手写台专属（useUIStore / useQuickPhraseStore）→ 本文件
//
// 说明：`useUIStore` 的 leftSidebar/rightSidebar 开关虽由 kernel 侧读取，
// 但语义上属手写台布局状态；kernel 通过 `@/stores` 兼容壳仍可取到（t4 保留壳）。
// ============================================================

import { create } from 'zustand';
import { nanoid } from 'nanoid';

// ---- UI 状态 ----

interface UIState {
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  leftSidebarTab: 'chapters' | 'outline' | 'notes';
  rightSidebarTab: 'context' | 'rhythm' | 'characters' | 'foreshadows' | 'items';
  focusMode: boolean;
  splitView: boolean;
  foreshadowWindowOpen: boolean;
  /** 地图是否打开 */
  storyMapOpen: boolean;
  toggleStoryMap: () => void;
  setStoryMapOpen: (open: boolean) => void;
  /** 暗色模式 */
  isDark: boolean;
  toggleTheme: () => void;
  setTheme: (dark: boolean) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarTab: (tab: UIState['leftSidebarTab']) => void;
  setRightSidebarTab: (tab: UIState['rightSidebarTab']) => void;
  toggleFocusMode: () => void;
  toggleSplitView: () => void;
  toggleForeshadowWindow: () => void;
  setForeshadowWindowOpen: (open: boolean) => void;
}

// ★ 2026-10-29 删除「固定为亮色模式」的模块级副作用：
//
//   ```ts
//   if (typeof document !== 'undefined') {
//     document.documentElement.classList.remove('dark');
//   }
//   ```
//
// 它是水墨时期手写台的遗留 —— 那时主题是「固定亮色」。但 `ui-kit` 的
// `themeStore.applyTheme()` 早已把明暗切换交给 `<html>.dark` + `color-scheme`
// 双写（ADR §6.3 修订），于是这两处**互相打架**：
//
//   · 本模块只被 `import` 一次（模块缓存），但 `applyStoredTheme()` 在
//     `main.tsx` **模块顶层**执行，早于任何页面组件 —— 顺序上本模块是后跑的，
//     于是它把刚设好的 `.dark` **又摘掉**。
//   · 实测表现（2026-10-29 走查）：localStorage 里存着 `mode:'dark'`、
//     `applyTheme` 也执行了（`color-scheme: dark` 写进了 inline style），
//     但 `.dark` 类被摘掉 ⇒ 所有 `--card` / `--background` 仍是亮档
//     （实测 `--card` 解析到 `0 0% 99.2%`），点「夜间」按钮当次有效、
//     一刷新就回到白底。
//   · 因为该模块只在被 import 时执行一次，**必须刷新才复现** —— 这也是它
//     一直没被发现的原因（点按钮的那次总是好的）。
//
// 主题的真源只有一个：`themeStore`。任何模块都不得直接改写 `<html>.dark`。

export const useUIStore = create<UIState>((set) => ({
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  leftSidebarTab: 'chapters',
  rightSidebarTab: 'context',
  focusMode: false,
  splitView: false,
  foreshadowWindowOpen: false,
  storyMapOpen: false,
  toggleStoryMap: () => set((state) => ({ storyMapOpen: !state.storyMapOpen })),
  setStoryMapOpen: (open) => set({ storyMapOpen: open }),
  isDark: false,
  toggleTheme: () => {
    // 固定亮色模式，不做切换
  },
  setTheme: (_dark) => {
    // 固定亮色模式，不做切换
  },
  toggleLeftSidebar: () => set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen })),
  toggleRightSidebar: () => set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen })),
  setLeftSidebarTab: (tab) => set({ leftSidebarTab: tab }),
  setRightSidebarTab: (tab) => set({ rightSidebarTab: tab }),
  toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
  toggleSplitView: () => set((state) => ({ splitView: !state.splitView })),
  toggleForeshadowWindow: () => set((state) => ({ foreshadowWindowOpen: !state.foreshadowWindowOpen })),
  setForeshadowWindowOpen: (open) => set({ foreshadowWindowOpen: open }),
}));

// ---- 快捷短语状态 ----

export interface QuickPhrase {
  id: string;
  text: string;
  category: 'character' | 'location' | 'item' | 'custom' | 'ai';
  source?: string;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

interface QuickPhraseState {
  phrases: QuickPhrase[];
  visible: boolean;
  isGenerating: boolean;
  setPhrases: (phrases: QuickPhrase[]) => void;
  addPhrase: (phrase: Omit<QuickPhrase, 'id' | 'createdAt' | 'updatedAt' | 'usageCount'>) => void;
  removePhrase: (id: string) => void;
  incrementUsage: (id: string) => void;
  setVisible: (visible: boolean) => void;
  setIsGenerating: (generating: boolean) => void;
  clearByProject: () => void;
}

export const useQuickPhraseStore = create<QuickPhraseState>((set) => ({
  phrases: [],
  visible: true,
  isGenerating: false,
  setPhrases: (phrases) => set({ phrases }),
  addPhrase: (phrase) =>
    set((state) => ({
      phrases: [
        ...state.phrases,
        {
          ...phrase,
          id: nanoid(),
          usageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })),
  removePhrase: (id) =>
    set((state) => ({
      phrases: state.phrases.filter((p) => p.id !== id),
    })),
  incrementUsage: (id) =>
    set((state) => ({
      phrases: state.phrases.map((p) =>
        p.id === id ? { ...p, usageCount: p.usageCount + 1, updatedAt: Date.now() } : p,
      ),
    })),
  setVisible: (visible) => set({ visible }),
  setIsGenerating: (generating) => set({ isGenerating: generating }),
  clearByProject: () => set({ phrases: [] }),
}));