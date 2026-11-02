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
import { parseJsonTolerant } from '../framework/text.js';
import { readDigestFor } from '../framework/memory/digest-gate.js';
import { createAgentSkillResolver } from '../framework/agent-skills.js';
import {
  createAgentMemory, createMemoryGate, experience, fingerprintOf, writeAudit,
} from '../framework/memory/index.js';
import { ROLE_PLOT, WRITER_MIN_CHARS, WRITER_MAX_CHARS } from '../discuss/roles.js';
import { ROLE_SUPERVISOR, TRACK_SYSTEM, STAGE_SPEAK_MAX_TOKENS } from './roles-phase.js';
import { extractBeatCard, renderBeatCard, type BeatCard } from './beats.js';
import { checkBeatCoverage, generateBeatCards, appendBeatCards } from './beat-rolling.js';
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
 * 从《剧情总纲》里读出**这本书计划写多少章**。读不出来返回 null（= 不设上限）。
 *
 * ★ 2026-10-22：这条守卫是拿一本书跑飞 85 章换来的。
 *   实测：总纲白纸黑字写着「三幕（第 19–24 章）… 章 24 成与真相了结之人」，
 *   而且**确实注入了模型**（digest 6000 字截断后三幕那三行全部存活，我量过），
 *   但**没有任何代码拦「第 85 章」** —— `production` 里大纲只被轨迹确认（只读检查）用到。
 *   于是长跑控件「写到第 N 章」只要 N 填得够大，就能一路越过总纲把它写完。
 *   轨迹确认确实每次都报 major_drift（54–58 起 7 次），可那只是"事后喊停"，
 *   而且是**可被作者点「继续长跑」按掉**的软信号。这道是硬边界。
 *
 * 识别三种写法（实测语料）：
 *   · 「三幕：（第 19–24 章）…」        → 24
 *   · 「三幕共 24 章」「全书 24 章」     → 24
 *   · 「第1章：…」这种逐章条目          → 取最大章号
 * 取所有命中里的**最大值**（逐章条目可能比幕范围更长，也可能反过来）。
 */
export function parseOutlineChapterLimit(outline: string | undefined | null): number | null {
  const t = String(outline ?? '');
  if (!t.trim()) return null;

  // ★ 2026-10-30 改口径（实测误伤）：**单条逐章条目视为噪声，两条以上才算章节清单**。
  //
  // 旧口径把所有来源的命中**混在一起取最大值**，于是这两类文本会互相污染。
  // 实测事故（《铁壳里的声音》）：plot 段的 artifact 不是大纲本体，而是**定稿官的裁决书**，
  // 全文只有一句「可开第1章：收、拆、掉带」—— 里面那唯一一条
  // 「第1章：」被当成"全书计划 1 章" ⇒ 上限 = 1。
  // 而库里已有第 1–3 章 ⇒ 每批都判 `overrun` ⇒ **长跑一章不写、空转 6 万批**。
  // 同一份状态里 `beats` 明确写着「第1–10章」，却被 plot 的误读盖住（旧代码只读 plot）。
  //
  // 新口径判据只有一条：**孤立的一条「第N章：」不可信，成串（≥2 条）才可信**。
  //   · 「可开第1章：…」是**开工指示**，只有一条 ⇒ 丢弃（事故正是这一条）；
  //   · 「第25章：尾声 / 第26章：后记」是**真章节清单** ⇒ 保留，且可以长于幕范围；
  //   · 范围写法（第1–10章 / 共 24 章）永远是作者对篇幅的明确承诺，总是保留。
  //   最后对**保留下来的信号取最大值** —— 既不丢尾章，也不会被一条误读压到 1。
  const rangeHits: number[] = [];
  const itemHits: number[] = [];

  // ① 范围写法：（第 19–24 章）/ 第19-24章 / （第1至24章）
  //    ★ 2026-10-22 实测补漏：**真契约里不写"第"字** —— 实际文本是「一幕章1–6」「三幕章19–24」。
  //      第一版正则强制要求"第"，结果在这本书上读出 null、守卫等于没装
  //      （`__tests__` 里用「（第 19–24 章）」造的样例反而过了，典型的"照着自己想象写测试"）。
  //      现在「第」可选，并且**允许没有"章"字后缀**（"章19–24"是"章"在前）。
  for (const m of t.matchAll(/第?\s*(\d+)\s*[–—\-~至到]\s*(\d+)\s*章?/g)) {
    rangeHits.push(Number(m[2]));
  }
  // ①b "章19–24" 这种章字在前的写法
  for (const m of t.matchAll(/章\s*(\d+)\s*[–—\-~至到]\s*(\d+)/g)) {
    rangeHits.push(Number(m[2]));
  }
  // ② "共 N 章" / "全书 N 章" / "合计 N 章"
  for (const m of t.matchAll(/(?:共|全书|总计|合计)\s*(\d+)\s*章/g)) {
    rangeHits.push(Number(m[1]));
  }
  // ③ 逐章条目："第 12 章：…"（孤立一条视为噪声，见上）
  for (const m of t.matchAll(/第\s*(\d+)\s*章\s*[：:]/g)) {
    itemHits.push(Number(m[1]));
  }

  const ok = (n: number) => Number.isFinite(n) && n > 0 && n < 2000;
  const signals = [...rangeHits.filter(ok)];
  const items = itemHits.filter(ok);
  // 孤立的一条逐章条目不构成"全书上限"的证据（见上面的事故说明）
  if (items.length >= 2) signals.push(...items);
  return signals.length > 0 ? Math.max(...signals) : null;
}

/**
 * 本批实际要写的章号 —— 在总纲上限处**截断**。
 * 返回 `{ orders, cappedBy }`：`cappedBy` 非空表示"因为总纲只到第 N 章，本批被截短了"。
 */
export function planWithinOutline(
  lastDelivered: number,
  limit: number | null,
  batch = PRODUCTION_BATCH,
): { orders: number[]; cappedBy: number | null; overrun: boolean } {
  const all = planProductionChapterOrders(lastDelivered, batch);
  if (limit == null) return { orders: all, cappedBy: null, overrun: false };
  const allowed = all.filter((o) => o <= limit);
  // ★ 原计划一章都不剩 = 已经写到（或越过）总纲上限 → **一章都不写**。
  //   第一版这里写成 `all.slice(0, 1)`（"至少写一章免得空转"），那等于守卫自己越纲 ——
  //   实测已交付 85 章、总纲只到 24 章，它会继续写第 86 章。必须直接拒。
  return {
    orders: allowed,
    // `cappedBy` 只表示「本批被总纲截短了」；没有截短时保持 null（否则调用方会误报"已到上限"）
    cappedBy: allowed.length < all.length ? limit : null,
    overrun: allowed.length === 0,
  };
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

/**
 * 单章指令 —— **有节拍卡时以卡为准**。
 *
 * ★ 2026-10-23：这是"大纲牵引"真正落地的那一行。
 *   旧版（上面那个 `productionMessage`）说「按《剧情总纲》里第 N 章的节拍走」——
 *   而总纲只写到第 24 章，第 25 章之后**那句话是假的**，模型只能凭最近三章的手感往下接。
 *   有卡时改为把**这张卡整张塞进创作指令**，并明确"以卡为准、总纲只作背景"。
 *
 *   `card` 为 null（这一段还没规划到这一章）→ **明确说出来**，并给出补救动作，
 *   而不是继续假装有节拍可依。
 */
export function productionMessageWithCard(
  order: number,
  hasPrevious: boolean,
  card: BeatCard | null,
  extra?: string,
): string {
  const tail = extra ? `\n\n【作者补充】\n${extra}` : '';
  if (!card) {
    /**
     * ★ 2026-10-30 修（实测灾难）：**不许再叫模型"先去补卡"**。
     *
     * 原文写的是「请先回到「章节大纲与节拍卡」段为本章补卡」——
     * 而写作官**没有这个工具、也不该干这件事**（补纲由 `beat-rolling` 负责）。
     * 它只能照字面在**正文里**补一张卡，然后接一句「以下为修正后完整正文：」。
     * 实测第 4 章整章前半段就是这样一张【第4章节拍卡】+ 工作笔记，
     * 连同「删去越章面摊段，章内补对话提占比」这种自我指令一起被当正文交付了。
     *
     * 正确说法：**把缺卡当成写作时的已知条件**，而不是派给它的任务。
     * 同时明确"正文里不许出现节拍卡/任务清单"—— 不给它任何把工作笔记写进正文的入口。
     */
    return [
      `接着上一章往下写第 ${order} 章。`,
      '',
      '（说明：本章暂时没有节拍卡，**这不是你要处理的事** —— 你只负责写正文。）',
      '缺少施工图时，本章必须至少有一个**不可逆的结果**（处境 / 关系 / 信息 / 筹码变了一样），',
      '并且不许重述上一章已经演过的场景。',
      '',
      '⚠️ **你的输出就是本章正文本身**：',
      '· 不要写节拍卡、不要列提纲、不要交代"补卡""删减""提对话占比"这类工作过程；',
      '· 不要写"以下为正文"这类前言 —— 从第一个字起就是正文。',
    ].join('\n') + tail;
  }
  const head = hasPrevious
    ? `接着上一章往下写第 ${order} 章。`
    : `写出第 ${order} 章正文。`;
  return [
    head,
    '',
    '**本章以下面的节拍卡为准**（它是这一章的施工图；《剧情总纲》只作背景，卡与总纲冲突时以卡为准）：',
    '',
    renderBeatCard(card),
    '',
    /**
     * ★ 2026-10-30 修（实测篇幅缩水）：**卡是骨架，不是成品**。
     *
     * 实测：加卡之后章节明显变短 —— 无卡段（74–86）均 2743 字、仅 2 章欠下限；
     * **有卡段（87–106）均 2524 字、10 章欠下限**。根因是写作官把"3–5 拍"当成了
     * **成品清单**：每拍写一两段就交，卡说完就停，不再展开。
     *
     * 而卡的拍数只是**结构骨架**（一章 3–5 拍是工程选择，不是篇幅上限）：
     * 每一拍都要展开成完整的场景 —— 动作、对话、感官细节、心理转折都写足。
     */
    `**卡是骨架，不是成品**：每一拍都要展开成**完整的场景**（人物动作、对话、感官细节、处境变化都要写足），`,
    `不能一两段带过。3–5 拍展开后自然就是 2500–3500 字；**本章篇幅仍须落在 ${WRITER_MIN_CHARS}–${WRITER_MAX_CHARS} 字之间**。`,
    '',
    '保持人物、伏笔与文风连续；**不要重述上一章已经写过的内容**。',
  ].join('\n') + tail;
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
  // ★ 2026-10-21：改用宽容解析（先严格、失败再补未转义的引号）。
  //   实测监工/轨迹确认**每一条**都因正文里的裸引号而被判「没能解析成 JSON」——
  //   不是模型没回，是解析器太严（详见 text.ts 的 repairUnescapedQuotes）。
  const raw = parseJsonTolerant(text);

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
  // 同上：走宽容解析，避免"正文里有对话引号"就让整份轨迹确认作废
  const raw = parseJsonTolerant(text);

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
  /**
   * ★ 2026-10-29：**为什么**停下。三种情况的后处置完全不同，不能混用一个 halted：
   *   · outline-overrun —— 本批 0 章（越纲）→ 前端/脚本都该**停**（继续只会空转）
   *   · supervisor-halt —— 监工判需修正，但**本批照常写完了** → 该**继续**（后端注释明写不再打断）
   *   · major-drift —— 轨迹确认判定明显跑偏 → 该**停**，交作者决策
   */
  haltReason?: 'outline-overrun' | 'supervisor-halt' | 'major-drift';
  track: TrackEntry | null;
  /** 本轮结束后的全书游标（已交付的最后一章） */
  cursor: number;
  /**
   * ★ 2026-10-29：本轮**在线补纲**产出的新节拍卡（若有）。
   * 编排层负责写回  —— 否则下一批会重复补同一段。
   * 未补纲时为 undefined。
   */
  beatArtifact?: string;
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
      /**
       * ★ 2026-10-21 修的真 bug：这里原来传的是 `ROLE_PLOT.system` —— 剧情设计师的
       *   **讨论人格**，而那份契约末尾明写「不要 JSON、不要小标题堆砌」。
       *   于是模型一边被要求"只输出 JSON"，一边被系统提示词要求"不要 JSON"，
       *   结果**每一条**轨迹确认都解析失败、一律降级成 minor_drift（memory 里记的
       *   「pipeline_tracks 5/5 全部输出没能解析成 JSON」就是这个）。
       *   `TRACK_SYSTEM`（= `TRACK_PLOT_ROLE` 的 system）才是带 JSON 契约的那份，此前是死代码。
       */
      system: await createAgentSkillResolver(ctx, o.userId).systemFor(ROLE_PLOT.key, TRACK_SYSTEM),
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
    /**
     * ★ 2026-10-29：**心跳** —— 每章开始前调一次，给阶段续 。
     * 没有它，一批跑超过 20 分钟就会被僵死扫描判成 failed（实测踩到）。
     */
    touchRunning?: () => Promise<void>;
    /**
     * ★ 2026-10-29：《剧情总纲》的章数上限（**用未截断全文算好传入**）。
     * 见下方 outlineLimit 的注释 —— contracts 里的 plot 是截断版，长总纲会解析不出上限。
     */
    outlineChapterLimit?: number | null;
    /** minor_drift 补丁（上一轮轨迹确认留下的，注入本批第一章） */
    pendingPatch?: string;
  },
  emit: (e: PipelineEvent) => void,
): Promise<ProductionOutcome> {
  const { projectId, userId } = opts;
  const reviewEvery = opts.reviewEvery ?? PRODUCTION_REVIEW_EVERY;

  /**
   * 「已经写到第几章」——**流水线游标与库里实际章数取更大者**。
   *
   * ★ 2026-10-29 修（实测）：原先只用 `opts.lastDelivered`（流水线游标），
   *   而**单章讨论模式（`/session`）写出的章不更新流水线游标**。
   *   实测后果：《雾港长夜》库里已有 86 章，游标却停在 73 ——
   *   于是长跑从**第 74 章**开始写，撞上「该章已有正文，不覆盖」，
   *   一批 5 章全部 `deliver_blocked`，白烧。
   *
   *   游标是"框架以为写到哪"，DB 是"实际写到哪"。两者不一致时**必须以实际为准**
   *   （否则会重复写已存在的章）。取 max 而不是直接换成 DB：游标可能包含
   *   DB 里查不到的进度（例如章被软删过），取大者两边都不丢失。
   */
  const dbMax = await maxChapterOrder(ctx, projectId);
  const last = Math.max(opts.lastDelivered ?? 0, dbMax);

  /**
   * ★ 2026-10-22：**总纲硬边界**。长跑只能写到《剧情总纲》计划的章数为止。
   *   （为什么需要：见 `parseOutlineChapterLimit` 的注释 —— 一本书因此跑飞了 85 章。）
   *   读不出总纲章数时不设限（老项目 / 没立总纲时保持原行为）。
   */
  /**
   * ★ 2026-10-29 修（审计确认）：总纲上限要读**未截断**的原文。
   *
   * `contracts` 里 plot 用 `cut(art, 4000)`（为注入上下文省 token），而
   * `parseOutlineChapterLimit` 靠正则从中找「共 N 章」—— **长篇总纲的这句若落在
   * 4000 字之外，就读出 null，硬边界等于没装**（这正是 2026-10-22 那本书跑飞 85 章的同类风险）。
   *
   * 修法：编排层用**全文**算好上限传下来（`opts.outlineChapterLimit`），
   * 不把全文塞进模型 prompt（那是另一回事，仍按预算截断）。
   * 没传时退回从 contracts 解析（保持老行为）。
   */
  const outlineText = opts.contracts?.find((c) => c.label.includes('剧情'))?.text ?? '';
  const outlineLimit = opts.outlineChapterLimit !== undefined
    ? opts.outlineChapterLimit
    : parseOutlineChapterLimit(outlineText);
  const planned = planWithinOutline(last, outlineLimit);
  const orders = planned.orders;
  if (planned.overrun) {
    /**
     * 已经写到（或越过）总纲上限 → **本批一章都不写**，直接把情况交给作者。
     *
     * ★ 实测教训：这本书的总纲写着「三幕章19–24」（即 24 章收尾），却一路写到 85 章。
     *   轨迹确认从第 54 章起报了 7 次 major_drift，但那是**可被点「继续长跑」按掉**的软信号。
     *   这道硬边界的作用是：不管长跑控件把目标填成多少，都不许自动越过作者定下的总纲。
     */
    emit({
      stage: 'production', type: 'stage_phase',
      label: `《剧情总纲》只计划到第 ${planned.cappedBy} 章，但已交付到第 ${last} 章 —— `
        + '本批不写任何新章。要继续往下写，请先改总纲（这是作者决策，框架不自动越纲）。',
    });
    const overrunMsg = `已越过《剧情总纲》上限（第 ${planned.cappedBy} 章），本批未写新章；请先改总纲或确认超纲继续`;
    return {
      chapters: [],
      artifact: overrunMsg,
      supervisor: null,
      halted: true,          // 让编排层按"已停下"处理，而不是当作正常跑完一批
      haltReason: 'outline-overrun',
      track: null,
      cursor: last,
      sinceReview: opts.sinceReview ?? 0,
    };
  }
  if (planned.cappedBy != null) {
    emit({
      stage: 'production', type: 'stage_phase',
      label: `《剧情总纲》只计划到第 ${planned.cappedBy} 章 —— 本批写到第 ${planned.cappedBy} 章为止；`
        + '要继续往下写，请先改总纲（作者决策，框架不自动越纲）',
    });
  }
  const total = orders.length;
  const records: ProductionChapterRecord[] = [];
  const ledger: Array<{ order: number; verdict: string; issues: number }> = [];
  const superviseHistory: SuperviseResult[] = [];
  let cursor = last;
  let halted = false;
  /** 停下的原因（见 ProductionOutcome.haltReason） */
  let haltReason: 'outline-overrun' | 'supervisor-halt' | 'major-drift' | undefined;
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
  /** ★ 在线补纲产出的节拍卡（累积给编排层写回；见 beat-rolling.ts 与 orchestrator 的注释） */
  let rollingBeats: string | undefined;
  /** 本轮轨迹确认结果（可能在循环内被"监工触发"改写，故在循环前声明） */
  let track: TrackEntry | null = null;

  for (let i = 0; i < total; i++) {
    const order = orders[i]!;
    const index = i + 1;
    // 心跳：这一批可能跑 20–60 分钟，每章开头续一次 runningSince，避免被僵死扫描误杀
    try { await opts.touchRunning?.(); } catch (e) { console.warn('[production] 心跳失败（不影响写作）:', e); }
    emit({ type: 'production_chapter', index, total, order, phase: 'start' });

    // 作者补充 + **当前生效的修正补丁**。补丁对后续**每一章**都注入 ——
    // 改掉 halt 行为后补丁会中途产生，只给每批第一章就压不住后面几章。
    const chapterExtra = [opts.extra, livePatch ? `【轨迹修正补丁（必须遵守）】\n${livePatch}` : '']
      .filter(Boolean).join('\n\n') || undefined;

    const { bridge, result } = createChapterBridge({
      stage: 'production', order, emit,
      onDelivered: ({ order: o }) => { cursor = Math.max(cursor, o); },
    });

    /**
     * ★ 2026-10-23：取出本章的**节拍卡**，作为写作指令的施工图。
     *   卡来自《章节大纲与节拍卡》契约（`opts.contracts` 里 label 含「节拍」/「章节大纲」的那份）。
     *   取不到就是 null —— 写作指令会**明确说"本章还没有卡"**，而不是继续假装有节拍可依。
     */
    /**
     * ★ 2026-10-29：**在线补纲** —— 本章没有节拍卡就现场补一批（默认 5 章）。
     *
     * 背景（实测）：节拍卡只覆盖第 1–10 章，而书写到第 85 章 ——
     * **75 章（88%）是在没有施工图的情况下写的**。这就是「开头重复 7/10」「平缓日常章」
     * 「跨章重复 188 句」的共同上游原因：没有新事件可写，模型只能反复做同一个动作。
     *
     * 补卡走与 beats 段同构的角色阵容，但**不改流水线游标**（增补，不是重跑）。
     * 补不出来就按无卡继续写（fail-open），绝不卡住长跑。
     */
    const beatRef = opts.contracts?.find((c) => /节拍|章节大纲/.test(c.label));
    let beatArtifact = beatRef?.text ?? '';
    {
      /**
       * ★ 起点用**全书已交付的最大章号**，不是本批的 `cursor`。
       *   第一版实测：`cursor` 是本批游标（从 `last` 开始、循环内才增长），
       *   于是"卡只到 10、已写到 73"时算出要补 **74–78** —— 而 74–78 早就写完了。
       *   补已写章节的卡毫无意义（节拍卡是未来章节的施工图）。
       */
      const deliveredMax = Math.max(cursor, await maxChapterOrder(ctx, projectId));
      const check = checkBeatCoverage(beatArtifact, order, deliveredMax);
      if (check.needed) {
        const fresh = await generateBeatCards(
          {
            ctx, projectId, userId, emit,
            /**
             * 补纲用的"发言"实现：与 `runStage` 的 speak 同口径（技能注入 + 阶段 token 上限），
             * 但**不写 transcript、不记 L2、不发 stage_turn** —— 补纲是旁路增补，
             * 不该污染当前 production 段的讨论记录（那是每章写作的上下文）。
             */
            speak: async (role, extra) => {
              const skills = createAgentSkillResolver(ctx, userId);
              /**
               * ★ 2026-10-29 修（实测抓到的真 bug）：**补纲必须让角色看到项目现状**。
               *
               * 第一版只拼 `extra`（任务）—— 角色是"盲写"的。后果实测：
               * 补出的卡里凭空出现了一个**库里根本没有的角色「陆绯」**，
               * 让"陆绯"顶替主角去换俘。虽然讨论环节的安全网兜住了
               * （角色设计师质疑「陆绯前两章没定位」→ 设定管家查库确认「没有陆绯任何设定」
               *   → 剧情设计师改正回林砚），但**白烧了一轮重写**。
               *
               * 正常讨论路径由 `headerFor()` 按角色的 L1 权限过滤摘要（角色设计师看到角色库、
               * 设定管家看到设定…）。补纲走的是旁路，必须自己补上这一步，
               * 否则"讨论"就退化成凭印象编造。
               */
              let digestBlock = '';
              try {
                // 复用已有的 `discuss-context` 读因（同一条链路上语义一致：
                // 都是"讨论前的装配，每个角色按自己的白名单拿一份"）
                const { digest } = await readDigestFor(ctx, projectId, role.key, 'discuss-context', { narrative: true });
                const parts = [
                  digest.brief ? `【开书设定】\n${digest.brief}` : '',
                  digest.characters ? `【已有角色（**不得凭空新增**，新角色必须先在本章正文里立起来）】\n${digest.characters}` : '',
                  digest.foreshadows ? `【现有伏笔】\n${digest.foreshadows}` : '',
                  digest.outline ? `【剧情总纲】\n${digest.outline}` : '',
                  digest.chapters ? `【已写章节】\n${digest.chapters}` : '',
                ].filter(Boolean);
                digestBlock = parts.join('\n\n');
              } catch (e) {
                console.warn('[beats] 补纲读取项目现状失败（按无现状继续）:', e);
              }
              const res = await ctx.ai.agents.run({
                system: await skills.systemFor(role.key, role.system),
                input: [digestBlock, extra, `现在轮到你（${role.name}）发言。`].filter(Boolean).join('\n\n'),
                tools: role.tools,
                maxTurns: role.tools?.length ? 6 : 4,   // 与 roles.ts 的 turnsFor 同口径（原先误写成 2，实测会把推理模型卡死）
                maxTokens: STAGE_SPEAK_MAX_TOKENS,
                context: { projectId, userId },
              });
              return String(res.text ?? '').trim();
            },
          },
          check.range,
        );
        if (fresh) {
          beatArtifact = appendBeatCards(beatArtifact, fresh);
          // 就地更新 contracts，后续章节直接读到新卡（否则每章都要重补一次）
          if (beatRef) beatRef.text = beatArtifact;
          else opts.contracts?.push({ label: '章节大纲与节拍卡', text: beatArtifact });
          // 累积给编排层**写回 store**（否则下一批再进来又判"没卡"、重复补同一段）
          rollingBeats = beatArtifact;
        }
      }
    }
    const beatCard = extractBeatCard(beatArtifact, order);
    if (!beatCard) {
      emit({
        type: 'stage_phase', stage: 'production',
        label: `第 ${order} 章没有节拍卡 —— 按"至少一个不可逆结果"的兜底要求写（在线补纲也未能产出）`,
      });
    }
    const warnings = result().warnings;

    try {
      await runDiscussion(
        ctx,
        {
          projectId, userId,
          message: productionMessageWithCard(order, last > 0 || i > 0, beatCard, chapterExtra),
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
          haltReason = 'supervisor-halt';
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
        haltReason = 'major-drift';
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
    ...(haltReason ? { haltReason } : {}),
    track,
    cursor,
    sinceReview,
    // ★ 在线补纲产出的新卡（编排层负责写回 store，见 orchestrator 的注释）
    ...(rollingBeats ? { beatArtifact: rollingBeats } : {}),
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
