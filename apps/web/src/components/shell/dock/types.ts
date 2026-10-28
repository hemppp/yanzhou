// ============================================================
// dock/types.ts — 停靠内核的公共类型（P2 · t3）
//
// 契约来源：docs/architecture/dock-protocol-adr.md
//   §1.4  FloatingPanelDockMeta（8 字段全可选）
//   §1.5  resolveDockMeta() = 缺省行为的唯一真源
//   §1.6  三类内容落位（center 是显式布尔，区别于 slot 的建议语义）
//   §2.4  DockShellApi（t3 交付给 t4 的命令接口）
//
// ⚠️ 本文件只定义类型与纯函数，不 import dockview、不 import React 运行时组件，
//    以便 t4（ProjectLayout / panelNavigation）在没有 dockview 的环境下也能安全取值。
// ============================================================

import type React from 'react';
import type { FloatingPanelDef } from '@/plugin/types';

/** 停靠区槽位（§1.4）。'center' 为建议落位，'left'|'right'|'bottom' 为停靠区。 */
export type DockSlot = 'center' | 'left' | 'right' | 'bottom';

/** 可停靠的三个侧栏槽（center 由 `center` 布尔单独表达，见 §1.6 裁定）。 */
export type DockAreaSlot = Exclude<DockSlot, 'center'>;

/**
 * dock 布局元数据（P0 新增，全字段可选）。
 * 未声明 = 宿主按 ADR §1.4「缺省行为」列处理。
 *
 * ⚠️ 该接口是 P0 冻结契约的**视图层镜像**。t4 若在 `@/plugin/types` 里落地同名接口，
 *    两边必须逐字段一致；此处刻意不 import `@/plugin/types` 的该成员，
 *    因为 P0 只冻结了文档、未落地代码（避免 t3 触碰 out-of-scope 的 plugin/ 目录）。
 */
export interface FloatingPanelDockMeta {
  /** 初始落位建议（可被用户拖拽覆盖）。缺省 → 'right' */
  slot?: DockSlot;
  /** 初始启用状态。false = 注册进候选池但默认不显示。缺省 → false */
  defaultOpen?: boolean;
  /** 同 key 多实例。缺省 false = 再次 open 只聚焦，不新开 */
  allowMultiple?: boolean;
  /** 允许用户关闭（标签上的 ×）。缺省 → true */
  closable?: boolean;
  /** 可被拖出为 floating group。缺省 → true（全部面板可拖出悬浮） */
  floatable?: boolean;
  /** 首次作为 floating group 出现时的几何建议值。缺省 → width/height → 1024×720 */
  floatingSize?: { width: number; height: number };
  /** 强制最小尺寸（用户拖拽不可突破）。缺省 → {width:240, height:160} */
  minSize?: { width: number; height: number };
  /** 该面板打开时「抢占」中心区：渲染到 center 槽而非普通侧栏槽。缺省 → false */
  center?: boolean;
}

/** `resolveDockMeta()` 的返回值：全部字段必填（缺省已填充）。 */
export type ResolvedDockMeta = Required<Omit<FloatingPanelDockMeta, 'floatingSize' | 'minSize'>> & {
  floatingSize: { width: number; height: number };
  minSize: { width: number; height: number };
};

/** 面板定义在视图层的读法：`dock` 是可选扩展，其余字段来自既有 `FloatingPanelDef`。 */
export type DockPanelDef = FloatingPanelDef & { dock?: FloatingPanelDockMeta };

/** §1.5 冻结的缺省值表 —— 逐字段与本常量一一对应，不得在别处再写 `??` 兜底。 */
export const DOCK_META_DEFAULTS = Object.freeze({
  slot: 'right' as DockSlot,
  defaultOpen: false,
  allowMultiple: false,
  closable: true,
  floatable: true,
  /** floatingSize 无静态缺省：按 §1.4 依次回落 def.width/def.height → 1024×720 */
  fallbackFloatingSize: Object.freeze({ width: 1024, height: 720 }),
  minSize: Object.freeze({ width: 240, height: 160 }),
  center: false,
});

/**
 * §1.5 缺省行为的**唯一真源**（纯函数，无副作用）。
 * `ProjectLayout` 与 `panelNavigation` 一律经它取值，不得各自写 `?? 默认值`。
 */
export function resolveDockMeta(def: DockPanelDef): ResolvedDockMeta {
  const d = def.dock;
  return {
    slot: d?.slot ?? DOCK_META_DEFAULTS.slot,
    defaultOpen: d?.defaultOpen ?? DOCK_META_DEFAULTS.defaultOpen,
    allowMultiple: d?.allowMultiple ?? DOCK_META_DEFAULTS.allowMultiple,
    closable: d?.closable ?? DOCK_META_DEFAULTS.closable,
    floatable: d?.floatable ?? DOCK_META_DEFAULTS.floatable,
    // 回落链：dock.floatingSize → 顶层 width/height → 1024×720（§1.4）
    floatingSize: d?.floatingSize ?? {
      width: def.width ?? DOCK_META_DEFAULTS.fallbackFloatingSize.width,
      height: def.height ?? DOCK_META_DEFAULTS.fallbackFloatingSize.height,
    },
    minSize: d?.minSize ?? { ...DOCK_META_DEFAULTS.minSize },
    center: d?.center ?? DOCK_META_DEFAULTS.center,
  };
}

/**
 * §2.4 `DockShellApi` —— 命令式控制句柄（经 `apiRef` 暴露）。
 * 与 store 层 `PanelNavigation` 是同一套能力的两层视图。
 */
export interface DockShellApi {
  openPanel(key: string): void;
  /**
   * ★ 2026-10-28 VS Code 对齐：以**预览**方式打开（活动栏单击 / 标签单击）。
   *
   * 与 `openPanel` 的差别只在"复用唯一预览位"——具体由 store 的 `openPreview` 实现，
   * 本层只负责"store 说改集合了就同步视图"。之所以放在 API 层而不是让 DockShell
   * 直接 import store：DockShell 一直保持**纯 UI**（不依赖任何 store）的边界，
   * 这里沿用它既有的 `api` 回调注入方式。
   */
  openPanelPreview(key: string): void;
  closePanel(key: string): void;
  focusPanel(key: string): void;
  /**
   * ★ 2026-10-11 单列布局：聚焦「基础标签（章节正文）」= 激活中心编辑区面板
   * （`CENTER_DEFAULT_PANEL_ID`）。它代表中心文档本身，不是业务面板，故不在 `openKeys` 里。
   */
  focusBase(): void;
  /** 当前已打开 key 顺序 */
  listPanels(): string[];
  /** 当前聚焦 key，无则 null */
  activePanel(): string | null;
  /** 把某面板弹为 floating group（用户拖拽的程序化等价物） */
  floatPanel(key: string): void;
  /** 恢复为停靠 */
  dockPanel(key: string, slot: DockAreaSlot): void;
  /**
   * ★ 2026-10-25 分屏：把某面板拆到编辑区**左侧 / 右侧的新组**（两栏并排）。
   *
   * `key` 既接受业务面板 key，也接受基础标签的保留 key（`doc:chapter`）。
   *
   * ⚠️ 实现要点（dockview 8.4.0 实测，勿凭直觉改写）：
   *   **panel 级** `panel.api.moveTo({ position })` **不会建组** —— 不传 `group` 时
   *   目标组回落为当前组、`position` 被强制 `'center'`，结果是 no-op（实测 groups 恒为 1）。
   *   能建组的是 **group 级** `group.api.moveTo`，它才在内部调 `addGroup({direction})`。
   *   故 DockShell 的做法是：`api.addGroup({ direction, referenceGroup })` 先建空组
   *   → `panel.api.moveTo({ group: newGroup, position: 'center' })` 把面板移进去。
   *
   * 语义：**只移动这一个面板**（`moveGroupOrPanel` 的 panel 分支，不带原组其他面板）；
   * `openKeys` 不变（分屏不改变「打开了什么」，只改变「摆在哪」）。
   */
  splitPanel(key: string, side: 'left' | 'right'): void;
  /** ★ 2026-10-25：取消分屏 —— 把某面板移回中心组，空出来的组由 dockview 自动回收。 */
  unsplitPanel(key: string): void;
  /**
   * ★ 2026-10-25：把**所有**组的面板并回中心组（一键退出分屏）。
   *
   * 为什么需要它：分屏后顶部标签条只显示**聚焦组**的标签，另一组的标签不在视野里，
   * 用户无法通过「右键某个标签 → 取消分屏」把那一组收回来 —— 必须有一个不依赖
   * 具体标签的出口。空组由 dockview 自动回收。
   */
  unsplitAll(): void;
  /** ★ 2026-10-25：当前是否处于分屏态（组数 > 1）。 */
  isSplit(): boolean;
  /**
   * ★ 2026-10-26：把焦点切到某面板**所在的那一栏**（分屏后点另一栏的标签用）。
   *   与 `openPanel` 的区别：openPanel 只保证面板存在并聚焦，若它已在别的组里，
   *   焦点会跟着 dockview 的默认行为走；这里显式 `group.api.setActive()` 再聚焦面板。
   */
  focusPanel(key: string): void;
}

/**
 * §1.6 中心槽「可替换插槽」的接口（t3 交付给 t4）。
 * 面板来源为外部传入的面板定义数组，DockShell 不硬编码任何业务面板。
 */
export interface DockShellProps {
  /** 候选面板定义池（已按当前 project.mode 过滤） */
  panels: DockPanelDef[];
  /** 中心区默认内容（章节编辑器路由出口）——单列布局下恒为中心组的基础标签 */
  centerDefault: React.ReactNode;
  /**
   * ★ 2026-10-11 单列布局：**已废弃**（保留占位以兼容旧调用方，DockShell 不再读取）。
   *   原语义「被占用时显示的中心面板 key」已无意义 —— 全部面板都在中心组标签堆叠。
   */
  activeCenterKey?: string | null;
  /** 命令式控制句柄（经 ref 暴露，见 §2.3） */
  apiRef?: React.Ref<DockShellApi>;
  /** 可选：受控的「已打开 key 列表」。未传时 DockShell 内部按 defaultOpen 自管 */
  openKeys?: string[];
  /**
   * ★ 2026-10-11：「章节正文」基础标签是否打开（默认 true）。
   * false ⇒ 中心默认面板（`CENTER_DEFAULT_PANEL_ID`）从中心组移除，基础标签退场；
   * 它**计入总标签上限**（由 store 裁剪 `openKeys` 保证），但不参与 LRU 淘汰。
   */
  baseOpen?: boolean;
  /** 可选：面板打开 / 关闭 / 聚焦的回调（t4 用于把状态写回 panelNavigation） */
  onOpenChange?: (keys: string[]) => void;
  onActiveChange?: (key: string | null) => void;
  /**
   * ★ 2026-10-28 VS Code 对齐：请求以**预览**方式记录某个面板（活动栏单击 / 标签单击）。
   *
   * 为什么用回调而不是让 DockShell import store：DockShell 保持**纯 UI**
   * （只吃 props、不依赖任何 store），这条边界从 t1 就定下了，破坏它会让
   * 「停靠内核可被任意宿主复用」的承诺失效。store 侧由 ProjectLayout 注入。
   */
  onPreviewOpen?: (key: string) => void;
  /**
   * 底部面板细条（t1 外壳改造）。
   *
   * 截图形态：常驻一条细条，左端「底部面板」、右端「N 条问题 Ctrl+J」，
   * 点击左端或按 Ctrl+J 展开/收起（展开高 ~200px，内容区自己滚动）。
   * 内核只负责**机制**（尺寸、开合、快捷键、无障碍），条数由调用方给真实来源
   * （见 `shell/issues.tsx`：外部 provider 优先，回落 annotation store）。
   */
  bottomPanel?: {
    /** 问题条数（真实来源由调用方给出） */
    issueCount: number;
    /** 展开后的内容（问题清单列表等） */
    children?: React.ReactNode;
  };
}
