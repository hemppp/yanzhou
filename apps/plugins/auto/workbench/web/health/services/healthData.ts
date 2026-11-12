// ============================================================
// health —— 章节体检的数据层（纯函数，可单测）
//
// ★ 判据**不在这里**：篇幅带、对话阈值、重复阈值全部由服务端
//   `novel.autowrite/server/discuss/chapter-health.ts` 用现役判据算出，
//   本文件只做**展示口径**（分段、计数、排序、状态聚合）。
//
//   为什么刻意不把阈值挪到前端：那会造出第二套真相 ——
//   界面上"合格"的章、流水线却打回，是最难解释的一种不一致。
//   这里只消费 `band`（服务端给的区间）做显示，自己不定义任何数字。
// ============================================================

/** 服务端 `/chapters/health` 返回的一行（与 ChapterHealthRow 对齐） */
export interface HealthRow {
  order: number;
  title: string;
  status: string;
  chars: number;
  length: 'low' | 'high' | 'ok';
  dialogueRatio: number;
  dialogueLow: boolean;
  dialogueHigh: boolean;
  dialogueFragmented: boolean;
  /** 明细数字（展示用） */
  intraDup: number;
  crossDup: number;
  /** **判定**（与流水线同一阈值；明细为 0 或未达线时为 false） */
  intraDupExcessive: boolean;
  crossDupExcessive: boolean;
  flagged: boolean;
}

export interface HealthSummary {
  count: number;
  totalChars: number;
  avgChars: number;
  outOfBand: number;
  dialogueLow: number;
  dialogueHigh: number;
  dialogueFragmented: number;
  intraDup: number;
  crossDup: number;
  clean: number;
}

export interface HealthReport {
  projectId: string;
  band: { min: number; max: number; target: number };
  /** 对话占比上下限（服务端现役常量） */
  dialogue: { floor: number; ceiling: number };
  chapters: HealthRow[];
  summary: HealthSummary;
}

/** 一行体检问题里最该先看的那一项（用于表格上的标签与配色） */
export type HealthIssue = 'length-low' | 'length-high' | 'dialogue-low' | 'dialogue-high'
  | 'dialogue-fragmented' | 'dup' | 'none';

/**
 * 取「首要问题」。
 *
 * 顺序按**作者在意的程度**排：篇幅出带是硬伤（不能定稿）→ 重复（会读出来）
 * → 对话形态。同章多项时只报最重的一条，避免一格塞四个标签反而看不清。
 */
export function primaryIssue(r: HealthRow): HealthIssue {
  if (r.length === 'low') return 'length-low';
  if (r.length === 'high') return 'length-high';
  // ★ 用 excessive 而不是明细 >0 —— 判定必须与流水线同源（见 chapter-health.ts 的说明）
  if (r.intraDupExcessive || r.crossDupExcessive) return 'dup';
  if (r.dialogueLow) return 'dialogue-low';
  if (r.dialogueHigh) return 'dialogue-high';
  if (r.dialogueFragmented) return 'dialogue-fragmented';
  return 'none';
}

/**
 * 问题标签。
 *
 * ★ severity 分三档，但**不靠颜色**——本设计系统是水墨灰阶：
 *   `--destructive`、`--cinnabar`、`--state-done` 全是灰（实测：
 *   destructive = 0 0% 16%、cinnabar = 0 0% 18%）。用颜色表达严重度在这里**必然失效**，
 *   三档会渲染成三个几乎一样的灰。
 *
 *   所以严重度走**结构**：hard = 实心墨块，soft = 淡墨底，ok = 只描边。
 *   实心/描边在单色下是无歧义的，且与水墨语汇一致（墨越重，越是"定论"）。
 *
 *   hard 的判据是"这条会挡住定稿"（篇幅出带、重复超线）；
 *   soft 是"读起来有瑕疵但不拦交付"（对话形态）。与流水线的软硬门一致。
 */
export const ISSUE_LABEL: Record<HealthIssue, { text: string; severity: 'hard' | 'soft' | 'ok' }> = {
  'length-low': { text: '篇幅偏短', severity: 'hard' },
  'length-high': { text: '篇幅超长', severity: 'hard' },
  dup: { text: '重复', severity: 'hard' },
  'dialogue-low': { text: '对话过少', severity: 'soft' },
  'dialogue-high': { text: '对话过多', severity: 'soft' },
  'dialogue-fragmented': { text: '对话太碎', severity: 'soft' },
  none: { text: '合格', severity: 'ok' },
};

/**
 * 把服务端响应的形状容错成 HealthReport。
 * 容忍 `{data:…}` / 裸对象两种（章节接口那边见过同类差异）。
 */
export function extractHealthReport(raw: unknown): HealthReport | null {
  const pick = (v: unknown): unknown => (
    v && typeof v === 'object' && 'data' in (v as Record<string, unknown>)
      ? (v as Record<string, unknown>).data
      : v
  );
  for (const c of [raw, pick(raw)]) {
    if (c && typeof c === 'object' && Array.isArray((c as HealthReport).chapters)) {
      return c as HealthReport;
    }
  }
  return null;
}

/** 千分位：长篇动辄十万字，裸数字看不出量级 */
export function fmtNum(n: number): string {
  return Number(n || 0).toLocaleString('zh-CN');
}

/** 占比转百分比整数（0.153 → 15） */
export function fmtPct(ratio: number): number {
  return Math.round((ratio || 0) * 100);
}

/**
 * 篇幅在带内 -> 位置百分比（0–100），用于画一条"落在区间哪一段"的微条。
 * 带宽为 0（不该发生）时返回 0，避免除零。
 */
export function bandPosition(chars: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(100, ((chars - min) / span) * 100));
}

/* ============================================================
 * 主页用的派生分组
 *
 * ★ 分组口径必须与 `primaryIssue()` 一致：
 *   先看篇幅（硬门），再看对话（软门）。否则会出现"图上标红、清单里却在对话栏"。
 * ============================================================ */

export interface HealthGroups {
  /** 全部达标 */
  ok: HealthRow[];
  /** 篇幅欠下限 */
  short: HealthRow[];
  /** 篇幅超上限 */
  long: HealthRow[];
  /** 篇幅在带内、但对话形态不达标 —— 与 short/long 不重叠 */
  dialogueOnly: HealthRow[];
  /** 有重复明细的章（未必达打回线） */
  dup: HealthRow[];
}

export function groupHealth(chapters: readonly HealthRow[]): HealthGroups {
  return {
    ok: chapters.filter((c) => !c.flagged),
    short: chapters.filter((c) => c.length === 'low'),
    long: chapters.filter((c) => c.length === 'high'),
    dialogueOnly: chapters.filter(
      (c) => c.length === 'ok' && (c.dialogueLow || c.dialogueHigh || c.dialogueFragmented),
    ),
    dup: chapters.filter((c) => c.intraDup > 0 || c.crossDup > 0),
  };
}

/** 判词的一段：`emph` 的片段带强调（下划线 + 朱砂），其余是普通叙述 */
export interface VerdictSegment {
  text: string;
  emph?: boolean;
  /** 片段之间是否需要逗号分隔（标点跟着片段走，避免渲染时拼错） */
  sep?: string;
}

/**
 * 一句判词（主页顶部那句白话），拆成**片段**返回。
 *
 * ★ 为什么不是一整句字符串：设计上只给关键数字加下划线与朱砂。
 *   最初实现是把整句塞进一个 `<strong>`，结果下划线从头划到尾 ——
 *   像链接，也盖住了停顿。片段化之后，强调范围由数据决定，渲染层只管上样式。
 *
 * 拆成纯函数同样是为了**可测**：这句话是全页最先被读到的，
 * 说错一个数字比图表画歪更容易误导。
 */
export function verdictSegments(
  g: HealthGroups,
  min: number,
  floorPct: number,
): { head: VerdictSegment[]; tail: VerdictSegment[] } {
  const need = g.short.length + g.long.length + g.dialogueOnly.length;
  const head: VerdictSegment[] = [{ text: `${need} 章需要动一次手：` }];

  const items: VerdictSegment[] = [];
  if (g.short.length) items.push({ text: `${g.short.length} 章还没写到 ${min} 字`, emph: true });
  if (g.long.length) items.push({ text: `${g.long.length} 章超出了上限`, emph: true });
  if (g.dialogueOnly.length) {
    items.push({ text: `另有 ${g.dialogueOnly.length} 章对话占比低于 ${floorPct}%`, emph: true });
  }

  // 标点单独成段：拼进强调片段会让下划线一直划到逗号上，也污染断言
  items.forEach((it, i) => {
    if (i > 0) head.push({ text: '，' });
    head.push(it);
  });
  head.push({ text: '。' });

  const tail: VerdictSegment[] = [{
    text: g.dup.length > 0
      ? `有 ${g.dup.length} 章出现跨章重复，但都没到打回线，图上仍算合格。`
      : '重复一路是干净的 —— 全书没有一处章内或跨章复写。',
  }];
  return { head, tail };
}

/**
 * 重复明细的条数区间，如「各 1–2 条」。
 *
 * 直接 join 每章条数会写出「2–1–1 条」这种读不成句的东西 ——
 * 读者要的是"每条章大概几条重复"，不是逐章回放。
 */
export function dupCountRange(rows: readonly HealthRow[]): string {
  if (rows.length === 0) return '';
  const counts = rows.map((r) => r.crossDup + r.intraDup);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return min === max ? `各 ${min} 条` : `各 ${min}–${max} 条`;
}

/** 纯文本版（日志 / 测试 / 无障碍标签用） */
export function verdictSentence(g: HealthGroups, min: number, floorPct: number): string {
  const { head, tail } = verdictSegments(g, min, floorPct);
  return [...head, ...tail].map((s) => s.text).join('');
}