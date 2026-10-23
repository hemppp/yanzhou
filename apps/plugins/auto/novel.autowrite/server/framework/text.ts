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
  // ★ 2026-10-23：报错必须**点名截断**。
  //   实测（真机跑第 1 章）：实体沉淀只报 `Expected ',' or '}' after property value
  //   in JSON at position 3847` —— 这是 JSON.parse 的位置信息，看不出「输出被 maxTokens
  //   砍了」。而截断是推理模型下最常见的一种失败（思考 token 也计入上限），
  //   判据也很硬：`extractFirstJson` 返回 null 就代表**括号没配平**，只可能是被砍了。
  //   把这条判据写进消息，下一次谁看到都知道该去调预算，而不是去查 JSON 语法。
  if (start < 0 || end <= start) {
    throw new Error(`输出中未找到 JSON 对象（收到 ${raw.length} 字符，疑似被 maxTokens 截断）：` + raw.slice(0, 120));
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`JSON 未配平（收到 ${raw.length} 字符，疑似被 maxTokens 截断）：${why}`);
  }
}

/** 与 chapter-service 一致的字数口径：剥 HTML 标记后计字符 */
export function countChars(content: string): number {
  return content.replace(/<[^>]+>/g, '').trim().length;
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
