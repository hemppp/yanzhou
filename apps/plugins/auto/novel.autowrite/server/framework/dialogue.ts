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

export interface DialogueReport {
  /** 对话占比 = 引号内内容字数 / 正文内容字数（0–1）；空稿为 0 */
  ratio: number;
  /** 引号内的内容字数（归一化后，不含引号本身与引号内标点） */
  dialogueChars: number;
  /** 正文内容字数（归一化后） */
  totalChars: number;
  /** 是否低于 DIALOGUE_RATIO_MIN（调用方据此打回/重写） */
  tooLow: boolean;
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
  for (const ch of chars) {
    if (ch === '"' || ch === "'") { inQuote = !inQuote; continue; }
    if (CJK_CLOSE.includes(ch)) { inQuote = false; continue; }
    if (CJK_OPEN.includes(ch)) { inQuote = true; continue; }
    if (inQuote) dialogueChars += countProseChars(ch);
  }
  const ratio = totalChars > 0 ? dialogueChars / totalChars : 0;
  return {
    ratio,
    dialogueChars,
    totalChars,
    // 空稿（totalChars=0）不算「对话偏少」—— 那是篇幅门的事，不该在这里重复打回
    tooLow: totalChars > 0 && ratio < DIALOGUE_RATIO_MIN,
  };
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
  return [
    '【本次重写的硬性要求：把对话补上来】',
    `框架逐字统计：本章对话占比只有 ${pct}%（引号内 ${rep.dialogueChars} 字 / 正文 ${rep.totalChars} 字），低于 ${min}% 的下限。`,
    '请**增加人物之间的对话**：把下列内容改成**当面说出来的对白**（而不是叙述转述或内心独白）——',
    `· 现在写成"他想…""他知道…"的推理，能让人问出来、答出来；`,
    `· 现在用旁白交代的信息（谁去了哪、为什么、要怎么办），交给角色在对话里交换；`,
    '· 对话要有来有回（问—答—追问—回避），不要只是一个人长篇独白。',
    `注意：**不要**为了凑占比灌水式加"嗯""哦"这类单字应答，也不要改写成剧本体 —— 其余篇幅要求照旧。`,
  ].join('\n');
}
