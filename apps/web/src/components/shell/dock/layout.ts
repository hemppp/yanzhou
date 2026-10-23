// ============================================================
// dock/layout.ts — dockview 选项 / 布局组装（P2 · t3，纯函数，便于单测）
//
// 职责：把「外部传入的面板定义数组」翻译成 dockview 的
//   components / addPanel options / 初始 layout。
// 本文件**不**触碰 DOM、不硬编码任何业务面板 key。
//
// 契约：ADR §1.4（落位与缺省）、§1.6（center 抢占中心槽）、§5.5（--dv-* → --vscode-*）。
// ============================================================

import type {
  DockAreaSlot,
  DockPanelDef,
  DockSlot,
  ResolvedDockMeta,
} from './types';
import { resolveDockMeta } from './types';

/**
 * 侧栏 / 底部面板的初始尺寸（VS Code 侧栏量级）。
 *
 * ★ t1（外壳改造）按截图把「侧栏」**拆成左右两档**：左栏（章节树）、右栏 340px（AI 对话）。
 *   旧的单一常量 `DOCK_SIDE_PANEL_DEFAULT_WIDTH = 320`
 *   已删除（全仓 grep 仅本文件引用，无测试依赖）。
 *
 * ★ 用户口径（2026-10-05）澄清：先前按「章节UI宽度减少百分之五十」把左栏改成 120px 属**误读** ——
 *   用户要的是**上下（高）减半**，不是栏宽（见 `LeftSidebar` 的章节行高 + 报告 §十二）。
 *   栏宽已**改回 240**（VS Code 侧栏量级），`buildPanelSpec` 的最小宽也一并回到通用 minSize。
 */
export const DOCK_LEFT_PANEL_DEFAULT_WIDTH = 240;
export const DOCK_RIGHT_PANEL_DEFAULT_WIDTH = 340;
export const DOCK_BOTTOM_PANEL_DEFAULT_HEIGHT = 240;

/** 侧栏初始宽度（**按槽取值**）：left → 240 / right → 340。 */
export function dockSideWidth(slot: 'left' | 'right'): number {
  return slot === 'left' ? DOCK_LEFT_PANEL_DEFAULT_WIDTH : DOCK_RIGHT_PANEL_DEFAULT_WIDTH;
}

/** dockview 侧的落位方向（`Direction` 的超集，'within' 用于同 group 堆叠）。 */
export type DropDirection = 'left' | 'right' | 'above' | 'below' | 'within';

/**
 * 把 ADR 的槽位名映射到 dockview 的 `Direction`。
 * dockview 用 above/below，本仓库契约用 top/bottom —— 这里是唯一转换点。
 */
export function slotToDockDirection(slot: DockAreaSlot): DropDirection {
  switch (slot) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'bottom':
      return 'below';
  }
}

/** 每个 dock area 承载的初始面板（§1.4 缺省 slot='right'）。 */
export interface DockAreaPlan {
  left: DockPanelDef[];
  right: DockPanelDef[];
  bottom: DockPanelDef[];
  center: DockPanelDef[];
}

/**
 * 候选池 → 布局桶。
 *
 * ★ 2026-10-11 用户口径（「点击那些功能需要显示在正页」）：布局收敛为**单列** ——
 *   所有面板都进中心组、作为文档标签堆叠，**不再有左右/底部停靠列**。
 *   故本函数不再按 `slot` 分桶：`center` 桶收全部面板，其余三桶恒空。
 *   `dock.slot` 字段（ADR §1.4 冻结）仍保留在类型上，但布局层已忽略它。
 *
 * ★ 不修改传入数组；顺序按 `order`（缺省 0）稳定排序，保证初始布局可复现。
 */
export function planDockAreas(panels: DockPanelDef[]): DockAreaPlan {
  const sorted = panels
    .map((def, index) => ({ def, index }))
    .sort((a, b) => {
      const oa = a.def.order ?? 0;
      const ob = b.def.order ?? 0;
      if (oa !== ob) return oa - ob;
      return a.index - b.index; // 稳定：order 相同时保序
    })
    .map((x) => x.def);

  return { left: [], right: [], bottom: [], center: sorted };
}

/** dockview `addPanel` 的入参（这里只列出本内核会设置的字段）。 */
export interface DockPanelSpec {
  id: string;
  title: string;
  component: string;
  params: { defKey: string; def: DockPanelDef };
  position: { direction: DropDirection; referencePanel: string };
  initialWidth?: number;
  initialHeight?: number;
  minimumWidth: number;
  minimumHeight: number;
  /**
   * ★ dockview 能力：加入但**不设为激活面板**。
   *
   * 为什么本内核需要它（2026-10-17 修「打开项目默认落在 AI 对话而非章节正文」）：
   * `addPanel` 缺省把新面板设为激活，于是「恢复上次打开集合 / 播默认种子 / 补加迟到
   * def」这些**非用户意图**的加入会把焦点从基础标签（章节正文）抢走。只有用户在
   * 视图层主动打开时才该抢焦点（那条路径走 `DockShellApi.openPanel`，不带本标记）。
   */
  inactive?: boolean;
}

/** dockview 内部注册的**唯一**通用渲染器 id（见 DockPanelContent）。 */
export const DOCK_PANEL_COMPONENT_ID = 'dock:panel';

/**
 * 为一个面板生成 dockview `addPanel` 规格。
 *
 * @param def       面板定义（外部传入）
 * @param slot      目标停靠区
 * @param anchorId  参考面板 id；同区首个面板用它定位（等于先注册的兄弟 id）
 */
export function buildPanelSpec(
  def: DockPanelDef,
  slot: DockSlot,
  anchorId: string,
): DockPanelSpec {
  const meta: ResolvedDockMeta = resolveDockMeta(def);
  const spec: DockPanelSpec = {
    id: panelInstanceId(def.key),
    title: def.label,
    component: DOCK_PANEL_COMPONENT_ID,
    params: { defKey: def.key, def },
    position:
      slot === 'center'
        ? { direction: 'within', referencePanel: anchorId }
        : { direction: slotToDockDirection(slot), referencePanel: anchorId },
    // 侧栏最小宽直接用通用 minSize（左 120 的实验已回滚：栏宽回到 240，不再需要收窄最小宽）
    minimumWidth: meta.minSize.width,
    minimumHeight: meta.minSize.height,
  };
  // 侧栏 / 底部面板给一个初始尺寸，避免首个面板占满整屏（VS Code 侧栏量级）
  if (slot === 'left' || slot === 'right') {
    spec.initialWidth = dockSideWidth(slot);
  } else if (slot === 'bottom') {
    spec.initialHeight = DOCK_BOTTOM_PANEL_DEFAULT_HEIGHT;
  }
  return spec;
}

/** 面板实例 id（与业务 key 区分开，因为同一 key 可能多实例，ADR §1.4 allowMultiple）。 */
export function panelInstanceId(key: string): string {
  return `nm-panel:${key}`;
}

/** 从实例 id 反解业务 key。 */
export function panelKeyFromInstanceId(id: string): string {
  const prefix = 'nm-panel:';
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * §1.6：中心区默认占用者的**固定参考 id**。
 * dockview 需要至少一个面板才能建立 grid；中心区先放一个「章节编辑区」占位面板，
 * 其内容由 `centerDefault` 注入（见 DockShell），被 center panel 抢占时替换。
 */
export const CENTER_DEFAULT_PANEL_ID = 'nm-center-default';

/** center 面板的实例 id 前缀（与普通面板区分，便于 activeCenterKey 反查）。 */
export function centerPanelInstanceId(key: string): string {
  return `nm-center:${key}`;
}

export function isCenterPanelInstanceId(id: string): boolean {
  return id.startsWith('nm-center:');
}

/**
 * 组装初始布局的**执行序列**：dockview 的 `addPanel` 必须串行，
 * 且首个面板不带 position（它建立 grid 根）。这里产出可直接 for 循环执行的描述数组。
 */
export interface LayoutStep {
  spec: DockPanelSpec;
  /** true = 该步是 grid 的根面板，不传 position */
  isRoot: boolean;
}

export function buildLayoutSteps(plan: DockAreaPlan, rootId: string): LayoutStep[] {
  const steps: LayoutStep[] = [];
  const anchors: Record<DockSlot, string | null> = {
    left: null,
    right: null,
    bottom: null,
    center: null,
  };

  // 顺序：center 先建根 → left → right → bottom，保证侧栏吸附到中心区两侧
  const order: DockSlot[] = ['center', 'left', 'right', 'bottom'];

  for (const slot of order) {
    for (const def of plan[slot]) {
      const anchor = anchors[slot] ?? rootId;
      const spec = buildPanelSpec(def, slot, anchor);
      // ★ t4（集成接线）：**只有 id 恰为 `rootId` 的面板才是根**（不传 position）。
      //   原判据 `anchors[slot] === null && steps.length === 0` 会在「首个条目来自侧栏桶」
      //   时把该侧栏面板判为根 —— 而调用方（DockShell.onReady）**总是先**用
      //   `CENTER_DEFAULT_PANEL_ID` 建好 grid 根，于是这个「根」会以
      //   `position: undefined` 落进中心分组，变成与「编辑区」并排的**标签**，
      //   而不是左右分栏。冷启动时插件面板 def 异步注册（manual 插件晚于 auto），
      //   plan 里只剩 right 桶 ⇒ 实测右栏并进中心分组（宽 1232 而非 340）。
      const isRoot = spec.id === rootId && steps.length === 0;
      steps.push({ spec, isRoot });
      anchors[slot] = spec.id;
    }
  }
  return steps;
}
