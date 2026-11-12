// ============================================================
// 意图门 · 硬规则（纯函数）
//
// 为什么单独抽出来：
//   这套规则此前**内嵌在** `runDiscussion()` 的循环里（1152 行的编排函数），
//   没有任何直接测试 —— 而它恰恰是决定「一章能不能交付」的地方，且 10-16/10-17/10-18
//   三次实测修复（重复 / 篇幅上下限 / 对话占比 / 三条交付红线）全落在这里。
//   抽成纯函数后，规则本身可以脱离模型、DB、SSE 被完整验证。
//
// 口径必须与 `runDiscussion` 完全一致：
//   · 复核明确写「判定：打回」→ 打回
//   · 三条交付红线（正文纯度 / 去重 / 对话）任一写「不通过」→ 打回
//   · 代码数出的重复 / 篇幅出带 / 对话过少 / 跨章重复 → 打回（不依赖模型自报）
//
// ★ 注意：这里**不做**任何模型调用，也不读写 DB。决策器（Jev）是另一层增强，
//   只在硬规则判不通过时才被询问，见 framework/gate-decision.ts。
// ============================================================

import type { RepetitionReport, CrossRepetitionReport } from '../pipeline/repetition.js';
import type { DialogueReport } from '../framework/dialogue.js';
import { WRITER_MIN_CHARS, WRITER_MAX_CHARS } from './roles.js';

/** 正文字数口径：与交付时写入 word_count 的算法保持一致（去空白字符数） */
export function proseLength(s: string): number {
  return s.replace(/\s/g, '').length;
}

/** 超过写作官篇幅上限（几乎总等于「靠复述凑字数」） */
export function isTooLong(draft: string): boolean {
  return proseLength(draft) > WRITER_MAX_CHARS;
}

/** 低于写作官篇幅下限（没写完） */
export function isTooShort(draft: string): boolean {
  return proseLength(draft) < WRITER_MIN_CHARS;
}

/** 篇幅出带（超上限或欠下限）—— 确定性硬伤 */
export function isOutOfBand(draft: string): boolean {
  return isTooLong(draft) || isTooShort(draft);
}

/**
 * 重写轮里的**篇幅指令**。
 *
 * ★ 2026-11-04 新增，治「重写叫它少动、闸门要它多写」的自相矛盾。
 *
 *   原先重写提示词把「**能局部改就不要整章重来**，只动需要动的地方」放在最前面，
 *   篇幅要求只是末尾一个括号。实测（13 章 / hy3）：短稿每轮重写只加 **15–300 字**
 *   —— 1920 → 1935 → 2020，而闸门要求 ≥2500。两条指令打架时模型服从措辞更强的那条，
 *   于是每章都卡在"改不动 → 用尽重写次数 → 按最不差的一稿交付"。
 *
 *   所以篇幅**欠下限**时口径必须反过来：明说允许整章重写、禁止只做局部润色。
 *   超上限则维持原口径（删，不要扩写）—— 那两个方向的话术不能混用，
 *   否则会出现"一边要求不少于、一边要求别超"的两头挨骂（见调用点的既有注释）。
 *
 * ★ 2026-11-05 再修一层：**扩写只能来自已有场景的稠密化，不能来自新增场景**。
 *   见下方欠下限分支里的说明 —— 这条口径必须与写作官 system 的"不要加第 6 个场景"对齐，
 *   否则模型会在"篇幅"与"节拍"两个硬约束之间来回振荡。
 */
export function renderLengthDirective(o: {
  chars: number;
  minChars: number;
  maxChars: number;
}): string {
  const { chars, minChars, maxChars } = o;
  if (chars > maxChars) {
    return `【篇幅】本章**已超出上限**（现在 ${chars} 字，上限 ${maxChars} 字）。`
      + '**必须删到上限以内** —— 优先删掉重复的段与句、删掉没有新信息的复述；'
      + '**不要**为凑数扩写，**也不要**因为删了就补写新段。';
  }
  if (chars < minChars) {
    return `【篇幅】本章**只有 ${chars} 字，低于 ${minChars} 字下限**（还差 ${minChars - chars} 字）。`
      + '**必须扩写到达标 —— 这是本轮第一优先，比"少改动"重要**：'
      + '· 允许**整章重写**，不要为了"保住原句"而不敢加；'
      /**
       * ★ 2026-11-05：从「加**新的场景内容**」改成「把**已有场景写厚**」。
       *
       *   上一版这句与写作官 system 里的硬锚点直接对立：
       *     system：「一章写 3–5 个场景…**不要靠加第 6、第 7 个场景**（那是超长的主因）」
       *     这里 ：「加的是**新的场景内容**」
       *   于是模型被夹在两条相反的指令中间，只能挑最新最具体的那条执行。
       *
       *   实测代价（第 1/2 章，四次复核）：复核判"正文超出四拍范围" → 写作官删场景
       *   （3101→1349）→ 删到跌破篇幅下限 → 篇幅门打回 → 扩写（→3053）→ 又超节拍 → 再删…
       *   两个硬约束各自都满足不了对方，来回振荡到重写次数用尽，最后按原稿交付。
       *
       *   改口径的原则：**让"变长"与"不超节拍"指向同一个动作**。
       *   要加的篇幅只能来自已有场景内部的稠密化，不能来自新增情节。
       */
      + '· 加的是**已有场景内部**的动作、对话、细节、环境 —— **把现有场景写厚**；'
      + '· **不要新增场景 / 不要新增情节**（会超出本章节拍，复核会打回，等于白改）；'
      + '· 也不要只是把原句换个说法讲一遍（那是复述，会触发重复检测）；'
      + `· 写到 ${minChars}–${maxChars} 字之间，不要超过 ${maxChars} 字（超了同样会被打回）。`;
  }
  return `【篇幅】照旧保持在 ${minChars}–${maxChars} 字之间。`;
}

/**
 * 重写轮的开场指令。
 *
 * ★ 2026-11-04 从 `orchestrator.ts` 抽出来（**并修了它的自相矛盾**）。
 *
 *   原来无论篇幅在不在带内，开场都是「**能局部改就不要整章重来**，只动需要动的地方」。
 *   篇幅欠下限时这句话和闸门要求直接打架 —— 实测短稿每轮只加 15–300 字，
 *   就是被这句话按住的（闸门要 ≥2500，指令说"少动"）。
 *
 *   现在按篇幅状态分叉：**出带时不给"少改动"的许可**，改为"以修好硬指标为第一优先"；
 *   在带内才保留原来的口径（那时少改动确实是对的，能减少模型改写引入的新问题）。
 *
 *   抽成纯函数是为了让这条口径**可测**：见 gate-rules.test.ts 的断言
 *   「欠下限时开场不得出现『能局部改就不要整章重来』」。
 */
export function renderRewriteLead(outOfBand: boolean): string {
  const head = '【本轮任务】你上一稿没过意图复核。按上文「意图复核」给出的**修改要求**重写。';
  return outOfBand
    ? head + '**本轮以修好硬指标为第一优先** —— 该扩写就扩写、该删就删，'
      + '不要为了"少改动"而留着不达标。'
      // ★ 2026-11-05：此处一并钉住"往哪儿扩"，否则模型会拿新增场景去凑字数（与节拍约束打架）
      + '**要加篇幅就加在已有场景里，不要开新场景**（新增情节会超出本章节拍）。'
      + '直接输出修改后的**完整正文**。'
    : head + '**能局部改就不要整章重来**，只动需要动的地方；直接输出修改后的**完整正文**。';
}

/**
 * 篇幅离区间 [WRITER_MIN_CHARS, WRITER_MAX_CHARS] 的距离：落在区间内为 0。
 * 越出得越远，值越大。用于在几稿之间比「谁更贴区间」。
 */
export function bandDistance(length: number): number {
  if (length < WRITER_MIN_CHARS) return WRITER_MIN_CHARS - length;
  if (length > WRITER_MAX_CHARS) return length - WRITER_MAX_CHARS;
  return 0;
}

/**
 * 从若干候选稿的**字数**里挑「最贴区间」的一稿，返回其下标（0 是初稿）。
 * 并列时取**更长**的一稿（长的那稿信息更多，且这里的前提是它没有离谱到超出容差 ——
 * 容差由调用方在拿到补写稿时先判一次）。
 *
 * ★ 2026-10-20 实测教训（这条函数是被真实数据逼出来的）：
 *   · 补写提示词原来只写「补到 3000 字以上」没有上限 ⇒ 模型把 1361 字的稿子灌到 **6863 字**；
 *   · 第一版修法是「超上限就丢弃补写稿、保留初稿」—— 结果是短稿**照旧很短**地进闸门，
 *     实测第 34 章只有 **1283 字**就这样交了货。
 *   两稿都不可取：正确做法是**挑离区间最近的那一稿**（并且在失控时再要一稿「删到区间内」，
 *   见 orchestrator 的篇幅校正），而不是非黑即白地二选一。
 */
export function pickNearestBand(...lengths: number[]): number {
  let best = 0;
  for (let i = 1; i < lengths.length; i++) {
    const d = bandDistance(lengths[i]);
    const bestD = bandDistance(lengths[best]);
    if (d < bestD || (d === bestD && lengths[i] > lengths[best])) best = i;
  }
  return best;
}

/**
 * 补写稿是否「失控」（涨得离谱，典型是靠灌水/复述凑字数）。
 * 判据是超过上限 1.5 倍 —— 实测干净稿从不会这样，失控稿一冲就是 2–3 倍（6863 / 9010 / 6306）。
 */
export function isRunawayExpansion(expandedLength: number): boolean {
  return expandedLength > Math.round(WRITER_MAX_CHARS * 1.5);
}

/** 交付候选稿的确定性指标（都不依赖模型判断，全是数出来的） */
export interface DraftCandidate {
  chars: number;
  /** 章内重复：多余重复句 + 变体重复 */
  intraDup: number;
  /** 跨章重复句数 */
  crossDup: number;
  /** 提纲泄漏处数（可选：老调用点不传按 0 算） */
  leak?: number;
}

/**
 * 候选稿的「惩罚分」：**越小越好**。用于打回上限用尽时挑一稿交付。
 *
 * 口径（权重是标定出来的，不是拍的）：
 *   · 篇幅离区间多远 —— **1 字算 6 分**（见下面 2026-10-22 的量纲修正）；
 *   · 章内重复一句 —— **200 分**（一句冗余重复对读者的伤害，远大于把一章写长/写短 200 字：
 *     实测坏章的共同特征就是"靠复述凑字数"，超长和重复本来就是同一个病的两面）；
 *   · 跨章重复一句 —— **100 分**（比章内轻一档：它未必是坏句，只是不该第二次出现）；
 *   · 提纲泄漏一处 —— **300 分**（出现「第38章」「埋线」这类词，是成品被读者一眼
 *     看出是机器写的，比多几句重复更致命）。
 *
 * ★ 2026-10-22 修**量纲**（这条修完才真正止住残章交货）：
 *   篇幅权重原先是 1 分/字，那是"所有候选稿长度都差不多"年代的口径 ——
 *   实测写作模型同一 prompt 的输出在 1782–8708 字之间乱跳，1 分/字就完全压不住了：
 *     候选 #1 = 3480 字（**在带内**）/ 章内 10 处 ⇒ 罚 2500
 *     候选 #3 = 1824 字（**欠下限 676 字**）/ 零重复 ⇒ 罚 676  ← 被选中，残章交货
 *   "缺了四分之一正文的短章"竟然比"完整但有 10 处重复的章"更划算，这显然反了。
 *   改成 6 分/字后：在带内的稿子天然胜过任何出带稿（200 字出带 ≈ 一处重复，量与量之间可比），
 *   而超长稿在被比之前就已经被 `trimToMaxChars` 裁进区间、距离归零，不受这条影响。
 *
 * 例（实测第 39 章）：某稿 8708 字（裁到 ~3480 后按带内算）/ 章内 61 处 ⇒ 12200 分；
 * 若另一稿 3300 字 / 章内 4 处 ⇒ 800 分 ⇒ 交付会取后者。
 */
export function draftPenalty(c: DraftCandidate): number {
  return bandDistance(c.chars) * 6 + c.intraDup * 200 + c.crossDup * 100 + (c.leak ?? 0) * 300;
}

/** 从候选稿里挑惩罚分最低的一稿，返回下标。并列时取**更靠后**的一稿（它更晚写、更贴合复核意见）。 */
export function pickBestDraft(candidates: DraftCandidate[]): number {
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    // `<=`：并列时取更靠后的一稿 —— 罚分相同就没有理由退回旧稿，
    // 而更新的一稿更贴合复核意见（旧稿被判回来的那些毛病它是带着改的）。
    if (draftPenalty(candidates[i]) <= draftPenalty(candidates[best])) best = i;
  }
  return best;
}

/**
 * 提纲泄漏（写作/结构性语言混进正文）的**确定性**检测。
 *
 * ★ 2026-10-21 补上——此前这条通道上**只有模型监工**在管（`kind: outline-leak`），
 *   而 `HardRuleInput` 里的 `leak` 一直是硬编码 0、注释写着"留字段供将来接确定性泄漏计数"。
 *   后果实测：58 章的书体检出 **28 处泄漏**，且模型监工抓到的章要等 3 次重写上限用尽才停。
 *
 * 两类词，都是**小说里绝不出现**的：
 *   ① 写作/提纲词：埋线、续埋、伏笔说明、回收、钩子、伏笔、章节、台账、作者、读者…
 *   ② **结构指代**：`第38章`、`本章`、`上一章`、`下一章`、`前章`、`章内`、`章尾`
 *      —— 实测原句：「她记起**第38章**深坞漂出的第七块同式木牌…」「那是**第32章**自深坞漂箱落进下坞抽舱的空白木牌」。
 *      小说正文里指称"第几章"是把施工图直接印在成品上，与"埋线"同类，危害更直白（读者一眼看出是机器写的）。
 *
 * 注意：只数**词**，不判语义——所以用词表而不是模型。误报风险低（这些词在正常叙事里没有位置），
 * 门槛设成"命中即算一处"，是否打回由 `LEAK_TOTAL_MAX` 定。
 */
const LEAK_WORDS = [
  '埋线', '续埋', '伏笔说明', '回收伏笔', '钩子', '埋点',
  '台账', '作者', '读者', '世界线', '大纲',
];
/**
 * 结构指代的**完整**词表。
 *
 * ★ 2026-10-21 二次收紧：第一版只写 `第\d+章`，结果漏掉了模型改用的**中文数字**写法 ——
 *   实测监工在第 58 章抓到的原句是「从**五十四章**埋下差末笔起就空着」「**三十八章**泥坑里那块牌裹的」
 *   「坑里那位，连着**两章**没咳了」。阿拉伯数字与中文数字必须**同时**覆盖。
 *
 * 为什么敢用宽松的「数字+章」：中文叙事里 `章` 除了章号只剩「文章/篇章/印章/规章」这类词，
 *   而它们的前一个字都不是数字 —— 所以「数字紧邻章」在小说里几乎必然是章号。
 *   万一误报，代价也只是多一次重写（门槛 LEAK_TOTAL_MAX 还有 3 处余量）。
 */
const CN_NUM = '0-9０-９一二三四五六七八九十百千零两';
const LEAK_STRUCT_RE = new RegExp(
  [
    `第\\s*[${CN_NUM}]+\\s*章`,     // 第38章 / 第三十八章
    `[${CN_NUM}]+\\s*章`,           // 三十八章 / 五十四章 / 连着两章（无"第"字）
    '本章', '上一章', '下一章', '前章', '后章', '此章', '章内', '章尾',
  ].join('|'),
  'g',
);

export interface LeakHit {
  /** 命中的词/式（原样，便于写进重写指令） */
  word: string;
  /** 命中次数 */
  count: number;
  /**
   * 类别：
   *   · `struct` —— 章号/章相对指代（"第38章""三十八章""本章"）。**零容忍**。
   *   · `word` —— 提纲/写作词（埋线、钩子、作者…）。留一点余量。
   */
  kind: 'struct' | 'word';
}

/** 数一稿里的提纲泄漏。返回命中明细（空数组 = 干净）。 */
export function detectOutlineLeak(draft: string): LeakHit[] {
  const text = draft ?? '';
  const hits: LeakHit[] = [];
  for (const w of LEAK_WORDS) {
    let n = 0;
    let i = -1;
    while ((i = text.indexOf(w, i + 1)) >= 0) n += 1;
    if (n > 0) hits.push({ word: w, count: n, kind: 'word' });
  }
  const struct = text.match(new RegExp(LEAK_STRUCT_RE.source, 'g')) ?? [];
  if (struct.length > 0) hits.push({ word: '第N章/本章', count: struct.length, kind: 'struct' });
  return hits;
}

/** 泄漏总处数 */
export function leakTotal(hits: readonly LeakHit[]): number {
  return hits.reduce((a, h) => a + h.count, 0);
}

/**
 * 两类泄漏的**硬上限**。
 *
 * ★ 2026-10-21 定标（拿已完成 58 章的真实正文量的）：单用一个总阈值 3 太松 ——
 *   全书 48 处泄漏里只有 2 章超 3，而**28 章的正文各带 1 处「第N章」，照样交货**。
 *   所以分两档：
 *   · **章号类零容忍**（`LEAK_STRUCT_MAX = 0`）：小说正文里出现"第32章""三十八章""本章"
 *     没有任何正当用法 —— 读者一眼就看出是机器写的，留一处都是残次品；
 *   · **提纲词留余量**（`LEAK_WORD_MAX = 3`）："作者""读者"偶有正当语境，误报代价是白改一轮。
 */
export const LEAK_STRUCT_MAX = 0;
export const LEAK_WORD_MAX = 3;

/** 泄漏是否超过各自的档位上限 */
export function leakExceeds(hits: readonly LeakHit[]): boolean {
  const struct = hits.filter((h) => h.kind === 'struct').reduce((a, h) => a + h.count, 0);
  const word = hits.filter((h) => h.kind === 'word').reduce((a, h) => a + h.count, 0);
  return struct > LEAK_STRUCT_MAX || word > LEAK_WORD_MAX;
}

/**
 * 把超长正文**按段落边界**裁进上限（确定性、零模型调用）。
 *
 * ★ 2026-10-22 实测驱动的设计：`z/hy3` 在真实写作 prompt 下输出 2756–6217 字，**方差极大**
 *   （同 prompt 同参数连跑三次：2756 / 4210 / 4670 / 6217），而且每次都是 `finish_reason=stop`
 *   ——它从不被 max_tokens 截断，是**自己决定写多长**。提示词里加"场景数"锚点、加"写完数一遍"
 *   都试过，一次都没收住（实测 6217 / 6299 字，反比之前更长）。
 *   让模型"删到区间"要多花一次 40 秒调用、且同样不可靠（实测 3912→3822 这种只删 90 字的）。
 *
 *   所以最后一道用**代码裁**：按段落（空行/换行）从后往前整段丢弃，直到压进上限。
 *   代价是可能丢一个结尾段落 —— 但它比"整章超 78% 直接进闸门打回重写 3 次"好得多，
 *   而且裁掉的是**最后**的段落，前面的叙事完整、开头不减。
 *
 * 裁不动（比如只有一个超长段落）就原样返回，交回原有流程。
 */
export function trimToMaxChars(text: string, maxChars: number = WRITER_MAX_CHARS): string {
  const t = text ?? '';
  if (proseLength(t) <= maxChars) return t;
  const paras = t.split(/(\n\s*\n|\n)/);
  // 从后往前丢**正文段落**（保留分隔符本身在数组里，拼回去时不至于粘连）
  while (paras.length > 1 && proseLength(paras.join('')) > maxChars) {
    // 每次丢最后一个非空白块
    let i = paras.length - 1;
    while (i >= 0 && paras[i]!.trim() === '') i -= 1;
    if (i <= 0) break;
    paras.splice(i, 1);
  }
  const out = paras.join('').replace(/\s+$/, '');
  return proseLength(out) <= maxChars ? out : t;   // 裁不动就原样返回
}

// ★ 2026-11-03 清理：原 `evaluateDraft` / `DraftFindings` 已删（运行期 0 调用，
//   只剩单测与 .runtime/probe-gate.mjs 在用）。
//   退役原因：它是"一稿全量确定性检查"的**聚合器**，但编排层（discuss/orchestrator.ts）
//   从不调它 —— 那边把同一批判定**逐项内联**在定稿流程里。两份并存时被测试的是死的
//   这一份，真正的生产路径反而没被这套断言覆盖，留着只会掩盖漂移。
//   下面导出的各单项判定（repetition / dialogue / outline-leak / 篇幅）仍是现役接口。

/**
 * 复核明确给出「打回」。
 *
 * ★ 2026-11-01：**同时认三种写法**。改契约后实测它换成了 Markdown 标题式输出：
 *     `# 验收判定：…` / `## 三、总体判定` / `- 剧情：部分不符（…）` / `建议：截断…`
 *   而旧正则只认行首的 `判定：打回`，于是**四维全解析成空、总判定也读不到**
 *   ⇒ 它最可靠的语义判断（剧情/角色/设定）被整份丢掉，只剩体检在说话。
 *   这是本项目第 5 次「契约改格式、解析器没跟上」（见 MEMORY 里的同类记录）。
 *
 * 判据保持**保守**：只认明确的打回/驳回/不符措辞，绝不因为出现「打回」二字就判死
 * （契约里本来就有"打回必须给出可执行指令"这类说明句）。
 */
export function reviewRequiresRewrite(review: string): boolean {
  return /(判定|结论)\s*[：:][^\n]{0,40}(打回|驳回)/
    .test(review);
}

/**
 * 复核在**语义三维**里判了「不通过/不符」。
 *
 * ★ 2026-11-01 新增。为什么需要它：
 *   旧实现只看总判定行，而模型经常写「总体判定」分项（`- 剧情：部分不符（收尾溢出）`）
 *   却不写总判定行 —— 那样它的核心发现就没人采纳。
 *   三维是复核官**唯一不可替代**的部分（去重/纯度已归代码），必须读得到。
 *
 * 只认这三项：剧情 / 角色 / 设定。去重 / 正文纯度 / 对话 各自另有判据，不在此列。
 */
export function reviewRejectsSemantic(review: string): boolean {
  // ① 同一行：`剧情：部分不符` / `角色：不通过`
  if (/(剧情|角色|设定)\s*[：:][^\n]{0,20}(不通过|不符|未落实|未落|偏离|溢出|不合格)/.test(review)) return true;
  /**
   * ② 跨行：实测它写成
   *      【剧情】
   *      不合格。
   *    标签与结论被换行隔开。只认**紧跟其后的两三行**，
   *    避免把远处无关的「不通过」算到这一维头上。
   */
  return /【?\s*(剧情|角色|设定)\s*】?\s*[:：]?\s*\n\s*[-*]?\s*[^\n]{0,30}?(不通过|不符|未落实|未落|偏离|溢出|不合格)/
    .test(review);
}

/**
 * 复核红线的「不通过」——**只剩对话一项**。
 *
 * ★ 2026-11-01：**去重 / 正文纯度已从这条红线里移出**，判决权收归代码。
 *
 * 理由（10 章 / 30 次复核的实测，逐句对齐模块自己的检测器）：
 *   · 去重维度 14 次指控里 **10 次不存在（71% 误报）**
 *   · 正文纯度 7 次指控里 **4 次引用的"原话"根本不在正文里**
 *   根因不是模型笨，是**信息缺口**：旧实现只在代码检出问题时才把事实喂给它，
 *   没检出时它一无所知，而契约又要求它自己数 ⇒ 干净的维度全靠猜。
 *   而这两项本来是**纯机械计数**（`detectRepetition.excessive` / `leakExceeds` 已精确算好），
 *   让模型参与只会引入噪声。⇒ 现在只由代码判（见 `passedHardRules`）。
 *
 * ★ **对话这一项刻意保留**：它有代码判不了的部分 —— 代码只能数引号里的字数，
 *   分不出"对着空气自语的引号段"算不算对话（那是本书的老毛病：自言自语冒充对话）。
 *   所以代码给**数字**（占比 + 形态，见 `review-evidence.ts`），
 *   但"这算不算真对话"仍由复核官判。
 */
export function reviewHitsRedLine(review: string): boolean {
  return /对话\s*[：:][^\n]*不通过/.test(review);
}

export interface HardRuleInput {
  review: string;
  rep: RepetitionReport;
  cross: CrossRepetitionReport;
  dlg: DialogueReport;
  /** 篇幅是否出带；不传则调用方自行保证已算过 */
  outOfBand?: boolean;
  /** 提纲泄漏是否超上限（不传 = 未检查，保持"不因此打回"的旧行为） */
  leakTooMany?: boolean;
}

/**
 * 硬规则是否放行。
 *
 * 放行 = 模型没写打回 + 没踩红线 + 代码没数出重复 / 跨章重复 / 篇幅出带 /
 *        对话过少 / 对话过密 / 对话太碎 / 提纲泄漏。
 * 任一不满足即打回；随后（若启用）才问决策器「值不值得再改」。
 *
 * ★ 2026-10-30 加 `tooFragmented`：占比可能正好，但每句都是 1–4 字的应答
 *   （用户反馈「对话内容太短，太像 AI」）—— 词面统计测得出，故不依赖模型自报。
 */
export function passedHardRules(input: HardRuleInput): boolean {
  return !reviewRequiresRewrite(input.review)
    // 语义三维（剧情/角色/设定）判了「不符/偏离」—— 复核官唯一不可替代的判断
    && !reviewRejectsSemantic(input.review)
    // 只剩对话一条模型红线（去重/纯度已由下面几行代码判定，见 reviewHitsRedLine 注释）
    && !reviewHitsRedLine(input.review)
    && !input.rep.excessive
    && !(input.outOfBand ?? false)
    && !input.dlg.tooLow
    && !input.dlg.tooHigh
    && !input.dlg.tooFragmented
    && !input.cross.excessive
    && !(input.leakTooMany ?? false);
}
