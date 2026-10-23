// ============================================================
// 分层记忆 · 水车存储器（**每个智能体各自一台**）
//
// 口径（2026-09-13 作者澄清）：
//   · **记忆方式 = 各智能体独立记忆**（存储与归属）
//   · **水车 = 记忆的迭代方式**（固定斗数 + 循环复用 + 出界压梗概）
//   → 所以水车**不是一层共享记忆**，而是**每个智能体内部各转各的**
//
// 落盘位置：就在该智能体自己的 L2（`agent_memory`，agent_id 必填）——
//   所以"A 的水车 B 读不到"不是靠约定，是靠键空间 + 句柄天然成立。
//
//   key = 'wheel.slots'                 该 agent 的斗位（JSON 数组，斗 1 最新）
//   key = 'wheel.summary.<chapterNo>'   出界一斗压成的一句话（沉进它自己的长期池）
//   key = 'wheel.pending.<chapterNo>'   还没压缩的出界原文（调用方稍后压）
// ============================================================

import type { AgentMemoryHandle } from './agent-memory.js';
import {
  pushChapter, WHEEL_CAPACITY_DEFAULT, type WheelChapter,
} from './waterwheel.js';

const K_SLOTS = 'wheel.slots';
const kSummary = (n: number) => `wheel.summary.${n}`;
const kPending = (n: number) => `wheel.pending.${n}`;

export interface WheelIngestResult {
  /** 落入斗位的章号 */
  ingested: number;
  /** 被挤出的一斗（null = 还没挤出去） */
  evicted: WheelChapter | null;
  /** 出界一斗压成了什么（给了 compress 才有；否则原文挂在 pending 上） */
  summary?: string;
}

export interface OwnWheel {
  /** 读自己的斗位（斗 1 最新） */
  slots(): Promise<WheelChapter[]>;
  /** 舀入一章：幂等（同章号重复舀入不会占两个斗位） */
  ingest(chapter: WheelChapter, opts?: {
    /** 出界一斗的压缩器（通常是模型调用）。不给就把原文挂 pending，绝不静默丢弃 */
    compress?: (chapter: WheelChapter) => Promise<string>;
  }): Promise<WheelIngestResult>;
  /** 渲染成给模型看的文本（斗 1 最新，带章号与故事内时间） */
  render(): Promise<string>;
  /** 这个 agent 自己的长期池（它出界过的章号 → 一句话） */
  summaries(): Promise<Array<{ chapterNo: number; text: string }>>;
}

/**
 * 给某个智能体建一台**它自己的**水车。
 * @param capacity 斗数（默认 1 = 现状：只带最近一章）。★ 每个 agent 可各自设
 */
export function createOwnWheel(
  handle: AgentMemoryHandle,
  capacity: number = WHEEL_CAPACITY_DEFAULT,
): OwnWheel {
  const readSlots = async (): Promise<WheelChapter[]> => {
    const item = await handle.readOwn<WheelChapter[]>(K_SLOTS, 'experience');
    return Array.isArray(item?.value) ? item.value : [];
  };

  return {
    slots: readSlots,

    async ingest(chapter, opts) {
      const current = await readSlots();
      const { slots, evicted } = pushChapter(current, chapter, capacity);
      // 斗位整体右移：直接覆写整份（斗位无稳定身份，逐条 diff 得不偿失）
      await handle.writeOwn({ form: 'experience', key: K_SLOTS, value: slots, sourceRef: `ch${chapter.chapterNo}` });

      if (!evicted) return { ingested: chapter.chapterNo, evicted: null };

      // ★ 出界不等于丢：能压就压成一句话，压不了也要把原文留下来（挂 pending）
      if (opts?.compress) {
        let summary = '';
        try {
          summary = (await opts.compress(evicted)).trim();
        } catch (e) {
          console.warn('[wheel] 出界压缩失败，原文挂 pending:', e);
        }
        if (summary) {
          await handle.writeOwn({ form: 'experience', key: kSummary(evicted.chapterNo), value: summary, sourceRef: `ch${evicted.chapterNo}` });
          return { ingested: chapter.chapterNo, evicted, summary };
        }
      }
      await handle.writeOwn({ form: 'experience', key: kPending(evicted.chapterNo), value: evicted.text, sourceRef: `ch${evicted.chapterNo}` });
      return { ingested: chapter.chapterNo, evicted };
    },

    async render() {
      const slots = await readSlots();
      if (slots.length === 0) return '（水车空）';
      return slots
        .map((s, i) => {
          const t = s.storyTime ? ` · 故事内：${s.storyTime}` : '';
          return `【斗${i + 1}｜第 ${s.chapterNo} 章${t}】\n${s.text}`;
        })
        .join('\n\n');
    },

    async summaries() {
      const items = await handle.listOwn('experience');
      return items
        .filter((i) => i.key.startsWith('wheel.summary.'))
        .map((i) => ({ chapterNo: Number(i.key.slice('wheel.summary.'.length)), text: String(i.value) }))
        .filter((x) => Number.isFinite(x.chapterNo))
        .sort((a, b) => a.chapterNo - b.chapterNo);
    },
  };
}
