// ============================================================
// 章节删除联动清理（前端 store 层）— 共享数据层（data-core）
// 原 stores/index.ts:727-864；实体 store 已下沉 data-core。
// ============================================================

import { cascadeCleanFlag } from './cascadeCleanFlag';
import {
  useTimelineStore,
  useEventStore,
  useItemStore,
  useCharacterStore,
  useLocationStore,
  useForeshadowStore,
} from './entityStores';
// 章节删除联动清理（前端 store 层）
//
// 后端 softDeleteChapter 已在数据库层做了联动清理，但前端
// Zustand store 是内存状态，不会自动感知后端的删除操作。
// 此函数在删除章节时同步清理前端各 store 的关联数据，确保
// 时间线/物品/角色/地点/伏笔等模块立即更新。
//
// 注意：只移除章节引用，不删除物品/角色/地点本身（它们可能跨章节）。
// ============================================================

export function cascadeCleanChapterClient(chapterOrder: number): void {
  // ★ 激活级联清理标志：让 useEntitySync 绕过批量删除保护，
  // 否则一次删除 3+ 实体时 DELETE 请求会被跳过，导致后端残留
  cascadeCleanFlag.activate();
  console.debug(`[cascadeCleanChapterClient] 开始清理 chapter=${chapterOrder}，已激活批量删除豁免标志`);

  // 1) 时间线事件：删除 chapter === chapterOrder 的事件
  const tlStore = useTimelineStore.getState();
  const tlBefore = tlStore.events.length;
  tlStore.setEvents(tlStore.events.filter((e) => e.chapter !== chapterOrder));
  const tlDeleted = tlBefore - useTimelineStore.getState().events.length;

  // 2) 故事事件：删除 chapter === chapterOrder 的事件
  const evStore = useEventStore.getState();
  const evBefore = evStore.events.length;
  evStore.setEvents(evStore.events.filter((e) => e.chapter !== chapterOrder));
  const evDeleted = evBefore - useEventStore.getState().events.length;

  // 3) 物品：从 chapters 和 holders 中移除该 order，重算 currentHolders
  //    ★ 孤儿清理：清理后 chapters 和 holders 都为空 → 删除物品
  const itemStore = useItemStore.getState();
  let itemsUpdated = 0;
  let itemsDeleted = 0;
  const survivedItems: typeof itemStore.items = [];
  for (const item of itemStore.items) {
    const newChapters = (item.chapters || []).filter((c) => c !== chapterOrder);
    const newHolders = (item.holders || []).filter((h) => h.chapter !== chapterOrder);
    const chapterChanged = newChapters.length !== (item.chapters || []).length;
    const holderChanged = newHolders.length !== (item.holders || []).length;

    // ★ 孤儿清理：清理后 chapters 和 holders 都为空，且本次确有清理动作 → 删除
    if (newChapters.length === 0 && newHolders.length === 0 && (chapterChanged || holderChanged)) {
      itemsDeleted++;
      continue;
    }

    if (!chapterChanged && !holderChanged) {
      survivedItems.push(item);
      continue;
    }

    // 重算 currentHolders
    const currentSet = new Set<string>();
    const sorted = [...newHolders].sort((a, b) => a.chapter - b.chapter);
    for (const h of sorted) {
      if (h.action === 'gained' || h.action === 'transferred') currentSet.add(h.characterId);
      else if (h.action === 'lost') currentSet.delete(h.characterId);
    }
    survivedItems.push({
      ...item,
      chapters: newChapters,
      holders: newHolders,
      currentHolders: Array.from(currentSet),
      updatedAt: Date.now(),
    });
    itemsUpdated++;
  }
  if (itemsUpdated > 0 || itemsDeleted > 0) itemStore.setItems(survivedItems);

  // 4) 角色：从 chapters 数组移除该 order
  //    ★ 孤儿清理：清理后 chapters 为空 → 删除角色
  const charStore = useCharacterStore.getState();
  let charsUpdated = 0;
  let charsDeleted = 0;
  const survivedChars: typeof charStore.characters = [];
  for (const c of charStore.characters) {
    const newChapters = (c.chapters || []).filter((ch) => ch !== chapterOrder);
    if (newChapters.length === (c.chapters || []).length) {
      survivedChars.push(c);
      continue;
    }
    // ★ 孤儿清理：清理后 chapters 为空 → 删除
    if (newChapters.length === 0) {
      charsDeleted++;
      continue;
    }
    survivedChars.push({ ...c, chapters: newChapters, updatedAt: Date.now() });
    charsUpdated++;
  }
  if (charsUpdated > 0 || charsDeleted > 0) charStore.setCharacters(survivedChars);

  // 5) 地点：从 chapters 数组移除该 order
  //    ★ 孤儿清理：清理后 chapters 为空 → 删除地点
  const locStore = useLocationStore.getState();
  let locsUpdated = 0;
  let locsDeleted = 0;
  const survivedLocs: typeof locStore.locations = [];
  // 被删掉的章节也是关系建立章节，相关关系要一起摘掉（否则图上留着第 N 章的边，
  // 而 N 章已经不存在了）
  for (const l of locStore.locations) {
    const newChapters = (l.chapters || []).filter((ch) => ch !== chapterOrder);
    const newRelations = (l.relations || []).filter(
      (rel) => rel.chapter === undefined || rel.chapter === null || rel.chapter !== chapterOrder,
    );
    const chapterChanged = newChapters.length !== (l.chapters || []).length;
    const relationChanged = newRelations.length !== (l.relations || []).length;
    if (!chapterChanged && !relationChanged) {
      survivedLocs.push(l);
      continue;
    }
    // ★ 孤儿清理：清理后 chapters 为空 → 删除
    if (newChapters.length === 0) {
      locsDeleted++;
      continue;
    }
    survivedLocs.push({
      ...l,
      chapters: newChapters,
      ...(relationChanged ? { relations: newRelations } : {}),
      updatedAt: Date.now(),
    });
    locsUpdated++;
  }
  if (locsUpdated > 0 || locsDeleted > 0) locStore.setLocations(survivedLocs);

  // 5b) 角色/物品关系同理：关系挂了 chapter 的，按章节摘掉
  //     （否则删了第 N 章，图上还留着「第 N 章建立」的师徒/配对边）
  const charStoreForRel = useCharacterStore.getState();
  let charRelsUpdated = 0;
  for (const c of charStoreForRel.characters) {
    const rels = c.relations || [];
    if (rels.length === 0) continue;
    const kept = rels.filter(
      (rel) => rel.chapter === undefined || rel.chapter === null || rel.chapter !== chapterOrder,
    );
    if (kept.length !== rels.length) {
      charStoreForRel.updateCharacter(c.id, { relations: kept, updatedAt: Date.now() });
      charRelsUpdated++;
    }
  }
  const itemStoreForRel = useItemStore.getState();
  let itemRelsUpdated = 0;
  for (const it of itemStoreForRel.items) {
    const rels = it.relations || [];
    if (rels.length === 0) continue;
    const kept = rels.filter(
      (rel) => rel.chapter === undefined || rel.chapter === null || rel.chapter !== chapterOrder,
    );
    if (kept.length !== rels.length) {
      itemStoreForRel.updateItem(it.id, { relations: kept });
      itemRelsUpdated++;
    }
  }

  // 6) 伏笔：seedChapter 命中则删除，payoffChapter 命中则置 null
  const fsStore = useForeshadowStore.getState();
  let fsDeleted = 0;
  let fsUpdated = 0;
  for (const fs of fsStore.foreshadows) {
    if (fs.seedChapter === chapterOrder) {
      fsStore.deleteForeshadow(fs.id);
      fsDeleted++;
    } else if (fs.payoffChapter === chapterOrder) {
      fsStore.updateForeshadow(fs.id, { payoffChapter: undefined, updatedAt: Date.now() });
      fsUpdated++;
    }
  }

  console.debug(
    `[cascadeCleanChapterClient] chapter=${chapterOrder} 完成: ` +
    `timeline删除=${tlDeleted} story删除=${evDeleted} ` +
    `items更新=${itemsUpdated} items孤儿删除=${itemsDeleted} ` +
    `characters更新=${charsUpdated} characters孤儿删除=${charsDeleted} 关系清理={角色:${charRelsUpdated},物品:${itemRelsUpdated}} ` +
    `locations更新=${locsUpdated} locations孤儿删除=${locsDeleted} ` +
    `foreshadows删除=${fsDeleted} foreshadows更新=${fsUpdated}`
  );
}
