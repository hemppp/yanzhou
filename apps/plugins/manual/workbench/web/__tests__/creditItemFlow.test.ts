// ============================================================
// 系统流：积分流水 → 物品持有 的落库链路
//
// 用真实扫描输出的实测结果当夹具，
// 验证「系统发放/兑换的物品」是否真的进了角色持有 —— 这是系统流最核心的
// 数据一致性要求：账本上写了兑换某物，物品库里就该有它的持有记录。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character, Item } from '@novel/shared';
import {
  useCharacterStore,
  useCreditStore,
  useItemStore,
} from '@novel-plugins/data-core/stores';
import { processCreditTransactionShared } from '../hooks/useScanProcessors';

function character(id: string, name: string): Character {
  return {
    id,
    projectId: 'p1',
    name,
    aliases: [],
    states: [],
    relations: [],
    chapters: [1],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function item(id: string, name: string, type = 'prop'): Item {
  return {
    id,
    projectId: 'p1',
    name,
    type,
    states: [],
    holders: [],
    currentHolders: [],
    relations: [],
    chapters: [1],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  useCharacterStore.setState({ characters: [character('c1', '林晚')] });
  useItemStore.setState({
    items: [
      item('i1', '青锋剑', 'weapon'),
      item('i2', '回气丹', 'potion'),
      item('i3', '玄铁护腕', 'armor'),
      item('i4', '妖狼牙', 'treasure'),
      item('i5', '基础剑法', 'scroll'),
    ],
  });
  useCreditStore.setState({ creditTransactions: [] });
});

describe('系统流：积分兑换/赠予 → 物品持有', () => {
  it('兑换功法：账本记 spend，物品不再新建但关联正确', () => {
    const result = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'spend',
        characterName: '林晚',
        amount: 60,
        reason: '在系统商城兑换基础剑法',
        itemName: '基础剑法',
        chapterOrder: 2,
      },
      'p1',
      2,
      new Set(),
    );

    expect(result).toEqual({ added: true, itemLinked: true });
    const tx = useCreditStore.getState().creditTransactions[0]!;
    expect(tx).toMatchObject({ type: 'spend', amount: 60, relatedItemId: 'i5' });

    const skill = useItemStore.getState().items.find((i) => i.id === 'i5')!;
    expect(skill.currentHolders).toEqual(['c1']);
    expect(skill.holders).toEqual([{ characterId: 'c1', chapter: 2, action: 'gained' }]);
  });

  it('系统赠予护腕：gift 记 0 积分，但护腕必须进持有', () => {
    const result = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'gift',
        characterName: '林晚',
        amount: 0,
        reason: '连续两次战斗胜利额外赠送',
        itemName: '玄铁护腕',
        chapterOrder: 6,
      },
      'p1',
      6,
      new Set(),
    );

    expect(result).toEqual({ added: true, itemLinked: true });
    const tx = useCreditStore.getState().creditTransactions[0]!;
    expect(tx).toMatchObject({ type: 'gift', amount: 0, relatedItemId: 'i3' });

    const armor = useItemStore.getState().items.find((i) => i.id === 'i3')!;
    expect(armor.currentHolders).toEqual(['c1']);
  });

  it('任务奖励妖狼牙：物品名在原文里写作「妖狼牙三枚」也要能匹配', () => {
    const result = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'gift',
        characterName: '林晚',
        amount: 0,
        reason: '主线任务额外奖励',
        itemName: '妖狼牙',
        chapterOrder: 9,
      },
      'p1',
      9,
      new Set(),
    );

    expect(result).toEqual({ added: true, itemLinked: true });
    const fang = useItemStore.getState().items.find((i) => i.id === 'i4')!;
    expect(fang.currentHolders).toEqual(['c1']);
  });

  it('任务完成同时给积分和物品：两条流水互不吞掉', () => {
    const gain = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'gain',
        characterName: '林晚',
        amount: 150,
        reason: '夺回青锋剑，任务完成',
        itemName: '青锋剑',
        chapterOrder: 6,
      },
      'p1',
      6,
      new Set(),
    );
    const gift = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'gift',
        characterName: '林晚',
        amount: 0,
        reason: '连续两次战斗胜利额外赠送',
        itemName: '玄铁护腕',
        chapterOrder: 6,
      },
      'p1',
      6,
      new Set(),
    );

    expect(gain.added).toBe(true);
    expect(gift.added).toBe(true);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(2);

    // 两条流水关联到不同物品，且各自都进了持有
    const blade = useItemStore.getState().items.find((i) => i.id === 'i1')!;
    const armor = useItemStore.getState().items.find((i) => i.id === 'i3')!;
    expect(blade.currentHolders).toEqual(['c1']);
    expect(armor.currentHolders).toEqual(['c1']);
  });

  it('余额变化不能当成流水（重复扫描同一章不重复入账）', () => {
    const credit = {
      creditType: 'credit_transaction' as const,
      action: 'gain' as const,
      characterName: '林晚',
      amount: 200,
      reason: '完成新手任务',
      chapterOrder: 3,
    };
    expect(processCreditTransactionShared(credit, 'p1', 3, new Set()).added).toBe(true);
    expect(processCreditTransactionShared(credit, 'p1', 3, new Set()).added).toBe(false);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(1);
  });
});

describe('系统流：重复扫描的去重口径', () => {
  it('换了措辞也不重复入账（按 类型+金额+关联物品 判重）', () => {
    const a = { creditType: 'credit_transaction' as const, action: 'gain' as const, characterName: '林晚', amount: 100, reason: '首次绑定系统，初始积分', chapterOrder: 1 };
    const b = { ...a, reason: '首次绑定系统获初始积分' };
    expect(processCreditTransactionShared(a, 'p1', 1, new Set()).added).toBe(true);
    expect(processCreditTransactionShared(b, 'p1', 1, new Set()).added).toBe(false);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(1);
  });

  it('同一章赠两件不同物品，各记一条', () => {
    const g1 = { creditType: 'credit_transaction' as const, action: 'gift' as const, characterName: '林晚', amount: 0, reason: '额外赠送', itemName: '玄铁护腕', chapterOrder: 8 };
    const g2 = { ...g1, itemName: '回气丹' };
    expect(processCreditTransactionShared(g1, 'p1', 8, new Set()).added).toBe(true);
    expect(processCreditTransactionShared(g2, 'p1', 8, new Set()).added).toBe(true);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(2);
  });

  it('解析不到的物品（技能名）按 类型+金额 判重', () => {
    const a = { creditType: 'credit_transaction' as const, action: 'spend' as const, characterName: '林晚', amount: 500, reason: '升级基础剑法至二级', itemName: '基础剑法', chapterOrder: 9 };
    expect(processCreditTransactionShared(a, 'p1', 9, new Set()).added).toBe(true);
    expect(processCreditTransactionShared({ ...a, reason: '基础剑法升至二级' }, 'p1', 9, new Set()).added).toBe(false);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(1);
  });
  it('同一章重复赠同一件物品只记一条', () => {
    const g = { creditType: 'credit_transaction' as const, action: 'gift' as const, characterName: '林晚', amount: 0, reason: '首次绑定赠送新手礼包', itemName: '青锋剑', chapterOrder: 1 };
    expect(processCreditTransactionShared(g, 'p1', 1, new Set()).added).toBe(true);
    expect(processCreditTransactionShared({ ...g, reason: '新手礼包赠送青锋剑' }, 'p1', 1, new Set()).added).toBe(false);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(1);
  });
});
describe('系统流：不该记的账', () => {
  it('现实货币（卖玉佩三百块钱）不进积分账本', () => {
    // 扫描根本不会输出这条（prompt 明确排除），这里验证即便误传也不会被识别为积分
    const result = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'gain',
        characterName: '林晚',
        amount: 0,
        reason: '卖掉玉佩得到三百块钱',
        chapterOrder: 8,
      },
      'p1',
      8,
      new Set(),
    );
    // gain 金额为 0 → 直接丢弃
    expect(result.added).toBe(false);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(0);
  });
});