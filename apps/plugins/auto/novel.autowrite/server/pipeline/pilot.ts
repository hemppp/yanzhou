// ============================================================
// Stage5 · 前三章试写（pilot）
//
// 设计（docs/architecture/ai-writing-multiagent-pipeline.md §Stage5）：
//   写作智能体派 3 个子代理，**串行**写前三章 → 每章各自走现有的
//   意图门 → 校对门 → 润色门 → 交付 → 实体沉淀 → 三章齐了再加一道
//   `premiere-reviewer` **跨章审阅** → 停下等作者（G4）。
//
// 为什么是"复用单章闭环"而不是另写一套写作逻辑：
//   `discuss/orchestrator.runDiscussion` 已经把一章跑通了（含强制注入上一章全文、
//   三道门、带警示交付、实体沉淀）。试写三章与长跑三十章在**单章层面**是同一件事，
//   另写一遍只会得到两个行为不一致的写作器（改一处漏一处的老问题）。
//
// ★ 串行是硬约束，不是效率取舍：并发写三章 = 三章各自开天辟地
//   （`resolvePreviousChapter` 的上一章全文注入是跨章连续性最吃紧的一块）。
//
// 本文件分两层：
//   · 纯函数（planPilotChapterOrders / renderPremiereInput / parsePremiereReview）
//     —— 零模型调用、零 DB，单测直接覆盖；
//   · `runPilot` —— 把上面这些接到真实的单章闭环上。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { schema, eq, and, isNull, desc, getProjectDb, type DrizzleDb } from '@novel/db';
import { runDiscussion } from '../discuss/orchestrator.js';
import { createChapterBridge } from './chapter-bridge.js';
import { extractFirstJson } from '../framework/text.js';
import { readDigestFor } from '../framework/memory/digest-gate.js';
import { createAgentSkillResolver } from '../framework/agent-skills.js';
import {
  createAgentMemory, createMemoryGate, experience, fingerprintOf, writeAudit,
} from '../framework/memory/index.js';
import { ROLE_PREMIERE, STAGE_SPEAK_MAX_TOKENS } from './roles-phase.js';
import { PILOT_CHAPTERS, type PipelineEvent } from './types.js';

// ---- 纯函数层 ----

/** 试写哪几章：库里已有章节就接着往后写，"前三章"在续写场景下同样成立 */
export function planPilotChapterOrders(lastOrder: number, count = PILOT_CHAPTERS): number[] {
  const from = Math.max(0, Math.floor(lastOrder) || 0) + 1;
  return Array.from({ length: Math.max(1, count) }, (_, i) => from + i);
}

/** 单章指令。★ 不照抄作者原话 —— 那是写给"立设定"那一段的（30 章连写踩过这个坑） */
export function pilotMessage(order: number, first: boolean, extra?: string): string {
  const head = first
    ? `按《剧情总纲》里第 ${order} 章的节拍，写出第 ${order} 章正文。`
    : `接着上一章往下写第 ${order} 章。按《剧情总纲》里第 ${order} 章的节拍走；`
      + '保持人物、伏笔与文风连续，不要重述上一章已经写过的内容。';
  return extra ? `${head}\n\n【作者补充】\n${extra}` : head;
}

/** 跨章审阅的输入：三章全文（截断要**明说**，否则它会以为后面没有内容） */
export function renderPremiereInput(o: {
  chapters: Array<{ order: number; title: string; content: string }>;
  contracts?: Array<{ label: string; text: string }>;
  perChapterMax?: number;
}): string {
  const max = o.perChapterMax ?? 5000;
  const parts: string[] = [];
  if (o.contracts?.length) {
    parts.push('【已批准的设定（判断"漂没漂"的基准，不是让你重述它）】');
    for (const c of o.contracts) parts.push(`◆ ${c.label}：\n${c.text}`);
    parts.push('');
  }
  parts.push(`【正文（共 ${o.chapters.length} 章，按顺序）】`);
  for (const c of o.chapters) {
    const body = c.content.length <= max ? c.content : c.content.slice(0, max) + '\n…（本章过长，此处已截断）';
    parts.push(`\n———— 第 ${c.order} 章 ${c.title} ————\n${body}`);
  }
  parts.push('', '现在按上面的输出契约给出跨章审阅的 JSON。');
  return parts.join('\n');
}

export interface PremiereIssue { kind: string; detail: string; evidence: string; fix: string }
export interface PremiereResult {
  verdict: 'pass' | 'minor' | 'major';
  voice: string;
  arc: string;
  foreshadow: string;
  cohesion: string;
  issues: PremiereIssue[];
}

const ISSUE_KINDS = new Set(['voice', 'arc', 'foreshadow', 'cohesion']);

/**
 * 解析跨章审阅。
 * ★ 解析不出来**不当作 pass** —— 那正是最糟的失败模式（"没审出问题"与"压根没审"混成一个结果）。
 *   兜底成 `minor` + 一条 issue，把"这次审阅没能解析"显式写进报告里。
 */
export function parsePremiereReview(text: string): PremiereResult {
  const raw = (() => {
    try {
      const json = extractFirstJson(text);
      return json ? JSON.parse(json) as Record<string, unknown> : null;
    } catch {
      return null;
    }
  })();

  if (!raw) {
    return {
      verdict: 'minor', voice: '', arc: '', foreshadow: '', cohesion: '',
      issues: [{
        kind: 'cohesion',
        detail: '跨章审阅的输出没能解析成 JSON（模型没按契约回）',
        evidence: text.slice(0, 300),
        fix: '人工读一遍这三章；或重跑本段让审阅重来一次',
      }],
    };
  }

  const str = (k: string): string => (typeof raw[k] === 'string' ? String(raw[k]).trim() : '');
  const v = str('verdict').toLowerCase();
  const verdict: PremiereResult['verdict'] = v === 'pass' || v === 'major' ? v : v === 'minor' ? 'minor' : 'minor';

  const issues: PremiereIssue[] = Array.isArray(raw.issues)
    ? (raw.issues as unknown[]).map((it) => {
        const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
        const k = typeof o.kind === 'string' ? o.kind.toLowerCase() : '';
        return {
          kind: ISSUE_KINDS.has(k) ? k : 'cohesion',
          detail: typeof o.detail === 'string' ? o.detail.trim() : '',
          evidence: typeof o.evidence === 'string' ? o.evidence.trim() : '',
          fix: typeof o.fix === 'string' ? o.fix.trim() : '',
        };
      }).filter((it) => it.detail)
    : [];

  // 判 pass 却列了 issue：以 issue 为准 —— 有具体问题就该看见（反过来会静默吞掉问题）
  const finalVerdict = verdict === 'pass' && issues.length > 0 ? 'minor' : verdict;
  return { verdict: finalVerdict, voice: str('voice'), arc: str('arc'), foreshadow: str('foreshadow'), cohesion: str('cohesion'), issues };
}

const VERDICT_LABEL: Record<PremiereResult['verdict'], string> = {
  pass: '通过（没有需要修正的问题）',
  minor: '可继续（接下来几章按下面修正）',
  major: '建议停下重写（出现了跨章级别的问题）',
};

const KIND_LABEL: Record<string, string> = {
  voice: '文风', arc: '主角弧光', foreshadow: '伏笔', cohesion: '整体连贯',
};

/** 把审阅结果渲染成给作者看（并存成阶段契约）的《前三章审阅报告》 */
export function renderPremiereReport(r: PremiereResult, chapters: Array<{ order: number; wordCount?: number }>): string {
  const parts: string[] = [];
  parts.push(`【前三章跨章审阅】判定：${VERDICT_LABEL[r.verdict]}（${r.issues.length} 处）`);
  parts.push('');
  parts.push(`已交付：${chapters.map((c) => `第 ${c.order} 章${c.wordCount ? `（${c.wordCount} 字）` : ''}`).join('、')}`);
  parts.push('');
  if (r.voice) parts.push(`文风：${r.voice}`);
  if (r.arc) parts.push(`主角弧光：${r.arc}`);
  if (r.foreshadow) parts.push(`伏笔：${r.foreshadow}`);
  if (r.cohesion) parts.push(`整体：${r.cohesion}`);
  if (r.issues.length) {
    parts.push('', `—— 需修正（${r.issues.length} 处）——`);
    r.issues.forEach((it, i) => {
      parts.push(`${i + 1}. [${KIND_LABEL[it.kind] ?? it.kind}] ${it.detail}`);
      if (it.evidence) parts.push(`   证据：${it.evidence}`);
      if (it.fix) parts.push(`   改法：${it.fix}`);
    });
  }
  return parts.join('\n');
}

// ---- 编排层 ----

export interface PilotChapterRecord { order: number; delivered: boolean; wordCount: number; warnings: string[] }

export interface PilotOutcome {
  chapters: PilotChapterRecord[];
  artifact: string;
  premiere: PremiereResult | null;
}

/** 取项目库里已交付的最大章号（新项目 → 0） */
async function maxChapterOrder(ctx: ServerPluginContext, projectId: string): Promise<number> {
  try {
    const db = await getProjectDb(projectId) as unknown as DrizzleDb;
    const rows = await db
      .select({ order: schema.chapters.order })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.projectId, projectId), isNull(schema.chapters.deletedAt)))
      .orderBy(desc(schema.chapters.order))
      .limit(1);
    return rows[0]?.order ?? 0;
  } catch (e) {
    console.warn('[pilot] 读取已有章节失败（按空库处理）:', e);
    return 0;
  }
}

/**
 * 跑试写：三章串行 + 跨章审阅。
 *
 * 失败取向（与单章闭环一致）：**一章没交上去不打断整轮** —— 试写本来就是拿来看文风的，
 * 手里有 2 章也比"什么都没有"强；但交付情况会逐章记进 `chapters`（含 delivered=false），
 * 报告里也照实写，绝不让人以为三章都齐了。
 */
export async function runPilot(
  ctx: ServerPluginContext,
  opts: { projectId: string; userId: string; extra?: string; lastDelivered?: number; contracts?: Array<{ label: string; text: string }> },
  emit: (e: PipelineEvent) => void,
): Promise<PilotOutcome> {
  const { projectId, userId } = opts;

  const last = opts.lastDelivered && opts.lastDelivered > 0
    ? opts.lastDelivered
    : await maxChapterOrder(ctx, projectId);
  const orders = planPilotChapterOrders(last);
  const total = orders.length;
  const records: PilotChapterRecord[] = [];

  for (let i = 0; i < total; i++) {
    const order = orders[i]!;
    const index = i + 1;
    emit({ type: 'pilot_chapter', index, total, order, phase: 'start' });

    const { bridge, result } = createChapterBridge({ stage: 'pilot', order, emit });
    const warnings = result().warnings;

    try {
      await runDiscussion(
        ctx,
        { projectId, userId, message: pilotMessage(order, i === 0, i === 0 ? opts.extra : undefined), chapterOrder: order, finalDone: false },
        bridge,
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      warnings.push(`异常中止：${detail}`);
      emit({ type: 'stage_phase', stage: 'pilot', label: `第 ${order} 章异常中止：${detail}` });
    }

    const { delivered, wordCount } = result();
    records.push({ order, delivered, wordCount, warnings });
    emit({ type: 'pilot_chapter', index, total, order, phase: 'done', delivered, wordCount, ...(warnings.length ? { warnings } : {}) });
  }

  // ---- 跨章审阅（不足 2 章就没有"跨章"可谈，明确说明而不是硬审）----
  const done = records.filter((r) => r.delivered);
  if (done.length < 2) {
    const artifact = [
      '【前三章试写】未能形成可审阅的三章。',
      '',
      '交付情况：' + (records.map((r) => `第 ${r.order} 章 ${r.delivered ? `已交付（${r.wordCount} 字）` : '未交付'}`).join('；') || '（无）'),
      '',
      '说明：跨章审阅需要至少两章正文作对照。请先解决上面的交付问题，再重跑本段。',
    ].join('\n');
    emit({ type: 'stage_phase', stage: 'pilot', label: `只交付了 ${done.length} 章，跳过跨章审阅` });
    return { chapters: records, artifact, premiere: null };
  }

  emit({ type: 'stage_phase', stage: 'pilot', label: '跨章审阅：横着读这三章…' });
  const chapters = await loadDeliveredChapters(ctx, projectId, done.map((r) => r.order));
  const premiere = await reviewPremiere(ctx, { projectId, userId, chapters, contracts: opts.contracts, records: done });
  const artifact = renderPremiereReport(premiere, done);
  emit({ type: 'premiere_review', text: artifact, verdict: premiere.verdict, issues: premiere.issues.length });
  return { chapters: records, artifact, premiere };
}

async function loadDeliveredChapters(
  ctx: ServerPluginContext,
  projectId: string,
  orders: number[],
): Promise<Array<{ order: number; title: string; content: string }>> {
  const out: Array<{ order: number; title: string; content: string }> = [];
  let db: DrizzleDb;
  try {
    db = await getProjectDb(projectId) as unknown as DrizzleDb;
  } catch (e) {
    console.warn('[pilot] 打开项目库失败，无法回读正文:', e);
    return out;
  }
  for (const order of orders) {
    try {
      const rows = await db
        .select({ order: schema.chapters.order, title: schema.chapters.title, content: schema.chapters.content })
        .from(schema.chapters)
        .where(and(eq(schema.chapters.projectId, projectId), eq(schema.chapters.order, order), isNull(schema.chapters.deletedAt)))
        .limit(1);
      const r = rows[0];
      if (r) out.push({ order: r.order, title: r.title || `第 ${r.order} 章`, content: r.content ?? '' });
    } catch (e) {
      console.warn(`[pilot] 回读第 ${order} 章失败:`, e);
    }
  }
  return out;
}

/** 跨章审阅：走闸门拿一份受控的设定现状（它要对照宪章判断"漂没漂"） */
async function reviewPremiere(
  ctx: ServerPluginContext,
  o: {
    projectId: string; userId: string;
    chapters: Array<{ order: number; title: string; content: string }>;
    contracts?: Array<{ label: string; text: string }>;
    records: PilotChapterRecord[];
  },
): Promise<PremiereResult> {
  const gate = createMemoryGate(ctx);
  let briefText = '';
  try {
    const { digest } = await readDigestFor(ctx, o.projectId, ROLE_PREMIERE.key, 'gate-review', { narrative: true });
    briefText = (digest.brief as string | undefined) ?? '';
  } catch (e) {
    console.warn('[pilot] 跨章审阅读取设定失败（按无设定继续）:', e);
  }

  const input = renderPremiereInput({ chapters: o.chapters, contracts: o.contracts });
  const full = briefText ? `【作者的开书设定】\n${briefText}\n\n${input}` : input;

  // L2：本轮审阅也是这个 agent 的一段经历
  try {
    await createAgentMemory({ ctx, projectId: o.projectId, agentId: ROLE_PREMIERE.key, gate })
      .writeOwn(experience(`exp.pilot.review.ch${o.chapters.map((c) => c.order).join('-')}`, {
        kind: 'said', text: `跨章审阅 ${o.chapters.length} 章`, ref: `pilot#${o.chapters.map((c) => c.order).join(',')}`,
      }));
  } catch (e) {
    console.warn('[pilot] 写审阅经历失败（不影响本段）:', e);
  }

  try {
    await writeAudit(ctx, {
      projectId: o.projectId, agentId: ROLE_PREMIERE.key, action: 'assemble',
      keys: ['settings.brief', 'chapter.*'], reason: 'chapter-write', allow: true,
      detail: `跨章审阅注入 ${full.length} 字（${o.chapters.length} 章正文）`,
      fingerprint: fingerprintOf(full),
    });
  } catch (e) {
    console.warn('[pilot] 跨章审阅装配指纹写入失败（不影响本段）:', e);
  }

  try {
    const result = await ctx.ai.agents.run({
      // ★ 前三章审阅也是"智能体"之一，它的开关同样要生效（与另两条链路同口径）
      system: await createAgentSkillResolver(ctx, o.userId).systemFor(ROLE_PREMIERE.key, ROLE_PREMIERE.system),
      input: full,
      maxTurns: 2,
      maxTokens: STAGE_SPEAK_MAX_TOKENS,
      context: { projectId: o.projectId, userId: o.userId },
    });
    const text = String(result.text ?? '').trim();
    if (!text) throw new Error('跨章审阅未产出内容');
    return parsePremiereReview(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn('[pilot] 跨章审阅调用失败:', e);
    return {
      verdict: 'minor', voice: '', arc: '', foreshadow: '', cohesion: '',
      issues: [{
        kind: 'cohesion', detail: `跨章审阅没能跑完：${detail}`,
        evidence: '', fix: '重跑本段，或人工读这三章',
      }],
    };
  }
}

/** pilot 的落库：验收判据（"三章都进库了没有"）**只看库**，不看承诺 */
export function pilotSinkNotes(records: PilotChapterRecord[]): string[] {
  const notes: string[] = [];
  const missed = records.filter((r) => !r.delivered);
  if (missed.length) notes.push(`${missed.length} 章未落库：${missed.map((r) => `第 ${r.order} 章`).join('、')}`);
  const warned = records.filter((r) => r.warnings.length);
  if (warned.length) notes.push(`${warned.length} 章带警示交付`);
  return notes;
}

/** 重导出，方便路由/编排统一从这里取 */
export { PILOT_CHAPTERS };
