// ============================================================
// 上下文解析器 —— flow 型技能的服务端供数通道
//
// chat 型技能由前端注入上下文；flow 型不依赖前端在场，
// 由这里直接查项目库产出紧凑设定摘要（digest），喂给子代理。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { schema, eq, and, isNull, asc, desc, lt, type DrizzleDb } from '@novel/db';

/** 截断工具：超长字段收敛，保 digest 紧凑 */
function cut(v: unknown, n: number): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export interface SettingsDigest {
  projectName: string;
  genre: string;
  characters: string;
  foreshadows: string;
  outline: string;
  chapters: string;
  /**
   * 开书设定（`projects.brief`）格式化后的文本，没有则为空串。
   * 由新书向导收集：开局 / 世界观 / 笔风基调 / 主角 / 女主 / 流派。
   */
  brief?: string;
}

/** `projects.brief` 是 JSON 文本列，这里手动解析并兜底（不 import db 层的 parseJson，避免跨包耦合） */
function parseBrief(raw: unknown): Record<string, unknown> | null {
  /**
   * ★ 同时接受**已经是对象**的形态。
   *
   * 只认字符串会埋一个静默坑：调用方手里常常已经解析过了
   * （`readProjectBriefRaw()` 返回的就是对象），若拿它去喂 `formatBrief`，
   * 会得到 null → 注入整段被跳过 → **作者的设定白填、而且不报任何错**。
   * 这类"悄悄少了一段"最难查（实测：单测里传对象时 formatBrief 返回空串才发现）。
   */
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 把开书设定格式化成可注入模型的一段文字。
 *
 * ★ 为什么要**强制注入**而不是让角色自己去查：`projects.brief` 在主库、不在项目库，
 *   角色手里的工具（`list_chapters` / `read_chapter`）根本读不到；不注入的话，
 *   作者在向导里填的开局 / 世界观 / 笔风 / 女主就是白填 —— 讨论现场只会看到书名。
 * 没有设定（手写项目、旧项目）时返回空串，调用方据此整段跳过。
 */
export function formatBrief(raw: unknown): string {
  const b = parseBrief(raw);
  if (!b) return '';
  const s = (k: string): string => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  const heroes = Array.isArray(b.heroines)
    ? b.heroines.filter((h): h is string => typeof h === 'string' && h.trim() !== '').map((h) => h.trim())
    : [];
  const catLabel = b.genreCategory === 'system' ? '系统流' : b.genreCategory === 'none' ? '无系统流' : '';

  const lines: string[] = [];
  if (s('opening')) lines.push(`开局：${s('opening')}`);
  if (s('worldview')) lines.push(`世界观：${s('worldview')}`);
  if (s('style')) lines.push(`笔风基调：${s('style')}`);
  if (s('protagonist')) lines.push(`主角：${s('protagonist')}`);
  if (heroes.length > 0) {
    lines.push(b.multipleHeroines === true
      ? `女主（多女主，共 ${heroes.length} 位）：${heroes.join('、')}`
      : `女主：${heroes[0]}`);
  }
  const genre = [catLabel, s('genre')].filter(Boolean).join(' · ');
  if (genre) lines.push(`流派：${genre}`);
  return lines.join('\n');
}

/** 拉取项目设定摘要（角色/伏笔/大纲/章节清单） */
export async function resolveSettingsDigest(
  ctx: ServerPluginContext,
  projectId: string,
): Promise<SettingsDigest> {
  const db = ctx.db.project(projectId) as DrizzleDb;

  const chars = await db
    .select({
      name: schema.characters.name,
      role: schema.characters.role,
      desire: schema.characters.desire,
      fear: schema.characters.fear,
      personality: schema.characters.personality,
      speechStyle: schema.characters.speechStyle,
      backstory: schema.characters.backstory,
    })
    .from(schema.characters)
    .where(eq(schema.characters.projectId, projectId));

  const fsh = await db
    .select({
      description: schema.foreshadows.description,
      type: schema.foreshadows.type,
      status: schema.foreshadows.status,
      seedChapter: schema.foreshadows.seedChapter,
      payoffChapter: schema.foreshadows.payoffChapter,
    })
    .from(schema.foreshadows)
    .where(eq(schema.foreshadows.projectId, projectId));

  const outline = await db
    .select({
      type: schema.outlineNodes.type,
      title: schema.outlineNodes.title,
      description: schema.outlineNodes.description,
      order: schema.outlineNodes.order,
    })
    .from(schema.outlineNodes)
    .where(eq(schema.outlineNodes.projectId, projectId))
    .orderBy(asc(schema.outlineNodes.order));

  const chapters = await db
    .select({
      order: schema.chapters.order,
      title: schema.chapters.title,
      wordCount: schema.chapters.wordCount,
      summary: schema.chapters.summary,
      deletedAt: schema.chapters.deletedAt,
    })
    .from(schema.chapters)
    .where(eq(schema.chapters.projectId, projectId))
    .orderBy(asc(schema.chapters.order));

  // 项目基本信息在主库
  const gdb = ctx.db.global() as DrizzleDb;
  const projRows = await gdb
    .select({
      name: schema.projects.name,
      genre: schema.projects.genre,
      description: schema.projects.description,
      brief: schema.projects.brief,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  const proj = projRows[0] ?? {};

  const charLines = chars.map((c) =>
    `- ${c.name}（${c.role ?? '未定位'}）：欲望=${cut(c.desire, 80)} 恐惧=${cut(c.fear, 60)} 性格=${cut(c.personality, 100)} 语言风格=${cut(c.speechStyle, 60)} 背景=${cut(c.backstory, 120)}`,
  );
  const fshLines = fsh.map((f) =>
    `- [${f.type}/${f.status}] ${cut(f.description, 80)}（埋于第${f.seedChapter}章${f.payoffChapter ? `，回收于第${f.payoffChapter}章` : '，未回收'}）`,
  );
  const outlineLines = outline.map((o) => `- [${o.type}] ${o.title}${o.description ? `：${cut(o.description, 120)}` : ''}`);
  const chapterLines = chapters
    .filter((c) => !c.deletedAt)
    .map((c) => `- 第${c.order}章《${c.title}》（${c.wordCount ?? 0}字）${c.summary ? `摘要：${cut(c.summary, 80)}` : ''}`);

  return {
    projectName: String(proj.name ?? ''),
    genre: String(proj.genre ?? ''),
    characters: charLines.join('\n') || '（暂无角色设定）',
    foreshadows: fshLines.join('\n') || '（暂无伏笔）',
    outline: outlineLines.join('\n') || '（暂无大纲）',
    chapters: chapterLines.join('\n') || '（暂无章节）',
    brief: formatBrief(proj.brief),
  };
}

/** 读取某一章的现有内容（交付覆写检查 + 备份用） */
/** 读**原始** brief（JSON 对象）。drift 的 L1 断言按字段拆，需要原始字段而不是格式化文本 */
export async function readProjectBriefRaw(
  ctx: ServerPluginContext,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const gdb = ctx.db.global() as DrizzleDb;
    const rows = await gdb
      .select({ brief: schema.projects.brief })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    return parseBrief(rows[0]?.brief);
  } catch (e) {
    console.warn('[context] 读原始 brief 失败（按无 brief 处理）:', e);
    return null;
  }
}

export async function readChapterByOrder(
  ctx: ServerPluginContext,
  projectId: string,
  order: number,
): Promise<{ id: string; title: string; content: string } | undefined> {
  const db = ctx.db.project(projectId) as DrizzleDb;
  const rows = await db
    .select({ id: schema.chapters.id, title: schema.chapters.title, content: schema.chapters.content })
    .from(schema.chapters)
    .where(and(eq(schema.chapters.projectId, projectId), eq(schema.chapters.order, order), isNull(schema.chapters.deletedAt)))
    .limit(1);
  return rows[0];
}

/** 上一章全文的注入上限（字符数）—— 衔接最吃结尾，超限时保留结尾 */
export const PREV_CHAPTER_MAX_CHARS = 6000;

export interface PreviousChapter {
  order: number;
  title: string;
  content: string;
  /** 因超长被截断（只保留结尾） */
  truncated: boolean;
  /** 故事内时间（如「第 3 日」）；没记过就是 undefined —— 水车第三层时间戳靠它 */
  storyTime?: string;
}

/**
 * 读取「上一章全文」—— 架构 §7 的强制注入项之一。
 *
 * 为什么必须**强制注入**而不是让 agent 自己去读：只给「第 N 章 · M 字 · 摘要」的清单时，
 * 模型不知道上一章的文风、语气、结尾钩子的具体写法，所谓「接着写」会写成另一本书。
 * 2026-09-12 实测：这是跨章连续性最缺的一块（此前只注入了 digest 摘要）。
 *
 * 取章规则（两处调用方语义不同，别混）：
 *   · 传了 beforeOrder → 取 order **小于**它的最新一章（写第 3 章时给第 2 章）
 *   · 没传 → 取库中最新一章（作者没指定章号时，「上一章」= 最后交付的那一章）
 * 超长时保留**结尾**并标注 —— 结尾那一刻的处境才是衔接点。
 */
export async function resolvePreviousChapter(
  ctx: ServerPluginContext,
  projectId: string,
  beforeOrder?: number,
  maxChars: number = PREV_CHAPTER_MAX_CHARS,
): Promise<PreviousChapter | null> {
  const db = ctx.db.project(projectId) as DrizzleDb;
  const scope = eq(schema.chapters.projectId, projectId);
  const alive = isNull(schema.chapters.deletedAt);
  const rows = await db
    .select({
      order: schema.chapters.order, title: schema.chapters.title, content: schema.chapters.content,
      storyTime: schema.chapters.storyTime,
    })
    .from(schema.chapters)
    .where(
      beforeOrder != null
        ? and(scope, alive, lt(schema.chapters.order, beforeOrder))
        : and(scope, alive),
    )
    .orderBy(desc(schema.chapters.order))
    .limit(1);

  const row = rows[0];
  const content = String(row?.content ?? '').trim();
  if (!row || !content) return null;
  const storyTime = row.storyTime ? String(row.storyTime) : undefined;
  if (content.length <= maxChars) {
    return { order: row.order, title: String(row.title ?? ''), content, truncated: false, storyTime };
  }
  return {
    order: row.order,
    title: String(row.title ?? ''),
    content: `（上一章原文过长，此处只保留结尾 ${maxChars} 字）\n…${content.slice(-maxChars)}`,
    truncated: true,
    storyTime,
  };
}

/** 故事内时间的抽取（定稿官契约里常写成「故事内时间：第 3 日」这一行） */
const STORY_TIME_RE = /(?:故事内时间|故事时间|时间线)[：:]\s*([^\n，。]{1,40})/;

/** 纯函数：从契约文本里抽故事内时间；抽不到返回 null（**不猜** —— 猜错比没有更坏） */
export function extractStoryTime(conclusion: string): string | null {
  const m = STORY_TIME_RE.exec(conclusion ?? '');
  return m?.[1]?.trim() || null;
}

/**
 * 从定稿官的契约里抽出「故事内时间」并写进该章。
 *
 * 为什么要有它：章号与故事时间**不是一回事** —— 一章可能写三天，也可能一天写五章。
 * 没有它，后面的角色只能按"上上章"推断时序，跳跃叙事必错（水车的第三层时间戳）。
 * 抽不到就留 null，**不猜**（猜错比没有更坏）。
 */
export async function persistChapterStoryTime(
  ctx: ServerPluginContext,
  projectId: string,
  order: number,
  conclusion: string,
): Promise<string | null> {
  const storyTime = extractStoryTime(conclusion);
  if (!storyTime) return null;
  try {
    const db = ctx.db.project(projectId) as DrizzleDb;
    await db.update(schema.chapters)
      .set({ storyTime })
      .where(and(eq(schema.chapters.projectId, projectId), eq(schema.chapters.order, order)));
    return storyTime;
  } catch (e) {
    console.warn('[context] 写入故事内时间失败（不影响交付）:', e);
    return null;
  }
}
