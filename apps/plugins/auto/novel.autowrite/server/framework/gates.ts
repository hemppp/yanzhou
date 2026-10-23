// ============================================================
// 三道门之「校对门 + 润色门」—— 讨论链路的落地（架构 §5）
//
// 分工（别混，踩过）：
//   意图门（`discuss/roles.ts` 的 ROLE_REVIEWER）—— **点**：答应的事做了吗（对照本章结论）
//   校对门（本文件 runConsistencyGate）          —— **面**：有没有说错话（全文 × 设定库）
//   润色门（本文件 runPolishGate）               —— **评分**：文笔 / 节奏
//
// 治理取向（与意图门刻意不同，原因见下）：
//   · 校对门是**硬门**，但只给它**一次定向修订**的机会；修订后仍不过也**不阻塞交付**，
//     而是把冲突清单如实交给人工。理由：第二个「打回—重写」循环会带来第三、第四个，
//     而两次打回后整章作废的代价（实测 2026-09-12：3333 字全废）远大于残留一处小冲突。
//   · 润色门是**软门**：只评分、给意见，**从不阻塞** —— 评分低不该拦下一章。
//
// 探针提示词来自 `framework/gates-prompts.ts`（2026-09-28 从已删除的 autowrite/prompts.ts 迁来）。
// 那两个 prompt 本身与链路无关；改它们只影响本文件的两道门。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { CHECKER_SYSTEM, REVIEWER_SYSTEM } from './gates-prompts.js';
import { parseJsonLoose } from './text.js';

export interface ConsistencyVerdict {
  pass: boolean;
  /** 冲突清单（含出处设定），最多 10 条 */
  conflicts: string[];
  /** 给写作官的定向修正指令 */
  instructions: string;
  /**
   * 非空表示这次比对**没能执行**（模型调用/解析失败）。
   * 此时 `pass` 一律为 `true` —— 绝不能因为基础设施抖动就让稿子被打回；
   * 但也**不能静默吞掉**：调用方必须把它透给作者看（实测踩过：静默失败
   * 会让校对门变成一个永远「跳过」的摆设，白白多烧一次调用）。
   */
  error?: string;
}

export interface PolishVerdict {
  score: number;
  comments: string;
  /** 同 ConsistencyVerdict.error：非空 = 这一步没执行成功 */
  error?: string;
}

/** 校对官对照的设定摘要（直接取 context-resolver 的 digest 三栏） */
export interface GateDigest {
  characters: string;
  foreshadows: string;
  outline: string;
}

/** 润色通过线（软门仅用于展示「是否达标」，不拦交付） */
export const POLISH_PASS_SCORE = 7;

/**
 * 调一次模型并解析成 JSON；**解析失败自动重试一次**（第二次附一句更硬的格式要求）。
 *
 * 为什么必须重试：解析失败 = 这一步**根本没执行**。校对门失败即放行，等于门是摆设 ——
 * 而重试只多花一次调用，代价远低于"漏掉一次一致性检查"。
 * （根因已同步修在 `parseJsonLoose`：原先是"第一个 { 到最后一个 }"，
 *  模型输出两个 JSON 时会切错 → `Unexpected non-whitespace character after JSON`。）
 * 重试后仍失败 → 返回 parsed=null，由调用方按既定策略处理（当前是 fail-open + 把 error 透给作者）。
 */
async function completeJson<T>(
  ctx: ServerPluginContext,
  opts: { system: string; user: string; maxTokens: number; temperature: number; userId?: string; label: string },
): Promise<{ parsed: T | null; error?: string; attempts: number }> {
  const NUDGE = '\n\n【格式要求（必须严格遵守）】只输出**一个** JSON 对象：不要解释、不要第二个对象、不要代码块标记。';
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await ctx.ai.complete({
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: attempt === 1 ? opts.user : opts.user + NUDGE },
        ],
        json: true,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        userId: opts.userId,
      });
      return { parsed: parseJsonLoose<T>(raw), attempts: attempt };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (attempt === 1) console.warn(`[gates] ${opts.label} 第 1 次输出无法解析，重试一次：`, lastErr);
    }
  }
  return { parsed: null, error: lastErr, attempts: 2 };
}

/**
 * 校对门：全文 × 设定库一致性机判。
 *
 * **不会抛错**。执行失败时返回带 `error` 的「通过」结论 —— 调用方据此照常交付，
 * 但要把 error 透给作者（别再静默跳过）。
 */
export async function runConsistencyGate(
  ctx: ServerPluginContext,
  opts: { order: number; draft: string; digest: GateDigest; userId?: string },
): Promise<ConsistencyVerdict> {
  const user = [
    '【设定摘要】',
    '角色：',
    opts.digest.characters,
    '',
    '伏笔：',
    opts.digest.foreshadows,
    '',
    '大纲：',
    opts.digest.outline,
    '',
    `【章节初稿（第${opts.order}章）】`,
    opts.draft,
  ].join('\n');

  const { parsed, error, attempts } = await completeJson<{ pass?: boolean; conflicts?: unknown; instructions?: unknown }>(
    ctx,
    {
      system: CHECKER_SYSTEM,
      user,
      // ★ 必须给足：校对官要逐条列出「冲突描述 + 出处」，正文一长输出就上千 token。
      //   实测（2026-09-12）：设 2048 时多章跑下来会**间歇性截断**。与 entity-sink 同量级取 4096。
      maxTokens: 4096,
      temperature: 0.1,
      userId: opts.userId,
      label: '校对官',
    },
  );

  if (!parsed) {
    console.warn(`[gates] 校对官调用失败（两次都不成，按通过处理，不拦交付）:`, error);
    return { pass: true, conflicts: [], instructions: '', error: `校对门未能执行（已重试一次）：${error}` };
  }
  if (attempts === 2) console.log('[gates] 校对官第二次输出才解析成功（第一次格式不合格）');
  return {
    pass: parsed.pass === true,
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.map(String).slice(0, 10) : [],
    instructions: String(parsed.instructions ?? '').slice(0, 300),
  };
}

/** 润色门：质量评分（软门，从不阻塞交付；执行失败同样返回带 error 的结果） */
export async function runPolishGate(
  ctx: ServerPluginContext,
  opts: { order: number; draft: string; userId?: string },
): Promise<PolishVerdict> {
  const { parsed, error } = await completeJson<{ score?: unknown; comments?: unknown }>(ctx, {
    system: REVIEWER_SYSTEM,
    user: `【章节初稿（第${opts.order}章）】\n${opts.draft}`,
    maxTokens: 1536,
    temperature: 0.2,
    userId: opts.userId,
    label: '评审官',
  });

  if (!parsed) {
    console.warn('[gates] 评审官调用失败（两次都不成，跳过润色门）:', error);
    return { score: 0, comments: '', error: `润色门未能执行（已重试一次）：${error}` };
  }
  return {
    score: Math.max(0, Math.min(10, Math.round(Number(parsed.score ?? 0)))),
    comments: String(parsed.comments ?? '').slice(0, 200),
  };
}
