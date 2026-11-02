// ============================================================
// 确定性「章内重复」检测 —— 长跑段整句/整段复读的代码级兜底
//
// 为什么必须有它（2026-10-16 实测根因）：
//   长跑（production）段产出的章节里，整句/整段在同一章内反复出现
//   （实测：某句出现 4 次、某段出现 3 次；更早一次第 1 章 164 段里 59 段重复，
//   单句「他坐在床沿，和发现报告前一样的位置」出现 7 次）。
//
//   排查结论：pilot（前三章）与 production（长跑）**走的是同一条路径** ——
//   两者都调 `discuss/orchestrator.runDiscussion`，都过同一道意图门（本文件不改这个事实）。
//   真正的漏洞在于：「去重」这道交付红线**只写在意图复核的提示词里**，靠模型自己
//   读完长稿再自报「去重：不通过」。模型对自己刚写出的长文常漏报复读（尤其在
//   「写不满字数就复述」的诱导下），于是重复稿照样通过交付。监工虽能看见，但那是
//   **交付之后**、且要到 >5 处才 halt —— 太晚，章已经落库。pilot 因为章节短、
//   上下文新、模型注意力足，没暴露这个缺陷。
//
//   所以这里用**代码**数一遍：不依赖模型、不花 token、结果可复现。
//   它在意图门里与模型的红线判定**取或** —— 模型没看出来，代码也能拦下并打回重写。
//
//   2026-10-16 追加第二类：**变体式重复**（缺陷 A）。上面的精确匹配归一化掉标点
//   空白后逐句计数，只能抓「一字不改」的复读；而实测里模型更常换个说法原样重写 ——
//   「墙立着，他刚起步，体系用墙拦，还没到人拦。」↔「低岗的墙立着，他刚起步，体系用
//   墙拦，还没到人拦。」（Jaccard 0.83），或只改句尾一个字（「记了位置」↔「记了位」，
//   Jaccard 0.95），又或者整段情节（起床抽腕屏→出门遇中层→回屋翻底稿→塞预警纸）
//   被重写 4 次。这些**一条都没被精确规则计到**，必须用近似相似度兜。
//
// 本文件是纯函数（零模型 / 零 DB），单测直接覆盖（见 repetition.test.ts）。
// 作用域刻意限定为**章内**：跨章雷同交给监工/轨迹确认（它们手里有前几章可比）。
// ============================================================

import { normalizeProse } from '../framework/text.js';

/**
 * 计为「重复」的最短句长（归一化后）。
 *
 * ★ 2026-10-16 从 10 提到 16：实测 10 字会把大量**正常短句**算成重复
 *   （「他缩了缩脖子。」「雨又密了。」「脚步声在空街里回得清楚。」）——
 *   一章里冒出几十处"重复"的假警报，把真正该修的**成段复读**淹掉。
 *   16 字以上还原样撞，才真有可疑。
 */
export const REPETITION_MIN_SENTENCE_CHARS = 16;
/** 计为「重复」的最短段长（归一化后）。整段雷同是硬伤，阈值放低一档。 */
export const REPETITION_MIN_PARAGRAPH_CHARS = 20;
/**
 * 「多出来的重复」累计到多少就判过度重复。
 * 口径对齐 ROLE_REVIEWER 的【去重】红线：「有两处以上重复，判不通过」。
 *   · 同一句出现 2 次 → 多 1 次（容忍，可能是有意的复沓）
 *   · 同一句出现 3 次 → 多 2 次（判过度 —— 典型的"复述凑字数"）
 *   · 两句各出现 2 次 → 多 2 次（判过度）
 */
export const REPETITION_MAX_EXCESS = 2;

/**
 * 近似重复 · 字符 3-gram 的 Jaccard 下限。
 *
 * ★ 0.60 的来由（2026-10-16 用本仓真实产出标定，同一项目已交付的第 1–5 章）：
 *   把每章里所有 ≥16 字的句子两两比一遍，取「非精确重复」的最高分：
 *     · 正常章（第 1 章）：最高分 0.52（「结论页的签名和底稿不一致，这不算事？」
 *       vs「…这不是局部能糊过去的事。」）—— 这是**同一件事的两种说法**，属正常行文，
 *       必须是放过的那一侧；
 *     · 待抓章（第 5 章）：高分对是 0.73 / 0.83 / 0.95 —— 全是换字重写；
 *   0.60 落在这道**自然断档**（0.52 → 0.73）的正中，两侧各留 0.08 余量。
 *   ★ 误伤教训：0.55 时第 4 章会命中一对（0.60），但那一对经人工核对是正常呼应
 *   （同一动作在两个场景里的收束句），不构成复读 —— 所以下限必须高于 0.60 以下
 *   的那类"共同词多"的句子。用 0.60 并叠加下面的编辑相似度条件后，第 1–4 章全部为 0。
 */
export const NEAR_DUP_JACCARD_MIN = 0.6;
/**
 * 近似重复 · 归一化编辑相似度下限（1 - 编辑距离 / 较长长度）。
 *
 * 为什么要**两道**门槛而不是一道：Jaccard 对"顺序"不敏感、对"同词换位/插话"宽容——
 * 正常行文里相邻句子共用名词、动作词（「他把纸往深处推」「纸贴着肋」），
 * 3-gram 交集很容易堆到 0.6，但句子的**结构**其实完全不同。
 * 编辑相似度对整句改写敏感，能把「换词复写」（0.72~1.00）与「只是用到同几个词」
 * （实测第 1–4 章最高 0.79，且此时 Jaccard 都在 0.44 以下）分开。
 * 0.72 同样取自上面那道实测断档（正常侧 ≤0.79 但 Jaccard 不达标；待抓侧 ≥0.68 且
 * Jaccard 全部 ≥0.60 —— 两个条件**同时**成立才算，正是「换词复写」的特征）。
 */
export const NEAR_DUP_EDIT_MIN = 0.72;
/**
 * 近似重复「多出来的次数」累计到多少就判过多。
 *
 * 实测标定：正常章（第 1–4 章）近似簇 excess 全是 0；待抓章（第 5 章）是 3
 * （三个簇：「卷帘门最后一声响」少个"远处"、「墙立着…还没到人拦」多个"低岗"、
 * 「记了位置」变「记了位」）。取 2 与精确重复同口径 —— 一两个呼应句算正常，
 * 三个以上同型改写就是复读。孤立的一对（excess=1）放过，避免误伤正常呼应。
 */
export const NEAR_DUP_MAX_EXCESS = 2;

export interface RepetitionFinding {
  /** 首次出现时的原句/原段（保留标点，便于人读与回填重写指令） */
  text: string;
  /** 本章内出现次数 */
  count: number;
}

/** 近似重复的一组句子：代表句 + 各变体 + 组内规模 */
export interface NearDuplicateFinding {
  /** 组内**首次出现**的那句原文（让写作官先认出是哪一段情节） */
  text: string;
  /** 该组句子总数（不同写法都算一个成员） */
  count: number;
  /** 组内出现的**不同写法**（最多留前几个，供写作官比对到底删哪些） */
  variants: string[];
}

export interface RepetitionReport {
  /** 重复的长句（按重复次数降序） */
  sentences: RepetitionFinding[];
  /** 重复的整段（按重复次数降序） */
  paragraphs: RepetitionFinding[];
  /** 重复长句「多出来」的次数之和（每条 count-1 累加）——超阈值即判过度 */
  excessSentences: number;
  /** 近似重复的长句组（换词重写 / 只改句尾等；按组内规模降序） */
  nearDuplicates: NearDuplicateFinding[];
  /** 近似重复「多出来」的次数之和（每条 count-1 累加） */
  excessNearDuplicates: number;
  /** **精确**重复是否过头 */
  exactExcessive: boolean;
  /** **近似**重复是否过头（缺陷 A：换词重写的代码兜底） */
  approximateExcessive: boolean;
  /** 情节块复用（同一块内容被讲了两遍）——见 detectBlockReuse 的标定说明 */
  blockReuse: BlockReuseFinding[];
  /** 是否检出情节块复用 */
  blockReuseExcessive: boolean;
  /** 两类重复任一过头即 true（调用方据此打回/重写） */
  excessive: boolean;
}

/**
 * 归一化：只留汉字与字母数字，丢掉空白与标点。
 * 目的：让「同一句换个标点 / 多一个空格」也被认成同一句 —— 否则模型把句号改成
 * 省略号就能绕过检测（实测里正是这么复读的）。
 * ★ 实现提到 framework/text.ts 的 normalizeProse：对话占比也要用同一把尺子。
 */
function normalize(s: string): string {
  return normalizeProse(s);
}

/** 字符 n-gram 集合（n=3）。短于 n 的串整体作为唯一 gram，避免空集。 */
function ngrams(s: string, n = 3): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n));
  if (s.length < n) set.add(s);
  return set;
}

/** 两个 gram 集合的 Jaccard 相似度（交集 / 并集）；两个都空视为 1。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * 归一化编辑相似度 = 1 - 编辑距离 / 较长的那个长度。
 *
 * 为什么要它：Jaccard 只看「共同 gram 多不多」，对**词序**与**句子结构**不敏感 ——
 * 两句共用几个名词短语就能堆到 0.6+。编辑相似度衡量「整句是不是同一句话改的」，
 * 两者**同时**达标才是「换词复写」。O(n·m) 但两边都 ≤ 一两百字，且只在
 * Jaccard 已达标的对上才算，章内长句数十条 → 开销可忽略。
 */
function editSimilarity(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - (prev[n] ?? 0) / Math.max(m, n);
}

/**
 * 找**近似重复**的长句组。
 *
 * 判据（两者必须同时成立，见两个常量的标定说明）：
 *   · 3-gram Jaccard ≥ NEAR_DUP_JACCARD_MIN
 *   · 编辑相似度 ≥ NEAR_DUP_EDIT_MIN
 * **精确相同**的句子在这里跳过 —— 它们已由 countRepeats 用同一把尺子量过，
 * 再算一遍会让「一句复现 2 次」同时顶起 excessSentences 与 excessNearDuplicates，
 * 双重计数把阈值凭空压低一半（误伤刻意复沓）。
 *
 * 组的合并用并查集：A≈B、B≈C 记成一组（传递性），代表句取**首次出现**的那句原文。
 */
function findNearDuplicates(text: string): { findings: NearDuplicateFinding[]; excess: number } {
  const sents = splitSentences(text)
    .map((raw) => ({ raw, norm: normalize(raw) }))
    .filter((s) => s.norm.length >= REPETITION_MIN_SENTENCE_CHARS);
  if (sents.length < 2) return { findings: [], excess: 0 };

  const grams = sents.map((s) => ngrams(s.norm));
  const parent = sents.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (let i = 0; i < sents.length; i++) {
    for (let j = i + 1; j < sents.length; j++) {
      const a = sents[i]!;
      const b = sents[j]!;
      if (a.norm === b.norm) continue;                       // 精确重复另有其规则
      if (jaccard(grams[i]!, grams[j]!) < NEAR_DUP_JACCARD_MIN) continue;
      if (editSimilarity(a.norm, b.norm) < NEAR_DUP_EDIT_MIN) continue;
      const ra = find(i);
      const rb = find(j);
      if (ra !== rb) parent[ra] = rb;
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < sents.length; i++) {
    const r = find(i);
    const list = groups.get(r);
    if (list) list.push(i);
    else groups.set(r, [i]);
  }

  const findings: NearDuplicateFinding[] = [];
  let excess = 0;
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    // 组内必须真有**两种以上写法**才算「变体式重复」；全同的组交给精确规则
    const distinct = new Set(ids.map((i) => sents[i]!.norm));
    if (distinct.size < 2) continue;
    // 组内顺序即句子在文中出现的顺序（groups 是按 i 递增 push 的），ids[0] 就是首现
    const variants: string[] = [];
    const seen = new Set<string>();
    for (const i of ids) {
      const n = sents[i]!.norm;
      if (seen.has(n)) continue;
      seen.add(n);
      variants.push(sents[i]!.raw);
      if (variants.length >= 3) break;   // 只列前三种写法，够写作官认出并删改了
    }
    findings.push({ text: sents[ids[0]!]!.raw, count: ids.length, variants });
    excess += ids.length - 1;
  }
  findings.sort((a, b) => b.count - a.count);
  return { findings, excess };
}

/** 切句：按中文/英文句末标点与换行切。没有句末标点的一段就是一句。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？…!?])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 数一组文本里「重复且够长」的条目。
 * 按归一化后的内容计数，但输出**首次出现的原文**（人读的是标点完整的句子）。
 */
function countRepeats(units: string[], minChars: number): RepetitionFinding[] {
  const byKey = new Map<string, { text: string; count: number }>();
  for (const u of units) {
    const key = normalize(u);
    if (key.length < minChars) continue;
    const hit = byKey.get(key);
    if (hit) hit.count += 1;
    else byKey.set(key, { text: u, count: 1 });
  }
  return [...byKey.values()]
    .filter((v) => v.count >= 2)
    .sort((a, b) => b.count - a.count)
    .map((v) => ({ text: v.text, count: v.count }));
}

/**
 * 检测一章正文里的**章内**重复（整句 / 整段 / 近似句组）。
 *
 * 判据：
 *   · 整段重复 → 直接判过度（哪怕只多一段，一段雷同就是硬伤）；
 *   · 整句**精确**重复 → 看「多出来的次数」之和是否达 REPETITION_MAX_EXCESS；
 *   · 整句**近似**重复（换词重写）→ 同样看「多出来的次数」之和是否达
 *     NEAR_DUP_MAX_EXCESS；两类**各判各的**（不合并 excess，避免一条精确重复
 *     顺带把近似额度也吃掉）。
 * 只看本章内部，不比对其他章节。
 *
 * ★「整段」只认**含两句以上**的自然段：单句独占一行很常见（网文排版），
 *   那是「整句重复」，交给句子规则按阈值判，不能既当段落又当句子双记
 *   ——否则一句复现 2 次就被段规则硬判过度，正常的刻意复沓会被误伤。
 */
/**
 * ★ 2026-10-22：**情节块复用**检测 —— 「同一块内容被讲了两遍」。
 *
 * 为什么句子级 / 段落级都漏掉它：实测第 27 章整章被抄了两遍（`段0↔段14`、`段1↔段15`、
 * `段2↔段16` 逐字相同），但**逐句计数**只在"同一句出现 ≥2 次"时才报 ——
 * 抄两遍意味着**一句也没多**（每句恰好 2 次，分散在 28 个段落里，看不出"整块重来"）。
 *
 * 判据（标定见下）：把正文切成 K 块，各块取**稀有锚点**（全章词频 ≤3 的二元组，
 * 高频虚词没有区分力），再看**非相邻块**之间的锚点重合度。
 *   非相邻 = 至少隔一块：相邻块本来就共享话题词，隔一块才说明"绕回去又讲了一遍"。
 *
 * 实测标定（本机 86 章的书，`块间稀有锚点重合度`）：
 *   · 已知整章抄两遍：第 24 章 **58%** / 第 27 章 **100%** / 第 39 章 **62%** / 第 70 章 **56%**
 *   · 干净章（3/4/5/6/84/85/86/20/40/60/80）：8%–33%
 *   · 断档清晰 ⇒ 阈值取 **45%**（两侧各留 ~12 个百分点余量）。
 *
 * ⚠️ 它**抓不到**「同一批事件换一套句子重讲」——第 1 章就是那样（我读过，确实讲了两遍），
 *   但它的块间重合度只有 **14%**，落在干净区间里。四轮标定（段落 Jaccard / 章内 LCS /
 *   锚点顺序一致率 / 两轮切点）都分不开它。**词面统计测不出语义重讲**，那一类只能靠
 *   语义判断（写作监工的 `filler` / `plot_stall`），不要在代码里假装能测。
 */
export interface BlockReuseFinding {
  /** 块序号（从 0 起） */
  fromBlock: number;
  toBlock: number;
  /** 两块稀有锚点的重合度（交集 / 较小集合） */
  overlap: number;
  /** 共用的锚点样例（给人看，判断是不是真重复） */
  sample: string[];
}

/** 块间稀有锚点重合度阈值 —— 实测断档 33% ↔ 56%，取中间偏保守的 45% */
export const BLOCK_REUSE_MIN = 0.45;
/** 切几块。太少则"块"粒度粗（一块里本来就有多个情节），太多则每块锚点太少、噪声大 */
export const BLOCK_REUSE_SEGMENTS = 6;
/** 每个块至少要有的稀有锚点数，不够就不比（太短的章没有统计意义） */
const BLOCK_REUSE_MIN_ANCHORS = 20;

export function detectBlockReuse(content: string): BlockReuseFinding[] {
  const n = normalize(content);
  if (n.length < BLOCK_REUSE_SEGMENTS * 80) return [];      // 太短，切块没意义

  const freq = new Map<string, number>();
  for (let i = 0; i + 2 <= n.length; i++) {
    const g = n.slice(i, i + 2);
    freq.set(g, (freq.get(g) ?? 0) + 1);
  }

  const size = Math.floor(n.length / BLOCK_REUSE_SEGMENTS);
  const blocks: Array<{ grams: Set<string>; pos: Array<{ g: string; at: number }> }> = [];
  for (let b = 0; b < BLOCK_REUSE_SEGMENTS; b++) {
    const from = b * size;
    const to = b === BLOCK_REUSE_SEGMENTS - 1 ? n.length : (b + 1) * size;
    const grams = new Set<string>();
    const pos: Array<{ g: string; at: number }> = [];
    for (let i = from; i + 2 <= to; i++) {
      const g = n.slice(i, i + 2);
      if ((freq.get(g) ?? 0) <= 3) { grams.add(g); pos.push({ g, at: i }); }
    }
    blocks.push({ grams, pos });
  }

  const out: BlockReuseFinding[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 2; j < blocks.length; j++) {
      const a = blocks[i]!, b = blocks[j]!;
      if (Math.min(a.grams.size, b.grams.size) < BLOCK_REUSE_MIN_ANCHORS) continue;
      const shared: string[] = [];
      for (const g of a.grams) if (b.grams.has(g)) shared.push(g);
      const overlap = shared.length / Math.min(a.grams.size, b.grams.size);
      if (overlap < BLOCK_REUSE_MIN) continue;
      out.push({ fromBlock: i, toBlock: j, overlap, sample: shared.slice(0, 8) });
    }
  }
  return out.sort((x, y) => y.overlap - x.overlap);
}

/** 情节块复用的重写指令：明确指出是哪两块，要求只保留一块 */
export function renderBlockReuseHint(findings: readonly BlockReuseFinding[]): string {
  const lines = findings.slice(0, 3).map((f) => {
    const from = `第 ${f.fromBlock + 1} 段位`, to = `第 ${f.toBlock + 1} 段位`;
    const pct = (f.overlap * 100).toFixed(0);
    return `· ${to}与${from}是**同一段内容**（锚点重合 ${pct}%，共用词：${f.sample.slice(0, 5).join('、')}）`;
  });
  return [
    '【框架检出的**整段复用**（把正文切成 6 块、逐块比对稀有词得来的）】',
    ...lines,
    '处理方式：**只保留前面那一块**，把后面重复的那一块整块删掉，'
      + '并用**新的情节推进**替换它（人物要有新的行动、新的信息、处境要有新的变化）——'
      + '**不要**把已有的内容换个说法再讲一遍，那是同一处硬伤。',
  ].join('\n');
}

export function detectRepetition(content: string): RepetitionReport {
  const text = content ?? '';
  const sentences = countRepeats(splitSentences(text), REPETITION_MIN_SENTENCE_CHARS);
  const paragraphs = countRepeats(
    text.split(/\n+/).map((s) => s.trim()).filter((b) => b && splitSentences(b).length >= 2),
    REPETITION_MIN_PARAGRAPH_CHARS,
  );
  const excessSentences = sentences.reduce((n, f) => n + (f.count - 1), 0);
  const near = findNearDuplicates(text);
  const blockReuse = detectBlockReuse(text);
  const exactExcessive = paragraphs.length > 0 || excessSentences >= REPETITION_MAX_EXCESS;
  const approximateExcessive = near.excess >= NEAR_DUP_MAX_EXCESS;
  const blockReuseExcessive = blockReuse.length > 0;
  return {
    sentences,
    paragraphs,
    excessSentences,
    nearDuplicates: near.findings,
    excessNearDuplicates: near.excess,
    exactExcessive,
    approximateExcessive,
    blockReuse,
    blockReuseExcessive,
    excessive: exactExcessive || approximateExcessive || blockReuseExcessive,
  };
}

/**
 * 生成给写作官的「消除重复」重写指令。
 *
 * 为什么要显式列出重复的句子：打回重写时，写作官默认按复核的「修改要求」改；
 * 而本次若因**代码检出的重复**打回、模型自己没报，复核里就没有这条 ——
 * 只说「有重复」它不知道改哪句，必须把原文与次数直接摆给它。
 *
 * ★ 近似重复必须**连变体一起列**：只说「这句出现 3 次」没用 —— 三处写法各不相同，
 *   写作官得看到「这几种写法其实是同一句」才会去删，否则它会以为在说另一句。
 */
export function renderRepetitionHint(rep: RepetitionReport): string {
  const parts: string[] = ['【本次重写的硬性要求：消除章内重复】'];
  if (rep.sentences.length) {
    parts.push('下列句子在**同一章内**出现了多次，每一句**只保留一次**，其余要么删去、要么换成不同的写法：');
    for (const f of rep.sentences) parts.push(`· 「${f.text}」（出现 ${f.count} 次）`);
  }
  if (rep.paragraphs.length) {
    parts.push('下列整段在同一章内重复，**只保留一段**：');
    for (const f of rep.paragraphs) {
      const shown = f.text.length > 60 ? f.text.slice(0, 60) + '…' : f.text;
      parts.push(`· 「${shown}」（出现 ${f.count} 次）`);
    }
  }
  if (rep.nearDuplicates.length) {
    parts.push(
      '下列句子**换了说法但说的是同一件事**（同一情节被改写重述），'
      + '整组**只保留一处**，其余删掉或改成真正推进情节的新内容：',
    );
    for (const f of rep.nearDuplicates) {
      const shown = f.text.length > 60 ? f.text.slice(0, 60) + '…' : f.text;
      parts.push(`· 「${shown}」（本节共出现 ${f.count} 次，写法有：）`);
      // 变体里第一条就是代表句本身，从第二条起才是「换个说法」的版本
      for (const v of f.variants.slice(1)) {
        const vs = v.length > 60 ? v.slice(0, 60) + '…' : v;
        parts.push(`    – 「${vs}」`);
      }
    }
  }
  // ★ 2026-10-22：情节块复用也在这条通道里播报（复核话与重写指令共用本函数，一处就够）
  if (rep.blockReuse?.length) parts.push('', renderBlockReuseHint(rep.blockReuse));
  parts.push('**不许靠复述凑字数** —— 写不满就加新的情节、动作、对话与细节补充，而不是把写过的话再说一遍。');
  return parts.join('\n');
}

/* ============================================================
 * 跨章重复检测（2026-10-16 新增）
 *
 * 为什么单独一块：「章内去重」抓不到长跑最要命的毛病 —— **把前几章写过的段落
 * 又抄进新章**。实测某本 26 章的书：章内重复只有 48 处，**跨章重复有 220 句**
 * （「他转身离开终端，廊里的低鸣还是那样，没有变…」在章 1、2 都出现）。
 * 这类不修，读起来就是"新章在复读旧章"。
 *
 * 做法：把**本章的长句**（归一化后 ≥ CROSS_DUP_MIN_CHARS）与**最近 N 章的同一批句子**
 * 比对，撞上就是跨章重复。只比"出现过没有"，不做相似度（长跑里逐字重抄才是主症，
 * 变体跨章太宽会误伤 —— 同一个人物、同一个地点在相邻章反复出现是合理的）。
 *
 * ★ 2026-10-17 补第二类：**变体式跨章复写**。上一版只抓「逐字相同」，但实测模型
 *   更常把旧章的一段换个说法再写一遍（《长夜将明》26 章里逐字 336 句、**变体另有 183 句**，
 *   后者一条都没被计到）。变体用与章内同一套双门槛（Jaccard + 编辑相似度），但阈值更严，
 *   因为跨章比对的是**全书**、误伤面更大。阈值 0.75/0.85 的标定见两个常量注释。
 * ============================================================ */

/** 计为跨章重复的最短句长（归一化后）。设得比章内更严：越长越可能是整句搬运。 */
export const CROSS_DUP_MIN_CHARS = 22;
/**
 * 变体式跨章复写 · 3-gram Jaccard 下限。
 *
 * ★ 0.75 的标定（2026-10-17，用两本真实成稿逐句比全历史）：
 *   干净的新书《雾港疑案》8 章：0.60 → 10 句 / 单章最多 3；**0.75 → 5 句 / 单章最多 2**；
 *   坏书《长夜将明》26 章：0.60 → 287 句 / 单章最多 25；**0.75 → 111 句 / 单章最多 11**。
 *   0.60 会把「同场景的正常呼应」（如连续两章都写"雾港的灯被雾晕成光团"）算进去，
 *   0.75 才把「换词重写同一段」与「复用同一意象」分开。与章内 0.60 不同 ——
 *   跨章比对全书，必须更严。
 */
export const CROSS_NEAR_JACCARD_MIN = 0.75;
/**
 * 变体式跨章复写 · 归一化编辑相似度下限。
 * 与 CROSS_NEAR_JACCARD_MIN 同时成立才算（理由同章内：Jaccard 对词序不敏感，
 * 单靠它会把"共用几个名词的句子"误判）。0.85 比章内的 0.72 严：跨章只抓**高度雷同**。
 */
export const CROSS_NEAR_EDIT_MIN = 0.85;
/**
 * 变体式跨章复写 · 达几处判过度。
 * 实测干净书单章最多 2 句、坏书单章最多 11 句 —— 取 4 落在断档中间，
 * 容忍相邻章 2–3 处正常呼应（同一意象的收束句），4 处以上才算"新章复读旧章"。
 */
export const CROSS_NEAR_MAX = 4;
/** 最多在几处旧章里撞到 */
export interface CrossDuplicateFinding {
  /** 本章里重复出现的句子 */
  text: string;
  /** 在哪些旧章出现过（章号，升序） */
  priorOrders: number[];
}

/** 变体式跨章复写的一组：本章句子 + 它在旧章里的近似版本 + 命中的旧章号 */
export interface CrossNearFinding {
  /** 本章里那句（代表写法） */
  text: string;
  /** 在哪些旧章出现过近似句 */
  priorOrders: number[];
  /** 旧章里最像的那句原文（供写作官比对） */
  priorText: string;
  /** 与旧章句子的最高相似度（Jaccard / 编辑取较低者，便于排序） */
  score: number;
}

export interface CrossRepetitionReport {
  /** 逐字相同的跨章重复 */
  findings: CrossDuplicateFinding[];
  /** 变体式跨章复写 */
  nearFindings: CrossNearFinding[];
  /** 逐字跨章重复句数 */
  exactCount: number;
  /** 变体式跨章复写句数 */
  nearCount: number;
  /** 两类合计（调用方看这个总数） */
  count: number;
  /** 逐字类是否达阈值 */
  exactExcessive: boolean;
  /** 变体类是否达阈值 */
  nearExcessive: boolean;
  /** 任一达阈值即 true（打回依据） */
  excessive: boolean;
}

/** 达几处**逐字**跨章重复才判过度。 */
export const CROSS_DUP_MAX = 5;

/**
 * 检测本章相对**已交付的旧章**的重复（逐字 + 变体两类）。
 *
 * @param content      本章正文
 * @param priorChapters 最近的旧章（order 升序或降序都行，内部只看 order 与 content）
 */
export function detectCrossChapterRepetition(
  content: string,
  priorChapters: Array<{ order: number; content: string }>,
): CrossRepetitionReport {
  const prior = priorChapters ?? [];
  const empty: CrossRepetitionReport = {
    findings: [], nearFindings: [], exactCount: 0, nearCount: 0, count: 0,
    exactExcessive: false, nearExcessive: false, excessive: false,
  };
  if (!prior.length) return empty;

  // 本章的长句 → 原文（保留标点，便于回填重写指令）
  const byKey = new Map<string, string>();
  for (const s of splitSentences(content ?? '')) {
    const k = normalize(s);
    if (k.length >= CROSS_DUP_MIN_CHARS && !byKey.has(k)) byKey.set(k, s);
  }
  if (!byKey.size) return empty;

  // 旧章句子一次性展开、归一化（避免对每条本章句都重切一遍旧章）
  const priorSents: Array<{ order: number; raw: string; norm: string; grams: Set<string> }> = [];
  for (const pc of prior) {
    for (const s of splitSentences(pc.content ?? '')) {
      const n = normalize(s);
      if (n.length >= CROSS_DUP_MIN_CHARS) priorSents.push({ order: pc.order, raw: s, norm: n, grams: ngrams(n) });
    }
  }
  const exactKeys = new Set(priorSents.map((p) => p.norm));

  const findings: CrossDuplicateFinding[] = [];
  const nearFindings: CrossNearFinding[] = [];
  for (const [k, text] of byKey) {
    // ① 逐字：旧章里有归一化后完全相同的句子
    if (exactKeys.has(k)) {
      const orders = [...new Set(priorSents.filter((p) => p.norm === k).map((p) => p.order))].sort((a, b) => a - b);
      findings.push({ text, priorOrders: orders });
      continue; // 逐字命中的不再算变体（避免同一句双计）
    }
    // ② 变体：与旧章句子高度相似（Jaccard 且 编辑相似度 同时达标）
    const grams = ngrams(k);
    let best: { order: number; raw: string; score: number } | null = null;
    const orders = new Set<number>();
    for (const p of priorSents) {
      const j = jaccard(grams, p.grams);
      if (j < CROSS_NEAR_JACCARD_MIN) continue;
      const e = editSimilarity(k, p.norm);
      if (e < CROSS_NEAR_EDIT_MIN) continue;
      orders.add(p.order);
      const score = Math.min(j, e);
      if (!best || score > best.score) best = { order: p.order, raw: p.raw, score };
    }
    if (best) {
      nearFindings.push({ text, priorOrders: [...orders].sort((a, b) => a - b), priorText: best.raw, score: best.score });
    }
  }

  findings.sort((a, b) => b.priorOrders.length - a.priorOrders.length);
  nearFindings.sort((a, b) => b.score - a.score);

  const exactExcessive = findings.length >= CROSS_DUP_MAX;
  const nearExcessive = nearFindings.length >= CROSS_NEAR_MAX;
  return {
    findings, nearFindings,
    exactCount: findings.length, nearCount: nearFindings.length,
    count: findings.length + nearFindings.length,
    exactExcessive, nearExcessive,
    excessive: exactExcessive || nearExcessive,
  };
}

/* ============================================================
 * 交付前**确定性去重**（2026-10-25 · D2）
 *
 * 动机（团队评审结论 + 本仓实测）：
 *   检测端能抓到重复（意图门硬规则 + 监工），但**改不动** —— 实测写作模型
 *   （z/hy3 系）长上下文后退化为复读机，3 次重写照样把同一句抄回来。
 *   于是"抓到"与"交付干净正文"之间始终差一步：打回上限用尽后仍带重复交付
 *   （实测全书 98 章：章内精确多余 437 句 / 整段重复块 166 / 跨章逐字 282）。
 *
 *   既然模型改不动，就用**代码**改：这些重复句是**逐字相同**的，删除对内容零损失
 *   （保留首现、删后现），零模型调用、零方差、可复现。
 *
 * 为什么**只删精确类、不删变体类**：
 *   精确重复（归一化后完全一致）删掉后现是无损的 —— 同一句话，信息量不因少说一遍而减少。
 *   而"变体式重复"（换词重写）虽高度相似却**可能携带新信息**（「塞进柜子」→「塞进柜子深处」），
 *   机械删错会丢情节。实测变体类只占 92（章内）/ 66（跨章），量小且风险高 ——
 *   按评审结论**留给人工/重写**，不在这里假装能安全删。
 *
 * 门槛与检测器同一把尺子（normalize / REPETITION_MIN_SENTENCE_CHARS / CROSS_DUP_MIN_CHARS），
 * 只删"检测器已经数过、且达到报告门槛"的那类句子。
 * ============================================================ */

export interface DedupeResult {
  /** 去重后的正文（无重复时原样返回） */
  text: string;
  /** 删除的**章内**精确重复句数（后现） */
  removedIntra: number;
  /** 删除的**跨章**精确重复句数（本章句子与旧章逐字相同） */
  removedCross: number;
  /** 删除的归一化字符数（≈省下的字数，用于日志） */
  removedChars: number;
  /**
   * 因「保留下限」（`keepAtLeast`）而**没删**的重复句数。
   * >0 说明这一章重复多到"删干净就会太短" —— 是**该章本身内容偏薄**的信号，
   * 值得写进交付警示让作者知道（而不是悄悄留下重复）。
   */
  keptForLength: number;
}

/**
 * 取正文里每一句的 [起, 止) 下标区间（含句末标点）。
 * 用下标而非 split：重建时**原样拼回**未删句子的原始文本（标点、错落空格都不动）。
 */
function sentenceRanges(block: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < block.length; i++) {
    if ('。！？…!?'.includes(block[i]!)) {
      out.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < block.length) out.push([start, block.length]);
  return out;
}

/**
 * 交付前确定性去重：删除**后现**的精确重复句，保留首现。
 *
 * 规则（保序、可复现）：
 *   · 章内：某句归一化后 ≥ REPETITION_MIN_SENTENCE_CHARS 且**已在本章出现过** → 删；
 *   · 跨章：某句归一化后 ≥ CROSS_DUP_MIN_CHARS 且**在本章之前的旧章里出现过** → 删；
 *   · 其余不动；整段重复由句子规则自然覆盖（整段每句都是后现 → 整段被清空 → 连同分隔符删除）。
 *
 * 不做任何模型调用。无重复时返回原串（调用方可据此判断是否变动）。
 */
export function dedupeExactRepeats(
  content: string,
  priorChapters: Array<{ order: number; content: string }> = [],
  opts: {
    /**
     * **保留下限**：删到这个字数就停手，宁可留几句重复也不再往下删。
     *
     * ★ 2026-10-27 加（实测事故）：交付口的去重曾把整章删薄 —— 单章删掉 **792 字**
     *   （2914 → 2122），结果 23 章里 8 章跌破 2500 下限。
     *   去重的目的是**去掉多余重复**，不是把章节删短；而篇幅下限是硬约束（闸门会拦）。
     *   两者冲突时以"保住篇幅"为准 —— 剩下的重复由重写/补写去治，不该悄悄截断。
     *
     * 注意：比较用的是**归一化**字数（去标点），它恒 ≤ `proseLength`（只去空白），
     * 所以按它守下限是**保守**的：真实落库字数只会比它更多，不会更少。
     */
    keepAtLeast?: number;
  } = {},
): DedupeResult {
  const text = content ?? '';
  const none: DedupeResult = { text, removedIntra: 0, removedCross: 0, removedChars: 0, keptForLength: 0 };
  if (!text.trim()) return none;

  // 旧章的长句归一化键（跨章逐字比对用；只收 ≥ CROSS_DUP_MIN_CHARS 的）
  const priorKeys = new Set<string>();
  for (const pc of priorChapters ?? []) {
    for (const s of splitSentences(pc.content ?? '')) {
      const k = normalize(s);
      if (k.length >= CROSS_DUP_MIN_CHARS) priorKeys.add(k);
    }
  }

  const parts = text.split(/(\n\s*\n|\n)/);
  const kept: string[] = [];
  const seen = new Set<string>();
  let removedIntra = 0;
  let removedCross = 0;
  let removedChars = 0;
  let keptForLength = 0;
  /** 保留下限（0 = 不限）。见 opts.keepAtLeast 说明。 */
  const keepAtLeast = Math.max(0, opts.keepAtLeast ?? 0);
  /** 全篇归一化字数 —— 每删一句就从它里面扣，用来判断"再删会不会破下限" */
  let remaining = normalize(text).length;

  for (const part of parts) {
    if (!part || /^\s*$/.test(part)) { kept.push(part); continue; }
    let rebuilt = '';
    for (const [a, b] of sentenceRanges(part)) {
      const raw = part.slice(a, b);
      const k = normalize(raw);
      if (!k.length) { rebuilt += raw; continue; }   // 纯空白残留
      const intra = k.length >= REPETITION_MIN_SENTENCE_CHARS && seen.has(k);
      const cross = !intra && k.length >= CROSS_DUP_MIN_CHARS && priorKeys.has(k);
      if (intra || cross) {
        /**
         * ★ 保留下限：删了会跌破下限就**停手**（留这一句，记一笔）。
         * 宁可留几句重复，也不要交一个"缺字"的章 —— 篇幅下限是硬约束，
         * 而重复可以被后续重写/人工处理，缺字则要重新补写一整章。
         */
        if (keepAtLeast > 0 && remaining - k.length < keepAtLeast) {
          keptForLength += 1;
          if (k.length >= REPETITION_MIN_SENTENCE_CHARS) seen.add(k);
          rebuilt += raw;
          continue;
        }
        if (intra) removedIntra += 1; else removedCross += 1;
        removedChars += k.length;
        remaining -= k.length;
        continue;
      }
      if (k.length >= REPETITION_MIN_SENTENCE_CHARS) seen.add(k);
      rebuilt += raw;
    }
    if (rebuilt.trim()) {
      kept.push(rebuilt);
    } else {
      // 整块被清空（整段重复）→ 连同它前面紧邻的空白分隔符一起丢，避免留下空段
      while (kept.length && /^\s*$/.test(kept[kept.length - 1]!)) kept.pop();
    }
  }

  /**
   * 一句都没删的两种情形要分开：
   *   · 本来就没重复（keptForLength=0）→ 返回 `none`（正文逐字不变）；
   *   · **有重复、但保留下限挡住了**（keptForLength>0）→ **必须把计数带出去** ——
   *     否则调用方看不到"这章重复多到删不动"，等于把问题藏了。
   *     （这是写完第一版就踩到的：只在 removedIntra+removedCross===0 时 return none，
   *      把 keptForLength 一起丢了，测试当场抓到。）
   */
  if (removedIntra + removedCross === 0) {
    return keptForLength > 0 ? { ...none, keptForLength } : none;
  }
  return { text: kept.join('').trim(), removedIntra, removedCross, removedChars, keptForLength };
}

/** 生成给写作官的「消除跨章重复」重写指令 */
export function renderCrossRepetitionHint(rep: CrossRepetitionReport): string {
  if (!rep.findings.length && !rep.nearFindings.length) return '';
  const parts: string[] = ['【本次重写的硬性要求：消除**跨章**重复】'];
  if (rep.findings.length) {
    parts.push('下列句子在**前面的章节里已经原样写过**，本章又出现 —— 每句都必须**改写或删掉**：');
    const top = rep.findings.slice(0, 10);
    for (const f of top) {
      const shown = f.text.length > 56 ? f.text.slice(0, 56) + '…' : f.text;
      parts.push(`· 「${shown}」（已在第 ${f.priorOrders.join('、')} 章出现过）`);
    }
    if (rep.findings.length > top.length) parts.push(`（另有 ${rep.findings.length - top.length} 句同类，一并处理）`);
  }
  if (rep.nearFindings.length) {
    parts.push('下列句子虽然**换了说法**，但仍是把前面章节写过的段落重写了一遍 —— 必须换掉内容，不是换词：');
    const top = rep.nearFindings.slice(0, 10);
    for (const f of top) {
      const a = f.text.length > 48 ? f.text.slice(0, 48) + '…' : f.text;
      const b = f.priorText.length > 48 ? f.priorText.slice(0, 48) + '…' : f.priorText;
      parts.push(`· 本章「${a}」 ≈ 第 ${f.priorOrders.join('、')} 章的「${b}」`);
    }
    if (rep.nearFindings.length > top.length) parts.push(`（另有 ${rep.nearFindings.length - top.length} 句同类，一并处理）`);
  }
  parts.push('**新章要有新内容** —— 景物、动作、心境的写法都要换，不要复用前面用过的句子，也不要换词重写同一段。');
  return parts.join('\n');
}
