// ============================================================
// 自动写作引擎插件 —— Server 面
//
// 写作技能框架（docs/architecture/ai-writing-architecture.md）：
//   1. 注册 8 个聊天型技能（自核心 skills.ts 剥离，内容归插件所有）
//   2. 状态/流水线路由（现役：/session 单章闭环 + /pipeline 多智能体流水线）
//   3. 状态全部存插件 KV（项目隔离），零迁移依赖
//
// ⚠️ 2026-09-28：已删除**旧批次流水线**（`server/autowrite/*` 的 8 个流程工具 +
//    `auto-write` flow 型技能 + `FlowStore` + `/batches` 路由）。它自 2026-09-12 起
//    与现役链路脱节、UI 也不再注册；其审计台账能力已迁到 `pipeline_runs`
//    （`GET /api/plugins/autowrite/pipeline/runs`）。被现役链路共用的纯函数
//    （JSON 解析 / 字数 / nowId）与两道门提示词已分别迁到 `framework/text.ts` /
//    `framework/gates-prompts.ts`。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { CHAT_SKILLS } from './skills/index.js';
import { createAutowriteRouter } from './routes.js';
import { isDecisionEnabled, resolveJevConfig, resolveChatDecisionModel } from './framework/gate-decision.js';

export const name = 'novel.autowrite';
export const inject = ['routes', 'db', 'ai'];

export function apply(ctx: ServerPluginContext): void {
  // ── 1. 聊天型技能（剥离内容，直通宿主注册表）──
  for (const def of CHAT_SKILLS) {
    ctx.effect(() => ctx.ai.skills.register(def), `autowrite: skill ${def.id}`);
  }

  // ── 2. 状态路由（/session 单章闭环 + /pipeline 多智能体流水线）──
  ctx.effect(
    () => ctx.routes.register('/api/plugins/autowrite', createAutowriteRouter(ctx)),
    'autowrite: routes',
  );

  ctx.logger.info(`自动写作引擎已挂载（${CHAT_SKILLS.length} 个技能 + 状态/流水线路由）`);
  // ── 3. 意图门决策器（可选增强）启用状态 —— 启动时打一行，排查"决策器到底开没开" ──
  if (isDecisionEnabled()) {
    const jev = resolveJevConfig();
    const chat = resolveChatDecisionModel();
    const how = jev ? `Jev 原生 ${jev.model} @ ${jev.url}` : `chat 兜底 ${String(chat)}`;
    ctx.logger.info(`意图门决策器已启用（${how}）；不可用时自动回退硬规则`);
  } else {
    ctx.logger.info('意图门决策器未启用（设 AUTOWRITE_JEV_URL 或 AUTOWRITE_DECISION_MODEL 开启）');
  }
}
