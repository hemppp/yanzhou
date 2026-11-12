// ============================================================
// 章节质量体检（**服务端**汇总，供界面只读展示）
//
// ★ 为什么在这一侧算，而不是让面板自己算：
//   体检的意义是**和流水线同一把尺子**。若面板在前端另写一套阈值，
//   就会出现"界面说没问题、流水线却打回"，等于制造了第二套真相。
//   这里直接复用现役判据：framework/dialogue.ts、pipeline/repetition.ts、
//   discuss/gate-rules.ts 的篇幅带 —— 一行阈值都不重复定义。
//
// ★ 纯函数 + 一次 DB 读：不做模型调用、不写任何状态。可以随便点刷新。
// ============================================================

import { schema, eq, and, isNull, desc, getProjectDb, type DrizzleDb } from '@novel/db';
import { detectDialogue, DIALOGUE_RATIO_MIN, DIALOGUE_RATIO_MAX } from '../framework/dialogue.js';
import { detectRepetition, detectCrossChapterRepetition } from '../pipeline/repetition.js';
import { proseLength, isTooLong, isTooShort } from './gate-rules.js';
import { WRITER_MIN_CHARS, WRITER_MAX_CHARS, WRITER_TARGET_CHARS } from './roles.js';

/** 单章体检结论 */
export interface ChapterHealthRow {
  order: number;
  title: string;
  status: string;
  chars: number;
  /** 篇幅：'low' 欠下限 / 'high' 超上限 / 'ok' 在带内 */
  length: 'low' | 'high' | 'ok';
  /** 对话占比 0–1 */
  dialogueRatio: number;
  /** 对话形态问题（可能同时为真）；都否 = ok */
  dialogueLow: boolean;
  dialogueHigh: boolean;
  dialogueFragmented: boolean;
  /** 章内重复「多出来」的次数（**明细数字**，供展示；判定看下面的 excessive） */
  intraDup: number;
  /** 跨章重复条数（同上，明细） */
  crossDup: number;
  /**
   * 重复**是否达到流水线的打回线**（= repetition.ts 的 `excessive`）。
   *
   * ★ 为什么不拿 `intraDup > 0` 当判据：流水线用的是阈值（精确/近似/情节块各有一条线，
   *   跨章 Cron 是 `CROSS_DUP_MAX=5`），**不是"有一条就算问题"**。
   *   第一版写成 `>0` 之后，面板把"1 条跨章重复"标成问题章，而流水线判定合格 ——
   *   正好制造出本文件头注释里警告的"第二套真相"。明细照常展示，判定必须同源。
   */
  intraDupExcessive: boolean;
  crossDupExcessive: boolean;
  /** 本章是否有任何一项**按流水线口径**需要关注 */
  flagged: boolean;
}

export interface ChapterHealthReport {
  projectId: string;
  /** 篇幅带（与流水线同一口径，界面直接展示，避免写死数字） */
  band: { min: number; max: number; target: number };
  /**
   * 对话占比的上下限（同样来自现役常量，不在前端另写）。
   * 主页的散点图要靠 `floor` 画那条虚线 —— 若前端自己写 15%，改阈值时图会说谎。
   */
  dialogue: { floor: number; ceiling: number };
  chapters: ChapterHealthRow[];
  summary: {
    count: number;
    totalChars: number;
    avgChars: number;
    /** 各项有问题的**章数**（不是问题条数） */
    outOfBand: number;
    dialogueLow: number;
    dialogueHigh: number;
    dialogueFragmented: number;
    intraDup: number;
    crossDup: number;
    /** 完全干净的章数 */
    clean: number;
  };
}

/**
 * 取一本已交付章节的体检报告。
 *
 * 跨章重复按**章节顺序**逐章比对（第 N 章对前 N−1 章），与流水线交付时的
 * `detectCrossChapterRepetition(currentDraft, priorForDup)` 同向。
 * 注意这是 O(n²) 句子级比较：30 万字量级下 ≤ 110 章，实测可接受；
 * 若将来变成瓶颈，再引入前面几章的窗口。
 */
export async function collectChapterHealth(
  projectId: string,
  limit = 0,
): Promise<ChapterHealthReport> {
  const db = await getProjectDb(projectId) as unknown as DrizzleDb;
  const rows = await db
    .select({
      order: schema.chapters.order,
      title: schema.chapters.title,
      content: schema.chapters.content,
      status: schema.chapters.status,
      wordCount: schema.chapters.wordCount,
    })
    .from(schema.chapters)
    .where(and(eq(schema.chapters.projectId, projectId), isNull(schema.chapters.deletedAt)))
    .orderBy(desc(schema.chapters.order));

  // 同一 order 可能有多行（历史版本）；保留**最后写入的**（desc 后首次出现即最新）
  const byOrder = new Map<number, typeof rows[number]>();
  for (const r of rows) if (!byOrder.has(r.order)) byOrder.set(r.order, r);

  const ordered = [...byOrder.values()].sort((a, b) => a.order - b.order);
  const scoped = limit > 0 ? ordered.slice(-limit) : ordered;

  const chapters: ChapterHealthRow[] = [];
  // 跨章比对的历史：只算**本篇范围内**已处理过的章（limit 时即窗口内）
  const prior: Array<{ order: number; content: string }> = [];

  for (const r of scoped) {
    const content = r.content ?? '';
    const chars = proseLength(content);
    const dlg = detectDialogue(content);
    const rep = detectRepetition(content);
    const cross = prior.length ? detectCrossChapterRepetition(content, prior) : null;

    const length: ChapterHealthRow['length'] =
      isTooShort(content) ? 'low' : isTooLong(content) ? 'high' : 'ok';
    const intraDup = rep.excessSentences + rep.excessNearDuplicates;
    const crossDup = cross?.count ?? 0;
    // 判定一律走判据自己的 excessive（阈值语义），明细数字只用于展示
    const intraDupExcessive = rep.excessive;
    const crossDupExcessive = cross?.excessive ?? false;

    chapters.push({
      order: r.order,
      title: r.title || '',
      status: String(r.status ?? ''),
      chars: chars || r.wordCount || 0,
      length,
      dialogueRatio: dlg.ratio,
      dialogueLow: dlg.tooLow,
      dialogueHigh: dlg.tooHigh,
      dialogueFragmented: dlg.tooFragmented,
      intraDup,
      crossDup,
      intraDupExcessive,
      crossDupExcessive,
      flagged: length !== 'ok' || dlg.tooLow || dlg.tooHigh || dlg.tooFragmented
        || intraDupExcessive || crossDupExcessive,
    });

    prior.push({ order: r.order, content });
  }

  const totalChars = chapters.reduce((a, c) => a + c.chars, 0);
  return {
    projectId,
    band: { min: WRITER_MIN_CHARS, max: WRITER_MAX_CHARS, target: WRITER_TARGET_CHARS },
    dialogue: { floor: DIALOGUE_RATIO_MIN, ceiling: DIALOGUE_RATIO_MAX },
    chapters,
    summary: {
      count: chapters.length,
      totalChars,
      avgChars: chapters.length ? Math.round(totalChars / chapters.length) : 0,
      outOfBand: chapters.filter((c) => c.length !== 'ok').length,
      dialogueLow: chapters.filter((c) => c.dialogueLow).length,
      dialogueHigh: chapters.filter((c) => c.dialogueHigh).length,
      dialogueFragmented: chapters.filter((c) => c.dialogueFragmented).length,
      intraDup: chapters.filter((c) => c.intraDupExcessive).length,
      crossDup: chapters.filter((c) => c.crossDupExcessive).length,
      clean: chapters.filter((c) => !c.flagged).length,
    },
  };
}