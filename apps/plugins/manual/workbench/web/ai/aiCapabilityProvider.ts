// ============================================================
// 手写台 AI 能力 provider —— 补齐 `ai.scan` / `ai.timelineExtract` / `ai.quickPhrases`
// 三个跨模块能力**实现**（此前全仓无 provider，消费点一律静默降级）。
//
// 消费方与对应入口：
//   · ai.scan            → useAutoEntityDetection（正文变更静默扫描：时间线事件 /
//                          角色/物品/地点/流转/别名）、useLatestChapterPolling（90s 轮询）
//   · ai.timelineExtract → TimelineView「提取」按钮（此前因缺席被隐藏）
//   · ai.quickPhrases    → QuickPhrasePanel「AI 提取」（缺席时走本地启发式兜底）
//
// 为什么 provider 落在 manual 而不是 auto（沿用开发史，勿搬）：
//   2026-10-01「剥离 AI 自动写作模块」（c2583f8）把 auto 的实现整体移出仓外；
//   随后的隔离改造进一步拆掉了「手写台 UI 依赖 auto 包在场」的结构
//   （auto 入口 inject=[]、不注册任何槽，见其头注）。能力表本身是**跨模块
//   共享面**（kernel 不按模块/创作模式隔离；见 packages/core manifest.ts 的
//   WEB_CAPABILITIES 注释与 ../hooks/aiScanCapability.ts 头注）——谁注册实现都
//   合法。服务端引擎全部在本仓
//   （/ai/scan-timeline-stream、/ai/extract-events-stream、/ai/gateway
//     quick-phrases → scanner-agent / quick-phrase-agent），本文件是缺的那层
//   「fetch + SSE 拆帧 + 回调派发」薄适配。
//
// ⚠ 红石开关面（isScannerEnabled / isExtractEnabled / registerAbort /
//   subscribeRedstone）：本构建**没有客户端开关来源**（服务端
//   user_settings.ai_features 既无读写 API 也无面板 UI），故按契约
//   「缺席时视为已启用」的兜底语义实现：两个 is*Enabled 恒为 true；若服务端
//   实际冻结该功能，端点会以 200 + {skipped:true, reason} 应答（checkFeatureFrozen），
//   这里把它转成 ScanSkippedError —— 消费方已有对应 toast。
//   registerAbort / subscribeRedstone 保留真实可用的注册表，供未来接上开关来源。
// ============================================================

import type { WebPluginContext } from '@novel/core/web';
import {
  getCurrentProjectId,
  getToken,
  resolveApiUrl,
  apiClient,
} from '@novel-plugins/data-core/api/apiClient';
import {
  useChapterStore,
  useCharacterStore,
  useProjectStore,
} from '@novel-plugins/data-core/stores';
import { readSseStream } from './sse';
import {
  ScanSkippedError,
  type AIScanCapability,
  type StreamAliasMatch,
  type StreamCreditTransaction,
  type StreamEntity,
  type StreamItemTransfer,
  type StreamTimelineEvent,
} from '../hooks/aiScanCapability';

// ------------------------------------------------------------------
// 红石注册表（开关来源缺位时的最小可运作实现，语义见文件头注）
// ------------------------------------------------------------------

const abortRegistry = new Map<string, Set<AbortController>>();
const redstoneSubscribers = new Set<() => void>();

function registerAbort(feature: string, controller: AbortController): () => void {
  let set = abortRegistry.get(feature);
  if (!set) {
    set = new Set();
    abortRegistry.set(feature, set);
  }
  set.add(controller);
  return () => {
    set.delete(controller);
  };
}

function subscribeRedstone(cb: () => void): () => void {
  redstoneSubscribers.add(cb);
  return () => {
    redstoneSubscribers.delete(cb);
  };
}

// ------------------------------------------------------------------
// 请求工具
// ------------------------------------------------------------------

/** 与 AiChatPanel 同一套鉴权头（Bearer token + X-Project-Id + cookie 兜底）。 */
function authHeaders(projectId?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (projectId) headers['X-Project-Id'] = projectId;
  return headers;
}

/** 服务端错误体统一形状 `{ error: { code, message } }`；取 message 供 toast 照做。 */
async function readError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string }; message?: string }
    | null;
  return new Error(body?.error?.message || body?.message || `HTTP ${res.status}`);
}

/**
 * 200 但没有 text/event-stream 内容类型 ⇒ 两种可能：
 *   · {skipped:true, reason} —— 红石开关冻结（checkFeatureFrozen），转成 ScanSkippedError；
 *   · 其它 JSON（异常体）—— 按错误抛出，不静默。
 */
async function toStreamOrThrow(res: Response): Promise<ReadableStream<Uint8Array>> {
  if (!res.ok) throw await readError(res);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const body = (await res.json().catch(() => null)) as
      | { skipped?: boolean; reason?: string; error?: { message?: string } }
      | null;
    if (body?.skipped) throw new ScanSkippedError(body.reason || '功能已关闭');
    throw new Error(body?.error?.message || '扫描失败：响应不是事件流');
  }
  if (!res.body) throw new Error('扫描失败：响应无流式主体');
  return res.body;
}

// ------------------------------------------------------------------
// ai.scan —— 流式扫描（时间线事件 + 实体 + 流转 + 别名）
// ------------------------------------------------------------------

async function scanTimelineStream(
  chapterContent: string,
  chapterOrder: number,
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
  projectId?: string,
  onCreditTransaction?: (credit: StreamCreditTransaction) => void,
): Promise<StreamTimelineEvent[]> {
  const pid = projectId ?? getCurrentProjectId() ?? null;
  // 签名只给 content/order；chapterTitle/projectName 由服务端 schema 必填，
  // 从 store 就近解析（找不到时给空串 —— 提示词里只是上下文，不阻塞扫描）
  const chapter = useChapterStore
    .getState()
    .chapters.find((c) => c.order === chapterOrder && (!pid || c.projectId === pid));

  const res = await fetch(resolveApiUrl('/ai/scan-timeline-stream'), {
    method: 'POST',
    headers: authHeaders(pid),
    credentials: 'include',
    signal,
    body: JSON.stringify({
      chapterContent,
      chapterTitle: chapter?.title ?? '',
      chapterOrder,
      projectName: useProjectStore.getState().currentProject?.name ?? '',
      // 服务端 schema 收字符串（scanner-agent 直接拼进提示词），这里序列化；
      // 形状约定：characters 含 name+aliases（防重复识别），items/locations 为名字数组
      existingEntities: JSON.stringify(
        existingEntities ?? { characters: [], items: [], locations: [] },
      ),
      ...(pid ? { projectId: pid } : {}),
    }),
  });

  const body = await toStreamOrThrow(res);
  const events: StreamTimelineEvent[] = [];
  for await (const frame of readSseStream(body)) {
    const data = frame.data;
    if (data.error) throw new Error(String(data.message || '流式扫描失败'));
    if (data.done) break;
    // 判别字段与服务端 scanner-agent 的四种行一一对应（事件行无判别字段）
    if (data.transferType === 'item_transfer') {
      onItemTransfer?.(data as unknown as StreamItemTransfer);
      continue;
    }
    if (data.aliasType === 'alias_match') {
      onAliasMatch?.(data as unknown as StreamAliasMatch);
      continue;
    }
    if (data.creditType === 'credit_transaction') {
      onCreditTransaction?.(data as unknown as StreamCreditTransaction);
      continue;
    }
    if (typeof data.entityType === 'string') {
      onEntity?.(data as unknown as StreamEntity);
      continue;
    }
    const event = data as unknown as StreamTimelineEvent;
    events.push(event);
    onEvent(event);
  }
  return events;
}

// ------------------------------------------------------------------
// ai.timelineExtract（以及 ai.scan 的同一方法）—— 按关键词提取事件
// ------------------------------------------------------------------

/**
 * 找出关键词在人物设定中的其他称呼（全名/别名/简称）。
 * 例如用户输入「星儿」，陈星的 name+aliases 会被一并送给模型，
 * 避免模型因为原文只写「陈星」而漏掉相关事件。
 */
function resolveKeywordAliases(projectId: string, keyword: string): string[] {
  const chars = useCharacterStore
    .getState()
    .characters.filter((c) => c.projectId === projectId);
  const names = new Set<string>();

  for (const c of chars) {
    const aliases = c.aliases ?? [];
    const matched =
      c.name === keyword ||
      aliases.includes(keyword) ||
      (keyword.length >= 2 &&
        (c.name.includes(keyword) ||
          keyword.includes(c.name) ||
          aliases.some((a) => a.includes(keyword) || keyword.includes(a))));
    if (!matched) continue;

    if (c.name && c.name !== keyword) names.add(c.name);
    for (const a of aliases) {
      if (a && a !== keyword) names.add(a);
    }
  }

  return Array.from(names).slice(0, 10);
}

async function extractEventsByKeyword(
  content: string,
  title: string,
  order: number,
  keyword: string,
  onEvent: (event: StreamTimelineEvent) => void,
  signal?: AbortSignal,
  projectId?: string,
): Promise<void> {
  const pid = projectId ?? getCurrentProjectId() ?? null;
  if (!pid) throw new Error('缺少项目上下文（projectId）');

  const keywordAliases = resolveKeywordAliases(pid, keyword);

  const res = await fetch(resolveApiUrl('/ai/extract-events-stream'), {
    method: 'POST',
    headers: authHeaders(pid),
    credentials: 'include',
    signal,
    body: JSON.stringify({
      chapterContent: content,
      chapterTitle: title,
      chapterOrder: order,
      keyword,
      ...(keywordAliases.length > 0 ? { keywordAliases } : {}),
      projectId: pid,
    }),
  });

  const body = await toStreamOrThrow(res);
  for await (const frame of readSseStream(body)) {
    const data = frame.data;
    if (data.error) throw new Error(String(data.message || '提取失败'));
    if (data.done) break;
    // 本端点只推事件行（无实体/流转/别名帧）
    onEvent(data as unknown as StreamTimelineEvent);
  }
}

// ------------------------------------------------------------------
// ai.quickPhrases —— 快捷短语 AI 提取
// ------------------------------------------------------------------

async function generate(
  content: string,
  characters: Array<{ name: string; aliases?: string[] }>,
): Promise<string[]> {
  // characters 是结构化数组，服务端 agents/quick-phrase-agent 收的是
  // 一行供参考的文本；格式取「名字（别名、别名）」，并限长防提示词过肥
  const charLine = (characters ?? [])
    .slice(0, 30)
    .map((c) => (c.aliases && c.aliases.length > 0 ? `${c.name}（${c.aliases.join('、')}）` : c.name))
    .filter(Boolean)
    .join('、')
    .slice(0, 800);

  // POST /ai/gateway {feature:'quick-phrases'} → apiClient 解包 data ⇒ { suggestions }
  const data = await apiClient.post<{ suggestions?: string[] } & { skipped?: boolean }>(
    '/ai/gateway',
    {
      feature: 'quick-phrases',
      payload: {
        // 服务端 buildUserPrompt 只取前 4000 字符，这里先裁，别传整章
        content: content.slice(0, 4000),
        characters: charLine,
      },
    },
    // 生成类走推理模型（实测 4–25s+），8s 默认必超时；silent 挡掉全局错误分发
    // （QuickPhrasePanel 自己 catch 并 console.debug，属预期降级路径）
    { silent: true, timeoutMs: 60_000 },
  );
  if (data && typeof data === 'object' && 'skipped' in data) return [];
  return (data?.suggestions ?? []).filter((s): s is string => typeof s === 'string' && s.length >= 2);
}

// ------------------------------------------------------------------
// 注册入口（manual 入口 apply() 调用）
// ------------------------------------------------------------------

export function registerAICapabilities(ctx: WebPluginContext): void {
  const scan: AIScanCapability = {
    scanTimelineStream,
    extractEventsByKeyword,
    // 开关来源缺位（见文件头注）：按契约「缺席视为已启用」兜底
    isScannerEnabled: () => true,
    isExtractEnabled: () => true,
    registerAbort,
    subscribeRedstone,
  };
  // 只注册 WEB_CAPABILITIES 白名单内的名字，不新造（manifest.ts 是唯一来源）
  ctx.registerCapability('ai.scan', scan);
  ctx.registerCapability('ai.timelineExtract', { extractEventsByKeyword });
  ctx.registerCapability('ai.quickPhrases', { generate });
}
