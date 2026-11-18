// ============================================================
// 系统流识别：系统绑定 + 「系统」不是角色
//
// 系统文里有两个反复出错的地方：
//   ① 谁绑定了系统 —— 这是角色的**属性**，不是一次事件。原文写「绑定成功，
//      宿主：林晚」，用户需要在角色面板上直接看到「已绑定系统」。
//   ② 「系统」不是人。物品流转里 fromCharacter 写成「系统」「系统空间」时，
//      按角色去匹配必然匹配不到，物品流转整条丢失；更糟的是后续
//      「林晚把系统给的丹药递给张三」会被当成普通角色间流转，
//      系统作为来源这一层被抹掉。
//
// 这里给出统一的判定与落库工具，自动检测 / 章节轮询 / 关系图共用。
// ============================================================

import type { Character } from '@novel/shared';
import { useCharacterStore } from '@novel-plugins/data-core/stores';

/** 角色身上用于标记「已绑定系统」的标签（固定写死，UI 以此显示徽标） */
export const SYSTEM_BIND_TAG = '系统绑定';

/** 系统名标签前缀：`系统:人生模拟器`，便于在角色标签里保留系统名字 */
export const SYSTEM_NAME_TAG_PREFIX = '系统:';

/** 系统实体名（不是角色）：物品流转 / 关系断言里出现这些都不该去找人 */
const SYSTEM_NAMES = [
  '系统', '系统商城', '系统空间', '系统面板', '系统奖励', '系统提示', '系统仓库',
  '系统背包', '任务面板', '属性面板', '任务栏', '主神', '主神空间', '光幕', '面板',
];

/** 判断一个名字是否指「系统」而不是某个人 */
export function isSystemEntityName(name?: string): boolean {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return false;
  if (SYSTEM_NAMES.includes(trimmed)) return true;
  // 「系统」开头的界面名（系统商店、系统公告…）也算系统，但不要吞掉人名
  // （如「系统」当姓的极罕见，这里限定前缀 + 后缀为界面类词）
  if (/^系统/.test(trimmed) && /(商城|空间|面板|奖励|提示|仓库|背包|商店|公告|消息)$/.test(trimmed)) {
    return true;
  }
  return false;
}

export interface SystemBindRecord {
  bindType: 'system_bind';
  characterName: string;
  /** 系统名（原文里写的名字，如「人生模拟器」），可空 */
  systemName?: string;
  /** bind=绑定/激活；unbind=解绑/剥离 */
  action?: 'bind' | 'unbind';
  context?: string;
}

export interface ApplySystemBindResult {
  changed: boolean;
  characterId?: string;
  reason?: string;
}

/** 按精确名/别名找角色（不做子串匹配，避免把「系统」挂到名字像的人身上） */
function findCharacterByName(name: string, characters: Character[]): Character | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return characters.find(
    (c) => c.name === trimmed || (c.aliases ?? []).includes(trimmed),
  );
}

/** 角色是否已绑定系统（UI 用） */
export function isSystemBound(character: Pick<Character, 'tags'>): boolean {
  return (character.tags ?? []).includes(SYSTEM_BIND_TAG);
}

/**
 * 落库一条系统绑定/解绑记录。
 *
 * 绑定：补 `系统绑定` 标签（幂等）；有系统名时再补 `系统:<名字>`。
 * 解绑：移除所有 `系统绑定` / `系统:*` 标签。
 */
export function applySystemBind(
  bind: SystemBindRecord,
  projectId: string,
): ApplySystemBindResult {
  const state = useCharacterStore.getState();
  const characters = state.characters.filter((c) => c.projectId === projectId);
  const character = findCharacterByName(bind.characterName, characters);
  if (!character) return { changed: false, reason: '角色未解析' };

  const action = bind.action ?? 'bind';
  const tags = new Set(character.tags ?? []);
  const before = tags.size;

  if (action === 'unbind') {
    for (const tag of [...tags]) {
      if (tag === SYSTEM_BIND_TAG || tag.startsWith(SYSTEM_NAME_TAG_PREFIX)) tags.delete(tag);
    }
  } else {
    tags.add(SYSTEM_BIND_TAG);
    const systemName = (bind.systemName ?? '').trim();
    // 系统名本身不能是「系统」这种泛称，否则标签没有信息量
    if (systemName && systemName !== '系统' && !isSystemEntityName(systemName)) {
      tags.add(`${SYSTEM_NAME_TAG_PREFIX}${systemName}`);
    }
  }

  if (tags.size === before) return { changed: false, characterId: character.id };
  state.updateCharacter(character.id, { tags: Array.from(tags), updatedAt: Date.now() });
  return { changed: true, characterId: character.id };
}

/**
 * 手动编辑用的纯函数：按「是否绑定 + 系统名」算出新的标签数组。
 *
 * UI 的开关/输入框都走它，避免各自拼标签造成重复或残留：
 *   · 绑定：确保有「系统绑定」；名字非空且不是泛称时写入「系统:名字」，并替换旧系统名；
 *   · 解绑：一次性清掉「系统绑定」与所有「系统:*」；
 *   · 未变更时返回原数组引用，调用方可据此跳过写库。
 */
export function withSystemBinding(
  tags: string[],
  bound: boolean,
  systemName?: string,
): string[] {
  const current = tags ?? [];
  const rest = current.filter((t) => t !== SYSTEM_BIND_TAG && !t.startsWith(SYSTEM_NAME_TAG_PREFIX));
  if (!bound) return rest.length === current.length ? current : rest;

  const next = [...rest, SYSTEM_BIND_TAG];
  const name = (systemName ?? '').trim();
  if (name && name !== '系统' && !isSystemEntityName(name)) {
    next.push(`${SYSTEM_NAME_TAG_PREFIX}${name}`);
  }

  const unchanged =
    next.length === current.length && next.every((tag) => current.includes(tag));
  return unchanged ? current : next;
}

/** 取角色绑定的系统名（没有返回 undefined） */
export function systemNameOf(character: Pick<Character, 'tags'>): string | undefined {
  const tag = (character.tags ?? []).find((t) => t.startsWith(SYSTEM_NAME_TAG_PREFIX));
  return tag ? tag.slice(SYSTEM_NAME_TAG_PREFIX.length) : undefined;
}