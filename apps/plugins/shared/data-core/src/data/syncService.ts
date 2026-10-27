// ============================================================
// 砚舟 - 自动同步中间件
// 封装 Zustand store 订阅 实现自动写入数据库
// ============================================================

import { useEffect, useRef, useCallback } from 'react';
import { cascadeCleanFlag } from '../stores/cascadeCleanFlag';

// ============================================================
// 模块级状态：HMR（热更新）时组件重挂载但模块不重新加载，
// 模块级变量保留值，避免热更新后重复 restore 导致内容被旧数据覆盖。
// ============================================================
let moduleLastRestoredProject: string | null = null;
import {
  useProjectStore,
  useChapterStore,
  useCharacterStore,
  useItemStore,
  useCreditStore,
  useLocationStore,
  useEventStore,
  useForeshadowStore,
  useEarmarkStore,
  useAnnotationStore,
  useOutlineStore,
  useTimelineStore,
  useNoteStore,
} from '../stores/entityStores';
import {
  loadAllProjectData,
  saveChapter, updateChapter, deleteChapter,
  saveCharacter, updateCharacter, deleteCharacter,
  saveItem, updateItem, deleteItem,
  saveCreditTransaction, updateCreditTransaction, deleteCreditTransaction,
  saveLocation, updateLocation, deleteLocation,
  saveStoryEvent, updateStoryEvent, deleteStoryEvent,
  saveForeshadow, updateForeshadow, deleteForeshadow,
  saveEarmark, updateEarmark, deleteEarmark,
  saveAnnotation, updateAnnotation, deleteAnnotation,
  saveOutlineNode, updateOutlineNode, deleteOutlineNode,
  saveTimelineEvent, updateTimelineEvent, deleteTimelineEvent,
  saveNote, updateNote, deleteNote,
} from './databaseService';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';

// ============================================================
// 工具函数
// ============================================================

function hasMeaningfulChanges<T extends object>(curr: T, prev: T, excludeKeys: (keyof T)[] = []): boolean {
  const keys = new Set([...Object.keys(curr), ...Object.keys(prev)]);
  const excludeSet = new Set(excludeKeys as string[]);
  for (const key of keys) {
    if (excludeSet.has(key)) continue;
     
    // 使用类型安全的属性访问
    const currValue = curr[key as keyof T];
    const prevValue = prev[key as keyof T];
    if (currValue !== prevValue) return true;
  }
  return false;
}

// ============================================================
// 泛型实体同步工厂
// 消灭 10 个重复的 useEffect 块
// ============================================================

interface EntitySyncActions<T extends { id: string }> {
  save: (entity: T) => Promise<T | null>;
  update: (id: string, updates: Partial<T>) => Promise<void>;
  delete: (id: string) => Promise<void>;
}

// 增强的 Zustand Store 类型定义
interface ZustandStore<TState> {
  subscribe: (listener: (state: TState, prevState: TState) => void) => () => void;
  getState: () => TState;
}

export function useEntitySync<T extends { id: string; updatedAt: number }>(
  projectId: string | null | undefined,
  isRestoring: { current: boolean },
  store: ZustandStore<any>,
  fieldName: string,
  actions: EntitySyncActions<T>,
  label: string,
) {
  // 跟踪正在 POST（创建）中的项 ID，防止竞态：POST 未完成时 PUT 到同一 ID → 404
  const inflightSavesRef = useRef<Set<string>>(new Set());
  // POST 在途期间被删除的 ID：POST 完成后补删，避免后端残留孤儿 + 立即 DELETE 触发 404
  const pendingDeletesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!projectId) return;
    // ★ 取消标志：cleanup 时置 true，async 队列每次 await 前检查
    // 防止用户快速切换项目时，旧项目的 DELETE/PUT 写入新项目后端
    let cancelled = false;
    const unsub = store.subscribe((state: any, prevState: any) => {
      if (isRestoring.current) return;
      (async () => {
        const items: T[] = state[fieldName];
        const prevItems: T[] = prevState[fieldName];
        for (const item of items) {
          // ★ 切换项目后立即停止旧队列，避免跨项目写入
          if (cancelled) return;
          const prev = prevItems.find((p: T) => p.id === item.id);
          if (!prev) {
            // 新项：POST 创建。标记为 in-flight，防止同期 PUT 竞态
            inflightSavesRef.current.add(item.id);
            try {
              await actions.save(item);
            } catch (e) {
              // 单项创建失败不阻断后续项的同步（如 ABORTED、网络错误）
              console.warn(`[syncService] ${label} 创建 ${item.id} 失败:`, e);
            } finally {
              inflightSavesRef.current.delete(item.id);
            }
            if (cancelled) return;
            // POST 完成后检查：若此 ID 在 POST 在途期间被删除，补发 DELETE 清理后端孤儿
            if (pendingDeletesRef.current.has(item.id)) {
              pendingDeletesRef.current.delete(item.id);
              await actions.delete(item.id).catch(() => { /* silent: 实体可能未创建成功 */ });
            }
          } else if (item.updatedAt !== prev.updatedAt || hasMeaningfulChanges(item, prev)) {
            // 已有项更新：如果该 ID 的 POST 还在 in-flight，跳过（POST 已包含最新数据）
            if (inflightSavesRef.current.has(item.id)) continue;
            if (cancelled) return;
            try {
              await actions.update(item.id, item);
            } catch (e) {
              // 单项更新失败不阻断后续项的同步（如 ABORTED、网络错误）
              console.warn(`[syncService] ${label} 更新 ${item.id} 失败:`, e);
            }
          }
        }
        // 收集所有被"删除"的项 ID，统一处理
        const deletedIds: string[] = [];
        for (const prev of prevItems) {
          if (!items.find((i: T) => i.id === prev.id)) {
            // 若 POST 仍在途（刚创建尚未持久化就被删除），延后删除：
            // 由 POST 的 finally 块在创建完成后补删，避免立即 DELETE 命中 404
            if (inflightSavesRef.current.has(prev.id)) {
              pendingDeletesRef.current.add(prev.id);
              continue;
            }
            deletedIds.push(prev.id);
          }
        }

        // 批量删除保护：一次检测到多个项同时消失，几乎肯定是 store 被覆盖/清空导致的竞态
        // （当前 UI 仅支持单个删除），而非用户操作。跳过整批 DELETE 并告警，防止误删。
        // ★ 例外：cascadeCleanFlag.active 时表示 cascadeCleanChapterClient 正在执行
        //   合法的批量清理（删除/清空章节时联动清理实体），此时必须放行 DELETE 请求
        const BATCH_DELETE_THRESHOLD = 3;
        if (deletedIds.length >= BATCH_DELETE_THRESHOLD && !cascadeCleanFlag.active) {
          console.warn(
            `[syncService] ${label} 检测到 ${deletedIds.length} 个项同时消失，疑似竞态误删，已跳过。`,
          );
        } else {
          if (deletedIds.length >= BATCH_DELETE_THRESHOLD) {
            console.debug(`[syncService] ${label} 批量删除 ${deletedIds.length} 个项（级联清理豁免）`);
          }
          for (const id of deletedIds) {
            if (cancelled) return;
            try {
              await actions.delete(id);
            } catch (e) {
              // 单项删除失败不阻断后续项的同步（如 ABORTED、网络错误）
              console.warn(`[syncService] ${label} 删除 ${id} 失败:`, e);
            }
          }
        }
      })().catch((e: Error) => {
        if (cancelled) return;
        console.error(`[syncService] ${label} sync error:`, e);
        dispatchToastEvent({ type: 'error', message: `${label}数据同步失败，请检查数据库连接` });
      });
    });
    return () => {
      cancelled = true;
      unsub();
      // ★ 清理 inflight / pendingDeletes 残留项，防止跨项目污染
      // 切换项目时，旧项目的 POST 仍会在后台完成，但 finally 块因 cancelled=true 会跳过 pendingDeletes 检查；
      // 若不清理，残留 ID 会留在 Set 中（虽然 nanoid 不重复，功能上无 bug，但内存泄漏 + 语义混乱）
      inflightSavesRef.current.clear();
      pendingDeletesRef.current.clear();
    };
    // actions/label/fieldName 均为静态配置，引用稳定，无需加入依赖

  }, [projectId, isRestoring, store]);
}

// ============================================================
// 同步 Hook
// ============================================================

export function useSyncService(projectId: string | null | undefined): {
  reload: () => Promise<void>;
} {
  const isRestoring = useRef(false);
  const restoreInProgressRef = useRef(false);
  // ★ 最新请求的 projectId：用于让旧 restoreFromDb 在 await 后自知过时、跳过 store 写入
  // 防止场景：用户 A→B 快速切换，A 的 loadAllProjectData 比 B 慢，
  // A 完成后若不校验会把 A 的数据写回 store，覆盖 B 的数据
  const latestProjectIdRef = useRef<string | null | undefined>(projectId);

  useEffect(() => {
    latestProjectIdRef.current = projectId;
  }, [projectId]);

  const restoreFromDb = useCallback(async () => {
    if (!projectId) return;
    // ★ 同项目并发去重：若同一个 projectId 已有 restore 在跑，跳过
    // 跨项目切换时不跳过——新项目的 restore 必须执行，旧项目的 restore 靠 await 后的 latest 校验自知过时
    if (restoreInProgressRef.current && latestProjectIdRef.current === projectId) return;
    restoreInProgressRef.current = true;
    isRestoring.current = true;
    const myProjectId = projectId;
    try {
      const data = await loadAllProjectData(projectId);
      // ★ await 后校验：若用户已切到其他项目，丢弃本次结果，避免旧数据覆盖新项目
      if (latestProjectIdRef.current !== myProjectId) {
        console.debug(`[syncService] restoreFromDb(${myProjectId}) 已过时（当前: ${latestProjectIdRef.current}），丢弃结果`);
        return;
      }
      // 后端不可用（tsx watch 重启 / 未启动）时 loadAllProjectData 返回空数组，
      // 此处避免用空数据覆盖 store 中已有数据，防止"热更新后内容消失"。
      const guard = <T extends { id: string; updatedAt?: number; wordCount?: number }>(
        next: T[],
        current: T[],
        setter: (items: T[]) => void,
      ) => {
        if (next.length === 0 && current.length > 0) return;
        const merged = new Map<string, T>();
        for (const item of current) merged.set(item.id, item);
        for (const item of next) {
          const existing = merged.get(item.id);
          if (!existing) {
            merged.set(item.id, item);
            continue;
          }
          // 后端更新时间 >= store → 用后端
          if ((item.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
            merged.set(item.id, item);
            continue;
          }
          // ★ 脏数据纠正：store 项疑似空内容竞态写入（wordCount<=1）且后端有真实内容 → 用后端
          const existingDirty = (existing.wordCount ?? 0) <= 1;
          const nextHasContent = (item.wordCount ?? 0) > 1;
          if (existingDirty && nextHasContent) {
            merged.set(item.id, item);
          }
        }
        setter(Array.from(merged.values()));
      };
      const pStore = useProjectStore.getState();
      const cStore = useChapterStore.getState();
      guard(data.projects, pStore.projects, pStore.setProjects);
      guard(data.chapters, cStore.chapters, cStore.setChapters);
      guard(data.characters, useCharacterStore.getState().characters, useCharacterStore.getState().setCharacters);
      guard(data.items, useItemStore.getState().items, useItemStore.getState().setItems);
      guard(data.creditTransactions, useCreditStore.getState().creditTransactions, useCreditStore.getState().setCreditTransactions);
      guard(data.locations, useLocationStore.getState().locations, useLocationStore.getState().setLocations);
      guard(data.storyEvents, useEventStore.getState().events, useEventStore.getState().setEvents);
      guard(data.foreshadows, useForeshadowStore.getState().foreshadows, useForeshadowStore.getState().setForeshadows);
      guard(data.earmarks, useEarmarkStore.getState().earmarks, useEarmarkStore.getState().setEarmarks);
      guard(data.annotations, useAnnotationStore.getState().annotations, useAnnotationStore.getState().setAnnotations);
      guard(data.outlineNodes, useOutlineStore.getState().nodes, useOutlineStore.getState().setNodes);
      guard(data.timelineEvents, useTimelineStore.getState().events, useTimelineStore.getState().setEvents);
      guard(data.notes, useNoteStore.getState().notes, useNoteStore.getState().setNotes);

      // ★ 章节数据自检：修复 order 重复/不连续 + 默认标题（第X章）与 order 不匹配的问题
      // （创建章节时的竞态可能导致 order 全为 1 / 标题全为"第一章"）
      const currentChapters = useChapterStore.getState().chapters;
      if (currentChapters.length > 1) {
        const chineseNums = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        const defaultTitleRegex = /^第\s*(\d+|[一二三四五六七八九十]+)\s*章$/;
        const sorted = [...currentChapters].sort((a, b) => a.order - b.order);
        let needsFix = false;
        for (let i = 0; i < sorted.length; i++) {
          const ch = sorted[i]!;
          const correctOrder = i + 1;
          if (ch.order !== correctOrder) { needsFix = true; break; }
          if (defaultTitleRegex.test(ch.title)) {
            const expected = correctOrder <= 10 ? `第${chineseNums[correctOrder]}章` : `第 ${correctOrder} 章`;
            if (ch.title !== expected && ch.title !== `第 ${correctOrder} 章`) { needsFix = true; break; }
          }
        }
        if (needsFix) {
          const now = Date.now();
          const fixed = sorted.map((ch, i) => {
            const correctOrder = i + 1;
            const needsOrderFix = ch.order !== correctOrder;
            const needsTitleFix = defaultTitleRegex.test(ch.title) &&
              ch.title !== (correctOrder <= 10 ? `第${chineseNums[correctOrder]}章` : `第 ${correctOrder} 章`) &&
              ch.title !== `第 ${correctOrder} 章`;
            if (!needsOrderFix && !needsTitleFix) return ch;
            return {
              ...ch,
              ...(needsOrderFix ? { order: correctOrder } : {}),
              ...(needsTitleFix ? { title: correctOrder <= 10 ? `第${chineseNums[correctOrder]}章` : `第 ${correctOrder} 章` } : {}),
              updatedAt: now,
            };
          });
          useChapterStore.getState().setChapters(fixed);
          // ★ 将修复后的数据持久化到后端
          // isRestoring.current = true 期间 useEntitySync 不会同步，需手动调用
          for (const ch of fixed) {
            const original = currentChapters.find((c) => c.id === ch.id);
            if (original && (original.order !== ch.order || original.title !== ch.title)) {
              try {
                await updateChapter(ch.id, { order: ch.order, title: ch.title, updatedAt: now });
              } catch (e) {
                console.warn('[syncService] 修复章节持久化失败:', ch.id, e);
              }
            }
          }
          console.debug(`[syncService] 章节自检修复完成，已持久化 ${fixed.filter((ch) => {
            const o = currentChapters.find((c) => c.id === ch.id);
            return o && (o.order !== ch.order || o.title !== ch.title);
          }).length} 个章节`);
        }
      }

      // ★ 写入 moduleLastRestoredProject 前再次校验，防止 await 期间项目已切换
      if (latestProjectIdRef.current === myProjectId) {
        moduleLastRestoredProject = myProjectId;
      }
    } catch (e) {
      console.warn('[syncService] 从数据库恢复数据失败', e);
    } finally {
      // ★ 仅当本次 restore 仍是最新时才清除标志，避免误清后启动的 restore
      if (latestProjectIdRef.current === myProjectId) {
        isRestoring.current = false;
        restoreInProgressRef.current = false;
      }
    }
  }, [projectId]);

  // ---- 启动/切换项目 ----
  useEffect(() => {
    if (!projectId) {
      if (moduleLastRestoredProject) {
        useProjectStore.setState({ projects: [] });
        useChapterStore.setState({ chapters: [] });
        useCharacterStore.setState({ characters: [] });
        useItemStore.setState({ items: [] });
        useLocationStore.setState({ locations: [] });
        useEventStore.setState({ events: [] });
        useForeshadowStore.setState({ foreshadows: [] });
        useEarmarkStore.setState({ earmarks: [] });
        useAnnotationStore.setState({ annotations: [] });
        useOutlineStore.setState({ nodes: [] });
        useTimelineStore.setState({ events: [] });
        useNoteStore.setState({ notes: [] });
        moduleLastRestoredProject = null;
      }
      return;
    }
    // ★ 捕获本次 effect 对应的 projectId，await 后校验是否仍是当前项目
    // 防止快速切换 A→B→C 时，A 的 restoreFromDb 晚于 B/C 完成，把旧数据写回 store
    const myProjectId = projectId;

    if (moduleLastRestoredProject === projectId) {
      // 同项目重新进入：若任一项目级 store 被外部清空（如 handleOpenBook 提前清空、HMR 重置），
      // 强制重新 restoreFromDb。仅检查 chapters 不够，其他 store 可能单独被清空。
      const anyEmpty =
        useChapterStore.getState().chapters.length === 0 ||
        useCharacterStore.getState().characters.length === 0 ||
        useItemStore.getState().items.length === 0;
      if (anyEmpty) {
        console.debug(`[syncService] 同项目 ${projectId} 但 store 已空，重新加载`);
        isRestoring.current = true;
        void restoreFromDb().then(() => {
          // ★ await 后校验：若用户已切到其他项目，丢弃本次结果
          if (myProjectId !== moduleLastRestoredProject) {
            console.debug(`[syncService] restoreFromDb 完成但项目已切换到 ${moduleLastRestoredProject}，丢弃结果`);
          }
        });
      }
      return;
    }

    // ★ 切换项目：先清空所有 store，再用新项目数据填充
    // guard 采用合并语义（只加不删），若不清空会导致旧项目章节残留
    // isRestoring=true 防止 useEntitySync 检测到批量消失而触发 DELETE
    isRestoring.current = true;
    useChapterStore.setState({ chapters: [] });
    useCharacterStore.setState({ characters: [] });
    useItemStore.setState({ items: [] });
    useLocationStore.setState({ locations: [] });
    useEventStore.setState({ events: [] });
    useForeshadowStore.setState({ foreshadows: [] });
    useEarmarkStore.setState({ earmarks: [] });
    useAnnotationStore.setState({ annotations: [] });
    useOutlineStore.setState({ nodes: [] });
    useTimelineStore.setState({ events: [] });
    useNoteStore.setState({ notes: [] });
    // 注意：projects 列表不清空（书架数据，非项目级）
    console.debug(`[syncService] 切换项目 ${moduleLastRestoredProject} → ${projectId}，已清空 store`);

    void restoreFromDb().then(() => {
      // ★ await 后校验：若用户已切到其他项目，本次清空+恢复的数据属于旧项目，
      // 不应保留在 store（会被下一个 effect 清空覆盖，这里仅记录日志）
      if (myProjectId !== moduleLastRestoredProject) {
        console.debug(`[syncService] 切换项目的 restoreFromDb 完成，但项目已变为 ${moduleLastRestoredProject}`);
      }
    });

  }, [projectId]);

  // ---- 实体级自动同步：store 变更 → 后端持久化 ----
  useEntitySync(projectId, isRestoring, useChapterStore, 'chapters', { save: saveChapter, update: updateChapter, delete: deleteChapter }, '章节');
  useEntitySync(projectId, isRestoring, useCharacterStore, 'characters', { save: saveCharacter, update: updateCharacter, delete: deleteCharacter }, '角色');
  useEntitySync(projectId, isRestoring, useItemStore, 'items', { save: saveItem, update: updateItem, delete: deleteItem }, '物品');
  useEntitySync(projectId, isRestoring, useCreditStore, 'creditTransactions', { save: saveCreditTransaction, update: updateCreditTransaction, delete: deleteCreditTransaction }, '积分流水');
  useEntitySync(projectId, isRestoring, useLocationStore, 'locations', { save: saveLocation, update: updateLocation, delete: deleteLocation }, '地点');
  useEntitySync(projectId, isRestoring, useEventStore, 'events', { save: saveStoryEvent, update: updateStoryEvent, delete: deleteStoryEvent }, '事件');
  useEntitySync(projectId, isRestoring, useForeshadowStore, 'foreshadows', { save: saveForeshadow, update: updateForeshadow, delete: deleteForeshadow }, '伏笔');
  useEntitySync(projectId, isRestoring, useEarmarkStore, 'earmarks', { save: saveEarmark, update: updateEarmark, delete: deleteEarmark }, '书签');
  useEntitySync(projectId, isRestoring, useAnnotationStore, 'annotations', { save: saveAnnotation, update: updateAnnotation, delete: deleteAnnotation }, '标注');
  useEntitySync(projectId, isRestoring, useOutlineStore, 'nodes', { save: saveOutlineNode, update: updateOutlineNode, delete: deleteOutlineNode }, '大纲');
  useEntitySync(projectId, isRestoring, useTimelineStore, 'events', { save: saveTimelineEvent, update: updateTimelineEvent, delete: deleteTimelineEvent }, '时间线');
  useEntitySync(projectId, isRestoring, useNoteStore, 'notes', { save: saveNote, update: updateNote, delete: deleteNote }, '笔记');

  return { reload: restoreFromDb };
}
