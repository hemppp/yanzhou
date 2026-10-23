// ============================================================
// Stage6 长跑（production）纯函数回归 —— 零模型 / 零 DB
//
// 这里守的是 M3 里**最容易悄悄坏掉**的判定：
//   · 监工"连续两次 watch → halt"的计数口径（把解析失败也算进去 = 误停整条长跑）
//   · 轨迹确认"解析不出来**不能**当 on_track"（把"没审出问题"和"压根没审"混为一谈）
//   · 批次章号规划（游标续跑的核心：从"已交付的最后一章 + 1"接）
// 这些一旦漂了，表现是"长跑莫名停下"或"跑偏了却没人管"，且不报错。
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  planProductionChapterOrders, productionMessage,
  renderSuperviseInput, parseSuperviseReport, superviseShouldHalt, renderSuperviseReport, CONSECUTIVE_WATCH_TO_HALT,
  renderTrackInput, parseTrackReview, renderTrackReport,
  renderProductionReport, productionSinkNotes,
  type SuperviseResult,
} from './production.js';

describe('长跑章号规划（断点续跑的核心）', () => {
  it('新项目从第 1 章起，一批 5 章', () => {
    expect(planProductionChapterOrders(0)).toEqual([1, 2, 3, 4, 5]);
  });

  it('已交付到第 7 章 → 从第 8 章接（不重写、不跳号）', () => {
    expect(planProductionChapterOrders(7)).toEqual([8, 9, 10, 11, 12]);
  });

  it('批次大小可配', () => {
    expect(planProductionChapterOrders(0, 3)).toEqual([1, 2, 3]);
  });

  it('脏输入（负数/NaN）按 0 处理，不会规划出第 0 章或负数章', () => {
    expect(planProductionChapterOrders(-5)[0]).toBe(1);
    expect(planProductionChapterOrders(Number.NaN)[0]).toBe(1);
  });
});

describe('长跑单章指令', () => {
  it('全书第 1 章按总纲起笔', () => {
    expect(productionMessage(1, false)).toContain('按《剧情总纲》');
  });

  it('非首章要求"接着上一章"，不照抄作者最初那句指令', () => {
    const m = productionMessage(9, true);
    expect(m).toContain('接着上一章');
    expect(m).toContain('第 9 章');
  });

  it('带作者补充时附在末尾', () => {
    expect(productionMessage(3, true, '节奏放慢')).toContain('节奏放慢');
  });
});

describe('监工输入组装', () => {
  it('正文进输入，过长截断且**明说**被截断', () => {
    const long = '字'.repeat(7000);
    const s = renderSuperviseInput({ order: 4, content: long, contentMax: 100 });
    expect(s).toContain('已截断');
    expect(s.length).toBeLessThan(long.length);
  });

  it('台账为空时明说"第一次监工"，不留空壳', () => {
    const s = renderSuperviseInput({ order: 1, content: '正文' });
    expect(s).toContain('第一次监工');
  });

  it('最近章摘要进输入（判断趋势要跟它们比）', () => {
    const s = renderSuperviseInput({
      order: 5, content: 'x', recentSummaries: [{ order: 4, summary: '主角进城' }],
    });
    expect(s).toContain('主角进城');
  });
});

describe('监工报告解析', () => {
  const wrap = (o: unknown) => `好的，这是结果：\n${JSON.stringify(o)}\n以上。`;

  it('正常 JSON：verdict / issues / trend 都解析出来', () => {
    const r = parseSuperviseReport(wrap({
      order: 12, verdict: 'watch', trend: '比前两章更拖',
      issues: [{ kind: 'rhythm', detail: '节奏拖', evidence: '他慢慢地…' }],
    }), 12);
    expect(r.verdict).toBe('watch');
    expect(r.parsed).toBe(true);
    expect(r.issues[0]?.kind).toBe('rhythm');
    expect(r.trend).toContain('更拖');
  });

  it('★ 解析不出来**不算 ok**（"没审出问题"与"压根没审"不能混），且 parsed=false', () => {
    const r = parseSuperviseReport('模型今天没按契约回，这是一段散文。', 7);
    expect(r.verdict).toBe('watch');
    expect(r.parsed).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('判 ok 却列了 issue → 以 issue 为准（有具体问题就该看见）', () => {
    const r = parseSuperviseReport(wrap({
      verdict: 'ok', issues: [{ kind: 'filler', detail: '注水', evidence: '……' }],
    }), 3);
    expect(r.verdict).toBe('watch');
  });

  it('halt 能穿过（这是唯一会打断长跑的判定）', () => {
    const r = parseSuperviseReport(wrap({ verdict: 'halt', issues: [] }), 20);
    expect(r.verdict).toBe('halt');
  });

  it('未知 verdict 落回 watch，不会漏成 ok', () => {
    const r = parseSuperviseReport(wrap({ verdict: 'excellent', issues: [] }), 2);
    expect(r.verdict).toBe('watch');
  });
});

describe('监工 halt 判定', () => {
  const r = (verdict: SuperviseResult['verdict'], parsed = true): SuperviseResult =>
    ({ order: 1, verdict, parsed, issues: [], trend: '' });

  it('单章 halt → 打断', () => {
    expect(superviseShouldHalt([r('ok'), r('halt')])).toBe(true);
  });

  it('单章 watch → 继续', () => {
    expect(superviseShouldHalt([r('ok'), r('watch')])).toBe(false);
  });

  // ★ 2026-10-16 二次修订：CONSECUTIVE_WATCH_TO_HALT = 0 → 连续 watch 不再打断。
  //   实测严格监工质量正常时也几乎每章 watch，"连续 N 次"等于每 7–8 章必停，
  //   30 万字长跑结构上跑不完。现在只有监工**显式 halt** 才停。
  it(`CONSECUTIVE_WATCH_TO_HALT = 0 时，连续 watch 一律不打断`, () => {
    expect(CONSECUTIVE_WATCH_TO_HALT).toBe(0);
    expect(superviseShouldHalt([r('watch'), r('watch'), r('watch'), r('watch'), r('watch')])).toBe(false);
  });

  it('显式 halt 仍打断（这条是长跑唯一的停下条件）', () => {
    expect(superviseShouldHalt([r('watch'), r('watch'), r('halt')])).toBe(true);
  });

  it('空历史 → 不打断', () => {
    expect(superviseShouldHalt([])).toBe(false);
  });
});

describe('监工报告渲染', () => {
  it('判定与问题都写进去', () => {
    const s = renderSuperviseReport({
      order: 9, verdict: 'watch', parsed: true, trend: '略拖',
      issues: [{ kind: 'filler', detail: '这段注水', evidence: '……' }],
    });
    expect(s).toContain('第 9 章');
    expect(s).toContain('注水');
  });
});

describe('轨迹确认输入组装', () => {
  it('总纲作为判断基准进输入', () => {
    const s = renderTrackInput({
      from: 1, to: 3, outline: '第一幕：主角进城', chapters: [{ order: 1, title: '起', content: '正文' }],
    });
    expect(s).toContain('第一幕：主角进城');
    expect(s).toContain('第 1–3 章');
  });

  it('过长的章截断且明说', () => {
    const s = renderTrackInput({
      from: 1, to: 1, outline: 'x',
      chapters: [{ order: 1, title: 'a', content: '字'.repeat(5000) }], perChapterMax: 100,
    });
    expect(s).toContain('已截断');
  });
});

describe('轨迹确认解析', () => {
  const wrap = (o: unknown) => `结果如下：\n${JSON.stringify(o)}`;

  it('on_track 能穿过', () => {
    const r = parseTrackReview(wrap({ verdict: 'on_track', note: '还在轨道上' }));
    expect(r.verdict).toBe('on_track');
    expect(r.parsed).toBe(true);
  });

  it('minor_drift 带补丁', () => {
    const r = parseTrackReview(wrap({ verdict: 'minor_drift', note: '略偏', patch: '第 4 章补一场对峙' }));
    expect(r.verdict).toBe('minor_drift');
    expect(r.patch).toContain('对峙');
  });

  it('major_drift 能穿过（唯一会暂停整条流水线的判定）', () => {
    const r = parseTrackReview(wrap({ verdict: 'major_drift', note: '主线跑偏' }));
    expect(r.verdict).toBe('major_drift');
  });

  it('★ 解析不出来按 minor_drift 保守处理，**绝不静默当 on_track**', () => {
    const r = parseTrackReview('模型没按契约回。');
    expect(r.verdict).toBe('minor_drift');
    expect(r.parsed).toBe(false);
    expect(r.note).toContain('人工复核');
  });

  it('未知 verdict 落回 on_track 以外的保守值？不 —— 只有明确 major/minor 才降级，其余按 on_track', () => {
    // 契约里 on_track 是"继续"，未知词按 on_track 处理是可接受的（不阻塞）；
    // 但**解析失败**必须保守（上一条已测）。
    const r = parseTrackReview(wrap({ verdict: '???', note: '' }));
    expect(r.verdict).toBe('on_track');
    expect(r.parsed).toBe(true);
  });
});

describe('轨迹确认报告渲染', () => {
  it('minor_drift 把补丁写进报告', () => {
    const s = renderTrackReport(4, 6, { verdict: 'minor_drift', note: '略偏', patch: '补一场对峙', parsed: true });
    expect(s).toContain('修正补丁');
    expect(s).toContain('对峙');
  });

  it('major_drift 明说流水线已暂停', () => {
    const s = renderTrackReport(7, 9, { verdict: 'major_drift', note: '跑偏', patch: '', parsed: true });
    expect(s).toContain('暂停');
  });
});

describe('长跑报告与落库提示', () => {
  it('报告写清交付情况与游标', () => {
    const s = renderProductionReport({
      chapters: [{ order: 8, delivered: true, wordCount: 3000, warnings: [] }],
      supervisor: { order: 8, verdict: 'ok', issues: 0 },
      track: null, halted: false, cursor: 8,
    });
    expect(s).toContain('第 8 章');
    expect(s).toContain('第 9 章'); // 接着写的下一章
  });

  it('未交付的章要点名（报告会写得像全交了）', () => {
    const notes = productionSinkNotes([
      { order: 1, delivered: true, wordCount: 3000, warnings: [] },
      { order: 2, delivered: false, wordCount: 0, warnings: ['未交付：已有正文'] },
    ]);
    expect(notes.some((n) => n.includes('第 2 章'))).toBe(true);
  });

  it('全交了就没有"未落库"提示', () => {
    const notes = productionSinkNotes([{ order: 1, delivered: true, wordCount: 3000, warnings: [] }]);
    expect(notes.filter((n) => n.includes('未落库'))).toHaveLength(0);
  });
});
