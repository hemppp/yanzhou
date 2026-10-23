// ============================================================
// 多智能体协作流水线 —— 前端客户端
//
// 对接插件路由（设计见 docs/architecture/ai-writing-multiagent-pipeline.md）：
//   GET  /api/plugins/autowrite/pipeline           读状态
//   POST /api/plugins/autowrite/pipeline/start     启动 / 续跑
//   POST /api/plugins/autowrite/pipeline/advance   跑一段（SSE）
//   POST /api/plugins/autowrite/pipeline/decision  闸门决策
//
// ★ 推进走 SSE、决策走普通 POST：需要用户输入的东西绝不放长连接里等 ——
//   连接一断状态就悬空，刷新页面更说不清「我到底批没批」。
// ============================================================

import { apiClient, getToken, getCurrentProjectId } from '@novel-plugins/data-core/api/apiClient';
import { resolveApiUrl } from '@novel-plugins/data-core/api/apiClient';
import { forEachSSEDataLine } from '../../discuss/services/sseStream';

export type StageKey = 'brief' | 'cast' | 'bible' | 'plot' | 'drift' | 'pilot' | 'production';
export type StageStatus = 'idle' | 'running' | 'awaiting_user' | 'approved' | 'failed';
export type DecisionAction = 'approve' | 'revise' | 'reject';

export interface PipelineStageView {
  key: StageKey;
  label: string;
  status: StageStatus;
  /** 被打回 / 退回的次数 */
  revision: number;
  /** 这一段有没有用户闸门（决定要不要弹审批卡） */
  gated: boolean;
  /** 这一段是否已实现（未实现的只展示，不给跑） */
  implemented: boolean;
  /** 契约文本（人可读） */
  artifact?: string;
  /** drift：逐条核查统计（UI 上把"核了几条"显出来） */
  driftCounts?: { total: number; 符合: number; 偏离: number; 库中无依据: number; hard: number; soft: number };
  /** pilot：试写的三章交付情况（`delivered=false` 要显眼） */
  pilotChapters?: Array<{ order: number; delivered: boolean; wordCount: number; warnings: string[] }>;
  /** pilot：跨章审阅判定 */
  premiereVerdict?: { verdict: 'pass' | 'minor' | 'major'; issues: number; kinds: string[] };
  /** production：本轮长跑的章节交付情况 */
  productionChapters?: Array<{ order: number; delivered: boolean; wordCount: number; warnings: string[] }>;
  /** production：本轮监工结论 */
  supervisorVerdict?: { order: number; verdict: 'ok' | 'watch' | 'halt'; issues: number };
  /** production：是否因监工 halt 停下 */
  supervisorHalted?: boolean;
  error?: string;
}

/** 轨迹确认记录（production 每 N 章一条） */
export interface PipelineTrackEntry {
  from: number;
  to: number;
  at: number;
  by: string;
  verdict: 'on_track' | 'minor_drift' | 'major_drift';
  note: string;
  patch?: string;
}

export interface PipelineDecisionEntry {
  stage: StageKey;
  at: number;
  by: string;
  action: DecisionAction;
  note?: string;
}

export interface PipelineView {
  projectId: string;
  stage: StageKey;
  stageLabel: string;
  briefHash: string;
  /** 开书设定改过 → 已批准但基于旧基线的阶段（UI 要提醒"建议重跑"） */
  staleStages: StageKey[];
  stages: PipelineStageView[];
  decisions: PipelineDecisionEntry[];
  /** 轨迹确认台账（倒序）—— production 每 N 章一条 */
  tracks?: PipelineTrackEntry[];
  reviewEvery: number;
  /** 已交付的最后一章（长跑从它的下一章接） */
  lastDelivered: number;
  updatedAt: number;
}

export interface PipelineStatus {
  started: boolean;
  hasBrief: boolean;
  view: PipelineView | null;
}

export interface SinkStats {
  characters: { created: number; updated: number };
  outline: number;
  foreshadows: number;
  skipped: number;
  notes: string[];
}

export interface DecisionResult {
  view: PipelineView;
  movedTo: StageKey | null;
  invalidated: StageKey[];
  stats: SinkStats | null;
  revisionLimit: number;
  /** 撞上修订上限：把选择交回作者（按现状继续 / 放弃这段） */
  hitRevisionLimit: boolean;
}

/** SSE 事件（与后端 pipeline/types.ts 的 PipelineEvent 一一对应） */
export type PipelineEvent =
  | { type: 'stage_start'; stage: StageKey; revision: number }
  | { type: 'stage_phase'; stage: StageKey; label: string }
  | {
      type: 'stage_turn';
      stage: StageKey;
      agent: string;
      name: string;
      color: string;
      short: string;
      text: string;
      meta?: string;
    }
  | { type: 'stage_summary'; stage: StageKey; text: string }
  /** 无闸门阶段跑完自动过（当前是 drift） */
  | { type: 'stage_auto_approved'; stage: StageKey; summary: string }
  /** 偏离核查发现硬偏离：游标已退回需要回修的那一段 */
  | { type: 'stage_drift_blocked'; stage: StageKey; backTo: StageKey; message: string; hard: number; soft: number }
  /** pilot：第 i/3 章开写 / 写完（done 带该章是否落库与字数） */
  | {
      type: 'pilot_chapter';
      index: number;
      total: number;
      order: number;
      phase: 'start' | 'done';
      delivered?: boolean;
      wordCount?: number;
      warnings?: string[];
    }
  /** pilot：跨章审阅结论（原文给作者看） */
  | { type: 'premiere_review'; text: string; verdict: 'pass' | 'minor' | 'major'; issues: number }
  /** production：第 i/N 章开写 / 写完（done 带该章是否落库、字数、全书游标） */
  | {
      type: 'production_chapter';
      index: number;
      total: number;
      order: number;
      phase: 'start' | 'done';
      delivered?: boolean;
      wordCount?: number;
      warnings?: string[];
      cursor?: number;
    }
  /** production：单章监工报告 */
  | { type: 'supervise_report'; order: number; verdict: 'ok' | 'watch' | 'halt'; issues: string[]; trend: string }
  /** production：每 N 章一次轨迹确认 */
  | { type: 'track_review'; from: number; to: number; verdict: 'on_track' | 'minor_drift' | 'major_drift'; note: string }
  | { type: 'awaiting_user'; stage: StageKey; summary: string; revision: number; revisionLimit: number }
  | { type: 'stage_sinked'; stage: StageKey; stats: SinkStats }
  | { type: 'stage_skipped'; stage: StageKey; reason: string }
  | { type: 'stage_failed'; stage: StageKey; message: string }
  | { type: 'baseline_changed'; from: string; to: string; stale: StageKey[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * ★ 两个 base 不能混用（2026-10-14 UI 实测修正）：
 *   - `API_PATH` 给 apiClient —— 它自己会补 baseUrl，**必须传相对路径**；
 *     传绝对 URL 会拼成 `http://host/api/http://host/api/…`（实测 404）。
 *   - `RAW_BASE` 给裸 fetch（SSE 要自己读流，走不了 apiClient），必须是完整 URL。
 *
 *   ⚠️ 此前的写法是 `const API_BASE = resolveApiUrl(...); const RAW_BASE = API_BASE;`
 *      —— 两个常量被赋了**同一个绝对 URL**，于是三个 apiClient 调用全部双重前缀：
 *      流水线看板一打开就 404（`GET /api/http://localhost:3774/api/plugins/autowrite/pipeline`）。
 *      注释当时已点明「两个 base 不能混用」，但赋值时又混用了。
 */
/** apiClient 用的相对路径（baseUrl 由 apiClient 自己补） */
const API_PATH = 'plugins/autowrite/pipeline';
/** 裸 fetch 用的完整 URL（由 data-core 的 resolveApiUrl 决定 base，不硬编码 '/api'） */
const RAW_BASE = resolveApiUrl(API_PATH);

export async function fetchPipeline(): Promise<PipelineStatus> {
  return apiClient.get<PipelineStatus>(API_PATH);
}

export async function startPipeline(note?: string): Promise<{ view: PipelineView; baselineMismatch: boolean }> {
  return apiClient.post<{ view: PipelineView; baselineMismatch: boolean }>(`${API_PATH}/start`, { note });
}

/**
 * 闸门决策。
 *
 * ★ `approve` 在服务端是**同步跑一次模型抽取**（把契约文本抽成结构化记录再落库），
 *   实测耗时可超过 10 秒 —— 用默认 8 秒超时会得到「请求超时」，而服务端其实已经批完了
 *   （界面卡在上一步，按钮永远不出现；GUI 全流程跑出来了）。所以这里必须给足超时。
 */
export async function decidePipeline(
  stage: StageKey,
  action: DecisionAction,
  note?: string,
): Promise<DecisionResult> {
  return apiClient.post<DecisionResult>(
    `${API_PATH}/decision`,
    { stage, action, note },
    { timeoutMs: 180_000 },
  );
}

/**
 * 跑一个阶段（SSE）。
 *
 * 走裸 fetch —— SSE 要自己读流，而 apiClient 会把响应体整个吞掉。
 * ★ 所以要手动补 X-Project-Id：后端缺这个头直接 400。
 */
export async function runPipelineStage(
  stage: StageKey,
  opts: { extra?: string; signal?: AbortSignal } = {},
  onEvent: (e: PipelineEvent) => void,
): Promise<void> {
  const token = getToken();
  const projectId = getCurrentProjectId();
  const resp = await fetch(`${RAW_BASE}/advance`, {
    method: 'POST',
    credentials: 'include', // 会话走 HttpOnly Cookie
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(projectId ? { 'X-Project-Id': projectId } : {}),
    },
    body: JSON.stringify({ stage, extra: opts.extra }),
    signal: opts.signal,
  });

  if (!resp.ok || !resp.body) {
    // 错误体是信封 { error: { code, message } }（apiClient 同款约定），把 message 抬出来
    let detail = `HTTP ${resp.status}`;
    try {
      const j = (await resp.json()) as { error?: string | { message?: string } };
      if (typeof j?.error === 'string') detail = j.error;
      else if (j?.error?.message) detail = j.error.message;
    } catch {
      // 非 JSON：保留状态码
    }
    throw new Error(detail);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handleBlock = (block: string) => {
    forEachSSEDataLine(block, (dataStr) => {
      try {
        onEvent(JSON.parse(dataStr) as PipelineEvent);
      } catch {
        // 单行解析失败不中断整条流
      }
    });
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        handleBlock(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    buffer += decoder.decode();
    handleBlock(buffer);
  } finally {
    reader.releaseLock?.();
  }
}
