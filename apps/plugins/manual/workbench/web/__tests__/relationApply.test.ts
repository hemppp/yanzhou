// ============================================================
// 关系断言的落库执行（store 级）
//
// 关键契约：
//   ① 通过校验的断言按「双向存储」写入（角色/物品/地点↔地点），
//      图上按无序对去重，删除一侧不会留下半边；
//   ② 同一对 + 同一类型重复断言只落一次（同一次扫描 + 跨批次）；
//   ③ 解析不到 / 证据不符的断言不写任何 store。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character, Item, Location } from '@novel/shared';
import {
  useCharacterStore,
  useItemStore,
  useLocationStore,
} from '@novel-plugins/data-core/stores';
import { applyRelationAssertion, buildRelationDedupe, buildRelationEntityRefs } from '../knowledge/relationApply';
import { prepareRelationContext } from '../knowledge/relationRecognition';

const CHAPTER_TEXT =
  '青云子收陈星为徒。陈星走进藏经阁，青云子在殿内等他。青锋剑与剑鞘本是一对。藏经阁位于青云山之上。';

function character(over: Partial<Character> & Pick<Character, 'id' | 'name'>): Character {
  return {
    projectId: 'p1',
    aliases: [],
    states: [],
    relations: [],
    chapters: [1],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function item(over: Partial<Item> & Pick<Item, 'id' | 'name'>): Item {
  return {
    projectId: 'p1',
    states: [],
    holders: [],
    currentHolders: [],
    relations: [],
    chapters: [1],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function location(over: Partial<Location> & Pick<Location, 'id' | 'name'>): Location {
  return {
    projectId: 'p1',
    states: [],
    relations: [],
    chapters: [1],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  useCharacterStore.setState({
    characters: [
      character({ id: 'c1', name: '陈星', aliases: ['星儿'] }),
      character({ id: 'c2', name: '青云子' }),
    ],
  });
  useItemStore.setState({
    items: [
      item({ id: 'i1', name: '青锋剑' }),
      item({ id: 'i2', name: '剑鞘' }),
    ],
  });
  useLocationStore.setState({
    locations: [
      location({ id: 'l1', name: '藏经阁' }),
      location({ id: 'l2', name: '青云山' }),
    ],
  });
});

function makeCtx() {
  const refs = buildRelationEntityRefs('p1');
  return prepareRelationContext({ chapterContent: CHAPTER_TEXT, ...refs });
}

describe('applyRelationAssertion', () => {
  it('角色关系双向写入，两边的方向互补', () => {
    const ctx = makeCtx();
    const dedupe = buildRelationDedupe('p1');

    const outcome = applyRelationAssertion(
      { assertionType: 'character_relation', subject: '陈星', object: '青云子', type: '师徒', context: '青云子收陈星为徒' },
      5,
      ctx,
      dedupe,
    );

    expect(outcome).toEqual({ added: true, kind: 'character' });

    const c1 = useCharacterStore.getState().characters.find((c) => c.id === 'c1')!;
    const c2 = useCharacterStore.getState().characters.find((c) => c.id === 'c2')!;
    expect(c1.relations).toEqual([
      expect.objectContaining({ targetId: 'c2', type: 'mentor', direction: 'to', chapter: 5 }),
    ]);
    expect(c2.relations).toEqual([
      expect.objectContaining({ targetId: 'c1', type: 'mentor', direction: 'from', chapter: 5 }),
    ]);
  });

  it('同一对 + 同一类型重复断言只落一次', () => {
    const ctx = makeCtx();
    const dedupe = buildRelationDedupe('p1');
    const assertion = {
      assertionType: 'character_relation' as const,
      subject: '陈星',
      object: '青云子',
      type: '师徒',
      context: '青云子收陈星为徒',
    };

    expect(applyRelationAssertion(assertion, 5, ctx, dedupe).added).toBe(true);
    expect(applyRelationAssertion(assertion, 6, ctx, dedupe)).toMatchObject({
      added: false,
      reason: '关系已存在',
    });

    // 跨批次（新一轮扫描重建索引）也要认出已存的关系
    const dedupe2 = buildRelationDedupe('p1');
    expect(applyRelationAssertion(assertion, 7, ctx, dedupe2).added).toBe(false);
  });

  it('物品关系双向写入', () => {
    const ctx = makeCtx();
    const dedupe = buildRelationDedupe('p1');

    expect(
      applyRelationAssertion(
        { assertionType: 'item_relation', subject: '青锋剑', object: '剑鞘', type: '配对', context: '青锋剑与剑鞘本是一对' },
        2,
        ctx,
        dedupe,
      ),
    ).toEqual({ added: true, kind: 'item' });

    const i1 = useItemStore.getState().items.find((i) => i.id === 'i1')!;
    const i2 = useItemStore.getState().items.find((i) => i.id === 'i2')!;
    expect(i1.relations).toEqual([expect.objectContaining({ targetItemId: 'i2', type: 'paired_with' })]);
    expect(i2.relations).toEqual([expect.objectContaining({ targetItemId: 'i1', type: 'paired_with' })]);
  });

  it('地点↔地点双向写入；地点→角色只写地点侧', () => {
    const ctx = makeCtx();
    const dedupe = buildRelationDedupe('p1');

    expect(
      applyRelationAssertion(
        { assertionType: 'location_relation', subject: '藏经阁', object: '青云山', type: '位于', context: '藏经阁位于青云山之上' },
        3,
        ctx,
        dedupe,
      ),
    ).toEqual({ added: true, kind: 'location' });
    expect(
      applyRelationAssertion(
        { assertionType: 'location_relation', subject: '藏经阁', object: '陈星', type: '位于', context: '藏经阁位于青云山之上' },
        3,
        ctx,
        dedupe,
      ),
    ).toEqual({ added: true, kind: 'location' });

    const l1 = useLocationStore.getState().locations.find((l) => l.id === 'l1')!;
    const l2 = useLocationStore.getState().locations.find((l) => l.id === 'l2')!;
    expect(l1.relations).toEqual([
      expect.objectContaining({ targetId: 'l2', targetKind: 'location', type: 'located_in' }),
      expect.objectContaining({ targetId: 'c1', targetKind: 'character', type: 'located_in' }),
    ]);
    // 「位于」有向：不在 l2 上写反向，避免出现「青云山位于藏经阁」
    expect(l2.relations).toEqual([]);
  });

  it('解析不到 / 证据不符的断言不写库', () => {
    const ctx = makeCtx();
    const dedupe = buildRelationDedupe('p1');

    expect(
      applyRelationAssertion(
        { assertionType: 'character_relation', subject: '陈星', object: '王五', type: '师徒', context: '青云子收陈星为徒' },
        3,
        ctx,
        dedupe,
      ),
    ).toMatchObject({ added: false, reason: '角色未解析' });

    expect(
      applyRelationAssertion(
        {
          assertionType: 'character_relation',
          subject: '陈星',
          object: '青云子',
          type: '师徒',
          context: '两人并肩走过长街',
        },
        3,
        ctx,
        dedupe,
      ),
    ).toMatchObject({ added: false, reason: '证据与原文不符' });

    expect(useCharacterStore.getState().characters.every((c) => c.relations.length === 0)).toBe(true);
  });
});