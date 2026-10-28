// ============================================================
// DocTabs.tsx —— 中心编辑区**文档标签行**（t1 外壳改造 / t6 去层 / ★ 全动态标签）
//
// 截图形态：「第一章 山雨欲来 ×」「人物设定」「大纲 · 卷一」 + 最右「+」，
// 与左「章节」、右「AI 对话」**共用同一条 35px 头部带**。
//
// ## 去层（t6，用户口径「上栏多了一层」）
//   原先标签行是顶栏之下一条**独立的 30px 横条**（`.shell-doctabs` 常驻在
//   `.shell-topbar` 与 `.shell-main` 之间），于是顶部叠了三层：
//   顶栏 35 + 独立标签行 30 + dock 组头 35。参考图只有**两层**
//   （顶栏 + 一条「左标题 / 中标签 / 右标题」共用带）。
//   现改为把标签行**放进中心 dock 组的组头**（`tabComponent`），三列标题同处一带，
//   独立横条消失 —— 见 DockShell 的 `DOCK_DOC_TABS_TAB_COMPONENT_ID`。
//
//   ⚠️ dockview 的 tabComponent 经 `createPortal` 渲染进组头元素，**不继承宿主
//      React 上下文**（dockview-react 的 ReactPart 只提供它自己的 ReactPartContext）。
//      故本组件只读**模块级** store / 注册表（useChapterStore / useOutlineStore /
//      panelOpenStore / usePluginRegistry / useProjectMode），不得依赖任何 Provider。
//   ⚠️ 本组件被渲染在 dockview 的 `[role="tab"]` 元素**内部**，因此自身**不能**再声明
//      `role="tablist"/"tab"`（嵌套交互元素是 a11y 反模式）。这里用
//      `role="group"` + 普通按钮 + `aria-current` 表达「当前文档」。
//
// ## ★ 2026-10-11 全动态标签（用户口径「点击打开功能需要和人物设定一样的在这个栏里面
//    可以关闭」→「全部功能都需要变成动态标签」）
//
//   本栏现在**只表达「打开了什么」**：
//     · 第 1 格恒为「章节正文」——**基础标签**：中心文档本身，不是功能面板，
//       不受任何面板开关影响（「+」菜单可在它被关掉后恢复）。
//     · 其后每一格 = `panelOpenStore.keys` 里的一个已打开面板，**一视同仁**：
//       章节树 / AI 对话 / 人物设定 / 大纲 / 时间线 … 没有任何面板被特殊对待。
//       （此前「目录三件套固定 + 常驻栏例外」的口径已按用户口径废弃。）
//     · × = 关闭它代表的面板（`getPanelNavigation().close(key)`）；
//       面板在**别处**被关闭（活动栏收起 / 上限淘汰 / 面板内关闭）⇒ 标签自动消失。
//     · 「+」菜单 = 面板候选池（与顶栏面板菜单**同一口径**：内置槽 ∪ 插件面板、
//       按 key 去重、按项目模式过滤、保持注册表 order），点击 = 打开或聚焦，
//       已打开的项带「已打开」标记。
//
//   真源唯一 = `panelOpenStore.keys`（打开集合）+ 插件注册表（标题）。
//   ⚠️ store 的既有上限 `MAX_OPEN_PANELS = 3`（超限 LRU 淘汰 + toast）照旧生效，
//      标签条数随之增减；本组件**不做**任何补偿或绕过。
//
// ## 契约
//   · × 关闭后激活**相邻**标签（右邻优先）；关到 0 个不崩（activeId → null）。
//   · 面板被聚焦（点活动栏 / 命令式 open）⇒ 对应标签跟着激活。
//   · 激活态＝顶部 2px 强调线（见 project-shell.css `.shell-doctab.is-active`）。
//
// 数据一律真实：无当前章节 ⇒ 基础标签回落「章节正文」；大纲面板的标签取
// `useOutlineStore` 里 order 最小的顶层 act 节点标题，无数据时回落「卷一」。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, ChevronDown } from 'lucide-react';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { useChapterStore, useOutlineStore } from '@/stores';
import { BASE_TAB_KEY, focusDocBase, getPanelNavigation, usePanelOpenStore } from '@/stores/panelOpenStore';
import { filterByProjectMode, usePluginRegistry, useProjectMode } from '@/plugin/registry';
import type { PluginMode } from '@/plugin/types';
import { beginSplitDrag } from './dock/DocSplitDropZone';

/** 一个文档标签。`kind==='chapter'` 是基础文档标签，`'panel'` 代表一个已打开的功能面板。 */
export interface DocTab {
  id: string;
  kind: 'chapter' | 'panel';
  /** `kind==='panel'` 时指向真实面板 key（注册表） */
  panelKey?: string;
  /** 静态标题；基础标签与 `panelKey==='outline'` 的标题在渲染时按真实数据覆盖 */
  title: string;
  /**
   * ★ 2026-10-26 分屏：该标签所在**栏位序号**（1 起，左→右）。
   *   仅分屏时由 DockShell 注入；单栏恒为 undefined（不渲染角标，旧行为不变）。
   */
  groupIndex?: number;
  /** 该栏是否是当前聚焦栏（非聚焦栏的标签点一下 = 把焦点切过去） */
  groupActive?: boolean;
}

/**
 * ★ 基础标签（永远排在第 1 格）：中心文档 = 章节正文。
 * 它不是功能面板 —— 正文由中心区章节编辑器出口（`<Outlet/>`）渲染，
 * 本标签只表达「当前文档是章节正文」；标题取 `useChapterStore` 的真实章节名
 * （`Chapter.title` 自带「第N章」前缀，见 apps/server/src/services/chapter-service.ts:277）。
 */
export const DOC_BASE_TAB: DocTab = { id: BASE_TAB_KEY, kind: 'chapter', title: '章节正文' };

/** 功能面板标签的 id 前缀（`doc:panel:<key>`）——它们由 `panelOpenStore.keys` 推导，不进本地状态。 */
const DYNAMIC_TAB_PREFIX = 'doc:panel:';

/** 「+」菜单里的一条候选面板（与 ProjectLayout 合池口径一致的最小字段集）。 */
interface PanelEntry {
  key: string;
  label: string;
  modes?: PluginMode[];
  order?: number;
}

interface DocTabsState {
  /**
   * ★ 2026-10-11：本地状态**只**承载「当前激活的是哪条标签」。
   * 标签集合（基础标签 + 功能面板）全部由 `panelOpenStore` 推导 —— 基础标签的
   * 开/关真源是 `store.baseOpen`，功能面板是 `store.keys`。
   */
  activeId: string | null;
}

/**
 * ★ 2026-10-25 分屏态：由 DockShell 注入的「聚焦组」信息。
 *
 * 单组（未分屏）时调用方**不传**这个 prop ⇒ 本组件回落「全部标签」，
 * 与改造前完全一致（8 个既有单测无需改写）。
 * 多组时只渲染聚焦组内的标签 —— 用户点哪一栏，顶部就显示哪一栏的标签页。
 */
export interface DocTabsGroupScope {
  /** 当前聚焦组里已打开的面板 key（业务 key，不含基础标签）。 */
  panelKeys: readonly string[];
  /** 焦点组是否包含中心默认面板（= 是否显示「章节正文」基础标签）。 */
  hasBase: boolean;
  /** 当前是否分屏（组数 > 1）。false ⇒ 忽略本 scope，回落全量。 */
  split: boolean;
  /**
   * ★ 2026-10-26：分屏时**每一栏**的标签集合（左→右），供顶部标签条"一次看全"。
   *
   * 为什么改口径：原实现只显示「聚焦那一栏」的标签 —— 用户分屏后看到顶部只剩
   * `AI 对话`，以为「章节正文不见了」（实测反馈）。分屏的意义是**同时看两样**，
   * 标签条却把另一半藏起来，等于把"已打开"的事实藏了。
   * 现在：所有栏的标签都列出，非聚焦栏的标签带一个栏位角标（如 `2`），
   * 点它 = 把焦点切到那一栏（见 DockShell 的 focusGroupOfPanel）。
   */
  groups?: ReadonlyArray<{
    /** 该栏里已打开的面板 key（左→右，不含基础标签） */
    panelKeys: readonly string[];
    /** 该栏是否含中心默认面板（章节正文） */
    hasBase: boolean;
    /** 是否是当前聚焦栏 */
    active: boolean;
  }>;
}

export interface DocTabsHeaderProps extends Partial<IDockviewPanelHeaderProps<never>> {
  /** ★ 分屏态的聚焦组范围；缺省 = 单栏全量（旧行为）。 */
  groupScope?: DocTabsGroupScope;
  /** ★ 拖拽落点回调：把标签拖到编辑区左/右边缘。缺省 = 不启用拖拽（单测友好）。 */
  onSplitRequest?: (key: string, side: 'left' | 'right') => void;
  /**
   * ★ 已废弃（2026-10-25 改 pointer 拖拽后不再需要）：拖拽态由
   * `DocSplitDropZone` 的 `subscribeSplitDrag`（**多订阅者**，2026-10-26 由单槽位改）
   * 统一播发，DockShell 与落点层各自订阅。保留字段仅为兼容旧调用方。
   */
  onDragStateChange?: (dragging: boolean) => void;
  /** ★ 取消分屏：把该标签代表的面板移回中心组。缺省 = 不显示该项。 */
  onUnsplitRequest?: (key: string) => void;
  /** ★ 一键合并所有分屏（不依赖具体标签，分屏时在标签条右侧出现）。 */
  onUnsplitAll?: () => void;
  /** ★ 当前是否分屏（决定右键菜单里是否出现「取消分屏」）。 */
  splitActive?: boolean;
  /**
   * ★ 2026-10-26：点非聚焦栏的标签时，请求把焦点切到那一栏（由 DockShell 提供）。
   *   缺省不启用（单测 / 单栏场景）。
   */
  onFocusGroupRequest?: (tab: DocTab) => void;
}

/** 标签右键菜单的位置（portal 到 body，避开 `.shell-doctabs{overflow:hidden}` 裁剪）。 */
interface TabMenuState {
  key: string;
  label: string;
  top: number;
  left: number;
}

/**
 * 中心组组头里的文档标签行。
 *
 * dockview 会以 `IDockviewPanelHeaderProps` 调用它（本组件不消费这些 props）；
 * 参数声明为 `Partial` 且带缺省值，便于单测直接 `<DocTabsHeader />` 渲染。
 */
export function DocTabsHeader({
  groupScope,
  onSplitRequest,
  onUnsplitRequest,
  onUnsplitAll,
  splitActive,
  onFocusGroupRequest,
}: DocTabsHeaderProps = {}) {
  const [state, setState] = useState<DocTabsState>(() => ({ activeId: DOC_BASE_TAB.id }));
  // ---- 「+」菜单的定位（F2 修复） ----
  // 标签条 `.shell-doctabs` 是 `overflow:hidden`（防止标签条被撑破，
  // 这是必须保留的约束）。菜单若作为它的绝对定位子节点，会被裁到只剩几个像素，
  // 真实鼠标无法命中（t1 首版即此问题）。因此菜单改为 **portal 到 <body>**，
  // 用固定定位挂在自己算出的坐标上：不再有被 overflow 裁剪的祖先，
  // 也不参与标签条的布局（不换行、不横向溢出）。
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuOpen = menuPos !== null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 标签横向滚动容器（激活标签自动滚入视野用） */
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 溢出列表按钮 + 菜单坐标（portal 到 body，与「+」菜单同款处理） */
  const overflowBtnRef = useRef<HTMLButtonElement | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<{ top: number; right: number } | null>(null);
  /** 标签条是否真的溢出（决定「▾」按钮出不出） */
  const [overflowing, setOverflowing] = useState(false);

  // 按「+」按钮的视口矩形摆放菜单（右对齐按钮右缘，下方 4px），并夹在视口内。
  const placeMenu = useCallback(() => {
    const btn = addBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setMenuPos({
      top: Math.round(r.bottom + 4),
      right: Math.round(Math.max(4, window.innerWidth - r.right)),
    });
  }, []);

  // ---- 真实数据源 ----
  // 当前章节名（无章节 ⇒ null，标签回落静态标题）
  const chapterTitle = useChapterStore((s) => s.getCurrentChapter()?.title ?? null);
  // 大纲卷名：order 最小的顶层 act 节点（无数据 ⇒ null，回落「卷一」）
  const outlineTitle = useOutlineStore((s) => {
    const acts = s.nodes.filter((n) => n.type === 'act').sort((a, b) => a.order - b.order);
    return acts[0]?.title ?? null;
  });

  // ---- ★ 动态标签真源（见文件头「全动态标签」） ----
  const openPanelKeys = usePanelOpenStore((s) => s.keys);
  const focusedPanelKey = usePanelOpenStore((s) => s.activeKey);
  // ★ 2026-10-28 VS Code 对齐：预览标签 key（斜体显示用）
  const previewKey = usePanelOpenStore((s) => s.previewKey);
  // ★ 2026-10-11：基础标签（章节正文）也由 store 驱动（可关、计入总上限）
  const baseOpen = usePanelOpenStore((s) => s.baseOpen);
  const builtinPanels = usePluginRegistry((s) => s.builtinPanels);
  const projectPanels = usePluginRegistry((s) => s.projectPanels);
  const projectMode = useProjectMode();

  // 候选池：内置槽 ∪ 插件面板（按 key 去重、内置优先）→ 按项目模式过滤。
  // ★ 与 ProjectLayout 的合池口径**同源**（那边多带 Component / dock 字段供 dockview 用）；
  //   顺序沿用注册表排序（`order`），与活动栏 / 顶栏面板菜单一致。
  const panelCatalog = useMemo<PanelEntry[]>(() => {
    const byKey = new Map<string, PanelEntry>();
    for (const b of builtinPanels) {
      if (b) byKey.set(b.key, { key: b.key, label: b.label ?? b.key, modes: b.modes, order: b.order });
    }
    for (const p of projectPanels) {
      if (p && !byKey.has(p.key)) {
        byKey.set(p.key, { key: p.key, label: p.label ?? p.key, modes: p.modes, order: p.order });
      }
    }
    return filterByProjectMode(Array.from(byKey.values()), projectMode);
  }, [builtinPanels, projectPanels, projectMode]);

  // 面板标题：注册表 label；未注册（模块仍在加载）⇒ 回落 key 本身，标签仍然可关
  const panelLabelOf = useCallback(
    (key: string): string => panelCatalog.find((p) => p.key === key)?.label ?? key,
    [panelCatalog],
  );

  /** 每个已打开面板一条标签，顺序 = 打开顺序（`panelOpenStore.keys`）。 */
  const dynamicTabs = useMemo<DocTab[]>(
    () =>
      openPanelKeys.map((k) => ({
        id: DYNAMIC_TAB_PREFIX + k,
        kind: 'panel' as const,
        panelKey: k,
        title: panelLabelOf(k),
      })),
    [openPanelKeys, panelLabelOf],
  );

  /**
   * 实际渲染的标签 = 基础标签（`store.baseOpen` 为真时，恒排第 1 格）+ 功能面板标签。
   * ★ 2026-10-11：基础标签也计入总上限（由 store 在打开面板时裁剪保证），且可被 × 关闭。
   *
   * ★ 2026-10-25 分屏：多组时按「聚焦组」过滤。
   * ★ 2026-10-26 修正（用户反馈「分屏后章节正文不见了」）：改为**列出所有栏的标签**，
   *   非聚焦栏的标签加一个栏位角标（①②…）。理由：分屏的目的是同时看两样，
   *   把另一半标签藏起来会让用户以为它被关掉了。单栏（split=false 或缺省）行为不变。
   */
  const tabs = useMemo<DocTab[]>(() => {
    const scoped = groupScope?.split === true;
    const perGroup = groupScope?.groups;
    if (!scoped || !perGroup || perGroup.length === 0) {
      // 单栏 / 无分组信息：旧行为，逐字节不变
      return baseOpen ? [{ ...DOC_BASE_TAB }, ...dynamicTabs] : dynamicTabs;
    }
    // 多栏：按栏序（左→右）拼出全部标签；同一面板只出现一次（防 dockview 瞬时重复）
    const seen = new Set<string>();
    const out: DocTab[] = [];
    perGroup.forEach((g, gi) => {
      if (g.hasBase && baseOpen && !seen.has(DOC_BASE_TAB.id)) {
        seen.add(DOC_BASE_TAB.id);
        out.push({ ...DOC_BASE_TAB, groupIndex: gi + 1, groupActive: g.active });
      }
      for (const key of g.panelKeys) {
        if (seen.has(key)) continue;
        const t = dynamicTabs.find((x) => x.panelKey === key);
        if (!t) continue;
        seen.add(key);
        out.push({ ...t, groupIndex: gi + 1, groupActive: g.active });
      }
    });
    // 兜底：分组信息里没覆盖到的已打开面板（极少数瞬时态）仍列出，别让标签凭空消失
    for (const t of dynamicTabs) {
      if (t.panelKey && !seen.has(t.panelKey)) out.push(t);
    }
    return out;
  }, [baseOpen, dynamicTabs, groupScope]);

  const labelOf = useCallback(
    (t: DocTab): string => {
      if (t.kind === 'chapter') return chapterTitle ?? t.title;
      if (t.panelKey === 'outline') return '大纲 · ' + (outlineTitle ?? '卷一');
      return t.title;
    },
    [chapterTitle, outlineTitle],
  );

  /** 当前聚焦标签的 dockview 面板 key（「分屏」按钮用它决定拆谁）。 */
  const activeTabKey = useMemo<string | null>(() => {
    const t = tabs.find((x) => x.id === state.activeId);
    if (!t) return null;
    return t.kind === 'chapter' ? BASE_TAB_KEY : (t.panelKey ?? null);
  }, [tabs, state.activeId]);

  // ---- ★ 2026-10-25 拖拽分屏：标签是拖拽抓手 ----
  //
  // ⚠️ 为什么用 pointer 事件而不是 HTML5 `draggable`（实测教训，勿改回）：
  //   标签主体是 `<button class="shell-doctab-main">`，Chrome 对 `<button>` 内的
  //   mousedown **不会发起祖先元素的 HTML5 拖拽** —— 只有左右各 5px 的 padding 能拖到，
  //   中间 50px 的文字区拖不动。`dispatchEvent(dragstart)` 的模拟测试能过，真实鼠标必失败。
  //   故改用 `pointerdown` + 移动阈值（4px）自建拖拽，`<button>` 拦不住。
  //   阈值保证「单击标签 = 聚焦面板」的既有语义不变。
  const dragEnabled = typeof onSplitRequest === 'function';

  const onTabPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, tab: DocTab) => {
      if (!dragEnabled) return;
      // 只认主键（左键 / 触摸）
      if (e.button !== 0) return;
      // × 按钮上不发起拖拽
      if ((e.target as HTMLElement).closest?.('.shell-doctab-close')) return;
      const key = tab.kind === 'chapter' ? BASE_TAB_KEY : tab.panelKey;
      if (!key) return;
      beginSplitDrag(key, e.clientX, e.clientY);
    },
    [dragEnabled],
  );

  // ---- ★ 2026-10-25 右键菜单（分屏 / 取消分屏 / 关闭）----
  // 拖拽在触屏 / 无鼠标环境不可用，右键菜单是等价入口。
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);

  const openTabMenu = useCallback(
    (e: React.MouseEvent, tab: DocTab) => {
      if (!dragEnabled) return; // 未启用分屏能力（单测 / 纯只读场景）时不劫持右键
      e.preventDefault();
      const key = tab.kind === 'chapter' ? BASE_TAB_KEY : tab.panelKey;
      if (!key) return;
      setTabMenu({ key, label: labelOf(tab), top: e.clientY, left: e.clientX });
    },
    [dragEnabled, labelOf],
  );

  // 点外部 / Esc 关右键菜单（与「+」菜单同款处理）
  useEffect(() => {
    if (!tabMenu) return;
    const onDown = (ev: MouseEvent) => {
      const el = ev.target as Node;
      if ((el as HTMLElement).closest?.('.shell-doctab-ctx')) return;
      setTabMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setTabMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [tabMenu]);

  /**
   * ★ 2026-10-28 VS Code 对齐：**激活标签自动滚入视野**。
   *
   * 为什么需要：标签条是 `overflow-x:auto`（可横向滚动），上限提到 5 个功能面板 +
   * 正文 = 最多 6 个标签后，很容易溢出。而激活一个**看不见的**标签（活动栏点开、
   * 命令式 open、Ctrl+N 切换）时，若不滚过去，用户会以为"点了没反应" ——
   * 这正是 VS Code 里 `revealActive` 那条逻辑在做的事。
   *
   * 实现要点：
   *   · 用 `scrollIntoView({ block:'nearest', inline:'nearest' })` 而不是手算偏移：
   *     前者对 RTL / 变宽标签 / 缩放都成立，且 `nearest` 保证"已经可见就不动"
   *     （避免每次切换都把标签条抖一下）。
   *   · 只在 `activeId` 变化时跑，不在每次 render 跑。
   */
  useEffect(() => {
    const list = listRef.current;
    const id = state.activeId;
    if (!list || !id) return;
    const el = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
    // ⚠️ 能力检测：jsdom（单测）与部分老环境**没有实现** scrollIntoView，
    //   直接调用会抛 TypeError 打红整组测试。这里不是"静默失败"——
    //   该 API 只在浏览器里有视觉意义，缺失时什么也不做是正确语义。
    if (typeof el?.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [state.activeId]);

  /**
   * ★ 2026-10-28：检测标签条**是否溢出**（决定「▾」按钮出不出）。
   * 用 `scrollWidth > clientWidth + 1`（+1 吸收亚像素取整），在 ResizeObserver
   * 与标签数量变化时重测 —— 窗口缩放、分屏、开关标签都会改变可用宽度。
   */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const next = list.scrollWidth > list.clientWidth + 1;
      setOverflowing((prev) => (prev === next ? prev : next));
    };
    measure();
    // ⚠️ 能力检测：jsdom 无 ResizeObserver。缺失时退化为"只在 resize / 标签数变化时测"，
    //   真实浏览器不受影响（有 RO 才能感知"面板被侧栏挤窄"这类非窗口事件）。
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(list);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [tabs.length]);

  /** 摆放溢出菜单（右对齐按钮右缘，下方 4px，夹在视口内） */
  const placeOverflowMenu = useCallback(() => {
    const btn = overflowBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setOverflowMenu({
      top: Math.round(r.bottom + 4),
      right: Math.round(Math.max(4, window.innerWidth - r.right)),
    });
  }, []);

  // 点外部 / Esc 关掉溢出菜单（与「+」菜单同款）
  useEffect(() => {
    if (!overflowMenu) return;
    const onDown = (ev: MouseEvent) => {
      const el = ev.target as Node;
      if ((el as HTMLElement).closest?.('.shell-doctab-overflow-menu')) return;
      if (overflowBtnRef.current?.contains(el as Node)) return;
      setOverflowMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOverflowMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [overflowMenu]);

  // ---- 打开 / 激活 ----
  /**
   * 打开 / 聚焦一个标签。
   *
   * ★ 2026-10-28 VS Code 对齐：
   *   · **单击**（`pin` 缺省）= 以**预览**方式打开 —— 复用同一个预览位，
   *     浏览一圈面板不会把 5 个名额耗尽；
   *   · **双击**（`pin: true`）= 转正为固定标签。
   *   · 已打开的标签点一下 = 聚焦 + 转正（VS Code 里点已打开的预览标签也会固定它）。
   * 基础标签（章节正文）不参与预览语义 —— 它是文档本身，没有"预览态"。
   */
  const openTab = useCallback((tab: DocTab, opts?: { pin?: boolean }) => {
    setState((s) => (s.activeId === tab.id ? s : { ...s, activeId: tab.id }));
    setMenuPos(null);
    const wantPin = opts?.pin === true;
    // 真实动作（标签集合由 store 推导，这里只切激活态 + 触发打开）：
    //  · 基础标签（章节正文）= 中心编辑区本身，不是业务面板 ⇒ store 置 baseOpen + 切回中心组；
    //  · 功能面板标签 ⇒ 打开/聚焦真实面板（未 ready 时静默排队、ready 后回放）。
    if (tab.kind === 'chapter') {
      usePanelOpenStore.getState().openBase();
      focusDocBase();
    } else if (tab.panelKey) {
      const nav = getPanelNavigation();
      const store = usePanelOpenStore.getState();
      const alreadyOpen = store.keys.includes(tab.panelKey);
      if (wantPin) {
        // 双击 / 显式固定：走 open（会转正），再确保 previewKey 清掉
        nav.open(tab.panelKey);
        store.pinPreview(tab.panelKey);
      } else if (alreadyOpen) {
        // 点已打开的标签 = 聚焦（并把它从预览转正 —— 用户主动点它了）
        nav.open(tab.panelKey);
      } else {
        // 单击未打开的面板 = 预览打开
        nav.openPreview(tab.panelKey);
      }
    }
    // ★ 2026-10-26 分屏：点**非聚焦栏**的标签时，除了打开该面板，还要把焦点切到它所在的栏
    //   （否则视口还停在另一栏，用户会觉得"点了没反应"）。由 DockShell 注入的回调完成。
    if (tab.groupIndex !== undefined && tab.groupActive === false) {
      onFocusGroupRequest?.(tab);
    }
  }, [onFocusGroupRequest]);

  // ---- 关闭（切到相邻标签；关到 0 个不崩） ----
  const closeTab = useCallback(
    (id: string) => {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const closed = tabs[idx];
      if (!closed) return;
      // 关掉它代表的真实对象（标签随之从 store 推导中消失）：
      //  · 基础标签 ⇒ store.closeBase()（中心文档标签退场，可经「+」菜单恢复）
      //  · 功能面板 ⇒ getPanelNavigation().close(key)
      if (closed.kind === 'chapter') usePanelOpenStore.getState().closeBase();
      else if (closed.kind === 'panel' && closed.panelKey) getPanelNavigation().close(closed.panelKey);
      const remaining = tabs.filter((t) => t.id !== id);
      // 右邻优先（同 index），越界取左邻；remaining 为空时 `undefined` ⇒ activeId = null
      const neighbor = remaining[Math.min(idx, remaining.length - 1)];
      setState((s) => (s.activeId === id ? { activeId: neighbor?.id ?? null } : s));
    },
    [tabs],
  );

  // 面板被聚焦（点活动栏 / 命令式 open / 在面板里操作）⇒ 对应标签跟着激活，
  // 让「刚点开的那一项」在栏里立刻是当前项（而不是仍停在「章节正文」）。
  useEffect(() => {
    if (!focusedPanelKey) return;
    const hit = tabs.find((t) => t.kind === 'panel' && t.panelKey === focusedPanelKey);
    if (!hit) return;
    setState((s) => (s.activeId === hit.id ? s : { ...s, activeId: hit.id }));
  }, [focusedPanelKey, tabs]);

  // 标签在别处消失（活动栏收起 / 上限淘汰 / 基础标签被关）⇒ 若当时的激活项正是它，
  // 落回第一个标签，避免出现「标签区没有激活项」的空档。
  useEffect(() => {
    setState((s) => {
      if (!s.activeId) return s;
      if (tabs.some((t) => t.id === s.activeId)) return s;
      return { activeId: tabs[0]?.id ?? null };
    });
  }, [tabs]);

  // ---- 「+」菜单：点外部 / Esc 关闭；视口或任意祖先滚动时重算位置 ----
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // 菜单已 portal 到 body，不在 rootRef 里，需单独判归属
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuPos(null);
    };
    const onReflow = () => placeMenu();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [menuOpen, placeMenu]);

  return (
    <div className="shell-doctabs" ref={rootRef} role="group" aria-label="文档标签">
      <div className="shell-doctabs-list" ref={listRef}>
        {tabs.map((t) => {
          const active = t.id === state.activeId;
          const label = labelOf(t);
          // ★ 分屏角标：只在分屏时出现（groupIndex 有值）；标出这个标签在第几栏
          const showGroupBadge = t.groupIndex !== undefined;
          // ★ 2026-10-28 VS Code 对齐：这一格是不是「预览标签」（斜体显示）
          const isPreviewTab =
            t.kind === 'panel' && t.panelKey !== undefined && t.panelKey === previewKey;
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              className={
                active
                  ? (isPreviewTab ? 'shell-doctab is-active is-preview' : 'shell-doctab is-active')
                  : (isPreviewTab ? 'shell-doctab is-preview' : 'shell-doctab')
              }
              data-preview={isPreviewTab ? 'true' : undefined}
              data-group-index={showGroupBadge ? t.groupIndex : undefined}
              onPointerDown={(e) => onTabPointerDown(e, t)}
              onContextMenu={(e) => openTabMenu(e, t)}
              title={
                showGroupBadge
                  ? `${label} · 第 ${t.groupIndex} 栏${t.groupActive ? '（当前聚焦）' : '（点击切到该栏）'}`
                  : isPreviewTab
                    ? `${label}（预览 · 双击固定，或开始编辑它）`
                    : dragEnabled ? `${label}（按住拖到编辑区左右边缘可分屏）` : label
              }
            >
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                className="shell-doctab-main"
                title={label}
                onClick={() => openTab(t)}
                onDoubleClick={() => openTab(t, { pin: true })}
              >
                {showGroupBadge ? (
                  <span
                    className={t.groupActive ? 'shell-doctab-group-badge is-active' : 'shell-doctab-group-badge'}
                    aria-hidden="true"
                  >
                    {t.groupIndex}
                  </span>
                ) : null}
                <span className="shell-doctab-label">{label}</span>
              </button>
              <button
                type="button"
                className="shell-doctab-close"
                aria-label={'关闭 ' + label}
                title="关闭"
                onClick={() => closeTab(t.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="shell-doctabs-actions">
        {/*
          ★ 2026-10-28 VS Code 对齐：**溢出时把所有已打开标签列出来**。
          标签条横向可滚，但滚动条被隐藏（`scrollbar-width:none`）——
          标签一多，用户既看不到"还有几个"，也没法快速跳到被挤到视野外的那个。
          VS Code 的做法是右上角一个「▾ 打开项列表」。这里同款：
          只在**确实溢出**时出现（标签少时不占位置），点开列出全部 + 当前激活打勾。
        */}
        {overflowing ? (
          <button
            type="button"
            ref={overflowBtnRef}
            className="shell-doctab-overflow"
            title={`列出全部 ${tabs.length} 个已打开的标签`}
            aria-label="列出全部已打开的标签"
            aria-haspopup="menu"
            aria-expanded={overflowMenu !== null}
            onClick={() => (overflowMenu ? setOverflowMenu(null) : placeOverflowMenu())}
          >
            <ChevronDown size={13} aria-hidden="true" />
            <span className="mc-num">{tabs.length}</span>
          </button>
        ) : null}

        {/* ★ 2026-10-26：显式「分屏」入口 —— 把当前聚焦的标签拆到右侧。
            此前只有「拖标签到边缘」和「标签右键菜单」两条路，用户找不到（实测反馈）。
            再点一次（已在分屏）则是「合并分屏」，一个按钮两态，位置固定。 */}
        {splitActive && onUnsplitAll ? (
          <button
            type="button"
            className="shell-doctab-unsplit"
            title="合并所有分屏（回到单栏）"
            aria-label="合并所有分屏"
            onClick={onUnsplitAll}
          >
            合并分屏
          </button>
        ) : onSplitRequest && activeTabKey ? (
          <button
            type="button"
            className="shell-doctab-split"
            title="分屏：把当前标签拆到右侧，可同时查看两个面板"
            aria-label="分屏"
            onClick={() => onSplitRequest(activeTabKey, 'right')}
          >
            分屏
          </button>
        ) : null}
        <button
          type="button"
          className="shell-doctab-add"
          ref={addBtnRef}
          aria-label="打开文档标签"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="打开功能"
          onClick={() => (menuOpen ? setMenuPos(null) : placeMenu())}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
        {menuPos
          ? createPortal(
              <div
                ref={menuRef}
                className="shell-doctab-menu"
                role="menu"
                aria-label="打开功能"
                style={{ top: menuPos.top, right: menuPos.right }}
              >
                {/* 基础标签（正文）——被关掉后从这里恢复；点它 = 回到正文 */}
                <button
                  type="button"
                  role="menuitem"
                  aria-pressed={baseOpen}
                  className={baseOpen ? 'shell-doctab-menu-item is-open' : 'shell-doctab-menu-item'}
                  onClick={() => openTab(DOC_BASE_TAB)}
                >
                  {labelOf(DOC_BASE_TAB)}
                </button>
                <div className="shell-doctab-menu-sep" aria-hidden="true" />
                {/* 功能面板候选池：点击 = 打开（已打开 ⇒ 聚焦，不重复开） */}
                {panelCatalog.map((p) => {
                  const isOpen = openPanelKeys.includes(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      role="menuitem"
                      aria-pressed={isOpen}
                      title={isOpen ? `${p.label}（已打开，点击聚焦）` : p.label}
                      className={isOpen ? 'shell-doctab-menu-item is-open' : 'shell-doctab-menu-item'}
                      onClick={() =>
                        openTab({
                          id: DYNAMIC_TAB_PREFIX + p.key,
                          kind: 'panel',
                          panelKey: p.key,
                          title: p.label,
                        })
                      }
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>,
              document.body,
            )
          : null}
      </div>

      {/*
        ★ 2026-10-28 VS Code 对齐：**溢出标签列表**（点右上「▾ N」打开）。
        与「+」菜单 / 右键菜单同款 —— portal 到 body，避开 `.shell-doctabs{overflow:hidden}` 的裁剪。
        列出**全部**已打开标签（不只溢出的那些）：VS Code 的 open editors 列表也是这样，
        因为用户的诉求是"一眼看到我打开了什么、快速跳过去"。
      */}
      {overflowMenu
        ? createPortal(
            <div
              className="shell-doctab-menu shell-doctab-overflow-menu"
              role="menu"
              aria-label="已打开的标签"
              style={{ top: overflowMenu.top, right: overflowMenu.right }}
            >
              <div className="shell-doctab-overflow-title">
                已打开 {tabs.length} 个
              </div>
              {tabs.map((t) => {
                const isActive = t.id === state.activeId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={
                      isActive
                        ? 'shell-doctab-menu-item shell-doctab-overflow-item is-active'
                        : 'shell-doctab-menu-item shell-doctab-overflow-item'
                    }
                    title={labelOf(t)}
                    onClick={() => {
                      openTab(t);
                      setOverflowMenu(null);
                    }}
                  >
                    <span className="shell-doctab-overflow-check" aria-hidden="true">
                      {isActive ? '✓' : ''}
                    </span>
                    <span className="shell-doctab-overflow-label">{labelOf(t)}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}

      {/* ★ 2026-10-25 标签右键菜单：拖拽的等价入口（触屏 / 无鼠标可用） */}
      {tabMenu
        ? createPortal(
            <div
              className="shell-doctab-menu shell-doctab-ctx"
              role="menu"
              aria-label={`${tabMenu.label} 操作`}
              style={{ top: tabMenu.top, left: tabMenu.left }}
            >
              <button
                type="button"
                role="menuitem"
                className="shell-doctab-menu-item"
                onClick={() => {
                  onSplitRequest?.(tabMenu.key, 'right');
                  setTabMenu(null);
                }}
              >
                向右分屏
              </button>
              <button
                type="button"
                role="menuitem"
                className="shell-doctab-menu-item"
                onClick={() => {
                  onSplitRequest?.(tabMenu.key, 'left');
                  setTabMenu(null);
                }}
              >
                向左分屏
              </button>
              {splitActive && onUnsplitRequest ? (
                <>
                  <div className="shell-doctab-menu-sep" aria-hidden="true" />
                  <button
                    type="button"
                    role="menuitem"
                    className="shell-doctab-menu-item"
                    onClick={() => {
                      onUnsplitRequest(tabMenu.key);
                      setTabMenu(null);
                    }}
                  >
                    取消分屏
                  </button>
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
