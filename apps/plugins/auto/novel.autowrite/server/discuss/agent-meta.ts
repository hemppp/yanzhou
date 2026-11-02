// ============================================================
// 讨论发言的**显示元信息**（名字 / 头像字 / 颜色）—— 给"讨论时间线"回看用
//
// 为什么需要它：
//   讨论**已经落库**（`agent_memory` 的 `exp.stage.<段>.turn<N>` 与 `exp.ch<N>.turn<M>`），
//   但库里只存 `agent_id`（如 `plot-designer`）—— 要还原成"谁说了什么"，
//   就得把 id 映射回显示信息。否则回看界面只能显示一串英文 key。
//
// 纪律：这里**只做汇总**，不新造任何信息 —— 名字/头像字/颜色一律取自各角色的定义处
//   （`discuss/roles.ts` / `pipeline/roles-phase.ts` / `pipeline/supervise-review.ts`），
//   避免又多一份会随角色改名而漂移的副本（段列表漂移那个 bug 就是同一类问题）。
// ============================================================

import {
  ROLE_PLOT, ROLE_CHARACTER, ROLE_CONTINUITY, ROLE_CONVENER, ROLE_WRITER, ROLE_REVIEWER,
  type DesignRole,
} from './roles.js';
import { ROLE_WORLD, ROLE_PREMIERE, ROLE_SUPERVISOR } from '../pipeline/roles-phase.js';
import {
  ROLE_PLOT_ADVANCE_REVIEW, ROLE_VOICE_DUP_REVIEW, ROLE_SUPERVISOR_GATE,
} from '../pipeline/supervise-review.js';

export interface AgentMeta {
  name: string;
  short: string;
  color: string;
}

/** 所有可能出现在记忆流里的角色（讨论层 + 流水线层 + 监工层） */
const ALL_KNOWN_ROLES: DesignRole[] = [
  ROLE_PLOT, ROLE_CHARACTER, ROLE_CONTINUITY, ROLE_CONVENER, ROLE_WRITER, ROLE_REVIEWER,
  ROLE_WORLD, ROLE_PREMIERE, ROLE_SUPERVISOR,
  ROLE_PLOT_ADVANCE_REVIEW, ROLE_VOICE_DUP_REVIEW, ROLE_SUPERVISOR_GATE,
];

export const AGENT_META: Readonly<Record<string, AgentMeta>> = Object.fromEntries(
  ALL_KNOWN_ROLES
    .filter((r) => r && r.key)
    .map((r) => [r.key, { name: r.name, short: r.short, color: r.color } satisfies AgentMeta]),
);

/** 未知 id 的兜底（老数据 / 新角色还没登记）：仍然显示出来，不吞掉发言 */
export function metaOf(agentId: string): AgentMeta {
  return AGENT_META[agentId] ?? { name: agentId, short: '?', color: '#666' };
}
