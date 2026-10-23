// ============================================================
// 单章闭环 → 流水线事件 的桥接
//
// 为什么单列：pilot（前三章试写）与 production（长跑）**都在跑同一件事** ——
// 调 `runDiscussion` 写一章，然后把它吐出的 `SessionEvent` 翻译成面板认识的
// `PipelineEvent`。这份映射有 10 个分支，抄两遍就等着漂移（改一处漏一处）。
//
// 唯一按阶段不同的只有「阶段名」和「交付时要不要更新游标」——用参数注入，
// 不在这里 if (stage === 'pilot') 分叉。
// ============================================================

import type { SessionEvent } from '../discuss/orchestrator.js';
import type { PipelineEvent, StageKey } from './types.js';

export interface ChapterBridgeResult {
  delivered: boolean;
  wordCount: number;
  warnings: string[];
}

/**
 * 造一个桥接器。
 *
 * @param stage    当前阶段（'pilot' | 'production'），写进每个事件
 * @param order    本章章号（用于文案）
 * @param emit     流水线事件出口
 * @param onDelivered  交付成功时的额外动作（production 用它推进 `cursor.lastDelivered`）。
 *                     放在桥接里而不是让调用方再扫一遍事件流，是因为"交付"只有一个时点。
 */
export function createChapterBridge(opts: {
  stage: StageKey;
  order: number;
  emit: (e: PipelineEvent) => void;
  onDelivered?: (d: { order: number; wordCount: number; warnings: string[] }) => void;
}): { bridge: (e: SessionEvent) => void; result: () => ChapterBridgeResult } {
  const { stage, order, emit, onDelivered } = opts;
  const state: ChapterBridgeResult = { delivered: false, wordCount: 0, warnings: [] };

  const bridge = (e: SessionEvent): void => {
    switch (e.type) {
      case 'phase':
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章 · ${e.label}` });
        break;
      case 'turn':
        emit({ type: 'stage_turn', stage, agent: e.agent, name: e.name, color: e.color, short: e.short, text: e.text, ...(e.meta ? { meta: e.meta } : {}) });
        break;
      case 'conclusion':
        // 本章结论走交流流展示（它不在流水线状态里，但作者需要看得到）
        emit({ type: 'stage_turn', stage, agent: 'chapter-conclusion', name: `第 ${order} 章结论`, color: '#6B7280', short: '结', text: e.text });
        break;
      case 'draft':
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章正文已出（第 ${e.revision} 稿）` });
        break;
      case 'review':
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章意图门：${e.passed ? '通过' : `打回（第 ${e.attempt} 次）`}` });
        break;
      case 'gate':
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章${e.name === 'check' ? '校对门' : '润色门'}：${e.passed ? '通过' : '未通过'}${e.score !== undefined ? `（${e.score} 分）` : ''}` });
        break;
      case 'delivered':
        state.delivered = true;
        state.wordCount = e.wordCount;
        if (e.warnings?.length) state.warnings.push(...e.warnings);
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章已交付（${e.wordCount} 字）` });
        onDelivered?.({ order, wordCount: e.wordCount, warnings: e.warnings ?? [] });
        break;
      case 'deliver_blocked':
        state.warnings.push(`未交付：${e.reason}`);
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章未交付：${e.reason}` });
        break;
      case 'entities':
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章实体沉淀：新增 ${e.created} / 更新 ${e.updated}` });
        break;
      case 'error':
        state.warnings.push(e.message);
        emit({ type: 'stage_phase', stage, label: `第 ${order} 章出错：${e.message}` });
        break;
      default:
        break;
    }
  };

  return { bridge, result: () => state };
}
