// ============================================================
// AI 写作台大模块 —— Web 面入口（D1：一模块一包；D35/D37：kernel 只经此入口引用）
//
// 注册面（2026-10-16 加「正文阅读」面板后）：
//   1. registerProjectPanel × 6 —— 流水线 / 本章计划 / 实体与设定 / 记忆审计 / 技能库 / 正文阅读
//   2. registerWorkbench({ modes:['auto'] }) —— AutoWriteWorkbench（AI 工作台壳）
//   3. registerCapability × 3 —— ai.quickPhrases / ai.timelineExtract / ai.scan（D43）
//   4. preload() —— 面板级预取（kernel 经 loadModulePreload('auto') 空闲调用）
//
//   ★ 本列表必须与下方 `inject` 常量**逐项相同**（改一处必须改另一处；清理批 A1/A8）。
//
// ★ 2026-10-13 对标本轮**移除**的两处注册（剥离后宿主已换标准，原样装回会造成重复渲染）：
//   · `builtinPanel` 槽 `'ai-chat'`：该槽已收回手写台自有（novel.manual.workbench，
//     modes:['manual']，实现为其自带 `web/ai/AiChatPanel.tsx`，见隔离改造 5f06c43）。
//     合池是「先按 key 去重、后按模式过滤」（ProjectLayout.tsx:176-208）⇒ 同 key 双注册
//     会让其中一个模式**永久失去**该面板，且谁生效取决于 glob 挂载顺序（auto → manual）。
//   · `settings` 区 `'ai-config'`：AI 设置已回归 kernel（983b999；
//     apps/web/src/pages/SettingsPage.tsx:238-249 全模式渲染 <AIConfigPanel/>）。
//     插件再注册 'ai' 区会被**追加**在其后 ⇒ auto 模式出现两份「AI 设置」。
//   两者若日后需要恢复，必须先改宿主标准（恢复渲染位 / 撤掉 kernel 面板），
//   不要在本模块单方面加回。auto 模式自有的对话界面由 AutoWriteWorkbench 承载。
//
// ★ 已裁（2026-10-14 清理批）：`chatRail` 注册**已删除**。该扩展点在 Dock 重构
//   （3e3754e）后已无任何宿主消费点（apps/web/src 全仓无读取 chatRail 的代码），
//   原注册是死注册。孤儿组件 `discuss/AiChatBubbleRail.tsx` 保留在模块内（不产生
//   契约面），等 chatRail 在内核定生死；`preload()` 里的预取一并移除。
//
// 本入口由 main.tsx 的 import.meta.glob 自动收集
//   （'../../../apps/plugins/auto/*/web/index.tsx'）—— 目录即模式事实来源。
// ============================================================

import React from 'react';
import {
  Workflow, ClipboardList, Network, ShieldCheck, Wand2, BookOpenText,
} from 'lucide-react';
import type { WebPluginContext } from '@novel/core/web';
import type { FloatingPanelDef } from '@/plugin/types';
// 红石开关面（D43）：与 scanService 同属 ai.scan 能力，静态 import 保持 store 单例
import { useAIRedstoneStore } from '../stores/aiRedstoneStore';
// D44 / 设计 §4-C2：把 auto 的内存态自清注册到 shared 的注册点。
//   —— shared 不再静态 import 本模块的 chatHistoryStore；改由本模块「主动注册」。
//   模块内 import 自己的 store 属模块内依赖，不产生 shared→auto 跨域边。
import { useChatHistoryStore } from '../stores/chatHistoryStore';
import { registerLocalDataCleaner } from '@novel-plugins/data-core';

// ---- 懒加载（保持 chunk 分割：three.js / 图谱面板不进主包）----
const PipelineGraphPanel = React.lazy(() =>
  import('./pipeline/PipelineGraphPanel').then((m) => ({ default: m.PipelineGraphPanel })));
const ChapterPlanGraphPanel = React.lazy(() =>
  import('./pipeline/ChapterPlanGraphPanel').then((m) => ({ default: m.ChapterPlanGraphPanel })));
const MemoryGraphPanel = React.lazy(() =>
  import('./memory/MemoryGraphPanel').then((m) => ({ default: m.MemoryGraphPanel })));
const SkillLibraryPanel = React.lazy(() =>
  import('./skills/SkillLibraryPanel').then((m) => ({ default: m.SkillLibraryPanel })));
const EntityOverviewPanel = React.lazy(() =>
  import('./entities/EntityOverviewPanel').then((m) => ({ default: m.EntityOverviewPanel })));
const ManuscriptPanel = React.lazy(() =>
  import('./manuscript/ManuscriptPanel').then((m) => ({ default: m.ManuscriptPanel })));

const AutoWriteWorkbench = React.lazy(() =>
  import('./discuss/AutoWriteWorkbench').then((m) => ({ default: m.AutoWriteWorkbench })));

export const name = 'novel.auto.workbench';
// ★ 2026-10-13 对标：去掉 'builtinBubble'（不再注册任何 builtin 面板槽）与
//   'settings'（AI 设置已回归 kernel，不再注册设置区）。
// ★ 2026-10-14 清理批 A1：再去掉 'chatRail'（Dock 重构后无宿主消费点，注册是死注册）。
//   注意：**保留 'capability'** —— A4/A5（红石开关归属）已按 Chief 建议拆出本批，
//   auto 仍真注册 3 个 capability（见 apply() 第 3 步），故此注入项仍必需。
export const inject = ['projectPanels', 'workbench', 'capability'];

/** AI 写作工作台面板定义（与原 plugin/autoBuiltin.ts 完全一致） */
export const AUTO_WORKBENCH_PANELS: FloatingPanelDef[] = [
  { key: 'pipeline', label: '流水线', icon: Workflow, group: 'live', Component: PipelineGraphPanel, modes: ['auto'] },
  { key: 'chapterPlan', label: '本章计划', icon: ClipboardList, group: 'live', Component: ChapterPlanGraphPanel, modes: ['auto'] },
  { key: 'entities', label: '实体与设定', icon: Network, group: 'data', Component: EntityOverviewPanel, modes: ['auto'] },
  { key: 'memory', label: '记忆审计', icon: ShieldCheck, group: 'data', Component: MemoryGraphPanel, modes: ['auto'] },
  { key: 'skills', label: '技能库', icon: Wand2, group: 'data', Component: SkillLibraryPanel, modes: ['auto'] },
  // 正文阅读：写出来的章节得能直接在界面上读（此前只能翻库/脚本，质量问题看不见）
  { key: 'manuscript', label: '正文阅读', icon: BookOpenText, group: 'data', Component: ManuscriptPanel, modes: ['auto'] },
];

export function apply(ctx: WebPluginContext): void {
  // 0) D44 / 设计 §4-C2：把 auto 的内存态自清**注册**到 shared 的清理点。
  //    shared 侧不再静态 import 本模块的 chatHistoryStore（那是 shared→auto 跨域边，
  //    auto 缺席时会让 shared 树带上悬空依赖）；改为 auto 在场时主动登记，
  //    使 clearAllLocalUserData()/clearProjectLocalData() 能连带清掉 auto 的内存态。
  //    auto 缺席 ⇒ 无此登记 ⇒ shared 照常执行且不抛错（只清 localStorage 键）。
  //    方向为 module→shared（`@novel-plugins/data-core`），不产生跨域边。
  ctx.effect(() => registerLocalDataCleaner((projectId: string | null) => {
    const store = useChatHistoryStore.getState();
    if (projectId === null) store.clearAll();
    else store.removeProject(projectId);
  }), 'auto-workbench: chat history cleaner');

  // 1) 6 个 AI 工作台面板
  for (const panel of AUTO_WORKBENCH_PANELS) ctx.registerProjectPanel(panel);

  // 2) ★ 已删（2026-10-14 清理批 A3）：原 `ctx.registerChatRail({ key:'ai-chat-rail', … })`
  //    —— chatRail 在 Dock 重构（3e3754e）后无宿主消费点，注册即死值。
  //    孤儿组件 `discuss/AiChatBubbleRail.tsx` 保留（见文件头注释）。

  // 3) AI 写作工作台壳（未注册 → auto 项目回退通用空态，manual 完全不受影响）
  ctx.registerWorkbench({
    key: 'autowrite',
    modes: ['auto'],
    Component: AutoWriteWorkbench,
  });

  // 4) AI 能力（D43：红石开关面并入 ai.scan，不单列契约名）
  //    动态 import：仅在能力被真正调用时加载 auto 的服务实现。
  //
  //    ⚠ 同名双 provider 待裁决：novel.manual.workbench 自 9772c8f 起也注册了
  //      ai.scan / ai.timelineExtract / ai.quickPhrases 三个同名能力
  //      （apps/plugins/manual/workbench/web/ai/aiCapabilityProvider.ts:277-279）。
  //      能力不按模式隔离、同 name 后写覆盖 ⇒ 谁生效取决于挂载顺序。
  //      本模块的实现含真实红石开关 store 与 scanService（manual 侧为兜底版），
  //      建议裁决为「本模块提供、manual 侧退为缺席兜底」，但需产品确认后再动对手方。
  ctx.registerCapability('ai.quickPhrases', {
    generate: async (content: string, characters: unknown[]) => {
      const { generateQuickPhrases } = await import('./discuss/services/quickPhraseService');
      return generateQuickPhrases(content, characters as never);
    },
  });

  ctx.registerCapability('ai.timelineExtract', {
    extractEventsByKeyword: async (...args: unknown[]) => {
      const { scanService } = await import('./entities/services/scanService');
      return (scanService.extractEventsByKeyword as unknown as (...a: unknown[]) => Promise<void>)(...args);
    },
  });

  ctx.registerCapability('ai.scan', {
    scanTimelineStream: async (...args: unknown[]) => {
      const { scanService } = await import('./entities/services/scanService');
      return (scanService.scanTimelineStream as unknown as (...a: unknown[]) => Promise<never>)(...args);
    },
    extractEventsByKeyword: async (...args: unknown[]) => {
      const { scanService } = await import('./entities/services/scanService');
      return (scanService.extractEventsByKeyword as unknown as (...a: unknown[]) => Promise<void>)(...args);
    },
    // ---- 红石开关面（同属 ai.scan）----
    isScannerEnabled: () => useAIRedstoneStore.getState().features.scanner,
    isExtractEnabled: () => useAIRedstoneStore.getState().features.extract,
    registerAbort: (feature: string, controller: AbortController) =>
      useAIRedstoneStore.getState().registerAbort(feature as never, controller),
    subscribeRedstone: (cb: () => void) => useAIRedstoneStore.subscribe(cb),
  });
}

// ------------------------------------------------------------------
// kernel 惰性引用的公开导出（D35/D37）：消 ProjectLayout 的 auto 侧静态 import
// ------------------------------------------------------------------
export { AutoWriteWorkbench } from './discuss/AutoWriteWorkbench';
// ★ D46：SkillsBar 为 auto 侧**容器**（数据接线 + 纯展示层），QuickPromptsBar 的展示层已下沉 ui-kit
//   —— 两者仍经本模块公开入口导出，外部引用路径不变
export { ChatPanel, SkillsBar, QuickPromptsBar } from './discuss/ChatPanel';
export type { ChatPanelControlProps } from './discuss/ChatPanel';

/**
 * 面板级预取入口（kernel 经 `loadModulePreload('auto')` 在空闲时间片调用）。
 *
 * ★ 2026-10-13 补齐（对标 manual 大模块的同名导出；kernel 契约见
 *   `apps/web/src/plugin/moduleEntries.ts:112`）：
 *   本模块的停靠面板与工作台壳全是**模块内相对路径**的懒加载，kernel 的
 *   `PRELOAD_ON_PATH` / `ALL_ROUTE_LOADERS` 看不见它们 —— 预取内容因此留在模块里。
 *   未导出时 kernel 显式容许（`if (typeof mod.preload !== 'function') return;`），
 *   导出后进项目首屏稳定即预热，开面板不再现下载。
 *   说明符与 `apply()` 的注册项**逐一同源**（与 manual 入口同约定：改一处要改两处）。
 */
export function preload(): void {
  // 工作台壳（auto 项目进项目后最先渲染的就是它）
  void import('./discuss/AutoWriteWorkbench').catch(() => {});
  // 6 个停靠面板
  void import('./pipeline/PipelineGraphPanel').catch(() => {});
  void import('./pipeline/ChapterPlanGraphPanel').catch(() => {});
  void import('./entities/EntityOverviewPanel').catch(() => {});
  void import('./memory/MemoryGraphPanel').catch(() => {});
  void import('./skills/SkillLibraryPanel').catch(() => {});
  void import('./manuscript/ManuscriptPanel').catch(() => {});
}
