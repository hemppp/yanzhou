// ============================================================
// AI 对话服务 - 通过后端 API
// ============================================================

import { apiClient } from '@novel-plugins/data-core/api/apiClient';
import { getToken } from '@novel-plugins/data-core/api/apiClient';
import { resolveApiUrl } from '@novel-plugins/data-core/api/apiClient';
import { createSSEStreamController, forEachSSEDataLine, type SSEStreamController } from './sseStream';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatError {
  type: 'config' | 'network' | 'api' | 'timeout' | 'unknown';
  message: string;
  originalError?: Error;
}

/** 小说对话上下文（含技能选择器透传字段） */
export interface NovelChatContext {
  projectId?: string;
  chapterTitle?: string;
  chapterContent?: string;
  characterNames?: string[];
  /** 当前章节的 order（用于智能续写/章节分析确定前三章范围） */
  currentChapterOrder?: number;
  /** 激活的技能 ID */
  skillId?: string;
  /** 前端按技能 contextKeys 收集的实体上下文文本 */
  extraContext?: string;
  /** 是否启用工具调用（让 AI 能读写实体模块） */
  enableTools?: boolean;
  /** 是否启用通用 Agent 模式（OpenAI Agents SDK，支持多步规划/网页搜索/章节读写） */
  enableAgent?: boolean;
}

/** 工具调用事件（LLM 请求调用工具） */
export interface ToolCallEvent {
  id: string;
  name: string;
  arguments: string;
}

/** 工具执行结果事件 */
export interface ToolResultEvent {
  id: string;
  name: string;
  success: boolean;
  result: string;
  entity?: {
    type: 'character' | 'foreshadow' | 'location' | 'item' | 'outline';
    action: 'create' | 'update';
    id?: string;
    name?: string;
    /** 大纲工具专用：携带结构化载荷供前端写入 localStorage store */
    payload?: Record<string, unknown>;
  };
}

export async function chat(
  messages: ChatMessage[],
  _options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  try {
    const response = await apiClient.post<{ response: string }>('/ai/chat', {
      simple: true,
      conversationHistory: messages.slice(0, -1).map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
      userMessage: messages[messages.length - 1]?.content || '',
    }, { timeoutMs: 60_000 });
    return response.response || '';
  } catch (e) {
    var errMsg = e instanceof Error ? e.message : '未知错误';
    return '[错误] ' + errMsg;
  }
}

export async function chatStream(
  _messages: ChatMessage[],
  _callbacks: {
    onChunk?: (chunk: string) => void;
    onComplete?: () => void;
    onError?: (error: ChatError) => void;
    onThinking?: (chunk: string) => void;
  },
  _options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  try {
    const result = await chat(_messages, _options);
    _callbacks.onChunk?.(result);
    _callbacks.onComplete?.();
    return result;
  } catch (e) {
    const err: ChatError = {
      type: 'unknown',
      message: e instanceof Error ? e.message : '未知错误',
    };
    _callbacks.onError?.(err);
    return '';
  }
}

export async function novelChat(
  userMessage: string,
  context: NovelChatContext,
  signal?: AbortSignal,
  history?: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  try {
    // system prompt 由后端 chat-agent 按 phase='小说对话' 组装
    // 前端只传业务上下文（章节标题、角色名、章节内容）和用户消息
    // ★ 同时传 conversationHistory，让后端支持多轮对话
    // ★ 技能选择器：透传 skillId + extraContext，由后端叠加技能 prompt
    const response = await apiClient.post<{ response: string }>('/ai/chat', {
      simple: true,
      phase: '小说对话',
      chapterTitle: context.chapterTitle,
      characterNames: context.characterNames,
      chapterContent: context.chapterContent,
      userMessage,
      conversationHistory: history,
      skillId: context.skillId,
      extraContext: context.extraContext,
      projectId: context.projectId,
      currentChapterOrder: context.currentChapterOrder,
    }, { timeoutMs: 60_000, signal });
    return response.response || '';
  } catch (e) {
    // abort 时向上抛出，由 novelChatStream 决定是否触发 onError
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // apiClient 在 abort 时抛 ApiError(code='ABORTED')
    const apiErr = e as { code?: string };
    if (apiErr?.code === 'ABORTED') throw e;
    const errMsg = e instanceof Error ? e.message : '未知错误';
    return '[错误] ' + errMsg;
  }
}

export async function novelChatStream(
  userMessage: string,
  context: NovelChatContext,
  callbacks: {
    onChunk?: (chunk: string) => void;
    onComplete?: () => void;
    onError?: (error: ChatError) => void;
    onThinking?: (chunk: string) => void;
    onToolCall?: (event: ToolCallEvent) => void;
    onToolResult?: (event: ToolResultEvent) => void;
  },
  _history?: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal
): Promise<string> {
  // ★ 真流式实现：通过 /ai/chat-stream SSE 端点逐 chunk 接收
  //   之前是 /ai/chat 同步请求 + 一次性 onChunk，"打字效果"是假的
  //   现在用 fetch + ReadableStream 解析 SSE data: 行，每个 chunk 实时回调
  // ★ 组合信号：外部取消 + 空闲超时（连接挂着但长时间无数据不再无限等待）
  let sse: SSEStreamController | null = null;
  try {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const token = getToken();
    // ★ 空闲超时 120s：推理型模型（如 hy4-preview）思考阶段只产生 reasoning 增量，
    //   后端桥不转发 reasoning，客户端在首个正文 token 前会持续无数据；45s 会误杀长思考流。
    sse = createSSEStreamController({ external: signal, idleTimeoutMs: 120_000 });
    const response = await fetch(resolveApiUrl('ai/chat-stream'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        simple: true,
        phase: '小说对话',
        chapterTitle: context.chapterTitle,
        characterNames: context.characterNames,
        chapterContent: context.chapterContent,
        userMessage,
        conversationHistory: _history,
        skillId: context.skillId,
        extraContext: context.extraContext,
        projectId: context.projectId,
        currentChapterOrder: context.currentChapterOrder,
        enableTools: context.enableTools === true,
        enableAgent: context.enableAgent === true,
      }),
      signal: sse.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`流式对话请求失败: ${response.status}`);
    }

    // ★ 检测非 SSE 响应（如功能被冻结时后端返回 JSON）
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const jsonText = await response.text();
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed && parsed.error) {
          const errMsg = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
          throw new Error(`流式对话失败：${errMsg}`);
        }
        throw new Error(`流式对话返回非 SSE 响应：${jsonText.slice(0, 200)}`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('流式对话')) throw e;
        throw new Error(`流式对话响应解析失败：${jsonText.slice(0, 200)}`);
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    // 单个 SSE 事件块的解析（循环内与流结束后的残余 buffer 共用）
    const processEventBlock = (eventBlock: string) => {
      forEachSSEDataLine(eventBlock, (dataStr) => {
        try {
          const data = JSON.parse(dataStr);
          if (data.chunk) {
            if (signal?.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
            fullContent += data.chunk;
            callbacks.onChunk?.(data.chunk);
          } else if (data.thinking) {
            callbacks.onThinking?.(data.thinking);
          } else if (data.tool_call) {
            callbacks.onToolCall?.(data.tool_call as ToolCallEvent);
          } else if (data.tool_result) {
            callbacks.onToolResult?.(data.tool_result as ToolResultEvent);
          } else if (data.done) {
            // 流正常结束
          } else if (data.error) {
            throw new Error(data.message || '流式对话失败');
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          if (e instanceof Error && (e.message.startsWith('流式对话') || e.message === '流式对话失败')) throw e;
          // 单行 JSON 解析失败不中断流，跳过继续
          console.warn('[novelChatStream] SSE 行解析失败:', dataStr.slice(0, 100));
        }
      });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sse.notifyActivity();
        buffer += decoder.decode(value, { stream: true });

        // 按双换行分割 SSE 事件（标准 SSE 协议）
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) >= 0) {
          const eventBlock = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          processEventBlock(eventBlock);
        }
      }
      // ★ decoder 最终 flush + 残余 buffer：最后一条事件可能没有尾部空行
      buffer += decoder.decode();
      processEventBlock(buffer);
    } finally {
      sse.dispose();
    }

    callbacks.onComplete?.();
    return fullContent;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // 空闲超时是错误而非用户取消，需要通知上层
      if (sse?.isIdleTimeout()) {
        callbacks.onError?.({ type: 'unknown', message: 'AI 回复空闲超时（45 秒无数据），连接已中断' });
        return '';
      }
      // 用户主动取消，不触发 onError
      return '';
    }
    const err: ChatError = {
      type: 'unknown',
      message: e instanceof Error ? e.message : '未知错误',
    };
    callbacks.onError?.(err);
    return '';
  }
}

