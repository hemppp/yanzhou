// ============================================================
// 插件自有智能体的「技能目标」声明（ctx.ai.skillTargets.declare）
//
// 为什么需要这个文件：
//   技能要标 `ownerAgent`，而「智能体 Skills」界面左列只列出**已声明**的智能体。
//   宿主静态清单（apps/server/src/ai/agents/skill-targets.ts）只有 8 个核心 agent，
//   **不含**本插件独有的 4 个：supervisor / supervisor-gate /
//   plot-advance-reviewer / voice-dup-reviewer。
//
//   后果（修复前的真实状态）：`plot-advance-review`、`voice-dup-review`、
//   `scene-outcome` 三门技能的 ownerAgent 指向未声明 id → 被判为 **orphan** →
//   在界面上永远看不见，且 `scripts/verify/verify-skill-library.mjs` 的
//   「归属到未声明智能体的孤儿为 0」断言直接失败。
//
// ★ 只声明宿主**缺**的那 4 个，不重复声明核心 agent。
//   原因：宿主的 `undeclareSkillTarget` 是**按 id 删除**（skill-targets.ts:46）——
//   若我们 declare 了 `writer`（覆盖核心条目），插件卸载时会把核心那条一起删掉。
//
// ★ 元信息一律取自各角色的定义处（DesignRole 的 key/name/short/color），
//   不在这里抄第二份 —— 否则角色改名时两边会漂移（段列表漂移那个 bug 就是同一类问题）。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { ROLE_SUPERVISOR } from '../pipeline/roles-phase.js';
import {
  ROLE_PLOT_ADVANCE_REVIEW,
  ROLE_VOICE_DUP_REVIEW,
  ROLE_SUPERVISOR_GATE,
} from '../pipeline/supervise-review.js';

/** 界面分组名，与宿主核心 `WRITING_AGENTS` 的 group 保持一致 */
const GROUP = '写作流水线';

interface OwnedAgent {
  id: string;
  name: string;
  short: string;
  color: string;
  description: string;
}

/**
 * 插件自有的、宿主静态清单里没有的智能体。
 * description 是唯一本地没有对应字段的项（DesignRole 不带一句话职责），在此写死。
 */
export const PLUGIN_OWNED_AGENTS: OwnedAgent[] = [
  {
    id: ROLE_SUPERVISOR.key,
    name: ROLE_SUPERVISOR.name,
    short: ROLE_SUPERVISOR.short,
    color: ROLE_SUPERVISOR.color,
    description: '交付后逐章巡检长篇质量，只读不改稿',
  },
  {
    id: ROLE_SUPERVISOR_GATE.key,
    name: ROLE_SUPERVISOR_GATE.name,
    short: ROLE_SUPERVISOR_GATE.short,
    color: ROLE_SUPERVISOR_GATE.color,
    description: '落库前最后一道闸：汇总两位帮手，决定放行或打回',
  },
  {
    id: ROLE_PLOT_ADVANCE_REVIEW.key,
    name: ROLE_PLOT_ADVANCE_REVIEW.name,
    short: ROLE_PLOT_ADVANCE_REVIEW.short,
    color: ROLE_PLOT_ADVANCE_REVIEW.color,
    description: '只审一件事：这一章有没有让故事往前走',
  },
  {
    id: ROLE_VOICE_DUP_REVIEW.key,
    name: ROLE_VOICE_DUP_REVIEW.name,
    short: ROLE_VOICE_DUP_REVIEW.short,
    color: ROLE_VOICE_DUP_REVIEW.color,
    description: '只审文字层：口头禅、句式雷同、重复景物、章风断层',
  },
];

/**
 * 声明插件自有智能体。注册清理器，插件卸载时逐个撤销。
 *
 * 为什么用 `ctx.effect`：与 `skills.register` 同一模式 —— 卸载时逆序清理，
 * 否则热重载会残留上一次的声明。
 */
export function declarePluginSkillTargets(ctx: ServerPluginContext): void {
  for (const agent of PLUGIN_OWNED_AGENTS) {
    ctx.effect(
      () => ctx.ai.skillTargets.declare({ ...agent, kind: 'agent', group: GROUP }),
      `autowrite: skill target ${agent.id}`,
    );
  }
}
