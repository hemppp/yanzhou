// ============================================================
// Stage6 · 长跑（production）—— 逐章写作 + 写作监工 + 每 N 章轨迹确认
//
// 设计见 docs/architecture/ai-writing-multiagent-pipeline.md §Stage6 与 §M3：
//   逐章跑现有单章闭环（讨论 → 结论 → 落笔 → 三道门 → 交付 → 沉淀）；
//   每章交付后由「写作监工」只读巡检一次；每 N 章回「剧情设计师」做一次轨迹确认。
//
// ★ 三个关键设计取舍（改代码前先读）：
//   1. **一段一批，不是一次跑到底**：`PRODUCTION_BATCH` 章为一轮，跑完把游标留在
//      `cursor.lastDelivered`，作者再点一次接着写 —— 这就是"断点续跑"的落地形式。
//      一次 SSE 请求真跑 30 章会断连、会失控；一批 5 章是"能看见进展又能收得住"的量级。
//   2. **监工 halt 是唯一会打断长跑的东西**：`ok/watch` 都继续，`halt`（或连续两次
//      `watch`）才停。理由见 roles-phase 的 SUPERVISE_REVIEW 注释 —— 长篇跑到第 40 章
//      才发现越写越水，重写成本是灾难。
//   3. **轨迹确认必须有产出物**：`on_track` 记一条；`minor_drift` 生成补丁（后续章节注入）；
//      `major_drift` 暂停整条流水线，出《轨迹偏离报告》请作者决策。
//
// 本文件分两层：纯函数（零模型/零 DB，单测直接覆盖）+ `runProduction`（接到真实闭环）。
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
import { ROLE_PLOT } from '../discuss/roles.js';
import { ROLE_SUPERVISOR, STAGE_SPEAK_MAX_TOKENS } from './roles-phase.js';
import {
  PRODUCTION_BATCH, PRODUCTION_REVIEW_EVERY, type PipelineEvent, type TrackEntry,
} from './types.js';

// ---- 纯函数层 ----

/** 本轮要写哪几章：从"已交付的最后一章"接着往后，一批 PRODUCTION_BATCH 章 */
export function planProductionChapterOrders(lastDelivered: number, batch = PRODUCTION_BATCH): number[] {
  const from = Math.max(0, Math.floor(lastDelivered) || 0) + 1;
  return Array.from({ length: Math.max(1, batch) }, (_, i) => from + i);
}

/**
 * 单章指令。`hasPrevious` 决定口吻：
 * - 全书第 1 章 → 按总纲起笔；
 * - 否则一律"接着上一章往下写"（**不要**照抄作者最初那句指令，那是写给立设定那一段的）。
 */
export function productionMessage(order: number, hasPrevious: boolean, extra?: string): string {
  const head = hasPrevious
    ? `接着上一章往下写第 ${order} 章。按《剧情总纲》里第 ${order} 章的节拍走；`
      + '保持人物、伏笔与文风连续，不要重述上一章已经写过的内容。'
    : `按《剧情总纲》里第 ${order} 章的节拍，写出第 ${order} 章正文。`;
  return extra ? `${head}\n\n【作者补充】\n${extra}` : head;
}

// ---- 写作监工 ----

export interface SuperviseIssue { kind: string; detail: string; evidence: string }
export interface SuperviseResult {
  order: number;
  verdict: 'ok' | 'watch' | 'halt';
  issues: SuperviseIssue[];
  trend: string;
  /** 是否成功解析出 JSON —— 解析失败也算 watch，但**不计入**"连续两次 watch → halt" */
  parsed: boolean;
}

const SUPERVISE_KINDS = new Set(['rhythm', 'voice', 'continuity', 'filler']);

/** 监工输入：本章正文 + 最近 3 章摘要 + 质量台账（此前的监工结论） */
export function renderSuperviseInput(o: {
  order: number;
  content: string;
  summary?: string;
  recentSummaries?: Array<{ order: number; summary: string }>;
  ledger?: Array<{ order: number; verdict: string; issues: number }>;
  contentMax?: number;
}): string {
  const max = o.contentMax ?? 6000;
  const parts: string[] = [];
  parts.push(`【本章（第 ${o.order} 章）正文】`);
  const body = o.content.length <= max ? o.content : o.content.slice(0, max) + '\n…（本章过长，此处已截断）';
  parts.push(body);
  if (o.summary) parts.push('', `【本章摘要】\n${o.summary}`);
  if (o.recentSummaries?.length) {
    parts.push('', '【最近几章摘要（判断"趋势"要跟它们比）】');
    for (const s of o.recentSummaries) parts.push(`第 ${s.order} 章：${s.summary}`);
  }
  if (o.ledger?.length) {
    parts.push('', '【质量台账（此前的监工结论，倒序）】');
    for (const l of o.ledger) parts.push(`第 ${l.order} 章：${l.verdict}（${l.issues} 处问题）`);
  } else {
    parts.push('', '【质量台账】无（这是本书第一次监工）');
  }
  parts.push('', `现在按输出契约给出第 ${o.order} 章的监工 JSON。`);
  return parts.join('\n');
}

/**
 * 解析监工报告。
 * ★ 解析不出来**不当作 ok** —— 与前三章审阅同一取向：把"没审出问题"和"压根没审"分开。
 *   兜底成 `watch` + 一条 issue，且 `parsed:false` 让它**不触发**"连续两次 watch → halt"，
 *   避免模型偶尔吐错 JSON 就把整条长跑打断。
 */
export function parseSuperviseReport(text: string, order: number): SuperviseResult {
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
      order, verdict: 'watch', parsed: false, trend: '',
      issues: [{
        kind: 'continuity',
        detail: '监工的输出没能解析成 JSON（模型没按契约回）',
        evidence: text.slice(0, 300),
      }],
    };
  }

  const v = typeof raw.verdict === 'string' ? raw.verdict.toLowerCase() : '';
  const verdict: SuperviseResult['verdict'] = v === 'halt' ? 'halt' : v === 'ok' ? 'ok' : 'watch';

  const issues: SuperviseIssue[] = Array.isArray(raw.issues)
    ? (raw.issues as unknown[]).map((it) => {
        const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
        const k = typeof o.kind === 'string' ? o.kind.toLowerCase() : '';
        return {
          kind: SUPERVISE_KINDS.has(k) ? k : 'continuity',
          detail: typeof o.detail === 'string' ? o.detail.trim() : '',
          evidence: typeof o.evidence === 'string' ? o.evidence.trim() : '',
        };
      }).filter((it) => it.detail)
    : [];

  // 判 ok 却列了 issue：以 issue 为准（有具体问题就该看见）
  const finalVerdict = verdict === 'ok' && issues.length > 0 ? 'watch' : verdict;
  const trend = typeof raw.trend === 'string' ? raw.trend.trim() : '';
  return { order, verdict: finalVerdict, issues, trend, parsed: true };
}

/**
 * 是否该因监工结果**打断长跑**。
 *
 * 规则（2026-10-16 二次修订，原因见下）：
 *   · 只有监工**显式**给 `halt` 才打断；
 *   · 连续 watch **不再**打断（`CONSECUTIVE_WATCH_TO_HALT = 0` 表示禁用该规则）。
 *
 * ★ 为什么最终把"连续 watch"整条去掉：
 *   这套监工提示词极其严格（要求逐句找问题、必须引原文），实测**质量正常时也几乎每章
 *   都给 watch**（v8 第 4/5/6/7 章各 3–5 条，条条属实但都不致命）。于是"连续 4 次 watch"
 *   约等于**每 7–8 章必停一次** —— 30 万字（约 110 章）在结构上就跑不完。
 *   现在改为：只有监工**明确说 halt**（真出事）才停；连续 watch 仍逐章记进台账
 *   （`pipeline_runs` / 监工报告），作者事后可查，但不再打断长跑。
 *   想把旧行为拿回来：把常量改回 2 或 4 即可。
 */
export const CONSECUTIVE_WATCH_TO_HALT = 0;
export function superviseShouldHalt(history: SuperviseResult[]): boolean {
  const last = history[history.length - 1];
  if (!last) return false;
  if (last.verdict === 'halt') return true;
  if (CONSECUTIVE_WATCH_TO_HALT <= 0) return false;
  const tail = history.slice(-CONSECUTIVE_WATCH_TO_HALT);
  return tail.length === CONSECUTIVE_WATCH_TO_HALT && tail.every((r) => r.verdict === 'watch' && r.parsed);
}

const SUPERVISE_KIND_LABEL: Record<string, string> = {
  rhythm: '节奏', voice: '文风', continuity: '连贯', filler: '注水',
  // 2026-10-16 新增（实测后段大半问题属于这三类，此前监工叫不出名字）
  'outline-leak': '提纲泄漏', duplication: '重复', 'dialogue-paucity': '对话过少',
};
const SUPERVISE_VERDICT_LABEL: Record<SuperviseResult['verdict'], string> = {
  ok: '正常', watch: '留意', halt: '需停下处理',
};

/** 渲染单章监工报告（给人看，也存进阶段契约） */
export function renderSuperviseReport(r: SuperviseResult): string {
  const parts: string[] = [];
  parts.push(`【第 ${r.order} 章监工】判定：${SUPERVISE_VERDICT_LABEL[r.verdict]}（${r.issues.length} 处）`);
  if (r.trend) parts.push(`走势：${r.trend}`);
  if (r.issues.length) {
    parts.push('');
    r.issues.forEach((it, i) => {
      parts.push(`${i + 1}. [${SUPERVISE_KIND_LABEL[it.kind] ?? it.kind}] ${it.detail}`);
      if (it.evidence) parts.push(`   证据：${it.evidence}`);
    });
  }
  return parts.join('\n');
}

// ---- 轨迹确认（每 N 章）----

export interface TrackResult {
  verdict: 'on_track' | 'minor_drift' | 'major_drift';
  note: string;
  patch: string;
  /** 是否成功解析（解析失败按 minor_drift 保守处理，并标出来） */
  parsed: boolean;
}

/** 轨迹确认输入：总纲 + 已交付 N 章 + 伏笔状态 + 监工台账 */
export function renderTrackInput(o: {
  from: number;
  to: number;
  outline: string;
  chapters: Array<{ order: number; title: string; content: string }>;
  foreshadows?: string;
  ledger?: Array<{ order: number; verdict: string; issues: number }>;
  perChapterMax?: number;
}): string {
  const max = o.perChapterMax ?? 4000;
  const parts: string[] = [];
  parts.push('【剧情总纲（判断"偏没偏"的基准，不是让你重述它）】');
  parts.push(o.outline || '（无总纲）');
  parts.push('', `【已交付章节（第 ${o.from}–${o.to} 章）】`);
  for (const c of o.chapters) {
    const body = c.content.length <= max ? c.content : c.content.slice(0, max) + '\n…（本章过长，此处已截断）';
    parts.push(`\n———— 第 ${c.order} 章 ${c.title} ————\n${body}`);
  }
  if (o.foreshadows) parts.push('', `【伏笔状态】\n${o.foreshadows}`);
  if (o.ledger?.length) {
    parts.push('', '【监工台账】');
    for (const l of o.ledger) parts.push(`第 ${l.order} 章：${l.verdict}（${l.issues} 处问题）`);
  }
  parts.push('', '现在按输出契约给出轨迹确认的 JSON。');
  return parts.join('\n');
}

/**
 * 解析轨迹确认。
 * ★ 解析不出来按 `minor_drift` 保守处理（**不**静默当成 on_track）——
 *   与"没审出问题 vs 压根没审"同一取向：宁可记一条"请人工复核"，也不假装在轨。
 */
export function parseTrackReview(text: string): TrackResult {
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
      verdict: 'minor_drift', parsed: false, patch: '',
      note: '轨迹确认的输出没能解析成 JSON（模型没按契约回），已按保守处理；请人工复核这几章的走向。',
    };
  }

  const v = typeof raw.verdict === 'string' ? raw.verdict.toLowerCase() : '';
  const verdict: TrackResult['verdict'] =
    v === 'major_drift' ? 'major_drift' : v === 'minor_drift' ? 'minor_drift' : 'on_track';
  return {
    verdict,
    parsed: true,
    note: typeof raw.note === 'string' ? raw.note.trim() : '',
    patch: typeof raw.patch === 'string' ? raw.patch.trim() : '',
  };
}

const TRACK_VERDICT_LABEL: Record<TrackResult['verdict'], string> = {
  on_track: '在轨（继续）',
  minor_drift: '小幅偏离（已生成修正补丁，接下来几章按它走）',
  major_drift: '明显跑偏（已暂停，请作者决策）',
};

/** 渲染轨迹确认报告 */
export function renderTrackReport(from: number, to: number, r: TrackResult): string {
  const parts: string[] = [];
  parts.push(`【轨迹确认 · 第 ${from}–${to} 章】判定：${TRACK_VERDICT_LABEL[r.verdict]}`);
  if (r.note) parts.push(`结论：${r.note}`);
  if (r.verdict === 'minor_drift' && r.patch) {
    parts.push('', '—— 修正补丁（接下来 2–3 章按它走）——');
    parts.push(r.patch);
  }
  if (r.verdict === 'major_drift') {
    parts.push('', '★ 整条流水线已暂停。请作者阅读上面的结论，决定是回修、改总纲还是继续。');
  }
  return parts.join('\n');
}

// ---- 编排层 ----

export interface ProductionChapterRecord { order: number; delivered: boolean; wordCount: number; warnings: string[] }

export interface ProductionOutcome {
  chapters: ProductionChapterRecord[];
  artifact: string;
  supervisor: {
    order: number; verdict: SuperviseResult['verdict']; issues: number;
    /** 问题明细（2026-10-16 加：只留计数则事后无法回查"那 3 条是什么"） */
    detail?: Array<{ kind: string; detail: string; evidence: string }>;
  } | null;
  halted: boolean;
  track: TrackEntry | null;
  /** 本轮结束后的全书游标（已交付的最后一章） */
  cursor: number;
  /** 本轮结束后的 sinceReview（供编排层写回 cursor） */
  sinceReview: number;
}

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
    console.warn('[production] 读取已有章节失败（按空库处理）:', e);
    return 0;
  }
}

/** 回读单章（监工要用正文） */
async function loadChapter(
  ctx: ServerPluginContext, projectId: string, order: number,
): Promise<{ order: number; title: string; content: string; summary: string } | null> {
  try {
    const db = await getProjectDb(projectId) as unknown as DrizzleDb;
    const rows = await db
      .select({ order: schema.chapters.order, title: schema.chapters.title, content: schema.chapters.content, summary: schema.chapters.summary })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.projectId, projectId), eq(schema.chapters.order, order), isNull(schema.chapters.deletedAt)))
      .limit(1);
    const r = rows[0];
    return r ? { order: r.order, title: r.title || `第 ${r.order} 章`, content: r.content ?? '', summary: r.summary ?? '' } : null;
  } catch (e) {
    console.warn(`[production] 回读第 ${order} 章失败:`, e);
    return null;
  }
}

/** 取某章之前最近 n 章的摘要（供监工比"趋势"） */
async function recentSummaries(
  ctx: ServerPluginContext, projectId: string, beforeOrder: number, n = 3,
): Promise<Array<{ order: number; summary: string }>> {
  try {
    const db = await getProjectDb(projectId) as unknown as DrizzleDb;
    const rows = await db
      .select({ order: schema.chapters.order, summary: schema.chapters.summary })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.projectId, projectId), isNull(schema.chapters.deletedAt)))
      .orderBy(desc(schema.chapters.order))
      .limit(20);
    return rows
      .filter((r) => r.order < beforeOrder && r.summary)
      .slice(0, n)
      .map((r) => ({ order: r.order, summary: r.summary as string }));
  } catch (e) {
    console.warn('[production] 读取章节摘要失败（按无摘要处理）:', e);
    return [];
  }
}

/** 读一份受控的设定现状（监工/轨迹确认都要 brief 与伏笔） */
async function readGateDigest(
  ctx: ServerPluginContext, projectId: string, agentId: string,
): Promise<{ brief: string; foreshadows: string }> {
  try {
    const { digest } = await readDigestFor(ctx, projectId, agentId, 'gate-review', { narrative: true });
    return {
      brief: (digest.brief as string | undefined) ?? '',
      foreshadows: (digest.foreshadows as string | undefined) ?? '',
    };
  } catch (e) {
    console.warn('[production] 读取设定现状失败（按无设定继续）:', e);
    return { brief: '', foreshadows: '' };
  }
}

/** 跑一次监工（只读）。失败**不打断长跑** —— 返回一个保守的 watch 结果。 */
async function runSupervisor(
  ctx: ServerPluginContext,
  o: {
    projectId: string; userId: string; order: number;
    chapter: { order: number; title: string; content: string; summary: string };
    recent: Array<{ order: number; summary: string }>;
    ledger: Array<{ order: number; verdict: string; issues: number }>;
  },
): Promise<SuperviseResult> {
  const gate = createMemoryGate(ctx);
  const { brief } = await readGateDigest(ctx, o.projectId, ROLE_SUPERVISOR.key);
  const input = renderSuperviseInput({
    order: o.order, content: o.chapter.content, summary: o.chapter.summary,
    recentSummaries: o.recent, ledger: o.ledger,
  });
  const full = brief ? `【作者的开书设定】\n${brief}\n\n${input}` : input;

  try {
    await createAgentMemory({ ctx, projectId: o.projectId, agentId: ROLE_SUPERVISOR.key, gate })
      .writeOwn(experience(`exp.prod.supervise.ch${o.order}`, {
        kind: 'said', text: `监工第 ${o.order} 章`, ref: `production#${o.order}`,
      }));
  } catch (e) {
    console.warn('[production] 写监工经历失败（不影响本段）:', e);
  }
  try {
    await writeAudit(ctx, {
      projectId: o.projectId, agentId: ROLE_SUPERVISOR.key, action: 'assemble',
      keys: ['settings.brief', 'chapter.*'], reason: 'chapter-write', allow: true,
      detail: `监工注入 ${full.length} 字（第 ${o.order} 章）`, fingerprint: fingerprintOf(full),
    });
  } catch (e) {
    console.warn('[production] 监工装配指纹写入失败（不影响本段）:', e);
  }

  try {
    const result = await ctx.ai.agents.run({
      system: await createAgentSkillResolver(ctx, o.userId).systemFor(ROLE_SUPERVISOR.key, ROLE_SUPERVISOR.system),
      input: full,
      maxTurns: 2,
      maxTokens: STAGE_SPEAK_MAX_TOKENS,
      context: { projectId: o.projectId, userId: o.userId },
    });
    const text = String(result.text ?? '').trim();
    if (!text) throw new Error('监工未产出内容');
    return parseSuperviseReport(text, o.order);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn('[production] 监工调用失败:', e);
    // 监工失败**不打断长跑**：判 watch（parsed:false，不计入 halt 计数），如实记下来
    return {
      order: o.order, verdict: 'watch', parsed: false, trend: '',
      issues: [{ kind: 'continuity', detail: `监工没能跑完：${detail}`, evidence: '' }],
    };
  }
}

/** 跑一次轨迹确认（回到剧情设计师）。失败同样保守处理，不打断。 */
async function runTrackReview(
  ctx: ServerPluginContext,
  o: {
    projectId: string; userId: string; from: number; to: number;
    outline: string;
    chapters: Array<{ order: number; title: string; content: string }>;
    foreshadows: string;
    ledger: Array<{ order: number; verdict: string; issues: number }>;
  },
): Promise<TrackResult> {
  const gate = createMemoryGate(ctx);
  const input = renderTrackInput({
    from: o.from, to: o.to, outline: o.outline, chapters: o.chapters,
    foreshadows: o.foreshadows, ledger: o.ledger,
  });

  try {
    await createAgentMemory({ ctx, projectId: o.projectId, agentId: ROLE_PLOT.key, gate })
      .writeOwn(experience(`exp.prod.track.${o.from}-${o.to}`, {
        kind: 'said', text: `轨迹确认第 ${o.from}–${o.to} 章`, ref: `production#${o.from}-${o.to}`,
      }));
  } catch (e) {
    console.warn('[production] 写轨迹确认经历失败（不影响本段）:', e);
  }
  try {
    await writeAudit(ctx, {
      projectId: o.projectId, agentId: ROLE_PLOT.key, action: 'assemble',
      keys: ['settings.brief', 'chapter.*'], reason: 'chapter-write', allow: true,
      detail: `轨迹确认注入 ${input.length} 字（第 ${o.from}–${o.to} 章）`, fingerprint: fingerprintOf(input),
    });
  } catch (e) {
    console.warn('[production] 轨迹确认装配指纹写入失败（不影响本段）:', e);
  }

  try {
    const result = await ctx.ai.agents.run({
      system: await createAgentSkillResolver(ctx, o.userId).systemFor(ROLE_PLOT.key, ROLE_PLOT.system),
      input,
      maxTurns: 2,
      maxTokens: STAGE_SPEAK_MAX_TOKENS,
      context: { projectId: o.projectId, userId: o.userId },
    });
    const text = String(result.text ?? '').trim();
    if (!text) throw new Error('轨迹确认未产出内容');
    return parseTrackReview(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn('[production] 轨迹确认调用失败:', e);
    return {
      verdict: 'minor_drift', parsed: false, patch: '',
      note: `轨迹确认没能跑完：${detail}。已按保守处理，请人工复核这几章的走向。`,
    };
  }
}

/** 汇总本轮长跑的报告（给人看，也存进阶段契约） */
export function renderProductionReport(o: {
  chapters: ProductionChapterRecord[];
  supervisor: { order: number; verdict: string; issues: number } | null;
  track: TrackEntry | null;
  halted: boolean;
  cursor: number;
}): string {
  const parts: string[] = [];
  const done = o.chapters.filter((c) => c.delivered);
  parts.push(`【长跑】本轮 ${o.chapters.length} 章，已交付 ${done.length} 章；全书已写到第 ${o.cursor} 章。`);
  parts.push('');
  parts.push('交付情况：' + (o.chapters.map((c) => `第 ${c.order} 章 ${c.delivered ? `已交付（${c.wordCount} 字）` : '未交付'}`).join('；') || '（无）'));
  const warned = o.chapters.filter((c) => c.warnings.length);
  if (warned.length) {
    parts.push('', '—— 带警示 ——');
    for (const c of warned) parts.push(`第 ${c.order} 章：${c.warnings.join('；')}`);
  }
  if (o.supervisor) {
    parts.push('', `监工（第 ${o.supervisor.order} 章）：${SUPERVISE_VERDICT_LABEL[o.supervisor.verdict as SuperviseResult['verdict']] ?? o.supervisor.verdict}（${o.supervisor.issues} 处问题）`);
  }
  if (o.track) {
    parts.push('', `轨迹确认（第 ${o.track.from}–${o.track.to} 章）：${TRACK_VERDICT_LABEL[o.track.verdict]}`
      + (o.track.note ? ` —— ${o.track.note}` : ''));
  }
  if (o.halted) {
    parts.push('', '★ 长跑已停下（监工 halt 或轨迹 major_drift）。处理后再点「继续长跑」即从第 '
      + (o.cursor + 1) + ' 章接着写。');
  } else {
    parts.push('', `继续点「长跑」即从第 ${o.cursor + 1} 章接着写。`);
  }
  return parts.join('\n');
}

/**
 * 跑一批长跑：PRODUCTION_BATCH 章串行 + 逐章监工 + （到点）轨迹确认。
 *
 * 失败取向（与单章闭环/pilot 一致）：**一章没交上去不打断整批** —— 手里有 N-1 章
 * 也比"什么都没有"强；但交付情况逐章记进 `chapters`（含 delivered=false），报告照实写。
 * 唯一主动停下的情形是监工 `halt` 或轨迹 `major_drift`（见文件头注释）。
 */
export async function runProduction(
  ctx: ServerPluginContext,
  opts: {
    projectId: string; userId: string;
    extra?: string;
    lastDelivered?: number;
    sinceReview?: number;
    reviewEvery?: number;
    /** 已批准的《剧情总纲》等契约（轨迹确认的对照物） */
    contracts?: Array<{ label: string; text: string }>;
    /** minor_drift 补丁（上一轮轨迹确认留下的，注入本批第一章） */
    pendingPatch?: string;
  },
  emit: (e: PipelineEvent) => void,
): Promise<ProductionOutcome> {
  const { projectId, userId } = opts;
  const reviewEvery = opts.reviewEvery ?? PRODUCTION_REVIEW_EVERY;

  const last = opts.lastDelivered && opts.lastDelivered > 0
    ? opts.lastDelivered
    : await maxChapterOrder(ctx, projectId);
  const orders = planProductionChapterOrders(last);
  const total = orders.length;
  const records: ProductionChapterRecord[] = [];
  const ledger: Array<{ order: number; verdict: string; issues: number }> = [];
  const superviseHistory: SuperviseResult[] = [];
  let cursor = last;
  let halted = false;
  let supervisorSummary: ProductionOutcome['supervisor'] = null;
  let sinceReview = opts.sinceReview ?? 0;

  /**
   * ★ 2026-10-16：监工 halt 不再**打断**长跑，改为「记台账 + 立刻拿修正补丁」。
   *
   * 为什么改（实测）：这套监工提示词极其严格，长跑后段**几乎每章都给 watch 甚至 halt**
   *   （v8 第 4–7 章连续 watch、v9 第 8 章 halt）。若 halt 就停，30 万字（约 110 章）
   *   在结构上跑不完 —— 每几章就被打断一次。
   *
   * 新行为：halt → 记进台账（supervisorHalted=true，作者事后可查）→ **就地跑一次轨迹确认**
   *   （剧情设计师回看这几章、给「接下来 2–3 章必须修正什么」的补丁）→ 补丁注入**后续每一章**
   *   → 继续往下写。于是"发现问题"仍然触发"修正动作"，但不再把整条流水线停住。
   */
  let livePatch: string = opts.pendingPatch ?? '';
  /** 本轮轨迹确认结果（可能在循环内被"监工触发"改写，故在循环前声明） */
  let track: TrackEntry | null = null;

  for (let i = 0; i < total; i++) {
    const order = orders[i]!;
    const index = i + 1;
    emit({ type: 'production_chapter', index, total, order, phase: 'start' });

    // 作者补充 + **当前生效的修正补丁**。补丁对后续**每一章**都注入 ——
    // 改掉 halt 行为后补丁会中途产生，只给每批第一章就压不住后面几章。
    const chapterExtra = [opts.extra, livePatch ? `【轨迹修正补丁（必须遵守）】\n${livePatch}` : '']
      .filter(Boolean).join('\n\n') || undefined;

    const { bridge, result } = createChapterBridge({
      stage: 'production', order, emit,
      onDelivered: ({ order: o }) => { cursor = Math.max(cursor, o); },
    });
    const warnings = result().warnings;

    try {
      await runDiscussion(
        ctx,
        {
          projectId, userId,
          message: productionMessage(order, last > 0 || i > 0, chapterExtra),
          chapterOrder: order,
          finalDone: false,
        },
        bridge,
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      warnings.push(`异常中止：${detail}`);
      emit({ type: 'stage_phase', stage: 'production', label: `第 ${order} 章异常中止：${detail}` });
    }

    const { delivered, wordCount } = result();
    records.push({ order, delivered, wordCount, warnings });
    if (delivered) sinceReview += 1;
    emit({
      type: 'production_chapter', index, total, order, phase: 'done',
      delivered, wordCount, cursor, ...(warnings.length ? { warnings } : {}),
    });

    // ---- 逐章监工（只读）。只在**交付成功**时跑：没交付的章没有正文可巡检 ----
    if (delivered) {
      const chapter = await loadChapter(ctx, projectId, order);
      if (chapter) {
        const recent = await recentSummaries(ctx, projectId, order, 3);
        emit({ type: 'stage_phase', stage: 'production', label: `第 ${order} 章监工巡检中` });
        const sup = await runSupervisor(ctx, {
          projectId, userId, order, chapter, recent, ledger,
        });
        superviseHistory.push(sup);
        ledger.push({ order, verdict: sup.verdict, issues: sup.issues.length });
        // ★ 2026-10-16：把 issues **明细**一起留档。此前只存条数，导致事后
        //   「第 13 章 watch（3 处问题）」回查不到那 3 条到底是什么 —— 监工的价值
        //   全在明细上，只留计数等于白巡检（实测踩到）。
        supervisorSummary = {
          order, verdict: sup.verdict, issues: sup.issues.length,
          detail: sup.issues.map((it) => ({
            kind: it.kind, detail: it.detail, evidence: it.evidence,
          })),
        };
        emit({
          type: 'supervise_report', order,
          verdict: sup.verdict,
          issues: sup.issues.map((it) => `[${SUPERVISE_KIND_LABEL[it.kind] ?? it.kind}] ${it.detail}`),
          trend: sup.trend,
        });
        if (superviseShouldHalt(superviseHistory)) {
          // ★ 不再 break。记台账（supervisorHalted=true，作者可查）+ 立刻拿修正补丁。
          halted = true;
          emit({
            type: 'stage_phase', stage: 'production',
            label: `第 ${order} 章监工判需修正：记台账并取修正补丁，长跑继续（不再打断）`,
          });
          // 就地跑一次轨迹确认：剧情设计师回看刚交付的这几章，给"接下来 2–3 章必须改什么"。
          // 它本身就是为"跑偏/原地打转"设计的，halt 场景正是它该上场的时候。
          try {
            const win = orders.slice(0, i + 1).filter((_o, idx) => records[idx]?.delivered);
            const from = win[0] ?? order;
            const to = win[win.length - 1] ?? order;
            const chapters: Array<{ order: number; title: string; content: string }> = [];
            for (const o of win) {
              const c = await loadChapter(ctx, projectId, o);
              if (c) chapters.push({ order: c.order, title: c.title, content: c.content });
            }
            if (chapters.length > 0) {
              emit({ type: 'stage_phase', stage: 'production', label: `轨迹确认（监工触发）：回看第 ${from}–${to} 章` });
              const { foreshadows } = await readGateDigest(ctx, projectId, ROLE_PLOT.key);
              const outline = opts.contracts?.find((c) => c.label.includes('剧情'))?.text ?? '';
              const tr = await runTrackReview(ctx, {
                projectId, userId, from, to, outline, chapters, foreshadows, ledger,
              });
              track = {
                from, to, at: Date.now(), by: userId,
                verdict: tr.verdict, note: tr.note,
                ...(tr.patch ? { patch: tr.patch } : {}),
              };
              // 补丁立刻生效：注入**后续每一章**（见循环顶部的 chapterExtra）
              if (tr.patch) livePatch = tr.patch;
              emit({
                type: 'track_review', from, to,
                verdict: tr.verdict, note: tr.note,
              });
              // 这次确认已经"用掉"了本轮的窗口计数
              sinceReview = 0;
            }
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            warnings.push(`监工触发轨迹确认失败：${detail}`);
          }
        }
      }
    }
  }

  // ---- 轨迹确认（按窗口到点，补一次）----
  //   `track` 已在循环前声明（监工触发的那次可能已经写过它）。这里只在**还没有**
  //   结果、且窗口到点时才补跑；监工已经触发过就把 sinceReview 归零了，不会重复跑。
  if (!track && sinceReview >= reviewEvery) {
    const doneOrders = records.filter((r) => r.delivered).map((r) => r.order);
    const from = doneOrders[0] ?? cursor - sinceReview + 1;
    const to = doneOrders[doneOrders.length - 1] ?? cursor;
    if (doneOrders.length > 0) {
      emit({ type: 'stage_phase', stage: 'production', label: `轨迹确认：回看第 ${from}–${to} 章` });
      const chapters: Array<{ order: number; title: string; content: string }> = [];
      for (const o of doneOrders) {
        const c = await loadChapter(ctx, projectId, o);
        if (c) chapters.push({ order: c.order, title: c.title, content: c.content });
      }
      const { foreshadows } = await readGateDigest(ctx, projectId, ROLE_PLOT.key);
      const outline = opts.contracts?.find((c) => c.label.includes('剧情'))?.text ?? '';
      const tr = await runTrackReview(ctx, {
        projectId, userId, from, to, outline, chapters, foreshadows, ledger,
      });
      track = {
        from, to, at: Date.now(), by: userId,
        verdict: tr.verdict, note: tr.note,
        ...(tr.patch ? { patch: tr.patch } : {}),
      };
      emit({ type: 'track_review', from, to, verdict: tr.verdict, note: tr.note });
      if (tr.verdict === 'major_drift') {
        halted = true;
      } else {
        // on_track / minor_drift 都算"确认过了"，计数归零
        sinceReview = 0;
      }
    }
  }

  const artifact = renderProductionReport({
    chapters: records, supervisor: supervisorSummary, track, halted, cursor,
  });
  return {
    chapters: records,
    artifact,
    supervisor: supervisorSummary,
    halted,
    track,
    cursor,
    sinceReview,
  };
}

/** production 的落库验收提示（只看库，不看承诺） */
export function productionSinkNotes(records: ProductionChapterRecord[]): string[] {
  const notes: string[] = [];
  const missed = records.filter((r) => !r.delivered);
  if (missed.length) notes.push(`${missed.length} 章未落库：${missed.map((r) => `第 ${r.order} 章`).join('、')}`);
  const warned = records.filter((r) => r.warnings.length);
  if (warned.length) notes.push(`${warned.length} 章带警示交付`);
  return notes;
}
