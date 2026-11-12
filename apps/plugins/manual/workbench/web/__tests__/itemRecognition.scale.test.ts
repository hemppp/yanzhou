// ============================================================
// 物品识别 · 10,000 条规模压测
//
// 确定性生成 10,000 个不同物品 + 10,000 条误识别，
// 验证：接受率、类型判断、拒绝原因、去重查找在万级规模下仍然正确。
// ============================================================

import { describe, expect, it } from 'vitest';
import type { Item } from '@novel/shared';
import { prepareItemContext, validateItemCandidate } from '../knowledge/itemRecognition';
import { generateItemCorpus } from './fixtures/itemCorpus';

const corpus = generateItemCorpus();

function makeItem(name: string, index: number): Item {
  return {
    id: `scale-${index}`,
    projectId: 'p-scale',
    name,
    states: [],
    holders: [],
    currentHolders: [],
    relations: [],
    chapters: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('物品识别 · 万级语料', () => {
  it('生成 10,000 个互不相同的正样本与 10,000 条负样本', () => {
    expect(corpus.positives).toHaveLength(10000);
    expect(corpus.negatives).toHaveLength(10000);
    expect(new Set(corpus.positives.map((p) => p.name)).size).toBe(10000);
    expect(new Set(corpus.negatives.map((n) => n.name)).size).toBe(10000);
    // 类型覆盖：weapon/armor/.../other 共 20 类
    expect(corpus.totals.types).toBeGreaterThanOrEqual(18);
  });

  it('10,000 个物品全部被接受，类型 100% 正确', () => {
    const failures: string[] = [];
    // 每 100 条拼成一段正文，同时压测接地校验
    for (let i = 0; i < corpus.positives.length; i += 100) {
      const batch = corpus.positives.slice(i, i + 100);
      const chapter = `${batch.map((p) => p.name).join('，')}。`;
      for (const item of batch) {
        const result = validateItemCandidate(
          {
            name: item.name,
            ...(item.inference ? {} : { itemType: item.type }),
          },
          { chapterContent: chapter },
        );
        if (!result.accept) {
          failures.push(`${item.name} → 拒绝:${result.reason}`);
        } else if (result.type !== item.type) {
          failures.push(`${item.name} → 类型 ${result.type} != ${item.type}`);
        }
        if (failures.length >= 20) break;
      }
      if (failures.length >= 20) break;
    }
    expect(failures).toEqual([]);
  }, 30000);

  it('10,000 条误识别全部被拒绝，原因 100% 正确', () => {
    const entities = corpus.collisionNames.map((name) => ({ name }));
    const failures: string[] = [];
    for (const item of corpus.negatives) {
      const ctx =
        item.reason === '与角色/地点同名'
          ? { existingCharacters: entities, existingLocations: entities }
          : {};
      const result = validateItemCandidate({ name: item.name }, ctx);
      if (result.accept) {
        failures.push(`${item.name} → 误接受:${result.type}`);
      } else if (result.reason !== item.reason) {
        failures.push(`${item.name} → ${result.reason} != ${item.reason}`);
      }
      if (failures.length >= 20) break;
    }
    expect(failures).toEqual([]);
  }, 30000);

  it('在 10,000 条已有物品中仍能正确去重（Map 索引，抽 50 条）', () => {
    const existing = corpus.positives.map((p, i) => makeItem(p.name, i)).reverse();
    const sample = corpus.positives.slice(0, 50);
    const chapter = sample.map((p) => p.name).join('，');
    // 索引只建一次：之后每条候选都是 O(1) 查表
    const prepared = prepareItemContext({ existingItems: existing, chapterContent: chapter });
    const failures: string[] = [];
    for (const item of sample) {
      const result = validateItemCandidate(
        {
          name: item.name,
          ...(item.inference ? {} : { itemType: item.type }),
        },
        prepared,
      );
      if (!result.accept || !result.existingItem || result.existingItem.name !== item.name) {
        failures.push(item.name);
      }
    }
    expect(failures).toEqual([]);
  }, 30000);

  it('13 类拒绝原因全部有覆盖', () => {
    const reasons = Object.keys(corpus.totals.byReason);
    expect(reasons.sort()).toEqual(
      [
        '与角色/地点同名',
        '功法招式',
        '数值/货币',
        '时间短语',
        '抽象概念',
        '描述性短语',
        '数量短语',
        '名称过短',
        '痕迹/证据',
        '系统界面元素',
        '系统玩法',
        '组织/地点',
        '非实体',
      ].sort(),
    );
  });
});
