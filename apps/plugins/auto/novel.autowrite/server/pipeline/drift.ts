// ============================================================
// Stage4 · 偏离核查（drift）—— 三层、逐条断言式
//
// 设计见 docs/architecture/ai-writing-multiagent-pipeline.md §4 Stage4。
//
// ★ 为什么必须"逐条断言"而不是"你看有没有跑偏"：
//   后者是开放式提问，模型必然回"整体符合"—— 那种核查等于没有。
//   这里把 brief **拆成可判定的断言**（每条一个 id），逼模型逐条给 `符合/偏离/库中无依据`，
//   于是输出可比对、可计数、可拦东西。
//
// 三层（从硬到软）：
//   L1  brief（作者原话，hash 锁定）     硬：违背开局/世界观/笔风/女主 → 必报，回对应段重修
//   L2  已批准的 cast/bible/plot 契约    硬：与已拍板内容冲突          → 必报
//   L3  项目库事实（角色/伏笔/物品）     软：设定空白或自相矛盾        → 写《待定》交作者
//
// 本文件里**判定与合并是纯函数**（可单测），只有"取判定"那一步调模型。
// ============================================================

import type { SettingsDigest } from '../framework/context-resolver.js';

export type DriftLayer = 'L1' | 'L2' | 'L3';
/** 判定三态。`库里没依据` 不是"偏离"，是**空白** —— 处置不同（进待定 vs 回修） */
export type DriftVerdict = '符合' | '偏离' | '库中无依据';

export interface DriftAssertion {
  /** 稳定 id（L1-1…）—— 逐条比对靠它，别用序号 */
  id: string;
  layer: DriftLayer;
  /** 可判定的断言原文，如「开局：主角在末日前三小时醒来…」 */
  claim: string;
}

export interface DriftJudgment {
  id: string;
  layer: DriftLayer;
  verdict: DriftVerdict;
  /** 证据：正文/契约里的原句（空证据的判定不可信） */
  evidence?: string;
  /** 建议回修哪一段（cast|bible|plot）；无则留空 */
  backTo?: string;
}

export interface DriftReport {
  hard: DriftJudgment[];
  soft: DriftJudgment[];
  /** 建议回修的最早一段（硬偏离里最靠前的那段）；无硬偏离则 null */
  backTo: string | null;
  counts: { total: number; 符合: number; 偏离: number; 库中无依据: number };
}

// ---------------------------------------------------------------- 纯函数

/**
 * 把 brief 拆成 L1 断言（**确定性生成，零模型调用**）。
 *
 * 为什么这层不交给模型拆：brief 的字段本身就是作者写死的硬约束（开局/世界观/笔风/主角/女主/流派），
 * 直接一条一字段最准；让模型"自己总结约束"反而会漏掉它认为不重要的那条 —— 而漏掉的那条往往就是要命的。
 */
export function buildAssertions(brief: Record<string, unknown> | null): DriftAssertion[] {
  if (!brief) return [];
  const pick = (k: string): string => {
    const v = brief[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const rows: Array<[string, string]> = [
    ['opening', '开局'],
    ['worldview', '世界观'],
    ['style', '笔风'],
    ['protagonist', '主角'],
    ['genre', '流派'],
  ];
  const out: DriftAssertion[] = [];
  let i = 1;
  for (const [key, label] of rows) {
    const v = pick(key);
    if (v) out.push({ id: `L1-${i++}`, layer: 'L1', claim: `${label}：${v}` });
  }
  // 女主可能是数组（多女主）或单值
  const heroines = Array.isArray(brief.heroines)
    ? brief.heroines.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : (pick('heroines') ? [pick('heroines')] : []);
  if (heroines.length > 0) {
    out.push({ id: `L1-${i++}`, layer: 'L1', claim: `女主：${heroines.join('、')}（名单与数量都不许改）` });
  }
  return out;
}

/** 渲染成给模型看的清单（逐条要有 id，判定必须回填 id） */
export function renderAssertions(list: readonly DriftAssertion[]): string {
  if (list.length === 0) return '（brief 里没有可判定的硬约束）';
  return list.map((a) => `${a.id}｜${a.claim}`).join('\n');
}

/**
 * 解析某位核查角色的判定（JSON）。
 * 容错：字段名不严谨、verdict 写了同义词都尽量认；认不出来算**未判定**（不当作"符合"）。
 */
export function parseJudgments(raw: unknown, assertions: readonly DriftAssertion[]): DriftJudgment[] {
  const byId = new Map(assertions.map((a) => [a.id, a]));
  const arr = Array.isArray(raw) ? raw : [];
  const out: DriftJudgment[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? o.assertion ?? '').trim();
    const base = byId.get(id);
    if (!base) continue;                       // 认不出的 id 直接丢（防止模型编 id）
    const verdictRaw = String(o.verdict ?? '').trim();
    // ★ 默认值必须是「库中无依据」而不是「符合」：
    //   模型写了个认不出的词（或漏字段）时，判成"符合"会让**没查出来的东西看起来像查过了**；
    //   判成"库中无依据"则会进《待定》被人看见 —— 两者代价差一个数量级。
    const verdict: DriftVerdict = verdictRaw.includes('无依据') || verdictRaw.includes('空白') || verdictRaw.includes('未知')
      ? '库中无依据'
      : verdictRaw.includes('偏离') || verdictRaw.includes('冲突') || verdictRaw.includes('违背') || verdictRaw.includes('违反')
        ? '偏离'
        : verdictRaw.includes('符合') || verdictRaw.includes('一致') || verdictRaw.includes('满足') || verdictRaw.toUpperCase() === 'OK'
          ? '符合'
          : '库中无依据';
    out.push({
      id,
      layer: base.layer,
      verdict,
      evidence: typeof o.evidence === 'string' ? o.evidence.slice(0, 300) : undefined,
      backTo: typeof o.backTo === 'string' ? o.backTo.slice(0, 20) : undefined,
    });
  }
  return out;
}

/**
 * 合并多位核查角色的判定 → 《偏离报告》的结构。
 *
 * 合并规则（别改乱）：
 *   · 同一 id **只要有一人说"偏离"就按偏离**（核查是"谁发现谁说了算"，不是投票）
 *   · L1/L2 的偏离 = **硬偏离**（回修）；L3 的偏离与任何层的"库中无依据" = **软偏离**（进待定）
 *   · 空证据的硬偏离**照样报**，但保留证据字段为空 —— 让作者知道"这条是模型说的、没给出处"
 */
export function mergeDriftReport(judgments: readonly DriftJudgment[]): DriftReport {
  const worst = new Map<string, DriftJudgment>();
  for (const j of judgments) {
    const cur = worst.get(j.id);
    const rank = (v: DriftVerdict) => (v === '偏离' ? 2 : v === '库中无依据' ? 1 : 0);
    if (!cur || rank(j.verdict) > rank(cur.verdict)) worst.set(j.id, j);
  }
  const list = [...worst.values()];
  const hard = list.filter((j) => j.verdict === '偏离' && j.layer !== 'L3');
  const soft = list.filter((j) => j.verdict === '库中无依据' || (j.verdict === '偏离' && j.layer === 'L3'));

  // 回修段：硬偏离里最靠前的一段（cast → bible → plot 的先后就是重修顺序）
  const order = ['cast', 'bible', 'plot'];
  let backTo: string | null = null;
  for (const seg of order) {
    if (hard.some((j) => j.backTo === seg)) { backTo = seg; break; }
  }
  return {
    hard,
    soft,
    backTo,
    counts: {
      total: list.length,
      符合: list.filter((j) => j.verdict === '符合').length,
      偏离: list.filter((j) => j.verdict === '偏离').length,
      库中无依据: list.filter((j) => j.verdict === '库中无依据').length,
    },
  };
}

/** 把报告渲染成人可读的一行摘要（事件/台账用，别让 UI 自己拼） */
export function summarizeDrift(r: DriftReport): string {
  const parts = [`逐条核对 ${r.counts.total} 条`, `符合 ${r.counts.符合}`];
  if (r.counts.偏离 > 0) parts.push(`**偏离 ${r.counts.偏离}**`);
  if (r.counts.库中无依据 > 0) parts.push(`库中无依据 ${r.counts.库中无依据}`);
  if (r.hard.length > 0) parts.push(`硬偏离 ${r.hard.length} 条${r.backTo ? `，建议回修「${r.backTo}」` : ''}`);
  if (r.soft.length > 0) parts.push(`软偏离 ${r.soft.length} 条（进待定）`);
  return parts.join(' · ');
}

/** 该给哪个核查角色看什么（三层对照物，职责分工见设计 §3 的角色矩阵） */
export function driftBriefFor(layer: DriftLayer, digest: SettingsDigest): string {
  if (layer === 'L3') {
    return [
      '【L3 对照物：项目库事实】',
      '角色现状：',
      digest.characters || '（暂无）',
      '伏笔台账：',
      digest.foreshadows || '（暂无）',
      '判定口径：库里**没有**依据的断言判「库中无依据」（这是空白，不是错），',
      '库里**自相矛盾**（同一事实两个值）判「偏离」。',
    ].join('\n');
  }
  if (layer === 'L2') {
    return [
      '【L2 对照物：已批准的契约】',
      '（本段的上面已经给了《角色与节奏宪章》《世界圣经》《剧情总纲》的全文）',
      '判定口径：与已批准内容**冲突**判「偏离」，并写清冲突在契约的哪一句。',
    ].join('\n');
  }
  return [
    '【L1 对照物：作者的 brief（作者原话，最高效力）】',
    '判定口径：违背作者写下的开局/世界观/笔风/主角/女主名单 → 判「偏离」。',
  ].join('\n');
}
