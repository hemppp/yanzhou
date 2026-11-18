// ============================================================
// 关系识别评测（客户端口径）
//
// 走的是**产品真实链路**：服务端 SSE 原样输出 → 客户端
// relationRecognition 做类型归一 / id 解析 / 证据接地 / 去重。
// 只有通过校验的断言才算「识别成功」，避免用服务端原始中文类型
// 直接对表造成的假阴性（e.g. 服务端输出「师徒」，标准码是 mentor）。
// ============================================================

import { CHAPTERS } from './chapters.mjs';
import {
  normalizeCharacterRelationType,
  normalizeItemRelationType,
  normalizeLocationRelationType,
  prepareRelationContext,
  prepareRelationDedupe,
  planRelationWrite,
  validateRelationAssertion,
  type PreparedRelationContext,
  type RelationDedupeIndex,
} from '../../apps/plugins/manual/workbench/web/knowledge/relationRecognition';

const BASE = process.argv[2] || 'http://127.0.0.1:3899';

type RawEntity = { entityType: 'character' | 'item' | 'location'; name: string; context?: string };
type RawAssertion = {
  assertionType: 'character_relation' | 'item_relation' | 'location_relation';
  subject: string;
  object: string;
  type: string;
  direction?: 'mutual' | 'to' | 'from';
  context: string;
  description?: string;
};

async function api(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function createProject(): Promise<string> {
  const res = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '关系识别评测 2026-11', genre: 'xianxia' }),
  });
  return (await res.json()).data.id;
}

async function createChapter(projectId: string, chapter: { title: string; content: string }, order: number) {
  await api('/chapters', {
    method: 'POST',
    headers: { 'X-Project-Id': projectId },
    body: JSON.stringify({
      projectId,
      title: chapter.title,
      content: `<p>${chapter.content}</p>`,
      order,
      status: 'draft',
    }),
  });
}

async function scanChapter(
  projectId: string,
  chapter: { title: string; content: string },
  order: number,
  known: { characters: Array<{ name: string; aliases: string[] }>; items: string[]; locations: string[] },
): Promise<{ entities: RawEntity[]; assertions: RawAssertion[]; events: number; error?: string }> {
  const res = await api('/ai/scan-timeline-stream', {
    method: 'POST',
    headers: { 'X-Project-Id': projectId },
    body: JSON.stringify({
      chapterContent: chapter.content,
      chapterTitle: chapter.title,
      chapterOrder: order,
      projectName: '关系识别评测',
      existingEntities: JSON.stringify(known),
      projectId,
    }),
  });

  const text = await res.text();
  const entities: RawEntity[] = [];
  const assertions: RawAssertion[] = [];
  let events = 0;
  let error: string | undefined;

  for (const frame of text.split('\n\n')) {
    const line = frame.trim();
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }
    if (data.error) {
      error = String(data.message ?? 'AI 错误');
      continue;
    }
    if (data.done) continue;
    if (typeof data.assertionType === 'string') assertions.push(data as unknown as RawAssertion);
    else if (typeof data.entityType === 'string') entities.push(data as unknown as RawEntity);
    else if (typeof data.title === 'string') events++;
  }

  return { entities, assertions, events, error };
}

const EXPECTED = {
  characters: ['陈星', '青云子', '苏晚', '沈知意', '顾长渊', '老周', '秦无咎'],
  items: ['青锋剑', '剑鞘', '星图残卷', '青铜罗盘', '玄铁令', '回魂丹'],
  locations: ['青云山', '藏经阁', '寒潭', '落霞镇', '听雨楼', '黑风寨', '断魂崖'],
  characterRelations: [
    ['陈星', '青云子', 'mentor'],
    ['青云子', '苏晚', 'mentor'],
    ['陈星', '沈知意', 'lover'],
    ['陈星', '顾长渊', 'enemy'],
    ['陈星', '苏晚', 'friend'],
    ['陈星', '老周', 'friend'],
    ['陈星', '秦无咎', 'rival'],
    ['顾长渊', '青云子', 'enemy'],
    ['顾长渊', '苏晚', 'enemy'],
  ],
  itemRelations: [
    ['青锋剑', '剑鞘', 'paired_with'],
    ['星图残卷', '青铜罗盘', 'related_to'],
  ],
  locationRelations: [
    ['藏经阁', '青云山', 'located_in'],
    ['寒潭', '青云山', 'located_in'],
    ['听雨楼', '落霞镇', 'located_in'],
    ['黑风寨', '落霞镇', 'nearby'],
    ['断魂崖', '青云山', 'located_in'],
    ['藏经阁', '陈星', 'located_in'],
    ['藏经阁', '青云子', 'located_in'],
    ['断魂崖', '顾长渊', 'located_in'],
  ],
};

/** 人工判定的错误关系（用于算误报） */
const KNOWN_WRONG = new Set([
  '苏晚|mentor|陈星',
  '顾长渊|subordinate|秦无咎',
  '陈星|rival|顾长渊',
]);

function norm(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').replace(/[「」『』“”"'《》〈〉【】[\]（）()·]/g, '');
}

function pairKey(a: string, b: string, type: string): string {
  return `${[norm(a), norm(b)].sort().join('|')}|${type}`;
}

async function main() {
  console.log(`[eval] base=${BASE}`);
  const projectId = await createProject();
  console.log(`[eval] project=${projectId}`);

  for (let i = 0; i < CHAPTERS.length; i++) {
    await createChapter(projectId, CHAPTERS[i]!, i + 1);
  }
  console.log(`[eval] 已写入 ${CHAPTERS.length} 章\n`);

  // 跨章累积：模拟客户端 store（实体 + 关系 + 去重索引）
  const known = { characters: [] as Array<{ name: string; aliases: string[] }>, items: [] as string[], locations: [] as string[] };
  const registry: Array<{ id: string; kind: 'character' | 'item' | 'location'; name: string; aliases?: string[] }> = [];
  let nextId = 1;
  let ctx: PreparedRelationContext | null = null;
  let dedupe: RelationDedupeIndex | null = null;

  const accepted = { character: [] as Array<RawAssertion & { chapter: number }>, item: [] as Array<RawAssertion & { chapter: number }>, location: [] as Array<RawAssertion & { chapter: number }> };
  const rejected: Array<{ chapter: number; reason: string; assertion: RawAssertion }> = [];
  const entityNames = { character: [] as string[], item: [] as string[], location: [] as string[] };
  const eventCounts: number[] = [];
  const errors: string[] = [];

  for (let i = 0; i < CHAPTERS.length; i++) {
    const order = i + 1;
    const chapter = CHAPTERS[i]!;
    process.stdout.write(`[eval] 第 ${order} 章 ${chapter.title} … `);
    const started = Date.now();
    let result;
    try {
      result = await scanChapter(projectId, chapter, order, known);
    } catch (e) {
      console.log(`失败: ${e instanceof Error ? e.message : e}`);
      errors.push(`${order}: ${e}`);
      continue;
    }
    if (result.error) errors.push(`${order}: ${result.error}`);

    // —— 客户端的实体落地（与 processEntityShared 同口径：去重后登记） ——
    for (const entity of result.entities) {
      const key = norm(entity.name);
      if (!key) continue;
      const bucket = entityNames[entity.entityType];
      if (!bucket.includes(key)) bucket.push(key);
      if (entity.entityType === 'character') {
        if (!known.characters.some((c) => norm(c.name) === key)) known.characters.push({ name: entity.name, aliases: [] });
        if (!registry.some((r) => r.kind === 'character' && norm(r.name) === key)) {
          registry.push({ id: `c${nextId++}`, kind: 'character', name: entity.name, aliases: [] });
        }
      } else if (entity.entityType === 'item') {
        if (!known.items.some((n) => norm(n) === key)) known.items.push(entity.name);
        if (!registry.some((r) => r.kind === 'item' && norm(r.name) === key)) {
          registry.push({ id: `i${nextId++}`, kind: 'item', name: entity.name });
        }
      } else {
        if (!known.locations.some((n) => norm(n) === key)) known.locations.push(entity.name);
        if (!registry.some((r) => r.kind === 'location' && norm(r.name) === key)) {
          registry.push({ id: `l${nextId++}`, kind: 'location', name: entity.name });
        }
      }
    }

    // 每章重建关系上下文（与 useAutoEntityDetection 一致）
    ctx = prepareRelationContext({
      chapterContent: chapter.content,
      characters: registry.filter((r) => r.kind === 'character').map((r) => ({ id: r.id, name: r.name, aliases: r.aliases })),
      items: registry.filter((r) => r.kind === 'item').map((r) => ({ id: r.id, name: r.name })),
      locations: registry.filter((r) => r.kind === 'location').map((r) => ({ id: r.id, name: r.name })),
    });
    // 去重索引跨章保留：产品侧每章从 store 重建，而 store 里已经有前面章节
    // 写入的关系，语义等价；这里用一个持续索引模拟同一份 store。
    dedupe ??= prepareRelationDedupe({ characters: [], items: [], locations: [] });

    let pass = 0;
    for (const assertion of result.assertions) {
      const validation = validateRelationAssertion(assertion, ctx);
      if (!validation.accept) {
        rejected.push({ chapter: order, reason: validation.reason, assertion });
        continue;
      }
      const planned = planRelationWrite(validation, order, dedupe);
      if (!planned) {
        rejected.push({ chapter: order, reason: '已存在', assertion });
        continue;
      }
      pass++;
      const entry = { ...assertion, chapter: order };
      if (validation.kind === 'character') accepted.character.push(entry);
      else if (validation.kind === 'item') accepted.item.push(entry);
      else accepted.location.push(entry);
    }

    const took = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `实体=${result.entities.length} 断言=${result.assertions.length} 通过=${pass} 事件=${result.events} (${took}s)`,
    );
    eventCounts.push(result.events);
  }

  // ---- 计分 ----
  const recall = (expected: string[], actual: string[]) => {
    const hay = new Set(actual.map(norm));
    const hit = expected.filter((x) => hay.has(norm(x)));
    return { hit, miss: expected.filter((x) => !hay.has(norm(x))) };
  };

  const charRec = recall(EXPECTED.characters, entityNames.character);
  const itemRec = recall(EXPECTED.items, entityNames.item);
  const locRec = recall(EXPECTED.locations, entityNames.location);

  const typeOf = (assertion: RawAssertion) => {
    if (assertion.assertionType === 'character_relation') return normalizeCharacterRelationType(assertion.type);
    if (assertion.assertionType === 'item_relation') return normalizeItemRelationType(assertion.type);
    // 地点关系：一端是角色 ⇒ 语义固定为 located_in（与客户端归一规则一致）
    const subjectIsLocation = entityNames.location.includes(norm(assertion.subject));
    const objectIsLocation = entityNames.location.includes(norm(assertion.object));
    const targetKind = subjectIsLocation && !objectIsLocation ? 'character' : 'location';
    return normalizeLocationRelationType(assertion.type, targetKind);
  };

  const score = (expected: Array<[string, string, string]>, actual: Array<RawAssertion & { chapter: number }>, label: string) => {
    const keys = new Set(actual.map((r) => pairKey(r.subject, r.object, typeOf(r))));
    const hit = expected.filter(([a, b, t]) => keys.has(pairKey(a, b, t)));
    const miss = expected.filter(([a, b, t]) => !keys.has(pairKey(a, b, t)));
    const extra = actual.filter((r) => {
      const k = pairKey(r.subject, r.object, typeOf(r));
      const expectedHit = expected.some(([a, b, t]) => pairKey(a, b, t) === k);
      if (expectedHit) return false;
      return !KNOWN_WRONG.has(`${r.subject}|${typeOf(r)}|${r.object}`) && !KNOWN_WRONG.has(`${r.object}|${typeOf(r)}|${r.subject}`);
    });
    const wrong = actual.filter((r) => {
      const t = typeOf(r);
      return KNOWN_WRONG.has(`${r.subject}|${t}|${r.object}`) || KNOWN_WRONG.has(`${r.object}|${t}|${r.subject}`);
    });
    return { label, actual: actual.length, hit, miss, extra, wrong };
  };

  const charScore = score(EXPECTED.characterRelations, accepted.character, '角色关系');
  const itemScore = score(EXPECTED.itemRelations, accepted.item, '物品关系');
  const locScore = score(EXPECTED.locationRelations, accepted.location, '地点关系');

  console.log('\n========== 识别结果（客户端口径） ==========');
  const entityLine = (label: string, exp: string[], rec: { hit: string[]; miss: string[] }, got: string[]) => {
    console.log(`${label}召回 ${rec.hit.length}/${exp.length} (${((rec.hit.length / exp.length) * 100).toFixed(0)}%) — 共识别 ${got.length} 个`);
    if (rec.miss.length) console.log(`  漏: ${rec.miss.join('、')}`);
    console.log(`  全部: ${got.join('、')}`);
  };
  entityLine('角色', EXPECTED.characters, charRec, entityNames.character);
  entityLine('物品', EXPECTED.items, itemRec, entityNames.item);
  entityLine('地点', EXPECTED.locations, locRec, entityNames.location);

  for (const s of [charScore, itemScore, locScore]) {
    const total = s.hit.length + s.miss.length;
    const precision = s.actual ? ((s.actual - s.wrong.length - s.extra.length) / s.actual) * 100 : 0;
    console.log(`\n${s.label}: 通过校验 ${s.actual} 条 · 期望命中 ${s.hit.length}/${total} (${((s.hit.length / total) * 100).toFixed(0)}%) · 明确错误 ${s.wrong.length} · 额外(可能合理) ${s.extra.length} · 粗估精度 ${precision.toFixed(0)}%`);
    if (s.miss.length) console.log(`  漏: ${s.miss.map(([a, b, t]) => `${a} -${t}- ${b}`).join(' | ')}`);
    if (s.wrong.length) console.log(`  错: ${s.wrong.map((r) => `${r.subject} -${typeOf(r)}- ${r.object}`).join(' | ')}`);
    if (s.extra.length) {
      console.log(`  额外: ${s.extra.map((r) => `${r.subject}-${typeOf(r)}-${r.object}(第${r.chapter}章)`).join(' | ')}`);
    }
  }

  console.log(`\n被客户端拒绝的断言 ${rejected.length} 条：`);
  const byReason = new Map<string, number>();
  for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  for (const [reason, count] of byReason) console.log(`  ${reason}: ${count}`);
  console.log(`  证据不符示例: ${rejected.filter((r) => r.reason === '证据与原文不符').slice(0, 4).map((r) => `${r.assertion.subject}→${r.assertion.object}`).join('、') || '—'}`);

  console.log(`\n时间线事件/章: ${eventCounts.join('/')}`);
  if (errors.length) console.log(`错误: ${errors.join(' | ')}`);

  const fs = await import('node:fs/promises');
  await fs.writeFile(
    'F:/new1.2/.claude/worktrees/mystifying-yonath-c3c451/scripts/tmp-recognition-eval/result-client.json',
    JSON.stringify({ projectId, entityNames, accepted, rejected, charScore, itemScore, locScore }, null, 2),
    'utf-8',
  );
  console.log('\n中间数据: scripts/tmp-recognition-eval/result-client.json');
  console.log(`PROJECT_ID=${projectId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
