// ============================================================
// 面板导航状态 —— 停靠系统（dockview）下的「打开 / 聚焦 / 关闭」唯一真源
//
// 契约真源：docs/architecture/dock-protocol-adr.md
//   §2.3.1  PanelNavigation 接口 + getPanelNavigation() 命令式单例（冻结）
//   §2.3.2  'nm:open-panel' 事件桥迁移（保留监听、回调体改调命令式入口、排队回放）
//   §4.2    MAX_OPEN_PANELS **删除**：无限打开，容量由 dockview 布局承担（**已被 §4.4 修订**）
//   §4.3    迁移动作清单（1–5）
//   §4.4    ★ 2026-10-07 修订（用户口径 m01407）：上限**回归 3**，超限淘汰
//           「最久没用过」的面板（LRU），且淘汰**必须可见**（toast）。
//           §4.2 否决的是「静默挤掉第一个」里的**静默**，不是上限本身 ——
//           故 §4.4 保留上限、换掉淘汰依据、补上提示。
//
// ## 双入口（ADR §2.3.1 冻结理由）
//   · React 组件 → `usePanelOpenStore(selector)`（zustand hook，订阅式）
//   · 非 React   → `getPanelNavigation()`（命令式单例）
//   'nm:open-panel' 的 5 个派发点**全部**在非 React 上下文（插件 apply(ctx) 的 run
//   回调、Tiptap 扩展工厂、DOM 事件回调），只暴露 hook 会逼它们再发明一套事件，
//   故命令式入口是硬需求。
//
// ## 与 DockShell 的关系（ADR §2.4）
//   `PanelNavigation`（store 层，稳定，插件可见）
//     → 内部转发到 `DockShellApi`（视图层，dockview 绑定）
//
//   DockShell 未挂载时（例如书架页、或在插件 apply(ctx) 阶段调用），
//   `open()` **必须静默排队**、不得抛错，挂载后回放。
//
// ## 上限 3（2026-10-07 用户口径，ADR §4.4）
//   最多同时打开 `MAX_OPEN_PANELS = 5` 个面板；打开第 6 个时淘汰**最久没用过**
//   的那一个（LRU：以「被打开 / 被聚焦」的时间为准，见 `touchRecency`）。
//   `opened()` 仍返回**打开顺序**（DockShell 首次构建布局的输入，顺序本身不再决定淘汰）。
//   与旧行为的两点区别，都是为了避免「做了但用户不知道」：
//     · 淘汰依据是**最近使用**而非最早打开 —— 挤掉的永远是你最近没在看的那个；
//     · 淘汰时抛一条 info toast（`notifyEviction`），用户知道面板去哪了。
//
// ## 持久化（2026-10-11 用户口径「AI 对话的窗口还是固定的……让他和其他的功能一样
//    可以动态关闭」）
//   打开集合落 localStorage（`STORAGE_KEY`），进项目时**恢复**而非重播默认种子 ——
//   于是「章节 / AI 对话」两栏关掉后刷新不再自己回来，与其余面板行为一致。
//   详见文件中部「持久化」小节（含 `persistArmed` 落盘闸门）。
// ============================================================

import { create } from 'zustand';

import { dispatchToastEvent } from '@/utils/errors';

/**
 * 打开状态的形状。
 *
 * `keys` 与 `activeKey` **分离**（ADR §4.3-4）：
 * 在 dockview 里「一个面板被打开」与「一个面板被聚焦」是两个独立维度 ——
 * 多标签堆叠时可以有 N 个打开但只有 1 个聚焦。
 */
export interface PanelOpenState {
  /** 已打开的 key（按打开顺序；**上限 `MAX_OPEN_PANELS`**，超限淘汰最久未用者，ADR §4.4） */
  keys: string[];
  /** 当前聚焦（dockview active panel）的 key；无则 null */
  activeKey: string | null;
  /**
   * ★ 2026-10-28 VS Code 对齐：**当前唯一的「预览标签」key**（null = 没有预览）。
   *
   * 语义（与 VS Code 同款）：
   *   · 单击打开 = 预览 —— 斜体标签，**占同一格**；再单击别的面板就把它**替换**掉，
   *     不会越开越多（浏览不污染标签栏）；
   *   · 双击 / 主动"固定" = 转正 —— 从 `previewKey` 里移除，变成普通固定标签；
   *   · 预览标签也计入 `keys`（它是一个真实打开的面板），也参与 LRU 淘汰。
   * 全局只有一个预览槽位（不是每个面板各记一份），这正是 VS Code 的行为。
   */
  previewKey: string | null;
  /**
   * ★ 2026-10-11：「章节正文」基础标签是否打开（默认 true）。
   * 它代表中心编辑区本身（不是业务面板），故不进 `keys`；但**计入总标签上限** ——
   * 见 `MAX_OPEN_PANELS` 上方注释。关闭它 = 关掉中心文档标签（可从「+」菜单恢复）。
   */
  baseOpen: boolean;
  /** 打开或聚焦面板。已打开 ⇒ 只聚焦（不新增、不重排）；未打开 ⇒ 打开并按上限淘汰 */
  open: (key: string) => void;
  /**
   * ★ 2026-10-28 VS Code 对齐：**以「预览」方式打开**（单击标签 / 单击活动栏）。
   *
   * 与 `open` 的唯一区别：若当前已有预览标签且不是这一个，**先把旧的预览关掉**
   * 再打开新的 —— 于是"浏览一圈面板"永远只占一个位，不会把 5 个名额耗尽。
   * 其余语义（上限、LRU、activeKey）与 `open` 完全一致。
   */
  openPreview: (key: string) => void;
  /** ★ 2026-10-28：把预览标签**转正**（双击 / 编辑内容 / 主动固定） */
  pinPreview: (key?: string) => void;
  /** 已打开则聚焦，未打开则打开。语义等同 `open`（保留旧名仅为对称，ADR §2.3.1） */
  focus: (key: string) => void;
  /** 切换：未打开 → 打开（同样受上限约束）；已打开 → 关闭 */
  toggle: (key: string) => void;
  /** 关闭。不存在则 no-op */
  close: (key: string) => void;
  /** 关闭全部；`opts.except` 内的 key 保留 */
  closeAll: (opts?: { except?: string[] }) => void;
  /** 当前已打开 key（打开顺序） */
  opened: () => string[];
  /** 当前聚焦 key，无则 null */
  active: () => string | null;
  /**
   * 聚焦态由**视图层**（DockShell / dockview）回写。
   * 不是公开契约的一部分，命名带 `_` 前缀与其它内部操作一致。
   */
  _setActive: (key: string | null) => void;
  /**
   * 视图层（DockShell 的用户交互：点标签 × 、拖走、关闭组）回写打开集合。
   * activeKey 只在它仍存在于新集合中时保留；集合超出上限时同样按 LRU 淘汰。
   */
  _syncFromView: (keys: string[]) => void;
  /** ★ 2026-10-11：打开「章节正文」基础标签（从「+」菜单恢复；幂等）。 */
  openBase: () => void;
  /** ★ 2026-10-11：关闭「章节正文」基础标签（标签上的 ×）。 */
  closeBase: () => void;
}

// ---- 视图层桥接（模块级单例；不放进 store state，避免每次渲染换引用） ----

/** 视图层「打开/聚焦」执行器：由 DockShell 挂载时注册，卸载时注销。 */
let viewOpen: ((key: string) => void) | null = null;

/**
 * 视图层「整集合覆写」执行器（关闭 / closeAll 这类**减少**操作无法表示为
 * 单个 open 调用，只能把闭包结果推过去）。
 */
let viewSync: ((keys: string[]) => void) | null = null;

/**
 * ★ 2026-10-11 单列布局：「聚焦基础标签（章节正文）」执行器。
 *
 * 基础标签「章节正文」代表中心编辑区本身（`CENTER_DEFAULT_PANEL_ID`），**不是**一个
 * 业务面板 —— 它不在 `panelOpenStore.keys` 里，故无法经 `open()` 表达。单列布局下
 * 点它必须把中心组切回承载章节编辑器的那个面板，否则正文出不来（点击无反应）。
 * DockShell 挂载时注册、卸载时注销；未挂载时静默（无面板可聚焦）。
 */
let viewBase: (() => void) | null = null;

/** DockShell 未挂载期间收到的打开请求（静默排队，ADR §2.4） */
const pendingOpens: string[] = [];

/** 同一 key 重复排队只保留一次，且保持首次排队顺序 */
function enqueueOpen(key: string): void {
  if (!pendingOpens.includes(key)) pendingOpens.push(key);
}

/**
 * §2.4 冻结：DockShell 挂载时注册执行器 → 立刻**回放**排队请求
 * （插件 `apply(ctx)` 里调 `open()` 时 shell 还没挂上，不能丢）。
 */
export function registerPanelViewOpener(fn: (key: string) => void): () => void {
  viewOpen = fn;
  if (pendingOpens.length) {
    const replay = pendingOpens.splice(0, pendingOpens.length);
    for (const k of replay) fn(k);
  }
  return () => {
    if (viewOpen === fn) viewOpen = null;
  };
}

/**
 * 当前是否已挂载视图层。
 * 诊断 / 测试用；产品代码读它没用（排队是透明的）。
 */
export function hasPanelView(): boolean {
  return viewOpen !== null;
}

/** 未回放的排队请求（只读快照，测试用） */
export function pendingPanelOpens(): readonly string[] {
  return pendingOpens;
}

/** 打开**或聚焦**：视图层可用就直接执行，否则排队 */
function openOrFocus(key: string): void {
  if (viewOpen) viewOpen(key);
  else enqueueOpen(key);
}

/** 关闭 / 批量关闭：视图层可用就推集合；缺席时 store 已是真源，下次挂载自然对齐 */
function pushKeysToView(): void {
  viewSync?.(usePanelOpenStore.getState().keys);
}

/** DockShell 注册「集合同步」回调（关闭路径用；打开路径走 openOrFocus）。 */
export function registerPanelViewSync(fn: ((keys: string[]) => void) | null): void {
  viewSync = fn;
}

/** DockShell 注册「聚焦基础标签」回调（点「章节正文」时切回中心编辑区）。 */
export function registerPanelViewBase(fn: (() => void) | null): () => void {
  viewBase = fn;
  return () => {
    if (viewBase === fn) viewBase = null;
  };
}

/**
 * 命令式「聚焦基础标签（章节正文）」：把中心组切回章节编辑器出口。
 * 视图层缺席时静默（无面板可聚焦）。
 */
export function focusDocBase(): void {
  viewBase?.();
}

// ---- ★ 2026-10-07 修订：打开数量上限（ADR §4.4） ---------------------------

/**
 * 同时打开的**功能面板**数量上限（★ 2026-10-27 口径变更：3 → 5）。
 *
 * ★ 口径：**5 个功能面板**，**不含**「章节正文」基础标签。
 *   正文是文档本身（不是功能面板），开着它不占名额 —— 于是正文 + 5 个面板
 *   = 屏幕上一共 6 个标签。这是作者明确的口径（"5 个功能面板 + 正文"）。
 *
 * 历史沿革（勿凭直觉改回去）：
 *   · 旧实现 `MAX_OPEN_PANELS = 3` 曾在 ADR §4.2（D10）被**删除**，理由是
 *     「打开第 4 个时静默挤掉第 1 个」让用户不知道面板去哪了；
 *   · 2026-10-07 上限回归（LRU 淘汰 + toast 可见）；
 *   · 2026-10-11 口径改为「总标签数 ≤ 3（含正文）」；
 *   · **2026-10-27 改为「功能面板 ≤ 5（不含正文）」** —— 对齐 VS Code 的
 *     "多页同时打开"手感（标签条本就支持横向滚动，历史上限的前提已不存在）。
 */
export const MAX_OPEN_PANELS = 5;

/**
 * ★ 2026-10-11 用户口径（「打开的页面是叠加的可以打开页面，最多打开三个页面」+
 *   「正文也当动态标签」）：
 *
 * 「章节正文」是文档标签栏的**第 1 格动态标签** —— 可关闭，但**不占功能面板名额**。
 * 它代表中心编辑区本身（DockShell 的 `CENTER_DEFAULT_PANEL_ID`），**不是**业务面板，
 * 故用这个保留 key 表达，存在 `PanelOpenState.baseOpen` 里（不进 `keys`）。
 *
 * ★ 2026-10-27 口径 = **功能面板数** ≤ `MAX_OPEN_PANELS`（= 5），不随正文开关变化。
 *   正文开着时屏幕上一共 6 个标签（1 正文 + 5 面板），关掉正文则 5 个。
 *   基础标签**不参与 LRU 淘汰**（它是文档本身，被自动收起会很突兀；用户可用 × 手动关）。
 */
export const BASE_TAB_KEY = 'doc:chapter';

/**
 * 「最近使用」顺序（最近用过的在前）。只记 key、不含时间戳 —— 只需要相对顺序。
 *
 * 更新时机 = 面板被**打开**或被**聚焦**（`_setActive`）：点活动栏、点标签、
 * 命令式 `open()` 都算「用过」。长度上限只是防御性裁剪，避免长会话无界增长。
 */
const recency: string[] = [];
const RECENCY_CAP = 64;

function touchRecency(key: string): void {
  const i = recency.indexOf(key);
  if (i !== -1) recency.splice(i, 1);
  recency.unshift(key);
  if (recency.length > RECENCY_CAP) recency.length = RECENCY_CAP;
}

/**
 * 越久没用过排名越大。
 *
 * **从未被 touch 过的 key 视为最新（`-1`）**，不是最旧：出现「store 没记过」
 * 的 key，只可能是活动栏 / 插件走 `DockShellApi.openPanel` 直接 `addPanel`，
 * 视图刚把它生出来、`_syncFromView` 才第一次见到它。若把它当最旧，裁剪会
 * 立刻淘汰**刚打开的那个**（表现为「点第 4 个按钮，它自己关了」）。
 * 宁可淘汰一个已知最旧者，也不要误杀刚打开的。
 */
function ageRank(key: string): number {
  return recency.indexOf(key);
}

/**
 * 把打开集合裁到**功能面板允许数**，返回**新集合**与**被淘汰者**。
 * 淘汰顺序：最久没用过 → 次久没用过 …；集合自身顺序（= 打开顺序）保持不变。
 *
 * ★ 2026-10-27：口径改为「**功能面板** ≤ `MAX_OPEN_PANELS`」，**不再受 `baseOpen` 影响**。
 *   正文标签开着与否都不占名额（它不属于 `keys`，只是 `baseOpen` 布尔）。
 *   故这里不再需要 `baseOpen` 参与计算 —— 保留参数只为兼容既有调用点。
 */
function limitOpenKeys(keys: string[], _baseOpen = false): { keys: string[]; evicted: string[] } {
  const max = MAX_OPEN_PANELS;
  if (keys.length <= max) return { keys, evicted: [] };
  const byAge = keys.slice().sort((a, b) => ageRank(b) - ageRank(a));
  const evicted = byAge.slice(0, keys.length - max);
  return { keys: keys.filter((k) => !evicted.includes(k)), evicted };
}

/**
 * 淘汰提示 —— **可见**是这次修订的一半意义（ADR §4.4），故直接抛 toast。
 *
 * 为什么在数据层抛：这是 `window` 级 CustomEvent（`novelmuse:toast-notify`）广播，
 * 与 store 现有的 `viewOpen` / `viewSync` 桥一样是**非 React** 通道，不引入
 * React / react-router 依赖（对比本文件末尾「不在 store 里 navigate」的分层理由）。
 * `ToastProvider` 缺席时无人监听，天然退化为静默 —— 不抛错。
 *
 * 去抖：淘汰收敛（视图回写 → store 裁剪 → React 移除面板 → 视图再回写）可能在
 * 同一批淘汰上触发多次，600ms 内的重复上报只提示一次。
 */
let lastEvictNoticeAt = 0;

function notifyEviction(evicted: readonly string[]): void {
  if (evicted.length === 0 || typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastEvictNoticeAt < 600) return;
  lastEvictNoticeAt = now;
  dispatchToastEvent({
    type: 'info',
    message: `已收起最久未用的面板（最多同时打开 ${MAX_OPEN_PANELS} 个）`,
    duration: 2600,
  });
}

// ---- ★ t4 集成：首屏「默认打开集合」种子 -------------------------------------
//
// 为什么需要它（跨区契约，t1 DockShell ↔ t4 接线）：
//   DockShell 的 `dock.defaultOpen` 只在**非受控**模式生效（DockShell.tsx:291-295
//   `openKeys ? openKeys : panels.filter(d => resolveDockMeta(d).defaultOpen)`），
//   而 ProjectLayout.tsx:153 恒以受控 `openKeys={openPanelKeys}` 传入 —— 首屏
//   `keys: []` 会让目标截图里的三栏（章节树 + 正文 + AI 对话）全部缺席。
//   真值来源只能是这里（store 是打开集合的唯一真源），所以种子落在此文件。

/**
 * ★ t4 新增：各项目模式的**首屏默认打开集合**。
 * 只列「目标截图里一打开就该在位」的面板；其余面板仍由用户/命令式入口打开。
 * 条数必须 ≤ `MAX_OPEN_PANELS`，否则首屏就会被自己裁一刀。
 */
export const DEFAULT_OPEN_PANEL_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  manual: Object.freeze(['chapters', 'ai-chat']),
  auto: Object.freeze([]),
});

// ---- ★ 2026-10-11 持久化：打开集合跨刷新保留 -----------------------------
//
// 用户口径：「AI 对话的窗口还是固定的……让他和其他的功能一样可以动态关闭」。
//
// 现象根因：打开集合原先**每次进项目都重新播默认种子**（`DEFAULT_OPEN_PANEL_KEYS.manual`
// = 章节树 + AI 对话），于是用户把这两栏关掉后**一刷新就回来** —— 表现为它们「关不掉 /
// 固定」，与其余面板（默认不开、关了保持关）不一致。会话内其实点标签的 × 就能关，
// 但刷新即复原，用户感知就是「固定」。
//
// 修法：把打开集合落 localStorage，作为「用户上次的选择」：
//   · 有记录 ⇒ 原样恢复，**不再播默认种子**（关掉的面板保持关闭）；
//   · 无记录（首次使用）⇒ 播默认种子，并立刻落盘作为基线；
//   · 之后每次集合变化（打开 / 关闭 / 上限淘汰 / 视图回写）都同步落盘。
// 于是「章节树 / AI 对话」与「人物设定 / 时间线…」行为完全一致：关掉就是关掉。
//
// 口径：**应用级**（不分项目 / 模式）—— 与 VS Code 的「工作台布局」同语义，一个应用一套。
// 失败静默（隐私模式 / 配额满 / SSR 无 window 都不该影响交互）。
const STORAGE_KEY = 'novelmuse.panelOpen.v1';

/**
 * 读取持久化的打开集合。
 * @returns `{ keys, baseOpen }`；**`null` = 从未记录过**（首次使用，应播默认种子）。
 *
 * ★ 2026-10-11：持久化结构从裸 `string[]` 升级为 `{ keys, baseOpen }`（基础标签也
 *   可关 ⇒ 它开/关状态也要跨刷新保留）。为兼容旧记录，仍接受**裸数组**形态
 *   （视为 `{ keys: 数组, baseOpen: true }`—— 旧记录时代基础标签恒在）。
 */
function readPersistedKeys(): { keys: string[]; baseOpen: boolean } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    // 旧形态：裸数组
    if (Array.isArray(parsed)) {
      return { keys: parsed.filter((k): k is string => typeof k === 'string'), baseOpen: true };
    }
    if (parsed && typeof parsed === 'object') {
      const o = parsed as { keys?: unknown; baseOpen?: unknown };
      const keys = Array.isArray(o.keys)
        ? o.keys.filter((k): k is string => typeof k === 'string')
        : [];
      return { keys, baseOpen: o.baseOpen !== false };
    }
    return null;
  } catch {
    return null;
  }
}

/** 落盘（静默失败）。 */
function writePersisted(keys: readonly string[], baseOpen: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ keys, baseOpen }));
  } catch {
    /* 静默：持久化失败不该影响面板交互 */
  }
}

/** 去重并保持首次出现顺序。 */
function dedupeKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * 落盘闸门：只有**播种 / 恢复决策完成之后**才允许持久化。
 *
 * 为什么需要：DockShell 的 `onReady` 会先以「视图实际面板集合」（此刻往往是空）
 * 回写一次 `_syncFromView([])`，它可能**早于** ProjectLayout 的播种 effect 触发。
 * 若此时就落盘，会把「空集合」写成用户选择，随后播种读取到 `[]` 便不再播种子
 * （首屏三栏永久缺席）。闸门把这次早期回写挡在持久化之外。
 */
let persistArmed = false;

/** 本会话是否已经播过种（诊断 / 测试用） */
let seeded = false;

/**
 * ★ t4 集成：**尚未被视图确认**的种子 key。
 *
 * 为什么需要（冷启动实测踩到的真问题）：DockShell 在 `onReady` / `addPanel` /
 * `removePanel` 时用「视图实际面板集合」回写宿主（`emitOpenChange` → `onOpenChange`
 * → `_syncFromView`），而 `_syncFromView` 是**整集合覆写**。插件面板是异步注册的
 * （插件模块图较大 / 面板走 lazy 加载，其 `def` 晚到），于是冷启动会出现这样的交错：
 *
 *   1. 播种 → store.keys = ['chapters','ai-chat']
 *   2. 较早到位的一个 def 先被加进面板 → dockview **异步**派发 `onDidAddPanel`（微任务）
 *      （实测当时先到的是 ai-chat —— 它那时由 auto 模块注册、模块图更小）
 *   3. 微任务落地**之前**另一个 def（chapters）也到位了
 *   4. 微任务才执行 → 上报集合 = 视图实际 = ['ai-chat'] → store 丢掉 'chapters'
 *      → 受控 effect 之后只看到 ['ai-chat']，**左栏永久缺席**（实测 groups 只剩
 *      编辑区 + AI 对话，`openStore.keys=['ai-chat']`）
 *
 *   ※ 2026-10「手写/自动隔离改造」后两个槽都由 manual 模块注册（ai-chat 面板已移交
 *     手写台），「谁先到位」不再由跨模块时序决定，但整集合覆写的机制不变、修法照旧。
 *
 * 修法：宿主只把「视图确认过」的种子 key 视为已交付；未被确认的种子 key 在回写时
 * 合并回去（有窗口上限，避免 def 永不出现时留下幽灵 key）。视图一旦上报包含它，
 * 即确认交付，此后用户手动关闭能正常上报消失（不会再被拉开）。
 */
let seedUnconfirmed: string[] = [];
let seedDeadline = 0;

/** 种子合并窗口：足够覆盖插件异步注册 + 首次布局的抖动 */
const SEED_MERGE_WINDOW_MS = 15000;

export function hasSeededPanelOpenKeys(): boolean {
  return seeded;
}

/**
 * ★ t4 新增：幂等地把 `keys` 播进「已打开集合」并请求视图层打开。
 *
 * · 只播一次（`seeded`）：用户手动关掉面板后不再被重新拉开；
 * · 合并而非覆写已存 keys（deep-link / 插件提前 open 的请求不丢）；
 * · 视图层未挂载时 `openOrFocus` 走既有的 pendingOpens 队列，挂载后回放；
 * · 未被视图确认前由 `_syncFromView` 兜住（见 `seedUnconfirmed` 注释）。
 *
 * @returns 是否真的执行了播种（`false` = 已播过 / 无 key 可播）
 */
export function seedPanelOpenKeys(keys: readonly string[] | null | undefined): boolean {
  if (seeded) return false;
  seeded = true;
  // ★ 2026-10-11 持久化：优先恢复「用户上次的打开集合」——
  //   有记录就不再播默认种子（关掉的面板保持关闭）；无记录才播种子并落盘为基线。
  const persisted = readPersistedKeys();
  const initialKeys = persisted !== null ? persisted.keys : (keys ? Array.from(keys) : []);
  const baseOpen = persisted !== null ? persisted.baseOpen : true;
  // ★ 基础标签开/关也随持久化恢复（关掉后刷新不自己回来）
  usePanelOpenStore.setState({ baseOpen });
  if (initialKeys.length === 0) {
    // 用户明确关光了（persisted.keys === []），或本模式无默认种子（keys 为空）
    persistArmed = true;
    writePersisted([], baseOpen);
    return false;
  }
  const wanted = dedupeKeys(initialKeys);
  const opened = usePanelOpenStore.getState().keys;
  const missing = wanted.filter((k) => !opened.includes(k));
  seedUnconfirmed = wanted.slice();
  seedDeadline = Date.now() + SEED_MERGE_WINDOW_MS;
  // ★ §4.4：种子也进「最近使用」序列（按播种顺序 ⇒ 先播的排在最旧）
  for (const key of wanted) touchRecency(key);
  if (missing.length) {
    usePanelOpenStore.setState({ keys: opened.concat(missing) });
    for (const key of missing) openOrFocus(key);
  }
  // 恢复完成 ⇒ 开启落盘，并立刻写入一次（把首次使用的默认种子固化为基线）
  persistArmed = true;
  writePersisted(usePanelOpenStore.getState().keys, usePanelOpenStore.getState().baseOpen);
  return true;
}

export const usePanelOpenStore = create<PanelOpenState>((set, get) => ({
  keys: [],
  activeKey: null,
  previewKey: null,
  baseOpen: true,

  /**
   * ★ 2026-10-28：预览语义 = **替换掉旧的预览位**。
   *
   * 抽成内部函数（不进 state），因为 `open` / `openPreview` / `_syncFromView`
   * 都要用同一套规则，各写一遍必然漂移（本文件历史上就踩过类似的重复实现）。
   *
   * 返回「要打开的新集合」：调用方负责 set。
   */
  openPreview: (key) => {
    const state = get();
    // 点的是已经开着的面板：只聚焦 + **转正**（VS Code 里点已打开的预览标签也会固定它）
    if (state.keys.includes(key)) {
      touchRecency(key);
      set({ activeKey: key, previewKey: state.previewKey === key ? null : state.previewKey });
      return;
    }
    touchRecency(key);
    const prevPreview = state.previewKey;
    // 旧预览若还开着且不是本次目标 ⇒ 先踢掉，再把新的加进来（保证预览位唯一）
    const base = prevPreview && prevPreview !== key && state.keys.includes(prevPreview)
      ? state.keys.filter((k) => k !== prevPreview)
      : state.keys;
    const limited = limitOpenKeys(base.concat(key), state.baseOpen);
    notifyEviction(limited.evicted);
    set({ keys: limited.keys, activeKey: key, previewKey: key });
  },

  /** 预览转正：只清 previewKey（面板本身已在 keys 里，无需动集合） */
  pinPreview: (key) => {
    const state = get();
    const target = key ?? state.previewKey;
    if (!target || state.previewKey !== target) return;
    set({ previewKey: null });
  },

  // ADR §4.3-2 + §4.4：已打开 ⇒ 只更新焦点；否则 concat 后裁到上限（淘汰最久未用者）
  open: (key) => {
    touchRecency(key);
    const state = get();
    if (state.keys.includes(key)) {
      // ★ 2026-10-28：显式 open（活动栏双击 / 命令 / 快捷键）视为"我要它留下" ⇒ 转正
      set({ activeKey: key, previewKey: state.previewKey === key ? null : state.previewKey });
      return;
    }
    const limited = limitOpenKeys(state.keys.concat(key), state.baseOpen);
    notifyEviction(limited.evicted);
    // 显式 open ⇒ 不留预览位（若预览的是别的面板，也要一并清掉，避免悬空 previewKey）
    set({ keys: limited.keys, activeKey: key, previewKey: null });
  },

  // ADR §2.3.1：语义等同 open（保留旧名仅为对称）
  focus: (key) => get().open(key),

  // ADR §4.3-3 + §4.4：已存在 → 关闭；不存在 → concat 后裁到上限
  toggle: (key) => {
    const state = get();
    if (state.keys.includes(key)) {
      set({
        keys: state.keys.filter((k) => k !== key),
        activeKey: state.activeKey === key ? null : state.activeKey,
        // 关掉的正是预览标签 ⇒ 预览位一并清空
        previewKey: state.previewKey === key ? null : state.previewKey,
      });
      return;
    }
    touchRecency(key);
    const limited = limitOpenKeys(state.keys.concat(key), state.baseOpen);
    notifyEviction(limited.evicted);
    set({ keys: limited.keys, activeKey: key, previewKey: null });
  },

  close: (key) =>
    set((state) => ({
      keys: state.keys.filter((k) => k !== key),
      activeKey: state.activeKey === key ? null : state.activeKey,
      // ★ 2026-10-28：关掉的是预览标签 ⇒ 预览位一并清空（避免悬空 key）
      previewKey: state.previewKey === key ? null : state.previewKey,
    })),

  closeAll: (opts) =>
    set((state) => {
      const except = opts?.except;
      if (!except || except.length === 0) {
        return { keys: [], activeKey: null, previewKey: null };
      }
      const kept = state.keys.filter((k) => except.includes(k));
      return {
        keys: kept,
        activeKey: kept.includes(state.activeKey ?? '') ? state.activeKey : null,
        previewKey: state.previewKey && kept.includes(state.previewKey) ? state.previewKey : null,
      };
    }),

  opened: () => get().keys,
  active: () => get().activeKey,

  // ★ §4.4：被聚焦 = 被「看过」，是 LRU 的主信号
  _setActive: (key) => {
    if (key) touchRecency(key);
    set({ activeKey: key });
  },

  _syncFromView: (keys) => {
    // ★ t4 集成：把「视图尚未确认交付」的种子 key 合并回去（详见 seedUnconfirmed 注释）。
    //   确认 = 视图至少上报过一次包含该 key 的集合；确认后不再兜（用户关闭能被正常上报）。
    let next = keys;
    if (seedUnconfirmed.length) {
      const reported = new Set(keys);
      seedUnconfirmed = seedUnconfirmed.filter((k) => !reported.has(k));
      if (seedUnconfirmed.length && Date.now() < seedDeadline) {
        next = keys.concat(seedUnconfirmed.filter((k) => !reported.has(k)));
      } else if (Date.now() >= seedDeadline) {
        seedUnconfirmed = [];
      }
    }
    /**
     * ★ 2026-10-19 修复「已满 3 个标签时，点活动栏第 3 个面板图标**第一次点击被吞**」：
     *
     * 活动栏走的是 `DockShellApi.openPanel` —— 直接 `addPanel`，**不经过本 store 的
     * `open()`**，于是新面板的 `touchRecency` 只在它被激活（`_setActive`）时才发生，
     * 而那一刻可能**晚于**下面的裁剪。此时 `ageRank` 读到的是该 key 在本会话里
     * **更早那次打开**留下的陈旧位次（`recency` 是模块级、跨整个页面生命周期），
     * 于是「刚打开的这个」被判成最久没用过的，**当场被自己淘汰掉** ——
     * 表现为点了没反应（视图加完立刻被移除，store 与标签栏都不变），再点一次才好。
     *
     * 判据取「**本次新出现在上报集合里的 key**」= 视图刚把它加进来 = 刚被打开。
     * 它们先记一次最近使用，再走下面的 LRU 裁剪，保证被淘汰的永远是**别的**面板。
     * （`ageRank` 对「从未 touch 过」的 key 返回 -1 当最新，只挡住了「首次打开」；
     *   本条挡住的是「本会话早先打开过、位次已陈旧」这一半。）
     */
    const prev = get().keys;
    for (const k of next) if (!prev.includes(k)) touchRecency(k);
    // ★ §4.4：视图可能上报**超过上限**的集合 —— 活动栏走的是 `DockShellApi.openPanel`
    //   （直接 addPanel，绕过了 store 的 `open`），用户拖标签也会。这里统一裁剪；
    //   被淘汰的面板由受控 effect（DockShell 的 `openKeys`）从视图移除。
    const limited = limitOpenKeys(next, get().baseOpen);
    notifyEviction(limited.evicted);
    next = limited.keys;
    set((state) => ({
      keys: next,
      activeKey: state.activeKey && next.includes(state.activeKey) ? state.activeKey : null,
      // ★ 2026-10-28：预览标签若被视图移除（用户点 × / 被 LRU 淘汰）⇒ 预览位清空，
      //   否则 `previewKey` 会指向一个已不存在的面板，标签条再也画不出斜体态。
      previewKey: state.previewKey && next.includes(state.previewKey) ? state.previewKey : null,
    }));
  },

  // ★ 2026-10-11：基础标签（章节正文）的开 / 关 —— 幂等。
  //   关掉它腾出的名额让功能面板可回到 3 个（受控 effect 会在 baseOpen 变化后重跑）。
  //   重开则**反向收名额**：基础标签占回 1 格 ⇒ 若此刻已有 3 个功能面板，按 LRU
  //   淘汰最久未用者（并 toast），保证「总标签数 ≤ MAX_OPEN_PANELS」恒成立。
  openBase: () =>
    set((state) => {
      const limited = limitOpenKeys(state.keys, true);
      notifyEviction(limited.evicted);
      return { baseOpen: true, keys: limited.keys };
    }),
  closeBase: () => set({ baseOpen: false }),
}));

// ---- ★ 2026-10-11 持久化：打开集合变化即落盘 -------------------------------
//
// 订阅 store：只要 `keys` 变化（打开 / 关闭 / 上限淘汰 / 视图回写）就写 localStorage。
// 闸门 `persistArmed` 保证播种 / 恢复决策完成前不落盘（挡掉 DockShell 就绪时的早期
// 空集合回写，见 `persistArmed` 注释）。`activeKey` 不落盘：焦点不是布局，刷新后由
// 视图重建即可（VS Code 亦不恢复焦点）。
if (typeof window !== 'undefined') {
  usePanelOpenStore.subscribe((state, prev) => {
    if (!persistArmed) return;
    if (state.keys !== prev.keys || state.baseOpen !== prev.baseOpen) {
      writePersisted(state.keys, state.baseOpen);
    }
  });
}

/**
 * §2.3.1 冻结：面板导航句柄（命令式，非 React 组件可直接调用）。
 * 与 `DockShellApi`（§2.4）是同一套能力的两层视图。
 */
export interface PanelNavigation {
  /** 打开或聚焦面板。已存在则只聚焦（ADR §4.2 缺省 allowMultiple=false） */
  open(key: string): void;
  /**
   * ★ 2026-10-28 VS Code 对齐：以**预览**方式打开（复用唯一的预览位）。
   * 与 `open` 的差别只在"旧预览会被替换掉"；上限 / LRU 语义相同。
   */
  openPreview(key: string): void;
  /** ★ 2026-10-28：把预览标签转正（双击 / 主动固定） */
  pinPreview(key?: string): void;
  /** 已打开则聚焦，未打开则打开（语义等同 open —— 保留旧名仅为对称） */
  focus(key: string): void;
  /** 切换：未打开→打开，已打开→关闭 */
  toggle(key: string): void;
  /** 关闭。不存在则 no-op */
  close(key: string): void;
  /** 关闭全部；opts.except 内的 key 保留 */
  closeAll(opts?: { except?: string[] }): void;
  /** 当前已打开 key（打开顺序；同时打开数不超过 `MAX_OPEN_PANELS`） */
  opened(): string[];
  /** 当前聚焦 key（dockview active panel），无则 null */
  active(): string | null;
}

/**
 * ★ 冻结：命令式单例入口（非 React 环境唯一可用入口）。
 *
 * 派发 `'nm:open-panel'` 的 5 个调用点（ADR §2.1）全部是非 React 上下文，
 * 它们**不需要**改；事件桥的回调体会转发到这里。
 */
export function getPanelNavigation(): PanelNavigation {
  const s = () => usePanelOpenStore.getState();
  return {
    open: (key) => {
      s().open(key);
      openOrFocus(key);
    },
    /**
     * ★ 2026-10-28：预览打开。
     * 关键差别在**视图侧**：若旧预览面板还挂在视图里而 store 已把它从 keys 移除，
     * 必须把新集合推给视图（`pushKeysToView`）—— 否则旧面板会赖在标签栏上不走，
     * 预览位变成"越点越多"。这一步是本功能最容易漏的地方。
     */
    openPreview: (key) => {
      const before = s().keys.slice();
      s().openPreview(key);
      const after = s().keys;
      // 集合有变化（新增 or 替换掉了旧预览）⇒ 让视图跟随；否则只需聚焦
      const changed = after.length !== before.length || after.some((k) => !before.includes(k));
      if (changed) pushKeysToView();
      else openOrFocus(key);
    },
    pinPreview: (key) => {
      s().pinPreview(key);
    },
    focus: (key) => {
      s().focus(key);
      openOrFocus(key);
    },
    toggle: (key) => {
      // 先读旧态判定方向：toggle 的语义依赖「当前是否已打开」
      const wasOpen = s().keys.includes(key);
      s().toggle(key);
      if (wasOpen) pushKeysToView();
      else openOrFocus(key);
    },
    close: (key) => {
      s().close(key);
      pushKeysToView();
    },
    closeAll: (opts) => {
      s().closeAll(opts);
      pushKeysToView();
    },
    opened: () => s().opened(),
    active: () => s().active(),
  };
}

/**
 * §2.3.3（ADR 注：便利项，非验收项）：命令式「打开设置页」。
 *
 * **刻意不在此落地** —— 本 store 属数据层，`PATHS` / `navigate` 属路由层，
 * 在此 import 会让 store 依赖 react-router，违反分层。
 * 因此 `'nm:open-settings'` 事件（由 ProjectLayout 监听并 `navigate(PATHS.settings)`）
 * 仍是插件触达设置页的**唯一路径**，长期保留（ADR D7）。
 */

// ---- 调试辅助（非契约） ----------------------------------------------------

/**
 * 重置 store 与视图层桥接（测试用）。
 *
 * @param opts.keepStorage 保留 localStorage 里的持久化记录 —— 用于模拟「刷新」：
 *   清内存状态（含播种开关）但保留用户上次的选择，随后再次 `seedPanelOpenKeys`
 *   应恢复该选择（而不是重新播默认种子）。
 */
export function _resetPanelOpenStore(opts?: { keepStorage?: boolean }): void {
  // ★ 先关落盘闸门再改 state —— 否则下面那次 `setState({keys:[]})` 会经订阅把
  //   「重置」写进 localStorage，把用户选择抹成空（测试里表现为「刷新后全空」）。
  persistArmed = false;
  usePanelOpenStore.setState({ keys: [], activeKey: null, baseOpen: true });
  pendingOpens.length = 0;
  viewOpen = null;
  viewSync = null;
  viewBase = null;
  seeded = false;
  seedUnconfirmed = [];
  seedDeadline = 0;
  recency.length = 0;
  lastEvictNoticeAt = 0;
  // ★ 2026-10-11 持久化：清掉落盘记录，避免跨用例串味（keepStorage 时保留，用于模拟刷新）
  if (!opts?.keepStorage) {
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 静默 */
    }
  }
}
