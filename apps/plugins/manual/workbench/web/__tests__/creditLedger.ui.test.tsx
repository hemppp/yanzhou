// ============================================================
// CreditLedger UI：记赠予 → 零积分入账 + 物品持有同步
//
// 这条用例覆盖纯逻辑之外的真实交互路径：
//   选人物 → 点「记赠予」→ 填奖励内容 → 选物品 → 提交
// 断言 store 里落的是 gift/amount=0，且物品 holders 写入 gained。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  useCharacterStore,
  useCreditStore,
  useItemStore,
  useProjectStore,
} from '@novel-plugins/data-core/stores';
import type { Character, Item, Project } from '@novel/shared';
import { CreditLedger } from '../knowledge/CreditLedger';

const CHARACTER = {
  id: 'c1',
  projectId: 'p1',
  name: '陈星',
  aliases: [],
  states: [],
  relations: [],
  chapters: [],
  tags: [],
  createdAt: 0,
  updatedAt: 0,
} as Character;

const ITEM = {
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
} as Item;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useProjectStore.setState({ currentProject: { id: 'p1', name: '测试书' } as Project });
  useCharacterStore.setState({ characters: [CHARACTER] });
  useItemStore.setState({ items: [ITEM] });
  useCreditStore.setState({ creditTransactions: [] });
});

describe('CreditLedger 赠予', () => {
  it('零积分入账，并同步写入物品持有', () => {
    render(<CreditLedger />);

    fireEvent.click(screen.getByText('陈星'));
    fireEvent.click(screen.getByText('记赠予'));

    fireEvent.change(
      screen.getByPlaceholderText('如：新手礼包 / 初级功法 / 系统空间'),
      { target: { value: '新手礼包' } },
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'i1' } });
    fireEvent.click(screen.getByText('记入赠予'));

    const txs = useCreditStore.getState().creditTransactions;
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      type: 'gift',
      amount: 0,
      characterId: 'c1',
      chapter: 1,
      reason: '新手礼包',
      relatedItemId: 'i1',
    });

    const item = useItemStore.getState().items.find((i) => i.id === 'i1')!;
    expect(item.holders).toEqual([{ characterId: 'c1', chapter: 1, action: 'gained' }]);
    expect(item.currentHolders).toEqual(['c1']);
  });
});
