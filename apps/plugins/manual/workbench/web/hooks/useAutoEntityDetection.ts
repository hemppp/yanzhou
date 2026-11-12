import { getCapability } from '@/plugin/registry';
// ============================================================
// 自动实体识别 Hook
// 在章节内容变化时自动提取角色、地点、时间线事件
//
// 工作模式：
// - 始终调用后端 /ai/scan 进行 LLM 扫描，智能提取新实体
// - 后端不可用时静默返回（能力实现内部已做 try/catch）
// ============================================================

import { useEffect, useRef, useCallback, useState, useSyncExternalStore } from 'react';
import { nanoid } from 'nanoid';
import { useCharacterStore, useLocationStore, useTimelineStore, useChapterStore, useItemStore, useProjectStore } from '@novel-plugins/data-core/stores';
import { mergeSimilarCharacters, updateItemHoldersForMerge } from '../knowledge/characterMerge';
import { processCreditTransactionShared } from './useScanProcessors';
import { prepareItemContext, validateItemCandidate } from '../knowledge/itemRecognition';
import { applyLocationCandidate, prepareLocationContext } from '../knowledge/locationRecognition';
import { assignAutoCoords } from '../knowledge/locationCoords';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';
import type { Item, Location, TimelineEvent } from '@novel/shared';
import { htmlToText } from '@novel-plugins/data-core/editor/entityDetector';
import {
  ScanSkippedError,
  type AIScanCapability,
  type StreamAliasMatch,
  type StreamCreditTransaction,
  type StreamEntity,
  type StreamItemTransfer,
  type StreamTimelineEvent,
} from './aiScanCapability';

function aiScan(): AIScanCapability | null {
  return getCapability<AIScanCapability>('ai.scan');
}
/** 模块级稳定 subscribe（useSyncExternalStore 要求引用稳定，否则每渲染重订阅） */
const noopUnsub = () => {};
function subscribeRedstone(cb: () => void): () => void {
  return aiScan()?.subscribeRedstone(cb) ?? noopUnsub;
}


// ---- 事件去重工具函数 ----

/** 归一化字符串：去标点、去空格、转小写 */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

/** 计算两个字符串的编辑距离相似度 (Levenshtein) */
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

/** 计算字符串相似度 (0~1) */
function stringSimilarity(s1: string, s2: string): number {
  const n1 = normalizeText(s1);
  const n2 = normalizeText(s2);
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1;
  const maxLen = Math.max(n1.length, n2.length);
  const dist = levenshteinDistance(n1, n2);
  return 1 - dist / maxLen;
}

/** 判断两个事件是否为同一事件 */
function isDuplicateEvent(existingTitle: string, existingDesc: string, newTitle: string, newDesc: string): boolean {
  const titleSim = stringSimilarity(existingTitle, newTitle);
  if (titleSim > 0.55) return true;
  
  const descSim = stringSimilarity(existingDesc, newDesc);
  if (descSim > 0.65) return true;
  
  if (titleSim > 0.4 && descSim > 0.4) return true;
  
  return false;
}

/** 检测间隔：用户停止输入后等待多久开始检测 (ms) */
const DETECT_DEBOUNCE_MS = 1500;


/** 创建实体的公共基础字段（ID、projectId、时间戳） */
function entityBase(projectId: string) {
  const now = Date.now();
  return { id: nanoid(), projectId, createdAt: now, updatedAt: now };
}

/**
 * 自动实体检测 Hook
 *
 * @param chapterId - 当前章节 ID（为 null 时不执行检测）
 * @param chapterContent - 当前章节 HTML 内容
 * @param chapterOrder  - 当前章节序号（用于 timeline）
 */
export function useAutoEntityDetection(
  chapterId: string | null | undefined,
  chapterContent: string,
  chapterOrder: number,
): { isScanning: boolean } {
  const [isScanning, setIsScanning] = useState(false);
  const isScanningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastContentRef = useRef('');
  const detectedIdsRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const unregisterAbortRef = useRef<(() => void) | null>(null);
  // ★ 扫描进行中收到新内容变更时，标记需要在当前扫描结束后补扫一次
  const pendingRescanRef = useRef(false);

  // ★ 红石开关：scanner 关闭时不发起扫描（与后端 /scan-timeline-stream 的 checkFeatureFrozen 对齐）
  // 注意：前端历史上有 'extract' 开关控制 useLatestChapterPolling，但后端章节扫描路由用的是 'scanner'。
  // 这里订阅 'scanner' 才能真正让 UI 开关生效。
  const scannerEnabled = useSyncExternalStore(
    subscribeRedstone,
    () => aiScan()?.isScannerEnabled() ?? true,
  );
  const scannerEnabledRef = useRef(scannerEnabled);
  const chapterIdRef = useRef(chapterId);
  const chapterOrderRef = useRef(chapterOrder);
  const chapterContentRef = useRef(chapterContent);

  // ★ 修复：用 useEffect 同步所有值到 ref，避免渲染期直接赋值
  useEffect(() => { scannerEnabledRef.current = scannerEnabled; }, [scannerEnabled]);
  useEffect(() => { chapterIdRef.current = chapterId; }, [chapterId]);
  useEffect(() => { chapterOrderRef.current = chapterOrder; }, [chapterOrder]);
  useEffect(() => { chapterContentRef.current = chapterContent; }, [chapterContent]);
  useEffect(() => { isScanningRef.current = isScanning; }, [isScanning]);

  /**
   * 处理单个流式时间线事件：去重 → 匹配角色 → addTimelineEvent → 建立关联
   * 从非流式版本提取为独立函数，供流式回调逐个调用
   */
  const processTimelineEvent = useCallback(
    (event: StreamTimelineEvent, idx: number, projectId: string): { added: boolean; relations: number } => {
      if (!event.title) return { added: false, relations: 0 };

      const chapterOrder = chapterOrderRef.current;

      // 1. 内存去重：本次扫描内的重复
      const eventKey = `${chapterOrder}-${event.title}-${event.type}`;
      let _hash = 5381;
      for (let i = 0; i < eventKey.length; i++) {
        _hash = ((_hash << 5) + _hash + eventKey.charCodeAt(i)) | 0;
      }
      const hashKey = (_hash >>> 0).toString(36);

      if (detectedIdsRef.current.has(hashKey)) return { added: false, relations: 0 };
      detectedIdsRef.current.add(hashKey);

      // 2. 持久化去重：与store中已有事件对比（同章节+标题/描述相似）
      const existingEvents = useTimelineStore.getState().events;
      const chapterEvents = existingEvents.filter(e => e.chapter === chapterOrder && e.projectId === projectId);
      
      const isDuplicate = chapterEvents.some(existing => {
        if (!existing.title) return false;
        return isDuplicateEvent(
          existing.title,
          existing.description || '',
          event.title,
          event.description || ''
        );
      });
      
      if (isDuplicate) {
        console.debug('[AutoEntity] 跳过重复事件:', event.title);
        return { added: false, relations: 0 };
      }

      // 构建 名字 → ID 索引（含别名）
      const existingCharacters = useCharacterStore.getState().characters;
      const charNameToId = new Map<string, string>();
      for (const c of existingCharacters) {
        if (c.name && !charNameToId.has(c.name)) charNameToId.set(c.name, c.id);
        for (const alias of c.aliases ?? []) {
          if (alias && !charNameToId.has(alias)) charNameToId.set(alias, c.id);
        }
      }

      const matchedIds = (event.characterNames ?? [])
        .map(name => charNameToId.get(name))
        .filter((id): id is string => Boolean(id));

      // order 去冲突：用 chapterOrder * 100 + 事件序号
      const safeOrder = chapterOrder * 100 + idx;

      // ★ 流式填充：立即写入时间线 store（用户可看到事件逐个出现）
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

      // 同事件中出现 ≥2 个已知角色 → 两两建立 mutual 关联关系
      let newRelations = 0;
      if (matchedIds.length >= 2) {
        const addRelation = useCharacterStore.getState().addRelation;
        for (let i = 0; i < matchedIds.length - 1; i++) {
          for (let j = i + 1; j < matchedIds.length; j++) {
            const aId = matchedIds[i]!;
            const bId = matchedIds[j]!;
            if (aId === bId) continue;

            const aChar = useCharacterStore.getState().characters.find(c => c.id === aId);
            const aHas = (aChar?.relations ?? []).some(r => r.targetId === bId && r.type === '关联');
            if (!aHas) {
              addRelation(aId, { targetId: bId, type: '关联', direction: 'mutual', chapter: chapterOrder });
              newRelations++;
            }
            const bChar = useCharacterStore.getState().characters.find(c => c.id === bId);
            const bHas = (bChar?.relations ?? []).some(r => r.targetId === aId && r.type === '关联');
            if (!bHas) {
              addRelation(bId, { targetId: aId, type: '关联', direction: 'mutual', chapter: chapterOrder });
              newRelations++;
            }
          }
        }
      }

      return { added: true, relations: newRelations };
    },
    [],
  );

  /**
   * AI 路径：流式扫描（时间线事件 + 实体）
   *
   * - 通过 /ai/scan-timeline-stream 单一 SSE 流同时获取时间线事件和角色/物品/地点
   * - 实体行先于事件行输出，逐个即时创建，避免 60s 超时
   */
  const runAIDetection = useCallback(async () => {
    const chapterId = chapterIdRef.current;
    const chapterOrder = chapterOrderRef.current;

    const chapters = useChapterStore.getState().chapters;
    const currentChapter = chapters.find(c => c.id === chapterId);

    console.debug('[AutoEntity] runAIDetection 调用', { chapterId, hasChapter: !!currentChapter, contentLen: currentChapter?.content?.length ?? 0 });
    if (!chapterId || !currentChapter) return;

    // ★ 红石开关：scanner 关闭时不发起扫描
    // 后端 /scan-timeline-stream 也会用 checkFeatureFrozen('scanner') 拦截，但前端拦截可避免无谓请求
    if (!scannerEnabledRef.current) {
      console.debug('[AutoEntity] scanner 红石开关已关闭，跳过扫描');
      return;
    }

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
    const unregister = registerAbort('scanner', controller);
    unregisterAbortRef.current = unregister;

    // ★ projectId 统一来源：优先使用 currentProject.id（与 CharacterManager 的 useCurrentProjectId 一致），
    // 避免多项目切换时 currentChapter.projectId 与 currentProject.id 不一致导致角色被错误 projectId 创建，
    // 进而被 CharacterManager 的 `c.projectId === projectId` 过滤掉（场景4 根因）
    const currentProjectId = useProjectStore.getState().currentProject?.id;
    const projectId = currentProjectId ?? currentChapter.projectId;
    const charState = useCharacterStore.getState();
    const itemState = useItemStore.getState();
    const locState = useLocationStore.getState();
    // ★ existingEntities 必须包含 name + aliases，让 AI 知道哪些别名已归属哪个角色
    // 之前只传 name，AI 不知道"孔明"已有别名"诸葛亮"，会把"诸葛亮"当成新角色输出
    // 导致重复创建角色，事后靠 alias_match 合并既浪费 token 又容易出错
    const existingEntities = {
      characters: charState.characters.map(c => ({
        name: c.name,
        aliases: c.aliases ?? [],
      })),
      items: itemState.items.map(i => i.name),
      locations: locState.locations.map(l => l.name),
    };

    let newEvents = 0;
    let newRelations = 0;
    let newChars = 0;
    let newItems = 0;
    let newLocs = 0;
    let newTransfers = 0;
    let newAliases = 0;
    let newCredits = 0;
    // 积分流水先缓存，等实体/物品都落库后再处理，避免模型把流水排在实体前面时匹配不到角色
    const pendingCredits: StreamCreditTransaction[] = [];

    const handleItemTransfer = (transfer: StreamItemTransfer) => {
      if (controller.signal.aborted) return;
      const itemState = useItemStore.getState();
      const charState = useCharacterStore.getState();

      // 按名称查找物品（支持部分匹配）
      const item = itemState.items.find(i => 
        i.name === transfer.itemName || 
        i.name.includes(transfer.itemName) || 
        transfer.itemName.includes(i.name)
      );
      if (!item) return;

      // 构建 名字→ID 映射（含别名）
      const charNameToId = new Map<string, string>();
      for (const c of charState.characters) {
        if (c.name && !charNameToId.has(c.name)) charNameToId.set(c.name, c.id);
        for (const alias of c.aliases ?? []) {
          if (alias && !charNameToId.has(alias)) charNameToId.set(alias, c.id);
        }
      }

      // 查找角色的辅助函数：先精确匹配，再模糊匹配（名字互相包含）
      const findCharId = (name: string): string | null => {
        if (!name) return null;
        // 精确匹配
        if (charNameToId.has(name)) return charNameToId.get(name)!;
        // 模糊匹配：名字互相包含
        const found = charState.characters.find(c =>
          c.name.includes(name) || name.includes(c.name) ||
          c.aliases?.some(a => a.includes(name) || name.includes(a))
        );
        return found ? found.id : null;
      };

      const fromId = transfer.fromCharacter ? findCharId(transfer.fromCharacter) : null;
      const toId = transfer.toCharacter ? findCharId(transfer.toCharacter) : null;

      // 检查本章是否已经记录过相同流转（去重）
      const existingInChapter = item.holders.some(
        h => h.chapter === chapterOrder &&
             ((fromId && h.characterId === fromId && h.action === 'lost') ||
              (toId && h.characterId === toId && (h.action === 'gained' || h.action === 'transferred')))
      );
      if (existingInChapter && transfer.action !== 'held') return;

      const newHolders = [...item.holders];
      const currentHoldersSet = new Set(item.currentHolders ?? []);
      let currentChanged = false;

      if (transfer.action === 'held') {
        // ★ 持有/使用/穿戴（无流转变化）：仅确保当前持有者包含该角色，不写流转史。
        //   这是人物-物品关系的基础数据（如"把罗盘摊在掌心"、"裹紧斗篷"）。
        if (toId && !currentHoldersSet.has(toId)) {
          currentHoldersSet.add(toId);
          currentChanged = true;
        }
      } else if (transfer.action === 'gained' && toId) {
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

      if (newTransfers > 0 || currentChanged || newHolders.length !== item.holders.length) {
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

      // ★ 安全过滤：排除明显不是人名的词
      // AI 偶尔会把身份描述、关系称谓当成角色名输出（如"女朋友"、"主角"、"大嗓门"）
      const obviouslyNotNames = new Set([
        '主角', '反派', '配角', '路人甲', '路人乙', '路人', '群众',
        '女朋友', '男朋友', '朋友', '同事', '同学', '老师', '学生',
        '父亲', '母亲', '爸爸', '妈妈', '哥哥', '姐姐', '弟弟', '妹妹',
        '大嗓门', '小个子', '大个子', '胖子', '瘦子', '老头', '老太',
        '少年', '少女', '青年', '中年', '老人', '孩子', '小孩',
        '黑衣人', '白衣人', '红衣人', '为首之人', '那少年', '这女子',
      ]);
      const validNames = allNames.filter(n => n.length >= 2 && !obviouslyNotNames.has(n));
      if (validNames.length < 2) return;

      // ★ 只用精确匹配找出已存在的角色，绝不用子串匹配
      const matchedCharIds = new Set<string>();
      for (const name of validNames) {
        for (const c of charState.characters) {
          if (c.projectId !== projectId) continue;
          if (c.name === name) { matchedCharIds.add(c.id); continue; }
          if (c.aliases?.includes(name)) { matchedCharIds.add(c.id); continue; }
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

      // ★ 安全校验：只有当 primaryChar 与待合并角色名有语言学上的相似性时才真正删除
      // 无共同字符的名字极不可能是同一人（如"陈星"和"周粥"），
      // 此时只添加别名但不删除角色，宁可多存也不误删。
      // 阈值与 characterMerge.ts 的 isNameSimilar 保持一致（0.8），避免前后端行为不一致
      const canSafelyDelete = (targetName: string): boolean => {
        const primary = primaryChar.name;
        if (targetName === primary) return false;
        // 单字名不参与删除（与 isNameSimilar 的 minLen < 2 规则一致）
        if (targetName.length < 2 || primary.length < 2) return false;
        // 叠字昵称模式（"粥粥"和"周粥"有一个共同字"粥"，且短名是叠字）
        if (targetName.length === 2 && targetName.charAt(0) === targetName.charAt(1) && primary.includes(targetName.charAt(0))) return true;
        // 前缀/后缀模式（"陈星" 包含 "陈"，而另一个是 "陈队长"）— 仅短名≥2字
        if (primary.length >= 2 && targetName.length >= 2) {
          if (primary.startsWith(targetName) || targetName.startsWith(primary)) return true;
          if (primary.endsWith(targetName) || targetName.endsWith(primary)) return true;
        }
        // 共同字符占比（与 isNameSimilar 的 0.8 阈值统一）
        const primaryChars = new Set([...primary]);
        const targetChars = [...targetName];
        const common = targetChars.filter(c => primaryChars.has(c)).length;
        const minLen = Math.min(primary.length, targetName.length);
        if (common / minLen >= 0.8) return true;
        return false;
      };

      const allAliases = new Set(primaryChar.aliases ?? []);
      const allChapters = new Set(primaryChar.chapters ?? []);
      let mergedBackstory = primaryChar.backstory || '';
      let mergedStates = [...(primaryChar.states ?? [])];
      let mergedRelations = [...(primaryChar.relations ?? [])];
      let mergedTags = new Set(primaryChar.tags ?? []);

      for (const name of validNames) {
        if (name !== primaryChar.name && !allAliases.has(name)) {
          allAliases.add(name);
        }
      }

      // 分类：可安全删除的 vs 不可安全删除的
      const safeToDelete: typeof otherMatched = [];
      const notSafeToDelete: typeof otherMatched = [];
      for (const other of otherMatched) {
        if (canSafelyDelete(other.name)) {
          safeToDelete.push(other);
        } else {
          notSafeToDelete.push(other);
          console.debug(
            `[AutoEntity] 别名合并安全校验拒绝: "${primaryChar.name}" ← "${other.name}" ` +
            `(无足够共同字符，疑似不同角色)`,
          );
        }
      }

      // 合并可安全删除的
      for (const other of safeToDelete) {
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

      // 不可安全删除的角色保持独立，不污染主角色的章节列表
      // 之前会把它们的章节补到主角色上，导致后续基于章节的过滤逻辑误判
      // 现在仅记录日志，两角色完全独立并存

      charState.updateCharacter(primaryChar.id, {
        aliases: Array.from(allAliases),
        chapters: Array.from(allChapters),
        backstory: mergedBackstory,
        states: mergedStates,
        relations: mergedRelations,
        tags: Array.from(mergedTags),
        updatedAt: Date.now(),
      });

      // 只删除可安全合并的角色
      for (const other of safeToDelete) {
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
      const plainText = htmlToText(currentChapter.content);
      console.debug(`[AutoEntity] 开始 SSE 扫描，纯文本长度=${plainText.length}（HTML长度=${currentChapter.content.length}）`);
      const scan = aiScan();
      if (!scan) return; // ai.scan 缺失（无提供方）：静默 return（设计 §5.3）
      // 本章只建一次索引：物品/地点再多也只做 O(1) 查重
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
      const timelinePromise = scan.scanTimelineStream(
        plainText,
        chapterOrder,
        existingEntities,
        (event) => {
          if (controller.signal.aborted) return;
          const result = processTimelineEvent(event, newEvents, projectId);
          if (result.added) {
            newEvents++;
            newRelations += result.relations;
          }
        },
        (entity: StreamEntity) => {
          if (controller.signal.aborted) return;
          if (!entity.name) return;

          if (entity.entityType === 'character') {
            const charState = useCharacterStore.getState();

            // ★ 本地兜底过滤：拦截 AI 仍可能误识别的明显非人名
            // 即使 prompt 已强调，AI 偶尔仍会输出单字名或动词+名词组合
            const singleCharVerbs = new Set([
              '按', '打', '来', '去', '说', '道', '看', '听', '走', '跑',
              '坐', '站', '吃', '喝', '拿', '放', '给', '要', '想', '做',
              '大', '小', '多', '少', '好', '坏', '是', '非', '上', '下',
              '在', '向', '从', '到', '过', '着', '了', '的', '与', '和',
            ]);
            const obviouslyNotNames = new Set([
              '主角', '反派', '配角', '路人', '群众', '朋友', '同事', '同学',
              '老师', '学生', '父亲', '母亲', '哥哥', '姐姐', '弟弟', '妹妹',
              '少年', '少女', '青年', '中年', '老人', '孩子', '医生', '护士',
              '警察', '警官', '警员', '司机', '服务员', '按摩员', '厨师',
              '皇帝', '掌门', '队长', '将军', '大人', '公子', '小姐',
            ]);
            const isLikelyNotPersonName = (name: string): boolean => {
              if (!name || name.length === 0) return true;
              // 单字名：必须是文中反复使用的姓氏，且不是常见动词/介词
              if (name.length === 1) {
                if (singleCharVerbs.has(name)) return true;
                // 单字名过于可疑，统一拦截（AI 输出的单字名几乎都是误识别）
                return true;
              }
              // 明显不是人名的词组
              if (obviouslyNotNames.has(name)) return true;
              // 超过6个字的名字极可能是句子片段
              if (name.length > 6) return true;
              // 动词+职业名词组合（如"按警员"、"打警察"）
              const verbNounPattern = /^[按打来去说道看听走跑坐站吃喝拿放给要做]\S{1,4}(员|人|者|生|师|官|长|帝|门|公|子|姐|士|兵|工)$/;
              if (verbNounPattern.test(name)) return true;
              return false;
            };

            if (isLikelyNotPersonName(entity.name)) {
              console.debug(`[AutoEntity] 本地兜底过滤拦截疑似非人名: "${entity.name}"`);
              return;
            }

            // ★ 只用精确匹配判断是否已存在，绝不用子串匹配
            // 子串匹配会导致 "周" 和 "周粥"、"林" 和 "林墨" 被误判为同一角色，
            // AI 正确识别的新角色会被吞为已有角色的别名。
            // 别名关系由 AI 的 alias_match 行专门输出，onEntity 不负责猜测。
            const existing = charState.characters.find(c =>
              c.name === entity.name ||
              c.aliases?.includes(entity.name)
            );

            if (existing) {
              // 已存在同名角色，只补充章节引用
              const chapters = new Set(existing.chapters ?? []);
              if (!chapters.has(chapterOrder)) {
                chapters.add(chapterOrder);
                charState.updateCharacter(existing.id, {
                  chapters: Array.from(chapters),
                  updatedAt: Date.now(),
                });
                newAliases++;
              }
              return;
            }

            // 完全新角色，创建
            console.debug(`[AutoEntity] 新角色: name="${entity.name}" context="${(entity.context || '').slice(0, 80)}"`);
            useCharacterStore.getState().addCharacter({
              ...entityBase(projectId),
              name: entity.name,
              backstory: entity.context || entity.description || '',
              aliases: [],
              states: [],
              relations: [],
              chapters: [chapterOrder],
              tags: [],
              // 扩展字段（AI 提取的可选信息）
              ...(entity.appearance ? { appearance: entity.appearance } : {}),
              ...(entity.personality ? { personality: entity.personality } : {}),
              ...(entity.role ? { role: entity.role } : {}),
              ...(entity.speechStyle ? { speechStyle: entity.speechStyle } : {}),
            });
            itemCtx.addEntityName(entity.name); // 同章物品撞名检查立即生效
            locationCtx.addEntityName(entity.name); // 同章地点撞名检查立即生效
            newChars++;
          } else if (entity.entityType === 'item') {
            const itemState = useItemStore.getState();
            const validation = validateItemCandidate(entity, itemCtx);
            if (!validation.accept) {
              console.debug(
                `[AutoEntity] 跳过疑似非物品 "${entity.name}": ${validation.reason}`,
              );
              return;
            }
            if (validation.existingItem) {
              // 已有物品：类型仍是未分类（other）时用 AI/后缀推断补全
              const existing = validation.existingItem;
              if (validation.type !== 'other' && (!existing.type || existing.type === 'other')) {
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
              // AI 类型优先；缺失/other 时按名称后缀兜底
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
                `[AutoEntity] 跳过疑似非地点「${entity.name}」：${result.reason}`,
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
            const newLocation: Location = {
              ...entityBase(projectId),
              name: result.name,
              description: result.description,
              states: [],
              chapters: [chapterOrder],
              tags: [],
              createdAt: now,
              updatedAt: now,
            };
            useLocationStore.getState().addLocation(newLocation);
            locationCtx.addLocation(newLocation); // 同章后续重复输出直接命中索引
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
          console.warn('[AutoEntity] 流式扫描失败', e);
        }
        return [] as StreamTimelineEvent[];
      });

      await timelinePromise;

      if (controller.signal.aborted) return;

      const freshLocations = useLocationStore.getState().locations;
      assignAutoCoords(freshLocations, useLocationStore.getState().updateLocation);

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
        console.debug(`[AutoEntity] 自动合并了 ${mergeCount} 对相似角色`);
      }

      // ★ 实体/物品都已落库，再处理积分流水（角色与关联物品才匹配得到）
      for (const credit of pendingCredits) {
        const result = processCreditTransactionShared(
          credit,
          projectId,
          chapterOrder,
          detectedIdsRef.current,
        );
        if (result.added) newCredits++;
      }

      const totalNew = newChars + newLocs + newEvents + newItems + newRelations + newTransfers + newAliases + newCredits;
      if (totalNew > 0) {
        const parts: string[] = [];
        if (newEvents > 0) parts.push(`${newEvents} 事件`);
        if (newChars > 0) parts.push(`${newChars} 角色`);
        if (newItems > 0) parts.push(`${newItems} 物品`);
        if (newLocs > 0) parts.push(`${newLocs} 地点`);
        if (newRelations > 0) parts.push(`${newRelations} 关系`);
        if (newTransfers > 0) parts.push(`${newTransfers} 装备流转`);
        if (newAliases > 0) parts.push(`${newAliases} 别名`);
        if (newCredits > 0) parts.push(`${newCredits} 积分流水`);
        dispatchToastEvent({
          type: 'success',
          message: `AI 识别完成：新增 ${parts.join('、')}`,
          duration: 4000,
        });
      }
    } catch (e) {
      if (controller.signal.aborted) {
        console.debug('[AutoEntity] 扫描被中止（章节切换或组件卸载）');
      } else if (e instanceof ScanSkippedError) {
        // ★ 后端红石开关关闭：给用户一次性提示，避免静默失败
        console.debug('[AutoEntity] 扫描被跳过：', e.reason);
        dispatchToastEvent({
          type: 'info',
          message: `AI 自动识别已关闭：${e.reason}。可在红石开关面板中开启「章节扫描」。`,
          duration: 5000,
        });
      } else {
        console.warn('[AutoEntity] AI 识别失败', e);
        // ★ 其它错误（如 AI 配置缺失、500 等）也给用户提示，避免静默失败让用户以为"AI 没识别上"
        const msg = e instanceof Error ? e.message : String(e);
        dispatchToastEvent({
          type: 'error',
          message: `AI 识别失败：${msg.slice(0, 100)}`,
          duration: 5000,
        });
      }
    } finally {
      unregister();
      if (abortRef.current === controller) abortRef.current = null;
      if (unregisterAbortRef.current === unregister) unregisterAbortRef.current = null;
    }
  }, [processTimelineEvent]);

  // 章节内容变化时触发检测
  useEffect(() => {
    const chapterId = chapterIdRef.current;
    const chapterContent = chapterContentRef.current;

    console.debug('[AutoEntity] effect 触发', { chapterId: !!chapterId, contentLen: chapterContent?.length ?? 0, lastLen: lastContentRef.current.length, changed: chapterContent !== lastContentRef.current });
    if (!chapterId || !chapterContent) return;

    if (chapterContent === lastContentRef.current) return;
    lastContentRef.current = chapterContent;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // ★ 取消标志：cleanup 时置 true，async 回调每次 await 后检查
    // 防止章节切换/组件卸载后，旧回调仍在 while 循环中用新 chapterId 发起扫描
    let cancelled = false;

    timerRef.current = setTimeout(async () => {
      // ★ 扫描进行中时不要丢弃本次触发，而是标记 pendingRef，
      // 等当前扫描结束后用最新内容再跑一次（避免"扫描期间输入新内容后停下"漏触发）
      if (isScanningRef.current) {
        pendingRescanRef.current = true;
        return;
      }
      isScanningRef.current = true;
      setIsScanning(true);

      try {
        const text = htmlToText(chapterContent).trim();
        console.debug(`[AutoEntity] 触发扫描 chapterId=${chapterId} 文本长度=${text.length}`);
        if (text.length < 20) return;

        await runAIDetection();

        // ★ 当前扫描结束后，若期间有新内容变更，再扫一次（用最新的 chapterContentRef）
        // cancelled 检查：防止章节切换/卸载后旧回调继续扫描新章节
        while (pendingRescanRef.current && !cancelled) {
          pendingRescanRef.current = false;
          if (cancelled) break;
          const latestContent = chapterContentRef.current;
          if (latestContent && latestContent !== lastContentRef.current) {
            lastContentRef.current = latestContent;
            await runAIDetection();
          }
        }
      } finally {
        isScanningRef.current = false;
        setIsScanning(false);
      }
    }, DETECT_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      // ★ 清除残留的 pendingRescan，防止下次 effect 重入时立即触发不必要的补扫
      pendingRescanRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [chapterId, chapterContent, runAIDetection]);

  useEffect(() => {
    detectedIdsRef.current.clear();
    lastContentRef.current = '';
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (unregisterAbortRef.current) {
        unregisterAbortRef.current();
        unregisterAbortRef.current = null;
      }
    };
  }, [chapterId]);

  // ★ 红石开关：scanner 关闭时立即中止在飞扫描 + 取消待触发 timer
  // 防止用户关掉开关后还在跑的扫描把实体加进来（与项目记忆"红石开关关闭时所有请求必须停止"对齐）
  useEffect(() => {
    if (scannerEnabled) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
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
    if (isScanningRef.current) {
      isScanningRef.current = false;
      setIsScanning(false);
    }
  }, [scannerEnabled]);

  return { isScanning };
}
