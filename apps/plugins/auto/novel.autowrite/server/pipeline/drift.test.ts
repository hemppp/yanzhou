/**
 * @fileoverview Stage4 偏离核查 —— 纯函数层（判定与合并）
 *
 * 设计文档点名必测的一条：**故意在 brief 里埋一条硬约束，核查能报出来**。
 * 这里用"合成判定"测合并逻辑（确定性、零模型）；真机那一步由脚本跑。
 */

import { describe, expect, it } from 'vitest';
import {
  buildAssertions, mergeDriftReport, parseJudgments, renderAssertions, summarizeDrift,
  type DriftAssertion, type DriftJudgment,
} from './drift.js';

const brief = {
  opening: '主角在末日前三小时醒来，收到自己发来的短信',
  worldview: '末日第三年，**旧水电站只在夜里供电**',
  style: '冷硬克制，短句为主',
  protagonist: '陈默',
  heroines: ['苏晚', '陆离'],
  genre: '末日求生',
};

describe('L1 断言：从 brief 字段确定性拆出（零模型调用）', () => {
  it('一条字段一条断言，id 稳定', () => {
    const a = buildAssertions(brief);
    expect(a.map((x) => x.id)).toEqual(['L1-1', 'L1-2', 'L1-3', 'L1-4', 'L1-5', 'L1-6']);
    expect(a[1]!.claim).toContain('旧水电站只在夜里供电');   // ★ 这条就是"埋进去的硬约束"
    expect(a.every((x) => x.layer === 'L1')).toBe(true);
  });

  it('多女主写成一条，且点明"名单与数量都不许改"', () => {
    const line = buildAssertions(brief).find((x) => x.claim.startsWith('女主'))!;
    expect(line.claim).toContain('苏晚、陆离');
    expect(line.claim).toContain('不许改');
  });

  it('没有 brief → 空清单（不编）', () => {
    expect(buildAssertions(null)).toEqual([]);
    expect(renderAssertions([])).toContain('没有可判定的硬约束');
  });
});

describe('判定解析：认不出的词**不能**算「符合」', () => {
  const list: DriftAssertion[] = buildAssertions(brief);

  it('认 id、认同义词（无依据/冲突/一致）', () => {
    const got = parseJudgments([
      { id: 'L1-2', verdict: '冲突', evidence: '第 3 章写成全天有电', backTo: 'bible' },
      { id: 'L1-3', verdict: '库中无依据' },
      { id: 'L1-1', verdict: '一致' },
    ], list);
    expect(got.find((j) => j.id === 'L1-2')!.verdict).toBe('偏离');
    expect(got.find((j) => j.id === 'L1-2')!.backTo).toBe('bible');
    expect(got.find((j) => j.id === 'L1-3')!.verdict).toBe('库中无依据');
    expect(got.find((j) => j.id === 'L1-1')!.verdict).toBe('符合');
  });

  it('★ 认不出的词 → 库中无依据（不能默认"符合"）', () => {
    const got = parseJudgments([{ id: 'L1-1', verdict: '嗯……大概没事吧' }], list);
    expect(got[0]!.verdict).toBe('库中无依据');
  });

  it('模型编造的 id 直接丢掉（不许凭空多出断言）', () => {
    const got = parseJudgments([{ id: 'L9-9', verdict: '偏离' }, { id: 'L1-1', verdict: '符合' }], list);
    expect(got.map((j) => j.id)).toEqual(['L1-1']);
  });
});

describe('合并《偏离报告》：硬/软分流 + 回修段', () => {
  const hard: DriftJudgment = { id: 'L1-2', layer: 'L1', verdict: '偏离', evidence: '第 3 章全天有电', backTo: 'bible' };

  it('★ 埋一条硬约束能被报出来，并给出回修段（设计要求的必测项）', () => {
    const r = mergeDriftReport([
      { id: 'L1-1', layer: 'L1', verdict: '符合' },
      hard,
    ]);
    expect(r.hard.map((j) => j.id)).toEqual(['L1-2']);
    expect(r.backTo).toBe('bible');
    expect(summarizeDrift(r)).toContain('硬偏离 1 条');
  });

  it('同一断言一人说符合、一人说偏离 → **按偏离**（谁发现谁说了算）', () => {
    const r = mergeDriftReport([
      { id: 'L1-2', layer: 'L1', verdict: '符合' },
      { id: 'L1-2', layer: 'L1', verdict: '偏离', backTo: 'bible' },
    ]);
    expect(r.counts.偏离).toBe(1);
    expect(r.hard).toHaveLength(1);
  });

  it('"库中无依据"与 L3 偏离都算**软**（进待定，不拦人）', () => {
    const r = mergeDriftReport([
      { id: 'L1-1', layer: 'L1', verdict: '库中无依据' },
      { id: 'L2-x', layer: 'L3', verdict: '偏离' },
    ]);
    expect(r.hard).toHaveLength(0);
    expect(r.soft).toHaveLength(2);
    expect(r.backTo).toBeNull();
  });

  it('多条硬偏离时，回修段取**最靠前**的那段（cast → bible → plot）', () => {
    const r = mergeDriftReport([
      { id: 'L1-1', layer: 'L1', verdict: '偏离', backTo: 'plot' },
      { id: 'L1-2', layer: 'L1', verdict: '偏离', backTo: 'cast' },
    ]);
    expect(r.backTo).toBe('cast');
  });

  it('全符合 → 无硬偏离、无需回修', () => {
    const r = mergeDriftReport([{ id: 'L1-1', layer: 'L1', verdict: '符合' }]);
    expect(r.backTo).toBeNull();
    expect(summarizeDrift(r)).not.toContain('硬偏离');
  });
});
