// ============================================================
// 扫描处理器共享逻辑
// 抽取 useAutoEntityDetection 和 useLatestChapterPolling 的公共处理逻辑
// ============================================================

import { nanoid } from 'nanoid';
import {
  useCharacterStore,
  useCreditStore,
  useLocationStore,
  useItemStore,
  useTimelineStore,
} from '@novel-plugins/data-core/stores';
import type { CreditTransaction, Item, Location, TimelineEvent } from '@novel/shared';
import { mergeSimilarCharacters, remapLocationRelations, updateItemHoldersForMerge } from '../knowledge/characterMerge';
import { computeCreditItemAcquisition } from '../knowledge/creditItemSync';
import {
  normalizeItemType,
  prepareItemContext,
  validateItemCandidate,
  type PreparedItemContext,
} from '../knowledge/itemRecognition';
import {
  applyLocationCandidate,
  prepareLocationContext,
  type PreparedLocationContext,
} from '../knowledge/locationRecognition';
import { isItemAutoDetectEnabled } from '../stores/entityDetectionPrefs';
import { isSystemEntityName } from '../knowledge/systemRecognition';

// 保留原来的导出路径（useAutoEntityDetection 从这里 import normalizeItemType）
export { normalizeItemType };
import type {
  StreamAliasMatch,
  StreamCreditTransaction,
  StreamEntity,
  StreamItemTransfer,
  StreamTimelineEvent,
} from './aiScanCapability';

// ---- 事件去重工具函数 ----

/** 归一化字符串：去标点、去空格、转小写 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
}

/** 计算两个字符串的编辑距离相似度 (Levenshtein) */
export function levenshteinDistance(a: string, b: string): number {
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
export function stringSimilarity(s1: string, s2: string): number {
  const n1 = normalizeText(s1);
  const n2 = normalizeText(s2);
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1;
  const maxLen = Math.max(n1.length, n2.length);
  return 1 - levenshteinDistance(n1, n2) / maxLen;
}

/**
 * 判断两个事件是否为同一事件。
 *
 * ★ 2026-11-07：旧阈值（标题 0.55 / 描述 0.65 / 双 0.4）对中文太松——
 *   「陈星进入藏经阁」与「陈星离开藏经阁」只差两个字，编辑距离相似度
 *   0.71 > 0.55，稳定被误判成重复，事件就这样被静默吞掉（表现为「漏提取」）。
 *   现在只承认三种确定性更高的重复：
 *     ① 标题几乎一致（≥0.85，标点/空格差异）；
 *     ② 标题较像且描述高度重合（模型换了个说法重提同一件事）；
 *     ③ 描述几乎一致、标题措辞不同。
 *   宁可留下一条待人工合并，也不要再把不同事件当成重复删掉。
 */
export function isDuplicateEvent(existingTitle: string, existingDesc: string, newTitle: string, newDesc: string): boolean {
  const titleSim = stringSimilarity(existingTitle, newTitle);
  const descSim = stringSimilarity(existingDesc, newDesc);
  if (titleSim >= 0.85) return true;
  if (titleSim >= 0.6 && descSim >= 0.8) return true;
  if (descSim >= 0.9 && titleSim >= 0.4) return true;
  return false;
}

/** 实体基础字段 */
export function entityBase(projectId: string) {
  const now = Date.now();
  return { id: nanoid(), projectId, createdAt: now, updatedAt: now };
}

/**
 * 构建角色名字 → ID 的映射表（含别名）
 */
export function buildCharNameToIdMap(characters: Array<{ name: string; id: string; aliases?: string[] }>): Map<string, string> {
  const charNameToId = new Map<string, string>();
  for (const c of characters) {
    if (c.name && !charNameToId.has(c.name)) charNameToId.set(c.name, c.id);
    for (const alias of c.aliases ?? []) {
      if (alias && !charNameToId.has(alias)) charNameToId.set(alias, c.id);
    }
  }
  return charNameToId;
}

/**
 * 查找角色ID：先精确匹配（含别名表），再保守地做包含匹配。
 *
 * ★ 2026-11-07：旧的 `characters.find(... includes ...)` 取的是**第一个**包含项，
 *   单字名（「陈」「王」）会把事件稳定挂到名单里第一个姓陈/姓王的角色上，
 *   这就是「角色挂错」的主要来源。现在：
 *   1. 单字名不再参与模糊匹配（只认精确名/别名）；
 *   2. 包含匹配按「共同匹配长度」取最长者；
 *   3. 最高分并列且指向不同角色时视为歧义，返回 null（宁可不挂，也不挂错）。
 */
export function findCharIdByName(name: string, charNameToId: Map<string, string>, characters: Array<{ id: string; name: string; aliases?: string[] }>): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  // 精确匹配
  const exact = charNameToId.get(trimmed);
  if (exact) return exact;

  // 单字名歧义太大，只接受精确名/别名
  if (trimmed.length < 2) return null;

  const scored = characters
    .map((c) => {
      let best = 0;
      const candidates = [c.name, ...(c.aliases ?? [])];
      for (const candidate of candidates) {
        if (!candidate || candidate.length < 2) continue;
        if (candidate.includes(trimmed) || trimmed.includes(candidate)) {
          best = Math.max(best, Math.min(candidate.length, trimmed.length));
        }
      }
      return { id: c.id, score: best };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  const top = scored[0]!;
  const runnerUp = scored.find((item) => item.id !== top.id);
  if (runnerUp && runnerUp.score === top.score) return null; // 歧义：多个角色同样匹配
  return top.id;
}

/**
 * 处理时间线事件的公共逻辑
 * @returns { added: boolean; relations: number }
 */
export function processTimelineEventShared(
  event: StreamTimelineEvent,
  idx: number,
  projectId: string,
  chapterOrder: number,
  detectedIdsRef: Set<string>,
): { added: boolean; relations: number } {
  if (!event.title) return { added: false, relations: 0 };

  // 1. 内存去重：本次扫描内的重复
  const eventKey = `${chapterOrder}-${event.title}-${event.type}`;
  let _hash = 5381;
  for (let i = 0; i < eventKey.length; i++) {
    _hash = ((_hash << 5) + _hash + eventKey.charCodeAt(i)) | 0;
  }
  const hashKey = (_hash >>> 0).toString(36);

  if (detectedIdsRef.has(hashKey)) return { added: false, relations: 0 };
  detectedIdsRef.add(hashKey);

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
    console.debug('[ScanProcessor] 跳过重复事件:', event.title);
    return { added: false, relations: 0 };
  }

  // 构建 名字 → ID 索引（含别名）；只限当前项目，避免串项目匹配
  const existingCharacters = useCharacterStore
    .getState()
    .characters.filter(c => c.projectId === projectId);
  const charNameToId = buildCharNameToIdMap(existingCharacters);

  // ★ 精确名/别名优先，其次走与物品流转一致的模糊匹配（包含关系），
  //   避免 AI 用「星儿」而角色库里叫「陈星」时事件丢失角色关联。
  const matchedIds = Array.from(
    new Set(
      (event.characterNames ?? [])
        .map(name => findCharIdByName(name, charNameToId, existingCharacters))
        .filter((id): id is string => Boolean(id)),
    ),
  );

  // order 去冲突：用 chapterOrder * 100 + 事件序号
  const safeOrder = chapterOrder * 100 + idx;

  // 写入时间线 store
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

  // ★ 2026-11 关系识别改造：不再由「同一事件里出现」推断关系。
  //   一处群戏里五个人同场，旧逻辑会给两两连上十条「关联」，把真实关系
  //   （师徒/父子/仇人）淹没在噪声里，图上每个主角都成了中心枢纽。
  //   关系改由扫描的 relation 断言行提供，经 knowledge/relationRecognition
  //   做类型归一 / 实体解析 / 证据接地后落库（见 relationApply）。
  //   事件里的 characterIds 仍然保留 —— 那是「谁在场」，不是「谁和谁什么关系」。

  return { added: true, relations: 0 };
}

/**
 * 处理正文扫描出的积分流水（系统文）。
 * 只记录能匹配到角色的流水；宁可不记，也不挂到错的人身上。
 */
export function processCreditTransactionShared(
  credit: StreamCreditTransaction,
  projectId: string,
  chapterOrder: number,
  detectedIdsRef: Set<string>,
): { added: boolean; itemLinked: boolean } {
  if (!credit.characterName) return { added: false, itemLinked: false };

  // 1. 本次扫描内去重
  const eventKey = `credit:${chapterOrder}-${credit.characterName}-${credit.action}-${credit.amount}-${credit.reason ?? ''}`;
  let hash = 5381;
  for (let i = 0; i < eventKey.length; i++) {
    hash = ((hash << 5) + hash + eventKey.charCodeAt(i)) | 0;
  }
  const hashKey = (hash >>> 0).toString(36);
  if (detectedIdsRef.has(hashKey)) return { added: false, itemLinked: false };
  detectedIdsRef.add(hashKey);

  // 2. 角色匹配（仅当前项目）
  const characters = useCharacterStore
    .getState()
    .characters.filter((c) => c.projectId === projectId);
  const charNameToId = buildCharNameToIdMap(characters);
  const characterId = findCharIdByName(credit.characterName, charNameToId, characters);
  if (!characterId) {
    console.debug('[ScanProcessor] 积分流水缺少可匹配角色，跳过:', credit.characterName);
    return { added: false, itemLinked: false };
  }

  const amount = credit.action === 'gift' ? 0 : credit.amount;
  if (credit.action !== 'gift' && amount <= 0) return { added: false, itemLinked: false };

  // 4. 关联物品（不在此处新建物品；实体行会先输出并由 onEntity 建好）
  const projectItems = useItemStore.getState().items.filter((i) => i.projectId === projectId);
  const item = credit.itemName
    ? (projectItems.find((i) => i.name === credit.itemName) ??
      (credit.itemName.length >= 2
        ? projectItems.find(
            (i) => i.name.includes(credit.itemName!) || credit.itemName!.includes(i.name),
          )
        : undefined))
    : undefined;

  // 3. 持久化去重：同角色/章节/类型/金额/关联物品视为同一笔。
  //
  //   ★ 不再比对 reason 文本。实测重复扫描同一章时，模型会把
  //   「首次绑定系统，初始积分」改写成「首次绑定系统获初始积分」——
  //   按文本相等去重就漏判，账本里同一笔出现两次（实测 ch1 出现 gain 100 两条）。
  //   关联物品参与比对：同一章里两件**不同物品**的赠予必须各记一条；
  //   没有关联物品时只按 类型+金额 判重。
  const itemKeyOfTx = (relatedItemId?: string): string => {
    if (!relatedItemId) return '';
    const name = projectItems.find((i) => i.id === relatedItemId)?.name ?? '';
    return normalizeText(name);
  };
  // ★ 只认「解析到的物品」：itemName 指向库里不存在的物品（如技能名「基础剑法」）时
  //   没有 id 可比，退回按 类型+金额 判重 —— 否则同一笔 spend 会被记两次。
  const creditItemKey = item ? normalizeText(item.name) : '';
  const existing = useCreditStore
    .getState()
    .creditTransactions.filter(
      (t) => t.projectId === projectId && t.characterId === characterId && t.chapter === chapterOrder,
    );
  const duplicate = existing.some(
    (t) =>
      t.type === credit.action &&
      (t.amount ?? 0) === amount &&
      itemKeyOfTx(t.relatedItemId) === creditItemKey,
  );
  if (duplicate) {
    console.debug('[ScanProcessor] 跳过重复积分流水:', credit.reason ?? credit.action);
    return { added: false, itemLinked: false };
  }

  const now = Date.now();
  const tx: CreditTransaction = {
    id: nanoid(),
    projectId,
    characterId,
    chapter: chapterOrder,
    type: credit.action,
    amount,
    ...(credit.reason ? { reason: credit.reason } : {}),
    ...(item ? { relatedItemId: item.id } : {}),
    tags: ['AI识别'],
    createdAt: now,
    updatedAt: now,
  };
  useCreditStore.getState().addCreditTransaction(tx);

  // 5. 兑换/奖励/赠予的物品同步进角色持有
  let itemLinked = false;
  if (item) {
    const updates = computeCreditItemAcquisition(item, characterId, chapterOrder);
    if (updates) {
      useItemStore.getState().updateItem(item.id, updates);
      itemLinked = true;
    }
  }

  return { added: true, itemLinked };
}

/**
 * 处理物品流转的公共逻辑
 */
export function handleItemTransferShared(
  transfer: StreamItemTransfer,
  chapterOrder: number,
  controller: AbortController,
  projectId?: string,
): number {
  if (controller.signal.aborted) return 0;
  const itemState = useItemStore.getState();
  const charState = useCharacterStore.getState();

  const inProject = <T extends { projectId: string }>(list: T[]): T[] =>
    projectId ? list.filter((x) => x.projectId === projectId) : list;

  // 按名称查找物品（支持部分匹配）；只在本项目范围内找，避免串书
  const item = inProject(itemState.items).find(i =>
    i.name === transfer.itemName ||
    i.name.includes(transfer.itemName) ||
    transfer.itemName.includes(i.name)
  );
  if (!item) return 0;

  // ★ 系统不是角色：fromCharacter/toCharacter 写成「系统/系统空间」时，
  //   不能拿去找人，否则整条流转静默丢失。
  const fromIsSystem = isSystemEntityName(transfer.fromCharacter);
  const toIsSystem = isSystemEntityName(transfer.toCharacter);

  // 构建 名字→ID 映射（含别名）
  const characters = inProject(charState.characters);
  const charNameToId = buildCharNameToIdMap(characters);

  const findCharId = (name: string): string | null =>
    findCharIdByName(name, charNameToId, characters);

  const fromId = !fromIsSystem && transfer.fromCharacter ? findCharId(transfer.fromCharacter) : null;
  const toId = !toIsSystem && transfer.toCharacter ? findCharId(transfer.toCharacter) : null;

  // 系统发放给角色：等价于该角色 gained（来源不是人，不写 lost）
  const systemIssued = fromIsSystem && !!toId;
  // 角色把物品交还/存进系统：等价于该角色 lost
  const intoSystem = toIsSystem && !!fromId;

  // 检查本章是否已经记录过相同流转（去重）
  const existingInChapter = item.holders.some(
    h => h.chapter === chapterOrder &&
         ((fromId && h.characterId === fromId && h.action === 'lost') ||
          (toId && h.characterId === toId && (h.action === 'gained' || h.action === 'transferred')))
  );
  if (existingInChapter && transfer.action !== 'held') return 0;

  const newHolders = [...item.holders];
  const currentHoldersSet = new Set(item.currentHolders ?? []);
  let currentChanged = false;
  let transferCount = 0;

  if (transfer.action === 'held') {
    // ★ 持有/使用/穿戴（无流转变化）：仅确保当前持有者包含该角色，不写流转史
    if (toId && !currentHoldersSet.has(toId)) {
      currentHoldersSet.add(toId);
      currentChanged = true;
    }
  } else if (systemIssued || (transfer.action === 'gained' && toId)) {
    // 系统发放，或普通获得：都记目标角色 gained
    newHolders.push({ characterId: toId!, chapter: chapterOrder, action: 'gained' });
    currentHoldersSet.add(toId!);
    transferCount++;
  } else if (intoSystem || (transfer.action === 'lost' && (fromId || toId))) {
    const loserId = fromId || toId!;
    newHolders.push({ characterId: loserId, chapter: chapterOrder, action: 'lost' });
    currentHoldersSet.delete(loserId);
    transferCount++;
  } else if (transfer.action === 'transferred' && fromId && toId) {
    newHolders.push({ characterId: fromId, chapter: chapterOrder, action: 'lost' });
    newHolders.push({ characterId: toId, chapter: chapterOrder, action: 'gained' });
    currentHoldersSet.delete(fromId);
    currentHoldersSet.add(toId);
    transferCount++;
  }

  if (transferCount > 0 || currentChanged || newHolders.length !== item.holders.length) {
    itemState.updateItem(item.id, {
      holders: newHolders,
      currentHolders: Array.from(currentHoldersSet),
      updatedAt: Date.now(),
    });
  }

  // ★ 系统发放的物品要在账本里留一笔 gift（模型偶尔只给流转行，不给流水）。
  //   这里补记；若模型已经输出过同一条，credits 的去重会拦住。
  if (systemIssued && toId) {
    const receiver = characters.find((c) => c.id === toId);
    if (receiver) {
      processCreditTransactionShared(
        {
          creditType: 'credit_transaction',
          action: 'gift',
          characterName: receiver.name,
          amount: 0,
          reason: `系统发放：${item.name}`,
          itemName: item.name,
          chapterOrder,
        },
        projectId ?? receiver.projectId,
        chapterOrder,
        new Set(),
      );
    }
  }

  return transferCount;
}

/**
 * 处理别名匹配的公共逻辑
 * @returns 新增的别名数量
 */
export function handleAliasMatchShared(
  aliasMatch: StreamAliasMatch,
  projectId: string,
  controller: AbortController,
  safeMode: boolean = false,
): number {
  if (controller.signal.aborted) return 0;
  const charState = useCharacterStore.getState();
  const allNames = [aliasMatch.primaryName, ...aliasMatch.aliases].filter(Boolean);
  if (allNames.length < 2) return 0;

  // 安全模式：过滤明显不是人名的词
  let validNames = allNames;
  if (safeMode) {
    const obviouslyNotNames = new Set([
      '主角', '反派', '配角', '路人甲', '路人乙', '路人', '群众',
      '女朋友', '男朋友', '朋友', '同事', '同学', '老师', '学生',
      '父亲', '母亲', '爸爸', '妈妈', '哥哥', '姐姐', '弟弟', '妹妹',
      '大嗓门', '小个子', '大个子', '胖子', '瘦子', '老头', '老太',
      '少年', '少女', '青年', '中年', '老人', '孩子', '小孩',
      '黑衣人', '白衣人', '红衣人', '为首之人', '那少年', '这女子',
    ]);
    validNames = allNames.filter(n => n.length >= 2 && !obviouslyNotNames.has(n));
    if (validNames.length < 2) return 0;
  }

  // 找出已存在的角色
  const matchedCharIds = new Set<string>();
  for (const name of validNames) {
    for (const c of charState.characters) {
      if (c.projectId !== projectId) continue;
      if (c.name === name) { matchedCharIds.add(c.id); continue; }
      if (c.aliases?.includes(name)) { matchedCharIds.add(c.id); continue; }
      if (!safeMode) {
        // 非安全模式允许子串匹配
        if (c.name.includes(name) || name.includes(c.name)) { matchedCharIds.add(c.id); continue; }
        if (c.aliases?.some(a => a.includes(name) || name.includes(a))) { matchedCharIds.add(c.id); continue; }
      }
    }
  }

  const matchedChars = charState.characters.filter(c => matchedCharIds.has(c.id));
  if (matchedChars.length === 0) return 0;

  const primaryChar = matchedChars.find(c => c.name === aliasMatch.primaryName)
    || matchedChars.find(c => aliasMatch.aliases.some(a => c.name === a || c.aliases?.includes(a)))
    || matchedChars[0];

  if (!primaryChar) return 0;

  const otherMatched = matchedChars.filter(c => c.id !== primaryChar.id);

  // 安全模式下的额外校验
  if (safeMode) {
    const canSafelyDelete = (targetName: string): boolean => {
      const primary = primaryChar.name;
      if (targetName === primary) return false;
      if (targetName.length < 2 || primary.length < 2) return false;
      if (targetName.length === 2 && targetName.charAt(0) === targetName.charAt(1) && primary.includes(targetName.charAt(0))) return true;
      if (primary.length >= 2 && targetName.length >= 2) {
        if (primary.startsWith(targetName) || targetName.startsWith(primary)) return true;
        if (primary.endsWith(targetName) || targetName.endsWith(primary)) return true;
      }
      const primaryChars = new Set([...primary]);
      const targetChars = [...targetName];
      const common = targetChars.filter(c => primaryChars.has(c)).length;
      const minLen = Math.min(primary.length, targetName.length);
      if (common / minLen >= 0.8) return true;
      return false;
    };

    const safeToDelete: typeof otherMatched = [];
    const notSafeToDelete: typeof otherMatched = [];
    for (const other of otherMatched) {
      if (canSafelyDelete(other.name)) {
        safeToDelete.push(other);
      } else {
        notSafeToDelete.push(other);
        console.debug(
          `[ScanProcessor] 别名合并安全校验拒绝: "${primaryChar.name}" ← "${other.name}"`,
        );
      }
    }

    // 合并可安全删除的
    const allAliases = new Set(primaryChar.aliases ?? []);
    const allChapters = new Set(primaryChar.chapters ?? []);
    let mergedBackstory = primaryChar.backstory || '';
    const mergedStates = [...(primaryChar.states ?? [])];
    const mergedRelations = [...(primaryChar.relations ?? [])];
    const mergedTags = new Set(primaryChar.tags ?? []);

    for (const name of validNames) {
      if (name !== primaryChar.name && !allAliases.has(name)) {
        allAliases.add(name);
      }
    }

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

    return allAliases.size - (primaryChar.aliases?.length ?? 0);
  } else {
    // 非安全模式：简单合并
    const allAliases = new Set(primaryChar.aliases ?? []);
    const allChapters = new Set(primaryChar.chapters ?? []);
    let mergedBackstory = primaryChar.backstory || '';
    const mergedStates = [...(primaryChar.states ?? [])];
    const mergedRelations = [...(primaryChar.relations ?? [])];
    const mergedTags = new Set(primaryChar.tags ?? []);

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

    return allAliases.size - (primaryChar.aliases?.length ?? 0);
  }
}

/**
 * 处理实体（角色/物品/地点）的公共逻辑
 *
 * 批量扫描时请传入预建的 itemContext（每章一次，需包含 chapterContent），
 * 否则本函数会按每次调用重建索引（万级物品库下是 O(n) 扫描）。
 * @returns { chars: number; items: number; locs: number; aliases: number }
 */
export function processEntityShared(
  entity: StreamEntity,
  projectId: string,
  chapterOrder: number,
  controller: AbortController,
  safeMode: boolean = false,
  chapterContent?: string,
  itemContext?: PreparedItemContext,
  locationContext?: PreparedLocationContext,
): { chars: number; items: number; locs: number; aliases: number } {
  if (controller.signal.aborted) return { chars: 0, items: 0, locs: 0, aliases: 0 };
  if (!entity.name) return { chars: 0, items: 0, locs: 0, aliases: 0 };

  let chars = 0;
  let items = 0;
  let locs = 0;
  let aliases = 0;

  if (entity.entityType === 'character') {
    const charState = useCharacterStore.getState();

    // 安全模式：本地兜底过滤
    if (safeMode) {
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
        if (name.length === 1) {
          if (singleCharVerbs.has(name)) return true;
          return true;
        }
        if (obviouslyNotNames.has(name)) return true;
        if (name.length > 6) return true;
        const verbNounPattern = /^[按打来去说道看听走跑坐站吃喝拿放给要做]\S{1,4}(员|人|者|生|师|官|长|帝|门|公|子|姐|士|兵|工)$/;
        if (verbNounPattern.test(name)) return true;
        return false;
      };

      if (isLikelyNotPersonName(entity.name)) {
        console.debug(`[ScanProcessor] 本地兜底过滤拦截疑似非人名: "${entity.name}"`);
        return { chars: 0, items: 0, locs: 0, aliases: 0 };
      }
    }

    // 检查是否已存在
    const existing = safeMode
      ? charState.characters.find(c =>
          c.name === entity.name ||
          c.aliases?.includes(entity.name)
        )
      : charState.characters.find(c =>
          c.name === entity.name ||
          c.aliases?.includes(entity.name) ||
          entity.name.includes(c.name) ||
          c.name.includes(entity.name)
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
        aliases++;
      }
      return { chars: 0, items: 0, locs: 0, aliases };
    }

    // 完全新角色，创建
    console.debug(`[ScanProcessor] 新角色: name="${entity.name}"`);
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
    itemContext?.addEntityName(entity.name); // 同章物品撞名检查立即生效
    locationContext?.addEntityName(entity.name); // 同章地点撞名检查立即生效
    chars++;
  } else if (entity.entityType === 'item') {
    const itemState = useItemStore.getState();
    const itemCtx = itemContext ?? prepareItemContext({
      chapterContent,
      existingItems: itemState.items.filter(i => i.projectId === projectId),
      existingCharacters: useCharacterStore
        .getState()
        .characters.filter(c => c.projectId === projectId),
      existingLocations: useLocationStore
        .getState()
        .locations.filter(l => l.projectId === projectId),
    });
    const validation = validateItemCandidate(entity, itemCtx);
    if (!validation.accept) {
      console.debug(`[ScanProcessor] 跳过疑似非物品 "${entity.name}": ${validation.reason}`);
      return { chars: 0, items: 0, locs: 0, aliases: 0 };
    }
    // ★ 物品自动识别关闭：只给已有物品补类型，不再新建
    if (!isItemAutoDetectEnabled() && !validation.existingItem) {
      console.debug(`[ScanProcessor] 物品自动识别已关闭，跳过新建 "${validation.name}"`);
      return { chars: 0, items: 0, locs: 0, aliases: 0 };
    }
    if (validation.existingItem) {
      // 已存在的物品：类型还是未分类（other）时用 AI/后缀推断补上
      const existing = validation.existingItem;
      if (validation.type !== 'other' && (!existing.type || existing.type === 'other')) {
        itemState.updateItem(existing.id, { type: validation.type, updatedAt: Date.now() });
      }
      return { chars: 0, items: 0, locs: 0, aliases: 0 };
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
    locationContext?.addEntityName(newItem.name); // 同章地点撞名检查立即生效
    items++;
  } else if (entity.entityType === 'location') {
    // 与自动检测 / 轮询扫描共用同一套确定性校验，不再只看「同名」就落库
    const locationCtx = locationContext ?? prepareLocationContext({
      chapterContent,
      existingLocations: useLocationStore
        .getState()
        .locations.filter(l => l.projectId === projectId),
      existingCharacters: useCharacterStore
        .getState()
        .characters.filter(c => c.projectId === projectId),
      existingItems: useItemStore
        .getState()
        .items.filter(i => i.projectId === projectId),
    });
    const result = applyLocationCandidate(entity, chapterOrder, locationCtx);
    if (result.kind === 'reject') {
      console.debug(
        `[ScanProcessor] 跳过疑似非地点 "${entity.name}": ${result.reason}`,
      );
      return { chars: 0, items: 0, locs: 0, aliases: 0 };
    }
    if (result.kind === 'link') {
      if (!result.changed) return { chars: 0, items: 0, locs: 0, aliases: 0 };
      const updates = {
        chapters: result.chapters,
        ...(result.description !== undefined ? { description: result.description } : {}),
        updatedAt: Date.now(),
      };
      useLocationStore.getState().updateLocation(result.location.id, updates);
      locationCtx.addLocation({ ...result.location, ...updates });
      itemContext?.addEntityName(result.location.name);
      return { chars: 0, items: 0, locs: 0, aliases: 0 };
    }
    const now = Date.now();
    const newLoc: Location = {
      ...entityBase(projectId),
      name: result.name,
      description: result.description,
      states: [],
      relations: [],
      chapters: [chapterOrder],
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    useLocationStore.getState().addLocation(newLoc);
    locationCtx.addLocation(newLoc);
    itemContext?.addEntityName(result.name); // 同章物品撞名检查立即生效
    locs++;
  }

  return { chars, items, locs, aliases };
}

/**
 * 扫描完成后合并相似角色
 */
export function mergeSimilarCharactersAfterScan(projectId: string): number {
  const charState = useCharacterStore.getState();
  const itemState = useItemStore.getState();
  const projectChars = charState.characters.filter(c => c.projectId === projectId);
  const projectItems = itemState.items.filter(i => i.projectId === projectId);
  const { mergedCharacters, mergedItems, mergeCount, idRemap } = mergeSimilarCharacters(projectChars, projectItems);
  if (mergeCount > 0) {
    const otherChars = charState.characters.filter(c => c.projectId !== projectId);
    const otherItems = itemState.items.filter(i => i.projectId !== projectId);
    charState.setCharacters([...otherChars, ...mergedCharacters]);
    itemState.setItems([...otherItems, ...mergedItems]);
    // 地点关系里的角色引用同步改写（否则留下指向已删角色的悬空边）
    if (idRemap.size > 0) {
      const locState = useLocationStore.getState();
      const remapped = remapLocationRelations(
        locState.locations.filter(l => l.projectId === projectId),
        idRemap,
      );
      const otherLocs = locState.locations.filter(l => l.projectId !== projectId);
      locState.setLocations([...otherLocs, ...remapped]);
    }
    console.debug(`[ScanProcessor] 自动合并了 ${mergeCount} 对相似角色`);
  }
  return mergeCount;
}
