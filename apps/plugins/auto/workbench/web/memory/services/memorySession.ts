// ============================================================
// 记忆审计 / 冲突 —— 前端客户端
//
// 对接插件路由：
//   GET  /api/plugins/autowrite/memory                     读审计 + 冲突 + 各角色 L2 条数
//   POST /api/plugins/autowrite/memory/conflicts/resolve    裁掉一条冲突
//
// 设计见 docs/architecture/multi-agent-memory-architecture.md §8.3：这些数据以前只能查库看，
// 现在给它一个面 —— **可信的隔离需要看得见**（看不见的审计等于没有）。
// ============================================================

import { apiClient } from '@novel-plugins/data-core/api/apiClient';

export interface MemoryAuditRow {
  id: string;
  agentId: string;
  /** read_l1 | deny_l1 | write_l2 | ingest | conflict */
  action: string;
  reason: string | null;
  allow: boolean;
  keys: unknown[];
  detail: string | null;
  at: number;
}

export interface MemoryConflict {
  id: string;
  slot: string;
  existing: string | null;
  incoming: string | null;
  source: string | null;
}

export interface MemoryAgentStat {
  agentId: string;
  /** 经历流条数（L2-N） */
  said: number;
  /** 事实引用条数（L2-F） */
  factRef: number;
  /** 它**自己的水车**斗位（斗 1 最新）—— 即"这个角色现在记得哪几章" */
  wheel: number[];
  /** 已出界并压成一句话的章号（沉在它自己的长期池） */
  summaries: number[];
}

export interface MemoryView {
  available: boolean;
  audit: MemoryAuditRow[];
  conflicts: MemoryConflict[];
  agents: MemoryAgentStat[];
}

/** 读记忆视图（X-Project-Id 由 apiClient 自动带 —— 裸 fetch 才需要手补；信封也由它拆） */
export async function fetchMemoryView(): Promise<MemoryView> {
  return apiClient.get<MemoryView>('/plugins/autowrite/memory');
}

export type ConflictDecision = 'keep' | 'accept' | 'drop';

/** 裁决一条冲突：keep=以库中既有值为准 / accept=以本批新值为准 / drop=两边都不算 */
export async function resolveConflict(
  id: string,
  decision: ConflictDecision = 'keep',
  note = '',
): Promise<{ needResink: boolean; hint: string }> {
  return apiClient.post('/plugins/autowrite/memory/conflicts/resolve', { id, decision, note });
}

/** 动作 → 人话（面板别直接显示枚举） */
export const ACTION_LABEL: Record<string, string> = {
  assemble: '装配',
  read_l1: '读全局',
  deny_l1: '被拒',
  write_l2: '写私记',
  ingest: '沉淀',
  conflict: '冲突',
};

/** reason → 人话（这几个值是枚举，不许乱写） */
export const REASON_LABEL: Record<string, string> = {
  'discuss-context': '讨论装配',
  'continuity-check': '核对出处',
  'assemble-before-write': '落笔前装配',
  'gate-review': '门禁复核',
  'recall-by-need': '按需回读',
  ingest: '沉淀',
};
