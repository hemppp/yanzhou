import { getCapability } from '@/plugin/registry';
// ============================================================
// 最新章节轮询扫描 Hook
// 后台定时扫描项目「最新章节」，静默提取实体并写入各 store
//
// 设计要点：
// - 轮询间隔 90s，检测最新章节（order 最大）内容是否变化
// - 若最新章节即当前编辑章节，跳过（useAutoEntityDetection 已在处理，避免双路径）
// - 静默执行：无 toast，仅 console.debug
// - 遵循红石开关：extract 关闭时停止轮询
// - 卸载时清理 timer + abort 在飞请求
// ============================================================

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { nanoid } from 'nanoid';
import {
  useChapterStore,
  useCharacterStore,
  useLocationStore,
  useItemStore,
  useTimelineStore,
} from '@novel-plugins/data-core/stores';
import type { Item, Location, TimelineEvent } from '@novel/shared';
import { mergeSimilarCharacters, updateItemHoldersForMerge } from '../knowledge/characterMerge';
import { htmlToText } from '@novel-plugins/data-core/editor/entityDetector';
import {
  type AIScanCapability,
  type StreamAliasMatch,
  type StreamCreditTransaction,
  type StreamEntity,
  type StreamItemTransfer,
  type StreamTimelineEvent,
} from './aiScanCapability';
import { processCreditTransactionShared } from './useScanProcessors';
import { prepareItemContext, validateItemCandidate } from '../knowledge/itemRecognition';
import { applyLocationCandidate, prepareLocationContext } from '../knowledge/locationRecognition';

function aiScan(): AIScanCapability | null {
  return getCapability<AIScanCapability>('ai.scan');
}
/** 模块级稳定 subscribe（useSyncExternalStore 要求引用稳定，否则每渲染重订阅） */
const noopUnsub = () => {};
function subscribeRedstone(cb: () => void): () => void {
  return aiScan()?.subscribeRedstone(cb) ?? noopUnsub;
}

// ---- 事件去重工具函数 ----

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function stringSimilarity(s1: string, s2: string): number {
  const n1 = normalizeText(s1);
  const n2 = normalizeText(s2);
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1;
  const maxLen = Math.max(n1.length, n2.length);
  return 1 - levenshteinDistance(n1, n2) / maxLen;
}

function isDuplicateEvent(existingTitle: string, existingDesc: string, newTitle: string, newDesc: string): boolean {
  const titleSim = stringSimilarity(existingTitle, newTitle);
  if (titleSim > 0.55) return true;
  const descSim = stringSimilarity(existingDesc, newDesc);
  if (descSim > 0.65) return true;
  if (titleSim > 0.4 && descSim > 0.4) return true;
  return false;
}

/** 轮询间隔（ms） */
const POLL_INTERVAL_MS = 90_000;

/** 内容签名最小变化阈值（字符数），避免微小编辑触发重复扫描 */
const MIN_CHANGE_CHARS = 50;

/** 简单字符串哈希（djb2），用于内容签名比对 */
function contentSignature(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** 实体基础字段 */
function entityBase(projectId: string) {
  const now = Date.now();
  return { id: nanoid(), projectId, createdAt: now, updatedAt: now };
}

/**
 * 最新章节轮询扫描
 *
 * @param currentChapterId - 当前正在编辑的章节 ID（用于跳过双路径）
 */
export function useLatestChapterPolling(currentChapterId: string | null | undefined): void {
  // 红石开关
  const extractEnabled = useSyncExternalStore(
    subscribeRedstone,
    () => aiScan()?.isExtractEnabled() ?? true,
  );

  // refs — 跨轮次持久化的状态
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unregisterAbortRef = useRef<(() => void) | null>(null);
  // 已扫描的内容签名：chapterId → signature，避免重复扫描未变内容
  const scannedSignaturesRef = useRef<Map<string, number>>(new Map());
  // 防止轮询重入
  const isPollingRef = useRef(false);
  // 用 ref 保存最新的 currentChapterId，避免 effect 依赖变化导致重启
  const currentChapterIdRef = useRef(currentChapterId);
  currentChapterIdRef.current = currentChapterId;

  useEffect(() => {
    // 红石关闭时不启动轮询
    if (!extractEnabled) {
      console.debug('[PollScan] extract 开关已关闭，轮询暂停');
      return;
    }

    /**
     * 执行一次轮询扫描
     * - 找到最新章节（order 最大）
     * - 若与当前编辑章节相同则跳过（避免双路径）
     * - 内容签名未变则跳过
     * - 静默扫描并写入 store
     */
    const pollOnce = async () => {
      if (isPollingRef.current) return;

      const chapters = useChapterStore.getState().chapters;
      if (chapters.length === 0) return;

      // 找到 order 最大的章节（最新章节）
      const latestChapter = chapters.reduce((max, ch) =>
        (ch.order ?? 0) > (max.order ?? 0) ? ch : max
      , chapters[0]!);

      if (!latestChapter) return;

      // 双路径规避：最新章节即当前编辑章节 → useAutoEntityDetection 已在处理
      if (latestChapter.id === currentChapterIdRef.current) {
        console.debug('[PollScan] 最新章节即当前编辑章节，跳过（避免双路径）');
        return;
      }

      const plainText = htmlToText(latestChapter.content);
      if (plainText.trim().length < 20) return;

      // 内容签名比对：未变或变化太小则跳过
      const sig = contentSignature(plainText);
      const prevSig = scannedSignaturesRef.current.get(latestChapter.id);
      if (prevSig !== undefined && Math.abs(sig - prevSig) < MIN_CHANGE_CHARS) {
        console.debug('[PollScan] 最新章节内容无显著变化，跳过');
        return;
      }
      scannedSignaturesRef.current.set(latestChapter.id, sig);

      isPollingRef.current = true;

      // 中止上一次在飞的轮询请求
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (unregisterAbortRef.current) {
        unregisterAbortRef.current();
        unregisterAbortRef.current = null;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const registerAbort = aiScan()?.registerAbort ?? (() => () => {});
      const unregister = registerAbort('extract', controller);
      unregisterAbortRef.current = unregister;

      const projectId = latestChapter.projectId;
      const chapterOrder = latestChapter.order;

      // 收集已存在实体名，用于去重
      const existingEntities = {
        characters: useCharacterStore.getState().characters.map(c => c.name),
        items: useItemStore.getState().items.map(i => i.name),
        locations: useLocationStore.getState().locations.map(l => l.name),
      };

      let newChars = 0;
      let newItems = 0;
      let newLocs = 0;
      let newEvents = 0;
      let newTransfers = 0;
      let newAliases = 0;
      let newCredits = 0;
      const detectedCreditKeys = new Set<string>();
      // 积分流水先缓存，等实体/物品都落库后再处理
      const pendingCredits: StreamCreditTransaction[] = [];

      const handleItemTransfer = (transfer: StreamItemTransfer) => {
        if (controller.signal.aborted) return;
        const itemState = useItemStore.getState();
        const charState = useCharacterStore.getState();

        const item = itemState.items.find(i => 
          i.name === transfer.itemName || 
          i.name.includes(transfer.itemName) || 
          transfer.itemName.includes(i.name)
        );
        if (!item) return;

        const charNameToId = new Map<string, string>();
        for (const c of charState.characters) {
          if (c.name && !charNameToId.has(c.name)) charNameToId.set(c.name, c.id);
          for (const alias of c.aliases ?? []) {
            if (alias && !charNameToId.has(alias)) charNameToId.set(alias, c.id);
          }
        }

        // 查找角色的辅助函数：先精确匹配，再模糊匹配
        const findCharId = (name: string): string | null => {
          if (!name) return null;
          if (charNameToId.has(name)) return charNameToId.get(name)!;
          const found = charState.characters.find(c =>
            c.name.includes(name) || name.includes(c.name) ||
            c.aliases?.some(a => a.includes(name) || name.includes(a))
          );
          return found ? found.id : null;
        };

        const fromId = transfer.fromCharacter ? findCharId(transfer.fromCharacter) : null;
        const toId = transfer.toCharacter ? findCharId(transfer.toCharacter) : null;

        const existingInChapter = item.holders.some(
          h => h.chapter === chapterOrder && 
               ((fromId && h.characterId === fromId && h.action === 'lost') ||
                (toId && h.characterId === toId && (h.action === 'gained' || h.action === 'transferred')))
        );
        if (existingInChapter) return;

        const newHolders = [...item.holders];
        const currentHoldersSet = new Set(item.currentHolders ?? []);

        if (transfer.action === 'gained' && toId) {
          newHolders.push({ characterId: toId, chapter: chapterOrder, action: 'gained' });
          currentHoldersSet.add(toId);
          newTransfers++;
        } else if (transfer.action === 'lost' && (fromId || toId)) {
          const loserId = fromId || toId!;
          newHolders.push({ characterId: loserId, chapter: chapterOrder, action: 'lost' });
          currentHoldersSet.delete(loserId);
          newTransfers++;
        } else if (transfer.action === 'transferred' && fromId && toId) {
          newHolders.push({ characterId: fromId, chapter: chapterOrder, action: 'lost' });
          newHolders.push({ characterId: toId, chapter: chapterOrder, action: 'gained' });
          currentHoldersSet.delete(fromId);
          currentHoldersSet.add(toId);
          newTransfers++;
        }

        if (newHolders.length !== item.holders.length) {
          itemState.updateItem(item.id, {
            holders: newHolders,
            currentHolders: Array.from(currentHoldersSet),
            updatedAt: Date.now(),
          });
        }
      };

      const handleAliasMatch = (aliasMatch: StreamAliasMatch) => {
        if (controller.signal.aborted) return;
        const charState = useCharacterStore.getState();
        const allNames = [aliasMatch.primaryName, ...aliasMatch.aliases].filter(Boolean);
        if (allNames.length < 2) return;

        const matchedCharIds = new Set<string>();
        for (const name of allNames) {
          for (const c of charState.characters) {
            if (c.projectId !== projectId) continue;
            if (c.name === name) { matchedCharIds.add(c.id); continue; }
            if (c.aliases?.includes(name)) { matchedCharIds.add(c.id); continue; }
            if (c.name.includes(name) || name.includes(c.name)) { matchedCharIds.add(c.id); continue; }
            if (c.aliases?.some(a => a.includes(name) || name.includes(a))) { matchedCharIds.add(c.id); continue; }
          }
        }

        const matchedChars = charState.characters.filter(c => matchedCharIds.has(c.id));

        if (matchedChars.length === 0) {
          return;
        }

        const primaryChar = matchedChars.find(c => c.name === aliasMatch.primaryName)
          || matchedChars.find(c => aliasMatch.aliases.some(a => c.name === a || c.aliases?.includes(a)))
          || matchedChars[0];

        if (!primaryChar) return;

        const otherMatched = matchedChars.filter(c => c.id !== primaryChar.id);

        const allAliases = new Set(primaryChar.aliases ?? []);
        const allChapters = new Set(primaryChar.chapters ?? []);
        let mergedBackstory = primaryChar.backstory || '';
        let mergedStates = [...(primaryChar.states ?? [])];
        let mergedRelations = [...(primaryChar.relations ?? [])];
        let mergedTags = new Set(primaryChar.tags ?? []);

        for (const name of allNames) {
          if (name !== primaryChar.name && !allAliases.has(name)) {
            allAliases.add(name);
          }
        }

        for (const other of otherMatched) {
          for (const a of other.aliases ?? []) {
            if (a !== primaryChar.name) allAliases.add(a);
          }
          for (const ch of other.chapters ?? []) allChapters.add(ch);
          if (other.backstory && other.backstory.length > mergedBackstory.length) {
            mergedBackstory = other.backstory;
          }
          for (const st of other.states ?? []) {
            if (!mergedStates.some(s => s.field === st.field)) mergedStates.push(st);
          }
          for (const rel of other.relations ?? []) {
            if (!mergedRelations.some(r => r.targetId === rel.targetId && r.type === rel.type)) {
              mergedRelations.push(rel);
            }
          }
          for (const t of other.tags ?? []) mergedTags.add(t);
        }

        charState.updateCharacter(primaryChar.id, {
          aliases: Array.from(allAliases),
          chapters: Array.from(allChapters),
          backstory: mergedBackstory,
          states: mergedStates,
          relations: mergedRelations,
          tags: Array.from(mergedTags),
          updatedAt: Date.now(),
        });

        for (const other of otherMatched) {
          const itemState = useItemStore.getState();
          const projectItems = itemState.items.filter(i => i.projectId === projectId);
          const updatedItems = updateItemHoldersForMerge(projectItems, other.id, primaryChar.id);
          const otherItems = itemState.items.filter(i => i.projectId !== projectId);
          itemState.setItems([...otherItems, ...updatedItems]);

          charState.deleteCharacter(other.id);
        }

        newAliases += allAliases.size - (primaryChar.aliases?.length ?? 0);
      };

      try {
        console.debug(`[PollScan] 静默扫描最新章节 #${chapterOrder} "${latestChapter.title}"（${plainText.length} 字）`);

        const scan = aiScan();
      if (!scan) return; // ai.scan 缺失：静默 return（设计 §5.3）
      // 本章只建一次索引：轮询扫描也可能面对万级物品/地点库
      const scanCharacters = useCharacterStore
        .getState()
        .characters.filter(c => c.projectId === projectId);
      const scanItems = useItemStore
        .getState()
        .items.filter(i => i.projectId === projectId);
      const scanLocations = useLocationStore
        .getState()
        .locations.filter(l => l.projectId === projectId);
      const itemCtx = prepareItemContext({
        chapterContent: plainText,
        existingItems: scanItems,
        existingCharacters: scanCharacters,
        existingLocations: scanLocations,
      });
      const locationCtx = prepareLocationContext({
        chapterContent: plainText,
        existingLocations: scanLocations,
        existingCharacters: scanCharacters,
        existingItems: scanItems,
      });
      await scan.scanTimelineStream(
          plainText,
          chapterOrder,
          existingEntities,
          // onEvent — 时间线事件
          (event: StreamTimelineEvent) => {
            if (controller.signal.aborted) return;
            if (!event.title) return;

            // 去重：与store中已有事件对比（同章节+标题/描述相似）
            const existingEvents = useTimelineStore.getState().events;
            const chapterEvents = existingEvents.filter(e => e.chapter === chapterOrder && e.projectId === projectId);
            
            const isDup = chapterEvents.some(existing => {
              if (!existing.title) return false;
              return isDuplicateEvent(
                existing.title,
                existing.description || '',
                event.title,
                event.description || ''
              );
            });
            
            if (isDup) {
              console.debug('[PollScan] 跳过重复事件:', event.title);
              return;
            }

            // 构建 名字 → ID 索引（含别名）
            const charNameToId = new Map<string, string>();
            for (const c of useCharacterStore.getState().characters) {
              if (c.name && !charNameToId.has(c.name)) charNameToId.set(c.name, c.id);
              for (const alias of c.aliases ?? []) {
                if (alias && !charNameToId.has(alias)) charNameToId.set(alias, c.id);
              }
            }
            const matchedIds = (event.characterNames ?? [])
              .map(name => charNameToId.get(name))
              .filter((id): id is string => Boolean(id));

            const safeOrder = chapterOrder * 100 + newEvents;
            const newTimelineEvent: TimelineEvent = {
              ...entityBase(projectId),
              title: event.title,
              description: event.description ?? '',
              chapter: chapterOrder,
              order: safeOrder,
              characterIds: matchedIds,
              type: event.type ?? 'event',
              timestamp: event.timestamp,
            };
            useTimelineStore.getState().addEvent(newTimelineEvent);
            newEvents++;

            // ≥2 个已知角色 → 两两建立关联
            if (matchedIds.length >= 2) {
              for (let i = 0; i < matchedIds.length - 1; i++) {
                for (let j = i + 1; j < matchedIds.length; j++) {
                  const aId = matchedIds[i]!;
                  const bId = matchedIds[j]!;
                  if (aId === bId) continue;
                  const aChar = useCharacterStore.getState().characters.find(c => c.id === aId);
                  if (!(aChar?.relations ?? []).some(r => r.targetId === bId && r.type === '关联')) {
                    useCharacterStore.getState().addRelation(aId, { targetId: bId, type: '关联', direction: 'mutual', chapter: chapterOrder });
                  }
                  const bChar = useCharacterStore.getState().characters.find(c => c.id === bId);
                  if (!(bChar?.relations ?? []).some(r => r.targetId === aId && r.type === '关联')) {
                    useCharacterStore.getState().addRelation(bId, { targetId: aId, type: '关联', direction: 'mutual', chapter: chapterOrder });
                  }
                }
              }
            }
          },
          // onEntity — 角色/物品/地点
          (entity: StreamEntity) => {
            if (controller.signal.aborted) return;
            if (!entity.name) return;

            if (entity.entityType === 'character') {
              const charState = useCharacterStore.getState();

              // 先检查是否已存在（通过名字或别名，或名字互相包含）
              const existing = charState.characters.find(c =>
                c.name === entity.name ||
                c.aliases?.includes(entity.name) ||
                entity.name.includes(c.name) ||
                c.name.includes(entity.name)
              );

              if (existing) {
                // 已存在相似角色，合并为别名
                const existingAliases = new Set(existing.aliases ?? []);
                let added = false;

                if (entity.name !== existing.name && !existingAliases.has(entity.name)) {
                  existingAliases.add(entity.name);
                  added = true;
                }

                const chapters = new Set(existing.chapters ?? []);
                if (!chapters.has(chapterOrder)) {
                  chapters.add(chapterOrder);
                  added = true;
                }

                if (added) {
                  charState.updateCharacter(existing.id, {
                    aliases: Array.from(existingAliases),
                    chapters: Array.from(chapters),
                    updatedAt: Date.now(),
                  });
                  newAliases++;
                }
                return;
              }

              // 完全新角色，创建
              useCharacterStore.getState().addCharacter({
                ...entityBase(projectId),
                name: entity.name,
                backstory: entity.context || entity.description || '',
                aliases: [],
                states: [],
                relations: [],
                chapters: [chapterOrder],
                tags: [],
              });
              itemCtx.addEntityName(entity.name); // 同章物品撞名检查立即生效
              locationCtx.addEntityName(entity.name); // 同章地点撞名检查立即生效
              newChars++;
            } else if (entity.entityType === 'item') {
              const itemState = useItemStore.getState();
              const validation = validateItemCandidate(entity, itemCtx);
              if (!validation.accept) {
                console.debug(
                  `[PollScan] 跳过疑似非物品 "${entity.name}": ${validation.reason}`,
                );
                return;
              }
              if (validation.existingItem) {
                const existing = validation.existingItem;
                if (
                  validation.type !== 'other' &&
                  (!existing.type || existing.type === 'other')
                ) {
                  itemState.updateItem(existing.id, {
                    type: validation.type,
                    updatedAt: Date.now(),
                  });
                }
                return;
              }
              const now = Date.now();
              const newItem: Item = {
                ...entityBase(projectId),
                name: validation.name,
                type: validation.type,
                description: entity.context || entity.description || '',
                states: [],
                holders: [],
                currentHolders: [],
                relations: [],
                chapters: [chapterOrder],
                tags: [],
                createdAt: now,
                updatedAt: now,
              };
              useItemStore.getState().addItem(newItem);
              itemCtx.addItem(newItem); // 同章后续重复输出直接命中索引
              locationCtx.addEntityName(newItem.name); // 同章地点撞名检查立即生效
              newItems++;
            } else if (entity.entityType === 'location') {
              const result = applyLocationCandidate(entity, chapterOrder, locationCtx);
              if (result.kind === 'reject') {
                console.debug(
                  `[PollScan] 跳过疑似非地点「${entity.name}」：${result.reason}`,
                );
                return;
              }
              if (result.kind === 'link') {
                // 已有地点（含方位前缀变体）只补章节/空描述，不重复建点
                if (!result.changed) return;
                const updates = {
                  chapters: result.chapters,
                  ...(result.description !== undefined ? { description: result.description } : {}),
                  updatedAt: Date.now(),
                };
                useLocationStore.getState().updateLocation(result.location.id, updates);
                locationCtx.addLocation({ ...result.location, ...updates });
                itemCtx.addEntityName(result.location.name);
                return;
              }
              const now = Date.now();
              const newLoc: Location = {
                ...entityBase(projectId),
                name: result.name,
                description: result.description,
                states: [],
                chapters: [chapterOrder],
                tags: [],
                createdAt: now,
                updatedAt: now,
              };
              useLocationStore.getState().addLocation(newLoc);
              locationCtx.addLocation(newLoc);
              itemCtx.addEntityName(result.name); // 同章物品撞名检查立即生效
              newLocs++;
            }
          },
          handleItemTransfer,
          handleAliasMatch,
          controller.signal,
          projectId,
          (credit: StreamCreditTransaction) => {
            if (controller.signal.aborted) return;
            pendingCredits.push(credit);
          },
        ).catch((e) => {
          if (!controller.signal.aborted) {
            console.warn('[PollScan] 流式扫描失败', e);
          }
          return [] as StreamTimelineEvent[];
        });

        if (controller.signal.aborted) return;

        // 扫描完成后合并相似角色
        const charState = useCharacterStore.getState();
        const itemState = useItemStore.getState();
        const projectChars = charState.characters.filter(c => c.projectId === projectId);
        const projectItems = itemState.items.filter(i => i.projectId === projectId);
        const { mergedCharacters, mergedItems, mergeCount } = mergeSimilarCharacters(projectChars, projectItems);
        if (mergeCount > 0) {
          const otherChars = charState.characters.filter(c => c.projectId !== projectId);
          const otherItems = itemState.items.filter(i => i.projectId !== projectId);
          charState.setCharacters([...otherChars, ...mergedCharacters]);
          itemState.setItems([...otherItems, ...mergedItems]);
          console.debug(`[PollScan] 自动合并了 ${mergeCount} 对相似角色`);
        }

        // ★ 实体/物品都已落库，再处理积分流水
        for (const credit of pendingCredits) {
          const result = processCreditTransactionShared(
            credit,
            projectId,
            chapterOrder,
            detectedCreditKeys,
          );
          if (result.added) newCredits++;
        }

        const total = newChars + newItems + newLocs + newEvents + newTransfers + newAliases + newCredits;
        if (total > 0) {
          console.debug(`[PollScan] 静默扫描完成：+${newChars}角色 +${newItems}物品 +${newLocs}地点 +${newEvents}事件 +${newTransfers}流转 +${newAliases}别名 +${newCredits}积分流水`);
        } else {
          console.debug('[PollScan] 静默扫描完成：无新增实体');
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          console.warn('[PollScan] 轮询扫描异常', e);
        }
      } finally {
        unregister();
        if (abortRef.current === controller) abortRef.current = null;
        if (unregisterAbortRef.current === unregister) unregisterAbortRef.current = null;
        isPollingRef.current = false;
      }
    };

    // 启动轮询：首次延迟 10s（避免与页面初始化/首次 AI 配置加载冲突），之后每 90s
    const firstTimer = setTimeout(() => {
      pollOnce();
      timerRef.current = setInterval(pollOnce, POLL_INTERVAL_MS);
    }, 10_000);

    return () => {
      clearTimeout(firstTimer);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (unregisterAbortRef.current) {
        unregisterAbortRef.current();
        unregisterAbortRef.current = null;
      }
      isPollingRef.current = false;
    };
  }, [extractEnabled]);
}
