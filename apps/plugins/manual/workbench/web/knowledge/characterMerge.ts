import type { Character, Item, ItemHolder, Location, LocationRelation } from '@novel/shared';
import type { CharacterRelation, EntityState } from '@novel/shared';

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
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshteinDistance(a, b) / maxLen;
}

function commonCharRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set([...a]);
  const setB = new Set([...b]);
  let common = 0;
  for (const c of setA) {
    if (setB.has(c)) common++;
  }
  const minLen = Math.min(setA.size, setB.size);
  return minLen === 0 ? 0 : common / minLen;
}

function isReduplicatedNickname(full: string, nick: string): boolean {
  if (!full || !nick) return false;
  if (nick.length !== 2 || full.length < 2) return false;
  const c0 = nick.charAt(0);
  const c1 = nick.charAt(1);
  if (c0 !== c1) return false;
  return full.includes(c0);
}

export function isNameSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA === lowerB) return true;

  const minLen = Math.min(lowerA.length, lowerB.length);
  const maxLen = Math.max(lowerA.length, lowerB.length);

  // ★ 单字名不参与相似性合并（"周" 不应自动合并 "周粥"/"周队长"）
  // 单字名匹配过宽是误识别的主要来源
  if (minLen < 2) return false;

  // 1. 互相包含（要求短名 ≥ 2 字，避免 "周" 匹配 "周粥"）
  if (minLen >= 2 && (lowerA.includes(lowerB) || lowerB.includes(lowerA))) {
    // 仅当短名是长名的前缀或后缀时才合并（如 "孔明" 是 "诸葛孔明" 的后缀）
    // 避免偶然的子串关系（如 "明月" 包含 "明"）误合并
    const short = lowerA.length <= lowerB.length ? lowerA : lowerB;
    const long = lowerA.length > lowerB.length ? lowerA : lowerB;
    if (long.startsWith(short) || long.endsWith(short)) return true;
    // 非前后缀的包含关系不合并（如 "周粥" 和 "粥周" 不合并）
  }

  // 2. 叠字昵称检测（如"周粥"→"粥粥"）- 优先级最高，最明确的别名模式
  if (isReduplicatedNickname(lowerA, lowerB)) return true;
  if (isReduplicatedNickname(lowerB, lowerA)) return true;

  // 3. 长度相同的短名字（2-3字）：需要更强的相似性证据
  if (minLen === maxLen && minLen <= 3) {
    const sim = nameSimilarity(lowerA, lowerB);
    // 2字名字：必须完全相同（已在开头处理），此处不合并相似 2 字名
    if (minLen === 2) return false;
    // 3字名字：至少2字相同（编辑距离≤1）
    if (minLen === 3 && sim >= 2 / 3) return true;
  }

  // 4. 长度不同的名字：共同字符比例 ≥ 0.8（提高阈值，避免误合并）
  // 原 0.6 阈值会让 "李将军" 和 "李医生" 合并（共同字"李"+比例 0.6）
  if (maxLen - minLen >= 1) {
    const ratio = commonCharRatio(lowerA, lowerB);
    if (ratio >= 0.8) return true;
  }

  // 5. 通用：编辑距离相似度 ≥ 0.8（提高阈值）
  if (nameSimilarity(lowerA, lowerB) >= 0.8) return true;

  return false;
}

/**
 * 检查角色 A 和角色 B 是否应该合并（名字相似或别名匹配）
 */
export function shouldMergeCharacters(a: Character, b: Character): boolean {
  if (a.id === b.id) return false;
  // 名字相同
  if (a.name === b.name) return true;
  // 别名包含对方名字
  if (a.aliases?.includes(b.name)) return true;
  if (b.aliases?.includes(a.name)) return true;
  // 别名互相包含
  if (a.aliases?.some((al: string) => b.aliases?.includes(al))) return true;
  // 名字相似
  if (isNameSimilar(a.name, b.name)) return true;
  // 名字和别名相似
  if (a.aliases?.some((al: string) => isNameSimilar(al, b.name))) return true;
  if (b.aliases?.some((al: string) => isNameSimilar(al, a.name))) return true;
  return false;
}

/**
 * 选择主角色（保留较长/更正式的名字）
 */
export function pickPrimaryCharacter(a: Character, b: Character): Character {
  // 优先选择名字更长的（通常更正式）
  if (a.name.length > b.name.length) return a;
  if (b.name.length > a.name.length) return b;
  // 名字一样长，选创建时间更早的
  if (a.createdAt && b.createdAt) {
    return a.createdAt < b.createdAt ? a : b;
  }
  return a;
}

/**
 * 合并两个角色，返回合并后的主角色
 */
export function mergeTwoCharacters(primary: Character, secondary: Character): Character {
  // 合并别名
  const aliasSet = new Set([...(primary.aliases ?? []), ...(secondary.aliases ?? [])]);
  // 把次要角色的名字也加为别名
  if (secondary.name !== primary.name) {
    aliasSet.add(secondary.name);
  }
  // 移除主角色的名字
  aliasSet.delete(primary.name);

  // 合并章节
  const primaryChapters: number[] = Array.isArray(primary.chapters) ? primary.chapters.filter(c => typeof c === 'number') : [];
  const secondaryChapters: number[] = Array.isArray(secondary.chapters) ? secondary.chapters.filter(c => typeof c === 'number') : [];
  const chapterSet = new Set([...primaryChapters, ...secondaryChapters]);

  // 合并标签
  const tagSet = new Set([...(primary.tags ?? []), ...(secondary.tags ?? [])]);

  // 合并状态
  const existingStates = new Map<string, EntityState>();
  for (const s of primary.states ?? []) {
    existingStates.set(s.field, s);
  }
  for (const s of secondary.states ?? []) {
    if (!existingStates.has(s.field)) {
      existingStates.set(s.field, s);
    }
  }

  // 合并关系（去重，按 targetId）
  const existingRelations = new Map<string, CharacterRelation>();
  for (const r of primary.relations ?? []) {
    existingRelations.set(r.targetId, r);
  }
  for (const r of secondary.relations ?? []) {
    if (!existingRelations.has(r.targetId)) {
      existingRelations.set(r.targetId, r);
    } else {
      // 已存在的关系，合并描述
      const existing = existingRelations.get(r.targetId)!;
      if (r.description && !existing.description?.includes(r.description)) {
        existing.description = existing.description
          ? `${existing.description}；${r.description}`
          : r.description;
      }
    }
  }
  // 移除指向自己的关系
  existingRelations.delete(primary.id);
  existingRelations.delete(secondary.id);

  // 合并简介
  const backstoryParts: string[] = [];
  if (primary.backstory) backstoryParts.push(primary.backstory);
  if (secondary.backstory && secondary.backstory !== primary.backstory) {
    backstoryParts.push(secondary.backstory);
  }

  return {
    ...primary,
    aliases: Array.from(aliasSet),
    chapters: Array.from(chapterSet).sort((a, b) => (a as number) - (b as number)),
    tags: Array.from(tagSet),
    states: Array.from(existingStates.values()),
    relations: Array.from(existingRelations.values()),
    backstory: backstoryParts.join('\n\n'),
    updatedAt: Date.now(),
  };
}

/**
 * 更新所有物品中的持有人 ID 映射（把 oldId 替换为 newId）
 */
export function updateItemHoldersForMerge(
  items: Item[],
  oldCharId: string,
  newCharId: string,
): Item[] {
  return items.map(item => {
    if (!item.holders?.length && !item.currentHolders?.length) return item;

    // 更新 holders
    const newHolders: ItemHolder[] = (item.holders ?? []).map((h: ItemHolder) =>
      h.characterId === oldCharId ? { ...h, characterId: newCharId } : h
    );

    // 去重：同一章节同一动作同一角色只保留一条
    const seen = new Set<string>();
    const uniqueHolders = newHolders.filter(h => {
      const key = `${h.chapter}-${h.action}-${h.characterId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 更新 currentHolders
    const currentSet = new Set(item.currentHolders ?? []);
    if (currentSet.has(oldCharId)) {
      currentSet.delete(oldCharId);
      currentSet.add(newCharId);
    }

    if (
      uniqueHolders.length === (item.holders?.length ?? 0) &&
      currentSet.size === (item.currentHolders?.length ?? 0) &&
      uniqueHolders.every((h, i) => h.characterId === item.holders?.[i]?.characterId)
    ) {
      return item;
    }

    return {
      ...item,
      holders: uniqueHolders,
      currentHolders: Array.from(currentSet),
      updatedAt: Date.now(),
    };
  });
}

/**
 * 扫描并合并所有相似角色
 * 返回合并的次数
 */
export function mergeSimilarCharacters(
  characters: Character[],
  items: Item[],
): {
  mergedCharacters: Character[];
  mergedItems: Item[];
  mergeCount: number;
  /** 被合并掉的角色 id → 主角色 id（调用方用它修正地点/其它实体里指向旧 id 的引用） */
  idRemap: Map<string, string>;
} {
  if (characters.length < 2) {
    return { mergedCharacters: characters, mergedItems: items, mergeCount: 0, idRemap: new Map() };
  }

  // ★ 使用并查集优化：先一次性计算所有合并对，再统一合并
  // 避免原 O(n³) 的"每合并一对就重新扫描"问题
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // 路径压缩
    let curr = id;
    while (parent.get(curr) !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // 初始化并查集
  for (const c of characters) parent.set(c.id, c.id);

  // 一次性计算所有合并对（O(n²)）
  for (let i = 0; i < characters.length; i++) {
    for (let j = i + 1; j < characters.length; j++) {
      if (shouldMergeCharacters(characters[i]!, characters[j]!)) {
        union(characters[i]!.id, characters[j]!.id);
      }
    }
  }

  // 按组聚合
  const groups = new Map<string, Character[]>();
  for (const c of characters) {
    const root = find(c.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(c);
  }

  // 每组合并为一个角色
  let its = [...items];
  let mergeCount = 0;
  const merged: Character[] = [];
  // 被合并掉的角色 id → 主角色 id。合并完要回头修正**其他角色**指向它们的
  // 关系 —— mergeTwoCharacters 只处理主角色自己的 relations，否则别处的
  // 「师徒→已删除角色」会一直挂着一个不存在的 targetId。
  const idRemap = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }

    // 按 pickPrimaryCharacter 逻辑选主角色（名字更长、创建更早）
    let primary = group[0]!;
    for (let i = 1; i < group.length; i++) {
      const candidate = group[i]!;
      const picked = pickPrimaryCharacter(primary, candidate);
      if (picked.id !== primary.id) primary = candidate;
    }

    // 依次合并到主角色
    let result = primary;
    for (const c of group) {
      if (c.id === primary.id) continue;
      const secondary = c;
      result = mergeTwoCharacters(result, secondary);
      its = updateItemHoldersForMerge(its, secondary.id, primary.id);
      idRemap.set(secondary.id, primary.id);
      mergeCount++;
    }
    merged.push(result);
  }

  if (idRemap.size > 0) {
    const remapped = merged.map((character) => {
      const relations = character.relations ?? [];
      if (relations.length === 0) return character;
      const seen = new Set<string>();
      let changed = false;
      const next: CharacterRelation[] = [];
      for (const rel of relations) {
        const targetId = idRemap.get(rel.targetId) ?? rel.targetId;
        if (targetId === character.id) {
          changed = true;
          continue; // 指向自己（合并后同一人）的关系无意义
        }
        if (targetId !== rel.targetId) changed = true;
        const key = `${targetId}|${rel.type}`;
        if (seen.has(key)) {
          changed = true;
          continue;
        }
        seen.add(key);
        next.push(targetId === rel.targetId ? rel : { ...rel, targetId });
      }
      return changed ? { ...character, relations: next, updatedAt: Date.now() } : character;
    });
    return { mergedCharacters: remapped, mergedItems: its, mergeCount, idRemap };
  }

  return { mergedCharacters: merged, mergedItems: its, mergeCount, idRemap };
}

/**
 * 角色合并后修正地点关系里的角色引用。
 *
 * 地点关系（location.relations）指向角色 id，角色被合并删掉后那些关系就指向
 * 一个不存在的 id —— 图上看不见，但数据里留着一堆悬空边，去重索引也会失效。
 * 这里按 idRemap 改写 targetId，并把改完造成的重复关系（同一地点 + 同一主角色
 * + 同一类型）合并成一条。
 */
export function remapLocationRelations(
  locations: Location[],
  idRemap: Map<string, string>,
): Location[] {
  if (idRemap.size === 0) return locations;
  return locations.map((location) => {
    const relations = location.relations ?? [];
    if (relations.length === 0) return location;

    const seen = new Set<string>();
    let changed = false;
    const next: LocationRelation[] = [];
    for (const relation of relations) {
      const targetId = relation.targetKind === 'character'
        ? (idRemap.get(relation.targetId) ?? relation.targetId)
        : relation.targetId;
      if (targetId !== relation.targetId) changed = true;
      const key = `${relation.targetKind}|${targetId}|${relation.type}`;
      if (seen.has(key)) {
        changed = true;
        continue;
      }
      seen.add(key);
      next.push(targetId === relation.targetId ? relation : { ...relation, targetId });
    }
    return changed ? { ...location, relations: next, updatedAt: Date.now() } : location;
  });
}
