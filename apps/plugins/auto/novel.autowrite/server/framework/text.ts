// ============================================================
// 纯文本工具 —— 宽松 JSON 解析 / 字数口径 / 短 id
//
// ★ 2026-09-28 从 `autowrite/helpers.ts` 迁出。原文件属于**已删除的旧批次流水线**，
//   但下面这几个函数被**现役链路**（discuss / pipeline / framework / memory）共用 ——
//   删旧代码时它们必须留下，否则现役链路全线断。
//   迁出后 autowrite/ 目录得以整体删除。
// ============================================================

/**
 * 从自由文本里取出**第一个配平**的 JSON（对象或数组）。
 *
 * 为什么不能"第一个 { 到最后一个 }"：模型经常输出**两个 JSON**，
 * 或者 JSON 后面跟一句带 `}` 的话 —— 那样切片会跨过两个对象，JSON.parse 直接报
 * `Unexpected non-whitespace character after JSON`（实测在校对门上连撞 2/3 次）。
 * 这里按括号配平扫描，字符串内的括号与转义都跳过。
 */
export function extractFirstJson(raw: string): string | null {
  const open = raw.search(/[{[]/);
  if (open < 0) return null;
  const openCh = raw[open]!;
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return raw.slice(open, i + 1);
    }
  }
  return null;   // 没配平（多半被 maxTokens 截断）
}

/** 宽松 JSON 解析：优先取第一个配平 JSON，回退到首尾大括号切片 */
export function parseJsonLoose<T>(raw: string): T {
  const first = extractFirstJson(raw);
  if (first) {
    try { return JSON.parse(first) as T; } catch { /* 落下去试老办法与更明确的报错 */ }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中未找到 JSON 对象：' + raw.slice(0, 120));
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

/**
 * 修补「字符串值里出现未转义 ASCII 双引号」的 JSON。
 *
 * ★ 2026-10-21 实测抓到：监工/轨迹确认的 JSON **本身是合法的意图**，但模型把正文里的
 *   对话原样写进了 `evidence` —— `"evidence": ""小周被褥里声淡："他缩着？""`，
 *   值内部的双引号没转义 ⇒ `JSON.parse` 必失败 ⇒ 整份报告被判「没能解析成 JSON」。
 *   实测 48 章的书里 supervisor/track **每一条**都栽在这上面（memory 里记的
 *   「pipeline_tracks 5/5 全部输出没能解析成 JSON」就是同一个根因）。
 *
 * 判据（扫描时逐字符判断，不重排内容）：在一个字符串**内部**遇到 `"` 时，
 * 向后看第一个非空白字符 —— 若是 `,` `}` `]` `:` 或字符串结束，那是真正的收尾引号；
 * 否则就是正文里的引号，补一个反斜杠转义。已经转义的（前面是 `\`）跳过。
 *
 * 修不好就原样返回，调用方照旧按"解析失败"兜底 —— 这里只做**尽力而为**，不吞错。
 */
export function repairUnescapedQuotes(json: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (ch === '\\') {          // 转义序列整体照抄（含 \" 与 \\）
      out += ch + (json[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch !== '"') { out += ch; continue; }
    // 位于字符串内部的双引号：向后找第一个非空白字符，判断它是不是收尾
    let j = i + 1;
    while (j < json.length && /\s/.test(json[j]!)) j += 1;
    const next = json[j];
    const isTerminator = next === undefined || next === ',' || next === '}' || next === ']' || next === ':';
    if (isTerminator) { out += ch; inStr = false; }
    else out += '\\"';          // 正文里的引号 → 转义
  }
  return out;
}

/**
 * 解析模型输出的 JSON，**先严格、失败再修补引号**。
 * 返回 null 表示确实解析不出来（调用方据此走"保守兜底"，不要当成 ok）。
 */
export function parseJsonTolerant(raw: string): Record<string, unknown> | null {
  const first = extractFirstJson(raw);
  if (!first) return null;
  try {
    return JSON.parse(first) as Record<string, unknown>;
  } catch { /* 落到修补 */ }
  try {
    return JSON.parse(repairUnescapedQuotes(first)) as Record<string, unknown>;
  } catch {
    return null;
  }
}


/**
 * 归一化「按内容计数」用的文本：只留汉字 / 字母 / 数字，丢掉空白与标点。
 *
 * ★ 2026-10-16 从 pipeline/repetition.ts 提上来共用。理由：章内重复检测
 *   （repetition.ts）与对话占比（framework/dialogue.ts）都要按**内容字数**而不是
 *   **字符数**来算 —— 标点与空白对判断毫无信息量，却能让同一段话因为标点不同
 *   数出不同长度（实测里模型正是靠「句号改省略号」绕过精确去重）。
 *   两处必须用同一把尺子，否则「对话占 20%」与「重复 16 字」在不同模块口径不一。
 */
export function normalizeProse(s: string): string {
  return s.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
}

/** 归一化后的内容字数（上面那把尺子的长度），空输入为 0 */
export function countProseChars(s: string): number {
  return normalizeProse(s).length;
}

/** 短 id（时间戳 + 随机后缀），用于快照等无 UUID 要求的场景 */
export function nowId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 剥掉正文**开头**的「工作笔记 / 元语言前言」。
 *
 * ★ 2026-10-30 实测事故（《铁壳里的声音》第 4 章全文开头）：
 *
 *   先补第4章节拍卡（依项目现状，原大纲只到第3章，本章无卡，按作者要求补卡并落至少一个不可逆结果）：
 *   【第4章节拍卡】
 *   - 起：韩野绕城北孙站记账窗…
 *   - 果（不可逆）：发夹离手归孙站…
 *   以下为修正后完整正文（删去越章面摊段，章内补对话提占比…）：
 *   韩野把发夹塞回裤包，骑三轮回城北。…
 *
 * 根因不是模型"不听话"，而是**指令把它引到了那里**：
 *   第 4 章没有节拍卡 ⇒ `productionMessageWithCard` 走无卡分支，
 *   该分支原文写着「**请先回到「章节大纲与节拍卡」段为本章补卡**」——
 *   写作官照做了，把"补卡"当成任务写进正文，然后才说"以下为…完整正文"。
 *   （该指令已于同日修正，但**不能只靠提示词**：一旦模型再把工作笔记写进正文，
 *   这里要能兜住 —— 提示词管"怎么写"，管不了它"跑偏了会被交出去"。）
 *
 * 三层剥离（任一层的剥离都必须**留下足够的正文**，否则放弃，见 `MIN_KEEP`）：
 *   ① 若出现「以下为…正文」这类**分界句**，取它**之后**的部分 —— 最可靠；
 *   ② 否则从开头逐段丢弃，直到某段不再是元语言；
 *   ③ 兜底：若「节拍卡」块出现在开头且其后仍有正文，从卡块之后开始。
 *
 * 「元语言」的判据只看**开头那段**（不是全文搜索）：正文里出现"回收""作者"这种词
 * 属于正常叙事（实测第 1 章「我上**回收**台电视机」就是误报过的例子），
 * 而**段首**的「先补…」「以下为…」「按作者要求」则只可能是在交代工作。
 */
const PREAMBLE_SPLIT_RE = /^.*?(?:以下|下面|如下)[是为]?\s*(?:修正后|修改后|改后|重写后)?\s*(?:的)?\s*(?:完整)?\s*正文.*?[：:]\s*$/m;
/** 段首的元语言：交代任务/补卡/删改/篇幅，而不是在讲故事 */
const PREAMBLE_LINE_RE = /^(?:先|另|顺便|补充|说明|备注|注|注意)?\s*(?:补|写|生成|列出|给出|输出|添加|修改|删去|删掉|压缩|扩写|修正|按|依|根据|为|因|由于)/;
/** 工作笔记的特征物：节拍卡块、条目符、括号内的自我指令 */
const PREAMBLE_MARK_RE = /【[^】]*(?:节拍卡|大纲|结论|任务|要求)[^】]*】|^\s*[-•·]\s*(?:起|承|转|合|探|变|果|目标|阻碍|灾难|反应|困境|决定|本章功能)\s*[:：]|本条|本章|第\s*\d+\s*章|作者要求|元评论|不计入正文/;

/** 保护阀：剥离后正文不得少于这个比例，否则认为"这不是前言，是正文"，原样返回 */
const MIN_KEEP = 0.5;

/**
 * @param raw 写作官的原始输出
 * @returns 剥掉开头工作笔记后的正文（若不满足保护阀则原样返回）
 */
export function stripProsePreamble(raw: string): string {
  const text = String(raw ?? '');
  if (!text.trim()) return text;

  const accept = (candidate: string): string | null => {
    const c = candidate.replace(/^\s+/, '');
    // 保护阀：剥完还剩一半以上，才算"真的剥掉了前言"；否则宁可不动
    return countProseChars(c) >= countProseChars(text) * MIN_KEEP && countProseChars(c) > 0 ? c : null;
  };

  // ① 分界句最可靠：「以下为（修正后）完整正文：」
  const split = PREAMBLE_SPLIT_RE.exec(text);
  if (split) {
    const after = accept(text.slice(split.index + split[0].length));
    if (after) return after;
  }

  // ② 逐段丢弃开头的元语言段（最多丢掉前 1/MIN_KEEP 的位置，避免把正文吃光）
  const paras = text.split(/\n\s*\n/);
  let drop = 0;
  const limit = Math.max(1, Math.floor(paras.length * (1 - MIN_KEEP)));
  while (drop < limit && drop < paras.length) {
    const p = paras[drop]!.trim();
    if (!p) { drop++; continue; }
    // 一个"前言段"= 段首是元语言 或 含工作笔记特征物
    const looksMeta = PREAMBLE_LINE_RE.test(p) || PREAMBLE_MARK_RE.test(p);
    if (!looksMeta) break;
    drop++;
  }
  if (drop > 0) {
    const rest = accept(paras.slice(drop).join('\n\n'));
    if (rest) return rest;
  }

  return text;
}

/**
 * 末尾元语言的判据（对称于开头的 `PREAMBLE_*`）。
 *
 * ★ 2026-11-02 新增，起因是一次实测：第 1 章正文**末尾**混进了校对门的修订说明——
 *   「--- 修正说明：删除起始章号标题（消除纯度不纯），合并重复的"铁锈味风钻入"描写
 *   （仅保留门缝一处），余文未动，已与设定库逐条核对无冲突，篇幅约 2770 字。」
 *   而 `stripProsePreamble` **只处理开头**（日志里也确实有「剥除正文开头的元语言前言」），
 *   末尾这类说明被原样落库、进了成稿。
 *
 * 为什么末尾会出现：校对门定向修订的提示词是「直接输出修正后的**完整正文**」，
 *   但模型习惯性地把"我改了什么"附在末尾 —— 提示词管不住，只能在落库前兜住。
 *
 * 判据刻意**窄**（只认"交代修改动作"的句子，不是凡含关键词就砍）：
 *   末尾的正文可能自然出现"删""改""核对"等词（如「他删了那行记录」），
 *   所以要求同时满足「位于末尾若干段内」+「像工作说明」+「剥掉后仍留足正文」。
 */
const TRAILING_META_RE = new RegExp([
  // ① 显式的修订说明抬头（最可靠）：--- 修正说明 / 【修订说明】 / 修改说明：
  '(?:^|\\n)\\s*(?:[-—=*#]{2,}\\s*)?(?:【|\\[)?\\s*(?:修正|修改|修订|改动|变更|调整)(?:说明|记录|清单|情况|要点)?\\s*(?:】|\\])?\\s*[:：]',
  // ② 交代"我改了什么"的动作句（要成句，不是单词命中）
  '(?:删去|删除|删掉|已删|保留|仅保留|合并|压缩|扩写|补齐|补写|替换|改写|重写|改回|已与设定库|逐条核对|无冲突|未动|余文|篇幅约|字数约|以上为|共计)\\s*[^\\n]{0,40}(?:字|处|条|段|项|冲突|核对|未动|保留)',
].join('|'), 'm');

/** 末尾剥离时最多看最后几段 —— 修订说明总是在末尾 */
const TRAILING_SCAN_PARAS = 3;

/**
 * 剥掉正文**末尾**的工作笔记（修订说明 / 改动清单）。
 *
 * 与 `stripProsePreamble` 同款保护阀：剥完必须仍留 ≥ `MIN_KEEP` 的正文，否则原样返回
 * （宁可留一段脏说明，也不能把一章正文砍成残章）。
 *
 * @param raw 写作官/校对门的输出
 * @returns 去掉末尾元语言后的正文
 */
export function stripProseTailMeta(raw: string): string {
  const text = String(raw ?? '');
  if (!text.trim()) return text;

  const paras = text.split(/\n\s*\n/);
  let cut = paras.length;   // 保留到第 cut 段（不含）
  let scanned = 0;
  // 从末尾往前，最多看 TRAILING_SCAN_PARAS 段
  while (cut > 1 && scanned < TRAILING_SCAN_PARAS) {
    const p = paras[cut - 1]!.trim();
    scanned++;
    if (!p) { cut--; continue; }
    if (!TRAILING_META_RE.test(p)) break;
    cut--;
  }
  if (cut === paras.length) return text;

  const kept = paras.slice(0, cut).join('\n\n').replace(/\s+$/, '');
  // 保护阀：与开头版一致
  return countProseChars(kept) >= countProseChars(text) * MIN_KEEP && countProseChars(kept) > 0
    ? kept
    : text;
}

/**
 * 落库前的正文净化：**开头 + 末尾**都剥。
 *
 * 单独暴露这个函数，是为了让调用方（`orchestrator` 的交付边界）**只有一个入口**，
 * 不至于哪天只调了开头版、忘了末尾版 —— 那次实测就是这么漏的。
 */
export function sanitizeProseForDelivery(raw: string): string {
  return stripProseTailMeta(stripProsePreamble(raw));
}
