// ============================================================
// 对话占比 —— 「对话太少」的代码级兜底
//
// 为什么必须有它（2026-10-16 实测）：
//   全书的对话占比只有 8–13%，目标是 20%。这个目标**只写在提示词里**，
//   模型会漏 —— 长跑段越写越像「内心独白 + 动作流」（实测第 4、5 章对话只占
//   5% 左右，整章几乎没有一句像样的人物对白）。意图复核的『对话』红线虽然存在，
//   但同样靠模型自报，漏报就直接交付了。
//
//   这里用**代码**数一遍：不依赖模型、不花 token、结果可复现。
//   口径：引号内的内容算「对话」，引号外的一切算「叙述」，
//   占比 = 对话的内容字数 / 正文的内容字数（都用 countProseChars 同一把尺子）。
//
// 本文件是纯函数（零模型 / 零 DB），单测见 dialogue.test.ts。
// ============================================================

import { countProseChars } from './text.js';

/**
 * 判「对话偏少」的下限。
 *
 * ★ 0.15 的来由（2026-10-16 用本仓真实产出标定）：
 *   · 同一项目已交付的第 1–5 章实测占比 —— 10.8% / 5.0% / 9.1% / 11.0% / 4.9%，
 *     五章**全部**低于目标 20%（这正是要修的缺陷）；
 *   · 目标 20% 若直接当打回线，会把「本来就偏低」的稿子全部打回，而重写上限
 *     只有 2 次 —— 一旦重写仍然到不了 20%，就成了「白烧两次调用再带瑕疵交付」，
 *     比不打回更糟；
 *   · 15% 是一个**够得着**的门槛：它是「明显偏少」与「只是没到理想值」的分界。
 *     实测的 5% 章会被拦下，11% 的章也会被拦下 —— 但写作官只要多写几轮像样的
 *     对白就能过线，不必凭空把整章改写成对话体。
 *   下调/上调都只改这一个常量，orchestrator 与单测都引用它。
 */
export const DIALOGUE_RATIO_MIN = 0.15;
/**
 * ★ 2026-10-30 新增**上限**：对话占比超过这个就算对话凑情节。
 *
 * 为什么需要（用户反馈「对话情节太多了」）：此前只有下限 15%，没有上限。
 * 实测第 114 章 **对话占比 63%** —— 整章几乎全是两人对骂，动作与环境几乎消失，
 * 读起来像剧本不像小说。悬疑/调查类小说 30–45% 是有质感的区间。
 *
 * ★ 2026-10-30 二次收紧 0.5 → 0.4：用户对《铁壳里的声音》前 3 章反馈「对话太多了」，
 *   实测占比 29%。29% 单看不算越界，但配合下面的「段太碎」才是真问题 ——
 *   上限放宽会被"字多但碎"的稿子钻空子，故收紧一档，与碎句判据形成合围。
 */
export const DIALOGUE_RATIO_MAX = 0.4;

/**
 * ★ 2026-10-30 新增**对话形态**判据（用户反馈：「对话内容太短了，有点太像 AI 了」）。
 *
 * 为什么必须用代码数（而不是靠提示词）：
 *   提示词里本来就有一句「不要为了凑占比灌水式加『嗯』『哦』这类单字应答」
 *   （见 renderDialogueHint），**但实测无效** —— 《铁壳里的声音》前 3 章 317 个对话段里，
 *   **中位数只有 4 字、53% 的段落 ≤4 字、32% ≤2 字**（「嗯。」「卖。」「五块。」「小气。」）。
 *
 *   根因：占比下限（≥20%）是个**只设下界**的指标，模型最省力的达标方式就是
 *   **把一句话拆成十个短应答**去堆字数 —— 数量凑占比。指标本身在鼓励它。
 *   这正是"AI 味"的机制之一：真实的市井对话松散、有废话、有半句没说完的；
 *   而碎句对轰是**一问一答、每句都精准有用**，读起来就是机器在交换信息。
 *
 * 口径（三个条件**同时**成立才判"太碎"，避免误伤紧张戏里正当的短接话）：
 *   · 段数够多（`DIALOGUE_FRAG_MIN_SEGS`）—— 只有两三句对白的章不适用；
 *   · 平均段长 < `DIALOGUE_MEAN_SEG_MIN`；
 *   · ≤`DIALOGUE_SHORT_SEG_CHARS` 字的段占比 > `DIALOGUE_SHORT_SEG_MAX`。
 *
 * 标定（★ 本仓四本书的真实章节，用 detectDialogue 同一把尺子量出来的，不是拍的）：
 *
 *   书（章节数）                     平均段长中位   短段(≤4字)占比中位
 *   《铁壳里的声音》  (3，用户嫌碎)      **5.6**        **55%**
 *   《雾港旧档》      (23)                8.1            36%
 *   《雾港长夜》      (111，最干净)      **10.3**        **19%**
 *   《雪线以北》      (16)              **11.5**        **15%**
 *
 *   第一版阈值（<8 字 + >35%）**太松**：最干净那本的第 10 百分位章（平均 7.9 / 短段 33%）
 *   正好压在线上，会误伤约一成好章。按上表的断档收到 **7 字 / 40%**：
 *   · 《铁壳里的声音》3 章全部命中（平均 5.5–6.6，短段 42–58%）；
 *   · 三本正常书的中位数与各自第 10 百分位章都不再命中。
 *   两个阈值都留了余量：紧张戏可以有一批「谁？」「我。」，但**不能过半**，平均也不能低到 7 字以下。
 */
export const DIALOGUE_SHORT_SEG_CHARS = 4;
export const DIALOGUE_MEAN_SEG_MIN = 7;
export const DIALOGUE_SHORT_SEG_MAX = 0.4;
/** 段数少于此值不判"太碎"（对白本来就少的章，是"太少"那条在管，不该重复打回） */
export const DIALOGUE_FRAG_MIN_SEGS = 10;

export interface DialogueReport {
  /** 对话占比 = 引号内内容字数 / 正文内容字数（0–1）；空稿为 0 */
  ratio: number;
  /** 引号内的内容字数（归一化后，不含引号本身与引号内标点） */
  dialogueChars: number;
  /** 正文内容字数（归一化后） */
  totalChars: number;
  /** 引号段落数（一个「…」算一段；未闭合的按到结尾算一段） */
  segments: number;
  /** 对话段的平均字数（归一化后；无对话为 0） */
  meanSegChars: number;
  /** ≤DIALOGUE_SHORT_SEG_CHARS 字的段数 */
  shortSegs: number;
  /** 短段占比（0–1；无对话为 0） */
  shortSegRatio: number;
  /** 是否低于 DIALOGUE_RATIO_MIN（调用方据此打回/重写） */
  tooLow: boolean;
  /** 是否高于 DIALOGUE_RATIO_MAX（对话塞满全章、动作与环境被挤掉） */
  tooHigh: boolean;
  /** 是否「段太碎」：段多、平均短、短段过半（见上面的标定说明） */
  tooFragmented: boolean;
}

/**
 * 引号对：中文小说常见四套，都要认。
 *   “…” 英文/通用双引号（中文排版里也常用）    ‘…’ 单引号（次要，含对白引用）
 *   「…」 『…』 日式/繁体书名号式引号（简繁中文小说都常见）
 *   "…" 英文直引号（模型直出英文引号时会出现）
 * 注意 “ ” ‘ ’ 在中文排版里成对出现，而 " 是**同一个字符**开关 ——
 * 所以下面用「开/关状态机」而不是正则配对：`"` 每次出现都翻转状态。
 */
const CJK_OPEN = '“‘「『';
const CJK_CLOSE = '”’」』';

/**
 * 计算对话占比。
 *
 * 扫描规则（状态机，逐字符）：
 *   · 遇见开启引号（且当前不在引号内）→ 进入对话态；
 *   · 遇见关闭引号（当前在对话内）→ 退出对话态，本段计入对话；
 *   · 英文直引号 `"`（或 `'`）→ **每次出现都翻转**状态（它没有开合之分）；
 *   · 其余字符：在对话态内计入对话，否则计入叙述。
 *
 * ★ 用内容字数（countProseChars）而非字符数：引号内的标点、换行不该给「对话」
 *   灌水 —— 一场靠「……」撑长度的对白不该算作高对话占比。
 * ★ 未闭合的引号（模型漏写右引号）按「到结尾都算对话」处理：宁可高估，
 *   也不要把一整段真对白因为一个漏引号判成叙述 —— 那会**多**打回一次。
 */
export function detectDialogue(content: string): DialogueReport {
  const text = content ?? '';
  const totalChars = countProseChars(text);
  const chars = [...text];
  let inQuote = false;
  /** 用「内容字符」累加，避免把引号内的标点算成对话 */
  let dialogueChars = 0;
  /** 当前正在累积的对话段（用于统计段数与段长） */
  let cur = '';
  const segLens: number[] = [];
  const pushSeg = () => {
    const n = countProseChars(cur);   // 同一把尺子：段长也是"内容字数"
    if (n > 0) segLens.push(n);
    cur = '';
  };
  for (const ch of chars) {
    if (ch === '"' || ch === "'") { if (inQuote) pushSeg(); inQuote = !inQuote; continue; }
    if (CJK_CLOSE.includes(ch)) { if (inQuote) pushSeg(); inQuote = false; continue; }
    if (CJK_OPEN.includes(ch)) { inQuote = true; continue; }
    if (inQuote) { dialogueChars += countProseChars(ch); cur += ch; }
  }
  // 未闭合的引号：到结尾都算对话（与上面的口径一致），收尾时补一段
  if (inQuote) pushSeg();

  const segments = segLens.length;
  const meanSegChars = segments > 0 ? segLens.reduce((a, n) => a + n, 0) / segments : 0;
  const shortSegs = segLens.filter((n) => n <= DIALOGUE_SHORT_SEG_CHARS).length;
  const shortSegRatio = segments > 0 ? shortSegs / segments : 0;
  const ratio = totalChars > 0 ? dialogueChars / totalChars : 0;
  return {
    ratio,
    dialogueChars,
    totalChars,
    segments,
    meanSegChars,
    shortSegs,
    shortSegRatio,
    // 空稿（totalChars=0）不算「对话偏少」—— 那是篇幅门的事，不该在这里重复打回
    tooLow: totalChars > 0 && ratio < DIALOGUE_RATIO_MIN,
    tooHigh: totalChars > 0 && ratio > DIALOGUE_RATIO_MAX,
    // 段太碎：三个条件同时成立（段够多 + 平均短 + 短段过半）
    tooFragmented: segments >= DIALOGUE_FRAG_MIN_SEGS
      && meanSegChars < DIALOGUE_MEAN_SEG_MIN
      && shortSegRatio > DIALOGUE_SHORT_SEG_MAX,
  };
}

/**
 * 「对话太碎」的那一行事实陈述（复核消息与重写指令共用，只有一份真源）。
 *
 * 只报**数出来的**事实与阈值，不替模型写台词 —— 缺的从来不是素材，
 * 是「意识到短应答是在凑数」。
 */
export function renderFragmentedLine(rep: DialogueReport): string {
  const mean = rep.meanSegChars.toFixed(1);
  const pctShort = (rep.shortSegRatio * 100).toFixed(0);
  return `框架逐字统计：本章有 ${rep.segments} 个对话段，**平均每段只有 ${mean} 字**，`
    + `其中 ${rep.shortSegs} 段（${pctShort}%）不超过 ${DIALOGUE_SHORT_SEG_CHARS} 字`
    + `（下限：平均 ≥ ${DIALOGUE_MEAN_SEG_MIN} 字，且短段占比 ≤ ${(DIALOGUE_SHORT_SEG_MAX * 100).toFixed(0)}%）。`
    + `一句话被拆成了十个短应答 —— 这是"用数量凑占比"，读起来像机器在对单据。`;
}

/**
 * **补写**阶段用的对话指令：本章对话不达标时，把要求连同"新增篇幅优先给对话"一起交出去；
 * 达标时返回空串（多塞要求只会挤占写作官的注意力）。
 *
 * ★ 2026-11-05 新增。为什么补写也要看对话：
 *   实测（afterfix pilot 第 3 章）补写把 1221 字扩到 3498（2.9 倍），对话占比却从
 *   27% **掉到 8%** —— 原指令只说"增加细节、动作、对话与描写"，对话只占四分之一，
 *   模型补进来的绝大多数是叙述 ⇒ 分母涨、分子不涨。**修篇幅的动作反过来恶化了对话指标**，
 *   所以补写阶段必须同时拿到对话目标，否则两个指标会互相打架。
 */
export function renderSupplementDialogueDirective(rep: DialogueReport): string {
  if (!rep.tooLow && !rep.tooFragmented) return '';
  return '\n\n**新增的篇幅请优先给人物对话** —— 本章对话占比不达标：\n'
    + renderDialogueHint(rep);
}

/**
 * 生成给写作官的「补对话」重写指令。
 *
 * 只列数字与方向，不替它写台词 —— 写作官手里有本章结论（谁在场、要谈什么），
 * 缺的从来不是素材，是「意识到对话也是正文的一部分」。
 */
export function renderDialogueHint(rep: DialogueReport): string {
  const pct = (rep.ratio * 100).toFixed(1);
  const min = (DIALOGUE_RATIO_MIN * 100).toFixed(0);
  /**
   * ★ 2026-10-30：**对话过多**也要有指令（原先只处理"太少"）。
   * 实测第 114 章对话 63% —— 整章两人对骂，动作与环境几乎消失，读起来像剧本。
   */
  if (rep.tooHigh) {
    const max = (DIALOGUE_RATIO_MAX * 100).toFixed(0);
    return [
      '【硬性要求：对话**压下来**】',
      `框架逐字统计：本章对话占比高达 ${pct}%（引号内 ${rep.dialogueChars} 字 / 正文 ${rep.totalChars} 字），超过 ${max}% 的上限。`,
      '整章几乎全是人物在说话，**动作、环境、物件、身体反应全被挤掉了** —— 读起来像剧本，不像小说。',
      '请这样改：',
      '· 把一部分**台词改成动作或状态**：他说了什么 → 他做了什么（手在抖、把东西塞回袖里、后退半步）；',
      '· 给每个对话场景补上**空间与物件**：他们在哪、手边有什么、光线怎样；',
      '· 只保留**真正有信息差或冲突**的对话轮次，寒暄与重复表态删掉。',
      ...(rep.tooFragmented ? [renderFragmentedLine(rep)] : []),
      `注意：对话**不能低于 ${min}%**（下限照旧），目标是落到 ${min}%–${max}% 之间；篇幅仍须在区间内。`,
    ].join('\n');
  }
  /**
   * ★ 2026-10-30：**对话太碎**也单列一条 —— 它不是"太多"也不是"太少"：
   *   占比可能正好，但每句都是「嗯。」「卖。」这种一到四字的应答。
   *   用户对《铁壳里的声音》的评价就是「对话内容太短了，有点太像 AI 了」。
   *   治法不是增删对话数量，而是**把碎应答合并成有分量的整句**。
   */
  if (rep.tooFragmented) {
    return [
      '【硬性要求：对话**写实、写厚**（现在太碎）】',
      renderFragmentedLine(rep),
      '请这样改（注意：**不是**加减对话数量，是把每一句写实）：',
      '· 把「一问一答、每句两个字的电报体」合并成**一次说完的整句**：',
      '  反面：「『卖不？』『卖。』『几块？』『五块。』」——像机器在对单据。',
      '  正面：把信息压进**一次发言**里，并让人物**答非所问、带情绪、夹动作**'
        + '（「我问你卖不卖。」「你先说谁让你来的。」）。',
      '· 让人物**说人话**：真实的市井/同事对话有语气词、有半句没说完、有废话和重复 ——'
        + '不要每句都精准、都有用、都推进信息（那正是机器味）。',
      '· **禁止**用「嗯／哦／晓得／卖／五块／小气」这类一到四字的单字应答连排；'
        + '同一段里最多留一处极短应答，其余补成完整发言。',
      '· 台词长一点之后，可以**减少对话轮数**把篇幅让给动作与环境，但**占比不得低于下限**。',
    ].join('\n');
  }
  return [
    '【硬性要求：把对话补上来】',
    `框架逐字统计：本章对话占比只有 ${pct}%（引号内 ${rep.dialogueChars} 字 / 正文 ${rep.totalChars} 字），低于 ${min}% 的下限。`,
    '请**增加人物之间的对话**：把下列内容改成**当面说出来的对白**（而不是叙述转述或内心独白）——',
    `· 现在写成"他想…""他知道…"的推理，能让人问出来、答出来；`,
    `· 现在用旁白交代的信息（谁去了哪、为什么、要怎么办），交给角色在对话里交换；`,
    '· 对话要有来有回（问—答—追问—回避），不要只是一个人长篇独白。',
    `注意：**不要**为了凑占比灌水式加"嗯""哦"这类单字应答，也不要改写成剧本体 —— 其余篇幅要求照旧。`,
  ].join('\n');
}
