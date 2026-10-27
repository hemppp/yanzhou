// ============================================================
// Web 插件类型 —— 契约来自 @novel/core/web，本地补充具体组件类型
// ============================================================

import type React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Editor, AnyExtension } from '@tiptap/core';
import type {
  WebPluginContext as CoreWebPluginContext,
  WebCommandDef as CoreCommandDef,
  WebRouteDef as CoreRouteDef,
  WebRouteGuard as CoreRouteGuard,
  SettingsCategory as CoreSettingsCategory,
  PluginMode,
} from '@novel/core/web';
// ★ ADR §1.4/§1.5 的 dock 元数据类型：单一真源在停靠内核侧
//   （`components/shell/dock/types.ts`，t3 交付）。这里**只做类型再导出**，
//   不复制定义 —— `dock/types.ts` 属 out-of-scope，不能反向 import 插件层，
//   故由本文件作为「插件可见的类型面」把它转发出去。
//   `import type` ⇒ 零运行时依赖，不会把 dockview 拖进插件包。
//   ⚠ 缺省值的真源仍是 `resolveDockMeta()`；本文件**不**复刻缺省表（ADR §1.5）。
export type { FloatingPanelDockMeta } from '@/components/shell/dock/types';
import type { FloatingPanelDockMeta } from '@/components/shell/dock/types';

// ---- 具体化类型（组件层使用，icon/Component 用真实类型）----

/**
 * 条目适用模式（契约来自 @novel/core）。
 * - 缺省 / 空数组 → 视为 ['shared']（两种模式都适用）
 * - 由插件宿主按插件父目录名（manual/auto/shared/local）推导后盖到每个注册条目上，
 *   消费点再按当前 project.mode 过滤（pluginAppliesToProjectMode）。
 * - 手工注册（不经宿主，如 AutoWriteWorkbench 的 auto 面板）时自行声明。
 */
export type { PluginMode };

/** 项目浮窗面板（对应 ProjectLayout 面板宿主） */
export interface FloatingPanelDef {
  icon: LucideIcon;
  label: string;
  key: string;
  /** any：面板组件可声明自己的 props（如 AI 对话的 controls），宿主按 key 决定是否透传 */
  Component: React.ComponentType<any>;
  /**
   * 该面板 chunk 的**预取**入口（可选，与 `Component` 用同一个 `import()` 说明符）。
   *
   * 为什么需要它：面板组件几乎都是 `React.lazy`，chunk 只在**首次渲染**那一刻才开始下载
   * ⇒ 冷路径点开面板必然先闪一下「加载中…」（`PanelFallback`）。
   * 宿主在「用户意图已出现、点击尚未发生」的时刻调它一发 —— 活动栏 / 气泡悬停与聚焦、
   * 进项目后的空闲时间片 —— 把「点击后才开始下载」变成「点击即命中模块缓存」。
   * 未声明 ⇒ 宿主静默跳过（第三方插件不受影响，也不会因为缺这个字段被当成错误）。
   */
  preload?: () => Promise<unknown>;
  width?: number;
  height?: number;
  order?: number;
  /** 'workspace'（缺省）进顶栏按钮组；'editor' 由编辑器内面板栏开关 */
  scope?: 'workspace' | 'editor';
  /**
   * AI 写作工作台（分页区 / 气泡列）的分组：
   *   'live' = 写作中（实时运转的数据） / 'data' = 资料。
   * 手写模式的浮窗面板不使用此字段。
   */
  group?: 'live' | 'data';
  /**
   * 浮窗左缘外侧贴附的功能气泡栏。
   *
   * ★ ADR §1.3 冻结（渲染位置迁移）：字段**保留不删**（第三方插件不炸），
   *   但**宿主不再读取它** —— dockview 面板的根 div 不是插件可预测的定位基准
   *   （拖动 / 停靠 / 悬浮三种形态下 DOM 结构不同），继续依赖外层定位会让 rail
   *   在停靠态错位。需要 rail 的面板请在其自己的 `Component` **内部**渲染，
   *   由组件自理定位。未声明 ⇒ 无任何渲染（本就如此）。
   */
  rail?: React.ComponentType;
  /**
   * ★ P0 新增（ADR §1.4）：停靠布局元数据，**全字段可选**。
   *
   * 缺省 `undefined` ⇒ 等价于 `{}` ⇒ 全部走 ADR §1.4「缺省行为」列，
   * 即 `slot:'right' / defaultOpen:false / allowMultiple:false / closable:true /
   * floatable:true / minSize:240×160 / center:false`，`floatingSize` 回落
   * 顶层 `width`/`height` → `1024×720`。
   *
   * ⚠ 缺省行为的**唯一真源**是 `DockShell` 内的 `resolveDockMeta()` 纯函数
   *   （`components/shell/dock/types.ts`）。消费方一律经它取值，
   *   **不得**在此类型旁再写一份 `?? 默认值`（ADR §1.5 冻结）。
   *
   * 因此本字段是**纯可选新增** ⇒ 既有插件注册代码 100% 向后兼容。
   */
  dock?: FloatingPanelDockMeta;
  /** 适用创作模式，见 PluginMode */
  modes?: PluginMode[];
}

export interface CommandDef extends Omit<CoreCommandDef, never> {
  id: string;
  title: string;
  keywords?: string[];
  run: () => void | Promise<void>;
  order?: number;
  modes?: PluginMode[];
}

export type RouteGuard = CoreRouteGuard;

export interface PluginRouteDef extends Omit<CoreRouteDef, never> {
  path: string;
  Component: React.ComponentType;
  guard?: RouteGuard;
  inProject?: boolean;
  order?: number;
  modes?: PluginMode[];
}

export type SettingsCategory = CoreSettingsCategory;

/** 设置页区块（宿主提供 nm-card 外壳 + 标题，插件只给内容组件） */
export interface SettingsSectionDef {
  key: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  Component: React.ComponentType;
  category?: SettingsCategory;
  order?: number;
  modes?: PluginMode[];
}

/** 编辑器 Tiptap 扩展工厂（每个编辑器实例调用一次 create） */
export interface EditorExtensionDef {
  key: string;
  create: () => AnyExtension;
  order?: number;
  modes?: PluginMode[];
}

/** 编辑器工具栏条目 */
export interface EditorToolbarItemDef {
  key: string;
  label: string;
  icon?: LucideIcon;
  run: (editor: Editor) => void | Promise<void>;
  isActive?: (editor: Editor) => boolean;
  order?: number;
  modes?: PluginMode[];
}

/** 选区菜单动作（icon 可为 Lucide 组件或 emoji 字符串） */
export interface SelectionActionDef {
  key: string;
  label: string;
  icon?: LucideIcon | string;
  color?: string;
  run: (payload: { text: string; editor: Editor }) => void | Promise<void>;
  order?: number;
  modes?: PluginMode[];
}

// ---- AI 聊天气泡栏（chatRail 扩展点，插件可接管）----

/** 宿主下发给气泡栏的状态与回调（状态机在 ProjectLayout，互斥在宿主处理） */
export interface ChatRailProps {
  syncInsert: boolean;
  enableTools: boolean;
  enableAgent: boolean;
  activeSkillId: string | null;
  onToggleSync: () => void;
  onToggleTools: () => void;
  onToggleAgent: () => void;
  /** 技能选择（id 或 null=取消） */
  onSkillChange: (id: string | null) => void;
}

export interface ChatRailDef {
  key: string;
  Component: React.ComponentType<ChatRailProps>;
  /** 适用创作模式：仅在该模式（或 shared）下由宿主采用；缺省 shared */
  modes?: PluginMode[];
}

/**
 * AI 对话浮窗的控件 props（kernel 自有契约，设计 §4-C1 / D44）。
 *
 * ★ 为什么在 kernel 定义而不是从 auto 模块再导出：
 *   消费方是 kernel 壳 `components/shell/ProjectLayout.tsx`（浮窗宿主）。
 *   若 kernel 从 `@novel-plugins/auto-workbench/web` 取该类型，就形成
 *   **kernel → auto 模块入口**的静态说明符，模块缺席时 vite 解析即失败
 *   （`[vite:load-fallback] ENOENT`）——与「另一模块缺席仍可用」直接冲突。
 *   故 kernel 自持该形状；auto 的 `ChatPanel` 侧实现结构一致即可（宿主按 `any` 下发）。
 */
export interface ChatPanelControlProps {
  /** 同步写入：AI 回复边生成边插入正文 */
  syncInsert: boolean;
  /** 工具调用：AI 可读写实体模块（与 enableAgent 互斥） */
  enableTools: boolean;
  /** Agent 模式：多步规划/网页搜索/章节读写（与 enableTools 互斥） */
  enableAgent: boolean;
  /** 当前激活的技能 ID（null = 未激活） */
  activeSkillId: string | null;
  onSyncInsertChange: (v: boolean) => void;
  onEnableToolsChange: (v: boolean) => void;
  onEnableAgentChange: (v: boolean) => void;
  onActiveSkillChange: (id: string | null) => void;
}

// ---- 插件上下文 / 模块契约（re-export core）----

export type WebPluginContext = CoreWebPluginContext;
export type WebPluginModule = import('@novel/core/web').WebPluginModule;

// ---- 新增扩展点的具体类型（re-export core；组件类型本地化见下）----

/** 跨模块能力名（唯一来源：@novel/core 的 WEB_CAPABILITIES） */
export type { WebCapabilityName } from '@novel/core/web';

/** 模块级工作台根组件定义（registerWorkbench）；Component 用真实 React 类型 */
export interface WorkbenchDef {
  key: string;
  modes: PluginMode[];
  Component: React.ComponentType<any>;
}

/**
 * 内核内置面板槽定义（ADR D9 / §3.3）。
 *
 * ★ 更名历史：原名 `BuiltinBubbleDef`。「bubble（气泡）」是本次重构退役的
 *   **UI 形态词**（ADR §0.3：功能转轮退役），继续用它命名扩展点会让下游
 *   误以为要保留气泡。类型更名，槽位本身作为扩展点保留。
 *
 * 字段集是 `FloatingPanelDef` 的**真子集**（少 `scope/rail/group`），
 * 因此合池时无需 `as unknown as FloatingPanelDef` 双断言（ADR §3.2）。
 * 按 key 键控多槽：`'chapters'` 与 `'ai-chat'` **都属 manual 模块**
 * （2026-10「手写/自动隔离改造」后 AI 对话面板由手写台自注册；此前它由 auto 模块注册）。
 *
 * ★ t4（集成接线）新增 `dock`：内置槽原先无法声明停靠位置 ⇒ `'chapters'`
 *   只能落 `resolveDockMeta` 的缺省 `slot:'right'`，左栏章节树到不了左停靠区。
 *   补上后与 `FloatingPanelDef.dock` 同源（缺省行为的真源仍是 `resolveDockMeta`，
 *   此处**只透传、不写缺省值**）。
 */
export interface BuiltinPanelDef {
  key: string;
  Component: React.ComponentType<any>;
  icon?: LucideIcon;
  label?: string;
  width?: number;
  height?: number;
  order?: number;
  modes?: PluginMode[];
  /** ★ t4：停靠布局元数据（全字段可选，语义与 `FloatingPanelDef.dock` 一致） */
  dock?: FloatingPanelDockMeta;
}

/** @deprecated ADR D9：改名 `BuiltinPanelDef`。别名仅为兼容已发布插件。 */
export type BuiltinBubbleDef = BuiltinPanelDef;
