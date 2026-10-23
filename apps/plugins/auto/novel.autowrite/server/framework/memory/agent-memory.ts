// ============================================================
// 分层记忆 · L2 智能体专属记忆句柄
//
// 隔离的**三重保证**（架构 §3）：
//   ① 物理：所有键在 `agent_memory` 表里带 `agent_id` 列，且查询/写入的 agentId
//      **只从句柄取**，不接受调用方传 —— 想构造别人的键？没有入口
//   ② 类型：本接口**没有** `writeGlobal`、没有 `readOther` —— 越权代码编不过
//   ③ 运行期：`assertSameAgent` 拦下"拿着别人的条目来写"（反序列化对象里带 agentId 的场景）
//
// 读 L1 必须走 `queryL1({keys, reason})`：闸门会校验白名单并记账。
// ============================================================

import { schema, eq, and, type DrizzleDb } from '@novel/db';
import type { ServerPluginContext } from '@novel/core';
import { nowId } from '../text.js';
import { MemoryGate, type GateDecision } from './gate.js';
import { writeAudit } from './gate.js';
import type { Experience, FactRef, L1ReadReason, MemoryForm } from './types.js';

/** 跨智能体写入的守卫（导出让单测直接验这条不变量） */
export function assertSameAgent(selfId: string, targetId: string | undefined): void {
  if (targetId && targetId !== selfId) {
    throw new Error(`[memory] 跨智能体写被拒：self=${selfId} target=${targetId}`);
  }
}

export interface MemoryItem<T = unknown> {
  form: MemoryForm;
  key: string;
  value: T;
  sourceRef?: string;
}

export interface AgentMemoryHandle {
  /** 只读，外部改不了 —— 句柄自证身份 */
  readonly agentId: string;
  /** 读自己的（**只有自己**） */
  readOwn<T = unknown>(key: string, form?: MemoryForm): Promise<MemoryItem<T> | null>;
  /** 写自己的（`item` 里若带别人的 agentId → 抛） */
  writeOwn(item: MemoryItem & { agentId?: string }): Promise<void>;
  /** 列自己的某式全部条目（经历流按需取用） */
  listOwn(form?: MemoryForm): Promise<Array<MemoryItem>>;
  /** 读 L1：走闸门，带具名 reason，返回放行结果（**不含**任何 L2 内容） */
  queryL1(args: { keys: string[]; reason: L1ReadReason; narrative?: boolean }): Promise<GateDecision>;
}

export function createAgentMemory(args: {
  ctx: ServerPluginContext;
  projectId: string;
  agentId: string;
  gate: MemoryGate;
}): AgentMemoryHandle {
  const { ctx, projectId, agentId, gate } = args;
  const db = () => ctx.db.project(projectId) as DrizzleDb;

  return {
    agentId,

    async readOwn<T>(key: string, form: MemoryForm = 'fact_ref') {
      const rows = await db()
        .select()
        .from(schema.agentMemory)
        .where(and(
          eq(schema.agentMemory.agentId, agentId),   // ★ 只能是自己的
          eq(schema.agentMemory.form, form),
          eq(schema.agentMemory.key, key),
        ))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return { form: row.form as MemoryForm, key: row.key, value: JSON.parse(row.value) as T, sourceRef: row.sourceRef ?? undefined };
    },

    async listOwn(form: MemoryForm = 'experience') {
      const rows = await db()
        .select()
        .from(schema.agentMemory)
        .where(and(eq(schema.agentMemory.agentId, agentId), eq(schema.agentMemory.form, form)));
      return rows.map((r) => ({
        form: r.form as MemoryForm, key: r.key, value: JSON.parse(r.value) as unknown, sourceRef: r.sourceRef ?? undefined,
      }));
    },

    async writeOwn(item) {
      assertSameAgent(agentId, item.agentId);   // ★ 防线③
      await db()
        .insert(schema.agentMemory)
        .values({
          id: nowId(),
          projectId,
          agentId,                                 // ★ 永远是句柄自己的
          form: item.form,
          key: item.key,
          value: JSON.stringify(item.value),
          sourceRef: item.sourceRef ?? null,
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.agentMemory.agentId, schema.agentMemory.form, schema.agentMemory.key],
          set: { value: JSON.stringify(item.value), sourceRef: item.sourceRef ?? null },
        });
      await writeAudit(ctx, {
        projectId, agentId, action: 'write_l2', keys: [item.key], allow: true, detail: item.form,
      });
    },

    async queryL1({ keys, reason, narrative }) {
      // strict：查"一条具体事实"时，越界说明调用方搞错了角色或键 —— 显式失败比静默少给更安全
      return gate.authorize({ projectId, agentId, keys, reason, narrative, mode: 'strict' });
    },
  };
}

/** 便捷构造器：事实引用条目（**存指针**，不存事实副本） */
export function factRef(key: string, ref: FactRef): MemoryItem<FactRef> & { agentId?: string } {
  return { form: 'fact_ref', key, value: ref, sourceRef: ref.factId };
}

/** 便捷构造器：经历条目（叙事式，只能被引用） */
export function experience(key: string, exp: Experience): MemoryItem<Experience> & { agentId?: string } {
  return { form: 'experience', key, value: exp, sourceRef: exp.ref };
}
