// ============================================================
// 手写台大模块 —— Web 面入口（D1：一模块一包；D35：kernel 只经此入口引用）
//
// 职责：
//   1. registerProjectPanel × 12 —— 手写台工作台停靠面板（modes: ['manual']）
//   2. registerBuiltinPanel('chapters') —— 「章节」内置面板槽（LeftSidebar）
//      ★ D21：kernel ProjectLayout 的 chapterBubbleDef 改为按 key 'chapters'
//        取注册槽；模块缺席 ⇒ 该面板不渲染（优雅降级）
//      ★ ADR D9 / §3.3（本次改名）：扩展点由 `registerBuiltinBubble` 更名为
//        `registerBuiltinPanel`。「bubble（气泡）」是本次重构退役的 UI 形态词，
//        槽位本身作为扩展点保留（`'chapters'` 仍是键）。旧名在 kernel 侧保留为
//        deprecated 别名，此处**主动改名**以完成去气泡化。
//   3. 章节编辑器（ChapterEditor）经本入口的具名导出供 kernel 惰性引用（D35）
//   4. registerBuiltinPanel('ai-chat') —— 右栏「AI 对话」面板（modes: ['manual']）
//      ★ 隔离改造（本轮）：该槽**原先由 auto 模块**（`apps/plugins/auto/workbench/
//        web/index.tsx`）注册，且把 modes 放宽到 ['manual','auto'] —— 等于
//        「手写台的右栏 UI 由 AI 写作模块提供」，并且同一个 key 在 ProjectLayout 的
//        `builtinPanels ∪ projectPanels` 合池里出现两个注册者（`byKey.set` 后写覆盖、
//        无告警 ⇒ 谁生效取决于 glob 挂载顺序，不可依赖）。
//        本轮把它收回手写台自有：真实实现落在本模块的 `./ai/AiChatPanel`，
//        modes 只声明 ['manual']；auto 侧的同 key 注册已删除。
//        口径：手写模块的组件只作用在手写模式，且不再引用 AI 写作模块。
//
// 本入口由 main.tsx 的 import.meta.glob 自动收集
//   （'../../../apps/plugins/manual/*/web/index.tsx'）—— 目录即模式事实来源。
// ============================================================

import React from 'react';
import { BookOpen, MessageSquare, Sparkles } from 'lucide-react';
import type { WebPluginContext } from '@novel/core/web';
import { registerBuiltinPanelAsContext } from '@/plugin/host';
import { registerBottomPanelSection } from '@/components/shell/bottomSections';
import { QuickPhraseSection, QuickPhraseThinEntry } from './editor/panels/QuickPhrasePanel';
import { BUILTIN_PANELS, preloadPanels } from './panels';
// ★ AI 能力 provider（静态引入）：注册必须发生在任何消费点首帧之前 ——
//   TimelineView 在**渲染期** getCapability('ai.timelineExtract') 决定按钮显隐，
//   懒加载 provider 会让按钮在补注册前的一帧里缺失（渲染时序不可依赖）。
import { registerAICapabilities } from './ai/aiCapabilityProvider';

// 章节面板内容：懒加载保持 chunk 分割
const LeftSidebar = React.lazy(() =>
  import('./layout/LeftSidebar').then((m) => ({ default: m.LeftSidebar })),
);

// ★ 隔离改造：AI 对话面板（手写台自有）。与左栏同款懒加载 —— 面板未打开时
//   不把面板代码拉进首屏（DockShell 的面板内容已在 Suspense/PanelGuard 内渲染）。
//   加载说明符 `./ai/AiChatPanel` 同时被下方 `preload()` 复用 ⇒ 预取列表与注册项
//   永远同源，不会两处各写一遍而漂移。
const AiChatPanel = React.lazy(() =>
  import('./ai/AiChatPanel').then((m) => ({ default: m.AiChatPanel })),
);

export const name = 'novel.manual.workbench';
// 'capability'（= registerCapability/getCapability 服务名，WEB_SERVICES 白名单项）：
// 2026-10-11 起本入口注册三个 AI 能力实现（见 apply() 第 5 步）。
export const inject = ['projectPanels', 'builtinBubble', 'capability'];

export function apply(ctx: WebPluginContext): void {
  // 1) 12 个手写台工作台面板（ADR §7.1：FloatingPanelDef 全部既有字段保留 ⇒ 零改动）
  for (const panel of BUILTIN_PANELS) {
    ctx.registerProjectPanel(panel);
  }

  // 2) 「章节」内置面板槽（D21 键控多槽；缺席即不渲染）。
  //    ★ D9：经 kernel 的过渡期桥接函数以**新名语义**注册。
  //      为什么用 `registerBuiltinPanelAsContext(ctx, …)` 而不是 `ctx.registerBuiltinPanel(…)`：
  //      `WebPluginContext`（packages/core，本次不在改动范围）只声明了旧名
  //      `registerBuiltinBubble`，新名尚未落到接口上。桥接函数是 kernel 提供的
  //      新名入口，二者落到**同一个注册槽**（`registry.builtinPanels`）。
  //      退场条件见 `@/plugin/host.ts` 的 `registerBuiltinPanelAsContext` 注释。
  registerBuiltinPanelAsContext(ctx, {
    key: 'chapters',
    label: '章节',
    icon: BookOpen,
    // ★ 2026-10-29：活动栏分区（见 kernel components/shell/panelSections.ts）。
    //   「章节」是写作主线本身，与 AI 对话同属「写作」组，排在竖栏最上。
    section: '写作',
    Component: LeftSidebar,
    // ★ 240：截图口径（左栏固定 240px 量级）。这不是纯外观参数 —— DockShell 用它设
    //   addPanel 的初始宽度与 minimumWidth（DockShell.tsx:389-390 / dock/types.ts:76），
    //   320 会让初始三栏直接挤掉中栏正文的可读宽度。
    width: 240,
    height: 640,
    modes: ['manual'],
    // ★ t4（集成接线）：显式声明落**左**停靠区。
    //   不声明时 `resolveDockMeta` 缺省 `slot:'right'`（dock/types.ts:60-70），
    //   左栏章节树会跑到右侧与 AI 对话抢同一停靠区 —— 目标截图要求左栏在左。
    //   尺寸真源仍是上面的 width/height + dock/layout.ts 的 DOCK_LEFT_PANEL_DEFAULT_WIDTH，
    //   这里不重复声明宽度。
    dock: { slot: 'left' },
  });

  // 3) 右栏「AI 对话」内置面板槽（本轮由 auto 收回手写台）。
  //    ★ modes 只声明 ['manual']：手写模块的面板只作用在手写模式。
  //      （kernel 的 `withModes` 是 `modes: def.modes ?? 宿主推导值`，条目级优先；
  //       本模块目录名推导值同为 manual，两处口径一致。）
  //    ★ 不声明 `dock` ⇒ 走 `resolveDockMeta` 缺省 `slot:'right'`（dock/types.ts:60-70），
  //      正是「右栏」语义；宽度量级沿用截图口径 340。
  registerBuiltinPanelAsContext(ctx, {
    key: 'ai-chat',
    label: 'AI 对话',
    icon: MessageSquare,
    // ★ 2026-10-29：与「章节」同属「写作」组（AI 协同是写作主线的一部分）。
    section: '写作',
    width: 340,
    height: 640,
    modes: ['manual'],
    Component: AiChatPanel,
  });

  // 4) 底部面板分区（kernel 扩展点 `registerBottomPanelSection`，见
  //    `apps/web/src/components/shell/bottomSections.tsx`）：把「快捷短语」
  //    从编辑器正文上方的 position:fixed 漂移气泡改挂到 DockShell 底部面板里
  //    的一栏。扩展点本身**不按模式隔离**（是否注册由本模块自行决定），故不
  //    走 ctx.* —— 直接调注册函数，并用 ctx.effect 挂注销，与其他注册一致。
  ctx.effect(
    registerBottomPanelSection({
      key: 'quick-phrase',
      label: '快捷短语',
      icon: Sparkles,
      ThinEntry: QuickPhraseThinEntry,
      Component: QuickPhraseSection,
    }),
    'bottom-section:quick-phrase',
  );

  // 5) AI 能力 provider（2026-10-11 补齐）—— 注册 `ai.scan` / `ai.timelineExtract` /
  //    `ai.quickPhrases` 三个实现。此前全仓无 provider（auto 模块实现随 c2583f8
  //    移出仓外），自动实体检测 / 时间线提取 / 快捷短语 AI 全部停在静默降级态。
  //    能力表是跨模块共享面（kernel 不按模式隔离），实现=本模块 `./ai/aiCapabilityProvider`，
  //    服务端引擎全部在本仓（详见该文件头注）。
  registerAICapabilities(ctx);
}

// ------------------------------------------------------------------
// kernel 惰性引用的公开导出（D35）
//   App.tsx:24 `loadChapterEditor` 改指本入口，避免 kernel 静态 import
//   `@/components/editor/ChapterEditor`（K2M 边）。
// ------------------------------------------------------------------
export { ChapterEditor } from './editor/ChapterEditor';
export { EditorPage } from './editor/EditorPage';

/**
 * 面板级预取入口（kernel 经 `loadModulePreload('manual')` 在空闲时调用）。
 *
 * ★ 2026-10-07「跳转画面会加载一下」修复：本模块的 chunk（章节左栏 + 12 个停靠面板）
 *   全是模块内部相对路径的懒加载，kernel 的 `PRELOAD_ON_PATH` / `ALL_ROUTE_LOADERS`
 *   看不见它们 ⇒ 进项目后每开一个面板都要现下载。预取**内容**因此留在模块里，
 *   kernel 只负责在首屏稳定后的空闲时间片里调一下这个函数（D35：kernel 不碰内部实现）。
 *
 * 与 `apply()` 期间注册的那份 lazy 组件共用同一 import() 说明符 ⇒ 命中同一份模块缓存，
 * 打开面板时同步命中、不再出现 Suspense fallback。
 */
export function preload(): void {
  // 「章节」左栏是进项目后**立刻**就渲染的面板（ProjectLayout 的 chapters 槽），
  // 优先级最高，单独先发；其余 12 个停靠面板一并发出。
  void import('./layout/LeftSidebar').catch(() => {});
  // ★ 隔离改造：右栏 AI 对话面板一并预取（原预取由 auto 模块的入口提供）。
  void import('./ai/AiChatPanel').catch(() => {});
  preloadPanels();
}
