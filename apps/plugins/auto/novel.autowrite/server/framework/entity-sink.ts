// ============================================================
// 实体沉淀 —— 一章**交付成功之后**，把本章新出现/变动的设定写进项目库
//
// 为什么需要它（2026-09-12 实测 P1）：
//   抽取能力在服务端（apps/server 的 entity-extract-agent / scanner-agent），
//   但**落库与去重启发式一直由前端做**（useAutoEntityDetection）。
//   自动写作编排器跑在服务端、前端不在环里 —— 于是交付只写了 chapters，
//   角色/物品/地点/伏笔一张表都没写。下一章的设定管家看到的仍是「暂无角色设定」，
//   跨章记忆只沉淀了正文，没有沉淀结构化实体。
//
// 落库原则（保守，绝不破坏既有数据）：
//   · 只增不删、只追加不覆盖；命中既有实体时只补章号与状态流水
//   · **精确名称匹配，绝不子串匹配** —— 前端踩过「周」与「周粥」被并成一个角色的坑
//   · 失败一律非致命：交付已经成功，沉淀失败不能反过来废掉章节
//
// 幂等：同一章重复沉淀时，chapters 数组与 states 流水都按内容去重。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { schema, eq, type DrizzleDb } from '@novel/db';
import { nowId, parseJsonLoose } from './text.js';
import { detectBatchConflicts, recordConflicts, type FactWrite } from './memory/ingest.js';

// ---- 存储结构（JSON 文本列的形状） ----
// 与 @novel/shared 的 EntityState / ItemHolder 一致；插件不依赖 shared 包，
// 故在此本地声明。改这两处形状时必须同步 packages/shared/src/index.ts。

interface EntityStateJson {
  chapter: number;
  field: string;
  oldValue?: string;
  newValue: string;
  description?: string;
}

interface ItemHolderJson {
  characterId: string;
  chapter: number;
  action: 'gained' | 'lost' | 'transferred' | 'held';
}

/** 伏笔状态/类型：与 @novel/shared 的 ForeshadowStatus / ForeshadowType 对齐（英文枚举） */
type ForeshadowStatusJson = 'planted' | 'hinted' | 'payed_off' | 'abandoned';
type ForeshadowTypeJson = 'identity' | 'motivation' | 'relation' | 'trauma' | 'turning' | 'fate';

// ---- 模型抽取结果 ----

interface RawChange { field?: string; oldValue?: string; newValue?: string; description?: string }
interface RawCharacter {
  name?: string; role?: string; desire?: string; fear?: string;
  personality?: string; speechStyle?: string; backstory?: string;
  change?: RawChange;
}
interface RawItem {
  name?: string; type?: string; description?: string;
  holders?: Array<{ name?: string; action?: string }>;
  change?: RawChange;
}
interface RawLocation { name?: string; description?: string }
interface RawForeshadow {
  description?: string; type?: string;
  /** plant=本章新埋 / advance=推进既有 / payoff=回收既有 */
  action?: string;
  hint?: string;
}
interface RawEvent { title?: string; description?: string; consequences?: string[] }

interface RawExtraction {
  characters?: RawCharacter[];
  items?: RawItem[];
  locations?: RawLocation[];
  foreshadows?: RawForeshadow[];
  events?: RawEvent[];
}

export interface SinkInput {
  projectId: string;
  /** 本章章号（交付时实际写入的章号） */
  order: number;
  /** 本章正文（抽取的主要依据） */
  draft: string;
  /** 本章结论（定稿官的契约；比正文更权威地说明「本章变了什么」，工具流水线没有则缺省） */
  conclusion?: string;
  /** 既有伏笔清单（原样来自项目库）—— 让模型能原样引用既有伏笔的 description */
  existingForeshadows?: string;
  userId?: string;
}

export interface SinkResult {
  created: number;
  updated: number;
  /** 被跳过/未落库的条目数（名称不可用、伏笔找不到既有条目等） */
  skipped: number;
  /** 跳过原因（去重后，最多 5 条，用于回流给作者看） */
  notes: string[];
}

// ---- 提示词 ----

/**
 * 实体抽取的输出预算。
 *
 * ★ 2026-10-23：4096 → 8192。原值在**推理模型**下必然失败 —— 复现（见
 *   persistChapterEntities 的注释）：max_tokens=4096 时 4096 个 token 全花在思考上，
 *   `finish_reason='length'`、正文长度 0；8192 时思考 1618 + 正文 4508，正常收尾。
 * 取 8192 而不是直接拉到 16384（pipeline/sink 的结构化抽取用的是那一档）：
 * 本调用的输出是「一章的增量实体」，实测 4508 token 就够；给太大只是徒增上限。
 */
const EXTRACT_MAX_TOKENS = 8192;

/** 截断后的补救预算。只在首次解析失败时用，故可以给足（同 pipeline 的抽取档位）。 */
const EXTRACT_RETRY_MAX_TOKENS = 16384;

const EXTRACT_SYSTEM = `你是「实体沉淀」，负责把刚定稿的一章里**新出现或发生变动**的设定，整理成可入库的结构化记录。

你的唯一依据是下面提供的【本章正文】与【本章结论】。**正文里没写的东西，一个字都不许补。**

规则：
- 只记录本章**首次出现**或**状态发生变动**的实体；既有实体若本章没有变化，不要报
- 名称必须与正文完全一致，不要改写成全名或简称
- change 只在确实存在时序变化时才给（如「手机」从「无归属」变为「陈默持有」）；没有就不给
- 伏笔分三种动作，必须区分：
  · plant —— 本章新埋的伏笔
  · advance —— 推进既有伏笔；description 必须**原样抄**下面的【既有伏笔】中的那一条，一个字都不许改
  · payoff —— 回收既有伏笔；description 同样必须原样抄
  · 本章不动的伏笔，一条都不要报
- 不要输出 JSON 以外的任何内容

严格按以下 JSON 结构输出：

{
  "characters": [
    { "name": "陈默", "role": "protagonist", "desire": "", "fear": "", "personality": "", "speechStyle": "", "backstory": "",
      "change": { "field": "认知", "oldValue": "不知情", "newValue": "知道对方认识自己", "description": "第二通电话后" } }
  ],
  "items": [
    { "name": "那部手机", "type": "信物", "description": "地铁上捡到、仍在响的手机",
      "holders": [{ "name": "陈默", "action": "gained" }],
      "change": { "field": "归属", "oldValue": "", "newValue": "陈默", "description": "早高峰地铁上捡到" } }
  ],
  "locations": [ { "name": "地铁车厢", "description": "早高峰的地铁" } ],
  "foreshadows": [ { "description": "既有伏笔原文或本章新伏笔原文", "type": "identity", "action": "plant", "hint": "来电者直呼其名" } ],
  "events": [ { "title": "地铁上捡到手机", "description": "...", "consequences": ["被卷入不知名的联系"] } ]
}

字段取值：
- role：protagonist（主角）/ supporting（配角）/ minor（次要）
- 角色 name 必须能独立成词（「主角」「警察」「老人」这类泛指词不要报）
- 伏笔 type：identity / motivation / relation / trauma / turning / fate
- 物品 holders[].action：gained（获得）/ lost（失去）/ transferred（转手）
- 没有内容的板块给空数组，不要省略字段`;

interface BuildInputOpts {
  order: number;
  draft: string;
  conclusion?: string;
  existingForeshadows?: string;
}

function buildExtractInput(o: BuildInputOpts): string {
  const parts = [`【本章章号】第 ${o.order} 章`];
  if (o.conclusion?.trim()) {
    parts.push(`【本章结论（契约，说明本章应该变了什么）】\n${o.conclusion.trim()}`);
  }
  parts.push(`【既有伏笔（advance / payoff 时 description 必须原样引用这里的条目）】\n${o.existingForeshadows?.trim() || '（暂无伏笔）'}`);
  parts.push(`【本章正文】\n${o.draft}`);
  parts.push('请输出实体沉淀 JSON。');
  return parts.join('\n\n');
}

// ---- 校验与归一化（纯函数，可单测） ----

/** 明显不是人名的泛指词 —— 与前端 useAutoEntityDetection 的词表同源，取常用部分 */
const JUNK_NAMES = new Set([
  '主角', '反派', '配角', '路人', '群众', '朋友', '同事', '同学',
  '老师', '学生', '父亲', '母亲', '哥哥', '姐姐', '弟弟', '妹妹',
  '少年', '少女', '青年', '中年', '老人', '孩子', '医生', '护士',
  '警察', '警官', '警员', '司机', '服务员', '皇帝', '掌门', '队长',
  '将军', '大人', '公子', '小姐', '对方', '其他人', '一个人', '男人', '女人',
]);

/**
 * 名称是否可用于入库。
 * 单字名一律拦：AI 输出的单字名几乎都是误识别（且与既有角色极易撞名）。
 */
export function usableName(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length < 2 || s.length > 6) return null;
  if (JUNK_NAMES.has(s)) return null;
  return s;
}

/** 伏笔类型归一化：容忍中文与大小写，未识别回退 identity */
export function mapForeshadowType(raw: unknown): ForeshadowTypeJson {
  const s = String(raw ?? '').trim().toLowerCase();
  const zh: Record<string, ForeshadowTypeJson> = {
    身份: 'identity', 动机: 'motivation', 关系: 'relation',
    创伤: 'trauma', 转折: 'turning', 命运: 'fate',
  };
  if (zh[s]) return zh[s];
  const en: ForeshadowTypeJson[] = ['identity', 'motivation', 'relation', 'trauma', 'turning', 'fate'];
  return en.includes(s as ForeshadowTypeJson) ? (s as ForeshadowTypeJson) : 'identity';
}

/** 伏笔动作归一化：plant / advance / payoff，未识别返回 null（=不处理） */
export function mapForeshadowAction(raw: unknown): 'plant' | 'advance' | 'payoff' | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'plant' || s.includes('埋') || s.includes('播种')) return 'plant';
  if (s === 'advance' || s.includes('推进') || s.includes('暗示')) return 'advance';
  if (s === 'payoff' || s === 'payed_off' || s.includes('回收')) return 'payoff';
  return null;
}

/** 物品持有动作归一化 */
export function mapHolderAction(raw: unknown): ItemHolderJson['action'] {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'gained' || s.includes('获得') || s.includes('得到')) return 'gained';
  if (s === 'lost' || s.includes('失去') || s.includes('丢')) return 'lost';
  if (s === 'transferred' || s.includes('转手') || s.includes('交给')) return 'transferred';
  return 'held';
}

/** 把抽取结果里的 change 归一化成 EntityState（无有效 newValue 则返回 null） */
export function toState(raw: RawChange | undefined, order: number): EntityStateJson | null {
  if (!raw || typeof raw !== 'object') return null;
  const newValue = String(raw.newValue ?? '').trim();
  if (!newValue) return null;
  return {
    chapter: order,
    field: String(raw.field ?? '').trim() || '状态',
    ...(String(raw.oldValue ?? '').trim() ? { oldValue: String(raw.oldValue).trim() } : {}),
    newValue,
    ...(String(raw.description ?? '').trim() ? { description: String(raw.description).trim() } : {}),
  };
}

/** 安全解析 JSON 文本列 */
function parseArr<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** 状态流水去重键：同一章同字段同新值只留一条（重复沉淀时不翻倍） */
function stateKey(s: EntityStateJson): string {
  return `${s.chapter}|${s.field}|${s.newValue}`;
}

/**
 * 按 holders 流转史推算当前持有者。
 * 与 @novel/shared 的 deriveCurrentHolders 同规则：每角色最后一次动作是 gained/transferred 即视为持有。
 */
function currentHoldersOf(holders: ItemHolderJson[]): string[] {
  const lastAction = new Map<string, ItemHolderJson['action']>();
  for (const h of [...holders].sort((a, b) => a.chapter - b.chapter)) {
    lastAction.set(h.characterId, h.action);
  }
  const out: string[] = [];
  for (const [cid, action] of lastAction) {
    if (action === 'gained' || action === 'transferred') out.push(cid);
  }
  return out;
}

// ---- 主流程 ----

/**
 * 抽取并把实体写入项目库。
 *
 * **不会抛错**：任何失败都收敛成 notes 返回。调用方只管回流展示，不必加 try/catch。
 */
/**
 * 沉淀前的「批次内自洽」筛查（分层记忆架构 §3 的防污染守卫，2026-09-13 接进真实路径）。
 *
 * 判据：**同一章里同一槽位出现两个不同值 = 模型自相矛盾**（跨章的值变化是正常演进，不算）。
 * 处置：冲突的那几条**一条都不落库**，写进 `fact_conflicts` 等人裁；其余照常沉淀。
 * 为什么必须拦：不拦的话"后写覆盖先写"，设定库里会留下一条谁都不知道哪来的值。
 */
export async function screenBatchConflicts(
  ctx: ServerPluginContext,
  projectId: string,
  raw: RawExtraction,
  order: number,
): Promise<number> {
  const facts: FactWrite[] = [];
  for (const c of raw.characters ?? []) {
    if (c?.name && c.change?.newValue) facts.push({ slot: `characters/${c.name}/state`, value: c.change.newValue, source: `ch${order}` });
  }
  for (const it of raw.items ?? []) {
    if (it?.name && it.change?.newValue) facts.push({ slot: `items/${it.name}/state`, value: it.change.newValue, source: `ch${order}` });
  }
  const { conflicts } = detectBatchConflicts(facts);
  if (conflicts.length === 0) return 0;

  await recordConflicts(ctx, projectId, conflicts.map((c) => ({
    slot: c.slot, existing: c.existing, incoming: c.incoming,
  })), `ch${order}`);

  // 冲突条目从抽取里摘掉（按槽位反查名字），剩下的才落库
  const bad = new Set(conflicts.map((c) => c.slot));
  raw.characters = (raw.characters ?? []).filter((c) => !c?.name || !bad.has(`characters/${c.name}/state`));
  raw.items = (raw.items ?? []).filter((it) => !it?.name || !bad.has(`items/${it.name}/state`));
  return conflicts.length;
}

export async function persistChapterEntities(
  ctx: ServerPluginContext,
  input: SinkInput,
): Promise<SinkResult> {
  const result: SinkResult = { created: 0, updated: 0, skipped: 0, notes: [] };

  const messages = [
    { role: 'system' as const, content: EXTRACT_SYSTEM },
    { role: 'user' as const, content: buildExtractInput({
      order: input.order,
      draft: input.draft,
      conclusion: input.conclusion,
      existingForeshadows: input.existingForeshadows,
    }) },
  ];

  /**
   * 抽取一次。
   *
   * ★ 2026-10-23 修「实体沉淀必定失败（推理模型）」：
   *   原实现是一次调用、`maxTokens: 4096`、失败即放弃。
   *   真机跑第 1 章时沉淀全灭，报 `Expected ',' or '}' after property value in JSON
   *   at position 3847`。复现取值（本章正文 + 本文件同一 EXTRACT_SYSTEM）：
   *
   *     max_tokens=4096 → finish_reason='length'，completion=4096 **全是思考**，
   *                        content 长 0，JSON 解析必然失败
   *     max_tokens=8192 → finish_reason='stop'，思考 1618 + 正文 4508，解析 OK
   *
   *   即：推理模型的思考 token **也计入** maxTokens，4096 在「长系统提示（本文件约 20KB）+
   *   一章正文」这一量级下会被思考吃光，正文连一个字都轮不到。
   *   这与 `apps/server/src/plugin/host.ts` 里子代理那次的「零正文」是**同一个根因**，
   *   故这里照它的做法办：先给足预算，解析失败再**加预算重试一次**（只在失败时多花一次钱）。
   */
  const tryExtract = async (maxTokens: number): Promise<RawExtraction> => {
    const raw = await ctx.ai.complete({
      messages,
      json: true,
      temperature: 0.1,
      maxTokens,
      userId: input.userId,
    });
    return parseJsonLoose<RawExtraction>(raw);
  };

  try {
    let parsed: RawExtraction;
    try {
      parsed = await tryExtract(EXTRACT_MAX_TOKENS);
    } catch (e) {
      // 只对「疑似被截断」补救：其它错误（网络/鉴权/配额）重试也没用，原样抛给外层的 catch。
      const msg = e instanceof Error ? e.message : String(e);
      if (!/maxTokens 截断|未配平/.test(msg)) throw e;
      console.warn(`[entity-sink] 实体抽取输出疑似被截断（maxTokens=${EXTRACT_MAX_TOKENS}），`
        + `改用 ${EXTRACT_RETRY_MAX_TOKENS} 重试一次：${msg}`);
      parsed = await tryExtract(EXTRACT_RETRY_MAX_TOKENS);
    }
    const db = ctx.db.project(input.projectId) as DrizzleDb;
    if (!db) {
      result.notes.push('项目库未打开，实体未沉淀');
      return result;
    }
    // ★ 先筛矛盾，再落库：同批次自相矛盾的条目一条都不进去
    try {
      const blocked = await screenBatchConflicts(ctx, input.projectId, parsed, input.order);
      if (blocked > 0) result.notes.push(`检测到 ${blocked} 处同批次矛盾，已拦下并进冲突队列（待裁决）`);
    } catch (e) {
      result.notes.push(`批次矛盾筛查失败（不影响本章沉淀）：${e instanceof Error ? e.message : String(e)}`);
    }
    await writeEntities(db, input, parsed, result);
  } catch (e) {
    result.notes.push(`实体沉淀失败（不影响已交付章节）：${e instanceof Error ? e.message : String(e)}`);
  }

  // notes 去重 + 限量，避免回流信息过长
  result.notes = [...new Set(result.notes)].slice(0, 5);
  return result;
}

/** 逐表落库。抽成独立函数便于单测直接喂已解析的抽取结果 */
export async function writeEntities(
  db: DrizzleDb,
  input: SinkInput,
  parsed: RawExtraction,
  result: SinkResult,
): Promise<void> {
  const { projectId, order } = input;
  const now = new Date();

  // ---- 角色：先全量读进来做精确匹配（同时为物品持有者解析 id） ----
  const charRows = await db.select().from(schema.characters)
    .where(eq(schema.characters.projectId, projectId));
  /** 精确名称 → 角色 id（含本轮新建的） */
  const charByName = new Map<string, string>();
  const charById = new Map<string, (typeof charRows)[number]>();
  for (const row of charRows) {
    charByName.set(row.name, row.id);
    charById.set(row.id, row);
  }

  for (const raw of asArray(parsed.characters)) {
    const name = usableName(raw?.name);
    if (!name) {
      result.skipped++;
      continue;
    }
    const change = toState(raw.change, order);
    const existing = charByName.get(name);

    if (existing) {
      const row = charById.get(existing);
      const chapters = parseArr<number>(row?.chapters);
      const states = parseArr<EntityStateJson>(row?.states);
      let touched = false;
      if (!chapters.includes(order)) {
        chapters.push(order);
        touched = true;
      }
      if (change && !states.some((s) => stateKey(s) === stateKey(change))) {
        states.push(change);
        touched = true;
      }
      if (!touched) {
        result.skipped++;
        continue;
      }
      await db.update(schema.characters)
        .set({ chapters: JSON.stringify(chapters), states: JSON.stringify(states), updatedAt: now })
        .where(eq(schema.characters.id, existing));
      result.updated++;
    } else {
      const id = nowId();
      await db.insert(schema.characters).values({
        id,
        projectId,
        name,
        role: str(raw.role) ?? null,
        desire: str(raw.desire) ?? null,
        fear: str(raw.fear) ?? null,
        personality: str(raw.personality) ?? null,
        speechStyle: str(raw.speechStyle) ?? null,
        backstory: str(raw.backstory) ?? null,
        states: JSON.stringify(change ? [change] : []),
        chapters: JSON.stringify([order]),
        createdAt: now,
        updatedAt: now,
      });
      charByName.set(name, id);
      result.created++;
    }
  }

  // ---- 物品 ----
  const itemRows = await db.select().from(schema.items)
    .where(eq(schema.items.projectId, projectId));
  const itemByName = new Map(itemRows.map((r) => [r.name, r]));

  for (const raw of asArray(parsed.items)) {
    const name = usableName(raw?.name);
    if (!name) {
      result.skipped++;
      continue;
    }
    const change = toState(raw.change, order);
    const existing = itemByName.get(name);

    if (existing) {
      const chapters = parseArr<number>(existing.chapters);
      const states = parseArr<EntityStateJson>(existing.states);
      const holders = parseArr<ItemHolderJson>(existing.holders);
      let touched = false;
      if (!chapters.includes(order)) {
        chapters.push(order);
        touched = true;
      }
      if (change && !states.some((s) => stateKey(s) === stateKey(change))) {
        states.push(change);
        touched = true;
      }
      for (const h of resolveHolders(raw.holders, charByName, order)) {
        if (!holders.some((x) => x.characterId === h.characterId && x.chapter === h.chapter && x.action === h.action)) {
          holders.push(h);
          touched = true;
        }
      }
      if (!touched) {
        result.skipped++;
        continue;
      }
      await db.update(schema.items)
        .set({
          chapters: JSON.stringify(chapters),
          states: JSON.stringify(states),
          holders: JSON.stringify(holders),
          currentHolders: JSON.stringify(currentHoldersOf(holders)),
          updatedAt: now,
        })
        .where(eq(schema.items.id, existing.id));
      result.updated++;
    } else {
      const holders = resolveHolders(raw.holders, charByName, order);
      const id = nowId();
      await db.insert(schema.items).values({
        id,
        projectId,
        name,
        type: str(raw.type) ?? null,
        description: str(raw.description) ?? null,
        states: JSON.stringify(change ? [change] : []),
        holders: JSON.stringify(holders),
        currentHolders: JSON.stringify(currentHoldersOf(holders)),
        chapters: JSON.stringify([order]),
        createdAt: now,
        updatedAt: now,
      });
      result.created++;
    }
  }

  // ---- 地点 ----
  const locRows = await db.select().from(schema.locations)
    .where(eq(schema.locations.projectId, projectId));
  const locByName = new Map(locRows.map((r) => [r.name, r]));

  for (const raw of asArray(parsed.locations)) {
    const name = usableName(raw?.name);
    if (!name) {
      result.skipped++;
      continue;
    }
    const existing = locByName.get(name);
    if (existing) {
      const chapters = parseArr<number>(existing.chapters);
      if (chapters.includes(order)) {
        result.skipped++;
        continue;
      }
      chapters.push(order);
      await db.update(schema.locations)
        .set({ chapters: JSON.stringify(chapters), updatedAt: now })
        .where(eq(schema.locations.id, existing.id));
      result.updated++;
    } else {
      await db.insert(schema.locations).values({
        id: nowId(),
        projectId,
        name,
        description: str(raw.description) ?? null,
        states: JSON.stringify([]),
        chapters: JSON.stringify([order]),
        createdAt: now,
        updatedAt: now,
      });
      result.created++;
    }
  }

  // ---- 伏笔 ----
  const fshRows = await db.select().from(schema.foreshadows)
    .where(eq(schema.foreshadows.projectId, projectId));
  // 精确描述匹配（trim 后全等）；模型被要求原样抄既有 description
  const fshByDesc = new Map(fshRows.map((r) => [r.description.trim(), r]));
  /**
   * 归一化匹配表（去空白 + 去标点 + 去引号）。
   *
   * ★ 2026-10-23（真机跑第 3–5 章时发现）：**只做精确匹配太脆**。
   *   提示词要求 advance / payoff 的 `description` **原样抄**既有条目，但实测模型
   *   会「抄个开头」或顺手改两个标点 —— 于是精确匹配落空，把**真实存在**的推进丢成
   *   `未在库中找到同条，advance 未落库`（第 5 章两条都是这样：模型引用的其实正是
   *   第 3/4 章种下的同一条，只是被改写/截断了）。
   *   这里补一层归一化比对，**只接受唯一候选**——歧义时仍然拒绝，宁可不落也不乱连。
   */
  const normKey = (s: string) => s.replace(/[\s，。、！？：；“”‘’（）()【】《》…—·"'`]/g, '');
  const normMap = new Map<string, typeof fshRows>();
  for (const r of fshRows) {
    const k = normKey(r.description.trim());
    if (!k) continue;
    normMap.set(k, [...(normMap.get(k) ?? []), r]);
  }
  /** 唯一候选才算命中（精确 → 归一化 → 单向包含） */
  const matchForeshadow = (desc: string): { row: typeof fshRows[number]; how: 'exact' | 'normalized' | 'contained' } | undefined => {
    const exact = fshByDesc.get(desc);
    if (exact) return { row: exact, how: 'exact' };

    const k = normKey(desc);
    if (k) {
      const hits = normMap.get(k);
      if (hits?.length === 1) return { row: hits[0]!, how: 'normalized' };
    }
    // 单向包含：模型常「抄开头」或「抄结尾」。要求较短一方 ≥ 12 字（太短会乱命中），
    // 且候选**唯一** —— 有两条都包含同一片段时说明判不准，交回「不落库」。
    if (k.length >= 12) {
      const contained = fshRows.filter((r) => {
        const rk = normKey(r.description.trim());
        return rk.length >= 12 && (rk.includes(k) || k.includes(rk));
      });
      if (contained.length === 1) return { row: contained[0]!, how: 'contained' };
    }
    return undefined;
  };

  for (const raw of asArray(parsed.foreshadows)) {
    const action = mapForeshadowAction(raw?.action);
    const desc = typeof raw?.description === 'string' ? raw.description.trim() : '';
    if (!action || !desc) {
      result.skipped++;
      continue;
    }

    if (action === 'plant') {
      // ★ 2026-10-23：去重同样走归一化匹配 —— 否则模型把既有伏笔改写几个标点再「播种」，
      //   就会在库里种下一条语义重复的条目（原有精确匹配挡不住这种）。
      if (matchForeshadow(desc)) {
        result.skipped++; // 已存在同描述伏笔，不重复播种
        continue;
      }
      await db.insert(schema.foreshadows).values({
        id: nowId(),
        projectId,
        description: desc,
        type: mapForeshadowType(raw.type),
        status: 'planted',
        seedChapter: order,
        seedText: str(raw.hint) ?? null,
        hints: JSON.stringify([]),
        relatedCharacters: JSON.stringify([]),
        relatedItems: JSON.stringify([]),
        createdAt: now,
        updatedAt: now,
      });
      result.created++;
      continue;
    }

    const hit = matchForeshadow(desc);
    if (!hit) {
      // advance / payoff 找不到既有伏笔：不猜、不新建，如实记一笔
      result.skipped++;
      result.notes.push(`伏笔「${desc.slice(0, 20)}」未在库中找到同条，${action} 未落库`);
      continue;
    }
    const target = hit.row;
    if (hit.how !== 'exact') {
      // 模糊命中要留痕：事后能查「这条推进到底连到了哪一条」
      result.notes.push(`伏笔「${desc.slice(0, 14)}」按${hit.how === 'normalized' ? '去标点' : '包含关系'}匹配到「${String(target.description).slice(0, 14)}」`);
    }

    if (action === 'payoff') {
      if (target.payoffChapter === order) {
        result.skipped++;
        continue;
      }
      await db.update(schema.foreshadows)
        .set({ payoffChapter: order, payoffText: str(raw.hint) ?? null, status: 'payed_off', updatedAt: now })
        .where(eq(schema.foreshadows.id, target.id));
      result.updated++;
    } else {
      const hints = parseArr<{ chapter: number; text?: string }>(target.hints);
      if (hints.some((h) => h.chapter === order)) {
        result.skipped++;
        continue;
      }
      hints.push({ chapter: order, ...(str(raw.hint) ? { text: str(raw.hint) } : {}) });
      await db.update(schema.foreshadows)
        .set({
          hints: JSON.stringify(hints),
          status: target.status === 'planted' ? 'hinted' : (target.status as ForeshadowStatusJson),
          updatedAt: now,
        })
        .where(eq(schema.foreshadows.id, target.id));
      result.updated++;
    }
  }

  // ---- 事件 ----
  for (const raw of asArray(parsed.events)) {
    const title = str(raw?.title);
    if (!title) {
      result.skipped++;
      continue;
    }
    await db.insert(schema.storyEvents).values({
      id: nowId(),
      projectId,
      title,
      description: str(raw.description) ?? null,
      chapter: order,
      participants: JSON.stringify([]),
      relatedItems: JSON.stringify([]),
      relatedLocations: JSON.stringify([]),
      consequences: JSON.stringify(asArray(raw.consequences).filter((c): c is string => typeof c === 'string')),
      tags: JSON.stringify([]),
      createdAt: now,
      updatedAt: now,
    });
    result.created++;
  }
}

/** 把「持有者名称 + 动作」解析为带角色 id 的流转记录；无法解析的名字直接丢弃（不猜） */
function resolveHolders(
  raw: Array<{ name?: string; action?: string }> | undefined,
  charByName: Map<string, string>,
  order: number,
): ItemHolderJson[] {
  const out: ItemHolderJson[] = [];
  for (const h of asArray(raw)) {
    const name = usableName(h?.name);
    if (!name) continue;
    const characterId = charByName.get(name);
    if (!characterId) continue;
    out.push({ characterId, chapter: order, action: mapHolderAction(h.action) });
  }
  return out;
}

function asArray<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}
