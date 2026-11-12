// ============================================================
// editor/jumpHighlight.ts —— 时间线跳转后，在正文里定位并高亮「内容片段」
//
// 背景（2026-11-06，用户口径「时间线点击跳转的时候对应章节的内容片段应该高亮」）：
//   旧实现只做**整段包含匹配** —— `paraText.includes(事件标题/描述)`。
//   但时间线事件的 title / description 是 AI 对原文的**概括**，不是逐字摘录：
//     事件「看照片与车牌尾号 / 我回到出租屋翻看照片，发现白色车尾号814与母亲生日相同」
//     原文「回到出租屋，我把那张照片翻来覆去地看。白色的车，尾号是我母亲的生日——…814。」
//   `includes` 永远为 false ⇒ 得分全 0 ⇒ 五轮重试后放弃，**一次高亮都不会出现**
//   （实测 console：17 段得分全 0）。而且即便命中，旧实现给**整个段落**刷底色，
//   长段落下用户仍看不出"对应的是哪几句话"。
//
// 本模块做两件事：
//   1. 用**字二元组（bigram）覆盖率 + IDF 权重 + 段落长度归一化**做模糊匹配，
//      概括句与原文共享「照片 / 尾号 / 母亲 / 生日 / 814」这类实词二元组，即可命中；
//   2. 命中段落后，再在**句级**选取得分最高的句子作为「内容片段」，
//      并对「——：」结尾的引子句做跨段延伸（对话常有「还是那个空白发信人：」独占一段）。
//
// ★ IDF 的必要性：本章 19 段里「空白发信人」出现在 4 段，是**章节高频词**；
//   不降权时它会把无关段落顶到第一（实测事件「空白发信人问妹妹名」错选段落 5/15）。
//   `log(1 + N/df)` 让"只出现在本段"的二元组权重远高于高频二元组。
// ★ 长度归一化（除以 √段落二元组数）：长段落天然有更多命中机会，不归一化时
//   短而聚焦的对话段（如「你妹妹叫什么名字？」）永远输给长段落。
//   实测这一项把 9 个真实事件的命中段从 5/9 提升到 9/9。
// ============================================================

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export interface JumpAnchor {
  title: string;
  description: string;
  characters: string[];
  timestamp: string;
  /** 目标章节的 order（用于确认编辑器已切到目标章再开始定位） */
  chapter: number | null;
}

export interface SnippetSegment {
  /** 段落序号（对应传入的 texts 数组下标） */
  paragraphIndex: number;
  /** 片段在该段落纯文本中的起始偏移 */
  start: number;
  /** 片段在该段落纯文本中的结束偏移（不含） */
  end: number;
}

/** 词元分隔符：中英文标点都视为"断句/断词"边界，避免跨标点拼出假二元组 */
const TOKEN_SEPARATOR = /[\s，。！？、；：,.!?;:"'“”‘’（）()\[\]{}《》〈〉—…·\-~～|/\\]+/;

/** 句级切分：句末标点后可能还跟着收尾引号/括号，一并收进本句 */
const SENTENCE_RE = /[^。！？!?…\n]+[。！？!?…]*[”"』」）)]*/g;

/** 引子句：以冒号/破折号/省略号收尾，本身信息量低，需要把下一句带上 */
const LEAD_IN_END_RE = /[：:—…]$/;

/** 段内引子句后面的段落若不超过这个长度，整段作为片段（对话的典型形态） */
const LEAD_IN_TARGET_MAX_CHARS = 120;

/** 三个锚点来源的权重（标题是作者/模型给的概括，比描述更凝练） */
const TITLE_WEIGHT = 1;
const DESC_WEIGHT = 0.8;
const TIME_WEIGHT = 0.6;

/** 角色名命中奖励：原文必定出现角色名，是很强的信号，但不足以单独决定段落 */
const CHARACTER_HIT_BONUS = 0.35;

/** 低于此分认为"没有匹配上"，宁可不亮也不乱亮 */
export const MIN_PARAGRAPH_SCORE = 0.45;

/** 解析 jumpAnchor。兼容历史数据：早期只往 store 里塞一个纯标题字符串。 */
export function parseJumpAnchor(raw: string | null | undefined): JumpAnchor {
  const empty: JumpAnchor = {
    title: '',
    description: '',
    characters: [],
    timestamp: '',
    chapter: null,
  };
  if (!raw) return empty;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      return {
        title: typeof obj.title === 'string' ? obj.title : '',
        description:
          typeof obj.desc === 'string'
            ? obj.desc
            : typeof obj.description === 'string'
              ? obj.description
              : '',
        characters: Array.isArray(obj.chars)
          ? obj.chars.filter((x): x is string => typeof x === 'string' && x.length > 0)
          : [],
        timestamp: typeof obj.time === 'string' ? obj.time : '',
        chapter: typeof obj.chapter === 'number' ? obj.chapter : null,
      };
    }
  } catch {
    // 不是 JSON：按旧格式的「纯标题」处理
  }

  return { ...empty, title: raw };
}

/** 文本 → 二元组集合（按标点切段后，仅在段内取相邻两字） */
export function bigramSet(text: string): Set<string> {
  const set = new Set<string>();
  if (!text) return set;
  for (const segment of text.split(TOKEN_SEPARATOR)) {
    for (let i = 0; i < segment.length - 1; i++) {
      set.add(segment.slice(i, i + 2));
    }
  }
  return set;
}

interface WeightFn {
  (gram: string): number;
}

/** 用「当前章节真实段落」统计 df，得到每二元组的 IDF 权重 */
function buildWeightFn(paragraphGrams: Set<string>[]): WeightFn {
  const df = new Map<string, number>();
  for (const grams of paragraphGrams) {
    for (const gram of grams) df.set(gram, (df.get(gram) ?? 0) + 1);
  }
  const total = Math.max(1, paragraphGrams.length);
  return (gram) => {
    const freq = df.get(gram);
    return freq ? Math.log(1 + total / freq) : 0;
  };
}

interface AnchorGrams {
  title: Set<string>;
  description: Set<string>;
  timestamp: Set<string>;
  /** 参与匹配的并集，用于统计"命中几个二元组" */
  all: Set<string>;
}

function gramAnchor(anchor: JumpAnchor): AnchorGrams {
  const title = bigramSet(anchor.title);
  const description = bigramSet(anchor.description);
  const timestamp = bigramSet(anchor.timestamp);
  return { title, description, timestamp, all: new Set([...title, ...description, ...timestamp]) };
}

function weightedHits(source: Set<string>, target: Set<string>, weight: WeightFn): number {
  let sum = 0;
  for (const gram of source) {
    if (target.has(gram)) sum += weight(gram);
  }
  return sum;
}

function countHits(source: Set<string>, target: Set<string>): number {
  let count = 0;
  for (const gram of source) {
    if (target.has(gram)) count++;
  }
  return count;
}

/**
 * 段落得分 = IDF 加权命中量 / √(段落二元组数) + 角色名奖励。
 * 分数本身没有绝对意义，只用于排序；`MIN_PARAGRAPH_SCORE` 是经验门槛。
 */
function scoreParagraphText(
  text: string,
  textGrams: Set<string>,
  anchorGrams: AnchorGrams,
  weight: WeightFn,
  anchor: JumpAnchor,
): { score: number; hitCount: number } {
  const raw =
    weightedHits(anchorGrams.title, textGrams, weight) * TITLE_WEIGHT +
    weightedHits(anchorGrams.description, textGrams, weight) * DESC_WEIGHT +
    weightedHits(anchorGrams.timestamp, textGrams, weight) * TIME_WEIGHT;

  const normalized = raw / Math.sqrt(Math.max(1, textGrams.size));

  let nameHits = 0;
  for (const name of anchor.characters) {
    if (name.length >= 2 && text.includes(name)) nameHits++;
  }
  const nameBonus = Math.min(nameHits, 2) * CHARACTER_HIT_BONUS;

  return {
    score: normalized + nameBonus,
    hitCount: countHits(anchorGrams.all, textGrams),
  };
}

/**
 * 在整章段落里选出与事件最匹配的一段。
 * 返回 -1 表示没有达到可信门槛。
 */
export function pickBestParagraph(texts: string[], anchor: JumpAnchor): number {
  if (texts.length === 0) return -1;
  const anchorGrams = gramAnchor(anchor);
  if (anchorGrams.all.size === 0 && anchor.characters.length === 0) return -1;

  const paragraphGrams = texts.map(bigramSet);
  const weight = buildWeightFn(paragraphGrams);
  // 锚点只有一两个二元组（如「钥匙」「出发」）时，命中一个就足以说明问题；
  // 锚点很长时要求至少命中两个，避免单个高频二元组把无关段落顶上来。
  const minHits = anchorGrams.all.size <= 2 ? 1 : 2;

  let bestIndex = -1;
  let bestScore = 0;

  texts.forEach((text, index) => {
    const { score, hitCount } = scoreParagraphText(
      text,
      paragraphGrams[index]!,
      anchorGrams,
      weight,
      anchor,
    );
    if (hitCount < minHits) return;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore >= MIN_PARAGRAPH_SCORE ? bestIndex : -1;
}

interface SentenceSpan {
  start: number;
  end: number;
  text: string;
}

/** 切句，并把偏移修正到「去掉首尾空白」的位置 */
function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  for (const match of text.matchAll(SENTENCE_RE)) {
    const rawStart = match.index ?? 0;
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = rawStart + leading;
    const end = rawStart + raw.length - trailing;
    if (end > start) spans.push({ start, end, text: text.slice(start, end) });
  }
  return spans;
}

/**
 * 在命中段落内选取得分最高的句子。
 * 返回 null 表示段落级命中了但句级没有 —— 此时调用方回退到整段。
 */
function pickBestSentence(
  text: string,
  anchor: JumpAnchor,
  anchorGrams: AnchorGrams,
  weight: WeightFn,
): SentenceSpan | null {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return null;

  let best: SentenceSpan | null = null;
  let bestScore = 0;

  for (const sentence of sentences) {
    const grams = bigramSet(sentence.text);
    if (grams.size === 0) continue;
    const { score } = scoreParagraphText(sentence.text, grams, anchorGrams, weight, anchor);
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  return best;
}

function isLeadIn(text: string): boolean {
  return LEAD_IN_END_RE.test(text.trim());
}

function firstNonSpace(text: string): number {
  return text.length - text.trimStart().length;
}

function lastNonSpace(text: string): number {
  return text.trimEnd().length;
}

/**
 * 计算一次跳转要亮起的片段。
 *
 * @param texts 当前编辑器里所有非空段落的 textContent（顺序 = DOM 顺序）
 * @returns 0 或 1 个片段；空数组表示「没有找到可信对应内容」
 */
export function planJumpHighlight(texts: string[], anchor: JumpAnchor): SnippetSegment[] {
  const bestIndex = pickBestParagraph(texts, anchor);
  if (bestIndex < 0) return [];

  const bestText = texts[bestIndex] ?? '';
  const anchorGrams = gramAnchor(anchor);
  const weight = buildWeightFn(texts.map(bigramSet));
  const sentence = pickBestSentence(bestText, anchor, anchorGrams, weight);

  // 句级完全没命中（命中可能跨句）：整段高亮
  if (!sentence) {
    return [{ paragraphIndex: bestIndex, start: firstNonSpace(bestText), end: lastNonSpace(bestText) }];
  }

  // ★ 引子句延伸：结束于「：」「——」「…」的句子通常只是过渡
  //   （如「还是那个空白发信人：」），真正的内容在**下一段**。
  //   下一段不长时整段带上；否则带下一段的第一句。
  if (isLeadIn(sentence.text)) {
    const nextIndex = findNextNonEmptyParagraph(texts, bestIndex);
    if (nextIndex !== -1) {
      const nextText = texts[nextIndex] ?? '';
      const trimmedLength = nextText.trim().length;
      if (trimmedLength > 0 && trimmedLength <= LEAD_IN_TARGET_MAX_CHARS) {
        return [
          {
            paragraphIndex: nextIndex,
            start: firstNonSpace(nextText),
            end: lastNonSpace(nextText),
          },
        ];
      }
      const nextSentence = splitSentences(nextText)[0];
      if (nextSentence) {
        return [{ paragraphIndex: nextIndex, start: nextSentence.start, end: nextSentence.end }];
      }
    }
  }

  return [{ paragraphIndex: bestIndex, start: sentence.start, end: sentence.end }];
}

function findNextNonEmptyParagraph(texts: string[], from: number): number {
  for (let i = from + 1; i < texts.length; i++) {
    if ((texts[i] ?? '').trim().length > 0) return i;
  }
  return -1;
}

// ------------------------------------------------------------------
// 编辑器文档：段落文本 + 字符偏移 → ProseMirror 位置
//
// ★ 高亮不走 DOM 包裹：ProseMirror 的 DOM 观察器会把外来的 <span> 当作
//   被篡改的节点重绘掉（实测 60ms 内消失）。改用 Decoration，
//   位置必须相对于**编辑器文档**计算，而不是相对 DOM 的 textContent。
// ------------------------------------------------------------------

export interface EditorBlock {
  /** 该段落/标题的纯文本（只拼接 text 子节点，与 `node.textContent` 对齐） */
  text: string;
  /** `text[i]` 在编辑器文档里的绝对位置 */
  textPositions: number[];
}

/**
 * 收集文档里所有非空文本块（段落 / 标题），并记录每个字符的文档位置。
 * 记录逐字符位置而不是「起点 + 偏移」：段落里可能有 hardBreak 等
 * 不贡献字符、但占 1 个文档位置的节点，用偏移换算会整体错位。
 */
export function collectEditorBlocks(doc: ProseMirrorNode): EditorBlock[] {
  const blocks: EditorBlock[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return; // 继续向下找 textblock

    const parts: string[] = [];
    const textPositions: number[] = [];
    node.descendants((child, relativePos) => {
      if (child.isText && child.text) {
        const absoluteStart = pos + 1 + relativePos;
        parts.push(child.text);
        for (let i = 0; i < child.text.length; i++) {
          textPositions.push(absoluteStart + i);
        }
      }
      return false; // 不继续深入 text 节点
    });

    const text = parts.join('');
    if (text.trim().length > 0) blocks.push({ text, textPositions });
    return false; // 已处理该文本块，不再深入
  });

  return blocks;
}

/** 把段落内的字符偏移区间换算成编辑器文档位置（Decoration 用，end 开区间） */
export function segmentToDocRange(
  block: EditorBlock,
  segment: { start: number; end: number },
): { from: number; to: number } | null {
  if (
    segment.start < 0 ||
    segment.end > block.text.length ||
    segment.end <= segment.start
  ) {
    return null;
  }
  const from = block.textPositions[segment.start];
  const last = block.textPositions[segment.end - 1];
  if (from == null || last == null) return null;
  return { from, to: last + 1 };
}
