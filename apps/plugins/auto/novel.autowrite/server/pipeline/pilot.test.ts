// ============================================================
// Stage5 试写（pilot）—— 纯函数单测
//
// 只测"判定"与"渲染"这两层：它们零模型调用、零 DB，能直接断言。
// 真机路径（三章串行、交付落库）走 scripts/verify-pipeline-pilot.mjs，不在单测里跑模型。
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  parsePremiereReview, pilotMessage, pilotSinkNotes, planPilotChapterOrders,
  renderPremiereInput, renderPremiereReport,
} from './pilot.js';

describe('试写章号规划', () => {
  it('新项目从第 1 章起写三章', () => {
    expect(planPilotChapterOrders(0)).toEqual([1, 2, 3]);
  });

  it('已有章节 → 接着往后写（"前三章"在续写场景同样成立）', () => {
    expect(planPilotChapterOrders(7)).toEqual([8, 9, 10]);
  });

  it('脏输入（负数/NaN）按 0 处理，不会规划出第 0 章或负数章', () => {
    expect(planPilotChapterOrders(-5)).toEqual([1, 2, 3]);
    expect(planPilotChapterOrders(Number.NaN)).toEqual([1, 2, 3]);
  });
});

describe('单章指令', () => {
  it('第 1 章点名要按总纲的节拍走', () => {
    expect(pilotMessage(1, true)).toContain('第 1 章');
    expect(pilotMessage(1, true)).toContain('剧情总纲');
  });

  it('后续章要求"接着上一章"，而不是重述作者最初那句指令', () => {
    const m = pilotMessage(3, false);
    expect(m).toContain('接着上一章');
    expect(m).toContain('不要重述');
  });

  it('后续章不带「作者补充」这一段（调用方只给第 1 章传 extra）', () => {
    expect(pilotMessage(1, true, '写快点')).toContain('【作者补充】');
    // 不传 extra 时不该出现空壳标题
    expect(pilotMessage(2, false)).not.toContain('作者补充');
    expect(pilotMessage(2, false)).toContain('接着上一章');
  });
});

describe('跨章审阅输入的组装', () => {
  const chapters = [
    { order: 1, title: '第一章', content: '甲'.repeat(100) },
    { order: 2, title: '第二章', content: '乙'.repeat(20) },
  ];

  it('三章都进输入，并给出章号', () => {
    const t = renderPremiereInput({ chapters });
    expect(t).toContain('第 1 章');
    expect(t).toContain('第 2 章');
  });

  it('过长的章要被截断，且**明说被截断**（否则会以为后面没内容了）', () => {
    const t = renderPremiereInput({ chapters: [{ order: 1, title: 'x', content: '甲'.repeat(50) }], perChapterMax: 10 });
    expect(t).toContain('已截断');
    expect(t.length).toBeLessThan(200);
  });

  it('契约会作为判断基准一起给（正文里看不到宪章）', () => {
    const t = renderPremiereInput({ chapters, contracts: [{ label: '世界圣经', text: '只有晚上有电' }] });
    expect(t).toContain('世界圣经');
    expect(t).toContain('只有晚上有电');
  });
});

describe('跨章审阅的解析', () => {
  const ok = JSON.stringify({
    voice: '三章语感一致', arc: '主角从躲到面对', foreshadow: '埋了 2 条，1 条有推进',
    cohesion: '像同一本书', verdict: 'minor',
    issues: [{ kind: 'forESHADOW', detail: '第二条伏笔三章没有回响', evidence: '"他把信塞回抽屉"', fix: '第 4 章给一次回响' }],
  });

  it('正常 JSON：字段与 issue 都解析出来，kind 归一成小写白名单', () => {
    const r = parsePremiereReview(`审阅如下：\n${ok}\n以上。`);
    expect(r.verdict).toBe('minor');
    expect(r.voice).toBe('三章语感一致');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.kind).toBe('foreshadow');
    expect(r.issues[0]!.fix).toContain('第 4 章');
  });

  it('解析不出来**不算 pass**（"没审出问题"与"压根没审"不能混成一个结果）', () => {
    const r = parsePremiereReview('我觉得写得挺好的，没什么问题。');
    expect(r.verdict).not.toBe('pass');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.detail).toContain('没能解析');
  });

  it('判 pass 却列了 issue → 以 issue 为准（有具体问题就该看见）', () => {
    const r = parsePremiereReview(JSON.stringify({ verdict: 'pass', issues: [{ kind: 'arc', detail: '主角三章没动' }] }));
    expect(r.verdict).toBe('minor');
  });

  it('未知 verdict 落回 minor，不会漏成 pass', () => {
    expect(parsePremiereReview(JSON.stringify({ verdict: 'excellent' })).verdict).toBe('minor');
  });

  it('issue 没有 detail 的条目被丢掉（空话不算问题）', () => {
    const r = parsePremiereReview(JSON.stringify({ verdict: 'minor', issues: [{ kind: 'voice' }, { kind: 'arc', detail: '有效' }] }));
    expect(r.issues).toHaveLength(1);
  });

  it('major 能穿过（这是唯一会让人停下来重写的判定）', () => {
    expect(parsePremiereReview(JSON.stringify({ verdict: 'major', issues: [{ kind: 'voice', detail: '文风断层' }] })).verdict).toBe('major');
  });
});

describe('审阅报告渲染', () => {
  it('把交付情况与问题都写进去（报告要能独立看懂）', () => {
    const r = parsePremiereReview(JSON.stringify({
      voice: 'v', arc: 'a', foreshadow: 'f', cohesion: 'c', verdict: 'minor',
      issues: [{ kind: 'arc', detail: '主角没动', evidence: '原句', fix: '第 4 章推一把' }],
    }));
    const t = renderPremiereReport(r, [{ order: 1, wordCount: 3000 }, { order: 2, wordCount: 2800 }]);
    expect(t).toContain('第 1 章（3000 字）');
    expect(t).toContain('第 2 章（2800 字）');
    expect(t).toContain('主角弧光');
    expect(t).toContain('证据：原句');
    expect(t).toContain('改法：第 4 章推一把');
  });

  it('pass 且无问题时不留"需修正"空壳', () => {
    const t = renderPremiereReport(parsePremiereReview(JSON.stringify({ verdict: 'pass', issues: [] })), [{ order: 1 }]);
    expect(t).not.toContain('需修正');
  });
});

describe('交付情况 → 落库提示', () => {
  it('全交了就没有提示', () => {
    expect(pilotSinkNotes([{ order: 1, delivered: true, wordCount: 3000, warnings: [] }])).toEqual([]);
  });

  it('有章没交 / 带警示交付都要点名（报告会写得像全交了）', () => {
    const notes = pilotSinkNotes([
      { order: 1, delivered: true, wordCount: 3000, warnings: [] },
      { order: 2, delivered: false, wordCount: 0, warnings: ['意图门未通过'] },
      { order: 3, delivered: true, wordCount: 1000, warnings: ['意图门未通过（打回 2 次），请人工复核本章'] },
    ]);
    expect(notes.some((n) => n.includes('1 章未落库') && n.includes('第 2 章'))).toBe(true);
    expect(notes.some((n) => n.includes('2 章带警示交付'))).toBe(true);
  });
});
