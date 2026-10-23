// ============================================================
// 章节扫描服务 - 通过后端 API
// ============================================================

import type { AIScanResult, ForeshadowType } from '@novel/shared';
import { apiClient, getToken } from '@novel-plugins/data-core/api/apiClient';
import { resolveApiUrl } from '@novel-plugins/data-core/api/apiClient';
import { createSSEStreamController } from '../../discuss/services/sseStream';

/** 流式时间线事件（后端逐个推送） */
export interface StreamTimelineEvent {
  title: string;
  description: string;
  type: 'event' | 'foreshadow' | 'state_change';
  characterNames: string[];
  chapterOrder: number;
  timestamp?: string;
}

/** 流式实体（角色/物品/地点，后端逐个推送） */
export interface StreamEntity {
  entityType: 'character' | 'item' | 'location';
  name: string;
  description: string;
  context: string;
  // 角色扩展字段（仅 character 类型使用，可选）
  appearance?: string;      // 外貌描述
  personality?: string;     // 性格特征
  role?: 'protagonist' | 'femaleLead' | 'supporting' | 'minor';  // 角色定位
  speechStyle?: string;     // 说话风格/口头禅
  // 物品扩展字段（仅 item 类型使用，可选）：标准类型码（weapon/armor/clothing/treasure/…）
  itemType?: string;
}

/** 流式物品流转（后端逐个推送） */
export interface StreamItemTransfer {
  transferType: 'item_transfer';
  itemName: string;
  fromCharacter: string;
  toCharacter: string;
  action: 'gained' | 'lost' | 'transferred' | 'held';
  context: string;
}

/** 流式角色别名关系（后端逐个推送） */
export interface StreamAliasMatch {
  aliasType: 'alias_match';
  primaryName: string;
  aliases: string[];
  context: string;
}

/** /ai/scan 接口返回的原始数据结构（mapScannerResult 输入） */
interface ScannerRawResponse {
  entities?: Array<{ type: string; name: string; description: string; mentioned: boolean; active: boolean }>;
  characters?: Array<{ name: string; isNew: boolean; context: string }>;
  items?: Array<{ name: string; isNew: boolean; context: string }>;
  locations?: Array<{ name: string; isNew: boolean; context: string }>;
  events?: Array<{
    title?: string;
    description?: string;
    type?: string;
    characterNames?: string[];
    participants?: string[];
    chapterOrder?: number;
    timestamp?: string;
  }>;
  stateChanges?: Array<{ entity?: string; entityId?: string; change?: string; newValue?: string; attribute?: string; oldValue?: string; context?: string }>;
  foreshadowSuggestions?: Array<{ text?: string; type?: string; description?: string; context?: string; confidence?: number }>;
  foreshadows?: Array<{ text?: string; type?: string; description?: string; context?: string; confidence?: number }>;
  consistencyIssues?: Array<{ issue?: string; severity?: string; type?: string; description?: string; suggestion?: string }>;
}

/** 判断异常是否为 abort 信号（跨浏览器/DOMException 兼容） */
function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && e.name === 'AbortError'
  ) || (
    typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError'
  );
}

/**
 * 扫描被跳过的原因（后端红石开关关闭时返回）。
 * 后端 checkFeatureFrozen 返回 200 + JSON `{ skipped: true, reason: '功能已关闭' }`，
 * 不是 SSE 流。前端必须显式检测此情况，否则会被 SSE 解析器静默丢弃，用户毫无反馈。
 */
export const SCAN_SKIPPED_SENTINEL = '__SCAN_SKIPPED__';

/** 扫描被跳过时抛出的错误（携带后端 reason） */
export class ScanSkippedError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`扫描被跳过：${reason}`);
    this.name = 'ScanSkippedError';
    this.reason = reason;
  }
}

/**
 * 章节扫描服务
 */
export const scanService = {
  async scanChapter(
    chapterContent: string,
    existingCharacters: { id: string; name: string }[] = [],
    existingItems: { id: string; name: string }[] = [],
    existingLocations: { id: string; name: string }[] = [],
    signal?: AbortSignal,
  ): Promise<AIScanResult> {
    if (chapterContent.length < 20) {
      return emptyResult();
    }

    try {
      const response = await apiClient.post<ScannerRawResponse>('/ai/scan', {
        chapterContent,
        chapterTitle: '',
        chapterOrder: 0,
        projectName: '',
        existingEntities: JSON.stringify({
          characters: existingCharacters.map(c => c.name),
          items: existingItems.map(i => i.name),
          locations: existingLocations.map(l => l.name),
        }),
      }, { timeoutMs: 60_000, signal });

      return mapScannerResult(response);
    } catch {
      return emptyResult();
    }
  },

  /**
   * 流式扫描时间线事件（SSE）
   *
   * 使用 fetch + ReadableStream 消费后端 SSE 流，
   * 每收到一个事件立即通过 onEvent 回调推送，实现流式填充。
   * 避免非流式 /ai/scan 的 60s 超时问题。
   *
   * @returns 完整的事件列表（流结束后返回）
   */
  async scanTimelineStream(
    chapterContent: string,
    chapterOrder: number,
    // ★ 修复类型：支持两种 characters 形式
    //   - useLatestChapterPolling 传 string[]（仅 name）
    //   - useAutoEntityDetection 传 { name, aliases }[]（含别名，避免重复创建）
    //   scanService 内部仅 JSON.stringify 透传给后端，不直接索引，故联合类型安全
    existingEntities: {
      characters: Array<string | { name: string; aliases: string[] }>;
      items: string[];
      locations: string[];
    },
    onEvent: (event: StreamTimelineEvent) => void,
    onEntity?: (entity: StreamEntity) => void,
    onItemTransfer?: (transfer: StreamItemTransfer) => void,
    onAliasMatch?: (aliasMatch: StreamAliasMatch) => void,
    signal?: AbortSignal,
    /** 项目上下文（后端校验项目归属，必填） */
    projectId?: string,
  ): Promise<StreamTimelineEvent[]> {
    console.debug('[scanService] scanTimelineStream 调用', { contentLen: chapterContent.length, chapterOrder, hasToken: !!getToken() });
    if (chapterContent.length < 20) return [];

    const token = getToken();
    // ★ 组合信号：外部取消 + 空闲超时（LLM 长时间不吐字节不再无限等待）
    const sse = createSSEStreamController({ external: signal, idleTimeoutMs: 60_000 });
    try {
      const response = await fetch(resolveApiUrl('ai/scan-timeline-stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(projectId ? { 'X-Project-Id': projectId } : {}),
        },
        body: JSON.stringify({
          chapterContent,
          chapterTitle: '',
          chapterOrder,
          projectName: '',
          existingEntities: JSON.stringify(existingEntities),
          projectId,
        }),
        signal: sse.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`流式扫描请求失败: ${response.status}`);
      }

      // ★ 后端红石开关关闭时返回 200 + JSON `{ skipped: true, reason: '功能已关闭' }`，
      // Content-Type 是 application/json 而非 text/event-stream。
      // 此时 response.body 是 ReadableStream 但只含一段 JSON，按 SSE 解析会全部丢弃 → 静默失败。
      // 这里显式检测并抛 ScanSkippedError，让 useAutoEntityDetection 能识别并提示用户。
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const jsonText = await response.text();
        try {
          const parsed = JSON.parse(jsonText);
          if (parsed && parsed.skipped === true) {
            throw new ScanSkippedError(parsed.reason || '功能已关闭');
          }
          // 其它 JSON 响应（如错误体）也抛出，避免静默
          if (parsed && parsed.error) {
            const errMsg = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
            throw new Error(`流式扫描失败：${errMsg}`);
          }
          throw new Error(`流式扫描返回非 SSE 响应：${jsonText.slice(0, 200)}`);
        } catch (e) {
          if (e instanceof ScanSkippedError) throw e;
          throw new Error(`流式扫描响应解析失败：${jsonText.slice(0, 200)}`);
        }
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events: StreamTimelineEvent[] = [];
      // ★ 收集后端通过 SSE 推送的 error 事件，流结束时抛出
      const streamErrors: string[] = [];

      // 单条 SSE 消息处理（循环内与流结束后的残余 buffer 共用）
      const processMessage = (msg: string) => {
        const trimmed = msg.trim();
        if (!trimmed.startsWith('data: ')) return;
        const data = trimmed.slice(6).trim();
        if (!data) return;

        try {
          const parsed = JSON.parse(data);

          // 结束标记
          if (parsed.done === true) return;
          // 错误标记
          if (parsed.error === true) {
            // ★ 后端通过 SSE 发送错误（如 AI 配置缺失、熔断器打开、AI 返回错误）
            // 必须收集起来在流结束时抛出，让 useAutoEntityDetection 能感知并提示用户
            const errMsg = typeof parsed.message === 'string' ? parsed.message : 'AI 扫描失败';
            console.warn('[scanService] 流式扫描错误:', errMsg);
            streamErrors.push(errMsg);
            return;
          }

          // 实体行（角色/物品/地点）
          if (parsed.entityType && parsed.name) {
            onEntity?.(parsed as StreamEntity);
            return;
          }

          // 物品流转行
          if (parsed.transferType === 'item_transfer') {
            onItemTransfer?.(parsed as StreamItemTransfer);
            return;
          }

          // 角色别名行
          if (parsed.aliasType === 'alias_match') {
            onAliasMatch?.(parsed as StreamAliasMatch);
            return;
          }

          // 时间线事件
          if (parsed.title) {
            const event = parsed as StreamTimelineEvent;
            events.push(event);
            onEvent(event);
          } else {
            // ★ 未知格式：打印出来便于诊断
            console.debug('[scanService] 未识别的 SSE 行:', data.slice(0, 200));
          }
        } catch (e) {
          // ★ JSON 解析失败：打印出来便于诊断 AI 输出格式问题
          console.warn('[scanService] JSON 解析失败:', data.slice(0, 200), e);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sse.notifyActivity();

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        for (const msg of messages) {
          processMessage(msg);
        }
      }

      // ★ decoder 最终 flush + 残余 buffer：最后一条事件可能没有尾部空行
      buffer += decoder.decode();
      if (buffer.trim()) processMessage(buffer);

      // ★ 流结束后若累积了错误，抛出第一个让上层提示用户
      if (streamErrors.length > 0) {
        throw new Error(streamErrors[0]);
      }

      return events;
    } catch (e) {
      if (sse.isIdleTimeout()) {
        throw new Error('AI 扫描空闲超时（60 秒无数据），连接已中断');
      }
      if (signal?.aborted || isAbortError(e)) {
        console.debug('[scanService] scanTimelineStream 已中止');
        return [];
      }
      throw e;
    } finally {
      sse.dispose();
    }
  },

  /**
   * 按关键词流式提取事件（SSE）
   *
   * 用户输入关键词（如角色名"陈星"），AI 从章节内容中提取相关事件，
   * 逐个通过 onEvent 回调推送，流结束后返回完整列表。
   */
  async extractEventsByKeyword(
    chapterContent: string,
    chapterTitle: string,
    chapterOrder: number,
    keyword: string,
    onEvent: (event: StreamTimelineEvent & { quote?: string }) => void,
    signal?: AbortSignal,
    /** 项目上下文（后端校验项目归属，必填） */
    projectId?: string,
  ): Promise<(StreamTimelineEvent & { quote?: string })[]> {
    if (chapterContent.length < 20) return [];

    const token = getToken();
    const sse = createSSEStreamController({ external: signal, idleTimeoutMs: 60_000 });
    try {
      const response = await fetch(resolveApiUrl('ai/extract-events-stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(projectId ? { 'X-Project-Id': projectId } : {}),
        },
        body: JSON.stringify({
          chapterContent,
          chapterTitle,
          chapterOrder,
          keyword,
          projectId,
        }),
        signal: sse.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`提取事件请求失败: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events: (StreamTimelineEvent & { quote?: string })[] = [];
      const streamErrors: string[] = [];

      const processMessage = (msg: string) => {
        const trimmed = msg.trim();
        if (!trimmed.startsWith('data: ')) return;
        const data = trimmed.slice(6).trim();
        if (!data) return;

        try {
          const parsed = JSON.parse(data);

          if (parsed.done === true) return;
          if (parsed.error === true) {
            // ★ 服务端错误不再静默吞掉：收集后抛出，避免"提取失败"伪装成"无结果"
            const errMsg = typeof parsed.message === 'string' ? parsed.message : '提取事件失败';
            streamErrors.push(errMsg);
            return;
          }

          if (parsed.title) {
            const event = parsed as StreamTimelineEvent & { quote?: string };
            events.push(event);
            onEvent(event);
          }
        } catch {
          // 忽略解析错误
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sse.notifyActivity();

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        for (const msg of messages) {
          processMessage(msg);
        }
      }

      // ★ decoder 最终 flush + 残余 buffer
      buffer += decoder.decode();
      if (buffer.trim()) processMessage(buffer);

      if (streamErrors.length > 0) {
        throw new Error(streamErrors[0]);
      }

      return events;
    } catch (e) {
      if (sse.isIdleTimeout()) {
        throw new Error('提取事件空闲超时（60 秒无数据），连接已中断');
      }
      if (signal?.aborted || isAbortError(e)) {
        console.debug('[scanService] extractEventsByKeyword 已中止');
        return [];
      }
      throw e;
    } finally {
      sse.dispose();
    }
  },
};

// 注意：mapScannerResult 的输出对象形状与 @novel/shared 的 AIScanResult 声明已对齐，
// 历史字段（entity/change/attribute、description/context/confidence、issue/suggestion）
// 已作为可选字段纳入 StateChangeMention/ForeshadowSuggestion/ConsistencyIssue。
function mapScannerResult(data: ScannerRawResponse): AIScanResult {
  // 事件解析：优先取 events 数组；兜底从 entities.type='event' 提取
  const rawEvents = Array.isArray(data.events) ? data.events : [];
  const entityEvents = (Array.isArray(data.entities) ? data.entities : []).filter(
    (e) => e && e.type === 'event'
  );
  const events = [
    ...rawEvents.map((e) => ({
      title: e.title || e.description || '',
      description: e.description || '',
      type: normalizeEventType(e.type),
      characterNames: Array.isArray(e.characterNames)
        ? e.characterNames.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        : Array.isArray(e.participants)
          ? e.participants.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
          : [],
      chapterOrder: typeof e.chapterOrder === 'number' ? e.chapterOrder : 0,
      timestamp: typeof e.timestamp === 'string' && e.timestamp ? e.timestamp : undefined,
    })),
    ...entityEvents
      .filter((e) => !rawEvents.some((r) => (r.title || r.description) === (e.name || e.description)))
      .map((e) => ({
        title: e.name || e.description || '',
        description: e.description || '',
        type: 'event' as const,
        characterNames: [] as string[],
        chapterOrder: 0,
        timestamp: undefined as string | undefined,
      })),
  ];

  // 实体兜底映射：当 characters/items/locations 数组缺失时，从 entities 按 type 过滤
  // entities 字段形状与 characters 不同（缺 isNew/context），统一映射时用 ?? 兜底默认值
  const characterSource = data.characters ?? data.entities?.filter((e) => e.type === 'character').map((e) => ({ name: e.name, isNew: true, context: e.description || '' })) ?? [];
  const itemSource = data.items ?? data.entities?.filter((e) => e.type === 'item').map((e) => ({ name: e.name, isNew: true, context: e.description || '' })) ?? [];
  const locationSource = data.locations ?? data.entities?.filter((e) => e.type === 'location').map((e) => ({ name: e.name, isNew: true, context: e.description || '' })) ?? [];

  return {
    chapterId: '',
    characters: characterSource.map((e) => ({
      name: e.name || '',
      isNew: e.isNew ?? true,
      context: e.context || '',
    })),
    items: itemSource.map((e) => ({
      name: e.name || '',
      isNew: e.isNew ?? true,
      context: e.context || '',
    })),
    locations: locationSource.map((e) => ({
      name: e.name || '',
      isNew: e.isNew ?? true,
      context: e.context || '',
    })),
    events,
    stateChanges: (data.stateChanges || []).map((s) => ({
      entity: s.entity || s.entityId || '',
      change: s.change || s.newValue || '',
      attribute: s.attribute || '',
      oldValue: s.oldValue || '',
      newValue: s.newValue || '',
      context: s.context || '',
    })),
    foreshadowSuggestions: (data.foreshadowSuggestions || data.foreshadows || []).map((f) => ({
      text: f.text || f.description || '',
      type: normalizeForeshadowType(f.type),
      description: f.description || '',
      context: f.context || '',
      confidence: f.confidence || 0.5,
    })),
    consistencyIssues: (data.consistencyIssues || []).map((c) => ({
      issue: c.issue || c.description || '',
      severity: normalizeSeverity(c.severity),
      type: normalizeConsistencyType(c.type),
      description: c.description || '',
      suggestion: c.suggestion || '',
    })),
  };
}

/** 规范化事件类型 */
function normalizeEventType(v: string | undefined): 'event' | 'foreshadow' | 'state_change' {
  if (v === 'foreshadow' || v === 'state_change') return v;
  return 'event';
}

/** 规范化伏笔类型（AI 可能返回非法值，统一兜底为 'turning'） */
function normalizeForeshadowType(v: string | undefined): ForeshadowType {
  const valid: ForeshadowType[] = ['identity', 'motivation', 'relation', 'trauma', 'turning', 'fate'];
  if (v && valid.includes(v as ForeshadowType)) return v as ForeshadowType;
  return 'turning';
}

/** 规范化严重级别 */
function normalizeSeverity(v: string | undefined): 'error' | 'warning' | 'info' {
  if (v === 'error' || v === 'info') return v;
  return 'warning';
}

/** 规范化一致性问题类型 */
function normalizeConsistencyType(v: string | undefined): 'timeline' | 'location' | 'character' | 'item' | 'custom' {
  if (v === 'timeline' || v === 'location' || v === 'character' || v === 'item') return v;
  return 'custom';
}

function emptyResult(): AIScanResult {
  return {
    chapterId: '',
    characters: [],
    items: [],
    locations: [],
    events: [],
    stateChanges: [],
    foreshadowSuggestions: [],
    consistencyIssues: [],
  };
}