// ============================================================
// 手写台内置面板定义（12 个浮窗面板）
//
// 原 kernel `apps/web/src/plugin/builtin.ts`（t4 迁入模块，D1/D35）：
//   · 面板定义改由 manual 模块自持，kernel 不再静态 import 手写台内部实现
//   · 懒加载保持 chunk 分割（与原 ProjectLayout lazy import 行为一致）
//   · 全部 modes: ['manual'] —— AI 写作模式有自己的一套面板（auto 模块）
// ============================================================

import React from 'react';
import {
  BookText, StickyNote, BarChart3, AlignLeft, Clock, Users, MapPin, Lightbulb, Database,
  Network, Map, Download,
} from 'lucide-react';
import type { FloatingPanelDef } from '@/plugin/types';

// 懒加载保持 chunk 分割（模块内相对路径）
//
// ★ 2026-10-07「跳转画面会加载一下」修复：懒加载的 import() 只在**面板首次渲染**
//   那一刻才发出 ⇒ 点开面板必然先看到「加载中…」。kernel 看不到这些说明符，
//   只能在模块自己的入口空闲预取（见文件末尾 preloadPanels 与 index.tsx 的 preload）。
//   为了让「预取列表」与「React.lazy 实际加载的东西」**永远同一份**（不会各写一遍后漂移），
//   这里统一经 lazyPanel 登记：谁被 React.lazy 包装，谁就自动进入预取列表。
const panelLoaders: Array<() => Promise<unknown>> = [];

/**
 * 一个面板的「懒组件 + 预取入口」对。
 *
 * ★ 2026-10-26：`preload` 一并带出去（挂到 `FloatingPanelDef.preload`）——
 *   宿主在**悬停活动栏图标**（意图已出现、点击尚未发生）时调它，把「点击后才开始下载
 *   chunk、先闪一下加载中」变成「点击即命中模块缓存」。两者共用同一个 import()
 *   说明符（这里只登记一次），不会各写一遍后漂移。
 */
interface LazyPanelEntry<T extends React.ComponentType<any>> {
  Component: React.LazyExoticComponent<T>;
  preload: () => Promise<unknown>;
}

function lazyPanel<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyPanelEntry<T> {
  panelLoaders.push(load);
  return { Component: React.lazy(load), preload: load as () => Promise<unknown> };
}

const ReferenceReader = lazyPanel(() => import('./editor/ReferenceReader').then((m) => ({ default: m.ReferenceReader })));
const OutlinePage = lazyPanel(() => import('./outline/OutlinePage').then((m) => ({ default: m.OutlinePage })));
const CharacterManager = lazyPanel(() => import('./knowledge/CharacterManager').then((m) => ({ default: m.CharacterManager })));
const LocationManager = lazyPanel(() => import('./knowledge/LocationManager').then((m) => ({ default: m.LocationManager })));
const ItemManager = lazyPanel(() => import('./knowledge/ItemManager').then((m) => ({ default: m.ItemManager })));
const StoryMap = lazyPanel(() => import('./knowledge/StoryMap').then((m) => ({ default: m.StoryMap })));
const TimelinePage = lazyPanel(() => import('./timeline/TimelinePage').then((m) => ({ default: m.TimelinePage })));
const ForeshadowManager = lazyPanel(() => import('./foreshadow/ForeshadowManager').then((m) => ({ default: m.ForeshadowManager })));
const NoteManager = lazyPanel(() => import('./notes/NoteManager').then((m) => ({ default: m.NoteManager })));
const WritingDashboard = lazyPanel(() => import('./stats/WritingDashboard').then((m) => ({ default: m.WritingDashboard })));
const RelationGraph = lazyPanel(() => import('./knowledge/RelationGraph').then((m) => ({ default: m.RelationGraph })));
const ExportDialog = lazyPanel(() => import('./export/ExportDialog').then((m) => ({ default: m.ExportDialog })));

/**
 * 面板级预取：把 12 个面板的 chunk 一次性发出去（由模块入口的 `preload()` 调用）。
 *
 * 与 React.lazy 共用同一个 import() 说明符 ⇒ 浏览器/打包器命中同一份模块表缓存，
 * 预取过再打开面板即为**同步命中**，不再走 Suspense fallback。
 * 失败一律静默：预热坏掉绝不能影响正常打开面板。
 */
export function preloadPanels(): void {
  for (const load of panelLoaders) void load().catch(() => {});
}

/**
 * 内置面板定义（与原 kernel builtin.ts 完全一致）。
 * 12 个工作台面板均属**手写台**（modes: ['manual']）。
 *
 * ★ 2026-10-29 新增 `section`（活动栏分区标题）：手写台在这里**声明**
 *   自己每个面板属于哪一组（写作 / 资料 / 工具），宿主只按字段分组渲染。
 *   分区名与顺序的词汇表在 kernel 的 `components/shell/panelSections.ts`；
 *   这里出现的三个名字都必须能在那里找到（写错不会报错，只会被排到末尾）。
 *
 *   归属理由：「资料」= 写作时要反复翻查的世界设定与素材，
 *   「工具」= 低频的产出与检视（统计 / 图谱 / 导出）。
 */
export const BUILTIN_PANELS: FloatingPanelDef[] = [
  { icon: BookText, label: '参考书', key: 'reference', section: '资料', Component: ReferenceReader.Component, preload: ReferenceReader.preload, width: 560, height: 800, modes: ['manual'] },
  { icon: StickyNote, label: '笔记', key: 'notes', section: '资料', Component: NoteManager.Component, preload: NoteManager.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: BarChart3, label: '统计', key: 'stats', section: '工具', Component: WritingDashboard.Component, preload: WritingDashboard.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: AlignLeft, label: '大纲', key: 'outline', section: '资料', Component: OutlinePage.Component, preload: OutlinePage.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: Clock, label: '时间线', key: 'timeline', section: '资料', Component: TimelinePage.Component, preload: TimelinePage.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: Users, label: '角色', key: 'characters', section: '资料', Component: CharacterManager.Component, preload: CharacterManager.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: MapPin, label: '地点', key: 'locations', section: '资料', Component: LocationManager.Component, preload: LocationManager.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: Lightbulb, label: '伏笔', key: 'foreshadows', section: '资料', Component: ForeshadowManager.Component, preload: ForeshadowManager.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: Database, label: '物品', key: 'items', section: '资料', Component: ItemManager.Component, preload: ItemManager.preload, width: 900, height: 800, modes: ['manual'] },
  // ★ 关系图是「重画布」面板：打开时**抢占中心编辑区**（ADR §1.6）——
  //   声明 `dock:{ center: true, slot: 'center' }` ⇒ DockShell 把它渲染到中心替换槽，
  //   而不是挤进右侧辅助侧栏（900×800 的图谱在侧栏里没法用）。
  //   `center` 是显式布尔（裁定见 ADR §1.4），`slot:'center'` 只是建议落位，二者分工不同。
  { icon: Network, label: '关系图', key: 'relationGraph', section: '工具', Component: RelationGraph.Component, preload: RelationGraph.preload, width: 900, height: 800, modes: ['manual'], dock: { center: true, slot: 'center' } },
  { icon: Map, label: '地图', key: 'storyMap', section: '资料', Component: StoryMap.Component, preload: StoryMap.preload, width: 900, height: 800, modes: ['manual'] },
  { icon: Download, label: '导出', key: 'export', section: '工具', Component: ExportDialog.Component, preload: ExportDialog.preload, width: 800, height: 700, modes: ['manual'] },
] as FloatingPanelDef[];
