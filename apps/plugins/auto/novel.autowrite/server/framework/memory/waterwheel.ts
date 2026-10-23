// ============================================================
// 分层记忆 · L1-N 叙事式的「灌溉水车」
//
// 这是《docs/architecture/ai-writing-architecture.md §6》那台水车的**落地实现**，
// 也是本架构里 **L1 叙事式的唯一写入通道**（读+写都在这一处）。
//
// 关键不是"会动"，是**斗数固定 + 循环复用**：
//   舀（低处）：**只在定稿交付时** —— 写作中的半成品不许占斗位，否则记忆被草稿污染
//   倒（高处）：最早一斗出界 → 压成一句话梗概（原文留在蓄水池，倒掉不等于丢）
//   斗位序号本身就是相对时间戳：斗 1 永远最新
//
// ★ 容量是可配的：默认 1 斗 = 现状（只带上一章全文）。
//   要不要扩到 3 斗是个**成本决策**（每轮多带约 2 章全文 × 每章 10+ 次模型调用），
//   所以这里只把机制铺好，容量留给调用方/配置决定。
// ============================================================

/**
 * 默认斗数。
 * 2026-09-13：作者拍板从 1 扩到 **3** —— 记忆迭代时能回看最近三章，
 * 代价是**每个角色每轮多带约 2 章全文**（故 §5.3 的篇幅上限是必须的，不是可选项）。
 * ★ 这是**每个智能体各自**的容量（水车是迭代方式，不是共享记忆）。
 */
export const WHEEL_CAPACITY_DEFAULT = 3;

/**
 * 注入时给"水车"的总字数上限。
 * 为什么必须有：扩到 3 斗后，若三章都很长（每章上限 6000 字），一次注入可达 18000 字，
 * 乘以每轮的多个角色，上下文会被吃掉一大块。策略：**斗 1 保证完整**，
 * 之后从新到旧往里加，加不下就停并**明确写"已省略"** —— 别让模型以为"没有前情"。
 */
export const WHEEL_MAX_CHARS = 12000;

export interface WheelChapter {
  /** 逻辑时间：章号 */
  chapterNo: number;
  /** 本章正文（舀进来的"水"） */
  text: string;
  /** 真实时间：入斗时间戳（新鲜度与审计） */
  ingestedAt: number;
  /** 故事内时间（第三个时间戳）—— 章节号与故事时间不是一回事，跳跃叙事必错 */
  storyTime?: string;
}

export interface WheelPushResult {
  /** 新斗位（最新在前） */
  slots: WheelChapter[];
  /** 出界的斗（要压成梗概的那个） */
  evicted: WheelChapter | null;
}

/**
 * 舀一章（纯函数，便于单测）：
 * 新章插到最前，超出容量则把**最老一斗**挤出（由调用方去压梗概）。
 */
export function pushChapter(
  slots: readonly WheelChapter[],
  chapter: WheelChapter,
  capacity: number = WHEEL_CAPACITY_DEFAULT,
): WheelPushResult {
  const cap = Math.max(1, Math.floor(capacity));
  // 同一章重复舀入：先摘掉旧的（幂等，避免重复占斗位）
  const rest = slots.filter((s) => s.chapterNo !== chapter.chapterNo);
  const next = [chapter, ...rest];
  const evicted = next.length > cap ? next[cap] ?? null : null;
  return { slots: next.slice(0, cap), evicted };
}

/** 把斗位渲染成给模型看的文本（斗 1 最新，带章号与故事时间） */
export function renderWheel(slots: readonly WheelChapter[]): string {
  if (slots.length === 0) return '（水车空）';
  return slots
    .map((s, i) => {
      const time = s.storyTime ? ` · 故事内：${s.storyTime}` : '';
      return `【斗${i + 1}｜第 ${s.chapterNo} 章${time}】\n${s.text}`;
    })
    .join('\n\n');
}

/** 出界一斗压成一句话梗概用的提示词片段（真正的压缩由模型做） */
export function evictPrompt(chapter: WheelChapter): string {
  return `把下面这一章压成**一句话**梗概（只留主线结果与状态变化，不要文采）：\n\n${chapter.text}`;
}


/**
 * 带篇幅预算地渲染水车：斗 1 一定完整，之后从新到旧加，超预算就停并标注省略。
 * 返回文本与"实际装了几个斗"，便于调用方记账/日志。
 */
export function renderWheelWithin(
  slots: readonly WheelChapter[],
  maxChars: number = WHEEL_MAX_CHARS,
): { text: string; included: number; omitted: number } {
  if (slots.length === 0) return { text: '（水车空）', included: 0, omitted: 0 };
  const blocks: string[] = [];
  let used = 0;
  let included = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const time = s.storyTime ? ` · 故事内：${s.storyTime}` : '';
    const head = `【斗${i + 1}｜第 ${s.chapterNo} 章${time}】`;
    const body = s.text;
    // 斗 1 无条件收（否则"没有前情"是假信息）；其余按预算
    if (i > 0 && used + head.length + body.length > maxChars) break;
    blocks.push(`${head}\n${body}`);
    used += head.length + body.length;
    included += 1;
  }
  const omitted = slots.length - included;
  if (omitted > 0) blocks.push(`（更早的 ${omitted} 个斗位因篇幅省略；需要细节请按需回读对应章节）`);
  return { text: blocks.join('\n\n'), included, omitted };
}
