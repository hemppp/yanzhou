// ============================================================
// 文风体检：**自言自语** 与 **术语过载**
//
// ★ 为什么需要（2026-10-30 用户反馈「对话情节太多了、写得太哲学了」）：
//
//   实测第 108 章，两个具体病症：
//
//   ① **自言自语冒充对话**：大量「他朝墙缝撂」「他低声说」「他朝雾里说」，
//      而没有活人在场回应 —— 那是把内心独白写成台词。
//      统计上算进"对话占比"（引号内字数），所以数据看着达标，
//      读起来却是"角色一直在自说自话地分析处境"。
//
//   ② **术语过载**：本书设定黑话（证/档/印/叉/条/漏/洇/裂丝/拓片…）
//      从早期 14.7/千字涨到最新 **38.7/千字（2.6 倍）**。
//      满篇黑话对轰，读者要拿术语反推剧情 —— 像公文不像小说。
//
// 本模块是**纯函数**（零模型、零 DB），可单测、可复现，用于：
//   · 长跑体检（`.runtime/analyze-style.mjs` 同口径）
//   · 闸门（比例超阈值时打回重写）
//
// ★ 设计取舍：**术语检测不设固定词表**。
//   固定词表换个题材就失效，而"本书自己的高频词"才是真问题 ——
//   所以按「同章内高频 2–4 字中文片段」统计，并支持传入**已知人名**排除
//   （人名天然高频，不排除会全是误报）。
// ============================================================

/** 引号（中英文都认）——与 dialogue.ts 同口径 */
const QUOTE_PAIRS: Array<[string, string]> = [['「', '」'], ['"', '"'], ['“', '”']];

/** 极常见虚词/代词 —— 高频是正常汉语，不该当术语 */
const STOP = new Set([
  '一个', '这个', '那个', '什么', '没有', '已经', '还是', '就是', '不是', '自己',
  '他们', '我们', '你们', '起来', '出来', '下来', '过去', '过来', '时候', '地方',
  '一样', '这样', '那样', '一边', '一面', '的话', '可是', '但是', '因为', '所以',
  '如果', '虽然', '而且', '然后', '现在', '可以', '知道', '看见', '听见', '觉得',
]);

export interface ProseStyleReport {
  /** 自语段落数：整段只有引号内容 + 说话人自己的动作，且附近没有第二个人接话 */
  soliloquy: number;
  /** 自语是否过多 */
  soliloquyExcessive: boolean;
  /** 本章高频术语（已排除人名与虚词），按次数降序，最多 8 条 */
  topTerms: Array<{ word: string; count: number }>;
  /** 最高频术语的出现次数 */
  topTermCount: number;
  /** 术语密度（次/千字） */
  jargonPerKchars: number;
  /** 术语是否过载 */
  jargonExcessive: boolean;
}

/** 整段是否「只有一句引号话」：去掉引号内容后剩下的，只有短叙述（说话人动作/神态） */
function isQuoteOnlyParagraph(p: string): { quoteOnly: boolean; narration: string } {
  const s = p.trim();
  let inQ = false;
  let close = '';
  let narration = '';
  let quoteChars = 0;
  for (const ch of s) {
    if (!inQ) {
      const pair = QUOTE_PAIRS.find(([a]) => a === ch);
      if (pair) { inQ = true; close = pair[1]; continue; }
      narration += ch;
    } else {
      if (ch === close || QUOTE_PAIRS.some(([, b]) => b === ch && b !== '"')) { inQ = false; continue; }
      quoteChars += 1;
    }
  }
  return { quoteOnly: quoteChars > 0, narration: narration.trim() };
}

/** 叙述里出现「说话动词」但没有第二个人在场 → 自语候选 */
const SPEECH_VERBS = /(说|道|撂|骂|嘀咕|念叨|嘟囔|念|答|问|喊|叫|低语|自语|自言自语)/;
/** 出现这些 → 有明确的听话对象（不算自语） */
const ADDRESSEE = /(对|向|朝|跟|冲)(他|她|它|你|我|老|科|录|周|灰|沈|丐|阿)|(问他|答他|回他|应他|冲他|朝他)/;

/**
 * 找本章的「高频术语」：2–4 字中文片段，出现 ≥3 次，排除虚词与人名。
 *
 * 为什么不去重生成式地找"最长重复子串"：开销大且噪声高。
 * 2–4 字滑动窗口 + 频次阈值，对"术语对轰"这类问题足够灵敏。
 */
function findTopTerms(text: string, knownNames: readonly string[], limit = 8): Array<{ word: string; count: number }> {
  const clean = text.replace(/[^一-龥]/g, '');
  const freq = new Map<string, number>();
  for (let len = 2; len <= 4; len += 1) {
    for (let i = 0; i + len <= clean.length; i += 1) {
      const w = clean.slice(i, i + len);
      if (STOP.has(w)) continue;
      if (knownNames.some((n) => n && (w.includes(n) || n.includes(w)))) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  // 只留"独立成词"级别的高频（≥3 次）；去重时保留更长的那个
  const sorted = [...freq.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  const picked: Array<{ word: string; count: number }> = [];
  for (const [w, c] of sorted) {
    if (picked.some((p) => p.word.includes(w) || w.includes(p.word))) continue;  // 子串去重
    picked.push({ word: w, count: c });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 自语阈值：一章超过这么多段自言自语就算"对话凑数" */
export const SOLILOQUY_MAX = 4;
/** 单个术语在**一章**内出现超过这么多次就算过载（人名已排除） */
export const TERM_OVERUSE_MAX = 8;
/** 术语密度上限（次/千字）—— 实测 14.7 正常、38.7 明显失控 */
export const JARGON_PER_KCHAR_MAX = 20;

/**
 * 文风体检。
 *
 * @param knownNames 已知角色名（用于从术语统计中排除 —— 人名天然高频）
 */
export function detectProseStyle(
  content: string,
  knownNames: readonly string[] = [],
): ProseStyleReport {
  const text = String(content ?? '');
  const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const n = text.replace(/\s/g, '').length || 1;

  // ① 自语：整段只有引号话 + 说话人自己的动作，且**相邻段没有第二段引号**（=没人接话）
  let soliloquy = 0;
  for (let i = 0; i < paras.length; i += 1) {
    const p = paras[i]!;
    const { quoteOnly, narration } = isQuoteOnlyParagraph(p);
    if (!quoteOnly) continue;
    if (!SPEECH_VERBS.test(narration)) continue;      // 没有"说/撂/骂"→ 可能是纯对话行，不算
    if (ADDRESSEE.test(narration)) continue;          // 明确有听者 → 不算自语
    // 相邻段是否有人接话（另一段引号）—— 有就不算自语
    const prev = paras[i - 1] ?? '';
    const next = paras[i + 1] ?? '';
    const neighborQuote = isQuoteOnlyParagraph(prev).quoteOnly || isQuoteOnlyParagraph(next).quoteOnly;
    if (neighborQuote) continue;
    soliloquy += 1;
  }

  // ② 术语
  const topTerms = findTopTerms(text, knownNames);
  const topTermCount = topTerms[0]?.count ?? 0;
  const totalTermHits = topTerms.reduce((a, t) => a + t.count, 0);
  const jargonPerKchars = (totalTermHits / n) * 1000;

  return {
    soliloquy,
    soliloquyExcessive: soliloquy > SOLILOQUY_MAX,
    topTerms,
    topTermCount,
    jargonPerKchars,
    jargonExcessive: topTermCount > TERM_OVERUSE_MAX || jargonPerKchars > JARGON_PER_KCHAR_MAX,
  };
}

/** 生成给写作官的重写指令（把问题**具体列出来**，不是泛泛说"别太哲学"） */
export function renderProseStyleHint(r: ProseStyleReport): string {
  const parts: string[] = ['【本次重写的硬性要求：去掉"自说自话"与"黑话对轰"】'];
  if (r.soliloquy > 0) {
    parts.push(
      `本章有 **${r.soliloquy} 处自言自语**（对着墙/雾/空气说话，没有活人回应）。`,
      '这些一律改成**动作、生理反应或物件状态** —— 不要让人物把分析结论说出来。',
      '例：「他朝墙缝撂，三路堵死，我绕闸口」→ 改成「他把残纸折两折塞回袖里，起身往闸口方向走」。',
    );
  }
  if (r.topTerms.length) {
    const list = r.topTerms.slice(0, 6).map((t) => `「${t.word}」×${t.count}`).join('、');
    parts.push(
      `本章**术语过载**（每千字 ${r.jargonPerKchars.toFixed(1)} 个，上限 ${JARGON_PER_KCHAR_MAX}）：${list}`,
      '同一个概念**换成人话**说清楚，不要用黑话代替具体物件与具体动作。',
      '反例：「主位洇裂露空，证不够数，填不进簿册」→ 正例：「那半张纸的角洇了水，编号看不清了」。',
    );
  }
  return parts.join('\n');
}
