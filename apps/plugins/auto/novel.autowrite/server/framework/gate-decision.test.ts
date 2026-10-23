// ============================================================
// gate-decision 单测 —— 决策器的「解析 / 归一化 / 接线」纯逻辑
//
// 不测网络本身（那要真 Jev）；测的是**最容易出错、且一错就影响每章交付**的部分：
//   · Jev systemone 的 answers（choice / noul / score）能否稳妥换算
//   · 各种脏输出（缺字段 / 越界 / 布尔写成字符串）能否归一
//   · accept_with_warning 绝不能变成 rewrite
//   · worthIt=false 时必须带警示放行，不能白烧重写
//   · 配置解析：原生 Jev / chat 兜底 / 全关
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  normalizeDecision, decisionToGateAction, decisionFromSystemOneAnswers,
  resolveJevConfig, resolveJevFallback, resolveChatDecisionModel, isDecisionEnabled,
  buildDecisionUserPrompt, buildSystemOneQuestions, buildDecisionStatePayload,
  DECISION_ISSUES, DECISION_VERDICTS, NOUL_YES_THRESHOLD,
  type DecisionState,
} from './gate-decision.js';

describe('配置解析', () => {
  it('全空 → 决策器关闭（不花钱）', () => {
    expect(resolveJevConfig({})).toBeNull();
    expect(resolveJevFallback({})).toBeNull();
    expect(resolveChatDecisionModel({})).toBeUndefined();
    expect(isDecisionEnabled({})).toBe(false);
  });
  it('配了原生 Jev URL → 启用，默认模型 typesafe/jev-1.13', () => {
    const j = resolveJevConfig({ AUTOWRITE_JEV_URL: 'http://127.0.0.1:3425/v1/systemone', AUTOWRITE_JEV_TOKEN: 'magpie' });
    expect(j).toEqual({ url: 'http://127.0.0.1:3425/v1/systemone', token: 'magpie', model: 'typesafe/jev-1.13' });
    expect(isDecisionEnabled({ AUTOWRITE_JEV_URL: 'http://x/v1/systemone' })).toBe(true);
  });
  it('JEV URL=off → 原生关闭', () => {
    expect(resolveJevConfig({ AUTOWRITE_JEV_URL: 'off' })).toBeNull();
  });
  it('备用端点独立解析；只配备用也算启用', () => {
    const f = resolveJevFallback({ AUTOWRITE_JEV_FALLBACK_URL: 'https://openrouter.ai/api/alpha/decisions', AUTOWRITE_JEV_FALLBACK_TOKEN: 'sk-or-x' });
    expect(f).toEqual({ url: 'https://openrouter.ai/api/alpha/decisions', token: 'sk-or-x', model: 'typesafe/jev-1.13' });
    expect(isDecisionEnabled({ AUTOWRITE_JEV_FALLBACK_URL: 'https://openrouter.ai/api/alpha/decisions' })).toBe(true);
  });
  it('chat 兜底模型：设了启用；off 关闭', () => {
    expect(resolveChatDecisionModel({ AUTOWRITE_DECISION_MODEL: 'z/hy3' })).toBe('z/hy3');
    expect(isDecisionEnabled({ AUTOWRITE_DECISION_MODEL: 'z/hy3' })).toBe(true);
    expect(resolveChatDecisionModel({ AUTOWRITE_DECISION_MODEL: 'off' })).toBeNull();
    expect(isDecisionEnabled({ AUTOWRITE_DECISION_MODEL: 'off' })).toBe(false);
  });
});

describe('decisionFromSystemOneAnswers —— Jev 原生返回换算', () => {
  // 实测真实返回（2026-10-18，typesafe/jev-1.13 经 magpie /v1/systemone）
  const realAnswers = {
    verdict: { type: 'choice', choice: 'rewrite', probabilities: { accept: 0.2, rewrite: 0.42, accept_with_warning: 0.38 }, confidence: 0.13 },
    primaryIssue: { type: 'choice', choice: 'duplication', probabilities: { duplication: 0.58, dialogue: 0.39 }, confidence: 0.51 },
    worthIt: { type: 'noul', noul: 0.49 },
    stalled: { type: 'noul', noul: 0.32 },
    quality: { type: 'score', score: 0.7, legend: {}, probabilities: {}, confidence: 0.4 },
  };

  it('choice/noul/score 全部正确换算', () => {
    const d = decisionFromSystemOneAnswers(realAnswers)!;
    expect(d.verdict).toBe('rewrite');
    expect(d.primaryIssue).toBe('duplication');
    expect(d.worthIt).toBe(false);   // 0.49 < 0.5
    expect(d.stalled).toBe(false);   // 0.32 < 0.5
    expect(d.quality).toBe(2);       // score=0.7 → 索引 +1 → round(1.7)=2
    expect(d.confidence).toBeCloseTo(0.13);
  });

  it('noul 阈值：P(yes) ≥ 0.5 才是 true', () => {
    const yes = decisionFromSystemOneAnswers({ verdict: { choice: 'rewrite' }, worthIt: { noul: NOUL_YES_THRESHOLD }, stalled: { noul: 0.9 } })!;
    expect(yes.worthIt).toBe(true);
    expect(yes.stalled).toBe(true);
  });

  it('score 档位换算：0→1、9→10、越界被夹住', () => {
    expect(decisionFromSystemOneAnswers({ verdict: { choice: 'accept' }, quality: { score: 0 } })!.quality).toBe(1);
    expect(decisionFromSystemOneAnswers({ verdict: { choice: 'accept' }, quality: { score: 9 } })!.quality).toBe(10);
    expect(decisionFromSystemOneAnswers({ verdict: { choice: 'accept' }, quality: { score: 99 } })!.quality).toBe(10);
  });

  it('verdict 非法 / 缺失 → null（回退旧规则）', () => {
    expect(decisionFromSystemOneAnswers({})).toBeNull();
    expect(decisionFromSystemOneAnswers({ verdict: { choice: 'maybe' } })).toBeNull();
    expect(decisionFromSystemOneAnswers(null)).toBeNull();
  });

  it('primaryIssue 非法 → none', () => {
    expect(decisionFromSystemOneAnswers({ verdict: { choice: 'rewrite' }, primaryIssue: { choice: '???' } })!.primaryIssue).toBe('none');
  });
});

describe('normalizeDecision —— chat 兜底的脏输出归一化', () => {
  it('合法输入原样通过', () => {
    const d = normalizeDecision({ verdict: 'rewrite', primaryIssue: 'dialogue', worthIt: true, stalled: false, quality: 6, reason: '对话偏少' });
    expect(d).toMatchObject({ verdict: 'rewrite', primaryIssue: 'dialogue', worthIt: true, stalled: false, quality: 6, reason: '对话偏少' });
  });
  it('verdict 非法 / 大小写容错', () => {
    expect(normalizeDecision({ verdict: 'maybe' })).toBeNull();
    expect(normalizeDecision({ verdict: '  ACCEPT  ' })!.verdict).toBe('accept');
  });
  it('布尔写成字符串 / 数字也认', () => {
    expect(normalizeDecision({ verdict: 'accept', worthIt: 'true', stalled: 1 })!.worthIt).toBe(true);
    expect(normalizeDecision({ verdict: 'accept', worthIt: 'true', stalled: 1 })!.stalled).toBe(true);
  });
  it('quality 越界夹到 [0,10]；非数字按 0', () => {
    expect(normalizeDecision({ verdict: 'accept', quality: 99 })!.quality).toBe(10);
    expect(normalizeDecision({ verdict: 'accept', quality: 'great' })!.quality).toBe(0);
  });
});

describe('decisionToGateAction —— 决策如何变成「打回/放行」', () => {
  const base = { primaryIssue: 'none' as const, stalled: false, quality: 7 };
  // 默认 attemptsDone=1（已改过一次）；0 的底线单独测
  it('accept → 放行', () => {
    expect(decisionToGateAction({ ...base, verdict: 'accept', worthIt: true })).toMatchObject({ pass: true, focus: 'none' });
  });
  it('accept_with_warning → 放行（绝不能变成 rewrite）', () => {
    expect(decisionToGateAction({ ...base, verdict: 'accept_with_warning', worthIt: true }, 2).pass).toBe(true);
  });
  it('rewrite + worthIt=true → 打回，并聚焦 primaryIssue', () => {
    const a = decisionToGateAction({ ...base, verdict: 'rewrite', worthIt: true, primaryIssue: 'dialogue' }, 1);
    expect(a.pass).toBe(false);
    expect(a.focus).toBe('dialogue');
  });
  it('rewrite + worthIt=false（已改过 ≥1 次）→ 带警示放行（别白烧）', () => {
    expect(decisionToGateAction({ ...base, verdict: 'rewrite', worthIt: false }, 2).pass).toBe(true);
  });
  it('rewrite 但 primaryIssue=none → 聚焦 duplication（兜底，不能空转）', () => {
    expect(decisionToGateAction({ ...base, verdict: 'rewrite', worthIt: true, primaryIssue: 'none' }, 1).focus).toBe('duplication');
  });

  /* ★ 2026-10-18 实测教训（第 29 章）：首次复核 worthIt=false 导致一次都没重写就交付 */
  it('attemptsDone=0 + 任意 verdict（含 accept_with_warning/worthIt=false）→ 一律先打回一次', () => {
    for (const v of ['accept', 'accept_with_warning', 'rewrite'] as const) {
      for (const worthIt of [true, false]) {
        const a = decisionToGateAction({ ...base, verdict: v, worthIt }, 0);
        expect(a.pass).toBe(false);
        expect(a.forcedFirstRewrite).toBe(true);
      }
    }
  });
  it('attemptsDone=0 时聚焦决策器的 primaryIssue', () => {
    const a = decisionToGateAction({ ...base, verdict: 'rewrite', worthIt: false, primaryIssue: 'length' }, 0);
    expect(a.pass).toBe(false);
    expect(a.focus).toBe('length');
  });
});

describe('请求体构造', () => {
  const state: DecisionState = {
    chapter: '第7章', chars: 3120, charMin: 2500, charMax: 3500,
    intraDup: 0, crossDup: 3, dialogueRatio: 0.1234, dialogueMin: 0.15,
    leak: 0, rewritesSoFar: 1, maxRewrites: 3, excerpt: '他推开门……',
  };
  it('state payload 含诊断与节选，对话占比保留三位', () => {
    const p = buildDecisionStatePayload(state) as Record<string, unknown>;
    expect(p.chars).toBe(3120);
    expect(p.dialogueRatio).toBe(0.123);
    expect(p.excerpt).toBe('他推开门……');
  });
  it('chat 提示词含诊断数值与节选', () => {
    const p = buildDecisionUserPrompt(state);
    expect(p).toContain('3120');
    expect(p).toContain('第7章');
    expect(p).toContain('他推开门');
  });
  it('systemone questions：5 问、类型正确、choice criteria 是对象、score criteria 是 10 档数组', () => {
    const q = buildSystemOneQuestions() as Record<string, Record<string, unknown>>;
    expect(Object.keys(q).sort()).toEqual(['primaryIssue', 'quality', 'stalled', 'verdict', 'worthIt']);
    expect(q.verdict.type).toBe('choice');
    expect(q.worthIt.type).toBe('noul');
    expect(q.quality.type).toBe('score');
    expect(Array.isArray(q.quality.criteria)).toBe(true);
    expect((q.quality.criteria as unknown[]).length).toBe(10);
    expect(typeof q.verdict.criteria).toBe('object');
  });
});

describe('常量表完整性', () => {
  it('verdict 三种、issue 七种，且无重复', () => {
    expect(new Set(DECISION_VERDICTS).size).toBe(3);
    expect(new Set(DECISION_ISSUES).size).toBe(7);
    expect(DECISION_ISSUES).toContain('plot_stall');
  });
});
