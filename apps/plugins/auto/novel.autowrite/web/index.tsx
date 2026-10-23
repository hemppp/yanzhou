// ============================================================
// 自动写作引擎插件 —— Web 面
//
// ★ 2026-09-11「双模块分离」：本插件**不再注册手写框架的浮窗面板**。
//   手写（manual）与 AI 写作（auto）自此是两个互斥模块：
//     · 手写侧只保留 AI 对话与它的技能，不再有「自动写作」入口
//     · AI 写作侧由宿主工作台（AutoWriteWorkbench）承载，不依赖气泡面板
//
// 仍然注册：
//   1. 技能图标（registerSkillIcons）—— 技能内容归插件所有，保留
//
// ★ 2026-10-14 清理批 C1–C4：chatRail 注册**已删**（Dock 重构 3e3754e 后无宿主消费点）。
//   孤儿组件 `web/chat-wheel.tsx` 保留在模块内（不产生契约面），等 chatRail 定生死。
//
// ★ 2026-09-28：panel.tsx（含从未注册的 AutowritePanel / AutowriteSkillRail）
//   已随旧批次流水线一并删除；仍在用的 setApiFetch 迁到 api.ts。
//   `auto-write` flow 型技能已删，其图标一并移除；`projectPanels` 注入已无用途，去掉。
// ============================================================

import {
  Users, Lightbulb, Activity, Globe, MessageSquare, Network, PenTool, BookOpen,
} from 'lucide-react';
import type { WebPluginContext } from '@novel/core/web';
import { setApiFetch } from './api.js';

export const name = 'novel.autowrite';
export const inject = ['skills', 'api'];

export function apply(ctx: WebPluginContext): void {
  // ★ 带鉴权 API：经 ctx.api（自动带 JWT/项目头）
  setApiFetch(ctx.api);

  // ── 已移除：registerProjectPanel({ key: 'autowrite', label: '自动写作' }) ──
  //   手写框架不再提供自动写作入口。AI 写作是独立模块，有自己的工作台；
  //   在手写模式下露出这个入口会让两套框架重新混在一起。

  // ★ 已删（2026-10-14 清理批 C3）：原 `ctx.registerChatRail({ key:'novel.autowrite:chat-wheel', … })`
  //   —— chatRail 在 Dock 重构（3e3754e）后无宿主消费点，注册即死值。

  // ── 技能选择器图标（key = 技能 id；未注册的技能走宿主 Puzzle 兜底）──
  ctx.registerSkillIcons({
    'character-analyst': Users,
    'foreshadow-tracker': Lightbulb,
    'rhythm-doctor': Activity,
    'worldbuilder': Globe,
    'dialogue-polisher': MessageSquare,
    'plot-architect': Network,
    'continue-writer': PenTool,
    'outline-architect': BookOpen,
  });
}
