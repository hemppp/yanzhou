// ============================================================
// 本轮讨论记录的**篇幅预算**（纯函数）
//
// 为什么需要它（2026-10-21 实测）：`buildInput` 此前把 `transcript` **全量**拼进
// 每次发言的 input —— 这是整条链路上**唯一没有预算的口子**。
//   水车有 12000 字预算、上一章有 6000 字、项目现状有 6000 字，
//   唯独"本轮讨论"可以无限长：一章 4–6 个角色、每个 300–3000 字，
//   写作官那一稿就 3000+，再叠上复核与重写，长跑后段的 input 会一路膨胀。
//   实测第 47 章正文 5625 字（上限 3500），且 19 种整段重复、其中四段各出现 4 次、
//   位置等间距约 967 字 —— 输入越长，模型越容易把已写过的段落当成素材再抄一遍。
//
// 预算的三条纪律（与框架里其它截断一致）：
//   ① **最新一轮永远完整**（它正是下一位发言者要对的东西；截了等于给错前提）；
//   ② 从新到旧装，装不下就退化；
//   ③ 省略必须**明说** —— 不能让模型以为"讨论里没提过"。
// ============================================================

export interface TranscriptTurn {
  /** 发言人（角色名） */
  name: string;
  /** 该轮发言全文 */
  text: string;
}

/** 一条讨论记录（含省略标记） */
export interface RenderedTurn {
  name: string;
  text: string;
  /** full = 全文；excerpt = 首尾节选（最新一轮超长时）；snippet = 只留开头；omitted = 整条省略 */
  mode: 'full' | 'excerpt' | 'snippet' | 'omitted';
  /** 原文长度（记账/日志用） */
  originalChars: number;
}

export interface TranscriptBudget {
  /** 整段讨论记录的字符预算 */
  maxChars: number;
  /** 最新一轮的上限；超过就取首尾各一半（写作官的一稿可能 4000+ 字） */
  newestCap: number;
  /** 装不下的旧轮保留的开头字数（太小就整条省略，留半句反而误导） */
  olderSnippet: number;
}

export const TRANSCRIPT_BUDGET_DEFAULT: TranscriptBudget = {
  // 12000 与水车同量级：两者都是"每轮都要带"的部分，加起来不该压过模型窗口。
  maxChars: 12000,
  // 写作官一稿上限 3500 字，留足余量；真到 6000 才节选。
  newestCap: 6000,
  // 150 字足够交代"他提出过什么"，又不至于占掉后面的预算。
  olderSnippet: 150,
};

/** 首尾各取一半的节选（衔接看结尾，方向看开头） */
export function excerptHeadTail(text: string, maxChars: number): string {
  const t = text ?? '';
  if (t.length <= maxChars) return t;
  const half = Math.floor(maxChars / 2);
  return `${t.slice(0, half)}\n……（中间省略 ${t.length - maxChars} 字）……\n${t.slice(-half)}`;
}

/**
 * 把讨论记录裁进预算。**顺序保持时间顺序**（读起来仍是一段对话）。
 *
 * 分配顺序：最新一轮 → 次新 → … 直到预算用完；再往前的旧轮只留开头，
 * 连开头都装不下就整条省略，并在输出末尾统一标一句"更早的 N 条已省略"。
 */
export function budgetTranscript(
  turns: readonly TranscriptTurn[],
  budget: TranscriptBudget = TRANSCRIPT_BUDGET_DEFAULT,
): { turns: RenderedTurn[]; usedChars: number } {
  if (turns.length === 0) return { turns: [], usedChars: 0 };

  const out: RenderedTurn[] = new Array(turns.length);
  let used = 0;

  // ① 最新一轮：无条件收（超长则首尾节选）
  const last = turns.length - 1;
  {
    const t = turns[last]!;
    const text = t.text.length <= budget.newestCap
      ? t.text
      : excerptHeadTail(t.text, budget.newestCap);
    out[last] = {
      name: t.name, text,
      mode: text === t.text ? 'full' : 'excerpt',
      originalChars: t.text.length,
    };
    used += renderOne(out[last]!).length;
  }

  // ② 从次新往旧：能装全文就装，装不下退化，再装不下省略
  for (let i = last - 1; i >= 0; i--) {
    const t = turns[i]!;
    const fullRendered = renderOne({ name: t.name, text: t.text, mode: 'full', originalChars: t.text.length });
    if (used + fullRendered.length <= budget.maxChars) {
      out[i] = { name: t.name, text: t.text, mode: 'full', originalChars: t.text.length };
      used += fullRendered.length;
      continue;
    }
    const snippet = t.text.slice(0, budget.olderSnippet);
    const snippetRendered = renderOne({ name: t.name, text: snippet, mode: 'snippet', originalChars: t.text.length });
    // 至少要能放下"谁说了什么"的开头，否则不如整条省掉（留半句比不留更误导）
    if (snippet.length > 0 && used + snippetRendered.length <= budget.maxChars) {
      out[i] = { name: t.name, text: snippet, mode: 'snippet', originalChars: t.text.length };
      used += snippetRendered.length;
      continue;
    }
    out[i] = { name: t.name, text: '', mode: 'omitted', originalChars: t.text.length };
  }

  return { turns: out, usedChars: used };
}

/** 单条记录的渲染格式（与原先 `◆ ${name}：\n${text}\n` 保持一致，避免模型看到新格式） */
function renderOne(t: RenderedTurn): string {
  if (t.mode === 'omitted') return '';
  if (t.mode === 'snippet') {
    return `◆ ${t.name}：\n${t.text}\n……（此轮发言共 ${t.originalChars} 字，此处只保留开头）`;
  }
  return `◆ ${t.name}：\n${t.text}\n`;
}

/** 渲染成可直接拼进 prompt 的一段文本（末尾附省略说明） */
export function renderTranscript(
  turns: readonly TranscriptTurn[],
  budget: TranscriptBudget = TRANSCRIPT_BUDGET_DEFAULT,
): string {
  const { turns: rendered } = budgetTranscript(turns, budget);
  const omitted = rendered.filter((t) => t.mode === 'omitted').length;
  const body = rendered.filter((t) => t.mode !== 'omitted').map(renderOne).join('\n');
  if (omitted === 0) return body;
  return `${body}\n（更早的 ${omitted} 条发言因篇幅省略；如需细节，按上文「最近章节」或按需回读核对）\n`;
}
