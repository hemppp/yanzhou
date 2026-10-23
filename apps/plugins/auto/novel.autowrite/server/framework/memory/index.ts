// ============================================================
// 分层记忆 · 出口
//
// 单点真相在 `discuss/roles.ts` 的 `memory` 字段 —— 本文件只做查表，
// 不在别处再抄一份权限表（抄一份就等着漂移）。
// ============================================================

export * from './types.js';
export { MemoryGate, writeAudit, fingerprintOf, type GateDecision, type GateAuditInput } from './gate.js';
export {
  createAgentMemory, assertSameAgent, factRef, experience,
  type AgentMemoryHandle, type MemoryItem,
} from './agent-memory.js';
export * from './waterwheel.js';
export * from './wheel-store.js';
export * from './ingest.js';

import type { ServerPluginContext } from '@novel/core';
import {
  ROLE_PLOT, ROLE_CHARACTER, ROLE_CONTINUITY, ROLE_CONVENER, ROLE_WRITER, ROLE_REVIEWER,
} from '../../discuss/roles.js';
// ★ 流水线阶段角色（策划官 / 前三章审阅 / 写作监工）也在讨论里发言，必须一并登记 ——
//   漏登记就是 fail-closed：它们会读到**空的项目现状**（策划官就靠那份现状立世界规则）。
import { ROLE_WORLD, ROLE_PREMIERE, ROLE_SUPERVISOR } from '../../pipeline/roles-phase.js';
import { MemoryGate, type RolePolicyLookup } from './gate.js';
import type { RoleMemoryPolicy } from './types.js';

const ALL_MEMORY_ROLES = [
  ROLE_PLOT, ROLE_CHARACTER, ROLE_CONTINUITY, ROLE_CONVENER, ROLE_WRITER, ROLE_REVIEWER,
  ROLE_WORLD, ROLE_PREMIERE, ROLE_SUPERVISOR,
];

const POLICY_TABLE: Record<string, RoleMemoryPolicy | undefined> = Object.fromEntries(
  ALL_MEMORY_ROLES.map((r) => [r.key, r.memory]),
);

/** 查某角色的记忆策略；**未声明 → undefined → 闸门 fail-closed** */
export const rolePolicyLookup: RolePolicyLookup = (agentId) => POLICY_TABLE[agentId];

/**
 * 校对门（`framework/gates.ts` 的 runConsistencyGate）—— 它**不是讨论角色**，没有 DesignRole 对象，
 * 所以策略声明在这里。它要查实体与前后文才抓得住不一致，因此给得宽；
 * 与意图复核（只对契约）是**两个不同的活**，别共用一个策略。
 */
export const PROOFREADER_POLICY: RoleMemoryPolicy = {
  readL1: ['settings.projectName', 'settings.brief', 'settings.genre', 'entity.characters.*', 'entity.locations.*', 'entity.items.*', 'outline.*', 'foreshadow.*', 'constraint.*', 'chapter.*'],
  readNarrative: true,
};

/** 编排层（不是角色）：可读全部事实式 + 叙事式，并负责唯一的 L1 写（沉淀/水车） */
export const ORCHESTRATOR_POLICY: RoleMemoryPolicy = { l1Wide: true, readNarrative: true };

/** 给编排层用的宽策略查表（角色走白名单，编排层走宽 + 记账） */
export const policyLookupWithOrchestrator: RolePolicyLookup = (agentId) => {
  if (agentId === 'orchestrator') return ORCHESTRATOR_POLICY;
  if (agentId === 'proofreader') return PROOFREADER_POLICY;
  return POLICY_TABLE[agentId];
};

/** 建闸门（业务侧标准入口） */
export function createMemoryGate(ctx: ServerPluginContext): MemoryGate {
  return new MemoryGate(ctx, policyLookupWithOrchestrator);
}

/** 所有角色的策略（面板/文档/测试用，避免又抄一份） */
export function allRolePolicies(): Array<{ agentId: string; policy?: RoleMemoryPolicy }> {
  return ALL_MEMORY_ROLES.map((r) => ({ agentId: r.key, policy: r.memory }));
}
