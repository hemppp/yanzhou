// ============================================================
// 关系断言的落库执行（扫描流 → store）
//
// 与 knowledge/relationRecognition 的分工：
//   · relationRecognition —— 纯函数：类型归一 / id 解析 / 证据接地 / 去重索引
//   · 本文件 —— 把通过的断言按计划写进 zustand store（角色关系、物品关系、地点关系）
//
// 为什么单独一层：自动扫描（useAutoEntityDetection）、章节轮询
// （useLatestChapterPolling）、地图「识别地点」（recognizeLocations）三处
// 都要写关系。之前三处各写一套「共现推断」，规则互相漂移；现在只有这一份。
// ============================================================

import {
  useCharacterStore,
  useItemStore,
  useLocationStore,
} from '@novel-plugins/data-core/stores';
import type { CharacterRelation, ItemRelation, LocationRelation } from '@novel/shared';
import type { StreamRelationAssertion } from '../hooks/aiScanCapability';
import {
  planRelationWrite,
  prepareRelationDedupe,
  validateRelationAssertion,
  type PreparedRelationContext,
  type RelationDedupeIndex,
} from './relationRecognition';

/** 当前项目的实体，转成关系解析所需的 id+name+aliases 形状 */
export function buildRelationEntityRefs(projectId: string): {
  characters: Array<{ id: string; name: string; aliases?: string[] }>;
  items: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
} {
  return {
    characters: useCharacterStore
      .getState()
      .characters.filter((c) => c.projectId === projectId)
      .map((c) => ({ id: c.id, name: c.name, aliases: c.aliases ?? [] })),
    items: useItemStore
      .getState()
      .items.filter((i) => i.projectId === projectId)
      .map((i) => ({ id: i.id, name: i.name })),
    locations: useLocationStore
      .getState()
      .locations.filter((l) => l.projectId === projectId)
      .map((l) => ({ id: l.id, name: l.name })),
  };
}

/**
 * 按现有 store 内容建去重索引。
 *
 * 扫描早期调用一次即可；后续同一流里的重复断言由 index.mark 拦住。
 * 注意：**不要**每条断言都重建 —— 那会退化成 O(实体数 × 关系数)。
 */
export function buildRelationDedupe(projectId: string): RelationDedupeIndex {
  const chars = useCharacterStore.getState().characters.filter((c) => c.projectId === projectId);
  const items = useItemStore.getState().items.filter((i) => i.projectId === projectId);
  const locations = useLocationStore.getState().locations.filter((l) => l.projectId === projectId);
  return prepareRelationDedupe({
    characters: chars.map((c) => ({ id: c.id, relations: c.relations })),
    items: items.map((i) => ({ id: i.id, relations: i.relations })),
    locations: locations.map((l) => ({ id: l.id, relations: l.relations })),
  });
}

function addCharacterRelation(characterId: string, relation: CharacterRelation): void {
  const character = useCharacterStore.getState().characters.find((c) => c.id === characterId);
  if (!character) return;
  // 双保险：即使去重索引漏了，图上也不会出现两条一样的边
  const duplicated = (character.relations ?? []).some(
    (r) => r.targetId === relation.targetId && r.type === relation.type,
  );
  if (duplicated) return;
  useCharacterStore.getState().addRelation(characterId, relation);
}

function addItemRelation(itemId: string, relation: ItemRelation): void {
  const item = useItemStore.getState().items.find((i) => i.id === itemId);
  if (!item) return;
  const duplicated = (item.relations ?? []).some(
    (r) => r.targetItemId === relation.targetItemId && r.type === relation.type,
  );
  if (duplicated) return;
  useItemStore.getState().addItemRelation(itemId, relation);
}

function addLocationRelation(locationId: string, relation: LocationRelation): void {
  const location = useLocationStore.getState().locations.find((l) => l.id === locationId);
  if (!location) return;
  const duplicated = (location.relations ?? []).some(
    (r) =>
      r.targetId === relation.targetId &&
      r.targetKind === relation.targetKind &&
      r.type === relation.type,
  );
  if (duplicated) return;
  useLocationStore.getState().updateLocation(locationId, {
    relations: [...(location.relations ?? []), relation],
    updatedAt: Date.now(),
  });
}

export type RelationApplyOutcome =
  | { added: false; reason: string }
  | { added: true; kind: 'character' | 'item' | 'location' };

/**
 * 校验并落库一条关系断言。
 *
 * @param ctx       预建的关系解析索引（一章一次，随新实体增量登记）
 * @param dedupe    预建的去重索引（一章一次）
 */
export function applyRelationAssertion(
  assertion: StreamRelationAssertion,
  chapterOrder: number,
  ctx: PreparedRelationContext,
  dedupe: RelationDedupeIndex,
): RelationApplyOutcome {
  const validation = validateRelationAssertion(assertion, ctx);
  if (!validation.accept) {
    return { added: false, reason: validation.reason };
  }

  const planned = planRelationWrite(validation, chapterOrder, dedupe);
  if (!planned) return { added: false, reason: '关系已存在' };

  const { write } = planned;
  if (write.kind === 'character') {
    for (const { characterId, relation } of write.additions) {
      addCharacterRelation(characterId, relation);
    }
    return { added: true, kind: 'character' };
  }
  if (write.kind === 'item') {
    for (const { itemId, relation } of write.additions) {
      addItemRelation(itemId, relation);
    }
    return { added: true, kind: 'item' };
  }
  for (const { locationId, relation } of write.additions) {
    addLocationRelation(locationId, relation);
  }
  return { added: true, kind: 'location' };
}