// ============================================================
// 系统账本：积分派生 + 赠予 → 物品持有同步
//
// 关键契约：
//   ① gift 流水不改变积分结余（derive / replay 共用 creditTransactionDelta）
//   ② 赠予关联物品时，首次同步写入 gained 流转并把角色加入 currentHolders
//   ③ 同一章重复同步必须幂等（反复保存不能刷出多条流转）
// ============================================================

import { beforeEach, describe, it, expect } from 'vitest';
import {
  creditTransactionDelta,
  deriveCreditBalance,
  replayCreditLedger,
  type Character,
  type CreditTransaction,
  type Item,
} from '@novel/shared';
import {
  useCharacterStore,
  useCreditStore,
  useItemStore,
} from '@novel-plugins/data-core/stores';
import { computeCreditItemAcquisition } from '../knowledge/creditItemSync';
import { processCreditTransactionShared } from '../hooks/useScanProcessors';

function makeTx(
  over: Partial<CreditTransaction> & Pick<CreditTransaction, 'id' | 'type' | 'amount'>,
): CreditTransaction {
  return {
    projectId: 'p1',
    characterId: 'c1',
    chapter: 1,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    projectId: 'p1',
    name: '残卷',
    states: [],
    holders: [],
    currentHolders: [],
    relations: [],
    chapters: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('creditTransactionDelta', () => {
  it('gain/spend 改变结余，gift 不改变', () => {
    expect(creditTransactionDelta({ type: 'gain', amount: 100 })).toBe(100);
    expect(creditTransactionDelta({ type: 'spend', amount: 40 })).toBe(-40);
    expect(creditTransactionDelta({ type: 'gift', amount: 0 })).toBe(0);
  });
});

describe('deriveCreditBalance', () => {
  it('赠予不计入积分结余', () => {
    const txs = [
      makeTx({ id: '1', type: 'gain', amount: 100, chapter: 1 }),
      makeTx({ id: '2', type: 'gift', amount: 0, chapter: 2 }),
      makeTx({ id: '3', type: 'spend', amount: 30, chapter: 3 }),
    ];
    expect(deriveCreditBalance(txs, 'c1')).toBe(70);
    // 截至第 2 章：赠予不影响结余
    expect(deriveCreditBalance(txs, 'c1', 2)).toBe(100);
  });
});

describe('replayCreditLedger', () => {
  it('赠予出现在流水里，但 balanceAfter 与上一笔相同', () => {
    const txs = [
      makeTx({ id: '1', type: 'gain', amount: 100, chapter: 1, createdAt: 1 }),
      makeTx({ id: '2', type: 'gift', amount: 0, chapter: 2, createdAt: 2 }),
      makeTx({ id: '3', type: 'spend', amount: 30, chapter: 3, createdAt: 3 }),
    ];

    expect(
      replayCreditLedger(txs, 'c1').map((t) => ({ type: t.type, balanceAfter: t.balanceAfter })),
    ).toEqual([
      { type: 'gain', balanceAfter: 100 },
      { type: 'gift', balanceAfter: 100 },
      { type: 'spend', balanceAfter: 70 },
    ]);
  });
});

describe('computeCreditItemAcquisition', () => {
  it('首次赠予写入 gained 流转并加入当前持有者', () => {
    expect(computeCreditItemAcquisition(makeItem(), 'c1', 3)).toEqual({
      holders: [{ characterId: 'c1', chapter: 3, action: 'gained' }],
      currentHolders: ['c1'],
    });
  });

  it('同一章重复同步幂等', () => {
    const item = makeItem({
      holders: [{ characterId: 'c1', chapter: 3, action: 'gained' }],
      currentHolders: ['c1'],
    });
    expect(computeCreditItemAcquisition(item, 'c1', 3)).toBeNull();
  });

  it('角色已持有但缺本章流转时，只补流转不改持有者', () => {
    const item = makeItem({ currentHolders: ['c1'] });
    expect(computeCreditItemAcquisition(item, 'c1', 4)).toEqual({
      holders: [{ characterId: 'c1', chapter: 4, action: 'gained' }],
      currentHolders: ['c1'],
    });
  });

  it('不同章节会追加新的获得记录', () => {
    const item = makeItem({
      holders: [{ characterId: 'c1', chapter: 3, action: 'gained' }],
      currentHolders: ['c1'],
    });
    expect(computeCreditItemAcquisition(item, 'c1', 5)).toEqual({
      holders: [
        { characterId: 'c1', chapter: 3, action: 'gained' },
        { characterId: 'c1', chapter: 5, action: 'gained' },
      ],
      currentHolders: ['c1'],
    });
  });

  it('非法角色 / 章节返回 null', () => {
    expect(computeCreditItemAcquisition(makeItem(), '', 3)).toBeNull();
    expect(computeCreditItemAcquisition(makeItem(), 'c1', 0)).toBeNull();
  });
});

describe('processCreditTransactionShared（正文扫描 → 账本）', () => {
  const CHARACTER = {
    id: 'c1',
    projectId: 'p1',
    name: '陈星',
    aliases: ['星儿'],
    states: [],
    relations: [],
    chapters: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  } as Character;

  beforeEach(() => {
    useCharacterStore.setState({ characters: [CHARACTER] });
    useItemStore.setState({ items: [makeItem({ id: 'i1', name: '基础剑法' })] });
    useCreditStore.setState({ creditTransactions: [] });
  });

  it('消耗积分入账，并同步关联物品持有', () => {
    const result = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'spend',
        characterName: '陈星',
        amount: 500,
        reason: '兑换基础剑法',
        itemName: '基础剑法',
        chapterOrder: 1,
      },
      'p1',
      1,
      new Set(),
    );

    expect(result).toEqual({ added: true, itemLinked: true });
    const tx = useCreditStore.getState().creditTransactions[0]!;
    expect(tx).toMatchObject({
      type: 'spend',
      amount: 500,
      characterId: 'c1',
      chapter: 1,
      reason: '兑换基础剑法',
      relatedItemId: 'i1',
    });

    const item = useItemStore.getState().items[0]!;
    expect(item.holders).toEqual([{ characterId: 'c1', chapter: 1, action: 'gained' }]);
    expect(item.currentHolders).toEqual(['c1']);
  });

  it('重复扫描同一笔流水不会重复入账', () => {
    const credit = {
      creditType: 'credit_transaction' as const,
      action: 'spend' as const,
      characterName: '陈星',
      amount: 500,
      reason: '兑换基础剑法',
      chapterOrder: 1,
    };
    expect(processCreditTransactionShared(credit, 'p1', 1, new Set()).added).toBe(true);
    // 新 Set 模拟下一次扫描：靠 store 持久化去重
    expect(processCreditTransactionShared(credit, 'p1', 1, new Set()).added).toBe(false);
    expect(useCreditStore.getState().creditTransactions).toHaveLength(1);
  });

  it('赠予强制零积分；角色不匹配时跳过', () => {
    processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'gift',
        characterName: '陈星',
        amount: 999,
        itemName: '令牌',
        chapterOrder: 2,
      },
      'p1',
      2,
      new Set(),
    );
    expect(useCreditStore.getState().creditTransactions[0]).toMatchObject({
      type: 'gift',
      amount: 0,
    });

    const missed = processCreditTransactionShared(
      {
        creditType: 'credit_transaction',
        action: 'spend',
        characterName: '不存在的人',
        amount: 10,
        chapterOrder: 1,
      },
      'p1',
      1,
      new Set(),
    );
    expect(missed.added).toBe(false);
  });
});
