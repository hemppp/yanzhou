// ============================================================
// ⚠ 已移交（留档）—— AI 对话面板（原 auto 模块 · 手写台右栏）
//
// ★ 隔离改造：本实现的产品归属已**移交手写台**：
//     apps/plugins/manual/workbench/web/ai/AiChatPanel.tsx（manual 模块 · modes ['manual']）
//   注册点随之一并移交：`apps/plugins/manual/workbench/web/index.tsx`（key='ai-chat'）。
//   为什么必须移交：手写台的右栏 UI 不应由 AI 写作（auto）模块提供 —— 既跨模块
//   （manual 的使用面依赖 auto 包在场），又让同一个 panel key 出现两个注册者
//   （`byKey.set` 后写覆盖、无告警 ⇒ 谁生效取决于 glob 挂载顺序）。
//
//   本文件在仓内**已无任何产品引用**（`apps/plugins/auto/workbench/web/index.tsx`
//   不再 import 它）。保留的唯一原因是本仓当前没有删除文件的能力；
//   待有 shell 时请连同 `web/ai/sse.ts`、`web/ai/__tests__/sse.test.ts` 一并删除。
//
// t3 ② 契约：消息列表（AI 消息带 agent 名 / 用户消息浅灰底块）
//   + 底部输入（占位「问点什么...」、Enter 发送 / Shift+Enter 换行）
//   + **真实**流式追加 + 滚动区自动到底。
//
// ★ 端点是 `/ai/chat-stream`（SSE，apps/server/src/modules/ai.ts:745），
//   不是 `/ai/chat` —— 后者返回完整 JSON（styleService.ts:182 在用），
//   不能满足「流式增量显示」。两者同源同 schema，只是响应形态不同。
//
// ★ 鉴权与 apiClient 同口径（apiClient.ts:264-277）：
//   Cookie（credentials:'include'）+ Authorization: Bearer + X-Project-Id。
//   这里手写 fetch 而非走 apiClient，只因为要拿 `res.body` 读流；
//   resolveApiUrl 复用同一个 base 推导（保住 /api 前缀）。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import { PromptBar, StreamingText } from '@novel-plugins/ui-kit';
import { useChapterStore, useProjectStore } from '@novel-plugins/data-core/stores';
import {
  getCurrentProjectId,
  getToken,
  resolveApiUrl,
} from '@novel-plugins/data-core/api/apiClient';
import { readSseStream } from './sse';

/** SSE `agent` 帧（服务端最小增量下发；缺省时用 DEFAULT_AGENT 兜底） */
export interface ChatAgentMeta {
  id: string;
  name: string;
  short?: string;
  color?: string;
  mode?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思考过程（服务端 `{thinking}` 帧；与正文分开展示，不混进消息体） */
  thinking: string;
  /** 本轮调用过的工具名（服务端 `{tool_call}` 帧） */
  tools: string[];
  agent: ChatAgentMeta;
  status: 'streaming' | 'done' | 'error';
  error?: string;
}

/**
 * 兜底身份：真源是 `apps/server/src/ai/agents/skill-targets.ts` 的 `chat`
 * 条目的 id/name/short/color（'我' / #5B7CFA）—— 这里只做镜像，不新造名字。
 * 有 SSE `agent` 帧时以后端为准。
 */
export const DEFAULT_AGENT: ChatAgentMeta = {
  id: 'chat',
  name: '对话智能体',
  short: '我',
  color: '#5B7CFA',
};

function readAgent(value: unknown): ChatAgentMeta | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  return {
    id: o.id,
    name: o.name,
    short: typeof o.short === 'string' ? o.short : undefined,
    color: typeof o.color === 'string' ? o.color : undefined,
    mode: typeof o.mode === 'string' ? o.mode : undefined,
  };
}

/** `{tool_call}` 只取名字：形状由 provider 决定（provider-factory.ts:86 的 delta），不下钻参数 */
function readToolName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.name === 'string' && o.name) return o.name;
  const fn = o.function;
  if (fn && typeof fn === 'object') {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === 'string' && name) return name;
  }
  return null;
}

export function AiChatPanel() {
  const project = useProjectStore((s) => s.currentProject);
  const chapters = useChapterStore((s) => s.chapters);
  const currentChapterId = useChapterStore((s) => s.currentChapterId);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const currentChapter = useMemo(
    () => chapters.find((c) => c.id === currentChapterId) ?? null,
    [chapters, currentChapterId],
  );

  // 面板头部显示「最近一次回答用的智能体」，空会话时显示默认身份
  const activeAgent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'assistant') return m.agent;
    }
    return DEFAULT_AGENT;
  }, [messages]);

  // 流式追加 → 自动到底（内容每帧都在变，故依赖 messages 整体）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 卸载时掐断在途请求，避免响应回来后 setState 落到已卸载组件
  useEffect(() => () => abortRef.current?.abort(), []);

  const patchLast = useCallback((patch: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      const next = prev.slice();
      next[next.length - 1] = patch(last);
      return next;
    });
  }, []);

  const applyEvent = useCallback(
    (data: Record<string, unknown>) => {
      // ★ 先取成局部 const 再进闭包：属性访问的类型收窄在回调里会失效
      const thinking = typeof data.thinking === 'string' ? data.thinking : '';
      const chunk = typeof data.chunk === 'string' ? data.chunk : '';
      const agent = readAgent(data.agent);
      const toolName = readToolName(data.tool_call);

      if (thinking) patchLast((m) => ({ ...m, thinking: m.thinking + thinking }));
      if (chunk) patchLast((m) => ({ ...m, content: m.content + chunk }));
      if (toolName) {
        patchLast((m) => (m.tools.includes(toolName) ? m : { ...m, tools: [...m.tools, toolName] }));
      }
      if (agent) patchLast((m) => ({ ...m, agent }));
      if (data.error === true || typeof data.error === 'string') {
        const detail =
          typeof data.message === 'string' && data.message ? data.message : '生成失败，请重试';
        patchLast((m) => ({ ...m, status: 'error', error: detail }));
      }
      if (data.done === true) patchLast((m) => ({ ...m, status: 'done' }));
    },
    [patchLast],
  );

  const sendText = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return; // ★ 空输入不发送
      if (streaming) return; // 在途时 PromptBar 已禁用，这里再兜一道

      const userMsg: ChatMessage = {
        id: nanoid(),
        role: 'user',
        content: text,
        thinking: '',
        tools: [],
        agent: DEFAULT_AGENT,
        status: 'done',
      };
      const placeholder: ChatMessage = {
        id: nanoid(),
        role: 'assistant',
        content: '',
        thinking: '',
        tools: [],
        agent: DEFAULT_AGENT,
        status: 'streaming',
      };
      const history = messages
        .filter((m) => m.status !== 'error' && m.content.trim().length > 0)
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg, placeholder]);
      setInput('');
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const projectId = getCurrentProjectId() ?? project?.id ?? null;
        const token = getToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (projectId) headers['X-Project-Id'] = projectId;

        const res = await fetch(resolveApiUrl('/ai/chat-stream'), {
          method: 'POST',
          headers,
          credentials: 'include',
          signal: controller.signal,
          body: JSON.stringify({
            // phase 命中 chatSchema 的 refine 白名单（'小说对话'），
            // 所以这一路请求永远合法；userMessage 仍是必填
            userMessage: text,
            phase: '小说对话',
            conversationHistory: history,
            ...(project?.name ? { projectName: project.name } : {}),
            ...(currentChapter?.title ? { currentChapter: currentChapter.title } : {}),
            ...(projectId ? { projectId } : {}),
          }),
        });

        if (!res.ok) {
          // ★ 失败必须「可见且可解释」：鉴权 /ensureConfig / 限流这三类错误是
          //   HTTP 状态码 + JSON 体（不是 SSE 帧），其中文文案才是用户能照做的
          //   那句话（如「未配置 AI 提供商」「请求过于频繁」），只报 `HTTP 401`
          //   会让用户无从下手。故优先取 body 里的 message/error 文案。
          let detail = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
          try {
            const body: unknown = await res.json();
            if (body && typeof body === 'object') {
              const o = body as { message?: unknown; error?: unknown };
              const msg =
                typeof o.message === 'string' && o.message
                  ? o.message
                  : typeof o.error === 'string' && o.error
                    ? o.error
                    : '';
              if (msg) detail = `${detail} · ${msg}`;
            }
          } catch {
            // 错误体不是 JSON（如网关 HTML 页）——保留状态码文案即可
          }
          throw new Error(detail);
        }
        if (!res.body) throw new Error('响应没有流式主体（res.body 为空）');

        let sawDone = false;
        let sawError = false;
        for await (const frame of readSseStream(res.body)) {
          if (frame.data.done === true) sawDone = true;
          if (frame.data.error === true || typeof frame.data.error === 'string') sawError = true;
          applyEvent(frame.data);
        }
        // 流干净结束但没收到 done:true（代理截断）时也要收敛状态，
        // 否则输入框会一直停在「停止」态、用户再也发不出消息
        if (!sawDone && !sawError) patchLast((m) => ({ ...m, status: 'done' }));
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (aborted) {
          // 用户点「停止」：保留已生成的部分，不算错误
          patchLast((m) => (m.status === 'streaming' ? { ...m, status: 'done' } : m));
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          patchLast((m) => ({ ...m, status: 'error', error: detail }));
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [applyEvent, currentChapter, messages, patchLast, project, streaming],
  );

  const handleSubmit = useCallback(() => {
    void sendText(input);
  }, [input, sendText]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'user') return m.content;
    }
    return '';
  }, [messages]);

  const handleRetry = useCallback(() => {
    if (lastUserText) void sendText(lastUserText);
  }, [lastUserText, sendText]);

  return (
    <div className="h-full flex flex-col font-[Inter,sans-serif]" aria-label="AI 对话面板">
      {/* 面板标题条 —— 与左栏「章节」条同规格
          ★ t6 尺寸对齐参考图：33px（与 dock 组头等高），参考图实测右栏标题条占应用区
          y31..63（原 `h-9` = 36px 偏高 3px）；且参考图右栏 y63 无分隔线（`#fdfdfd`），
          故不画 `border-b` —— 全应用只有中心栏组头在 y63 有一条 `#dcdcdc` 细线。 */}
      <div className="flex h-[33px] shrink-0 items-center justify-between px-3">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-tone">
          <Sparkles size={12} aria-hidden="true" className="text-tone-3" />
          AI 对话
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="text-[10px] text-tone-3"
            title={`当前智能体：${activeAgent.name}（${activeAgent.id}）`}
          >
            {activeAgent.name}
          </span>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              title="清空对话"
              aria-label="清空对话"
              className="rounded-chip p-0.5 text-tone-3 transition-colors hover:text-tone"
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          )}
        </span>
      </div>

      {/* 消息列表：面板内部滚动（flex-1 + min-h-0），不撑破 100vh */}
      {/* ★ t6 F-5：容器只有一个 `aria-label="对话消息"`，任何「按 aria-label 数消息」的
          探针恒得 1。这里给**每条消息**补上 `data-message-role` 与逐条 `aria-label`，
          使「用户/助手」消息可被计数与区分（`role="log"` + `aria-live` 保留给流式播报）。 */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="对话消息"
        className="flex-1 min-h-0 overflow-y-auto mc-scrollbar px-3 py-3 space-y-3"
      >
        {messages.length === 0 ? (
          <p className="pt-6 text-center text-[10.5px] leading-[1.7] text-tone-3">
            问点什么，开始与 AI 讨论这一章。
          </p>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} text={m.content} />
            ) : (
              <AssistantBlock
                key={m.id}
                message={m}
                canRetry={!streaming && lastUserText.length > 0}
                onRetry={handleRetry}
              />
            ),
          )
        )}
      </div>

      {/* 输入区 */}
      <div
        className="shrink-0 border-t px-2.5 pb-2.5 pt-2"
        style={{ borderColor: 'hsl(var(--paper-line))' }}
      >
        <PromptBar
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="问点什么..."
          streaming={streaming}
          onStop={handleStop}
          disabled={false}
          hint={
            <span className="flex items-center justify-between">
              <span>Enter 发送 · Shift+Enter 换行</span>
              <span className="mc-num">{streaming ? '生成中…' : ''}</span>
            </span>
          }
        />
      </div>
    </div>
  );
}

/** 用户消息：浅灰底块右对齐（与 AI 的裸文左对齐形成对比） */
function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-message-role="user" aria-label="用户消息">
      <div
        className="max-w-[86%] whitespace-pre-wrap rounded-window px-2.5 py-1.5 text-[11.5px] leading-[1.6] text-tone"
        style={{ background: 'hsl(var(--paper-hover-2))' }}
      >
        {text}
      </div>
    </div>
  );
}

/** AI 消息：agent 名 + 正文（流式挂光标）+ 工具调用 + 错误态 */
function AssistantBlock({
  message,
  canRetry,
  onRetry,
}: {
  message: ChatMessage;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const agent = message.agent;
  return (
    <div className="space-y-1" data-message-role="assistant" aria-label="助手消息">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9.5px] font-medium text-paper"
          style={{ background: agent.color ?? 'hsl(var(--tone-3))' }}
        >
          {agent.short ?? '·'}
        </span>
        <span className="text-[10px] font-medium text-tone-2">{agent.name}</span>
        <span className="mc-num text-[10px] text-tone-3" title="智能体 id">
          {agent.id}
        </span>
      </div>

      {message.thinking.length > 0 &&
        (message.content.length > 0 ? (
          <div className="mc-num text-[10px] text-tone-3">
            已思考 {message.thinking.length} 字
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-[10.5px] leading-[1.6] text-tone-3">
            {message.thinking}
          </div>
        ))}

      {message.content.length > 0 ? (
        <StreamingText
          streaming={message.status === 'streaming'}
          className="whitespace-pre-wrap text-[11.5px] leading-[1.65] text-tone"
        >
          {message.content}
        </StreamingText>
      ) : message.status === 'streaming' ? (
        <StreamingText streaming className="text-[11.5px] text-tone-3">
          正在思考…
        </StreamingText>
      ) : null}

      {message.tools.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {message.tools.map((t) => (
            <span
              key={t}
              className="mc-num rounded-chip border px-1.5 py-0.5 text-[10px] text-tone-3"
              style={{ borderColor: 'hsl(var(--paper-line))' }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {message.status === 'error' && (
        <div role="alert" className="space-y-1">
          <div className="text-[10.5px] leading-[1.6] text-sig-stop">
            发送失败：{message.error ?? '未知错误'}
          </div>
          <button
            type="button"
            onClick={onRetry}
            disabled={!canRetry}
            className="inline-flex items-center gap-1 rounded-chip px-1.5 py-0.5 text-[10px] text-tone-2 transition-colors hover:text-tone disabled:opacity-50"
          >
            <RotateCcw size={11} aria-hidden="true" />
            重试
          </button>
        </div>
      )}
    </div>
  );
}

export default AiChatPanel;
