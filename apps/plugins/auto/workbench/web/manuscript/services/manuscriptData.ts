// ============================================================
// manuscript —— 正文章节数据（纯函数，可单测）
//
// ★ 为什么单独一个文件：这一层是「排序 / 统计 / 章号归一」的口径，
//   面板只做渲染。AI 长跑写出来的章节里 order 可能是 1、2、5（缺号）或彼此相等，
//   口径写错（比如拿数组下标当章号）在界面上极难发现 —— 抽出来单测钉死。
// ============================================================

/** 章节接口返回的最小形状（只取面板用得到的字段；接口图放宽而不收敛） */
export interface ManuscriptChapter {
  id: string;
  /** 章号（后端 1 起；异常数据可能缺号或相等） */
  order: number;
  title: string;
  content: string;
  wordCount: number;
  status?: string;
}

/** 接口地址：列表接口的路径形态固定是 `<entity>/projects/<projectId>`（★ 不是 ?projectId=） */
export const MANUSCRIPT_API_ENTITY = 'chapters';

/** 正文接口响应的形状容错（不同版本见过 `{data:[…]}` / 裸数组 / `{items:[…]}` 三种） */
export function extractChapterArray(raw: unknown): ManuscriptChapter[] {
  const pick = (v: unknown): unknown => (v && typeof v === 'object' && 'data' in (v as Record<string, unknown>)
    ? (v as Record<string, unknown>).data
    : v);
  const candidates: unknown[] = [raw, pick(raw)];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as ManuscriptChapter[];
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      if (Array.isArray(o.items)) return o.items as ManuscriptChapter[];
      if (Array.isArray(o.chapters)) return o.chapters as ManuscriptChapter[];
    }
  }
  return [];
}

/**
 * 按 order 升序排序 —— **不拿数组下标当章号**。
 *
 * order 相等时用 id 兜底比较：排序必须是**确定**的，否则刷新一次目录顺序就变，
 * 作者会以为"章节乱了"。不改原数组（面板可能直接把 store 里的数组传进来）。
 */
export function sortChapters(chapters: readonly ManuscriptChapter[]): ManuscriptChapter[] {
  return [...chapters].sort((a, b) => {
    const d = (a.order || 0) - (b.order || 0);
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
  });
}

export interface ManuscriptStats {
  /** 章数 */
  count: number;
  /** 总字数 */
  totalWords: number;
  /** 平均每章字数（四舍五入；无章节时为 0） */
  avgWords: number;
}

/**
 * 全书统计。
 *
 * ★ 缺 wordCount 的章**按正文实际长度**补算 —— 长跑落库的章偶尔 wordCount 是 0
 *   （写入路径没回填），若直接累加会让"总字数"凭空少掉整章，看起来像丢章。
 *   中文按字符计（与宿主 chapters 的口径一致），英文/标点也按字符算，宁多不少。
 */
export function computeStats(chapters: readonly ManuscriptChapter[]): ManuscriptStats {
  let totalWords = 0;
  for (const c of chapters) {
    totalWords += c.wordCount > 0 ? c.wordCount : countChars(c.content);
  }
  const count = chapters.length;
  return { count, totalWords, avgWords: count > 0 ? Math.round(totalWords / count) : 0 };
}

/** 正文字数：去掉空白后的字符数（空正文记 0，不把换行算成字） */
export function countChars(content: string | undefined): number {
  if (!content) return 0;
  return content.replace(/\s/g, '').length;
}

/** 章号显示：order 缺省或为 0 时退化成一个可读的占位，不显示 "第 0 章" */
export function chapterLabel(order: number): string {
  return order > 0 ? `第 ${order} 章` : '未编号';
}
