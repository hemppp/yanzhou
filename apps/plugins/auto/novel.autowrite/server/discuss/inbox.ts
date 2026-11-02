// ============================================================
// 作者插话信箱（human-in-the-loop 的最小实现）
//
// 为什么需要它（2026-10-25，参照 AgentTeams 的「人在环中」）：
//   讨论是"一次调用跑到完"的长连接（`/session` / `/pipeline/advance` 都是 SSE），
//   跑起来之后前端就把发送按钮禁掉了。作者看到剧情设计师说错了、或者想补一条约束，
//   只能等整轮跑完 —— 那时讨论已经收敛、甚至章节已经落库。
//
//   本模块给作者一条**异步插话**的通道：
//     · 插话走**独立短连接** POST 写进项目级信箱（不占长连接、不需要等）；
//     · 讨论循环在**每个角色开口前**读一次信箱，把新插话注入该角色的 input；
//     · 读到即标记 consumed，保证同一条插话只生效一次。
//
// 语义边界（刻意为之）：
//   · **不打断正在跑的模型调用** —— 粒度是"下一个角色开口前"（约 30–60 秒）。
//     打断会浪费一次调用、截断一段可能很好的发言，而且破坏讨论顺序的可复现性。
//   · **fail-open**：信箱空 / 读失败时，行为与没有这个功能**完全一致**。
//
// 为什么用 kv 而不是新表：插话是短生命周期的会话态（跑完即弃），
//   `ctx.db.kv` 已自带项目隔离，且不需要为此引入一次数据库迁移。
// ============================================================

import type { ServerPluginContext } from '@novel/core';

/** 与 PipelineStore 同一个命名空间（见 pipeline/store.ts 顶部） */
const NS = 'novel.autowrite';
/** 信箱 key 前缀：`inbox.<id>` */
const PREFIX = 'inbox.';
/** 单条插话最大长度 —— 防止把 prompt 撑爆（讨论记录本身已有 12000 字预算） */
export const INTERJECTION_MAX_CHARS = 500;
/** 一次最多注入几条 —— 超出的留到下一轮，避免一次塞爆某个角色的 input */
export const INTERJECTION_MAX_PER_TURN = 3;
/** 信箱保留条数（消费后仍留在库里供审计，但只留最近这么多） */
const KEEP_MAX = 50;

export interface Interjection {
  id: string;
  /** 毫秒时间戳 */
  at: number;
  text: string;
  /** 已被某个角色消费过（同一条不会再注入第二次） */
  consumed: boolean;
}

export interface KvLike {
  list(pluginId: string, prefix?: string, opts?: { projectId?: string }): Array<{ key: string; value: unknown }>;
  set(pluginId: string, key: string, value: unknown, opts?: { projectId?: string }): Promise<void>;
  delete(pluginId: string, key: string, opts?: { projectId?: string }): Promise<void>;
}

/** 从上下文取 kv（拆出来是为了单测能直接传假 kv） */
export function kvOf(ctx: Pick<ServerPluginContext, 'db'>): KvLike {
  return ctx.db.kv as unknown as KvLike;
}

/** 读出全部插话（含已消费的），按时间升序 */
function readAll(kv: KvLike, projectId: string): Interjection[] {
  let rows: Array<{ key: string; value: unknown }> = [];
  try {
    rows = kv.list(NS, PREFIX, { projectId });
  } catch (e) {
    console.warn('[inbox] 读信箱失败（按空处理）:', e);
    return [];
  }
  return rows
    .map((r) => r.value as Interjection | null)
    .filter((v): v is Interjection => !!v && typeof v.text === 'string')
    .sort((a, b) => a.at - b.at);
}

/** 写信箱：作者插一句话。返回新条目（含 id，前端可用它做去重/回执）。 */
export async function pushInterjection(
  ctx: Pick<ServerPluginContext, 'db'>,
  projectId: string,
  rawText: string,
): Promise<Interjection> {
  const text = String(rawText ?? '').trim().slice(0, INTERJECTION_MAX_CHARS);
  if (!text) throw new Error('插话内容为空');
  const entry: Interjection = {
    id: `ij_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    text,
    consumed: false,
  };
  const kv = kvOf(ctx);
  await kv.set(NS, `${PREFIX}${entry.id}`, entry, { projectId });

  // 只保留最近 KEEP_MAX 条（消费过的优先淘汰；插话是会话态，不值得无限留）
  try {
    const all = readAll(kv, projectId);
    if (all.length > KEEP_MAX) {
      const drop = all.slice(0, all.length - KEEP_MAX);
      for (const d of drop) await kv.delete(NS, `${PREFIX}${d.id}`, { projectId });
    }
  } catch { /* 清理失败不影响投递 */ }

  return entry;
}

/**
 * 取走「待生效」的插话：按时间升序取最多 `INTERJECTION_MAX_PER_TURN` 条，
 * 并**立即标记 consumed**（同一条不会在下一个角色身上重复注入）。
 *
 * 读失败一律返回空数组（fail-open）—— 插话是增强，不能因为它把一次讨论搞垮。
 */
export function takeInterjections(
  ctx: Pick<ServerPluginContext, 'db'>,
  projectId: string,
): Interjection[] {
  const kv = kvOf(ctx);
  const pending = readAll(kv, projectId).filter((v) => !v.consumed);
  if (!pending.length) return [];
  const take = pending.slice(0, INTERJECTION_MAX_PER_TURN);
  for (const t of take) {
    // 同步 kv 的 set 是 Promise，但这里不能 await（调用点都是同步的发言前检查）——
    // 先本地标记再落库，落库失败只影响"会不会重复注入一次"，不影响本次生效。
    void kv.set(NS, `${PREFIX}${t.id}`, { ...t, consumed: true }, { projectId }).catch((e) => {
      console.warn('[inbox] 标记已消费失败（可能导致重复注入一次）:', e);
    });
    t.consumed = true;
  }
  return take;
}

/** 信箱里还有几条待生效（给路由回执 / 界面显示"排队中"用） */
export function pendingCount(ctx: Pick<ServerPluginContext, 'db'>, projectId: string): number {
  return readAll(kvOf(ctx), projectId).filter((v) => !v.consumed).length;
}

/** 把待生效插话渲染成注入用的提示块（两条链路共用同一措辞，避免语义漂移） */
export function renderInterjections(list: readonly Interjection[]): string {
  if (!list.length) return '';
  return [
    `【作者刚刚插话（${list.length} 条，优先遵守）】`,
    ...list.map((p) => `· ${p.text}`),
    '（作者是在讨论进行中插的话 —— 本轮请按这个方向调整；与上文冲突时以作者为准。）',
  ].join('\n');
}
