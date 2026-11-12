// ============================================================
// 系统账本 → 物品持有同步
//
// 账本里的「关联物品」表示角色在本章获得了这件东西
// （积分兑换 / 任务奖励 / 系统赠予）。记账后把它同步进物品库，
// 物品面板的「当前持有者 / 流转历史」才不会与账本脱节。
//
// 纯函数，便于单测；实际写 store 由调用方完成。
// ============================================================

import type { Item } from '@novel/shared';

/**
 * 计算同步所需的最小变更。
 * @returns null 表示无需变更（本章已有获得记录且角色已持有）
 */
export function computeCreditItemAcquisition(
  item: Item,
  characterId: string,
  chapter: number,
): Pick<Item, 'holders' | 'currentHolders'> | null {
  if (!characterId || !Number.isFinite(chapter) || chapter < 1) return null;

  const holders = item.holders ?? [];
  const alreadyRecorded = holders.some(
    (h) =>
      h.characterId === characterId &&
      h.chapter === chapter &&
      (h.action === 'gained' || h.action === 'transferred'),
  );

  const current = new Set(item.currentHolders ?? []);
  const currentChanged = !current.has(characterId);
  if (alreadyRecorded && !currentChanged) return null;

  if (currentChanged) current.add(characterId);

  return {
    holders: alreadyRecorded
      ? holders
      : [...holders, { characterId, chapter, action: 'gained' }],
    currentHolders: Array.from(current),
  };
}
