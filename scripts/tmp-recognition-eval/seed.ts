// ============================================================
// 把「10 章扫描 + 客户端关系校验」的结果真正写进项目库，
// 好在 UI 里查看关系图 / 地点关系 / 物品开关的最终效果。
//
// 走的是产品同样的接口（POST/PUT /api/{characters,items,locations}），
// 关系用 relationRecognition 的同一套校验，避免评测口径与产品口径漂移。
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
const PROJECT_NAME = process.argv[3] || '关系识别评测·可视化';

type RawEntity = { entityType: 'character' | 'item' | 'location'; name: string; description?: string; context?: string; itemType?: string };
type RawAssertion = {
  assertionType: 'character_relation' | 'item_relation' | 'location_relation';
  subject: string;
  object: string;
  type: string;
  direction?: 'mutual' | 'to' | 'from';
  context: string;
  description?: string;
};

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function norm(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').replace(/[「」『』“”"'《》〈〉【】[\]（）()·]/g, '');
}

async function main() {
  console.log(`[seed] base=${BASE}`);
  const project = (await api('/projects', {
    method: 'POST',
    body: JSON.stringify({ name: PROJECT_NAME, genre: 'xianxia' }),
  })).data as { id: string };
  const projectId = project.id;
  console.log(`[seed] project=${projectId}`);

  for (let i = 0; i < CHAPTERS.length; i++) {
    await api('/chapters', {
      method: 'POST',
      headers: { 'X-Project-Id': projectId },
      body: JSON.stringify({
        projectId,
        title: CHAPTERS[i]!.title,
        content: `<p>${CHAPTERS[i]!.content}</p>`,
        order: i + 1,
        status: 'draft',
      }),
    });
  }
  console.log(`[seed] 已写入 ${CHAPTERS.length} 章`);

  const known = { characters: [] as Array<{ name: string; aliases: string[] }>, items: [] as string[], locations: [] as string[] };
  const idByName = new Map<string, string>(); // `${kind}:${norm(name)}` → id
  const relationsById = {
    character: new Map<string, any[]>(),
    item: new Map<string, any[]>(),
    location: new Map<string, any[]>(),
  };
  let dedupe: RelationDedupeIndex | null = null;

  for (let i = 0; i < CHAPTERS.length; i++) {
    const order = i + 1;
    const chapter = CHAPTERS[i]!;
    process.stdout.write(`[seed] 第 ${order} 章 … `);

    // 扫描端点是 SSE，不能走 api()（它会 JSON.parse）
    const scanRes = await fetch(`${BASE}/api/ai/scan-timeline-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Project-Id': projectId },
      body: JSON.stringify({
        chapterContent: chapter.content,
        chapterTitle: chapter.title,
        chapterOrder: order,
        projectName: PROJECT_NAME,
        existingEntities: JSON.stringify(known),
        projectId,
      }),
    });
    if (!scanRes.ok) throw new Error(`扫描失败 ${scanRes.status}: ${(await scanRes.text()).slice(0, 200)}`);
    const text = await scanRes.text();

    const entities: RawEntity[] = [];
    const assertions: RawAssertion[] = [];
    for (const frame of text.split('\n\n')) {
      const line = frame.trim();
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data.error || data.done) continue;
      if (typeof data.assertionType === 'string') assertions.push(data);
      else if (typeof data.entityType === 'string') entities.push(data);
    }

    // ---- 落库实体（与产品同口径：按名字去重） ----
    let created = 0;
    for (const entity of entities) {
      const key = norm(entity.name);
      if (!key) continue;
      const kind = entity.entityType;
      const mapKey = `${kind}:${key}`;
      if (idByName.has(mapKey)) continue;

      if (kind === 'character') {
        if (!known.characters.some((c) => norm(c.name) === key)) {
          known.characters.push({ name: entity.name, aliases: [] });
        }
        const data = (await api('/characters', {
          method: 'POST',
          headers: { 'X-Project-Id': projectId },
          body: JSON.stringify({
            projectId,
            name: entity.name,
            backstory: entity.context || entity.description || '',
            aliases: [],
            states: [],
            relations: [],
            chapters: [order],
            tags: [],
          }),
        })).data;
        idByName.set(mapKey, data.id);
        created++;
      } else if (kind === 'item') {
        if (!known.items.some((n) => norm(n) === key)) known.items.push(entity.name);
        const data = (await api('/items', {
          method: 'POST',
          headers: { 'X-Project-Id': projectId },
          body: JSON.stringify({
            projectId,
            name: entity.name,
            type: entity.itemType || 'other',
            description: entity.context || entity.description || '',
            states: [],
            holders: [],
            currentHolders: [],
            relations: [],
            chapters: [order],
            tags: [],
          }),
        })).data;
        idByName.set(mapKey, data.id);
        created++;
      } else {
        if (!known.locations.some((n) => norm(n) === key)) known.locations.push(entity.name);
        const data = (await api('/locations', {
          method: 'POST',
          headers: { 'X-Project-Id': projectId },
          body: JSON.stringify({
            projectId,
            name: entity.name,
            description: entity.context || entity.description || '',
            states: [],
            relations: [],
            chapters: [order],
            tags: [],
          }),
        })).data;
        idByName.set(mapKey, data.id);
        created++;
      }
    }

    // ---- 校验关系（同一套客户端规则） ----
    const ctx: PreparedRelationContext = prepareRelationContext({
      chapterContent: chapter.content,
      characters: [...idByName.entries()]
        .filter(([k]) => k.startsWith('character:'))
        .map(([k, id]) => ({ id, name: known.characters.find((c) => norm(c.name) === k.slice('character:'.length))?.name ?? '' })),
      items: [...idByName.entries()]
        .filter(([k]) => k.startsWith('item:'))
        .map(([k, id]) => ({ id, name: known.items.find((n) => norm(n) === k.slice('item:'.length)) ?? '' })),
      locations: [...idByName.entries()]
        .filter(([k]) => k.startsWith('location:'))
        .map(([k, id]) => ({ id, name: known.locations.find((n) => norm(n) === k.slice('location:'.length)) ?? '' })),
    });
    dedupe ??= prepareRelationDedupe({ characters: [], items: [], locations: [] });

    let accepted = 0;
    for (const assertion of assertions) {
      const validation = validateRelationAssertion(assertion, ctx);
      if (!validation.accept) continue;
      const planned = planRelationWrite(validation, order, dedupe);
      if (!planned) continue;
      accepted++;

      const { write } = planned;
      if (write.kind === 'character') {
        for (const { characterId, relation } of write.additions) {
          const list = relationsById.character.get(characterId) ?? [];
          if (!list.some((r) => r.targetId === relation.targetId && r.type === relation.type)) {
            list.push(relation);
            relationsById.character.set(characterId, list);
          }
        }
      } else if (write.kind === 'item') {
        for (const { itemId, relation } of write.additions) {
          const list = relationsById.item.get(itemId) ?? [];
          if (!list.some((r) => r.targetItemId === relation.targetItemId && r.type === relation.type)) {
            list.push(relation);
            relationsById.item.set(itemId, list);
          }
        }
      } else {
        for (const { locationId, relation } of write.additions) {
          const list = relationsById.location.get(locationId) ?? [];
          if (
            !list.some(
              (r) =>
                r.targetId === relation.targetId &&
                r.targetKind === relation.targetKind &&
                r.type === relation.type,
            )
          ) {
            list.push(relation);
            relationsById.location.set(locationId, list);
          }
        }
      }
    }

    console.log(`新增实体=${created} 断言=${assertions.length} 通过=${accepted}`);
  }

  // ---- 回写关系 ----
  for (const [id, relations] of relationsById.character) {
    await api(`/characters/${id}`, {
      method: 'PUT',
      headers: { 'X-Project-Id': projectId },
      body: JSON.stringify({ relations }),
    });
  }
  for (const [id, relations] of relationsById.item) {
    await api(`/items/${id}`, {
      method: 'PUT',
      headers: { 'X-Project-Id': projectId },
      body: JSON.stringify({ relations }),
    });
  }
  for (const [id, relations] of relationsById.location) {
    await api(`/locations/${id}`, {
      method: 'PUT',
      headers: { 'X-Project-Id': projectId },
      body: JSON.stringify({ relations }),
    });
  }

  console.log(
    `\n[seed] 完成：角色 ${known.characters.length}、物品 ${known.items.length}、地点 ${known.locations.length}；` +
      `角色关系 ${[...relationsById.character.values()].reduce((n, l) => n + l.length, 0)} 条、` +
      `物品关系 ${[...relationsById.item.values()].reduce((n, l) => n + l.length, 0)} 条、` +
      `地点关系 ${[...relationsById.location.values()].reduce((n, l) => n + l.length, 0)} 条`,
  );
  console.log(`PROJECT_ID=${projectId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
