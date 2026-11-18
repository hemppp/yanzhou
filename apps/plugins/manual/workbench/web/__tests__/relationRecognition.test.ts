// ============================================================
// 关系识别后处理回归
//
// 锁定 2026-11 关系识别改造的两条底线：
//   ① 类型归一：中文关系词（师徒/父亲/仇人/配对/剑鞘/位于…）必须落到标准码，
//      归不出来的自由描述**不许**当「其他」混进图里；
//   ② 断言校验：主体/客体解析不到、证据对不上原文、自指 —— 一律丢弃，
//      宁可少一条关系，也不挂到错的人身上。
// 以及双向存储、去重索引、写入计划。
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  normalizeCharacterRelationType,
  normalizeItemRelationType,
  normalizeLocationRelationType,
  planRelationWrite,
  prepareRelationContext,
  prepareRelationDedupe,
  inferLocationPresence,
  relationNameKey,
  validateRelationAssertion,
  type RelationAssertion,
} from '../knowledge/relationRecognition';

// 证据里必须同时满足两件事：逐字出自原文 + 含该类型的关系谓词
const CHAPTER =
  '青云子收陈星为徒，赐他一把青锋剑，剑与鞘本是一对。藏经阁位于青云山主峰之上，藏经阁就在青云山旁边，藏经阁通往地下密室。陈星与青云子结为好友。陈星走进藏经阁，殿内空无一人。';

function ctx() {
  return prepareRelationContext({
    chapterContent: CHAPTER,
    characters: [
      { id: 'c1', name: '陈星', aliases: ['星儿'] },
      { id: 'c2', name: '青云子', aliases: [] },
      { id: 'c3', name: '沈知意', aliases: [] },
    ],
    items: [
      { id: 'i1', name: '青锋剑' },
      { id: 'i2', name: '剑鞘' },
      { id: 'i3', name: '罗盘' },
    ],
    locations: [
      { id: 'l1', name: '藏经阁' },
      { id: 'l2', name: '青云山' },
    ],
  });
}

function assert(over: Partial<RelationAssertion>): RelationAssertion {
  return {
    assertionType: 'character_relation',
    subject: '陈星',
    object: '青云子',
    type: '师徒',
    context: '青云子收陈星为徒',
    ...over,
  };
}

describe('关系类型归一', () => {
  it('角色关系：中文词表 → 标准码，长词优先', () => {
    expect(normalizeCharacterRelationType('师徒')).toBe('mentor');
    expect(normalizeCharacterRelationType('师父')).toBe('mentor');
    expect(normalizeCharacterRelationType('父亲')).toBe('family');
    expect(normalizeCharacterRelationType('父子')).toBe('family');
    expect(normalizeCharacterRelationType('未婚妻')).toBe('lover');
    expect(normalizeCharacterRelationType('仇敌')).toBe('enemy');
    expect(normalizeCharacterRelationType('情敌')).toBe('rival');
    expect(normalizeCharacterRelationType('挚友')).toBe('friend');
    expect(normalizeCharacterRelationType('同盟者')).toBe('ally');
    expect(normalizeCharacterRelationType('上下级')).toBe('subordinate');
    expect(normalizeCharacterRelationType('enemy')).toBe('enemy');
  });

  it('角色关系：自由描述按兜底规则归一，完全归不出的回 other（随后被拒）', () => {
    expect(normalizeCharacterRelationType('名义上的师父')).toBe('mentor');
    expect(normalizeCharacterRelationType('同父异母的姐姐')).toBe('family');
    expect(normalizeCharacterRelationType('不共戴天的死仇')).toBe('enemy');
    expect(normalizeCharacterRelationType('有过一面之缘')).toBe('other');
    expect(normalizeCharacterRelationType('')).toBe('other');
  });

  it('物品关系：配对/包含/部件/对立/变形 → ItemRelationType', () => {
    expect(normalizeItemRelationType('配对')).toBe('paired_with');
    expect(normalizeItemRelationType('剑鞘')).toBe('paired_with');
    expect(normalizeItemRelationType('内含')).toBe('contains');
    expect(normalizeItemRelationType('部件')).toBe('part_of');
    expect(normalizeItemRelationType('相克')).toBe('opposite_of');
    expect(normalizeItemRelationType('化形')).toBe('transforms_into');
    expect(normalizeItemRelationType('说不清')).toBe('related_to');
  });

  it('地点关系：地点之间按词表；客体是角色时只保留「位于」语义', () => {
    expect(normalizeLocationRelationType('位于')).toBe('located_in');
    expect(normalizeLocationRelationType('邻近')).toBe('nearby');
    expect(normalizeLocationRelationType('通往')).toBe('routes_to');
    // 角色没有「邻近/通往」这回事，能读到的最多是「在场」
    expect(normalizeLocationRelationType('邻近', 'character')).toBe('located_in');
    expect(normalizeLocationRelationType('', 'location')).toBe('related_to');
  });

  it('比较键：全角/空白/标点不影响解析', () => {
    expect(relationNameKey(' 陈 星 ')).toBe('陈星');
    expect(relationNameKey('「青云子」')).toBe('青云子');
  });
});

describe('句内在场推断（模型漏召回时的确定性兜底）', () => {
  const locations = [
    { id: 'l1', name: '江心洲' },
    { id: 'l2', name: '藏经阁' },
  ];
  const characters = [
    { id: 'c1', name: '沈砚' },
    { id: 'c2', name: '裴无咎' },
  ];

  it('同一句里「人物 + 地点 + 在场谓词」→ 补一条位于', () => {
    const result = inferLocationPresence('沈砚登上江心洲，裴无咎已经等在那里。', locations, characters);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: '江心洲', object: '沈砚', type: '位于' }),
        expect.objectContaining({ subject: '江心洲', object: '裴无咎', type: '位于' }),
      ]),
    );
  });

  it('没有在场谓词时不补（推门不等于在场）', () => {
    expect(inferLocationPresence('沈砚推开藏经阁的木门。', locations, characters)).toEqual([]);
  });

  it('没有具名人物时不补', () => {
    expect(inferLocationPresence('藏经阁里空无一人。', locations, characters)).toEqual([]);
  });

  it('跨句不匹配（人物与地点不在同一句）', () => {
    expect(
      inferLocationPresence('沈砚走进山门。藏经阁在云雾里。', locations, characters),
    ).toEqual([]);
  });

  it('别名也能命中', () => {
    const result = inferLocationPresence(
      '星儿站在江心洲上。',
      locations,
      [{ id: 'c1', name: '沈砚', aliases: ['星儿'] }],
    );
    expect(result).toEqual([
      expect.objectContaining({ subject: '江心洲', object: '沈砚' }),
    ]);
  });
});

describe('关系断言校验', () => {
  it('角色关系通过：类型归一 + 双向方向保留', () => {
    const result = validateRelationAssertion(assert({}), ctx());
    expect(result).toMatchObject({
      accept: true,
      kind: 'character',
      subjectId: 'c1',
      objectId: 'c2',
      type: 'mentor',
      direction: 'to',
    });
  });

  it('别名也能解析到角色', () => {
    const result = validateRelationAssertion(assert({ subject: '星儿' }), ctx());
    expect(result).toMatchObject({ accept: true, subjectId: 'c1' });
  });

  it('解析不到主体/客体 → 丢弃', () => {
    expect(validateRelationAssertion(assert({ object: '王五' }), ctx())).toMatchObject({
      accept: false,
      reason: '角色未解析',
    });
    expect(validateRelationAssertion(assert({ subject: '', object: '青云子' }), ctx())).toMatchObject({
      accept: false,
    });
  });

  it('自指关系 → 丢弃', () => {
    expect(validateRelationAssertion(assert({ object: '陈星' }), ctx())).toMatchObject({
      accept: false,
      reason: '自指关系',
    });
  });

  it('类型归不出语义（other）→ 丢弃，不往图里塞噪声', () => {
    expect(
      validateRelationAssertion(
        assert({ type: '一起喝过酒', context: '陈星走进藏经阁' }),
        ctx(),
      ),
    ).toMatchObject({ accept: false, reason: '关系类型无法归一' });
  });

  it('证据对不上原文 → 丢弃（同事件 quote 的口径）', () => {
    expect(validateRelationAssertion(assert({ context: '他们并肩走过长街' }), ctx())).toMatchObject({
      accept: false,
      reason: '证据与原文不符',
    });
  });

  it('没有证据的关系一律丢弃（无法区分「原文写的关系」与「同场联想」）', () => {
    expect(validateRelationAssertion(assert({ context: '' }), ctx())).toMatchObject({
      accept: false,
      reason: '缺少证据',
    });
  });

  it('泛关系（认识/相识/见过）不入图', () => {
    expect(
      validateRelationAssertion(
        assert({ type: '认识', subject: '陈星', object: '苏晚', context: '陈星在青云山见过苏晚' }),
        prepareRelationContext({
          chapterContent: '陈星在青云山见过苏晚，两人点了个头。',
          characters: [
            { id: 'c1', name: '陈星' },
            { id: 'c2', name: '苏晚' },
          ],
        }),
      ),
    ).toMatchObject({ accept: false, reason: '关系类型过泛' });
  });

  it('同一句里同时有师徒与同门证据时，按师徒算（不能把师父降成朋友）', () => {
    const prepared = prepareRelationContext({
      chapterContent: '顾长渊是青云子最早收的徒弟，也是陈星与苏晚的师兄。',
      characters: [
        { id: 'c1', name: '顾长渊' },
        { id: 'c2', name: '青云子' },
      ],
    });
    expect(
      validateRelationAssertion(
        assert({
          subject: '青云子',
          object: '顾长渊',
          type: '朋友',
          context: '顾长渊是青云子最早收的徒弟',
        }),
        prepared,
      ),
    ).toMatchObject({ accept: true, type: 'mentor' });
  });

  it('师兄/同门被标成师徒时纠正为同门', () => {
    const prepared = prepareRelationContext({
      chapterContent: '顾长渊也是陈星与苏晚的师兄。',
      characters: [
        { id: 'c1', name: '顾长渊' },
        { id: 'c2', name: '苏晚' },
      ],
    });
    expect(
      validateRelationAssertion(
        assert({ subject: '顾长渊', object: '苏晚', type: '师徒', context: '也是陈星与苏晚的师兄' }),
        prepared,
      ),
    ).toMatchObject({ accept: true, type: 'friend' });
  });

  it('证据里没有关系谓词时丢弃（两个名字同场不等于有关系）', () => {
    // 这句同时出现「陈星」「藏经阁」，但说的是「推门/走进」，不是「位于」
    expect(
      validateRelationAssertion(
        assert({
          assertionType: 'location_relation',
          subject: '藏经阁',
          object: '陈星',
          type: '位于',
          context: '陈星走进藏经阁',
        }),
        ctx(),
      ),
    ).toMatchObject({ accept: true });

    // 同场出现但没有任何关系谓词 —— 必须丢
    expect(
      validateRelationAssertion(
        assert({
          assertionType: 'location_relation',
          subject: '藏经阁',
          object: '青云子',
          type: '位于',
          context: '陈星与青云子结为好友',
        }),
        ctx(),
      ),
    ).toMatchObject({ accept: false, reason: '证据里没有关系表述' });
  });

  it('物品关系：两端都必须是物品', () => {
    expect(
      validateRelationAssertion(
        {
          assertionType: 'item_relation',
          subject: '青锋剑',
          object: '剑鞘',
          type: '配对',
          context: '剑与鞘本是一对',
        },
        ctx(),
      ),
    ).toMatchObject({ accept: true, kind: 'item', subjectId: 'i1', objectId: 'i2', type: 'paired_with' });

    // 客体不是物品（角色）⇒ 丢弃
    expect(
      validateRelationAssertion(
        { assertionType: 'item_relation', subject: '青锋剑', object: '陈星', type: '配对', context: '剑与鞘本是一对' },
        ctx(),
      ),
    ).toMatchObject({ accept: false, reason: '物品未解析' });
  });

  it('地点关系：主体必须是地点，客体可为地点或角色', () => {
    expect(
      validateRelationAssertion(
        { assertionType: 'location_relation', subject: '藏经阁', object: '青云山', type: '位于', context: '藏经阁位于青云山' },
        ctx(),
      ),
    ).toMatchObject({
      accept: true,
      kind: 'location',
      subjectId: 'l1',
      targetId: 'l2',
      targetKind: 'location',
      type: 'located_in',
    });

    expect(
      validateRelationAssertion(
        { assertionType: 'location_relation', subject: '藏经阁', object: '陈星', type: '位于', context: '陈星走进藏经阁' },
        ctx(),
      ),
    ).toMatchObject({ accept: true, targetId: 'c1', targetKind: 'character' });

    // 方向写反（角色 → 地点）：对调成 (地点 ← 角色)，不是丢弃
    expect(
      validateRelationAssertion(
        { assertionType: 'location_relation', subject: '陈星', object: '藏经阁', type: '位于', context: '陈星走进藏经阁' },
        ctx(),
      ),
    ).toMatchObject({
      accept: true,
      kind: 'location',
      subjectId: 'l1',
      targetId: 'c1',
      targetKind: 'character',
      type: 'located_in',
    });

    // 主体地点解析不到、反方向也不是角色 ⇒ 丢弃
    expect(
      validateRelationAssertion(
        { assertionType: 'location_relation', subject: '不存在之地', object: '青云山', type: '位于', context: '藏经阁位于青云山' },
        ctx(),
      ),
    ).toMatchObject({ accept: false, reason: '地点未解析' });
  });

  it('同章新落库的实体能被后续断言解析（增量登记）', () => {
    const prepared = ctx();
    expect(
      validateRelationAssertion(
        { assertionType: 'location_relation', subject: '藏经阁', object: '地下密室', type: '通往', context: '藏经阁通往地下密室' },
        prepared,
      ),
    ).toMatchObject({ accept: false });

    prepared.addLocation({ id: 'l3', name: '地下密室' });
    expect(
      validateRelationAssertion(
        { assertionType: 'location_relation', subject: '藏经阁', object: '地下密室', type: '通往', context: '藏经阁通往地下密室' },
        prepared,
      ),
    ).toMatchObject({ accept: true, targetId: 'l3' });
  });
});

describe('写入计划与去重', () => {
  it('角色关系双向写入，反向方向取反', () => {
    const prepared = ctx();
    const dedupe = prepareRelationDedupe({ characters: [], items: [], locations: [] });
    const validation = validateRelationAssertion(assert({}), prepared);
    if (!validation.accept) throw new Error('应通过校验');

    const planned = planRelationWrite(validation, 7, dedupe);
    expect(planned?.write.kind).toBe('character');
    if (planned?.write.kind !== 'character') return;

    expect(planned.write.additions).toEqual([
      { characterId: 'c1', relation: expect.objectContaining({ targetId: 'c2', type: 'mentor', direction: 'to', chapter: 7 }) },
      { characterId: 'c2', relation: expect.objectContaining({ targetId: 'c1', type: 'mentor', direction: 'from', chapter: 7 }) },
    ]);
  });

  it('对称关系两侧都是 mutual，图上不画箭头', () => {
    const prepared = ctx();
    const dedupe = prepareRelationDedupe({ characters: [], items: [], locations: [] });
    const validation = validateRelationAssertion(
      assert({ type: '朋友', direction: 'mutual', context: '陈星与青云子结为好友' }),
      prepared,
    );
    if (!validation.accept) throw new Error('应通过校验');
    const planned = planRelationWrite(validation, 3, dedupe);
    if (planned?.write.kind !== 'character') throw new Error('应为角色关系');
    expect(planned.write.additions.map((a) => a.relation.direction)).toEqual(['mutual', 'mutual']);
  });

  it('物品关系双向写入', () => {
    const prepared = ctx();
    const dedupe = prepareRelationDedupe({ characters: [], items: [], locations: [] });
    const validation = validateRelationAssertion(
      { assertionType: 'item_relation', subject: '青锋剑', object: '剑鞘', type: '配对', context: '剑与鞘本是一对' },
      prepared,
    );
    if (!validation.accept) throw new Error('应通过校验');
    const planned = planRelationWrite(validation, 4, dedupe);
    if (planned?.write.kind !== 'item') throw new Error('应为物品关系');
    expect(planned.write.additions).toEqual([
      { itemId: 'i1', relation: expect.objectContaining({ targetItemId: 'i2', type: 'paired_with' }) },
      { itemId: 'i2', relation: expect.objectContaining({ targetItemId: 'i1', type: 'paired_with' }) },
    ]);
  });

  it('地点↔地点双向写入，地点→角色只写地点侧', () => {
    const prepared = ctx();
    const dedupe = prepareRelationDedupe({ characters: [], items: [], locations: [] });

    // 「位于」是有向的：只写 (藏经阁 → 青云山)，绝不写反向，
    // 否则图上会出现语义倒置的「青云山位于藏经阁」。
    const locLoc = validateRelationAssertion(
      { assertionType: 'location_relation', subject: '藏经阁', object: '青云山', type: '位于', context: '藏经阁位于青云山' },
      prepared,
    );
    if (!locLoc.accept) throw new Error('应通过校验');
    const planned = planRelationWrite(locLoc, 2, dedupe);
    if (planned?.write.kind !== 'location') throw new Error('应为地点关系');
    expect(planned.write.additions).toHaveLength(1);

    // 「邻近」对称：两侧都写
    const nearby = validateRelationAssertion(
      {
        assertionType: 'location_relation',
        subject: '藏经阁',
        object: '青云山',
        type: '邻近',
        context: '藏经阁就在青云山旁边',
      },
      prepared,
    );
    if (!nearby.accept) throw new Error('应通过校验');
    const plannedNearby = planRelationWrite(nearby, 2, dedupe);
    if (plannedNearby?.write.kind !== 'location') throw new Error('应为地点关系');
    expect(plannedNearby.write.additions).toHaveLength(2);

    const locChar = validateRelationAssertion(
      { assertionType: 'location_relation', subject: '藏经阁', object: '沈知意', type: '位于', context: '陈星走进藏经阁' },
      prepared,
    );
    if (!locChar.accept) throw new Error('应通过校验');
    const plannedChar = planRelationWrite(locChar, 2, dedupe);
    if (plannedChar?.write.kind !== 'location') throw new Error('应为地点关系');
    expect(plannedChar.write.additions).toEqual([
      { locationId: 'l1', relation: expect.objectContaining({ targetId: 'c3', targetKind: 'character' }) },
    ]);
  });

  it('同一对 + 同一类型重复断言只写一次（同一次扫描内）', () => {
    const prepared = ctx();
    const dedupe = prepareRelationDedupe({ characters: [], items: [], locations: [] });
    const validation = validateRelationAssertion(assert({}), prepared);
    if (!validation.accept) throw new Error('应通过校验');

    expect(planRelationWrite(validation, 3, dedupe)).not.toBeNull();
    expect(planRelationWrite(validation, 4, dedupe)).toBeNull();
  });

  it('已有关系会被索引挡住，不重复堆边', () => {
    const prepared = ctx();
    const dedupe = prepareRelationDedupe({
      characters: [
        { id: 'c1', relations: [{ targetId: 'c2', type: 'mentor', direction: 'to' }] },
        { id: 'c2', relations: [{ targetId: 'c1', type: 'mentor', direction: 'from' }] },
      ],
      items: [],
      locations: [],
    });
    const validation = validateRelationAssertion(assert({}), prepared);
    if (!validation.accept) throw new Error('应通过校验');
    expect(planRelationWrite(validation, 3, dedupe)).toBeNull();
  });
});