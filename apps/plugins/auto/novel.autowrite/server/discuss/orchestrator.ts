// ============================================================
// 设计讨论编排 —— 一轮会话
//
// 与 autowrite 原有的「规划官 → 写作官 → 校对官」流水线不同：
// 这里是**多角色来回讨论**，然后把讨论收敛成「本章结论」。
// 讨论记录（transcript）在本轮内共享 —— 每个角色都看得到前面人说了什么，
// 这是「交流」与「各交一份报告」的分界线。
//
// 会话顺序：
//   剧情设计师提案 → 角色设计师回应 → 设定管家查库质疑
//   → 剧情设计师二次回应（针对质疑）→ 定稿官收敛成本章结论
//
// 事件流（SSE）：
//   { type:'phase', label }      正在做什么
//   { type:'turn', agent, ... }  某个角色的完整发言
//   { type:'conclusion', text }  收敛出的本章结论
//   { type:'error' | 'done' }
//
// 说明：本版只做「讨论 + 收敛」。写作官出稿与意图复核在下一版接。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import {
  DESIGN_ROLES, CONVENER_ROLE, ROLE_WRITER, ROLE_REVIEWER,
  WRITER_TARGET_CHARS, WRITER_MIN_CHARS, WRITER_MAX_CHARS, type DesignRole,
} from './roles.js';
import {
  resolveSettingsDigest, resolvePreviousChapter, persistChapterStoryTime, type SettingsDigest,
} from '../framework/context-resolver.js';
import { readDigestFor } from '../framework/memory/digest-gate.js';
import {
  createAgentMemory, createMemoryGate, createOwnWheel, experience, factRef,
  renderWheelWithin, WHEEL_CAPACITY_DEFAULT, evictPrompt, fingerprintOf, writeAudit, allRolePolicies,
} from '../framework/memory/index.js';
import { renderTranscript, TRANSCRIPT_BUDGET_DEFAULT } from '../framework/transcript.js';
import { persistChapterEntities } from '../framework/entity-sink.js';
import { createAgentSkillResolver, skillMetaNote } from '../framework/agent-skills.js';
import { runConsistencyGate, runPolishGate, POLISH_PASS_SCORE } from '../framework/gates.js';
import {
  detectRepetition, renderRepetitionHint, detectCrossChapterRepetition, renderCrossRepetitionHint,
  dedupeExactRepeats,
} from '../pipeline/repetition.js';
import { takeInterjections, renderInterjections } from './inbox.js';
import {
  ROLE_PLOT_ADVANCE_REVIEW, ROLE_VOICE_DUP_REVIEW, ROLE_SUPERVISOR_GATE,
  renderHelperTask, renderSuperviseMergeTask,
  parseHelperReport, parseSupervisorDecision, decideSupervision, renderDispatchInstruction,
  type HelperReport,
} from '../pipeline/supervise-review.js';
import { detectDialogue, renderDialogueHint, renderFragmentedLine, DIALOGUE_RATIO_MIN, DIALOGUE_RATIO_MAX } from '../framework/dialogue.js';
import { stripProsePreamble, countProseChars } from '../framework/text.js';
import {
  runGateDecision, decisionToGateAction, isDecisionEnabled,
  type GateDecision, type DecisionIssue,
} from '../framework/gate-decision.js';
import { WRITER_MAX_TOKENS } from './roles.js';
// 正文字数口径与意图门硬规则统一由 gate-rules.ts 提供（纯函数、可直接单测）
import {
  proseLength, isTooLong, isTooShort, isOutOfBand, passedHardRules,
  pickNearestBand, isRunawayExpansion, draftPenalty, pickBestDraft,
  detectOutlineLeak, leakTotal, leakExceeds, trimToMaxChars, LEAK_STRUCT_MAX, LEAK_WORD_MAX, type LeakHit,
} from './gate-rules.js';
import { schema, eq, and, isNull, desc, lt, getProjectDb, type DrizzleDb } from '@novel/db';
import { randomUUID } from 'node:crypto';
// 三条硬门禁（场景逻辑卡 / 四问 / 定稿线）—— 纯函数，见文件头
import {
  checkSceneLogicCard, renderSceneCardGap,
  scoreChapterForFinalize, renderFinalizeDetail, FINALIZE_MIN_SCORE,
} from '../framework/quality-gates.js';
// 复核证据包（双向证据：没问题时也把代码数出来的数字交给复核官）
import { renderReviewEvidence } from './review-evidence.js';

export type SessionEvent =
  | { type: 'phase'; label: string }
  /**
   * ★ 2026-10-25：作者插话**已生效**（被某个角色的发言消费）。
   * 前端据此把"我插的那句话"从「已排队」改成「已生效」，并落进同一条时间线 ——
   * 这是 AgentTeams「人和 agent 同一时间线」的实质。
   */
  | { type: 'interjection'; texts: string[] }
  /**
   * 思维链增量（推理型模型的 reasoning_content）。
   *
   * 实时逐片到达，同一个 agent 在一次发言里可能发几十到上千条 ——
   * 前端按 agent 追加到一个「正在想」的缓冲区，收到该 agent 的 turn 事件时结算。
   * **模型不吐推理内容（非推理模型 / 中转站剥了字段）时一条都不会有**，前端要按「可能没有」处理。
   */
  | { type: 'thinking'; agent: string; name: string; short: string; color: string; delta: string }
  | {
      type: 'turn';
      agent: string;
      name: string;
      color: string;
      short: string;
      text: string;
      meta?: string;
      /** 本次发言的完整思维链（与 thinking 事件同一份内容；没有则 undefined） */
      thinking?: string;
    }
  | { type: 'conclusion'; text: string }
  | { type: 'draft'; text: string; revision: number }
  | { type: 'review'; text: string; attempt: number; passed: boolean }
  /**
   * 方案 §5 的三道门：意图门用 review 事件，校对门 / 润色门用本事件。
   *   check  —— 硬门（全文 × 设定库一致性）：passed=false 时 detail 是冲突清单；
   *             它只允许一次定向修订，仍未消除也**不阻塞交付**（随交付交人工）。
   *   polish —— 软门（质量评分）：**从不阻塞**，passed 表示是否达到 POLISH_PASS_SCORE。
   */
  | { type: 'gate'; name: 'check' | 'polish' | 'finalize'; passed: boolean; detail: string; score?: number }
  /**
   * 交付成功。`warnings` 非空 = 交付了但有需人工复核之处（例如意图门打回上限用尽）。
   * **连写场景下不能因为门没过就丢章**：缺一章会让后面所有章失去前情，
   * 比带瑕疵的一章糟得多（实测 30 章连写丢了 2/7 章，就是这么来的）。
   */
  | { type: 'delivered'; order: number; title: string; wordCount: number; created: boolean; warnings?: string[] }
  | { type: 'deliver_blocked'; order: number; title: string; reason: string }
  /** 实体沉淀结果：本章交付后写入项目库的角色/物品/地点/伏笔条数 */
  | { type: 'entities'; created: number; updated: number; skipped: number; notes: string[] }
  /** 连写模式：一章开始（前端据此插分段并重置本轮的结论/正文/阶段状态） */
  | { type: 'chapter_start'; order: number; index: number; total: number }
  /** 连写模式：一章收尾（不论该章是否交付成功都会发） */
  | { type: 'chapter_done'; order: number; index: number; total: number; delivered: boolean }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface DiscussionOpts {
  projectId: string;
  userId: string;
  /** 作者这一轮说的话 */
  message: string;
  /** 可选：在意第几章（写进输入，帮助角色聚焦） */
  chapterOrder?: number;
  /**
   * 是否在本轮结束时发 `done`（默认 true）。
   * 连写模式下由 `runChapters` 统一收尾，单章调用要传 false ——
   * 否则前端会在第一章结束时就把整轮判成「跑完了」。
   */
  finalDone?: boolean;
}

/** 单角色发言的 maxTurns：带工具的角色需要多转几轮查库 */
function turnsFor(role: DesignRole): number {
  return role.tools && role.tools.length > 0 ? 6 : 2;
}

/**
 * 意图门打回上限 —— 超限停下问人，不无限循环。
 *
 * ★ 2026-10-16 从 2 提到 3：实测长跑后段写作官会「越写越长 + 复述凑字数」，
 *   2 次重写常改不动（v6/v7 两轮都卡在同一处：5807 字/31 处重复，重写 2 次仍不达标），
 *   于是带瑕疵交付 → 监工 halt → 整条长跑停在第五章。
 *   多给一次定向重写，让"删到上限内、删掉重复"这条能真正落地；
 *   代价是每章最多多 1 次模型调用（仅在该章不达标时）。
 */
const MAX_REVISIONS = 3;

/**
 * 监工终审（落库前）最多打回几轮。
 * 设 1：一个帮手判 severe 就够贵了（+3 次调用：两位帮手 + 监工汇总 + 一次整章重写）。
 * 实测意图门那边 3 轮都改不动的章，让监工多打回几轮也改不动，只是烧钱。
 */
const MAX_SUPERVISE_ROUNDS = 1;

/** 中文数字 → 阿拉伯数字（只处理「第 X 章」里的常见写法，够用即可） */
const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function cnToNum(s: string): number | null {
  if (!s) return null;
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] ? (CN_DIGIT[m[1]] ?? 1) : 1;
    const ones = m[2] ? (CN_DIGIT[m[2]] ?? 0) : 0;
    return tens * 10 + ones;
  }
  if (/^[一二三四五六七八九]$/.test(s)) return CN_DIGIT[s] ?? null;
  return null;
}

/** 从作者指令里识别目标章号（「第3章」「第三章」都认） */
function parseChapterOrder(message: string): number | null {
  const arabic = message.match(/第\s*(\d+)\s*章/);
  if (arabic?.[1]) return Number(arabic[1]);
  const cn = message.match(/第\s*([一二三四五六七八九十]+)\s*章/);
  if (cn?.[1]) return cnToNum(cn[1]);
  return null;
}

/**
 * 交付：把定稿正文写入章节。
 *
 * 治理原则（沿用核心「章节写入默认封锁」的基调）：
 *   · 目标章**为空**（空章或不存在）→ 直接写入，没有覆写风险
 *   · 目标章**已有正文** → **不自动覆盖**，emit `deliver_blocked` 交人工
 *   · 听不出章号 → 明说，不猜（猜错的代价是往错误章节写一整章）
 *
 * 返回是否真的写入了库（被治理拦下时为 false）—— 实体沉淀只许跟着真交付走，
 * 否则会把「正文里根本没有」的实体写进设定库。
 */
async function deliver(
  ctx: ServerPluginContext,
  opts: {
    projectId: string; message: string; order?: number; draft: string; warnings?: string[];
    /**
     * 本章摘要（写进 `chapters.summary`）。
     *
     * ★ 2026-10-22：这一列此前**85 章全是空**，直接后果是 digest 的「章节」块
     *   渲染成 `- 第1章《第1章》（2328字）` —— 对模型零信息量，
     *   于是它写第 80 章时对第 1–84 章一无所知（长程记忆实际为零）。
     *   这里**不额外调模型**：摘要直接取本章的「结论」（它本来就是本章要发生的事，
     *   由定稿官写、已在上下文里），零成本、也不引入新的失败点。
     */
    summary?: string;
    /**
     * 落库时的章节状态。
     *
     * ★ 2026-10-31：定稿门的产出。在此之前这一处**恒为 `'draft'`**，
     *   自动流程从不提升 —— 于是"定稿"这个身份在自动写作里根本不存在，
     *   哪一章是"交是交了、但没到定稿线"根本区分不出来。
     *   现在由调用方按定稿分给：过线 → `'final'`，否则保持 `'draft'`（**照旧交付**，
     *   只是不给"定稿"这个身份 —— 见 framework/quality-gates.ts 的治理说明）。
     *   取值必须是宿主认的 `ChapterStatus`（packages/shared: draft|revised|final|archived）。
     */
    finalStatus?: 'draft' | 'final';
  },
  emit: (e: SessionEvent) => void,
): Promise<{ delivered: boolean; order: number; title: string }> {
  const order = opts.order ?? parseChapterOrder(opts.message);
  if (!order) {
    emit({
      type: 'deliver_blocked',
      order: 0,
      title: '',
      reason: '没能从指令里认出要写第几章 —— 请写明「第 N 章」。正文已产出，但未入库。',
    });
    return { delivered: false, order: 0, title: '' };
  }

  const db = ctx.db.project(opts.projectId) as DrizzleDb;
  const content = opts.draft.trim();
  const wordCount = proseLength(content);
  /** 摘要 ≤200 字（digest 读的时候每章再截 80 字，这里留足余量给"这章发生了什么"） */
  const summary = (opts.summary ?? '').trim().slice(0, 200);
  const now = new Date();

  const existing = await db
    .select({ id: schema.chapters.id, title: schema.chapters.title, content: schema.chapters.content })
    .from(schema.chapters)
    .where(and(
      eq(schema.chapters.projectId, opts.projectId),
      eq(schema.chapters.order, order),
      isNull(schema.chapters.deletedAt),
    ))
    .limit(1);

  const row = existing[0];
  if (row) {
    if (row.content && row.content.trim().length > 0) {
      emit({
        type: 'deliver_blocked',
        order,
        title: row.title,
        reason: '该章已有正文，按治理原则不自动覆盖 —— 请到编辑器确认内容后再决定是否替换。',
      });
      return { delivered: false, order, title: row.title };
    }
    await db.update(schema.chapters)
      .set({ content, wordCount, updatedAt: now, status: opts.finalStatus ?? 'draft', ...(summary ? { summary } : {}) })
      .where(eq(schema.chapters.id, row.id));
    emit({ type: 'delivered', order, title: row.title, wordCount, created: false, ...(opts.warnings?.length ? { warnings: opts.warnings } : {}) });
    return { delivered: true, order, title: row.title };
  }

  const title = `第${order}章`;
  await db.insert(schema.chapters).values({
    id: randomUUID(),
    projectId: opts.projectId,
    title,
    content,
    order,
    wordCount,
    ...(summary ? { summary } : {}),
    status: opts.finalStatus ?? 'draft',
    createdAt: now,
    updatedAt: now,
  });
  emit({ type: 'delivered', order, title, wordCount, created: true, ...(opts.warnings?.length ? { warnings: opts.warnings } : {}) });
  return { delivered: true, order, title };
}

/**
 * 跨章去重用的「前面章节」窗口。
 *
 * ★ 为什么是 8 而不是水车的 3：水车轮是**给角色看前情**的（3 斗足够续写），
 *   而跨章去重要防的是「整段搬运」—— 可以是相邻章，也可以是隔了十几章。
 *   实测 26 章的书（逐字 336 / 变体 111）：3 章窗口查到 335/94，8 章 336/108，
 *   全历史 336/111 ⇒ 8 章已覆盖 97%+，再往上加是纯开销（每章多读几个 DB 行，不调模型）。
 *   若某本书的"复用"跨了更远，调大这个常量即可。
 *
 * ★ 2026-10-25 复量（98 章 / 29.7 万字的《雾港日志》，D2 决策依据）：
 *   **8 章窗口 348 句 = 全书窗口 348 句（逐字 282 / 变体 66），一模一样。**
 *   即：这本书的跨章复读**全部发生在相邻 8 章内**，把窗口放大到全书**零收益**
 *   （只是每章多读几十行 DB）。故**维持 8**——评审建议的"8→全书"经实测对本书无效，
 *   不为一个 0 收益的改动动代码。若将来遇到长距离复用（如第 3 章抄进第 60 章）的书，再调大。
 */
const CROSS_DUP_LOOKBACK = 8;

/**
 * 提纲泄漏的**重写指令**。
 *
 * ★ 只说"别写提纲语言"没用 —— 写作官不知道具体是哪几个词。这里把代码命中的词**逐个列出来**，
 *   并要求它在正文里把这些词连同所在句子一起改写成纯叙事（而不是删掉整句导致情节缺失）。
 */
function renderLeakHint(hits: readonly LeakHit[]): string {
  const list = hits.map((h) => `「${h.word}」×${h.count}`).join('、');
  const struct = hits.some((h) => h.word.includes('章'));
  return [
    '【框架逐词检出的**正文不纯**（不是判断，是代码数的）】',
    `命中的词：${list}`,
    '这些词**一律不许出现在正文里**：',
    '· 提纲/写作词（埋线、伏笔、钩子、台账、作者、读者、大纲…）→ 用**动作、对话、物件**把同一件事演出来，不要说出来；',
    struct
      ? '· 结构指代（"第N章""本章""上一章"）→ 改成故事内部的指称，例如「上次查扣那回」「雾退那天」「他先前说过的那句话」。'
        + '**正文里绝不许出现章号** —— 那是施工图，不是小说。'
      : '',
    '只改这些词所在的地方，其余段落不要动。',
  ].filter(Boolean).join('\n');
}

/** 决策器用的正文节选：首段 + 尾段各一半（避免整章外发，又能看出文风与结尾状态） */
function proseExcerpt(text: string, maxChars: number): string {
  const t = (text ?? '').trim();
  if (t.length <= maxChars) return t;
  const half = Math.floor(maxChars / 2);
  return `${t.slice(0, half)}\n……（中间省略 ${t.length - maxChars} 字）……\n${t.slice(-half)}`;
}

/** 决策器 primaryIssue 的中文名（给界面/日志读） */
function issueLabel(issue: DecisionIssue): string {
  const map: Record<DecisionIssue, string> = {
    duplication: '重复', dialogue: '对话太少', length: '篇幅',
    plot_stall: '情节原地打转', voice: '文风', leak: '提纲泄漏', none: '—',
  };
  return map[issue] ?? issue;
}

/**
 * 按决策器指定的**单一问题**生成聚焦的重写指令。
 *
 * 为什么只修一条：实测「补对话 → 字数超上限 → 又打回」的循环，根因就是一次让写作官
 * 同时满足互相拉扯的多条要求。决策器挑出最该修的一条，这里就只写那一条，
 * 其余维度本轮不管（下一轮若还不过会再判）。
 */
function renderFocusedHint(focus: DecisionIssue, ctx2: {
  rep: ReturnType<typeof detectRepetition>;
  cross: ReturnType<typeof detectCrossChapterRepetition>;
  dlg: ReturnType<typeof detectDialogue>;
  chars: number;
  tooLong: boolean;
}): string {
  switch (focus) {
    case 'duplication':
      return [ctx2.rep.excessive ? renderRepetitionHint(ctx2.rep) : '', ctx2.cross.excessive ? renderCrossRepetitionHint(ctx2.cross) : '']
        .filter(Boolean).join('\n\n');
    case 'dialogue':
      return renderDialogueHint(ctx2.dlg);
    case 'length':
      return ctx2.tooLong
        ? `【本次只改篇幅】现在 ${ctx2.chars} 字，超上限 ${WRITER_MAX_CHARS} 字。必须删到上限内 —— 删重复段、删无新信息的复述，不要扩写。`
        : `【本次只改篇幅】现在 ${ctx2.chars} 字，低于下限 ${WRITER_MIN_CHARS} 字。补细节、动作、对话，把篇幅补进区间。`;
    case 'plot_stall':
      return '【本次只改情节推进】本章在重复上一章的情节，没有实质推进。必须让主角在本章做出**新的行动 / 获得新信息 / 处境发生新变化**，删掉原地打转的段落。';
    case 'voice':
      return '【本次只改文风】保持冷硬克制的白描、短句为主、对话带潜台词；去掉解释性、总结性的旁白。';
    case 'leak':
      return '【本次只改正文纯度】删除一切提纲/写作语言（伏笔、钩子、作者、读者、台账等元话语），'
        + '以及**对章节自身的指称**（"第N章""本章""上一章"），只保留故事本身。';
    default:
      return '';
  }
}

/**
 * 回读本章之前最近 `CROSS_DUP_LOOKBACK` 章的正文，供跨章去重比对。
 *
 * 只读 DB（每章一行），**不调模型**。取不到就按空处理（第 1 章、或 DB 未就绪）。
 * 与 `resolvePreviousChapter` 的区别：那个只取 1 章、且会按 6000 字截断（给模型看的前情
 * 需要截断，去重比对不需要 —— 截断会漏掉被截掉那半里的重复句）。
 */
async function loadPriorChaptersForDup(
  ctx: ServerPluginContext,
  projectId: string,
  beforeOrder?: number,
): Promise<Array<{ order: number; content: string }>> {
  try {
    const db = ctx.db.project(projectId) as DrizzleDb | null;
    if (!db) return [];
    const scope = eq(schema.chapters.projectId, projectId);
    const alive = isNull(schema.chapters.deletedAt);
    const rows = await db
      .select({ order: schema.chapters.order, content: schema.chapters.content })
      .from(schema.chapters)
      .where(beforeOrder != null ? and(scope, alive, lt(schema.chapters.order, beforeOrder)) : and(scope, alive))
      .orderBy(desc(schema.chapters.order))
      .limit(CROSS_DUP_LOOKBACK);
    return rows
      .filter((r) => String(r.content ?? '').trim().length > 0)
      .map((r) => ({ order: Number(r.order), content: String(r.content) }))
      .sort((a, b) => a.order - b.order);
  } catch (e) {
    console.warn('[discuss] 读取跨章去重窗口失败（按无前文处理）:', e);
    return [];
  }
}

export async function runDiscussion(
  ctx: ServerPluginContext,
  opts: DiscussionOpts,
  emit: (e: SessionEvent) => void,
): Promise<void> {
  const { projectId, userId, message, chapterOrder } = opts;

  // ★ 先确保项目库已打开（治本）。
  //   `ctx.db.project()` 是**同步**接口，只读缓存 —— 而**全新项目**从没写过数据，
  //   它的库还没进缓存，于是返回 null，后面任何读/写都会炸。
  //   这个坑已经踩过两次（设定读取、交付），所以统一在这里开一次。
  try {
    await getProjectDb(projectId);
  } catch (e) {
    console.warn('[discuss] 打开项目库失败（后续按空库处理）:', e);
  }

  /** 本轮讨论记录 —— 所有角色共享，这是「来回」的载体 */
  const transcript: Array<{ name: string; text: string }> = [];

  // ★ 强制注入（2026-09-11 修幻觉）：把项目库现状**直接喂给所有角色**。
  //   此前只给了「可查库」的权限，结果设定管家在一个**空项目**里凭常识编出了
  //   「我查到祠堂和主角家是同村设定」。让 agent「自己去查」防不住幻觉 ——
  //   事实必须由框架直接提供，并且明确标注「这是真的；没有就是真没有」。
  // ★ 注意：项目库是在**首次写入**时才创建的。空项目下 `ctx.db.project()` 返回 null，
  //   resolveSettingsDigest 会抛错 —— 这里必须按「库确实是空的」兜底，
  //   否则一个新项目连讨论都跑不起来。
  let digest: SettingsDigest;
  try {
    digest = await resolveSettingsDigest(ctx, projectId);
  } catch (e) {
    console.warn('[discuss] 读取项目设定失败（多为空项目库未创建），按空库处理:', e);
    digest = {
      projectName: '',
      genre: '',
      characters: '（暂无角色设定）',
      foreshadows: '（暂无伏笔）',
      outline: '（暂无大纲）',
      chapters: '（暂无章节）',
    };
  }
  /**
   * 渲染「项目现状」块。
   * ★ 参数化是因为现在**每个角色各拿一份**（按自己的记忆白名单裁剪，见下）：
   *   没拿到的字段整段省略 —— 不要留空标题让模型猜「是不是没有」。
   */
  const renderFacts = (d: Partial<SettingsDigest>): string => [
    '【项目现状（框架直接读取项目库得到的真实数据，不是你的记忆）】',
    `项目：${d.projectName || '未命名'}${d.genre ? ' · ' + d.genre : ''}`,
    // ★ 开书设定（新书向导产出）：开局 / 世界观 / 笔风 / 主角 / 女主 / 流派。
    //   它在**主库**的 projects.brief 上，角色的工具读不到 —— 只能由框架直接给。
    ...(d.brief
      ? ['', '【创作设定（作者开书时写下的硬设定 —— 与设定库同等效力，不得违背）】', d.brief]
      : []),
    ...(d.characters ? ['', '角色：', d.characters] : []),
    ...(d.foreshadows ? ['', '伏笔：', d.foreshadows] : []),
    ...(d.outline ? ['', '大纲：', d.outline] : []),
    ...(d.chapters ? ['', '章节：', d.chapters] : []),
  ].join('\n');

  /** 现状块上限：设定很长时截断，并明确告知「被截断了」，避免它以为没写就是没有 */
  const MAX_FACT_CHARS = 6000;
  const clipFacts = (t: string): string => (t.length > MAX_FACT_CHARS
    ? t.slice(0, MAX_FACT_CHARS) + '\n…（项目数据过长，此处已截断；需要细节请用工具查）'
    : t);

  // ★ 强制注入（架构 §7）：**上一章全文**。
  //   只给现状摘要时，模型知道「发生了什么」，却不知道「上一章是怎么写的」——
  //   文风、语气、结尾那一刻的处境全靠猜，连着读就会断层。§7 把它列为
  //   「不注入必然写错、不能交给自主判断」的一类（此前只注入了 digest 摘要）。
  //   没有已交付章节时**明确说明**，避免模型凭类型套路幻想前情。
  /**
   * 取**最近 N 章**（N = 水车容量，2026-09-13 从 1 扩到 3）。
   * 每章一次 DB 读、**不调模型**；循环用 `beforeOrder` 往前退（语义见 resolvePreviousChapter 注释）。
   * 拿到之后不是"直接拼给所有人"，而是——每人各自入**自己的**水车（见下 headerFor）。
   */
  const wheelCapacity = WHEEL_CAPACITY_DEFAULT;
  const recentChapters: Array<{ order: number; content: string; storyTime?: string }> = [];
  try {
    let cursor: number | undefined = chapterOrder;
    for (let i = 0; i < wheelCapacity; i++) {
      const p = await resolvePreviousChapter(ctx, projectId, cursor);
      if (!p) break;
      recentChapters.push({ order: p.order, content: p.content });
      cursor = p.order;
    }
  } catch (e) {
    console.warn('[discuss] 读取最近章节失败（按无前文处理）:', e);
  }

  /**
   * 记忆闸门 + 每角色一份的上下文（2026-09-13 接线）。
   *
   * 为什么按角色裁：`memory_audit` 里要能回答「这个角色当时**被允许**看到什么」。
   * 但**宽度原则**是「凡不注入就会编的都必须给」（角色卡/伏笔/约束/前情）——
   * 所以只有意图复核是刻意窄的，其余角色的差异只在「要不要地点/物品」这一档。
   *
   * `load: async () => digest` —— 复用上面已经取好的共享 digest，
   * 因此裁剪**不产生额外查询**，闸门只做过滤与记账。
   */
  const gate = createMemoryGate(ctx);
  /**
   * 已启用技能解析器（"智能体 Skills"的开关 → system prompt）。
   * ★ 本次运行内按 agent 缓存：一章要跑十几轮发言，不能每轮查一次主库。
   */
  const agentSkills = createAgentSkillResolver(ctx, userId);
  const gatedCache = new Map<string, string>();
  /** 出界压缩的按章缓存：同一章只调一次模型 */
  const evictSummaryCache = new Map<number, string>();
  const compressEvicted = async (ev: { chapterNo: number; text: string }): Promise<string> => {
    const hit = evictSummaryCache.get(ev.chapterNo);
    if (hit !== undefined) return hit;
    const r = await ctx.ai.agents.run({
      system: '你是文本压缩器。只输出梗概，不加任何前后缀、不加标题、不解释。',
      input: evictPrompt(ev as never),
      // 梗概口径从"一句话"放宽到 3–5 句 / ≤200 字（见 waterwheel.evictPrompt 的说明），
      // 输出上限随之抬到 400 token，否则中文 200 字会被截在半句。
      maxTokens: 400,
      context: { projectId, userId },
    });
    const text = String(r.text ?? '').trim();
    if (text) evictSummaryCache.set(ev.chapterNo, text);
    return text;
  };
  const headerFor = async (agentId: string): Promise<string> => {
    const cached = gatedCache.get(agentId);
    if (cached !== undefined) return cached;

    const { digest: allowed, narrativeGranted } = await readDigestFor(ctx, projectId, agentId, 'discuss-context', {
      narrative: true,                       // 讨论阶段要带上一章（它在下面的 prevBlock 里）
      load: async () => digest,
    });
    /**
     * 前情段：**用这个 agent 自己的水车**渲染（2026-09-13 扩到 3 斗后改的）。
     *
     * 为什么改成水车而不是"统一注入上一章"：
     *   · 水车是**记忆的迭代方式** —— 它读到的前情成为它自己记忆的一部分，各转各的；
     *   · 扩了容量就得让注入真的用上：否则"容量 3"只是个永不生效的数字。
     * 幂等：同一章重复入斗不会占两个斗位（同章号先摘旧的）。
     */
    let prev = '';
    if (!narrativeGranted) {
      prev = '';                                  // 未获准读叙事：一段都不给（不影响事实部分）
    } else if (recentChapters.length === 0) {
      prev = '【前情】本项目还没有已交付的章节 —— 这是第一章，直接从开局写起，不要假设前情。';
    } else {
      try {
        const wheel = createOwnWheel(memoryOf(agentId), wheelCapacity);
        /**
         * ★ 舀水策略（2026-09-13 抽查后修正）：
         *   之前每次都把"最近 N 章"重播一遍 —— 斗位刚好填满，**永不发生出界**，
         *   于是"循环复用 + 出界压梗概"这套迭代机制等于死代码（抽查里 summary 一条都没有）。
         *   现在：**空斗才播种**（拿最近 N 章垫底，保证连续性），之后**只舀新章** ——
         *   这样斗满就真的会挤掉最老一斗、真的会压成一句话，迭代才发生。
         */
        const existing = await wheel.slots();
        const newestInWheel = existing[0]?.chapterNo ?? 0;
        const toIngest = existing.length === 0
          ? [...recentChapters].reverse()                       // 旧 → 新（播种）
          : recentChapters.filter((c) => c.order > newestInWheel); // 只舀比斗 1 更新的
        for (const c of toIngest) {
          await wheel.ingest(
            { chapterNo: c.order, text: c.content, ingestedAt: Date.now(), storyTime: c.storyTime },
            // ★ 出界一斗压成一句话（架构 §6：倒掉不等于丢）。**同一章只压一次**：
            //   各 agent 的水车在同一时刻挤掉的往往是同一章，按章号缓存，省掉重复的模型调用。
            { compress: compressEvicted },
          );
        }
        const { text } = renderWheelWithin(await wheel.slots());
        /**
         * ★ 2026-10-22：把**长期池（出界梗概）接回 prompt** —— 此前是"只写不读"。
         *
         * 实测：85 章的书里，水车每挤掉一章就调一次模型压成梗概、存进 `wheel.summary.<n>`
         * （这本书压了 85 条、花掉 85 次调用），而 `summaries()` **零个生产调用者** ——
         * 唯一读它的是 routes.ts 的记忆面板（给人看的）。
         * 结果每个智能体的"长期记忆"实际只有最近 3 章全文，再往前是空的：
         * 写第 80 章时，它对第 40 章发生过什么**一无所知**。
         *
         * 这就是"越写越模板化"的结构性原因之一：没有历史可用，只能反复咀嚼最近 3 章。
         * 接上之后，每个角色都能看到自己那台水车压出来的全部章节梗概（按章号排序）。
         *
         * 预算：梗概上限 200 字 × 85 章 ≈ 1.7 万字，与 3 章全文（约 1.2 万字）同量级；
         * 为免长跑后期无限膨胀，这里再截一道 `LONGTERM_MAX_CHARS`（从**最新**往回取，
         * 越近的越相关），并明确告知省略了多少章。
         */
        /**
         * ★ 2026-10-30 置 0 = **关闭**（用户裁决：上下文只留「最近 2 章 + 本章卡」）。
         *
         * 原先是 8000 字（85 章的梗概全塞进去）。关掉的依据：
         * 实测越发模板化是因为最近 3 章全文被反复咀嚼，而不是缺历史——
         * 梗概虽给了历史，但那是**一句话摘要**，模型抓不到可写的细节，反而稀释注意力。
         * 恢复方法：把这里改回 8000 即可。
         */
        const LONGTERM_MAX_CHARS = 0;
        let longterm = '';
        try {
          const sums = await wheel.summaries();
          // 排除水车里已有的（那几章有全文，梗概是冗余）
          const inWheel = new Set((await wheel.slots()).map((s) => s.chapterNo));
          const older = sums.filter((s) => !inWheel.has(s.chapterNo));
          if (LONGTERM_MAX_CHARS > 0 && older.length > 0) {
            const picked: string[] = [];
            let used = 0;
            for (let i = older.length - 1; i >= 0; i--) {          // 从最新往回
              const line = `第${older[i]!.chapterNo}章：${older[i]!.text}`;
              if (used + line.length > LONGTERM_MAX_CHARS) break;
              picked.unshift(line);
              used += line.length;
            }
            const omitted = older.length - picked.length;
            longterm = [
              '',
              `【更早章节的梗概（你自己的长期记忆 · 水车出界时压出来的 · 共 ${older.length} 章）】`,
              '**这些是已经发生过的剧情**：续写时不要与它们矛盾，也不要把它们当新情节再写一遍。',
              ...picked,
              ...(omitted > 0 ? [`（更早的 ${omitted} 章因篇幅省略）`] : []),
            ].join('\n');
          }
        } catch (e) {
          console.warn('[discuss] 读取长期梗概失败（按无长期记忆处理）:', e);
        }
        prev = [
          `【最近章节（你自己的水车 · 斗 1 最新 · 最多 ${wheelCapacity} 斗）】`,
          '**文风与衔接必须与斗 1 连续**：接着它的结尾往下写，不要复述它已经写过的内容，也不要换一种语气。',
          /**
           * ★ 2026-10-21：水车既是"迭代"、也是模型最容易抄袭的来源。
           *   实测第 47 章 5625 字里 19 种整段重复、四段各出现 4 次且**等间距约 967 字**
           *   —— 不是在复述斗 1，而是在**按节拍把斗位里的旧段循环取用**。
           *   仅靠"不要复述斗 1"约束不住，这里把三条明确写成硬约束。
           */
          '**硬约束（违反即视为本章作废）**：',
          '① 斗位里的段落**只能用来衔接，不得原样或换几个字搬进本章**；',
          '② 同一段景物 / 同一个动作 / 同一句对话，本章**只许出现一次**；',
          '③ 每章必须有新的**事件推进**（人物做了决定、处境发生变化），不能只是把已知信息换个说法再铺一遍。',
          text,
          longterm,
        ].filter(Boolean).join('\n');
      } catch (e) {
        console.warn('[discuss] 水车入斗/渲染失败（退化为无前情）:', e);
        prev = '';
      }
    }

    const text = [
      '【作者要求】',
      message,
      chapterOrder ? `（针对第 ${chapterOrder} 章）` : '',
      '',
      clipFacts(renderFacts(allowed)),
      '',
      prev,
      '',
    ].filter(Boolean).join('\n');
    gatedCache.set(agentId, text);

    // ★ A4/I6：记本次**注入内容的指纹**（hash + 字数）—— 同 (项目,章,角色,授权集)
    //   两次装配指纹是否一致，就是"装配可复现"的可执行形式。
    try {
      await writeAudit(ctx, {
        projectId, agentId, action: 'assemble', keys: Object.keys(allowed),
        reason: 'discuss-context', allow: true,
        detail: `注入 ${text.length} 字${narrativeGranted ? '' : '（未含前情）'}`,
        fingerprint: fingerprintOf(text),
      });
    } catch (e) {
      console.warn('[discuss] 装配指纹写入失败（不影响讨论）:', e);
    }

    // ★ A1：把「它获准读到的全局事实」记成该角色自己的**事实引用（指针）**——
    //   L2 的"双式"里 fact_ref 这一式此前没有任何写入方（只有 experience 在跑）。
    //   只给"以查库为职责"的角色记（设定管家 l1Wide）：否则每个角色每轮都写一堆族名，纯噪音。
    const policy = allRolePolicies().find((r) => r.agentId === agentId)?.policy;
    if (policy?.l1Wide) {
      try {
        const mem = memoryOf(agentId);
        for (const key of Object.keys(allowed)) {
          await mem.writeOwn(factRef(`fref.ch${chapterOrder ?? 0}.${key}`, {
            factId: key, why: 'continuity-check：它据这些事实核对本章设定', sourceChapter: chapterOrder ?? undefined,
          }));
        }
      } catch (e) {
        console.warn('[discuss] 事实引用写入失败（不影响讨论）:', e);
      }
    }
    return text;
  };

  /**
   * ★ A2「按需回读」（`recall-by-need`）—— 此前这个 reason 在枚举里但**零调用方**，等于没实现。
   *
   * 真实触发点：**篇幅不足要补写时**。补写要加细节，最需要的恰恰是**斗位之外**的更早前情
   * （斗位里已有最近 3 章）。所以这里回读"比最老一斗更早的那一章"，走闸门、带 reason、记账。
   * 拿不到就返回空串 —— 回读失败绝不能反过来卡住交付。
   */
  const recallEarlier = async (agentId: string): Promise<string> => {
    try {
      const wheel = await createOwnWheel(memoryOf(agentId));
      const slots = await wheel.slots();
      const oldest = slots[slots.length - 1]?.chapterNo;
      if (!oldest || oldest <= 1) return '';          // 斗位里已经覆盖到第 1 章，没有更早的了
      const decision = await gate.authorize({
        projectId, agentId, keys: ['chapter.*'], reason: 'recall-by-need',
        narrative: true, mode: 'strict',
      });
      if (!decision.allow) return '';
      const earlier = await resolvePreviousChapter(ctx, projectId, oldest);   // order < oldest
      if (!earlier) return '';
      return [
        `【按需回读（第 ${earlier.order} 章《${earlier.title}》—— 比你最近三章更早的前情）】`,
        '以下是你主动回读的更早章节，用于避免补写时与前文冲突。',
        earlier.content,
      ].join('\n');
    } catch (e) {
      console.warn('[discuss] 按需回读失败（按无此段处理）:', e);
      return '';
    }
  };

  /** L2：把这次发言记进该角色自己的经历流（只记「自己说的」；heard 可由 transcript 复现，不重复落盘） */
  const memoryOf = (agentId: string) =>
    createAgentMemory({ ctx, projectId, agentId, gate });

  /**
   * 校对门（不是讨论角色，agentId 用 'proofreader'）用的 digest。
   * 它的白名单覆盖全部键族，所以**内容与共享 digest 等价** —— 这里过闸门是为了：
   *   ① 审计里留下「门禁在 gate-review 用途下读过 L1」这条记录
   *   ② 以后若要收窄校对的可见范围，改策略即可生效，不用再动调用点
   */
  let proofreadDigest: Partial<SettingsDigest> | null = null;
  const getProofreadDigest = async (): Promise<Partial<SettingsDigest>> => {
    if (!proofreadDigest) {
      const r = await readDigestFor(ctx, projectId, 'proofreader', 'gate-review', {
        narrative: true, load: async () => digest,
      });
      proofreadDigest = r.digest;
    }
    return proofreadDigest;
  };

  const buildInput = (header: string, role: DesignRole, extra?: string): string => {
    const parts: string[] = [header];
    if (transcript.length > 0) {
      parts.push('【本轮讨论记录】');
      /**
       * ★ 2026-10-21：讨论记录也要有篇幅预算。
       *   此前这里是 `for (const t of transcript) parts.push(全文)` —— 整条链路上
       *   **唯一没有预算的口子**（水车 12000、上一章 6000、现状 6000 都有）。
       *   长跑后段一章 4–6 人发言、写作官一稿 3000+，再叠复核与重写，input 会一路膨胀，
       *   而模型输入越长越容易把已写过的段落当素材复述（实测第 47 章 5625 字、19 种整段重复）。
       *   预算规则见 framework/transcript.ts：最新一轮永远完整，省略必须明说。
       */
      const rendered = renderTranscript(transcript, TRANSCRIPT_BUDGET_DEFAULT);
      // 一行可观测：作者问「为什么这次提示词变短了」、或排查「是不是把关键发言裁掉了」时看这里。
      const rawLen = transcript.reduce((a, x) => a + x.text.length, 0);
      if (rendered.length < rawLen) {
        console.log(`[discuss] 讨论记录按预算裁剪：${rawLen} → ${rendered.length} 字（${transcript.length} 条发言）`);
      }
      parts.push(rendered);
    }
    if (extra) parts.push(extra);
    parts.push(`现在轮到你（${role.name}）发言。`);
    return parts.join('\n');
  };

  /**
   * 只跑模型的那一半（**不**写 transcript / 不记 L2 / 不发 turn 事件）。
   *
   * ★ 2026-10-25 拆出来是为了让**互不依赖的发言并行**：`speak` 原本把"调模型"与
   *   "登记进讨论记录"焊死在一起，于是两个帮手的调用只能一个接一个。
   *   现在拆开 —— 模型调用可以 `Promise.all` 重叠，而登记（transcript 顺序、
   *   L2 的 `turn${n}` 编号）仍然**按发言顺序**串行做，语义与拆分前完全一致。
   */
  const runRole = async (
    role: DesignRole,
    extra?: string,
    opts?: { maxTokens?: number },
  ): Promise<{ role: DesignRole; text: string; model?: string; thinking?: string }> => {
    /**
     * ★ 2026-10-25：**作者插话**在每次发言前生效（人在环中）。
     *
     * 粒度刻意是"下一个角色开口前"，不是"立即打断"：打断会浪费一次调用、截断一段可能
     * 很好的发言，还会破坏讨论顺序的可复现性。插话走独立短连接写入信箱（见 inbox.ts），
     * 这里取走即标记 consumed —— 同一条只注入一次。
     */
    const pending = takeInterjections(ctx, projectId);
    if (pending.length) {
      extra = [extra, renderInterjections(pending)].filter(Boolean).join('\n\n');
      emit({ type: 'interjection', texts: pending.map((p) => p.text) });
      // 可观测：作者问"我插的话到底进没进 prompt"、或事后复盘"这一章为什么改向"时看这一行
      console.log(`[discuss] 作者插话已注入「${role.name}」的 input：${pending.map((p) => p.text.slice(0, 40)).join(' / ')}`);
    }
    emit({ type: 'phase', label: `${role.name}发言中` });
    const roleHeader = await headerFor(role.key);
    // ★ 已启用技能拼进 system（"智能体 Skills"里的开关真正生效的地方）
    const system = await agentSkills.systemFor(role.key, role.system);
    const injected = agentSkills.appliedIds(role.key);
    if (injected.length) {
      // 一行可观测日志：作者问"为什么这次行为变了"、或排查"技能是不是真进了 prompt"时，
      // 这是唯一能直接看到"系统提示词确实变长了"的地方。
      console.log(`[skills] ${role.key} 注入 ${injected.join('/')}：system ${role.system.length} → ${system.length} 字`);
    }
    const result = await ctx.ai.agents.run({
      system,
      input: buildInput(roleHeader, role, extra),
      tools: role.tools,
      maxTurns: turnsFor(role),
      ...(opts?.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
      context: { projectId, userId },
      // ★ 思维链旁路：宿主在 provider 的 fetch 上截 reasoning_content 后从这里推回来。
      //   拿不到就一次都不回调（不是所有模型都吐），下面的 turn 事件只是不带 thinking。
      onThinking: (delta) => emit({
        type: 'thinking',
        agent: role.key,
        name: role.name,
        short: role.short,
        color: role.color,
        delta,
      }),
    });
    const text = String(result.text ?? '').trim();
    if (!text) throw new Error(`${role.name}未产出内容（可能是模型调用失败）`);
    return { role, text, ...(result.model ? { model: result.model } : {}), ...(result.thinking ? { thinking: result.thinking } : {}) };
  };

  /**
   * 把一次发言登记进讨论记录 / L2 / 事件流。
   * **顺序敏感**：必须按发言顺序调用（`transcript.length` 就是 L2 的 turn 编号）。
   */
  const recordTurn = async (r: { role: DesignRole; text: string; model?: string; thinking?: string }): Promise<void> => {
    const { role, text } = r;
    transcript.push({ name: role.name, text });
    // L2 经历流：记「它自己说了什么」。失败不影响讨论（记忆是旁路，不能反过来废掉这一轮）
    try {
      // ★ key 必须**带上章号**：只用 `turn.9` 这种编号的话，每章都会算出同样的 key，
      //   后一章会把前一章的经历**覆盖**掉（实测：4 章只留下 13 条，本该 ~40 条）。
      await memoryOf(role.key).writeOwn(experience(`exp.ch${chapterOrder ?? 0}.turn${transcript.length}`, {
        kind: 'said', text: text.slice(0, 2000), ref: `ch${chapterOrder ?? 0}#turn${transcript.length}`,
      }));
    } catch (e) {
      console.warn('[discuss] 写 L2 经历失败（不影响讨论）:', e);
    }
    emit({
      type: 'turn',
      agent: role.key,
      name: role.name,
      color: role.color,
      short: role.short,
      text,
      meta: [r.model ? `模型 ${r.model}` : '', skillMetaNote(agentSkills, role.key)]
        .filter(Boolean).join(' · ') || undefined,
      ...(r.thinking ? { thinking: r.thinking } : {}),
    });
  };

  /** 一个角色的一次发言（跑模型 + 登记）—— 绝大多数调用点用它 */
  const speak = async (
    role: DesignRole,
    extra?: string,
    opts?: { maxTokens?: number },
  ): Promise<string> => {
    const r = await runRole(role, extra, opts);
    /**
     * ★ 2026-10-30：**写作官的产出统一剥一次"工作笔记前言"**。
     *
     * 实测事故（第 4 章）：正文开头是「先补第4章节拍卡…【第4章节拍卡】- 起：…」
     * 再加一句「以下为修正后完整正文：」，后面才是真正的正文。
     * 根因是指令在无卡时要求它"先补卡"（已同日修），但**提示词靠不住** ——
     * 这里用确定性代码兜底，并对所有写作官调用点（初稿/补写/删减/重写/监工派发）
     * 一次覆盖，避免逐个调用点漏改。
     *
     * 放在 `recordTurn` **之前**：讨论记录里存的也该是干净正文
     * （否则复核官会拿"含工作笔记的版本"去验收，判断随之失真）。
     */
    if (role.key === ROLE_WRITER.key && r.text) {
      const clean = stripProsePreamble(r.text);
      if (clean !== r.text) {
        console.log(`[discuss] 剥除正文开头的元语言前言：${countProseChars(r.text)} → ${countProseChars(clean)} 字`);
        r.text = clean;
      }
    }
    await recordTurn(r);
    return r.text;
  };

  try {
    // ——— 第一轮：各自从自己那一维发言 ———
    for (const role of DESIGN_ROLES) {
      await speak(role);
    }

    // ——— 第二轮：剧情设计师针对质疑正面回应 ———
    // 没有这一轮，三个角色就只是各交一份报告，不构成讨论。
    const plot = DESIGN_ROLES[0];
    if (plot) {
      await speak(
        plot,
        '【本轮任务】同伴已对你的方案提出补充与质疑。请**正面回应**：接受的说明怎么改，'
        + '不接受的说明为什么。不要重述原方案，不要客套。',
      );
    }

    // ——— 收敛 ———
    emit({ type: 'phase', label: '收敛本章结论' });
    let conclusion = await speak(CONVENER_ROLE);
    emit({ type: 'conclusion', text: conclusion });

    /**
     * ── 硬门禁 ① + ②：不填场景逻辑卡（含动作前四问）不许写正文 ──
     *
     * ★ 为什么由**代码**拦（2026-10-31）：这条纪律来自 ai-fiction-writer 的 `novel-logic`，
     *   但在原包里它只写在提示词里（`hard_block: {require_scene_card…}`）—— 那只是**模型自律**，
     *   模型可以无视，而且越"配合"越危险（它会假装填了卡）。
     *   放在这里，写作官**根本没有机会**在没有卡的情况下动笔。
     *
     * 四问的答案就是卡里的字段（谁在场/在哪/什么时刻、为什么这么做、信息从哪来），
     * 所以①与②是**同一次检查**，不另开门 —— 见 framework/quality-gates.ts 的 FOUR_QUESTIONS。
     *
     * 给定稿官**一次**补全机会：缺项多半是格式没照契约写（`角色` 那类值本身是多行的，
     * 模型容易漏标签），一次定向重发就能救回来；第二次仍缺，就认定"这一章没有卡"。
     * 只给一次是有意的 —— 这条链路上每一次 speak 都是一次完整模型调用，
     * 无限补卡比不写更糟。
     */
    {
      let card = checkSceneLogicCard(conclusion);
      if (!card.ok) {
        emit({ type: 'phase', label: `场景逻辑卡不完整（${renderSceneCardGap(card)}）—— 退回定稿官补全` });
        const patched = await speak(
          CONVENER_ROLE,
          '【本轮任务】你上面收敛的「本章结论」缺少必填项，写作官**无法据此动笔**。缺的是：\n'
          + `${card.missing.length ? `· 整项没写：${card.missing.join('、')}\n` : ''}`
          + `${card.empty.length ? `· 写了但空白：${card.empty.join('、')}\n` : ''}`
          + '\n请**只输出补全后的完整本章结论**（原有各行原样保留，把缺的补上），严格按契约逐项给出：'
          + '节拍 / 场景 / 角色 / 动机 / 关键物 / 伏笔 / 禁项 / 结束状态 / 故事内时间 / 待定。'
          + '不要解释、不要寒暄、不要复述讨论过程。',
        );
        if (patched.trim()) {
          conclusion = patched;
          emit({ type: 'conclusion', text: conclusion });
          card = checkSceneLogicCard(conclusion);
        }
      }
      if (!card.ok) {
        // 不写正文 —— 这正是这条门禁的全部意义。照实告诉作者，而不是悄悄放行。
        emit({
          type: 'error',
          message: `本章结论仍缺场景逻辑卡必填项（${renderSceneCardGap(card)}）。`
            + '按「不填场景逻辑卡不许写正文」，本轮**未落笔**：请补全这一章的场景/动机等信息后重跑。',
        });
        if (opts.finalDone !== false) emit({ type: 'done' });
        return;
      }
    }

    // ——— 落笔：写作官据结论写正文 ———
    // 它与设计角色的区别：**不参与争论**，只把结论当契约执行 —— 避免被过程中
    // 已被否决的方案带偏。它仍然看得到完整讨论记录（要"总结上面的讨论"）。
    emit({ type: 'phase', label: `写作官落笔中（目标 ${WRITER_TARGET_CHARS} 字以上，需要一会儿）` });
    let currentDraft = await speak(
      ROLE_WRITER,
      '【本轮任务】按上面的「本章结论」写出本章正文。'
      + '结论的节拍 / 关键物 / 角色 / 伏笔 / 禁项都是硬约束，逐条落实。直接输出正文。',
      { maxTokens: WRITER_MAX_TOKENS },
    );

    // ——— 篇幅自检：低于下限先补一次，再进意图门 ———
    //   必须排在意图门**之前**：门只该验收最终稿，补写出来的内容也得过门。
    //   注：意图门打回触发的重写不重复这道检查（避免调用次数失控），
    //   重写指令里已写明「篇幅不得少于 X 字」。
    //
    //   ★ 2026-10-20 实测两轮修：① 提示词原来只给下限 ⇒ 模型灌到 6863 字；
    //     ② 只改成「超上限就丢弃补写稿」⇒ 短稿照旧很短地交货（实测第 34 章 1283 字）。
    //     现在：补写失控时**再要一稿「删到区间内」**（只此一次），最后在
    //     {初稿, 补写稿, 删减稿} 里挑**离区间最近**的一稿 —— 不再非黑即白地二选一。
    //
    /**
     * ★ 2026-10-27 修（**顺序性 bug**）：**确定性去重必须排在篇幅自检之前**。
     *
     * 事故（《雾港旧档》23 章实测）：去重原先只在**交付口**跑 —— 那是链路的最后一站，
     * 删完就落库。它删跨章重复删得很狠（单章 **2914 → 2122，掉了 792 字**），
     * 于是 23 章里 **8 章跌破 2500 下限**，交付警示写着「去重后篇幅 2280 字，低于下限」。
     *
     * 根因是**顺序**而非去重本身：去重让章节变短，而"变短"这条链路上唯一能补的地方
     * 就是下面的**篇幅自检 → 补写**。去重跑在它之后，等于拆了东墙又不补西墙。
     *
     * 现在：先读旧章 → 先去重 → 再自检/补写 ⇒ 去重腾出的篇幅补写会补齐，
     * 结果**又干净又够长**。交付口那道仍然保留（监工/校对门之后可能又写出重复），
     * 但那道带了 `keepAtLeast` 下限保护，不可能再把章节删破。
     */
    const priorForDup = await loadPriorChaptersForDup(ctx, projectId, chapterOrder);
    {
      const dd = dedupeExactRepeats(currentDraft, priorForDup);
      if (dd.removedIntra + dd.removedCross > 0) {
        const beforeD = proseLength(currentDraft);
        currentDraft = dd.text;
        console.log(
          `[discuss] 初稿确定性去重：删章内 ${dd.removedIntra} 句 / 跨章 ${dd.removedCross} 句`
          + `（${beforeD} → ${proseLength(currentDraft)} 字）`,
        );
        emit({
          type: 'phase',
          label: `初稿去重：删去 ${dd.removedIntra + dd.removedCross} 句逐字重复（${beforeD} → ${proseLength(currentDraft)} 字）`,
        });
      }
    }
    const initialLen = proseLength(currentDraft);

    /**
     * ★ 2026-10-22：**超上限也要在这里治，而不是丢给意图门重写整章。**
     *
     * 实测（`z/hy3` 真实写作 prompt）：模型稳定写到 **3900–6800 字**（上限 3500），
     * 而旧逻辑只有「欠下限」有就地补写，「超上限」要等意图门打回、再整章重写一遍 ——
     * 一次 40 秒的写作 ×3 次打回，绝大部分时间花在"删字"上，还可能越改越差。
     *
     * 这里加一条**就地删减**：超上限就明确要求"只删不加、删到区间内"，用正则数出的字数
     * 逼它自己删；删完在 {原稿, 删减稿} 里取离区间更近的一稿。删减比重写便宜得多（输出更短）。
     */
    // 无条件留一行：定位"篇幅闸门到底有没有走到"（此前只有换稿时才打日志，
    // 导致"没裁"和"裁了但没生效"在日志里长得一模一样）
    console.log(
      `[discuss] 篇幅自检：初稿 ${initialLen} 字（区间 ${WRITER_MIN_CHARS}–${WRITER_MAX_CHARS}）`
      + `${initialLen > WRITER_MAX_CHARS ? ' → 超上限，准备裁剪' : initialLen < WRITER_MIN_CHARS ? ' → 欠下限，准备补写' : ' → 在带内'}`,
    );
    if (initialLen > WRITER_MAX_CHARS) {
      /**
       * ★ 2026-10-22 去掉 8% 容差。原先写的是「超得不多（<8%）就不折腾」——
       *   那是**在还没有代码裁剪时**的取舍（只能靠模型删、删一次 40 秒）。
       *   现在裁剪是零调用，容差反而成了漏洞：实测第 71 章 3727 字（+6.5%）、
       *   第 73 章 3770 字（+7.7%）都落在容差内被放过，最终**超带交付**。
       *   既然零成本，就没有放过的理由 —— 一律裁进区间。
       */
      {
        /**
         * 先用**代码**裁（零调用、零方差），裁完还超才请模型删。
         *
         * 为什么先代码：实测模型删减**不可靠**（3912→3822 只删了 90 字），
         * 而每章多一次删减调用就是 +40 秒。裁掉的是最后几个段落，前面的叙事完整。
         */
        const cut = trimToMaxChars(currentDraft);
        const cutLen = proseLength(cut);
        if (cutLen < initialLen) {
          currentDraft = cut;
          console.log(`[discuss] 篇幅按段落裁剪 ${initialLen} → ${cutLen} 字（代码裁，零调用）`);
        }
        if (proseLength(currentDraft) > WRITER_MAX_CHARS) {
          // 代码裁不动（例如整章就是一个超长段落）→ 再请模型删，有界一次
          emit({ type: 'phase', label: `篇幅超出（${proseLength(currentDraft)} 字 / 上限 ${WRITER_MAX_CHARS}），请写作官删减…` });
          try {
            const before = proseLength(currentDraft);
            const trimmed = await speak(
              ROLE_WRITER,
              `【本轮任务】你这一稿 **${before} 字，超出上限 ${WRITER_MAX_CHARS} 字共 ${before - WRITER_MAX_CHARS} 字**。请**只删不加**：\n`
              + `· 删掉重复的段与句、删掉没有新信息的复述与排比、删掉重复的环境描写；\n`
              + `· **不要**删情节推进、关键动作、关键对话；**不要**新增任何内容（新增会让字数重新超标）；\n`
              + `· 删到 **${WRITER_MIN_CHARS}–${WRITER_MAX_CHARS} 字**之间（目标 ${WRITER_TARGET_CHARS} 字）。\n`
              + '直接输出删好的**完整正文**。',
              { maxTokens: WRITER_MAX_TOKENS },
            );
            const trimmedLen = proseLength(trimmed);
            // 模型删完仍可能超上限（它只受理地约束）→ 再走一遍代码裁剪
            const trimmedNorm = trimmedLen > WRITER_MAX_CHARS ? trimToMaxChars(trimmed) : trimmed;
            const trimmedNormLen = proseLength(trimmedNorm);
            if (pickNearestBand(before, trimmedNormLen) === 1) {
              currentDraft = trimmedNorm;
              console.log(`[discuss] 篇幅就地删减 ${before} → ${trimmedLen} 字`
                + (trimmedNormLen !== trimmedLen ? `（裁剪至 ${trimmedNormLen} 字）` : ''));
            } else {
              console.warn(`[discuss] 篇幅就地删减无效（${before} → ${trimmedLen} 字），保留原稿交意图门`);
            }
          } catch (e) {
            console.warn('[discuss] 篇幅就地删减失败，按原稿继续:', e);
          }
        }
      }
    }

    const afterTrimLen = proseLength(currentDraft);
    if (afterTrimLen < WRITER_MIN_CHARS) {
      emit({ type: 'phase', label: `篇幅不足（${initialLen} 字），请写作官补写…` });
      try {
        // 补写前先按需回读一段更早的前情（斗位之外），给"加细节"提供素材
        const recalled = await recallEarlier(ROLE_WRITER.key);
        const expanded = await speak(
          ROLE_WRITER,
          `【本轮任务】你上一稿只有 ${initialLen} 字，未达 ${WRITER_MIN_CHARS} 字下限。`
          + `请在**现有内容基础上补写**（不要重写、不要压缩已有段落，只增加细节、动作、对话与描写），`
          + `把篇幅补到 ${WRITER_TARGET_CHARS} 字左右。`
          + `**篇幅区间是 ${WRITER_MIN_CHARS}–${WRITER_MAX_CHARS} 字：少于 ${WRITER_MIN_CHARS} 字不合格，超过 ${WRITER_MAX_CHARS} 字同样不合格**`
          + `（超了就是靠复述凑字数，会被打回）。直接输出补写后的**完整正文**。`
          + (recalled ? `\n\n${recalled}` : ''),
          { maxTokens: WRITER_MAX_TOKENS },
        );
        const expandedLen = proseLength(expanded);

        /**
         * ★ 2026-10-22 修一个**判据性**的坑（它让第 67 章交了 1097 字残稿）。
         *
         * 实测：初稿 877 字 → 补写产出 **5200 字**（一部完整的正文，只是超长）。
         * 旧判据只比"谁离区间近"：877 离下限 1623、5200 离上限 1700 ⇒ 判 877 更近，
         * **把补写稿整个丢掉、留着 877 字的残稿交付**（日志原句「篇幅补写未变长（877 → 5200 字）」）。
         *
         * 根因：这条判据是在**还没有裁剪能力**时定的，那时两边都不可修复，比距离是对的。
         * 现在 `trimToMaxChars` 能把超长稿零成本裁进区间 ⇒ **"超上限"变成可修复的，"欠下限"才是不可修复的**。
         * 所以先对补写稿做一次裁剪归一化，再比距离：5200 裁到 ~3470（距离 0）必然胜出。
         */
        const expandedFixed = expandedLen > WRITER_MAX_CHARS ? trimToMaxChars(expanded) : expanded;
        const expandedFixedLen = proseLength(expandedFixed);
        if (isRunawayExpansion(expandedLen)) {
          // 补写失控 → 再要一稿「删到区间内」。这是**有界的一次**：
          // 删减比补写容易得多，实测能一次落回区间；失败也只是回到三选一。
          emit({ type: 'phase', label: `补写失控（${expandedLen} 字），请写作官删到区间内…` });
          const trimmed = await speak(
            ROLE_WRITER,
            `【本轮任务】你上一稿有 ${expandedLen} 字，**超过了 ${WRITER_MAX_CHARS} 字上限**（上限是硬约束）。`
            + `请把它删到 ${WRITER_MIN_CHARS}–${WRITER_MAX_CHARS} 字之间：优先删掉重复的段与句、删掉没有新信息的复述；`
            + `**不要**删情节推进与关键动作，也不要再扩写。直接输出删好的**完整正文**。`,
            { maxTokens: WRITER_MAX_TOKENS },
          );
          // 三个候选一律先做长度归一化（超长的裁进区间）再比 —— 判据同上面那段说明
          const trimmedLen = proseLength(trimmed);
          const trimmedFixed = trimmedLen > WRITER_MAX_CHARS ? trimToMaxChars(trimmed) : trimmed;
          const trimmedFixedLen = proseLength(trimmedFixed);
          const pick = pickNearestBand(initialLen, expandedFixedLen, trimmedFixedLen);
          currentDraft = pick === 1 ? expandedFixed : pick === 2 ? trimmedFixed : currentDraft;
          console.log(
            `[discuss] 篇幅校正 ${initialLen} → 补写${expandedLen}(归一 ${expandedFixedLen})`
            + ` / 删减${trimmedLen}(归一 ${trimmedFixedLen}) ⇒ 取第 ${pick} 稿（${proseLength(currentDraft)} 字）`,
          );
        } else {
          // 比的是**裁剪归一化之后**的长度（超长稿先裁进区间再比，见上面的说明）
          const pick = pickNearestBand(initialLen, expandedFixedLen);
          if (pick === 1) {
            currentDraft = expandedFixed;
            console.log(
              `[discuss] 篇幅补写 ${initialLen} → ${expandedLen} 字`
              + (expandedFixedLen !== expandedLen ? `（裁剪至 ${expandedFixedLen} 字）` : ''),
            );
          } else {
            // ★ 2026-10-22 修措辞：这里以前一律写"未变长"，但实测有一条 `2039 → 4006 字`
            //   也被判成"未变长" —— 其实它是**补过头了**（离上限比初稿离下限更远），
            //   取舍函数 pickNearestBand 判它不如初稿贴区间。两种情况的处置相同、原因不同，
            //   日志写成一句会让人误以为"模型没补"，排查时白跑一趟。
            console.warn(
              `[discuss] 篇幅补写后离区间更远（${initialLen} → ${expandedLen} 字），保留初稿`,
            );
          }
        }
      } catch (e) {
        console.warn('[discuss] 篇幅补写失败，按初稿继续:', e);
      }
    }
    emit({ type: 'draft', text: currentDraft, revision: 0 });

    // ——— 意图复核：对照结论验收，不合格打回重写 ———
    // 这道门防的是「白写了」—— 方向错了整章作废，比事实性错误贵得多，所以排在最前。
    let approved = false;
    /** 本轮最后一次有效的决策器结果（放行时据此落警示；null = 决策器未用/不可用） */
    let lastDecision: GateDecision | null = null;
    /**
     * 交付警示收集器。**提前声明**（原在循环之后）：决策器在循环内可能"带警示放行"，
     * 需要往这里写；若仍放在循环后，会撞 TDZ（used before declaration）。
     */
    const warnings: string[] = [];
    // ★ 2026-10-16：本轮的「代码检出的章内重复」——每一稿都重算，作为重写指令的一部分。
    //   模型自报的去重判定可能漏（见 pipeline/repetition.ts 顶部注释），代码这一关是兜底。
    /**
     * ★ 2026-10-16 代码级篇幅**上下限**。
     * 实测根因：写作官为凑字数，会把整段反复重抄 —— 坏章的唯一共同点就是**字数超上限**
     * （第 2 章 5242 字/161 段/41 段重复；同书第 1、3、4 章都在带内、重复为 0）。
     * 提示词里写了上限但**约束不住**，所以这一关必须用代码判：
     * 超限即打回，并在重写指令里明写"删到目标字数，**删重复段**，不要扩写"。
     *
     * ★ 2026-10-18 补**下限**：此前只判了"超上限"，**欠下限根本没进硬规则** ——
     *   GUI 长跑实测第 15 章 2017 字（下限 2500）照样交付。下限是"没写完"，
     *   和上限一样是可判定的物理事实，不能只靠提示词。
     */
    const tooLong = () => isTooLong(currentDraft);
    const tooShort = () => isTooShort(currentDraft);
    /** 篇幅出带（超上限或欠下限）—— 确定性硬伤，详见下方 decisionToGateAction 的 nonNegotiable */
    const outOfBand = () => isOutOfBand(currentDraft);
    /**
     * ★ 2026-10-21：提纲泄漏的**确定性**计数（此前这条只有模型监工在管，`leak` 字段恒为 0）。
     *   实测 58 章的书：正文里「她记起**第38章**深坞漂出的…」「那是**第32章**自深坞漂箱…」
     *   —— 把施工图印在了成品上。做成闭包（随 currentDraft 变），不必在每处重算点上抄一遍。
     */
    const leakHits = () => detectOutlineLeak(currentDraft);
    const leakCount = () => leakTotal(leakHits());
    const leakTooMany = () => leakExceeds(leakHits());
    let rep = detectRepetition(currentDraft);
    /**
     * ★ 跨章重复（2026-10-16）：拿本章长句与**前面章节**比，撞上即跨章复读。
     *   实测某 26 章的书：章内重复 48 处、**跨章 220 句** —— 章内去重完全没覆盖这块，
     *   而它才是"新章在复读旧章"的元凶。
     *
     * ★ 2026-10-17 修两个盲区：
     *   ① 原来只拿 `recentChapters`（水车轮，**只有 3 章**）比 —— 实测 26 章的书
     *      「逐字跨章 336 句」，用 3 章窗口只查得到 335、用全历史 336，说明主症是**相邻章复读**
     *      （3 章窗口够用）；但「第 3 章抄进第 20 章」这类长距离复读会被漏掉。
     *      改为**回读最近 8 章**（实测 8 章≈全量：94/108/111，3 章是 94/…）。
     *   ② 原来只查「逐字相同」，**变体式跨章复写一条都查不到**（实测另有 183 句）。
     *      检测函数已补上变体类，见 pipeline/repetition.ts 的 CROSS_NEAR_*。
     */
    // `priorForDup` 已在篇幅自检之前读好（去重更早跑，见上方说明）——这里直接用。
    let cross = detectCrossChapterRepetition(currentDraft, priorForDup);
    /**
     * ★ 2026-10-16 代码级对话占比兜底（缺陷 B）。
     * 实测全书对话占比只有 8–13%，目标 20% —— 这个目标只写在提示词里，模型会漏。
     * 复核的『对话』红线同样靠模型自报，漏报就直接交付。这里用代码数一遍，
     * 低于 DIALOGUE_RATIO_MIN（15%）即参与打回。口径与阈值见 framework/dialogue.ts。
     */
    let dlg = detectDialogue(currentDraft);
    /**
     * ★ 2026-10-21：把每一稿都记下来，**交付时取最好的一稿**，而不是最后一稿。
     *
     * 实测根因（40 章 GUI 长跑）：重写是「按修改要求再写一遍」，**不保证变好** ——
     * 第 39 章最后落库的是 **8708 字 / 章内重复 61 处**，而它前面那几稿未必更差。
     * 旧逻辑 `currentDraft` 被每次重写原地覆盖，取到的是"最后一稿"；打回上限用尽时
     * 直接把它交出去，等于把最坏的一稿当成了结果。
     *
     * 交付候选按**确定性指标**排序（篇幅离区间多远 + 重复多少），不花额外模型调用。
     */
    const candidates: Array<{ text: string; chars: number; intraDup: number; crossDup: number; leak: number }> = [];
    const rememberDraft = (text: string) => {
      /**
       * ★ 2026-10-22：入候选前先做**长度归一化**（超长裁进区间）。
       *   理由同 draftPenalty 的量纲说明：超长是**可修复**的（零调用裁掉尾部段落），
       *   所以不该按"原始长度离区间多远"去罚它 —— 那会让"超长的完整章"输给"欠下限的残章"，
       *   实测第 82 章就是这么交出 1824 字的。
       *   （前面的篇幅闸门通常已经裁过；这里再兜一次，保证候选表里的字数就是它真实的竞争力。）
       */
      const normalized = proseLength(text) > WRITER_MAX_CHARS ? trimToMaxChars(text) : text;
      const r = detectRepetition(normalized);
      const c = detectCrossChapterRepetition(normalized, priorForDup);
      candidates.push({
        text: normalized,
        chars: proseLength(normalized),
        intraDup: r.excessSentences + r.excessNearDuplicates,
        crossDup: c.count,
        leak: leakTotal(detectOutlineLeak(normalized)),
      });
    };
    rememberDraft(currentDraft);
    for (let attempt = 1; attempt <= MAX_REVISIONS; attempt++) {
      emit({ type: 'phase', label: `意图复核（第 ${attempt} 次）` });
      // 每轮重置：放行警示只应反映**本轮**决策器结论，不能带上一轮的旧结论
      lastDecision = null;
      const review = await speak(
        ROLE_REVIEWER,
        '【本轮任务】对照上面的「本章结论」验收**写作官最新一稿**（讨论记录里最后一条写作官正文；'
        + '若前面还有更早的稿子，那是被替代的旧稿，不要拿它作数）。按格式输出判定与逐维结论。'
        /**
         * ★ 2026-11-01：证据从**单向**改成**双向**（`review-evidence.ts`）。
         *
         * 旧写法是五段 `x ? 「框架已检出…」 : ''` —— 只在检出问题时说话。
         * 于是"干净"的维度复核官一无所知，而契约又要求它自己数 ⇒ 干净的维度全靠猜。
         * 实测（10 章 / 30 次复核）：去重维度 14 次指控 **10 次不存在（71% 误报）**、
         * 正文纯度 7 次里 4 次引用的原话根本不在正文里；每次误报都整章打回、白烧一次写作官。
         *
         * 现在把五项**全部**交出去（含"无"），并明说这几项以框架数字为准、它只判语义三维。
         */
        + '\n\n' + renderReviewEvidence({
          rep, cross, dlg,
          chars: proseLength(currentDraft),
          charMin: WRITER_MIN_CHARS,
          charMax: WRITER_MAX_CHARS,
          outOfBand: outOfBand(),
          leakHits: leakHits(),
        }),
      );
      // 判定行解析：明确写「打回」才重写 —— 解析不到一律当通过，避免格式跑偏导致死循环。
      // ★ 2026-10-16：除总判定行外，另认三条交付红线（正文纯度 / 去重 / 对话）里的「不通过」——
      //   这三类（抄提纲、成段重复、对话过少）实测在长跑后段占了问题大半，而监工 halt 已经太晚，
      //   必须在这一关拦下。任一维「不通过」即打回重写。
      // ★ 代码兜底：模型说通过、但代码数出「过度重复」「篇幅出带」「对话偏少」→ 仍打回
      //   （这几条是长跑段的直接病灶，且都不依赖模型判断）
      //   ★ 2026-10-18：`tooLong()` → `outOfBand()`，把**欠下限**一并纳入（此前漏判）。
      //   规则本体已抽到 gate-rules.ts（纯函数，可直接单测）。
      const hardRulePass = passedHardRules({
        review, rep, cross, dlg, outOfBand: outOfBand(), leakTooMany: leakTooMany(),
      });

      /**
       * ★ 2026-10-17：**Jev 型决策器**（可选）替代/收敛上面这套互相打架的硬规则。
       *
       * 只在硬规则判「不通过」时才问决策器 —— 硬规则放行的章没必要再花一次调用。
       * 决策器回答三件硬规则答不了的事：① 这一稿值不值得再改（worthIt）；
       * ② 若改，只修哪一条（primaryIssue，避免补对话→超字数→再打回的循环）；
       * ③ 是否情节原地打转（stalled，确定性去重抓不到）。
       *
       * **失败即回退**：决策器不可用（模型没通道 / 超时 / 输出不合规）→ `gateAction` 保持
       * 硬规则结论，行为与引入前**完全一致**。这是硬约束：决策器是增强，不是依赖。
       */
      let passed = hardRulePass;
      let focus: DecisionIssue = 'none';
      let decisionNote = '';
      /**
       * ★ 2026-10-27 修**触发条件**（原为 `!hardRulePass && isDecisionEnabled()`）。
       *
       * 原逻辑把体检当成"硬规则不过时的复核"——但这是**逻辑自相矛盾**：
       * 体检的三项能力（AI 味 / 开头重复 / 内容重复）**恰恰是硬规则测不出的**，
       * 所以它们出问题时 hardRulePass 通常仍是 true ⇒ **体检永远不触发**。
       *
       * 实测（第 26–29 章真跑）：29 章写完，一次体检都没跑。
       *
       * 改成**每章都体检**：它是常规检查，不是打回前的复核。
       * 成本可接受（实测 hy3 约 4 秒/次，每章 1 次）。
       */
      if (isDecisionEnabled()) {
        emit({ type: 'phase', label: '意图门：内容体检（AI 味 / 开头重复 / 内容重复）…' });
        // 正文节选：首尾各一段（避免整章外发，见 gate-decision.ts 顶部 PRIVACY 说明）
        const excerpt = proseExcerpt(currentDraft, 900);
        const dr = await runGateDecision(ctx, {
          chapter: `第 ${chapterOrder ?? '?'} 章`,
          chars: proseLength(currentDraft),
          charMin: WRITER_MIN_CHARS,
          charMax: WRITER_MAX_CHARS,
          intraDup: rep.excessSentences + rep.excessNearDuplicates,
          crossDup: cross.count,
          dialogueRatio: dlg.ratio,
          dialogueMin: DIALOGUE_RATIO_MIN,
          leak: leakCount(),   // ★ 2026-10-21：真的接上了确定性计数（此前恒为 0，见 detectOutlineLeak）
          rewritesSoFar: attempt - 1,
          maxRewrites: MAX_REVISIONS,
          excerpt,
          /**
           * ★ 2026-10-27（开头重复判定必需）：把**本章开头 + 前两章开头**一起送进去。
           *
           * 开头重复是"每章都用同一套起手"（天亮/雾起/他坐起来）—— 词面各章不同、
           * 功能位相同，词频统计零命中。只有把三段开头并排给决策模型才判得出。
           *
           * 取 260 字：足够覆盖"环境起手 + 主角第一个动作"的完整功能位，
           * 又不至于把正文大段外发（state 里已有 900 字节选）。
           */
          openingExcerpt: currentDraft.slice(0, 260),
          priorOpenings: priorForDup.slice(-2).map((p) => ({
            chapter: `第 ${p.order} 章`,
            opening: p.content.slice(0, 260),
          })),
        }, { userId });
        if (dr.decision) {
          /**
           * ★ 2026-10-18：**确定性硬伤不许被决策器放行**。
           *   篇幅是物理事实（不是审美取舍）：超上限几乎总等于"靠复述凑字数"
           *   （实测第 10 章 5869 字 / 同时 11 处章内重复），欠下限则是没写完。
           *   这类事实不进"值不值得改"的权衡 —— 传下去，命中即打回。
           */
          const nonNegotiable: DecisionIssue[] = [];
          if (outOfBand()) nonNegotiable.push('length');
          // attemptsDone = attempt - 1（本轮是第 attempt 次复核；attempt=1 时还没改过）
          const action = decisionToGateAction(dr.decision, attempt - 1, { nonNegotiable });

          /**
           * ★ 2026-10-27 **合并而不是覆盖**（触发条件放宽后必须修）：
           *
           * 原来 `passed = action.pass` —— 体检说放行就放行。改成"每章都体检"之后，
           * 这样会**让体检放过硬规则判死的章**（例如模型复核明确写「判定：打回」、
           * 或篇幅出带），是回归。
           *
           * 正确语义：**两者取严**——
           *   · 硬规则不过 → 一定打回（体检无权翻案）；
           *   · 硬规则过、但体检发现内容问题 → 打回（这正是新增能力的价值）；
           *   · 两者都过 → 放行。
           *
           * 代价：硬规则不过时也要跑一次体检（多 4 秒），但换来
           * "打回时能说清是内容问题还是硬指标问题"，值得。
           */
          const contentFails = !action.pass;
          if (!hardRulePass) {
            // 硬规则判死：保持打回，聚焦项优先用硬伤，其次用体检的首要问题
            passed = false;
            focus = action.forcedByHardFact || action.forcedFirstRewrite
              ? action.focus
              : (action.focus !== 'none' ? action.focus : focus);
          } else {
            // 硬规则通过：完全由体检决定
            passed = !contentFails;
            focus = contentFails ? action.focus : 'none';
          }
          decisionNote = dr.decision.reason ?? '';
          lastDecision = dr.decision;
          /** 体检摘要（给界面/日志一句人话，而不是 verdict 那套旧词） */
          const tags = [
            dr.decision.aiFlavor ? `AI味 ${dr.decision.aiFlavor}/10` : '',
            dr.decision.openingRepeat ? '开头重复' : '',
            dr.decision.contentRepeat ? '内容重复' : '',
          ].filter(Boolean).join(' · ') || '三项均正常';
          emit({
            type: 'phase',
            label: action.pass
              ? `体检[${dr.via === 'native' ? 'Jev' : 'chat'}]：放行（${tags}）${decisionNote ? ' · ' + decisionNote : ''}`
              : `体检[${dr.via === 'native' ? 'Jev' : 'chat'}]：打回重写，只修「${issueLabel(focus)}」${action.forcedByHardFact ? '（篇幅出带，硬约束）' : action.forcedFirstRewrite ? '（至少先改一次）' : ''}（${tags}）${decisionNote ? ' · ' + decisionNote : ''}`,
          });
        } else {
          // 决策器不可用 → 回退硬规则（行为同引入前），并把原因写进日志
          emit({ type: 'phase', label: `决策器不可用（${dr.error ?? '未知'}），回退硬规则` });
        }
      }

      emit({ type: 'review', text: review, attempt, passed });
      if (passed) {
        approved = true;
        /**
         * 带警示放行：**体检有问题但未达打回线**时，落一条警示。
         *
         * ★ 2026-10-27：判据从"决策器 verdict"改成"体检结果"。旧写法 `verdict !== 'accept'`
         *   在新契约下没意义（决策器不再做总判决）。现在按三项症状如实报：
         *   放行了但仍有问题 → 作者需要知道是哪一项，而不是笼统"决策器判定了什么"。
         */
        if (lastDecision) {
          const problems = [
            lastDecision.contentRepeat ? '内容重复（重讲已演过的事件）' : '',
            lastDecision.openingRepeat ? '开头重复（与前两章起手雷同）' : '',
            lastDecision.aiFlavor >= 9 ? `AI 味偏重（${lastDecision.aiFlavor}/10）`
              : lastDecision.aiFlavor >= 7 ? `AI 味略重（${lastDecision.aiFlavor}/10）` : '',
          ].filter(Boolean);
          if (problems.length) {
            warnings.push(`内容体检未过但已放行：${problems.join('；')}${lastDecision.reason ? `（${lastDecision.reason}）` : ''}`);
          }
        }
        break;
      }

      if (attempt === MAX_REVISIONS) {
        // 超限不硬撑：停下交给作者，别让它在循环里烧钱
        emit({ type: 'phase', label: `已达重写上限（${MAX_REVISIONS} 次），停在待人工处理` });
        break;
      }

      emit({ type: 'phase', label: `第 ${attempt} 次打回，写作官按修改要求重写中…` });
      // 修改要求就在 transcript 里（复核的话），写作官能看到 —— 不必另传。
      // 但**代码检出的重复/对话占比**未必在复核话里（模型可能没报），所以额外显式带上。
      //
      // ★ 2026-10-17：若决策器给出了**单一聚焦**问题（focus），重写指令就**只写那一条**
      //   （治「补对话→超字数→再打回」的循环）；否则退回原来的「把所有代码检出的问题
      //   一并写出来」的多条并列（与引入决策器前完全一致）。
      const focused = focus !== 'none'
        ? renderFocusedHint(focus, { rep, cross, dlg, chars: proseLength(currentDraft), tooLong: tooLong() })
        : '';
      currentDraft = await speak(
        ROLE_WRITER,
        '【本轮任务】你上一稿没过意图复核。按上文「意图复核」给出的**修改要求**重写。'
        + '**能局部改就不要整章重来**，只动需要动的地方；直接输出修改后的**完整正文**。'
        + (focus !== 'none'
          ? `\n\n【本轮**只**改这一条，其余不动】${issueLabel(focus)}\n${focused}`
            + `\n（篇幅仍须在 ${WRITER_MIN_CHARS}–${WRITER_MAX_CHARS} 字之间。）`
          : (tooLong()
            // 超限时口径要反过来：**删**，不是补。否则它会一边被要求"不少于"、一边被要求"别超"，两头挨骂
            ? `注意：本章**已超出篇幅上限**（现在 ${proseLength(currentDraft)} 字，上限 ${WRITER_MAX_CHARS} 字）。`
              + '**必须删到上限以内** —— 优先删掉重复的段与句、删掉没有新信息的复述；'
              + '**不要**为凑数扩写，**也不要**因为删了就补写新段。'
            : `注意：修改后篇幅仍不得少于 ${WRITER_MIN_CHARS} 字、不要超过 ${WRITER_MAX_CHARS} 字。`)
            + (rep.excessive ? `\n\n${renderRepetitionHint(rep)}` : '')
            + (cross.excessive ? `\n\n${renderCrossRepetitionHint(cross)}` : '')
            // 补对话与删重复会互相拉扯（补对话会加字、删重复会减字），两条同时命中时
            // 一并写出来，让写作官在**同一次**重写里同时满足，别改完一头又踩另一头。
            + (dlg.tooLow ? `\n\n${renderDialogueHint(dlg)}` : '')
            // 提纲泄漏：把**命中的词逐个列出来**（只说"别写提纲语言"它不知道该删哪个）
            + (leakTooMany() ? `\n\n${renderLeakHint(leakHits())}` : '')),
        { maxTokens: WRITER_MAX_TOKENS },
      );
      /**
       * ★ 2026-10-22：**重写路径也要做长度归一化** —— 此前这一路完全没有篇幅校正，
       *   是"初稿翻回带内、重写又漂出去"的漏口。实测第 66 章：初稿 4099 字已用代码裁到
       *   3471（在带内），但意图门打回后重写又写回 3985 字，最终就按 3985 交付了。
       *
       *   这里只做**净减**（超长才裁），不动在带内或偏短的稿子 ——
       *   重写稿变短是写作官按修改要求删重复的正常结果，不该被这里的逻辑覆盖。
       */
      if (proseLength(currentDraft) > WRITER_MAX_CHARS) {
        const before = proseLength(currentDraft);
        const cut = trimToMaxChars(currentDraft);
        const cutLen = proseLength(cut);
        if (cutLen < before) {
          currentDraft = cut;
          console.log(`[discuss] 重写稿按段落裁剪 ${before} → ${cutLen} 字（第 ${attempt} 次重写后）`);
        }
      }
      emit({ type: 'draft', text: currentDraft, revision: attempt });
      // 重写后重新数一遍：重复可能被换了个样子留下（句号改省略号等），归一化能抓住
      rep = detectRepetition(currentDraft);
      cross = detectCrossChapterRepetition(currentDraft, priorForDup);
      // 对话占比同样重算 —— 补对话时很容易顺手把复述话再抄一遍
      dlg = detectDialogue(currentDraft);
      rememberDraft(currentDraft);
    }
    /**
     * ★ 2026-10-21：打回上限用尽前，**取候选里最好的一稿**再交付。
     *   重写是"再写一遍"，不保证变好（实测第 39 章最后一稿 8708 字 / 章内重复 61 处）。
     *   排序依据是确定性指标（离篇幅区间的距离 + 重复条数），见 gate-rules 的 draftPenalty。
     */
    if (!approved) {
      const bestIdx = pickBestDraft(candidates);
      // 无论取哪一稿都留一行候选表 —— 事后复盘「为什么交的是这一稿」只看日志就够，
      // 不必再回去复现（这一行是补出来的：第一版只在**换稿时**打，等于没换就查不到任何依据）。
      console.log(
        `[discuss] 交付候选 ${candidates.length} 稿：`
        + candidates.map((c, i) => `#${i + 1}(${c.chars}字/内${c.intraDup}/跨${c.crossDup}/罚${draftPenalty(c)}${i === bestIdx ? '★' : ''})`).join(' '),
      );
      if (bestIdx !== candidates.length - 1) {
        const chosen = candidates[bestIdx];
        console.log(
          `[discuss] 交付改取更优稿：第 ${bestIdx + 1}/${candidates.length} 稿（${chosen.chars} 字，`
          + `章内重复 ${chosen.intraDup}、跨章 ${chosen.crossDup}，罚分 ${draftPenalty(chosen)}）—— 最后一稿是 `
          + `${candidates[candidates.length - 1].chars} 字/章内 ${candidates[candidates.length - 1].intraDup}`
          + `（罚分 ${draftPenalty(candidates[candidates.length - 1])}）`,
        );
        currentDraft = chosen.text;
        rep = detectRepetition(currentDraft);
        cross = detectCrossChapterRepetition(currentDraft, priorForDup);
        dlg = detectDialogue(currentDraft);
      }
    }
    /**
     * 未过意图门时的交付警示。
     *
     * ★ 这里曾经是「不通过就不交付」，实测 30 章连写时**丢了 2/7 章** —— 缺章会让
     *   后面所有章失去前情（比带瑕疵的一章糟得多），而且脚本/后台跑的时候作者根本
     *   看不到那份没入库的稿子。现在改为**带警示照常交付**，由作者事后复核。
     */
    if (!approved) {
      warnings.push(`意图门未通过（打回 ${MAX_REVISIONS} 次），请人工复核本章`);
      emit({
        type: 'phase',
        label: `已达重写上限（${MAX_REVISIONS} 次）仍未通过意图门 —— 仍会交付（缺章比带瑕疵更糟），交付结果里会标注`,
      });
    }

    {
      /** 目标章号：后面两道门与交付都要用（deliver 内部会再算一次，规则相同） */
      const targetOrder = chapterOrder ?? parseChapterOrder(message) ?? 0;

      /**
       * ——— 监工复核（落库前 · 两位帮手分头审 + 监工汇总 + 可派发写作）———
       *
       * ★ 2026-10-23 用户口径：「监工使用技能审阅，然后派发写作，给监工两个帮手，用来审阅」。
       *
       * 为什么放在这里（校对门之前）：
       *   · 它必须**在落库之前** —— 交付后的巡检只能记台账，改不动已经入库的正文；
       *   · 它必须在**校对门之前** —— 监工派发的重写也要再过一遍校对与润色，
       *     否则重写稿可能带着与设定库的冲突直接落库。
       *
       * 两个帮手**串行**调用（不是并行）：代理是全局串行的，并行没有速度收益，
       * 而 `speak` 会往讨论记录里追加，并行会让记录顺序与 L2 经历键（turn${n}）错乱。
       */
      const helperReports: HelperReport[] = [];
      for (let supRound = 1; supRound <= MAX_SUPERVISE_ROUNDS; supRound++) {
        emit({ type: 'phase', label: `监工复核（第 ${supRound} 轮）：两位帮手分头审阅…` });

        /**
         * ★ 2026-10-25：两位帮手**并行**跑模型（互不依赖：一个看情节推进、一个看文风重复）。
         *
         * 原先两句 `await speak(...)` 串行 —— 实测网关**支持并发**（两并发墙钟 5.1s
         * vs 串行 9.9s），而这两个审阅是长跑里每章都要做的固定开销，并行能省掉约一半。
         *
         * ⚠️ 生效前提：代理的并发闸门要放开（`MAX_CONCURRENCY>1`，见 tools/magpie-proxy.mjs）。
         *    闸门仍为 1 时这里只是"正确地并行发出、被网关串行接住"，行为与拆分前一致 ——
         *    **不会变坏，只是不变快**。
         *
         * 登记（transcript / L2 的 turn 编号）仍**按原顺序**做：讨论记录的顺序是别人
         * 复现讨论的依据，不能因为并行就乱掉。
         */
        const [advR, voiR] = await Promise.all([
          runRole(ROLE_PLOT_ADVANCE_REVIEW, renderHelperTask(ROLE_PLOT_ADVANCE_REVIEW, currentDraft, targetOrder)),
          runRole(ROLE_VOICE_DUP_REVIEW, renderHelperTask(ROLE_VOICE_DUP_REVIEW, currentDraft, targetOrder)),
        ]);
        await recordTurn(advR);
        await recordTurn(voiR);
        const adv = parseHelperReport(advR.text);
        const voi = parseHelperReport(voiR.text);
        helperReports.splice(0, helperReports.length, adv, voi);
        emit({
          type: 'phase',
          label: `帮手结论：情节推进 ${adv.verdict}（${adv.findings.length} 条）· 文风重复 ${voi.verdict}（${voi.findings.length} 条）`,
        });

        const merged = await speak(
          ROLE_SUPERVISOR_GATE,
          renderSuperviseMergeTask({
            chapterOrder: targetOrder, plotAdvance: adv, voiceDup: voi,
            draftExcerpt: proseExcerpt(currentDraft, 900),
          }),
        );
        const decision = parseSupervisorDecision(merged);
        const acted = decideSupervision(decision, [adv, voi]);
        emit({
          type: 'phase',
          label: `监工终审：${acted.dispatch === 'rewrite' ? '打回重写' : '放行'} —— ${acted.reason}`,
        });

        if (acted.dispatch === 'deliver') {
          if (decision.verdict !== 'ok' || decision.notes) {
            warnings.push(`监工终审放行（${decision.verdict}）${decision.notes ? `：${decision.notes}` : ''}`);
          }
          break;
        }

        if (supRound === MAX_SUPERVISE_ROUNDS) {
          // 改满轮数仍被判重写 → 与意图门的取舍一致：**缺章比带瑕疵更糟**，照常交付并标注
          warnings.push(`监工终审打回 ${MAX_SUPERVISE_ROUNDS} 轮仍未通过，已带警示交付：${acted.reason}`);
          emit({
            type: 'phase',
            label: `监工终审改满 ${MAX_SUPERVISE_ROUNDS} 轮仍未通过 —— 仍会交付（缺章比带瑕疵更糟），交付结果里会标注`,
          });
          break;
        }

        emit({ type: 'phase', label: '监工派发写作：写作官按审阅意见重写中…' });
        currentDraft = await speak(ROLE_WRITER, renderDispatchInstruction(decision, [adv, voi]));
        emit({ type: 'draft', text: currentDraft, revision: MAX_REVISIONS + 2 });
      }

      // ——— 校对门（硬门 · 全文 × 设定库）———
      // 与意图门的分工：意图门是「答应的事做了吗」（点，对照本章结论），
      // 校对门是「有没有说错话」（面，全文扫描设定库）。
      // 治理上刻意只给它**一次定向修订**：第二个打回循环会引来第三、第四个，
      // 而两次打回后整章作废的代价（实测 2026-09-12：3333 字全废）远大于残留一处小冲突。
      emit({ type: 'phase', label: '校对门：全文对照设定库…' });
      let gate = await runConsistencyGate(ctx, { order: targetOrder, draft: currentDraft, digest: await getProofreadDigest() as SettingsDigest, userId });
      emit({
        type: 'gate',
        name: 'check',
        passed: gate.pass,
        // ★ 执行失败（两次都没解析成功）要标出来：passed=true 是"不拦交付"的取舍，
        //   但绝不能让它看起来像是"检查通过了"
        ...(gate.error ? { skipped: true } : {}),
        detail: gate.error
          ? gate.error
          : (gate.pass ? '未发现与设定库冲突' : (gate.conflicts.join('；') || '未给出具体冲突')),
      });
      if (!gate.pass) {
        emit({ type: 'phase', label: `校对门发现 ${gate.conflicts.length || 1} 处冲突，写作官定向修订中…` });
        try {
          const fixed = await speak(
            ROLE_WRITER,
            '【本轮任务】校对官把正文与设定库逐条比对，发现下列冲突，请**定向修正**：\n'
            + (gate.conflicts.map((c, i) => `${i + 1}. ${c}`).join('\n') || '（校对官未列出具体条目）')
            + (gate.instructions ? `\n校对官的修正指令：${gate.instructions}` : '')
            + '\n\n只改涉及处，不要重写全章；直接输出修正后的**完整正文**。'
            + `篇幅不得少于 ${WRITER_MIN_CHARS} 字。`,
            { maxTokens: WRITER_MAX_TOKENS },
          );
          if (fixed.trim()) {
            // 修订前的原稿留一份：若修订稿跌破篇幅下限，就回退到它（见下方下限检查）
            const beforeConsistencyFix = currentDraft;
            currentDraft = fixed;
            /**
             * ★ 2026-10-22：**校对门的定向修正也要做长度归一化**。
             *   它是候选选稿**之后**的最后一道改写，此前没有任何篇幅约束 ——
             *   实测第 78 章：意图门选出 3442 字（在带内），校对门定向修正后变成 **3624 字超带交付**，
             *   成了"所有长度闸门都过了、最后一步又漂出去"的漏口。
             *   提示词里只写了"篇幅不得少于 X 字"（只有下限），所以给它补上上限的硬钳制。
             */
            if (proseLength(currentDraft) > WRITER_MAX_CHARS) {
              const beforeFix = proseLength(currentDraft);
              const cutFixed = trimToMaxChars(currentDraft);
              const cutFixedLen = proseLength(cutFixed);
              if (cutFixedLen < beforeFix) {
                currentDraft = cutFixed;
                console.log(`[discuss] 校对门修正稿按段落裁剪 ${beforeFix} → ${cutFixedLen} 字`);
              }
            }
            /**
             * ★ 2026-11-01：**下限也要守**（10-22 只补了上限，这一边一直是漏的）。
             *
             * 实测（第 11 章）：1877 字的稿子，校对门定向修订后模型只回了 **247 字**，
             * 而这里只判 `> 上限`，于是 247 字直接落库交付 —— 成稿被毁。
             * 提示词里那句「篇幅不得少于 X 字」只是**请求**，不是约束。
             *
             * 处理原则：**修订稿跌破下限就整份丢弃，保留修订前的稿子**。
             * 理由是不对称的 —— 留着一处未消除的设定冲突，作者人工一眼能改；
             * 交付 247 字的残章，等于这一章没了。
             * 同 `dedupeExactRepeats` 的 `keepAtLeast`：宁可留瑕疵，不许删破下限。
             */
            else if (proseLength(currentDraft) < WRITER_MIN_CHARS) {
              console.warn(
                `[discuss] 校对门修正稿跌破下限（${proseLength(currentDraft)} < ${WRITER_MIN_CHARS} 字），`
                + '整份丢弃、保留修订前原稿',
              );
              currentDraft = beforeConsistencyFix;
            }
          }
          emit({ type: 'draft', text: currentDraft, revision: MAX_REVISIONS + 1 });
          const recheck = await runConsistencyGate(ctx, { order: targetOrder, draft: currentDraft, digest: await getProofreadDigest() as SettingsDigest, userId });
          emit({
            type: 'gate',
            name: 'check',
            passed: recheck.pass,
            detail: recheck.error
              ? recheck.error
              : (recheck.pass
                ? '定向修订后冲突已消除'
                : `定向修订后仍有冲突：${recheck.conflicts.join('；')}`),
          });
          gate = recheck;
        } catch (e) {
          console.warn('[discuss] 校对门定向修订失败，按原稿继续:', e);
        }
      }
      if (!gate.pass) {
        // 不阻塞：宁可带着一处标注交付，也不要让整章作废
        emit({
          type: 'phase',
          label: `校对门仍有 ${gate.conflicts.length || 1} 处冲突未消除 —— 不拦交付，请在成稿里人工确认`,
        });
      }

      // ——— 润色门（软门 · 评分）——从不阻塞交付 ———
      emit({ type: 'phase', label: '润色门：质量评分中…' });
      const polish = await runPolishGate(ctx, { order: targetOrder, draft: currentDraft, userId });
      emit({
        type: 'gate',
        name: 'polish',
        passed: !polish.error && polish.score >= POLISH_PASS_SCORE,
        ...(polish.error ? { skipped: true } : {}),
        score: polish.score,
        detail: polish.error ?? (polish.comments || '（无评语）'),
      });

      /**
       * ★ 2026-10-25（D2）：**交付前确定性去重** —— 机械删除**后现**的精确重复句，保留首现。
       *
       * 放在这里（与长度不变量同一处"交付边界"）：这是**最后**一次动正文的机会 ——
       *   监工派发的重写、校对门的定向修订都在它之前，落库之后再也没有机会。放此处，
       *   无论正文经过哪条路径，落库的都是"已去重"的稿子。
       *
       * 为什么敢机械删：**检测端抓得到、模型改不动**是全项目的实测结论（写作模型长上下文
       *   退化为复读机，3 次重写照样把同一句抄回来）。删的是**逐字相同**的句子 ——
       *   删后现对内容零损失（变体式重复可能带新信息，**不在这里删**，见 repetition.ts 的 D2 说明）。
       *   零模型调用、零方差。实测本书可删 章内 369 句 / 跨章 351 句 / 共约 1.8 万字（全书 6%）。
       *
       * 只在**未过意图门**的路径上跑：过了门的章重复未超标、不该被动；未过门才需要这层兜底。
       *
       * ★ 2026-10-27：加了 **`keepAtLeast` 保留下限**。此前这道是"删到底"，
       *   实测把章节删破（2914 → 2122，23 章里 8 章低于 2500）。
       *   去重的目标是**去掉多余重复**，不是把章节删短 —— 删到下限就停手，
       *   剩下的重复由下面的警示如实报出来（而不是悄悄截断、也不装作没有）。
       */
      if (!approved) {
        const dd = dedupeExactRepeats(currentDraft, priorForDup, { keepAtLeast: WRITER_MIN_CHARS });
        if (dd.removedIntra + dd.removedCross > 0) {
          const beforeDd = proseLength(currentDraft);
          currentDraft = dd.text;
          rep = detectRepetition(currentDraft);
          cross = detectCrossChapterRepetition(currentDraft, priorForDup);
          dlg = detectDialogue(currentDraft);
          const afterDd = proseLength(currentDraft);
          console.log(
            `[discuss] 交付前确定性去重：删章内 ${dd.removedIntra} 句 / 跨章 ${dd.removedCross} 句（${beforeDd} → ${afterDd} 字）`
            + (dd.keptForLength ? `｜因保篇幅留下 ${dd.keptForLength} 句重复未删` : ''),
          );
          emit({
            type: 'phase',
            label: `交付前确定性去重：删去 ${dd.removedIntra + dd.removedCross} 句**逐字重复**（${beforeDd} → ${afterDd} 字）`
              + (dd.keptForLength ? ` · 另有 ${dd.keptForLength} 句因保篇幅留下` : ''),
          });
        }
        /**
         * ★ 2026-10-29 修（审计确认）：**`keptForLength` 必须在外层判断之外报**。
         *
         * `dedupeExactRepeats` 在「有重复、但删一句就会跌破下限」时返回
         * `{ ...none, keptForLength: N }`（正文没动、removedIntra/Cross 都是 0）。
         * 而原来的警示写在 `if (dd.removedIntra + dd.removedCross > 0)` **里面** ⇒
         * 这个场景一条警示都不发 —— 恰好是 65d1397 声称要修好的那种情况。
         *
         * 它单独成立：**没删**不等于**没问题**，反而说明这一章重复多到删不动。
         */
        if (dd.keptForLength > 0) {
          warnings.push(
            `本章重复偏多：去重删到 ${WRITER_MIN_CHARS} 字下限就停手，另有 ${dd.keptForLength} 句重复未删`
            + '（删净会低于下限）—— 建议人工看一眼是否内容本身偏薄',
          );
        }
      }

      /**
       * ★ 2026-10-22：**交付边界的长度不变量**（最后一道，也是最该有的一道）。
       *
       * 前面已经在五个改写点分别做了长度收敛（初稿 / 补写 / 超长删减 / 重写 / 校对门修正），
       * 但实测证明"逐个打补丁"永远会漏一个：第 78 章就是意图门选完 3442 字（在带内）之后，
       * 被**校对门的定向修正**顶回 3624 字超带交付 —— 而那条路径当时没人管。
       *
       * 所以在这里补一道**兜底不变量**：无论正文是经过哪条路径来的，落库前一律收进上限。
       * 与前面几处不重复（那里是"让闸门看到正确的稿子"，这里是"保证落库的稿子合规"）。
       * 只做净减，不动在带内或偏短的稿子 —— 欠下限交给意图门与补写，不在交付口硬塞。
       */
      if (proseLength(currentDraft) > WRITER_MAX_CHARS) {
        const beforeDeliver = proseLength(currentDraft);
        const finalCut = trimToMaxChars(currentDraft);
        const finalLen = proseLength(finalCut);
        if (finalLen < beforeDeliver) {
          currentDraft = finalCut;
          console.log(`[discuss] 交付前兜底裁剪 ${beforeDeliver} → ${finalLen} 字（超上限，落库前强制收敛）`);
        }
      }

      /**
       * ★ 交付前**最后一遍**确定性检查：把残留问题如实写进交付警示。
       *
       * 为什么挪到这里（2026-10-25）：这些警示原先在意图门之后就算好了 —— 但**去重与篇幅
       *   收口都在它后面**，于是会报"本章仍有 10 处章内重复"，而它们其实刚被机械删掉。
       *   放在去重+收口**之后**，警示讲的才是**真正落库的那一稿**。
       *   两类重复分别警示：模型可能只压下一类（它常把"精确重复"删掉、却把"换个说法的
       *   复写"留下），合并成一条会漏报真实残留。
       */
      if (rep.exactExcessive) {
        const worst = [...rep.paragraphs, ...rep.sentences][0];
        warnings.push(`本章仍有章内重复（${rep.excessSentences} 处多余重复）${worst ? `，如「${worst.text.slice(0, 40)}」出现 ${worst.count} 次` : ''}`);
      }
      if (rep.approximateExcessive) {
        const worst = rep.nearDuplicates[0];
        warnings.push(`本章仍有**变体式**重复（换词重写同一情节，${rep.excessNearDuplicates} 处多余重复）${worst ? `，如「${worst.text.slice(0, 40)}」出现 ${worst.count} 次` : ''}`);
      }
      if (dlg.tooLow) {
        warnings.push(`本章对话占比仅 ${(dlg.ratio * 100).toFixed(1)}%，低于下限 ${(DIALOGUE_RATIO_MIN * 100).toFixed(0)}%`);
      }
      // ★ 2026-10-30：对话**过多**也如实报（实测第 114 章 63%，动作与环境被挤掉）
      if (dlg.tooHigh) {
        warnings.push(`本章对话占比高达 ${(dlg.ratio * 100).toFixed(1)}%，超过上限 ${(DIALOGUE_RATIO_MAX * 100).toFixed(0)}%（动作与环境被挤掉，读起来像剧本）`);
      }
      // ★ 2026-10-30：对话**太碎**也如实报（每句 1–4 字的电报体应答，用户反馈"太像 AI"）
      if (dlg.tooFragmented) {
        warnings.push(`本章对话偏碎：${dlg.segments} 段、平均 ${dlg.meanSegChars.toFixed(1)} 字、短段占 ${(dlg.shortSegRatio * 100).toFixed(0)}%（像机器在对单据）`);
      }
      if (cross.exactExcessive) {
        const worst = cross.findings[0];
        warnings.push(`本章与前面章节有 ${cross.exactCount} 句**逐字**重复${worst ? `，如「${worst.text.slice(0, 36)}」（已在第 ${worst.priorOrders.join('、')} 章出现）` : ''}`);
      }
      if (cross.nearExcessive) {
        const worst = cross.nearFindings[0];
        warnings.push(`本章与前面章节有 ${cross.nearCount} 句**变体式**复写（换词重写旧章段落）${worst ? `，如「${worst.text.slice(0, 36)}」≈ 第 ${worst.priorOrders.join('、')} 章的「${worst.priorText.slice(0, 36)}」` : ''}`);
      }
      // ★ 2026-10-21：篇幅之外，**提纲泄漏**同样要在交付时如实告知
      //   （此前只有模型监工会提，而它抓到就要 halt；代码这一关的结论落到交付警示里才看得见）
      if (leakTooMany()) {
        warnings.push(`本章仍有 ${leakCount()} 处提纲/结构语言（${leakHits().map((h) => `${h.word}×${h.count}`).join('、')}），请人工复核本章`);
      }

      /**
       * ── 硬门禁 ③：未过 85 不许定稿 ──
       *
       * ★ 为什么**不拦交付**（这条是刻意的，不是漏做）：
       *   `framework/gates.ts` 的治理口径写明「润色门是软门：只评分、给意见，**从不阻塞** ——
       *   评分低不该拦下一章」，那是一条用真实事故换来的结论（2026-09-12：两次打回后
       *   整章 3333 字全废，代价远大于残留一处小冲突）。
       *   所以这条门的正确落法是：**正文照旧交付，但不给"定稿"这个身份** ——
       *   章节 status 只在这一刻由 'draft' 提升为 'final'，没过线就保持 'draft'。
       *
       * 判据**全部来自本链路已有的代码判定**（意图门 / 重复 / 篇幅 / 泄漏 / 对话 /
       * 校对门 / 润色门），本门**不新增任何模型调用**。
       * 执行失败的门不扣分（fail-open）—— 与既有口径一致：不能让基础设施抖动
       * 决定一章能不能定稿。
       */
      const finalize = scoreChapterForFinalize({
        reviewPassed: approved,
        repExcessive: rep.excessive,
        crossExcessive: cross.excessive,
        outOfBand: isOutOfBand(currentDraft),
        leakTooMany: leakTooMany(),
        dlgLow: dlg.tooLow,
        dlgHigh: dlg.tooHigh,
        dlgFragmented: dlg.tooFragmented,
        consistencyPassed: gate.pass,
        consistencySkipped: Boolean(gate.error),
        polishScore: polish.score,
        polishSkipped: Boolean(polish.error),
      });
      emit({
        type: 'gate',
        name: 'finalize',
        passed: finalize.ok,
        score: finalize.score,
        detail: renderFinalizeDetail(finalize),
      });
      if (!finalize.ok) {
        warnings.push(
          `未达定稿线（${finalize.score}/100 < ${FINALIZE_MIN_SCORE}）：`
          + finalize.deductions.map((d) => d.reason).join('；')
          + ' —— 正文已交付，但**未标定稿**，请人工复核后再定稿。',
        );
      }

      // 只有过了意图门才落库 —— 别把没过门的东西写进章节
      emit({ type: 'phase', label: '交付中…' });
      // ★ 2026-10-16 修：`warnings` 必须传进 deliver。
      //   此前这里漏传，导致上面辛苦算出的「意图门未通过 / 章内重复 / 变体式重复 / 对话占比过低」
      //   四条警示**全被丢掉** —— 落库的章 `warnings` 恒为空，监工 halt 时事后根本查不到
      //   为什么（实测第 5 章 5807 字/31 处重复，却报"警示:[]"）。
      const delivered = await deliver(
        ctx,
        {
          projectId, message, order: chapterOrder, draft: currentDraft,
          // 摘要取「本章结论」（定稿官写的那份，本来就描述本章要发生什么），零额外调用
          summary: conclusion,
          ...(warnings.length ? { warnings } : {}),
          // 定稿门：过线才给"定稿"身份（见上方硬门禁 ③）
          finalStatus: finalize.ok ? 'final' : 'draft',
        },
        emit,
      );

      // —— 实体沉淀：把本章新出现/变动的角色·物品·地点·伏笔写进项目库 ——
      // 只跟着**真交付**走：被治理拦下的（已有正文不覆盖 / 没认出章号）绝不沉淀，
      // 否则设定库里会出现正文里根本没有的实体。
      if (delivered.delivered) {
        // ★ A3：故事内时间（水车三层时间戳的第三层）—— 从定稿官契约里抽，抽不到就不写
        const storyTime = await persistChapterStoryTime(ctx, projectId, delivered.order, conclusion);
        if (storyTime) emit({ type: 'phase', label: `故事内时间：${storyTime}` });
        emit({ type: 'phase', label: '沉淀本章实体中…' });
        const sink = await persistChapterEntities(ctx, {
          projectId,
          order: delivered.order,
          draft: currentDraft,
          conclusion,
          existingForeshadows: digest.foreshadows,
          userId,
        });
        emit({
          type: 'entities',
          created: sink.created,
          updated: sink.updated,
          skipped: sink.skipped,
          notes: sink.notes,
        });
      }
    }

    if (opts.finalDone !== false) emit({ type: 'done' });
  } catch (e) {
    emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    if (opts.finalDone !== false) emit({ type: 'done' });
  }
}

// ============================================================
// 连写多章（P1-2）
//
// 动机：在此之前一轮会话只能处理一章 —— 想写 10 章就得有人守着敲 10 次，
// 那不叫「自动写作」。这里把单章闭环串成循环。
//
// 设计要点：
//   · **逐章串行**：每章都完整跑讨论 → 结论 → 落笔 → 三道门 → 交付 → 沉淀，
//     不给它「跳过某步省事」的机会（多章连写最容易在这里偷工减料）。
//   · **一章失败不拖垮后面**：单章内部已把异常收敛成 error 事件，
//     这里只统计成败、继续下一章，最后汇总 —— 30 章跑到第 17 章崩掉不该全废。
//   · **后续章的指令由上一章自然延续**：不重复作者的原始口头指令（那是指向第 1 章的），
//     改发「接着上一章往下写第 N 章」，并靠「上一章全文注入」保证衔接。
//   · 事件带 index/total，前端据此分段显示。
// ============================================================

export interface MultiChapterOpts extends DiscussionOpts {
  /** 连写章数（1 = 单章） */
  chapterCount: number;
}

/**
 * 已交付的最后一章号（没有任何章时返回 0）。
 *
 * ★ 2026-10-29 新增，为修 `runChapters` 的起始章号 bug：
 *   原实现 `from = opts.chapterOrder ?? parseChapterOrder(message) ?? 1` ——
 *   作者说「接着写 10 章」时消息里**没有"第 N 章"**，于是从**第 1 章**开始写，
 *   而第 1 章已有正文 ⇒ 每章都被「已有正文不自动覆盖」拦下 ⇒ **连烧 10 次调用全白费**。
 *   实测：一次「接着写 10 章」把 1、2 章各跑了一遍完整讨论，全部 `deliver_blocked`。
 *
 *   正确语义：**没明说章号时，接着已有的往下写**。这也是作者说"接着写"的本意。
 */
export async function lastDeliveredOrder(ctx: ServerPluginContext, projectId: string): Promise<number> {
  try {
    const db = ctx.db.project(projectId) as DrizzleDb | null;
    if (!db) return 0;
    const rows = await db
      .select({ order: schema.chapters.order })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.projectId, projectId), isNull(schema.chapters.deletedAt)))
      .orderBy(desc(schema.chapters.order))
      .limit(1);
    return Number(rows[0]?.order ?? 0) || 0;
  } catch (e) {
    console.warn('[discuss] 读取已有章节失败（按空库处理）:', e);
    return 0;
  }
}

/**
 * 连写的起始章号（纯函数，可直接单测）。
 *
 * 优先级：**显式 chapterOrder > 消息里的「第 N 章」> 接着已有章节往下写**。
 * 全书还没任何章时 `lastDelivered=0` ⇒ 从第 1 章开始（正确）。
 *
 * ★ 为什么这个函数值得单独抽出来测：原来的写法是 `... ?? 1`，
 *   而「接着写 10 章」这句消息里没有「第 N 章」⇒ 一路落到默认值 1
 *   ⇒ 从第 1 章开始写、每章都被「已有正文不自动覆盖」拦下、**连烧 10 次调用全白费**。
 *   这是个**静默烧钱**的 bug —— 界面上只看到"每章都失败"，看不出根因是章号算错。
 */
export function resolveStartOrder(
  opts: { chapterOrder?: number; message: string },
  lastDelivered: number,
): number {
  const explicit = opts.chapterOrder ?? parseChapterOrder(opts.message);
  return explicit ?? lastDelivered + 1;
}

export async function runChapters(
  ctx: ServerPluginContext,
  opts: MultiChapterOpts,
  emit: (e: SessionEvent) => void,
): Promise<void> {
  const total = Math.max(1, Math.min(50, Math.floor(opts.chapterCount) || 1));
  const from = resolveStartOrder(opts, await lastDeliveredOrder(ctx, opts.projectId));
  let ok = 0;

  for (let i = 0; i < total; i++) {
    const order = from + i;
    const index = i + 1;
    emit({ type: 'chapter_start', order, index, total });

    // 第 1 章用作者原话；之后各章自动续写（作者的指令是写给第 1 章的，不能一路照抄）
    const message = i === 0
      ? opts.message
      : `接着上一章往下写第 ${order} 章。保持人物、伏笔与文风的连续性，不要重述上一章已经写过的内容。`;

    let failed = false;
    const wrapped = (e: SessionEvent) => {
      if (e.type === 'error') failed = true;
      emit(e);
    };

    try {
      await runDiscussion(
        ctx,
        { ...opts, message, chapterOrder: order, finalDone: false },
        wrapped,
      );
    } catch (e) {
      failed = true;
      const detail = e instanceof Error ? e.message : String(e);
      emit({ type: 'error', message: `第 ${order} 章异常中止：${detail}` });
    }

    if (!failed) ok++;
    emit({ type: 'chapter_done', order, index, total, delivered: !failed });
  }

  console.log(`[discuss] 连写结束：${ok}/${total} 章无错（起始第 ${from} 章）`);
  emit({ type: 'done' });
}
