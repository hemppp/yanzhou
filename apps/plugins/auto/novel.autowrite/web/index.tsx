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
// ★ 2026-11-03 清理：失去唯一用途的 `web/chat-wheel.tsx` 已删除（chatRail 仍无消费点）。
//
// ★ 2026-09-28：panel.tsx（含从未注册的 AutowritePanel / AutowriteSkillRail）
//   已随旧批次流水线一并删除；仍在用的 setApiFetch 迁到 api.ts。
//   `auto-write` flow 型技能已删，其图标一并移除；`projectPanels` 注入已无用途，去掉。
// ============================================================

import {
  Users, Lightbulb, Activity, Globe, MessageSquare, Network, PenTool, BookOpen,
  Shield, History, Gauge, Eye, TrendingUp, User, Layers, Feather,
  // ★ 2026-11-01 补：这 5 门此前**没有图标**，界面上走 Puzzle 兜底
  //   （注册表 21 门、图标只有 16 门 —— 后加的 5 门漏了）
  Footprints, Repeat2, Flag, AlignLeft, Sparkles,
} from 'lucide-react';
import type { WebPluginContext } from '@novel/core/web';
import { setApiFetch } from './api.js';

export const name = 'novel.autowrite';
export const inject = ['skills', 'api'];

export function apply(ctx: WebPluginContext): void {
  // ★ 带鉴权 API：经 ctx.api（自动带 JWT/项目头）
  setApiFetch(ctx.api);

  // ── 不注册 projectPanel / chatRail ──
  //   前者会让手写框架重新出现「自动写作」入口，把两套框架混在一起；
  //   后者在 Dock 重构后已无宿主消费点（注册即死值）。两者都不要加回。

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
    // ★ 2026-10-31：从 ai-fiction-writer 提取的 8 门方法论技能
    'logic-prevention': Shield,
    'era-authenticity': History,
    'chapter-quality-audit': Gauge,
    'four-perspective-review': Eye,
    'hook-emotion-curve': TrendingUp,
    'character-craft': User,
    'worldbuilding-layers': Layers,
    'prose-discipline': Feather,
    // ★ 2026-11-01 补：后加 5 门漏了图标（此前走宿主 Puzzle 兜底，21 门里显示得残缺）
    'plot-advance-review': Footprints,
    'voice-dup-review': Repeat2,
    'scene-outcome': Flag,
    'chapter-opening': AlignLeft,
    'de-ai-prose': Sparkles,
  });
}
