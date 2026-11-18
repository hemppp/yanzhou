// ============================================================
// 系统积分识别规则（纯函数）
//
// 从 useScanProcessors 抽出来的原因：扫描、系统发物补记、面板手动记账
// 三条路径必须用**同一套**金额归一 / 去重 / 物品解析规则，否则会出现
// 「AI 记的账去重了、手记的没去重」这类漂移。
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  auditCreditLedger,
  creditDedupeKey,
  existingCreditDedupeKey,
  normalizeCreditAmount,
  resolveCreditItem,
} from '../knowledge/creditRecognition';

const ITEMS = [
  { id: 'i1', name: '回气丹' },
  { id: 'i2', name: '玄铁护腕' },
  { id: 'i3', name: '刀' },
];

describe('normalizeCreditAmount', () => {
  it('gain/spend 必须是正数', () => {
    expect(normalizeCreditAmount('gain', 100)).toBe(100);
    expect(normalizeCreditAmount('spend', 60)).toBe(60);
    expect(normalizeCreditAmount('gain', 0)).toBeNull();
    expect(normalizeCreditAmount('gain', -5)).toBeNull();
    expect(normalizeCreditAmount('spend', Number.NaN)).toBeNull();
  });

  it('gift 恒为 0（系统赠物不涉及积分）', () => {
    expect(normalizeCreditAmount('gift', 999)).toBe(0);
    expect(normalizeCreditAmount('gift', -1)).toBe(0);
  });
});

describe('creditDedupeKey', () => {
  it('不含 reason 文本（模型换措辞不该重复入账）', () => {
    // 两条流水除了事由措辞之外完全相同
    expect(creditDedupeKey('gain', 100)).toBe(creditDedupeKey('gain', 100));
  });

  it('类型/金额/关联物品任一不同即不同键', () => {
    expect(creditDedupeKey('gain', 100)).not.toBe(creditDedupeKey('spend', 100));
    expect(creditDedupeKey('gain', 100)).not.toBe(creditDedupeKey('gain', 200));
    expect(creditDedupeKey('gift', 0, '回气丹')).not.toBe(creditDedupeKey('gift', 0, '玄铁护腕'));
  });

  it('物品名比较忽略标点与空白', () => {
    expect(creditDedupeKey('gift', 0, '回气丹')).toBe(creditDedupeKey('gift', 0, ' 回气丹 '));
  });
});

describe('existingCreditDedupeKey', () => {
  it('关联物品用 id 反查名称后再比较', () => {
    expect(
      existingCreditDedupeKey({ type: 'gift', amount: 0, relatedItemId: 'i1' }, ITEMS),
    ).toBe(creditDedupeKey('gift', 0, '回气丹'));
  });

  it('没有关联物品时退回 类型+金额', () => {
    expect(existingCreditDedupeKey({ type: 'spend', amount: 500 }, ITEMS)).toBe(
      creditDedupeKey('spend', 500),
    );
  });

  it('关联物品已不存在时也不炸（按无物品处理）', () => {
    expect(
      existingCreditDedupeKey({ type: 'gift', amount: 0, relatedItemId: 'gone' }, ITEMS),
    ).toBe(creditDedupeKey('gift', 0));
  });
});

describe('resolveCreditItem', () => {
  it('精确名优先', () => {
    expect(resolveCreditItem('回气丹', ITEMS)).toMatchObject({ id: 'i1' });
  });

  it('原文写法差异（妖狼牙三枚 ↔ 妖狼牙）能匹配', () => {
    const items = [{ id: 'f1', name: '妖狼牙' }];
    expect(resolveCreditItem('妖狼牙三枚', items)).toMatchObject({ id: 'f1' });
  });

  it('单字名不做包含匹配（「刀」不该命中「断水刀」）', () => {
    const items = [{ id: 'b1', name: '断水刀' }];
    expect(resolveCreditItem('刀', items)).toBeUndefined();
  });

  it('空名 / 找不到时返回 undefined', () => {
    expect(resolveCreditItem('', ITEMS)).toBeUndefined();
    expect(resolveCreditItem(undefined, ITEMS)).toBeUndefined();
    expect(resolveCreditItem('不存在之物', ITEMS)).toBeUndefined();
  });
});

describe('auditCreditLedger', () => {
  const tx = (chapter: number, type: 'gain' | 'spend' | 'gift', amount: number) => ({
    characterId: 'c1',
    chapter,
    type,
    amount,
  });

  it('正常账目：结余、累计收支、赠予次数', () => {
    const audit = auditCreditLedger(
      [tx(1, 'gain', 100), tx(2, 'spend', 60), tx(3, 'gift', 0), tx(4, 'gain', 200)],
      'c1',
    );
    expect(audit).toMatchObject({ balance: 240, gained: 300, spent: 60, gifts: 1 });
    expect(audit.negativeAtChapters).toEqual([]);
  });

  it('中途透支也能查出来（最终结余为正也一样）', () => {
    // 先花 500 再得 1000：最终 +500，但第 1 章就已经是 -500
    const audit = auditCreditLedger([tx(1, 'spend', 500), tx(2, 'gain', 1000)], 'c1');
    expect(audit.balance).toBe(500);
    expect(audit.negativeAtChapters).toEqual([1]);
  });

  it('只统计指定角色的流水', () => {
    const audit = auditCreditLedger(
      [tx(1, 'gain', 100), { ...tx(1, 'gain', 999), characterId: 'c2' }],
      'c1',
    );
    expect(audit.gained).toBe(100);
  });

  it('按章节排序后再算（输入乱序不影响结果）', () => {
    const audit = auditCreditLedger([tx(3, 'gain', 100), tx(1, 'spend', 50)], 'c1');
    expect(audit.negativeAtChapters).toEqual([1]);
    expect(audit.balance).toBe(50);
  });
});