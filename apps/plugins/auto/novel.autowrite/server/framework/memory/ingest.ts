// ============================================================
// 分层记忆 · 沉淀（L1 事实式的**唯一**写通道）
//
// 为什么单独一层：`entity-sink` 已经是"交付成功后才落库"的唯一写通道，
// 本文件在那之上补两件防污染的守卫：
//
//   ① **批次内去重**：同一槽位在**同一批次**里给出两个不同值 —— 这是模型自相矛盾，
//      不是剧情演进（跨章的值变化是正常的）。两条都不写，进冲突队列等人裁。
//   ② **冲突队列**：`fact_conflicts` 只增不改，谁想覆盖谁就得先把它解掉。
//
// 反面（明确不做）：不做"新值自动覆盖旧值" —— 那正是记忆污染的经典入口。
// ============================================================

import { schema, eq, and, type DrizzleDb } from '@novel/db';
import type { ServerPluginContext } from '@novel/core';
import { nowId } from '../text.js';
import { writeAudit } from './gate.js';

export interface FactWrite {
  /** 槽位，如 'characters/陈默/state'、'foreshadows/断刃/status' */
  slot: string;
  value: string;
  /** 来源（章号等），冲突时用来判断哪个更新 */
  source: string;
}

export interface IngestResult {
  written: FactWrite[];
  conflicts: Array<{ slot: string; existing: string; incoming: string }>;
}

/**
 * 批次内自洽检查：同一槽位两个不同值 → 冲突（两条都不放行）。
 * 纯函数，单测直接验 —— 这是"不污染"最核心的一条规则。
 */
export function detectBatchConflicts(facts: readonly FactWrite[]): IngestResult {
  const bySlot = new Map<string, FactWrite[]>();
  for (const f of facts) {
    const list = bySlot.get(f.slot) ?? [];
    list.push(f);
    bySlot.set(f.slot, list);
  }
  const written: FactWrite[] = [];
  const conflicts: IngestResult['conflicts'] = [];
  for (const [slot, list] of bySlot) {
    const distinct = [...new Set(list.map((f) => f.value))];
    if (distinct.length > 1) {
      // 同批次里自己跟自己打架：不写、记账、进队列（保序：取前两个不同值做展示）
      conflicts.push({ slot, existing: distinct[0]!, incoming: distinct[1]! });
    } else {
      written.push(list[0]!);
    }
  }
  return { written, conflicts };
}

/** 把冲突写进 `fact_conflicts` 并记账（幂等：同槽位同状态的重复冲突不重复插） */
export async function recordConflicts(
  ctx: ServerPluginContext,
  projectId: string,
  conflicts: IngestResult['conflicts'],
  source: string,
): Promise<void> {
  if (conflicts.length === 0) return;
  const db = ctx.db.project(projectId) as DrizzleDb;
  for (const c of conflicts) {
    try {
      // ★ 去重：同一槽位已经有 open 的冲突就不再插一条（否则每章都会给同一槽位再排一条，
      //   面板会被同一条冲突刷满）。已存在的把 incoming 更新为最新值，便于看"它又给了个别的值"。
      const existing = await db
        .select()
        .from(schema.factConflicts)
        .where(and(
          eq(schema.factConflicts.projectId, projectId),
          eq(schema.factConflicts.slot, c.slot),
          eq(schema.factConflicts.status, 'open'),
        ))
        .limit(1);
      if (existing[0]) {
        await db.update(schema.factConflicts)
          .set({ incomingValue: c.incoming, source })
          .where(eq(schema.factConflicts.id, existing[0].id));
        continue;
      }
      await db.insert(schema.factConflicts).values({
        id: nowId(),
        projectId,
        slot: c.slot,
        existingValue: c.existing,
        incomingValue: c.incoming,
        source,
        status: 'open',
        createdAt: new Date(),
      });
      await writeAudit(ctx, {
        projectId,
        agentId: 'orchestrator',   // 沉淀是编排层的行为，不是某个角色的
        action: 'conflict',
        keys: [c.slot],
        reason: 'ingest',
        allow: false,
        detail: `${c.existing} ✗ ${c.incoming}（同批次矛盾，两条都不写）`,
      });
    } catch (e) {
      console.warn('[memory] 冲突入队失败（不影响交付）:', e);
    }
  }
}

// ★ 2026-11-03 清理：`listOpenConflicts` 与 `ingestFacts` 已删（全仓 0 引用）。
//   `ingestFacts` 是"通用沉淀入口"的提案，但实际写入路径在 entity-sink.ts ——
//   本文件保留的 `detectBatchConflicts` / `recordConflicts` 才是被它调用的部分。
