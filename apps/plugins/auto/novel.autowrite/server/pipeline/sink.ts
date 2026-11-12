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
import { STAGE_LABEL, type SinkStats, type StageKey } from './types.js';

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
      "belief": "信念，一句话",
      "weakness": "致命弱点，一句话",
      "appearance": "外貌，一句话",
      "personality": "性格，一句话",
      "speechStyle": "说话风格，一句话",
      "backstory": "背景，一句话",
      "aliases": ["别名"],
      "relations": [{ "target": "对方名字", "type": "关系类型", "description": "关系里最要紧的那点张力" }]
    }
  ],
  "notes": ["抽取中发现的不确定项"]
}

规则：
- 只抽文本里**明确写了**的；没写就留空字符串，不要推测
- 主角是 protagonist，女主是 femaleLead，其余按文本判断
- name 必须原样照抄
- relations 的 target 必须是文本里出现过的名字；关系没写就不给这条`;

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

interface RawRelation { target?: unknown; type?: unknown; description?: unknown }

/**
 * 角色抽取的**原始行**（字段全是 unknown —— 模型返回什么都有可能）。
 * ★ 2026-11-07：对外导出。`enrichCastProfiles` 的入参就是 `RawChar[]`，
 *   不导出该类型，调用方连自己的输入都没法标注（`sink.test.ts` 即撞在此处）。
 */
export interface RawChar {
  name?: unknown; role?: unknown; desire?: unknown; fear?: unknown;
  belief?: unknown; weakness?: unknown; appearance?: unknown;
  personality?: unknown; speechStyle?: unknown; backstory?: unknown; aliases?: unknown;
  relations?: RawRelation[];
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
          /**
           * ★ 2026-10-26：**任务行放在最前**（与 gates.ts 同一口径）。
           *
           * 这里的 system（`EXTRACT_SYSTEM_*`）第一句已经是"你是数据抽取器。把《…》抽成 JSON"，
           * 任务其实不缺 —— 但 user 消息只有素材、没有一句"现在做这件事"，
           * 模型仍可能在长文本后转入"等你指令"模式。补一行任务与 gates 保持一致，
           * 让"任务在最前、素材在中、契约在最后"这条结构在三处统一。
           */
          `【本轮任务】从下面的「${STAGE_LABEL[opts.stage]}」产出里抽取结构化数据，`
            + '只输出 JSON（按 system 里给的结构），不要评论、不要解释。',
          '',
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

// ============================================================
// 角色档案补全（cast 段专用）
//
// ★ 为什么"抽取"还不够（2026-11-07：作者反馈「角色详细内容不够详细」）：
//   《角色与节奏宪章》本身是 200–400 字的共识稿，定稿官只记「欲望 / 恐惧 / 关系演变 / 退场点」，
//   抽取器又只能照抄文本里写了的 —— 于是落进知识库的角色档案每条只有一句话；
//   `appearance` / `belief` / `weakness` 三列**从来没被写过**（DB 有列，抽取器不产出，sink 也不写）。
//   作者点开角色看到的是一张空表，写作官拿到的也只有五个短句。
//
//   所以 cast 落库多一步"档案补全"：一次调用，把骨架扩写成能照着写的详细档案。
//   与抽取的分工：抽取是"文本里有什么写什么"；补全是"宪章没细写的，按已批准设定补足"。
//   因此它**允许推断细节**，但硬约束是不改姓名/定位、不推翻宪章里写死的关系与弧光。
// ============================================================

/**
 * 一次补全最多覆盖多少个角色。
 * 预算账：单个角色约 600–700 字 + JSON 键 ≈ 800 token，8 位 ≈ 6.4k；
 * 推理模型的思考 token 也计入 `maxTokens`（实测 5k 上下），16384 才够用。
 * 全员补全在几十人的项目里必然截断，而截断 = 整份 JSON 作废。
 */
const ENRICH_MAX_CHARS = 8;

const ENRICH_SYSTEM = `你是「角色档案师」，负责把《角色与节奏宪章》里的人物补全成**可以直接照着写**的详细档案。

给你：作者的开书设定、已批准的角色宪章、以及从宪章里抽出的角色骨架（可能每个字段只有一句话）。
你的活：为名单里的每个角色写一份有细节、能落到笔下的档案。

写什么：
1. 外貌：1–2 个**能被记住**的具体特征（旧外套、说话前的停顿、左手小指伸不直），不要"眉清目秀"
2. 性格：表层表现 + 内里的矛盾 + 一个具体的习惯动作
3. 欲望 / 恐惧 / 信念 / 致命弱点：各写清"从哪来、会怎么影响他的选择"
4. 说话风格：句长、用词、称呼习惯，并**给 2 句他真会说的话**
5. 背景：与当前故事**直接相关**的往事，最多三件
6. 关系：只写有张力的（谁要什么、谁欠谁、谁在防谁）；target 必须是名单里的名字，或开书设定里明确出现的人名

硬规则（违反则整份作废）：
- 姓名、角色定位、宪章里写死的关系与弧光**一律不许改**；宪章与开书设定冲突时以开书设定为准
- 不要写剧情推进，不要写"伏笔 / 回收 / 作者 / 读者 / 本章"这类元语言
- 名单里的每个角色都要有输出，没给到的角色不要自己加
- 只输出 JSON，不要评论、不要解释

严格输出这个结构：
{
  "characters": [
    {
      "name": "必须与名单完全一致",
      "appearance": "40–80 字",
      "personality": "80–150 字",
      "desire": "30–60 字",
      "fear": "30–60 字",
      "belief": "30–60 字",
      "weakness": "30–60 字",
      "speechStyle": "40–80 字，含两句示例台词",
      "backstory": "100–200 字",
      "relations": [{ "target": "名单里的名字", "type": "关系类型", "description": "20–50 字，写张力不写履历" }]
    }
  ]
}`;

/** 补全字段（顺序即拼骨架时的展示顺序） */
const PROFILE_KEYS = [
  'desire', 'fear', 'belief', 'weakness',
  'appearance', 'personality', 'speechStyle', 'backstory',
] as const;

/** 只补全值得花预算的角色：主角 / 女主 / 配角优先，路人甲靠抽取的骨架就够 */
function enrichRank(v: unknown): number {
  const s = str(v);
  if (s === 'protagonist') return 0;
  if (s === 'femaleLead') return 1;
  if (s === 'supporting') return 2;
  return 3;
}

export interface EnrichCastResult {
  /** 补全后的角色骨架（补全失败时原样返回） */
  rows: RawChar[];
  /** 失败/降级说明（成功时为空） */
  note?: string;
}

/**
 * 把 cast 段抽出的角色骨架扩写成详细档案。
 *
 * **不抛错**：补全是锦上添花，失败时骨架照常落库（与 sink 的总体取向一致）。
 */
export async function enrichCastProfiles(
  ctx: ServerPluginContext,
  opts: { artifact: string; briefText: string; rows: RawChar[]; userId?: string },
): Promise<EnrichCastResult> {
  if (opts.rows.length === 0) return { rows: opts.rows };

  const picked = [...opts.rows]
    .sort((a, b) => enrichRank(a.role) - enrichRank(b.role))
    .slice(0, ENRICH_MAX_CHARS);
  const skeleton = picked.map((c, i) => {
    const profile = c as unknown as Record<string, unknown>;
    const fields = PROFILE_KEYS
      .map((k) => `${k}=${str(profile[k]) ?? '（空）'}`)
      .join('｜');
    return `${i + 1}. ${str(c.name) ?? '（无名）'}｜${str(c.role) ?? 'supporting'}｜${fields}`;
  });

  const trimNote = opts.rows.length > picked.length
    ? `（本次补全前 ${picked.length} 位；其余 ${opts.rows.length - picked.length} 位只落骨架）`
    : '';

  let raw: string;
  try {
    raw = await ctx.ai.complete({
      messages: [
        { role: 'system', content: ENRICH_SYSTEM },
        {
          role: 'user',
          content: [
            '【本轮任务】为下面名单里的每个角色补全详细档案，只输出 JSON（按 system 里给的结构）。',
            '',
            opts.briefText ? `【作者的开书设定】\n${opts.briefText}\n` : '',
            `【已批准的《角色与节奏宪章》】\n${opts.artifact}\n`,
            `【要补全的角色名单（骨架）】${trimNote}\n${skeleton.join('\n')}`,
          ].filter(Boolean).join('\n'),
        },
      ],
      json: true,
      maxTokens: EXTRACT_MAX_TOKENS,
      // 补全要写细节，0.1 会写成模板句；但仍需贴着宪章，所以不给更高
      temperature: 0.6,
      userId: opts.userId,
    });
  } catch (e) {
    return {
      rows: opts.rows,
      note: `角色档案补全失败（骨架已照常落库）：${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let parsed: { characters?: RawChar[] } | null = null;
  try {
    parsed = parseJsonLoose<{ characters?: RawChar[] }>(raw);
  } catch (e) {
    console.warn('[pipeline] 角色档案补全解析失败:', e instanceof Error ? e.message : e);
    console.warn(`[pipeline] 原始输出前 200 字：${raw.slice(0, 200)}`);
    return { rows: opts.rows, note: '角色档案补全返回的不是合法 JSON（骨架已照常落库）' };
  }

  const enriched = asArray(parsed?.characters);
  if (enriched.length === 0) {
    return { rows: opts.rows, note: '角色档案补全结果为空（骨架已照常落库）' };
  }

  const byName = new Map<string, RawChar>();
  for (const r of opts.rows) {
    const n = str(r.name);
    if (n) byName.set(n, r);
  }

  let filled = 0;
  for (const e of enriched) {
    const name = str(e?.name);
    if (!name) continue;
    const target = byName.get(name);
    // 名单外的名字一律丢弃（模型不得凭空造角色）
    if (!target) continue;
    for (const k of PROFILE_KEYS) {
      const v = str((e as unknown as Record<string, unknown>)[k]);
      if (!v) continue;
      (target as unknown as Record<string, unknown>)[k] = v;
      filled++;
    }
    if (Array.isArray(e.relations) && e.relations.length > 0) target.relations = e.relations;
  }

  if (filled === 0) {
    return { rows: opts.rows, note: '角色档案补全没有产出可用字段（骨架已照常落库）' };
  }
  return { rows: opts.rows };
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
    /**
     * ★ 补全在落库**之前**做（2026-11-07）：upsert 的语义是"只补空字段"，
     *   如果先按一句话骨架写进去，补全结果就永远进不了新建的行。
     *   补全失败时 rows 原样返回，骨架照常落库。
     */
    const enriched = await enrichCastProfiles(ctx, {
      artifact: input.artifact,
      briefText: input.briefText,
      rows: asArray(extracted.characters),
      userId: input.userId,
    });
    if (enriched.note) stats.notes.push(enriched.note);
    await upsertCharacters(db, input.projectId, enriched.rows, stats);
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

/** 关系列的 JSON 形状（与 @novel/shared 的 CharacterRelation 一致） */
interface RelationJson {
  targetId: string;
  type: string;
  description?: string;
  chapter?: number | null;
  direction: 'from' | 'to' | 'mutual';
}

function parseRelations(raw: unknown): RelationJson[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((r): r is RelationJson =>
      !!r && typeof r === 'object'
      && typeof (r as RelationJson).targetId === 'string'
      && typeof (r as RelationJson).type === 'string');
  } catch {
    return [];
  }
}

/** 角色：按**精确名称**匹配，存在就只补空字段（绝不覆盖作者写过的内容） */
async function upsertCharacters(
  db: DrizzleDb,
  projectId: string,
  rows: RawChar[],
  stats: SinkStats,
): Promise<void> {
  /**
   * ★ 2026-10-29 修（审计确认）：**空结果要如实报**，不能静默"成功"。
   *
   * 原实现 `if (rows.length === 0) return;` —— 于是一个**合法但为空**的 JSON
   * （模型抽到 0 条角色）会让 `sinkStats.notes` 为空 ⇒ 编排层判 `sinked = true`
   * ⇒ 界面显示"已落库"，实际一条没写。
   * bible 段早有这个空检查（见 upsertBible），cast/plot 漏了 —— 补齐，口径一致。
   */
  if (rows.length === 0) {
    stats.notes.push('角色抽取结果为空，未写入任何角色条目');
    return;
  }
  const existing = await db
    .select({
      id: schema.characters.id,
      name: schema.characters.name,
      role: schema.characters.role,
      desire: schema.characters.desire,
      fear: schema.characters.fear,
      belief: schema.characters.belief,
      weakness: schema.characters.weakness,
      appearance: schema.characters.appearance,
      personality: schema.characters.personality,
      speechStyle: schema.characters.speechStyle,
      backstory: schema.characters.backstory,
      relations: schema.characters.relations,
      tags: schema.characters.tags,
    })
    .from(schema.characters)
    .where(eq(schema.characters.projectId, projectId));

  const byName = new Map(existing.map((r) => [r.name, r]));
  /** 名称 → id（含本轮新建的）：关系解析要用它把「对方名字」换成 targetId */
  const nameToId = new Map(existing.map((r) => [r.name, r.id]));
  const relByChar = new Map(existing.map((r) => [r.name, parseRelations(r.relations)]));
  /** 本轮新建的角色名：关系补写不再重复记一次 updated */
  const created = new Set<string>();
  const now = new Date();

  for (const c of rows) {
    const name = usableName(c.name);
    if (!name) {
      stats.skipped++;
      continue;
    }
    const role = mapCharRole(c.role);
    /**
     * ★ 2026-11-07：补全后的档案要**八列全写**。
     *   此前只写 desire/fear/personality/speechStyle/backstory 五列，
     *   `belief` / `weakness` / `appearance` 三列在 DB 里存在却永远为空 ——
     *   作者在详情页看到的就是"这角色没写多少东西"。
     */
    const patch = {
      desire: str(c.desire),
      fear: str(c.fear),
      belief: str(c.belief),
      weakness: str(c.weakness),
      appearance: str(c.appearance),
      personality: str(c.personality),
      speechStyle: str(c.speechStyle),
      backstory: str(c.backstory),
    };
    const hit = byName.get(name);
    if (hit) {
      /**
       * 只补空：作者已经写过的字段一个都不动。
       *
       * ★ 2026-11-07 加一条**受限升级**：老项目里的角色是上一版 sink 写的，
       *   五个字段都只有一句话（非空）—— 按"只补空"的规则，补全结果永远写不进去，
       *   作者重跑 cast 也看不到改善。所以对**流水线自己创建**的行
       *   （tags 含 `pipeline:cast`），允许用补全结果替换**明显是一句话**的旧值
       *   （≤40 字且新值至少长 10 字）。作者写过的长文本不会被碰。
       */
      const isPipelineRow = typeof hit.tags === 'string' && hit.tags.includes('pipeline:cast');
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (!v) continue;
        const cur = (hit as Record<string, unknown>)[k];
        if (!cur) {
          set[k] = v;
          continue;
        }
        if (isPipelineRow && typeof cur === 'string'
          && cur.trim().length <= 40 && v.length > cur.trim().length + 10) {
          set[k] = v;
        }
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
    const id = randomUUID();
    await db.insert(schema.characters).values({
      id,
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
    nameToId.set(name, id);
    relByChar.set(name, []);
    created.add(name);
    stats.characters.created++;
  }

  /**
   * ★ 关系放在**第二轮**写（2026-11-07）：第一轮结束时所有角色 id 才齐，
   *   否则「A → 排在后面的 B」会因为 B 还没插入而解析不到 targetId。
   *   解析不到的（名单外的人名、单字名）直接丢弃 —— 不猜、不新建。
   */
  for (const c of rows) {
    const name = usableName(c.name);
    if (!name) continue;
    const id = nameToId.get(name);
    if (!id) continue;
    const list = relByChar.get(name) ?? [];
    let changed = false;
    for (const raw of asArray(c.relations)) {
      const targetName = str(raw?.target);
      if (!targetName) continue;
      const targetId = nameToId.get(targetName);
      if (!targetId || targetId === id) continue;
      const type = str(raw.type) ?? '关联';
      // 幂等：同一对 (targetId, type) 只留一条
      if (list.some((x) => x.targetId === targetId && x.type === type)) continue;
      list.push({
        targetId,
        type,
        ...(str(raw.description) ? { description: str(raw.description) } : {}),
        direction: 'mutual',
        chapter: null,
      });
      changed = true;
    }
    if (!changed) continue;
    await db.update(schema.characters)
      .set({ relations: JSON.stringify(list), updatedAt: now })
      .where(eq(schema.characters.id, id));
    if (!created.has(name)) stats.characters.updated++;
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

  /**
   * ★ 2026-10-29：剧情总纲同理 —— 幕与章都为空时如实报（口径同 bible / cast）。
   */
  if (acts.length === 0 && chapters.length === 0 && asArray(extracted.foreshadows).length === 0) {
    stats.notes.push('剧情总纲抽取结果为空，未写入任何大纲条目');
  }

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
