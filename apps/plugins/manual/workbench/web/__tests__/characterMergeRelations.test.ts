// ============================================================
// 角色合并后的关系改写
//
// 背景：mergeSimilarCharacters 以前只合并主角色自己的 relations，
// 「别处指向被删角色」的关系会一直挂着不存在的 targetId —— 图上看不见，
// 数据里却是悬空边，去重索引也认不出来（同一对会被重复写入）。
// 本文件锁定：合并后角色/物品/地点三处的旧 id 引用都被改写，且去重。
// ============================================================

import { describe, expect, it } from 'vitest';
import type { Character, Item, Location } from '@novel/shared';
import { mergeSimilarCharacters, remapLocationRelations } from '../knowledge/characterMerge';

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

describe('mergeSimilarCharacters 的关系改写', () => {
  it('其他角色指向被合并角色的关系改写到主角色，并去掉自指/重复', () => {
    const characters = [
      // 「诸葛孔明」是更长的名字 ⇒ 合并后保留它；「孔明」并入
      character({ id: 'c1', name: '诸葛孔明' }),
      character({ id: 'c2', name: '孔明' }),
      character({
        id: 'c3',
        name: '青云子',
        relations: [
          { targetId: 'c2', type: 'mentor', direction: 'from' },
          { targetId: 'c1', type: 'mentor', direction: 'from' },
        ],
      }),
    ];

    const { mergedCharacters, mergeCount, idRemap } = mergeSimilarCharacters(characters, []);
    expect(mergeCount).toBeGreaterThan(0);

    // 不再有指向 c2 的关系；c1 上同类型只留一条
    const survivingIds = new Set(mergedCharacters.map((c) => c.id));
    for (const c of mergedCharacters) {
      for (const rel of c.relations) {
        expect(survivingIds.has(rel.targetId)).toBe(true);
        expect(rel.targetId).not.toBe(c.id);
      }
    }
    const c3 = mergedCharacters.find((c) => c.id === 'c3')!;
    expect(c3.relations.filter((r) => r.type === 'mentor')).toHaveLength(1);
    expect(c3.relations[0]!.targetId).toBe('c1');
    expect(idRemap.get('c2')).toBe('c1');
  });

  it('无合并时 idRemap 为空、数据原样返回', () => {
    const characters = [
      character({ id: 'c1', name: '陈星' }),
      character({ id: 'c2', name: '青云子' }),
    ];
    const result = mergeSimilarCharacters(characters, []);
    expect(result.mergeCount).toBe(0);
    expect(result.idRemap.size).toBe(0);
  });
});

describe('remapLocationRelations', () => {
  it('改写指向被删角色的地点关系，并把重复的合并成一条', () => {
    const locations = [
      location({
        id: 'l1',
        name: '藏经阁',
        relations: [
          { targetId: 'c2', targetKind: 'character', type: 'located_in' },
          { targetId: 'c1', targetKind: 'character', type: 'located_in' },
          { targetId: 'l2', targetKind: 'location', type: 'nearby' },
        ],
      }),
    ];

    const [result] = remapLocationRelations(locations, new Map([['c2', 'c1']]));
    expect(result!.relations).toEqual([
      { targetId: 'c1', targetKind: 'character', type: 'located_in' },
      { targetId: 'l2', targetKind: 'location', type: 'nearby' },
    ]);
  });

  it('地点→地点的关系不受角色 id 改写影响', () => {
    const locations = [
      location({
        id: 'l1',
        name: '藏经阁',
        relations: [{ targetId: 'l2', targetKind: 'location', type: 'located_in' }],
      }),
    ];
    const [result] = remapLocationRelations(locations, new Map([['l2', 'l9']]));
    expect(result!.relations).toEqual([
      { targetId: 'l2', targetKind: 'location', type: 'located_in' },
    ]);
  });
});

describe('物品引用', () => {
  it('物品持有者 id 随角色合并改写', () => {
    const characters = [
      character({ id: 'c1', name: '诸葛孔明' }),
      character({ id: 'c2', name: '孔明' }),
    ];
    const items = [
      item({
        id: 'i1',
        name: '青锋剑',
        holders: [{ characterId: 'c2', chapter: 1, action: 'gained' }],
        currentHolders: ['c2'],
      }),
    ];

    const { mergedItems } = mergeSimilarCharacters(characters, items);
    expect(mergedItems[0]!.currentHolders).toEqual(['c1']);
    expect(mergedItems[0]!.holders[0]!.characterId).toBe('c1');
  });
});