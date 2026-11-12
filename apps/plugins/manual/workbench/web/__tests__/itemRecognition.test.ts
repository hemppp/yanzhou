// ============================================================
// 物品识别后处理回归
//
// 重点锁定实测误识别：
//   · 「500 积分」「100金币」等货币/数值
//   · 「系统面板」「属性面板」等系统 UI
//   · 角色名/地点名被当成物品
//   · 原文里根本没出现的名词
// 以及名称归一化、类型后缀兜底、已有物品去重。
// ============================================================

import { describe, expect, it } from 'vitest';
import type { Item } from '@novel/shared';
import {
  inferItemType,
  isLikelyNonItemName,
  itemNameKey,
  normalizeItemName,
  normalizeItemType,
  prepareItemContext,
  resolveItemType,
  validateItemCandidate,
} from '../knowledge/itemRecognition';

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    projectId: 'p1',
    name: '青锋剑',
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

describe('normalizeItemName / itemNameKey', () => {
  it('去列表序号、书名号、首尾引号与多余空白', () => {
    expect(normalizeItemName('「青锋剑」')).toBe('青锋剑');
    expect(normalizeItemName('1. 青锋剑')).toBe('青锋剑');
    expect(normalizeItemName('  《青锋剑》  ')).toBe('青锋剑');
    expect(normalizeItemName('青锋  剑')).toBe('青锋 剑');
    expect(itemNameKey('「青锋  剑」')).toBe('青锋剑');
  });

  it('剥项目符号与全角序号（旧实现会残留 • / - 与 1）', () => {
    expect(normalizeItemName('• 青锋剑')).toBe('青锋剑');
    expect(normalizeItemName('- 青锋剑')).toBe('青锋剑');
    expect(normalizeItemName('· 青锋剑')).toBe('青锋剑');
    expect(normalizeItemName('（1）青锋剑')).toBe('青锋剑');
    expect(normalizeItemName('【一】青锋剑')).toBe('青锋剑');
  });

  it('成对括号只剥外壳，不产生缺半边括号的截断名称', () => {
    // 旧实现会变成「青锋剑（上品」
    expect(normalizeItemName('青锋剑（上品）')).toBe('青锋剑');
    expect(normalizeItemName('青锋剑(上品)')).toBe('青锋剑');
    expect(normalizeItemName('青锋剑（1）')).toBe('青锋剑');
    // 非品阶括注是名称的一部分，保留
    expect(normalizeItemName('青锋剑（神秘）')).toBe('青锋剑（神秘）');
  });
});

describe('isLikelyNonItemName', () => {
  it.each([
    ['500 积分', '数值/货币'],
    ['100金币', '数值/货币'],
    ['积分', '抽象概念'],
    ['经验', '抽象概念'],
    ['系统面板', '系统界面元素'],
    ['属性面板', '系统界面元素'],
    ['任务提示框', '系统界面元素'],
    ['123', '纯数字'],
    ['三个人', '数量短语'],
    ['   ', '空名称'],
  ])('拒绝非物品 %s', (name, reason) => {
    const result = isLikelyNonItemName(name);
    expect(result.nonItem).toBe(true);
    expect(result.reason).toBe(reason);
  });

  it('保留真正有名字的物品/技能载体', () => {
    for (const name of ['青锋剑', '九转金丹', '金丝软甲', '藏宝图', '任务令牌', '系统空间']) {
      expect(isLikelyNonItemName(name).nonItem).toBe(false);
    }
  });

  it('拒绝反向数值写法与属性词（系统流常见）', () => {
    expect(isLikelyNonItemName('积分+500')).toMatchObject({ reason: '数值/货币' });
    expect(isLikelyNonItemName('等级3')).toMatchObject({ reason: '数值/货币' });
    expect(isLikelyNonItemName('HP 100')).toMatchObject({ reason: '数值/货币' });
    expect(isLikelyNonItemName('+10 魅力')).toMatchObject({ reason: '数值/货币' });
    expect(isLikelyNonItemName('攻击力')).toMatchObject({ reason: '抽象概念' });
    expect(isLikelyNonItemName('５００积分')).toMatchObject({ reason: '数值/货币' });
  });

  it('拒绝指代、描述性短语、句子片段与单字名', () => {
    expect(isLikelyNonItemName('那把剑')).toMatchObject({ reason: '指代短语' });
    expect(isLikelyNonItemName('沈知意的玉佩')).toMatchObject({ reason: '描述性短语' });
    expect(isLikelyNonItemName('青锋剑，剑光如雪')).toMatchObject({ reason: '句子片段' });
    expect(isLikelyNonItemName('剑')).toMatchObject({ reason: '名称过短' });
    // 两字专名「的卢」不能被描述性短语规则误伤
    expect(isLikelyNonItemName('的卢').nonItem).toBe(false);
  });
});

describe('inferItemType / resolveItemType', () => {
  it('按名称后缀推断类型', () => {
    expect(inferItemType('青锋剑')).toBe('weapon');
    expect(inferItemType('金丝软甲')).toBe('armor');
    expect(inferItemType('九转金丹')).toBe('potion');
    expect(inferItemType('藏宝图')).toBe('document');
    expect(inferItemType('玉佩')).toBe('clothing');
    expect(inferItemType('夜明珠')).toBe('gem');
    expect(inferItemType('罗盘')).toBe('tool');
    expect(inferItemType('不知名之物')).toBe('other');
  });

  it('AI 类型优先，缺失或 other 时走后缀推断', () => {
    expect(resolveItemType('青锋剑', 'scroll')).toBe('scroll');
    expect(resolveItemType('青锋剑', '武器')).toBe('weapon');
    expect(resolveItemType('青锋剑', 'other')).toBe('weapon');
    expect(resolveItemType('青锋剑')).toBe('weapon');
    expect(normalizeItemType('丹药')).toBe('potion');
  });

  it('最长后缀优先：复合后缀不再被单字后缀抢先', () => {
    expect(inferItemType('飞剑')).toBe('vehicle'); // 旧实现：weapon（剑）
    expect(inferItemType('玉佩')).toBe('clothing'); // 不是 gem（玉）
    expect(inferItemType('玉简')).toBe('scroll'); // 不是 book（简）或 gem（玉）
    expect(inferItemType('盾牌')).toBe('armor'); // 不是 token（牌）
    expect(inferItemType('丹炉')).toBe('tool'); // 不是 potion（丹）
    expect(inferItemType('马车')).toBe('vehicle');
  });

  it('同名异义的高频词走精确覆盖', () => {
    expect(inferItemType('牡丹')).toBe('plant'); // 旧实现：potion（丹）
    expect(inferItemType('玉米')).toBe('food');
    expect(inferItemType('海马')).toBe('animal');
  });
});

describe('validateItemCandidate', () => {
  const ctx = {
    chapterContent: '陈星拔出青锋剑，剑光如雪。沈知意站在藏经阁外。',
    existingCharacters: [{ name: '沈知意' }],
    existingLocations: [{ name: '藏经阁' }],
  };

  it('接受原文中真实出现的具体物品，并归一化名称/推断类型', () => {
    const result = validateItemCandidate(
      { name: '「青锋剑」', itemType: 'other', context: '陈星拔出青锋剑' },
      ctx,
    );
    expect(result).toEqual({
      accept: true,
      name: '青锋剑',
      type: 'weapon',
      nameKey: '青锋剑',
    });
  });

  it('拒绝货币/系统 UI，即使原文里出现了', () => {
    expect(
      validateItemCandidate({ name: '500 积分', context: '消耗了 500 积分' }, ctx),
    ).toMatchObject({ accept: false, reason: '数值/货币' });
    expect(
      validateItemCandidate({ name: '系统面板', context: '系统面板亮起' }, ctx),
    ).toMatchObject({ accept: false, reason: '系统界面元素' });
  });

  it('拒绝角色名/地点名', () => {
    expect(validateItemCandidate({ name: '沈知意', context: '沈知意' }, ctx)).toMatchObject({
      accept: false,
      reason: '与角色/地点同名',
    });
    expect(validateItemCandidate({ name: '藏经阁', context: '藏经阁' }, ctx)).toMatchObject({
      accept: false,
      // 藏经阁先被「阁」这一组织/地点后缀拦下，比撞名判定更早
      reason: '组织/地点',
    });
  });

  it('拒绝原文中找不到的名称', () => {
    expect(
      validateItemCandidate({ name: '紫电锤', context: '陈星击败了敌人' }, ctx),
    ).toMatchObject({ accept: false, reason: '原文中找不到名称' });
  });

  it('已有物品按归一化键去重，并返回 existingItem', () => {
    const existing = makeItem({ name: '「青锋剑」' });
    const result = validateItemCandidate(
      { name: '青锋剑', context: '陈星拔出青锋剑' },
      { ...ctx, existingItems: [existing] },
    );
    expect(result).toMatchObject({ accept: true, existingItem: existing, type: 'weapon' });
  });

  it('带品阶标注的重复输出能合并回已有物品', () => {
    const existing = makeItem({ name: '青锋剑' });
    const result = validateItemCandidate(
      { name: '青锋剑（上品）', context: '陈星拔出青锋剑' },
      { ...ctx, existingItems: [existing] },
    );
    expect(result).toMatchObject({
      accept: true,
      name: '青锋剑',
      existingItem: existing,
    });
  });

  it('拒绝单字名与全角数字货币', () => {
    expect(validateItemCandidate({ name: '剑', context: '剑光如雪' }, ctx)).toMatchObject({
      accept: false,
      reason: '名称过短',
    });
    expect(
      validateItemCandidate({ name: '５００积分', context: '消耗了 500 积分' }, ctx),
    ).toMatchObject({ accept: false, reason: '数值/货币' });
  });

  it('接地校验忽略间隔号差异（爱丽丝·冯 / 爱丽丝冯）', () => {
    const result = validateItemCandidate(
      { name: '星辰剑', context: '星辰·剑出鞘' },
      { chapterContent: '星辰·剑出鞘，寒光四射。' },
    );
    expect(result).toMatchObject({ accept: true, name: '星辰剑', type: 'weapon' });
  });
});

describe('prepareItemContext', () => {
  const rawCtx = {
    chapterContent: '陈星拔出青锋剑，沈知意站在藏经阁外。',
    existingItems: [makeItem({ name: '「青锋剑」' })],
    existingCharacters: [{ name: '沈知意' }],
    existingLocations: [{ name: '藏经阁' }],
  };

  it('预建索引与原始上下文的校验结果完全一致', () => {
    const prepared = prepareItemContext(rawCtx);
    const candidates = [
      { name: '青锋剑', context: '陈星拔出青锋剑' },
      { name: '紫电锤', context: '陈星击败了敌人' },
      { name: '沈知意', context: '沈知意' },
      { name: '500 积分', context: '消耗了 500 积分' },
      { name: '藏经阁', context: '藏经阁' },
    ];
    for (const candidate of candidates) {
      expect(validateItemCandidate(candidate, prepared)).toEqual(
        validateItemCandidate(candidate, rawCtx),
      );
    }
  });

  it('同一次扫描中新增的物品/角色立即参与去重与撞名', () => {
    const prepared = prepareItemContext({ chapterContent: '陈星拔出青锋剑。' });
    const first = validateItemCandidate({ name: '青锋剑', context: '青锋剑' }, prepared);
    expect(first.accept).toBe(true);
    if (!first.accept) return;

    prepared.addItem(makeItem({ name: first.name }));
    expect(
      validateItemCandidate({ name: '「青锋剑」', context: '青锋剑' }, prepared),
    ).toMatchObject({ accept: true, existingItem: expect.anything() });

    prepared.addEntityName('沈知意');
    expect(
      validateItemCandidate({ name: '沈知意', context: '沈知意' }, prepared),
    ).toMatchObject({ accept: false, reason: '与角色/地点同名' });
  });
});
