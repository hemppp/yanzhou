// ============================================================
// 阶段产出物落库（保守 upsert）
//
// 流程：定稿官的**契约文本**（人读）→ 一次 json 抽取调用 → 结构化记录 → 写项目库。
//
// 为什么不能直接把契约文本解析进库：契约是给人读的散文式清单（「主角弧光：…」），
// 格式稳定但语义自由，正则解析必然碎在第一个不听话的输出上。现有 entity-sink 的做法
// （一次 `ai.complete({json:true})` 再保守 upsert）已经验证过，这里沿用同一套思路。
//
// ★ 三条铁律（都有实测教训）：
//   1. **只在闸门 approve 之后落库** —— 被作者否掉的东西不该进库
//   2. **保守**：只新增、只补空字段，绝不覆盖作者已经写过/改过的内容
//   3. **匹配只用精确名称**（「周」≠「周粥」），按 (type,title) / (name) 去重保证幂等
// ============================================================

import { randomUUID } from 'node:crypto';
import type { ServerPluginContext } from '@novel/core';
import { schema, eq, getProjectDb, type DrizzleDb } from '@novel/db';
import { parseJsonLoose } from '../framework/text.js';
import { usableName } from '../framework/entity-sink.js';
import { STAGE_SPEAK_MAX_TOKENS } from './roles-phase.js';
import type { SinkStats, StageKey } from './types.js';

/** 抽取上限：实体多时 JSON 会很长，给不足会被截断（截断 = 静默出错） */
const EXTRACT_MAX_TOKENS = STAGE_SPEAK_MAX_TOKENS;

// ---- 抽取提示词 ----

const EXTRACT_SYSTEM_CAST = `你是数据抽取器。把《角色与节奏宪章》里的信息抽成 JSON，不要评论、不要解释。

严格输出这个结构：
{
  "characters": [
    {
      "name": "角色名（必须与文本一致，不得改写）",
      "role": "protagonist | femaleLead | supporting | minor",
      "desire": "欲望，一句话",
      "fear": "恐惧，一句话",
      "personality": "性格，一句话",
      "speechStyle": "说话风格，一句话",
      "backstory": "背景，一句话",
      "aliases": ["别名"]
    }
  ],
  "notes": ["抽取中发现的不确定项"]
}

规则：
- 只抽文本里**明确写了**的；没写就留空字符串，不要推测
- 主角是 protagonist，女主是 femaleLead，其余按文本判断
- name 必须原样照抄`;

const EXTRACT_SYSTEM_BIBLE = `你是数据抽取器。把《世界圣经》抽成 JSON，不要评论、不要解释。

严格输出这个结构：
{
  "world":    [{ "title": "世界观总条", "description": "完整描述" }],
  "factions": [{ "name": "势力名", "description": "诉求 / 资源 / 与其他势力的关系" }],
  "powers":   [{ "name": "体系或等级名", "description": "机制、代价与上限" }],
  "places":   [{ "name": "地点名", "description": "描述与资源特征" }],
  "notes":    ["不确定项"]
}

规则：
- 只抽文本里**明确写了**的；势力至少要有名字，没名字的条目不输出
- name / title 必须原样照抄`;

const EXTRACT_SYSTEM_PLOT = `你是数据抽取器。把《剧情总纲》抽成 JSON，不要评论、不要解释。

严格输出这个结构：
{
  "acts": [
    { "title": "幕名", "description": "功能与张力说明", "from": 1, "to": 12 }
  ],
  "chapters": [
    { "title": "章节标题（没写标题就用「第N章」的形式）", "order": 1, "description": "这一章要发生什么", "tension": 7, "act": "所属幕名" }
  ],
  "foreshadows": [
    { "description": "伏笔内容", "type": "identity|motivation|relation|trauma|turning|fate",
      "seedChapter": 3, "payoffChapter": 18 }
  ],
  "notes": ["不确定项"]
}

规则：
- 只抽文本里**明确写了**的章号与内容，不要替作者补章
- tension 取文本里的张力值（1–10 的整数）；没写就省略该字段
- payoffChapter 没写回收章就填 0`;

const EXTRACT_SYSTEM: Partial<Record<StageKey, string>> = {
  cast: EXTRACT_SYSTEM_CAST,
  bible: EXTRACT_SYSTEM_BIBLE,
  plot: EXTRACT_SYSTEM_PLOT,
};

export function extractSystemFor(stage: StageKey): string | undefined {
  return EXTRACT_SYSTEM[stage];
}

// ---- 抽取 ----

interface RawChar {
  name?: unknown; role?: unknown; desire?: unknown; fear?: unknown;
  personality?: unknown; speechStyle?: unknown; backstory?: unknown; aliases?: unknown;
}
interface RawNote { title?: unknown; description?: unknown }
interface RawNamed { name?: unknown; description?: unknown }
interface RawAct { title?: unknown; description?: unknown; from?: unknown; to?: unknown }
interface RawChapter { title?: unknown; order?: unknown; description?: unknown; tension?: unknown; act?: unknown }
interface RawForeshadow {
  description?: unknown; type?: unknown; seedChapter?: unknown; payoffChapter?: unknown;
}

interface StageExtract {
  characters?: RawChar[];
  world?: RawNote[];
  factions?: RawNamed[];
  powers?: RawNamed[];
  places?: RawNamed[];
  acts?: RawAct[];
  chapters?: RawChapter[];
  foreshadows?: RawForeshadow[];
  notes?: unknown[];
}

function asArray<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 枚举白名单：模型的自由发挥一律落回安全值（枚举全英文，schema 里的中文注释会骗人） */
const CHAR_ROLES = ['protagonist', 'femaleLead', 'supporting', 'minor'] as const;
const FSH_TYPES = ['identity', 'motivation', 'relation', 'trauma', 'turning', 'fate'] as const;

function mapCharRole(v: unknown): string {
  const s = str(v);
  if (s && (CHAR_ROLES as readonly string[]).includes(s)) return s;
  return 'supporting';
}

function mapFshType(v: unknown): string {
  const s = str(v);
  if (s && (FSH_TYPES as readonly string[]).includes(s)) return s;
  return 'motivation';
}

/**
 * 抽取一次。
 * 解析失败**返回 null 而不是空对象** —— 静默返回空对象会让上层以为"库里确实没东西"，
 * 这正是校对门曾经变成摆设的原因（JSON 被截断 → 解析失败 → 被 catch 成 null → 调用方跳过）。
 */
export async function extractStageArtifact(
  ctx: ServerPluginContext,
  opts: { stage: StageKey; artifact: string; briefText: string; userId?: string },
): Promise<StageExtract | null> {
  const system = extractSystemFor(opts.stage);
  if (!system) return null;
  const raw = await ctx.ai.complete({
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          opts.briefText ? `【作者的开书设定（用于判断角色定位，不要据此新增内容）】\n${opts.briefText}\n` : '',
          `【待抽取的文本】\n${opts.artifact}`,
        ].filter(Boolean).join('\n'),
      },
    ],
    json: true,
    maxTokens: EXTRACT_MAX_TOKENS,
    userId: opts.userId,
  });
  // ★ parseJsonLoose **会抛**（找不到 JSON 对象/解析失败），不是返回 undefined ——
  //   必须显式接住：不接的话异常会往上冒，调用方稍不留神就把它当成"这次没东西要落库"。
  let parsed: StageExtract | null = null;
  try {
    parsed = parseJsonLoose<StageExtract>(raw);
  } catch (e) {
    console.warn(`[pipeline] 阶段 ${opts.stage} 的结构化抽取解析失败:`, e instanceof Error ? e.message : e);
    console.warn(`[pipeline] 原始输出前 200 字：${raw.slice(0, 200)}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[pipeline] 阶段 ${opts.stage} 抽取结果不是对象（返回 ${raw.length} 字符）`);
    return null;
  }
  return parsed;
}

// ---- 落库 ----

export interface SinkInput {
  projectId: string;
  stage: StageKey;
  artifact: string;
  /** 开书设定的格式化文本（判断题干用） */
  briefText: string;
  userId?: string;
}

export async function sinkStageArtifact(
  ctx: ServerPluginContext,
  input: SinkInput,
): Promise<SinkStats> {
  const stats: SinkStats = {
    characters: { created: 0, updated: 0 },
    outline: 0,
    foreshadows: 0,
    skipped: 0,
    notes: [],
  };

  // ★ 全新项目库在首次写入前是不存在的，`ctx.db.project()` 会返回 null
  try {
    await getProjectDb(input.projectId);
  } catch (e) {
    console.warn('[pipeline] 打开项目库失败（按空库处理）:', e);
  }

  const extracted = await extractStageArtifact(ctx, {
    stage: input.stage,
    artifact: input.artifact,
    briefText: input.briefText,
    userId: input.userId,
  });
  if (!extracted) {
    // 抽取失败要把话说清楚，别让作者以为"落库成功了但库里没有"
    stats.notes.push('结构化抽取失败（模型输出不是合法 JSON），本次未落库；契约文本已保留在工作台，可重试本阶段');
    return stats;
  }

  const db = ctx.db.project(input.projectId) as DrizzleDb | null;
  if (!db) {
    stats.notes.push('项目库不可用，本次未落库');
    return stats;
  }

  if (input.stage === 'cast') {
    await upsertCharacters(db, input.projectId, asArray(extracted.characters), stats);
  } else if (input.stage === 'bible') {
    await upsertBible(db, input.projectId, extracted, stats);
  } else if (input.stage === 'plot') {
    await upsertPlot(db, input.projectId, extracted, stats);
  }

  for (const n of asArray(extracted.notes)) {
    const s = str(n);
    if (s) stats.notes.push(s);
  }
  return stats;
}

/** 角色：按**精确名称**匹配，存在就只补空字段（绝不覆盖作者写过的内容） */
async function upsertCharacters(
  db: DrizzleDb,
  projectId: string,
  rows: RawChar[],
  stats: SinkStats,
): Promise<void> {
  if (rows.length === 0) return;
  const existing = await db
    .select({
      id: schema.characters.id,
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

  const byName = new Map(existing.map((r) => [r.name, r]));
  const now = new Date();

  for (const c of rows) {
    const name = usableName(c.name);
    if (!name) {
      stats.skipped++;
      continue;
    }
    const role = mapCharRole(c.role);
    const patch = {
      desire: str(c.desire),
      fear: str(c.fear),
      personality: str(c.personality),
      speechStyle: str(c.speechStyle),
      backstory: str(c.backstory),
    };
    const hit = byName.get(name);
    if (hit) {
      // 只补空：作者已经写过的字段一个都不动
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v && !(hit as Record<string, unknown>)[k]) set[k] = v;
      }
      if (!hit.role) set.role = role;
      if (Object.keys(set).length > 0) {
        set.updatedAt = now;
        await db.update(schema.characters).set(set).where(eq(schema.characters.id, hit.id));
        stats.characters.updated++;
      } else {
        stats.skipped++;
      }
      continue;
    }
    const aliases = asArray(c.aliases as unknown[]).map((a) => str(a)).filter((a): a is string => !!a);
    await db.insert(schema.characters).values({
      id: randomUUID(),
      projectId,
      name,
      role,
      ...patch,
      aliases: aliases.length ? JSON.stringify(aliases) : null,
      states: JSON.stringify([]),
      relations: JSON.stringify([]),
      chapters: JSON.stringify([]),
      tags: JSON.stringify(['pipeline:cast']),
      createdAt: now,
      updatedAt: now,
    });
    stats.characters.created++;
  }
}

/** 大纲节点：按 (type,title) 去重，幂等 */
async function upsertOutlineNode(
  db: DrizzleDb,
  projectId: string,
  rows: Array<{ type: string; title: string; description?: string; tags?: string[]; parentId?: string; orderHint?: number }>,
  stats: SinkStats,
): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  const existing = await db
    .select({ id: schema.outlineNodes.id, type: schema.outlineNodes.type, title: schema.outlineNodes.title })
    .from(schema.outlineNodes)
    .where(eq(schema.outlineNodes.projectId, projectId));
  const seen = new Map(existing.map((r) => [`${r.type}::${r.title}`, r.id]));
  const now = new Date();
  const out = new Map<string, string>();

  for (const [i, r] of rows.entries()) {
    const key = `${r.type}::${r.title}`;
    const hit = seen.get(key);
    if (hit) {
      out.set(key, hit);
      stats.skipped++;
      continue;
    }
    const id = randomUUID();
    await db.insert(schema.outlineNodes).values({
      id,
      projectId,
      parentId: r.parentId ?? null,
      type: r.type,
      title: r.title,
      description: r.description ?? null,
      order: r.orderHint ?? i,
      linkedChapterIds: JSON.stringify([]),
      tags: JSON.stringify(r.tags ?? []),
      createdAt: now,
      updatedAt: now,
    });
    seen.set(key, id);
    out.set(key, id);
    stats.outline++;
  }
  return out;
}

async function upsertBible(
  db: DrizzleDb,
  projectId: string,
  extracted: StageExtract,
  stats: SinkStats,
): Promise<void> {
  const world = asArray(extracted.world).flatMap((w) => {
    const title = str(w.title);
    if (!title) return [];
    return [{ type: 'note', title, description: str(w.description), tags: ['bible:world'] }];
  });
  const factions = asArray(extracted.factions).flatMap((f) => {
    const title = str(f.name);
    if (!title) return [];
    return [{ type: 'note', title, description: str(f.description), tags: ['bible:faction'] }];
  });
  const powers = asArray(extracted.powers).flatMap((p) => {
    const title = str(p.name);
    if (!title) return [];
    return [{ type: 'note', title, description: str(p.description), tags: ['bible:power'] }];
  });
  const places = asArray(extracted.places).flatMap((p) => {
    const title = str(p.name);
    if (!title) return [];
    return [{ type: 'note', title, description: str(p.description), tags: ['bible:place'] }];
  });
  if (factions.length === 0 && powers.length === 0 && world.length === 0 && places.length === 0) {
    stats.notes.push('世界圣经抽取结果为空，未写入任何设定条目');
    return;
  }
  await upsertOutlineNode(db, projectId, [...world, ...factions, ...powers, ...places], stats);
}

async function upsertPlot(
  db: DrizzleDb,
  projectId: string,
  extracted: StageExtract,
  stats: SinkStats,
): Promise<void> {
  // 1) 幕（先建，好让章节挂上去）
  const acts = asArray(extracted.acts).flatMap((a) => {
    const title = str(a.title);
    if (!title) return [];
    const from = num(a.from);
    const to = num(a.to);
    const span = from && to ? `（第 ${from}–${to} 章）` : '';
    return [{ type: 'act', title, description: `${span}${str(a.description) ?? ''}`, tags: ['pipeline:plot'] }];
  });
  const actIds = await upsertOutlineNode(db, projectId, acts, stats);

  // 2) 章（挂到所属幕下；张力值并进描述，outline_nodes 没有数值列）
  const chapters = asArray(extracted.chapters).flatMap((c) => {
    const title = str(c.title);
    if (!title) return [];
    const tension = num(c.tension);
    const desc = [str(c.description) ?? '', tension ? `（张力 ${tension}/10）` : ''].join('');
    const actName = str(c.act);
    const parentId = actName ? actIds.get(`act::${actName}`) : undefined;
    const order = num(c.order);
    return [{
      type: 'chapter' as const,
      title,
      description: desc || undefined,
      tags: ['pipeline:plot'],
      parentId,
      orderHint: order != null ? order : undefined,
    }];
  });
  await upsertOutlineNode(db, projectId, chapters, stats);

  // 3) 伏笔
  const fsh = asArray(extracted.foreshadows);
  if (fsh.length > 0) {
    const existing = await db
      .select({ id: schema.foreshadows.id, description: schema.foreshadows.description })
      .from(schema.foreshadows)
      .where(eq(schema.foreshadows.projectId, projectId));
    const seen = new Set(existing.map((r) => r.description));
    const now = new Date();
    for (const f of fsh) {
      const description = str(f.description);
      if (!description) {
        stats.skipped++;
        continue;
      }
      if (seen.has(description)) {
        stats.skipped++;
        continue;
      }
      const seed = num(f.seedChapter) ?? 1;
      const payoff = num(f.payoffChapter);
      await db.insert(schema.foreshadows).values({
        id: randomUUID(),
        projectId,
        description,
        type: mapFshType(f.type),
        status: 'planted',
        seedChapter: seed,
        payoffChapter: payoff && payoff > 0 ? payoff : null,
        relatedCharacters: JSON.stringify([]),
        relatedItems: JSON.stringify([]),
        relatedEvents: JSON.stringify([]),
        earmarks: JSON.stringify([]),
        tags: JSON.stringify(['pipeline:plot']),
        createdAt: now,
        updatedAt: now,
      });
      seen.add(description);
      stats.foreshadows++;
    }
  }
}
