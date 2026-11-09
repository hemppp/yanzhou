// ============================================================
// gate-decision 单测 —— 决策器的「解析 / 归一化 / 接线」纯逻辑
//
// 不测网络本身（那要真 Jev）；测的是**最容易出错、且一错就影响每章交付**的部分：
//   · Jev systemone 的 answers（noul / score）能否稳妥换算
//   · 各种脏输出（缺字段 / 越界 / 布尔写成字符串）能否归一
//   · 内容问题分如何变成「打回/放行」以及聚焦哪一条
//   · 配置解析：原生 Jev / chat 兜底 / 显式关闭
//
// ★ 2026-11-09 重写（本文件此前 13 条全红）。
//   原因不是实现坏了，而是**契约在 2026-10-27 整体换过一次**：
//   决策器从「意图门裁判（verdict / primaryIssue / worthIt）」改成「文本体检仪」
//   （aiFlavor / openingRepeat / contentRepeat / quality）。旧字段仍保留但已
//   @deprecated，只作为兼容层**由内容项反推**。本文件此前仍按 10-18 的旧口径断言，
//   所以一直红着。这里按**现役契约**重写，并把兼容层的反推规则一并钉死。
//   实现侧未改动任何行为（除补了两处与实现相反的陈旧注释）。
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
  it('全空 → 决策器默认开启（chat 兜底取 hy3）', () => {
    /**
     * ★ 2026-11-09 口径更正：原断言是「全空 = 关闭」。
     *   2026-10-27 起 chat 兜底**未配置时默认 `hy3`**（见 resolveChatDecisionModel 的
     *   选型表：Jev 被地域门挡死，内容体检又要每章跑，默认关掉等于退回词面统计）。
     *   所以要关必须**显式** `off` / `none`，见下一条。
     */
    expect(resolveJevConfig({})).toBeNull();
    expect(resolveJevFallback({})).toBeNull();
    expect(resolveChatDecisionModel({})).toBe('hy3');
    expect(isDecisionEnabled({})).toBe(true);
  });
  it('显式 off → 关闭（不花钱）', () => {
    expect(resolveChatDecisionModel({ AUTOWRITE_DECISION_MODEL: 'off' })).toBeNull();
    expect(isDecisionEnabled({ AUTOWRITE_DECISION_MODEL: 'off' })).toBe(false);
    expect(resolveChatDecisionModel({ AUTOWRITE_DECISION_MODEL: 'none' })).toBeNull();
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
  it('chat 兜底模型：设了用设定值；off 关闭', () => {
    expect(resolveChatDecisionModel({ AUTOWRITE_DECISION_MODEL: 'z/hy3' })).toBe('z/hy3');
    expect(isDecisionEnabled({ AUTOWRITE_DECISION_MODEL: 'z/hy3' })).toBe(true);
    expect(resolveChatDecisionModel({ AUTOWRITE_DECISION_MODEL: 'off' })).toBeNull();
    expect(isDecisionEnabled({ AUTOWRITE_DECISION_MODEL: 'off' })).toBe(false);
  });
});

describe('decisionFromSystemOneAnswers —— Jev 原生返回换算', () => {
  // 2026-10-27 起的问题集：三项内容质量判定 + 严重度分档
  const answers = {
    aiFlavor: { type: 'score', score: 2.6, confidence: 0.7 },       // round(3.6) = 4
    aiFlavorHasTemplateSyntax: { type: 'noul', noul: 0.81 },        // ≥0.5 → true
    aiFlavorHasExplainingNarrator: { type: 'noul', noul: 0.12 },    // <0.5 → false
    openingRepeat: { type: 'noul', noul: 0.5 },                     // 恰好阈值 → true
    contentRepeat: { type: 'noul', noul: 0.49 },                    // 差一点 → false
    quality: { type: 'score', score: 0.7 },                         // round(1.7) = 2
  };

  it('noul/score 全部正确换算，并反推出兼容字段', () => {
    const d = decisionFromSystemOneAnswers(answers)!;
    expect(d.aiFlavor).toBe(4);
    expect(d.quality).toBe(2);
    expect(d.aiFlavorTemplateSyntax).toBe(true);
    expect(d.aiFlavorExplainingNarrator).toBe(false);
    expect(d.openingRepeat).toBe(true);
    expect(d.contentRepeat).toBe(false);
    // —— 兼容层（@deprecated）：由内容项反推 ——
    expect(d.verdict).toBe('rewrite');        // 有任一重复项 ⇒ rewrite
    expect(d.primaryIssue).toBe('voice');     // openingRepeat ⇒ voice
    expect(d.stalled).toBe(false);            // = contentRepeat
    expect(d.worthIt).toBe(true);             // 新语义恒 true（不再权衡值不值得）
    expect(d.confidence).toBeCloseTo(0.7);    // 取 aiFlavor.confidence
    expect(d.reason).toContain('openingRepeat:0.50');
  });

  it('noul 阈值：P(yes) ≥ 0.5 才是 true', () => {
    const at = decisionFromSystemOneAnswers({
      openingRepeat: { noul: NOUL_YES_THRESHOLD },
      contentRepeat: { noul: NOUL_YES_THRESHOLD - 0.001 },
    })!;
    expect(at.openingRepeat).toBe(true);
    expect(at.contentRepeat).toBe(false);
  });

  it('score 档位换算：0→1、9→10、越界被夹住', () => {
    expect(decisionFromSystemOneAnswers({ aiFlavor: { score: 0 } })!.aiFlavor).toBe(1);
    expect(decisionFromSystemOneAnswers({ aiFlavor: { score: 9 } })!.aiFlavor).toBe(10);
    expect(decisionFromSystemOneAnswers({ aiFlavor: { score: 99 } })!.aiFlavor).toBe(10);
    expect(decisionFromSystemOneAnswers({ quality: { score: -5 } })!.quality).toBe(1);
  });

  it('没有任何内容信号 → null（回退旧规则）', () => {
    expect(decisionFromSystemOneAnswers({})).toBeNull();
    expect(decisionFromSystemOneAnswers(null)).toBeNull();
    // ★ 2026-10-27 起 verdict 已不是问题集的一项，只有它不算有效返回
    expect(decisionFromSystemOneAnswers({ verdict: { choice: 'rewrite' } })).toBeNull();
    expect(decisionFromSystemOneAnswers({ verdict: { choice: 'maybe' } })).toBeNull();
  });

  it('兼容字段 primaryIssue 由内容项反推：内容重复→duplication，开头重复→voice，干净→none', () => {
    expect(decisionFromSystemOneAnswers({ contentRepeat: { noul: 0.9 } })!.primaryIssue).toBe('duplication');
    expect(decisionFromSystemOneAnswers({ openingRepeat: { noul: 0.9 } })!.primaryIssue).toBe('voice');
    expect(decisionFromSystemOneAnswers({ aiFlavor: { score: 5 } })!.primaryIssue).toBe('none');
  });
});

describe('normalizeDecision —— chat 兜底的脏输出归一化', () => {
  it('合法输入原样通过', () => {
    const d = normalizeDecision({
      aiFlavor: 6, aiFlavorHasTemplateSyntax: 'true',
      openingRepeat: false, contentRepeat: true, quality: 7,
      reason: '换句重讲已演过的事件',
    });
    expect(d).toMatchObject({
      aiFlavor: 6, aiFlavorTemplateSyntax: true,
      openingRepeat: false, contentRepeat: true, quality: 7,
      verdict: 'rewrite', primaryIssue: 'duplication', stalled: true,
      reason: '换句重讲已演过的事件',
    });
  });
  it('没有内容信号 → null（含只给旧 verdict 的情况）', () => {
    expect(normalizeDecision({})).toBeNull();
    expect(normalizeDecision({ verdict: 'maybe' })).toBeNull();
    // ★ 2026-10-27 起 verdict 不再是输入字段；只给它已不足以判定有效
    expect(normalizeDecision({ verdict: '  ACCEPT  ' })).toBeNull();
  });
  it('布尔写成字符串 / 数字也认', () => {
    const d = normalizeDecision({ openingRepeat: 'true', contentRepeat: 1, quality: 0 })!;
    expect(d.openingRepeat).toBe(true);
    expect(d.contentRepeat).toBe(true);
    expect(d.primaryIssue).toBe('duplication'); // 两项都真时内容重复优先
  });
  it('quality / aiFlavor 越界夹到 [0,10]；非数字按 0', () => {
    // 必须另带一个信号，否则整条被判无效（见上一条）
    expect(normalizeDecision({ quality: 99, contentRepeat: false })!.quality).toBe(10);
    expect(normalizeDecision({ quality: 'great', contentRepeat: false })!.quality).toBe(0);
    expect(normalizeDecision({ aiFlavor: 99 })!.aiFlavor).toBe(10);
  });
  it('reason 去空白、超长截到 200 字', () => {
    expect(normalizeDecision({ aiFlavor: 3, reason: '  理由  ' })!.reason).toBe('理由');
    expect(normalizeDecision({ aiFlavor: 3, reason: 'x'.repeat(300) })!.reason).toHaveLength(200);
  });
});

describe('decisionToGateAction —— 决策如何变成「打回/放行」', () => {
  /**
   * ★ 2026-11-09：本组此前按旧语义（verdict + worthIt）断言。
   *   现役实现只读内容体检结果（scoreContentProblems），verdict / worthIt 已 @deprecated。
   *   `GateDecision` 的五个内容字段是必填，base 必须补齐（旧版漏填也是 HEAD typecheck
   *   的 7 条 TS2345 来源）。
   */
  const clean = {
    aiFlavor: 0, aiFlavorTemplateSyntax: false, aiFlavorExplainingNarrator: false,
    openingRepeat: false, contentRepeat: false, quality: 7,
    verdict: 'accept' as const, primaryIssue: 'none' as const, worthIt: true, stalled: false,
  };

  it('三项全绿 → 放行', () => {
    expect(decisionToGateAction(clean, 1)).toMatchObject({ pass: true, focus: 'none' });
  });
  it('内容重复 → 打回，聚焦 duplication（单项 45 分已过线）', () => {
    const a = decisionToGateAction({ ...clean, contentRepeat: true }, 1);
    expect(a.pass).toBe(false);
    expect(a.focus).toBe('duplication');
  });
  it('开头重复 → 打回，聚焦 voice（单项 30 分，不必凑总分）', () => {
    const a = decisionToGateAction({ ...clean, openingRepeat: true }, 1);
    expect(a.pass).toBe(false);
    expect(a.focus).toBe('voice');
  });
  it('AI 味 ≥9 档 → 打回，聚焦 voice', () => {
    const a = decisionToGateAction({ ...clean, aiFlavor: 10 }, 1);
    expect(a.pass).toBe(false);
    expect(a.focus).toBe('voice');
  });
  it('AI 味 8 档 → 带瑕疵放行（总分 20 < 40，且未达单项硬线）', () => {
    const a = decisionToGateAction({ ...clean, aiFlavor: 8 }, 1);
    expect(a.pass).toBe(true);
    expect(a.content?.total).toBe(20);
  });
  it('确定性硬伤（篇幅）→ 无视内容体检，直接打回并聚焦该条', () => {
    const a = decisionToGateAction(clean, 2, { nonNegotiable: ['length'] });
    expect(a.pass).toBe(false);
    expect(a.focus).toBe('length');
    expect(a.forcedByHardFact).toBe(true);
  });

  /* ★ 2026-10-29：底线一从「无条件先改一次」收窄为「确实有问题才先改一次」 */
  it('attemptsDone=0 且三项全绿 → 直接放行（不再每章白烧一次重写）', () => {
    const a = decisionToGateAction(clean, 0);
    expect(a.pass).toBe(true);
    expect(a.forcedFirstRewrite).toBeUndefined();
  });
  it('attemptsDone=0 且有问题 → 强制先改一次，并聚焦最重的一项', () => {
    const dup = decisionToGateAction({ ...clean, contentRepeat: true }, 0);
    expect(dup.pass).toBe(false);
    expect(dup.focus).toBe('duplication');
    expect(dup.forcedFirstRewrite).toBe(true);

    const flavor = decisionToGateAction({ ...clean, aiFlavor: 9 }, 0);
    expect(flavor.pass).toBe(false);
    expect(flavor.focus).toBe('voice');
    expect(flavor.forcedFirstRewrite).toBe(true);
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
  it('systemone questions：6 问、类型正确、两个 score 各 10 档', () => {
    // ★ 2026-10-27 问题集：aiFlavor(score) + 两个 AI 味剖面(noul) + 开头/内容重复(noul) + quality(score)
    const q = buildSystemOneQuestions() as Record<string, Record<string, unknown>>;
    expect(Object.keys(q).sort()).toEqual([
      'aiFlavor', 'aiFlavorHasExplainingNarrator', 'aiFlavorHasTemplateSyntax',
      'contentRepeat', 'openingRepeat', 'quality',
    ]);
    expect(q.aiFlavor!.type).toBe('score');
    expect(q.quality!.type).toBe('score');
    expect(q.aiFlavorHasTemplateSyntax!.type).toBe('noul');
    expect(q.aiFlavorHasExplainingNarrator!.type).toBe('noul');
    expect(q.openingRepeat!.type).toBe('noul');
    expect(q.contentRepeat!.type).toBe('noul');
    expect((q.aiFlavor!.criteria as unknown[]).length).toBe(10);
    expect((q.quality!.criteria as unknown[]).length).toBe(10);
  });
});

describe('常量表完整性', () => {
  it('verdict 三种、issue 七种，且无重复', () => {
    expect(new Set(DECISION_VERDICTS).size).toBe(3);
    expect(new Set(DECISION_ISSUES).size).toBe(7);
    expect(DECISION_ISSUES).toContain('plot_stall');
  });
});
