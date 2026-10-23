// ============================================================
// 设计讨论会话 —— 前端 SSE 客户端
//
// 对接插件路由 POST /api/plugins/autowrite/session。
// 与 /api/ai/chat-stream 不同：那边是「一个代理逐字说话」，
// 这边是「多个角色各说一段」—— 所以事件里带 agent 身份，不是裸 chunk。
//
// 事件：
//   { type:'phase', label }      正在做什么（显示在输入框上方）
//   { type:'thinking', ... }     某角色正在推理：思维链增量（逐片、实时；非推理模型没有）
//   { type:'turn', agent, ... }  某个角色的完整发言（带本次发言的整段思维链）
//   { type:'conclusion', text }  收敛出的本章结论
//   { type:'error' | 'done' }
// ============================================================

import { getToken, getCurrentProjectId } from '@novel-plugins/data-core/api/apiClient';
import { resolveApiUrl } from '@novel-plugins/data-core/api/apiClient';
import { forEachSSEDataLine } from '../../discuss/services/sseStream';

export interface SessionTurn {
  type: 'turn';
  agent: string;
  name: string;
  color: string;
  short: string;
  text: string;
  meta?: string;
  /** 本次发言的完整思维链（推理型模型的 reasoning_content），没有则 undefined */
  thinking?: string;
}

export type SessionEvent =
  | { type: 'phase'; label: string }
  /**
   * 思维链增量：实时逐片到达，同一次发言可能几十到上千条。
   * **非推理模型 / 中转站剥了该字段时一条都不会有**，前端要按「可能没有」处理。
   */
  | { type: 'thinking'; agent: string; name: string; short: string; color: string; delta: string }
  | SessionTurn
  | { type: 'conclusion'; text: string }
  /** 写作官产出的本章正文 —— 落在正文方块里；revision 0 = 初稿，≥1 = 第 N 次重写 */
  | { type: 'draft'; text: string; revision: number }
  /** 意图复核结论（对照本章结论验收） */
  | { type: 'review'; text: string; attempt: number; passed: boolean }
  /**
   * 校对门 / 润色门结论（见后端 framework/gates.ts）：
   *   check  —— 硬门（全文 × 设定库）。passed=false 只做一次定向修订，之后仍会交付，
   *             所以这里收到 false 不代表本章没交出去。
   *   polish —— 软门评分（0–10，7 为通过线），从不阻塞交付。
   */
  | {
      type: 'gate'; name: 'check' | 'polish'; passed: boolean; detail: string; score?: number;
      /** ★ true = 这一步**根本没执行**（模型调用/解析失败），与"通过"必须区分显示 */
      skipped?: boolean;
    }
  /** 交付成功：正文已写入章节。warnings 非空 = 交付了但有需人工复核之处（如意图门未过） */
  | { type: 'delivered'; order: number; title: string; wordCount: number; created: boolean; warnings?: string[] }
  /** 交付被拦：多为「该章已有正文，不自动覆盖」，或「没认出章号」 */
  | { type: 'deliver_blocked'; order: number; title: string; reason: string }
  /** 实体沉淀：交付后写入项目库的角色/物品/地点/伏笔条数 */
  | { type: 'entities'; created: number; updated: number; skipped: number; notes: string[] }
  /** 连写模式：一章开始（前端据此分段并重置本轮的结论/正文/阶段状态） */
  | { type: 'chapter_start'; order: number; index: number; total: number }
  /** 连写模式：一章收尾（不论是否交付成功都会发） */
  | { type: 'chapter_done'; order: number; index: number; total: number; delivered: boolean }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * 跑一轮设计讨论。
 * @param message 作者这一轮说的话
 * @param opts.chapterCount 连写章数（1 = 单章）。>1 时后端逐章跑完整闭环，
 *        后续章由后端自动「接着上一章往下写」—— 不要在这里自己拼 N 条指令。
 * @param onEvent 每个 SSE 事件的回调（角色发言是**整段**到达的，不是逐字）
 */
export async function runSession(
  message: string,
  opts: { chapterOrder?: number; chapterCount?: number; signal?: AbortSignal } = {},
  onEvent: (e: SessionEvent) => void,
): Promise<void> {
  const token = getToken();
  // ★ 这里走裸 fetch（SSE 需要自己读流），不经过 apiClient，
  //   所以要手动补它平时自动注入的 X-Project-Id —— 后端缺这个头会直接 400。
  const projectId = getCurrentProjectId();
  const resp = await fetch(resolveApiUrl('plugins/autowrite/session'), {
    method: 'POST',
    credentials: 'include', // 会话走 HttpOnly Cookie
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(projectId ? { 'X-Project-Id': projectId } : {}),
    },
    body: JSON.stringify({ message, chapterOrder: opts.chapterOrder, chapterCount: opts.chapterCount }),
    signal: opts.signal,
  });

  if (!resp.ok || !resp.body) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = (await resp.json()) as { error?: string | { message?: string } };
      if (j?.error) detail = typeof j.error === 'string' ? j.error : (j.error.message ?? detail);
    } catch {
      // 非 JSON 响应，保留 HTTP 状态码
    }
    throw new Error(detail);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleBlock = (block: string) => {
    forEachSSEDataLine(block, (dataStr) => {
      try {
        onEvent(JSON.parse(dataStr) as SessionEvent);
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
    // 最后一条事件可能没有尾部空行
    buffer += decoder.decode();
    handleBlock(buffer);
  } finally {
    reader.releaseLock?.();
  }
}
