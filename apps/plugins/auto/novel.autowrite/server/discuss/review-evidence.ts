// ============================================================
// 复核证据包 —— 把代码数出来的**事实**（含"没问题"）一并交给复核官
//
// 为什么要有这个文件（2026-11-01 实测定位的真缺陷）：
//   旧写法只在**检出问题**时才把事实喂给复核官：
//       rep.excessive ? 「框架已检出重复…」 : ''
//   于是"干净"的维度它**一无所知**，而契约又要求它自己数
//   （【去重】"有两处以上重复，判不通过"、【对话】"给出估计的占比"）。
//   ⇒ 凡是没有问题的维度，它的判决都是猜的。
//
//   实测（10 章 / 30 次复核，逐句对齐模块自己的检测器）：
//     · 去重维度 14 次指控 **10 次不存在（71% 误报）**
//     · 正文纯度 7 次指控 **4 次引用的"原话"根本不在正文里**
//     · 对话维度 24 次指控 **4 次与代码实测不符**（报 13.8%，实测 19.8%）
//   误报直接导致整章打回（任一维「不通过」即打回，见 orchestrator 的 passedHardRules），
//   每次打回烧掉一次完整写作官调用。
//
// 两条修法（本文件是第 1 条）：
//   ① **双向证据**：没有问题时也明说"框架逐句数过：无超限重复"。它要么印证、要么忽略，
//      但不能再说"没看见"。
//   ② **判决权收归代码**（见 orchestrator）：去重 / 正文纯度这两个**确定性**维度
//      不再由模型判，只由代码判 —— 与 2026-10-27 已确立的口径一致（"确定性代码答得更好"）。
//
// ★ 这个文件是纯函数：输入全部是已算好的报告对象，零模型调用、零 DB，可直接单测。
// ============================================================

import type { RepetitionReport, CrossRepetitionReport } from '../pipeline/repetition.js';
import type { DialogueReport } from '../framework/dialogue.js';
import { DIALOGUE_RATIO_MIN, DIALOGUE_RATIO_MAX } from '../framework/dialogue.js';
import {
  LEAK_STRUCT_MAX, LEAK_WORD_MAX,
  type LeakHit,
} from './gate-rules.js';

/** 交给复核官之前要先算好的一切（都是代码已经数过的） */
export interface ReviewEvidenceInput {
  /** 章内重复 */
  rep: RepetitionReport;
  /** 跨章重复 */
  cross: CrossRepetitionReport;
  /** 对话占比与形态 */
  dlg: DialogueReport;
  /** 正文字数（与 gate-rules 的 proseLength 同口径） */
  chars: number;
  charMin: number;
  charMax: number;
  /** 是否出带（含超上限与欠下限） */
  outOfBand: boolean;
  /** 提纲/结构语言命中明细 */
  leakHits: readonly LeakHit[];
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * 生成「框架事实」块。
 *
 * ★ 每一行都**必出现**，且分成「命中」与「未命中」两种写法 —— 这就是"双向"的全部含义：
 *   复核官读到的永远是一份**完整的体检单**，而不是"只有异常项的告警"。
 *   它因此没有空间去猜，也就没有空间猜错。
 */
export function renderReviewEvidence(input: ReviewEvidenceInput): string {
  const { rep, cross, dlg, chars, charMin, charMax, outOfBand, leakHits } = input;
  const lines: string[] = [];

  // —— 篇幅 ——
  lines.push(outOfBand
    ? `篇幅：**出带** —— ${chars} 字（允许 ${charMin}–${charMax}）`
    : `篇幅：在带内 —— ${chars} 字（允许 ${charMin}–${charMax}）`);

  // —— 章内重复（确定性；判决权已归代码）——
  const intraExcess = rep.excessSentences + rep.excessNearDuplicates;
  lines.push(rep.excessive
    ? `章内重复：**超限** —— 多余 ${intraExcess} 处`
    : '章内重复：**无** —— 逐句比对过，没有同一句话/同一动作/同一段景物出现两次以上');

  // —— 跨章重复（确定性；判决权已归代码）——
  lines.push(cross.excessive
    ? `跨章重复：**超限** —— 与前面章节重复 ${cross.count} 句`
    : '跨章重复：**无** —— 与前面章节逐句比对过，没有大段重复');

  // —— 对话占比（确定性计数；这一项让复核官不必再"估"）——
  const ratio = dlg.ratio;
  const dlgState = dlg.tooLow
    ? '**偏低**'
    : dlg.tooHigh ? '**偏高**'
      : '在区间内';
  lines.push(
    `对话占比：${pct(ratio)} —— ${dlgState}`
    + `（目标 ${pct(DIALOGUE_RATIO_MIN)}–${pct(DIALOGUE_RATIO_MAX)}，独白不算对话）`
    + `｜引号段 ${dlg.segments} 段，平均 ${dlg.meanSegChars} 字`,
  );
  if (dlg.tooFragmented) {
    lines.push(`对话形态：**过碎** —— ${dlg.shortSegs} 个短段占 ${pct(dlg.shortSegRatio)}`);
  } else {
    lines.push('对话形态：正常 —— 无「一到四字应答连排」');
  }

  // —— 正文纯度（确定性；判决权已归代码）——
  const structHits = leakHits.filter((h) => h.kind === 'struct').reduce((a, h) => a + h.count, 0);
  const wordHits = leakHits.filter((h) => h.kind === 'word').reduce((a, h) => a + h.count, 0);
  if (structHits > LEAK_STRUCT_MAX || wordHits > LEAK_WORD_MAX) {
    lines.push(
      `正文纯度：**不纯** —— 章号/结构指代 ${structHits} 处、提纲词 ${wordHits} 处`
      + (leakHits.length ? `（${leakHits.map((h) => `${h.word}×${h.count}`).join('、')}）` : ''),
    );
  } else {
    lines.push(
      `正文纯度：**干净** —— 逐词扫过，无「第N章/本章/埋线/钩子/作者/读者/台账」等提纲语言`
      + (wordHits > 0 ? `（仅有 ${wordHits} 处提纲词，在容差内）` : ''),
    );
  }

  return [
    '【框架事实（代码逐项数出来的，不是你的判断）】',
    ...lines.map((l) => `· ${l}`),
    '',
    '★ 上面这五项是**确定性计数**，以框架数字为准：**去重 / 正文纯度 / 篇幅 / 对话占比**'
    + '这几项你不用再自己估，也不要给出与之冲突的估计值。',
    '★ 你只判**下面这三件事**（框架数不出来，必须由你读正文判断）：',
    '   【剧情】节拍是否逐条落实、顺序有没有乱、关键物是否出现且状态一致、收尾是否落在「结束状态」',
    '   【角色】结论角色栏每条状态变化是否真实发生、动机与反应是否符合讨论中定下的理解、有没有用已否决的处理方式',
    '   【设定】有没有违反结论的「禁项」、伏笔是否按结论指示处理（说「不动」的有没有被乱动）',
  ].join('\n');
}
