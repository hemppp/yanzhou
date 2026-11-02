// ============================================================
// AI 模块路由 - AI 相关 API 端点
//
// POST /api/ai/scan               - 章节扫描
// POST /api/ai/check-consistency   - 一致性检查
// POST /api/ai/analyze-style       - 风格分析
// POST /api/ai/analyze-rhythm      - 节奏分析
// POST /api/ai/chat                - 对话助手
// POST /api/ai/generate-character  - 生成角色
// POST /api/ai/generate-plot       - 生成情节
//
// 错误处理：异常统一由全局 errorHandler 中间件捕获处理
// ============================================================

import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getProvider, type AIConfig, configLoaders, applyBuiltinRelayFallback } from '../ai/providers/provider-factory.js';
import { isBuiltinRelayKey, BUILTIN_RELAY_LABEL } from '../lib/builtin-relay.js';
import { ensureConfigMiddleware } from '../ai/user-config-loader.js';
import { listMarket } from '../services/skill-catalog.js';
import { getDb, schema, eq, saveToDisk, initProjectDb } from '@novel/db';
import { getActiveProxy } from '../lib/proxy-agent.js';
import {
  scanChapter,
  streamTimelineEvents,
  streamEventsByKeyword,
  runConsistencyCheck,
  runStyleAnalysis,
  runSimplifiedStyleAnalysis,
  runChatAgent,
  runChatAgentSimple,
  runChatAgentSimpleStream,
  runRhythmAnalysis,
  runTimelineAnalysis,
} from '../ai/index.js';
import { runChatAgentWithTools } from '../ai/agents/chat-agent.js';
import { runNovelAgentStream } from '../ai/agents/sdk/agent.js';
import {
  ensureToolsRegistered, ENTITY_TOOL_NAMES, PLUGIN_TOOL_NAMES, READ_TOOL_NAMES,
  PROPOSE_CHAPTER_TOOL_NAME, getToolDefinitions, getPluginToolNames,
} from '../ai/tools/index.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limiter.js';
import { safeInternal } from '../lib/safe-error.js';
import { assertSafeOutboundUrl, assertSafeOutboundUrlDeep } from '../lib/ssrf-guard.js';
import { verifyProjectOwnership } from '../lib/ownership.js';
import { buildProjectContext, checkOutlineExists } from '../ai/context-builder.js';
import { listSkillMetas } from '../ai/agents/skills.js';
import { getSkillTarget } from '../ai/agents/skill-targets.js';
// 集中式 Skills 库（docs/architecture/skills-library.md）：库的读写 + 每个智能体的开关
import {
  listLibrary, listOrphanOwners, installSkill, removeSkill,
  listTargets, getTargetSkills, setToggle, setAllToggles,
} from '../services/skill-library.js';

/**
 * 统一判断错误是否为 AbortError（用户取消 / 请求超时）。
 *
 * 不同来源的 abort 错误形态不同：
 * - DOMException（浏览器/undici）：name === 'AbortError'
 * - Node fetch (undici) 内部：code === 'ABORT_ERR' 或 'UND_ERR_ABORTED'
 * 统一在此处检测，避免各处 catch 用不一致的判定漏判。
 */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'AbortError' ||
    (error as { code?: string }).code === 'ABORT_ERR' ||
    (error as { code?: string }).code === 'UND_ERR_ABORTED'
  );
}

/**
 * 诊断 fetch 网络错误，将技术性错误消息转换为用户友好的中文提示。
 * Node.js undici fetch 失败时 error.message 通常是 "fetch failed"，
 * 真正的原因在 error.cause 中（ENOTFOUND / ECONNREFUSED / 证书错误等）。
 *
 * 同时在服务端控制台打印完整错误对象，便于排查无法分类的失败。
 */
function diagnoseFetchError(error: unknown, baseUrl?: string): string {
  if (!(error instanceof Error)) {
    console.error('[AI Fetch] 非 Error 抛出:', error);
    return '未知错误';
  }

  // cause 可能是 Error 实例，也可能是带 code 的对象，也可能是 undefined
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeObj = (cause ?? {}) as {
    code?: string;
    message?: string;
    name?: string;
    errno?: string | number;
    syscall?: string;
    address?: string;
    port?: number;
  };

  const code = causeObj.code || (typeof causeObj.errno === 'string' ? causeObj.errno : undefined);
  const causeMsg = causeObj.message || (cause instanceof Error ? cause.message : '');
  const msg = error.message;
  const hostname = baseUrl ? (() => { try { return new URL(baseUrl).hostname; } catch { return ''; } })() : '';

  // 服务端完整日志（用于排查无法分类的失败）
  console.error('[AI Fetch] 失败详情:', {
    message: msg,
    name: error.name,
    baseUrl,
    modelsUrl: baseUrl ? `${baseUrl}/models` : undefined,
    cause: cause instanceof Error
      ? { name: cause.name, message: cause.message, code: (cause as { code?: string }).code }
      : causeObj,
  });

  // 超时（AbortError / 手动 abort）
  if (error.name === 'AbortError' || code === 'UND_ERR_ABORTED' || msg.includes('aborted')) {
    return '请求超时：AI 服务在 15 秒内未响应，可能服务过载或网络不通';
  }
  // DNS 解析失败
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) {
    return `无法解析域名${hostname ? `「${hostname}」` : ''}：请检查 API 地址拼写是否正确`;
  }
  // 连接被拒绝
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
    return `连接被拒绝：目标服务${causeObj.address ? ` ${causeObj.address}${causeObj.port ? `:${causeObj.port}` : ''}` : ''}未启动或端口未监听（如 Ollama 未运行，请确认服务已启动）`;
  }
  // 连接被重置
  if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
    const proxyHint = getActiveProxy()
      ? `（已走代理 ${getActiveProxy()}，但目标服务拒绝连接——可能是代理节点被对方封禁，请更换代理节点或改用国内可达的 AI 服务）`
      : '（未配置代理。可能被防火墙拦截，请启动代理软件或设置 HTTPS_PROXY 环境变量）';
    return `连接被重置：目标服务强制断开了连接${proxyHint}`;
  }
  // SSL / TLS 证书问题
  if (code?.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || msg.includes('certificate') || causeMsg.includes('certificate')) {
    return `SSL 证书错误：目标服务 HTTPS 证书无效或已过期${causeMsg ? `（${causeMsg.slice(0, 120)}` : ''}）`;
  }
  // 通用 fetch failed 兜底：把 cause 的具体信息拼进消息，避免无信息
  if (msg === 'fetch failed' || msg.includes('fetch failed')) {
    const detail = causeMsg || code || (cause ? String(cause) : '');
    // ETIMEDOUT / ENETUNREACH 通常是网络不可达（如中国大陆直连被墙服务）
    if (code === 'ETIMEDOUT' || code === 'ENETUNREACH' || msg.includes('ETIMEDOUT') || msg.includes('ENETUNREACH')) {
      const proxyHint = getActiveProxy()
        ? `（已走代理 ${getActiveProxy()}，但仍超时——代理节点可能不通或目标被拦截，请更换节点或改用国内 AI 服务）`
        : '（未配置代理。请启动代理软件，或设置 HTTPS_PROXY 环境变量，或改用国内 AI 服务如 DeepSeek/智谱）';
      return `网络连接超时：无法连接到 ${hostname || 'AI 服务'}${proxyHint}`;
    }
    return detail
      ? `网络请求失败：${detail}（请检查 API 地址、网络连接、防火墙设置）`
      : `网络请求失败：无法连接到 AI 服务（baseUrl=${baseUrl ?? '未设置'}），请检查 API 地址、网络连接和防火墙设置`;
  }
  return msg;
}

const scanSchema = z.object({
  chapterContent: z.string().min(1, '章节内容不能为空').max(500000),
  chapterTitle: z.string(),
  chapterOrder: z.number().int().min(0),
  projectName: z.string(),
  previousSummary: z.string().optional(),
  existingEntities: z.string().optional(),
  /** 项目上下文（扫描结果会归属到该项目时必填） */
  projectId: z.string().uuid().optional(),
});

const consistencySchema = z.object({
  projectName: z.string(),
  charactersJson: z.string().optional(),
  itemsJson: z.string().optional(),
  locationsJson: z.string().optional(),
  eventsJson: z.string().optional(),
  foreshadowsJson: z.string().optional(),
  timelineJson: z.string().optional(),
  outlineJson: z.string().optional(),
  chaptersSummary: z.string().optional(),
});

const styleSchema = z.object({
  referenceText: z.string().min(1, '参考文本不能为空').max(500000),
  simple: z.boolean().optional(),
  source: z.string().optional(),
  author: z.string().optional(),
  genre: z.string().optional(),
  era: z.string().optional(),
});

const rhythmSchema = z.object({
  text: z.string().min(1, '章节文本不能为空').max(500000),
  chapterTitle: z.string().optional(),
});

const chatSchema = z.object({
  simple: z.boolean().optional(),
  conversationHistory: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
  // phase 场景下 userMessage 可空（由后端按 phase 模板组装）
  userMessage: z.string().max(50000).optional(),
  projectName: z.string().max(10000).optional(),
  currentChapter: z.string().max(10000).optional(),
  keyCharacters: z.string().max(10000).optional(),
  keyThemes: z.string().max(10000).optional(),
  phase: z.string().max(10000).optional(),

  // ---- 小说对话场景 ----
  chapterTitle: z.string().max(10000).optional(),
  characterNames: z.array(z.string()).optional(),
  chapterContent: z.string().max(500000).optional(),

  // ---- 大纲撰写场景 ----
  partitionTitle: z.string().max(10000).optional(),
  partitionPlaceholder: z.string().max(10000).optional(),
  previousSections: z.array(z.object({
    title: z.string(),
    content: z.string(),
  })).optional(),

  // ---- 大纲优化场景 ----
  sectionTitle: z.string().max(10000).optional(),
  sectionContent: z.string().max(10000).optional(),

  // ---- 大纲生成场景 ----
  topic: z.string().max(10000).optional(),
  genre: z.string().max(10000).optional(),

  // ---- 卡文诊断场景 ----
  currentParagraph: z.string().max(10000).optional(),
  precedingParagraphs: z.array(z.string()).optional(),
  charactersInScene: z.array(z.string()).optional(),
  location: z.string().max(10000).optional(),
  knowledgeBaseContext: z.array(z.string()).optional(),

  // ---- 续写提示场景 ----
  blockType: z.string().max(10000).optional(),
  blockReason: z.string().max(10000).optional(),
  atmosphere: z.string().max(10000).optional(),
  writingTips: z.array(z.string()).optional(),
  promptCount: z.number().int().min(1).max(10).optional(),

  // ---- 风格改写场景 ----
  text: z.string().max(500000).optional(),
  styleProfile: z.object({
    sentenceLength: z.string().optional(),
    perspective: z.string().optional(),
    dialogueStyle: z.string().optional(),
    paragraphLength: z.string().optional(),
  }).optional(),

  // ---- 技能选择器（用户主动激活的专家模式）----
  // ★ 修复：之前缺这两个字段，zValidator 会 strip 掉，导致技能功能完全失效
  skillId: z.string().max(10000).optional(),
  extraContext: z.string().max(10000).optional(),
  /** 是否启用工具调用（让 AI 能读写实体模块） */
  enableTools: z.boolean().optional(),
  /** 是否启用通用 Agent 模式（基于 OpenAI Agents SDK，支持多步规划/网页搜索/章节读写） */
  enableAgent: z.boolean().optional(),

  // ---- 智能续写 / 章节分析 场景 ----
  /** 项目 ID（用于后端自动构建增强上下文） */
  projectId: z.string().max(10000).optional(),
  /** 后端构建的完整项目上下文（大纲+角色+地点+物品+伏笔+事件+前三章等） */
  enhancedContext: z.string().max(200000).optional(),
  /** 前三章内容（按 order 排序） */
  previousChapters: z.array(z.string()).optional(),
  /** 当前章节的 order（用于智能续写/章节分析确定前三章范围） */
  currentChapterOrder: z.number().int().min(0).optional(),
}).refine(
  // 校验：默认对话场景下 userMessage 必填
  (data) => {
    const knownPhases = ['小说对话', '大纲撰写', '大纲优化', '大纲生成', '卡文诊断', '续写提示', '风格改写', '章节分析', '智能续写'];
    if (data.phase && knownPhases.includes(data.phase)) {
      return true; // phase 场景下 userMessage 可空
    }
    return !!data.userMessage && data.userMessage.length > 0;
  },
  {
    message: '消息内容不能为空',
    path: ['userMessage'],
  },
);

const generateCharacterSchema = z.object({
  description: z.string(),
  // ★ nullish 而非 optional（2026-10-11，UI 实测踩到）：客户端把
  //   `project.genre`（未设题材时为 **null**）原样 POST 过来，`z.string().optional()`
  //   只放行 undefined ⇒ 未设题材的新项目点「AI 生成角色」必 400（invalid_type）。
  //   处理器侧本就按 falsy 处理（`body.genre ? … : ''`），放行 null 无副作用。
  genre: z.string().nullish(),
  context: z.string().nullish(),
});

const generatePlotSchema = z.object({
  description: z.string(),
  projectName: z.string().optional(),
  genre: z.string().optional(),
  charactersJson: z.string().optional(),
  foreshadowsJson: z.string().optional(),
  currentSummary: z.string().optional(),
});

/** 创建 AI 路由器 */
const aiRouter = new Hono<{ Variables: AuthVariables }>();

// AI 速率限制：每用户每分钟最多 20 次请求
const aiRateLimit = rateLimit({ maxRequests: 20, windowMs: 60_000, keyBy: 'user' });

async function getChat(userId?: string) {
  const provider = await getProvider(userId);
  return provider.chat.bind(provider);
}

/** 获取 Provider 的流式 chat 函数 */
async function getChatStream(userId?: string) {
  const provider = await getProvider(userId);
  return provider.chatStream.bind(provider);
}

// ★ `ensureUserConfigLoader` / `ensureConfigMiddleware` 已抽到
//   `../ai/user-config-loader.js` —— 因为**插件路由也要用**（见该文件头的踩坑记录：
//   讨论走 /api/plugins/*，以前不过这个中间件，配置静默回退到内置站模型，
//   结果思维链永远是空的）。此处改为 import，别再在本地重新定义一份。

type AuthorizedProject =
  | { ok: true; projectId: string }
  | { ok: false; response: Response };

/**
 * 解析并校验 AI 请求的项目上下文。
 * body 与 X-Project-Id 同时存在时必须一致；项目 ID 存在时必须属于当前用户。
 * required=true 用于会把扫描结果绑定到项目的端点。
 */
async function resolveAuthorizedProject(
  c: Context<{ Variables: AuthVariables }>,
  bodyProjectId: unknown,
  required = false,
): Promise<AuthorizedProject> {
  const headerProjectId = (c.req.header('X-Project-Id') ?? '').trim();
  if (bodyProjectId !== undefined && bodyProjectId !== null && typeof bodyProjectId !== 'string') {
    return {
      ok: false,
      response: c.json({ error: { code: 'VALIDATION_ERROR', message: 'projectId 必须是字符串' } }, 400),
    };
  }
  const bodyId = typeof bodyProjectId === 'string' ? bodyProjectId.trim() : '';
  if (bodyId && headerProjectId && bodyId !== headerProjectId) {
    return {
      ok: false,
      response: c.json({ error: { code: 'VALIDATION_ERROR', message: 'body.projectId 与 X-Project-Id 不一致' } }, 400),
    };
  }
  const projectId = bodyId || headerProjectId;
  if (!projectId) {
    if (required) {
      return {
        ok: false,
        response: c.json({ error: { code: 'VALIDATION_ERROR', message: '缺少 projectId' } }, 400),
      };
    }
    return { ok: true, projectId: '' };
  }
  const user = c.get('user');
  if (!user?.id) {
    return { ok: false, response: c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401) };
  }
  const denial = await verifyProjectOwnership(c, projectId);
  if (denial) return { ok: false, response: denial };
  return { ok: true, projectId };
}

aiRouter.post('/scan', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', scanSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'scanner');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof scanSchema>;
  const project = await resolveAuthorizedProject(c, body.projectId);
  if (!project.ok) return project.response;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  const result = await scanChapter(chat, {
    chapterContent: body.chapterContent,
    chapterTitle: body.chapterTitle,
    chapterOrder: body.chapterOrder,
    projectName: body.projectName,
    previousSummary: body.previousSummary,
    existingEntities: body.existingEntities,
  }, { signal });

  return c.json({ success: true, data: result });
});

// POST /api/ai/scan-timeline-stream — 流式扫描时间线事件（SSE）
// 逐个推送解析出的时间线事件，前端可即时填充，避免 60s 超时
aiRouter.post('/scan-timeline-stream', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', scanSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'scanner');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof scanSchema>;
  const project = await resolveAuthorizedProject(c, body.projectId, true);
  if (!project.ok) return project.response;
  const chatStream = await getChatStream(user?.id);
  const signal = c.req.raw.signal;

  // SSE 流式响应
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        // ★ closed 标志 + try/catch：客户端断开后继续 enqueue 会抛错，避免错误噪声
        let closed = false;
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            closed = true;
          }
        };
        // ★ 心跳保活：与 chat-stream 对齐，防止反向代理在空闲时断开长连接
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } catch {
            closed = true;
            clearInterval(heartbeat);
          }
        }, 15_000);

        try {
          console.log(`[scan-timeline-stream] 开始 AI 扫描, 内容长度=${body.chapterContent.length}, 章节=${body.chapterOrder}`);
          await streamTimelineEvents(chatStream, {
            chapterContent: body.chapterContent,
            chapterTitle: body.chapterTitle,
            chapterOrder: body.chapterOrder,
            projectName: body.projectName,
            previousSummary: body.previousSummary,
            existingEntities: body.existingEntities,
          }, {
            signal,
            onEvent: (event) => send(event),
            onEntity: (entity) => send(entity),
            onItemTransfer: (transfer) => send(transfer),
            onAliasMatch: (aliasMatch) => send(aliasMatch),
          });
          console.log(`[scan-timeline-stream] AI 扫描成功完成`);
          send({ done: true });
        } catch (err: unknown) {
          // SSE 错误也需脱敏，避免泄露 AI provider 内部错误细节
          const message = isAbortError(err)
            ? '请求已取消'
            : safeInternal(err, '流式扫描失败', '[scan-timeline-stream]');
          send({ error: true, message });
        } finally {
          clearInterval(heartbeat);
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* 已关闭 */ }
          }
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  );
});

// POST /api/ai/extract-events-stream — 按关键词流式提取事件（SSE）
// 用户输入关键词（如角色名），AI 从当前章节内容中提取相关事件，逐个推送
const extractEventsSchema = z.object({
  chapterContent: z.string().min(1, '章节内容不能为空'),
  chapterTitle: z.string(),
  chapterOrder: z.number().int().min(0),
  keyword: z.string().min(1, '关键词不能为空'),
  projectId: z.string().uuid(),
});

aiRouter.post('/extract-events-stream', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', extractEventsSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'scanner');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof extractEventsSchema>;
  const project = await resolveAuthorizedProject(c, body.projectId, true);
  if (!project.ok) return project.response;
  console.log(`[AI Extract] 用户=${user?.id} 章节=${body.chapterOrder} 关键词="${body.keyword}" 内容长度=${body.chapterContent.length}`);
  const chatStream = await getChatStream(user?.id);
  const signal = c.req.raw.signal;

  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } catch {
            closed = true;
            clearInterval(heartbeat);
          }
        }, 15_000);

        try {
          await streamEventsByKeyword(chatStream, {
            chapterContent: body.chapterContent,
            chapterTitle: body.chapterTitle,
            chapterOrder: body.chapterOrder,
            keyword: body.keyword,
          }, {
            signal,
            onEvent: (event) => send(event),
          });
          send({ done: true });
        } catch (err: unknown) {
          const message = isAbortError(err)
            ? '请求已取消'
            : safeInternal(err, '提取失败', '[extract-events-stream]');
          send({ error: true, message });
        } finally {
          clearInterval(heartbeat);
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* 已关闭 */ }
          }
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  );
});

aiRouter.post('/check-consistency', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', consistencySchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'consistency');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof consistencySchema>;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  const result = await runConsistencyCheck(chat, {
    projectName: body.projectName,
    charactersJson: body.charactersJson,
    itemsJson: body.itemsJson,
    locationsJson: body.locationsJson,
    eventsJson: body.eventsJson,
    foreshadowsJson: body.foreshadowsJson,
    timelineJson: body.timelineJson,
    outlineJson: body.outlineJson,
    chaptersSummary: body.chaptersSummary,
  }, { signal });

  return c.json({ success: true, data: result });
});

aiRouter.post('/analyze-style', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', styleSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'style');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof styleSchema>;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  try {
    if (body.simple === true) {
      const result = await runSimplifiedStyleAnalysis(chat, {
        referenceText: body.referenceText,
      }, { signal });
      return c.json({ success: true, data: result });
    }

    const result = await runStyleAnalysis(chat, {
      referenceText: body.referenceText,
      source: body.source,
      author: body.author,
      genre: body.genre,
      era: body.era,
    }, { signal });

    return c.json({ success: true, data: result });
  } catch (e) {
    // JSON 解析失败 / LLM 超时 / 网络错误 —— 返回降级结果而非 500
    // 前端 styleService 会继续走"回退本地启发式"逻辑，不影响写作
    const reason = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : '';
    console.warn('[analyze-style] 分析失败，返回降级结果。原因:', reason);
    if (stack) console.warn('[analyze-style] 错误堆栈:', stack);
    return c.json({
      success: false,
      degraded: true,
      reason: reason || 'AI 风格分析暂时不可用，已降级处理',
    }, 200);
  }
});

aiRouter.post('/analyze-rhythm', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', rhythmSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'rhythm');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof rhythmSchema>;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  const result = await runRhythmAnalysis(chat, {
    text: body.text,
    chapterTitle: body.chapterTitle,
  }, { signal });

  return c.json({ success: true, data: result });
});

aiRouter.post('/chat', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', chatSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'chat');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof chatSchema>;
  const project = await resolveAuthorizedProject(c, body.projectId);
  if (!project.ok) return project.response;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  if (body.simple === true) {
    const response = await runChatAgentSimple(chat, {
      conversationHistory: body.conversationHistory,
      userMessage: body.userMessage,
      projectName: body.projectName,
      currentChapter: body.currentChapter,
      keyCharacters: body.keyCharacters,
      keyThemes: body.keyThemes,
      phase: body.phase,
      // 小说对话
      chapterTitle: body.chapterTitle,
      characterNames: body.characterNames,
      chapterContent: body.chapterContent,
      // 大纲撰写
      partitionTitle: body.partitionTitle,
      partitionPlaceholder: body.partitionPlaceholder,
      previousSections: body.previousSections,
      // 大纲优化
      sectionTitle: body.sectionTitle,
      sectionContent: body.sectionContent,
      // 大纲生成
      topic: body.topic,
      genre: body.genre,
      // 卡文诊断
      currentParagraph: body.currentParagraph,
      precedingParagraphs: body.precedingParagraphs,
      charactersInScene: body.charactersInScene,
      location: body.location,
      knowledgeBaseContext: body.knowledgeBaseContext,
      // 续写提示
      blockType: body.blockType,
      blockReason: body.blockReason,
      atmosphere: body.atmosphere,
      writingTips: body.writingTips,
      promptCount: body.promptCount,
      // 风格改写
      text: body.text,
      styleProfile: body.styleProfile,
      // ★ 修复：透传技能选择器字段，之前缺失导致技能失效
      skillId: body.skillId,
      extraContext: body.extraContext,
    }, { signal });
    return c.json({ success: true, data: { response } });
  }

  // 结构化对话场景：userMessage 必填（zValidator 的 refine 已校验）
  const result = await runChatAgent(chat, {
    conversationHistory: body.conversationHistory,
    userMessage: body.userMessage || '',
    projectName: body.projectName,
    currentChapter: body.currentChapter,
    keyCharacters: body.keyCharacters,
    keyThemes: body.keyThemes,
    phase: body.phase,
  }, { signal });

  return c.json({ success: true, data: result });
});

/**
 * POST /api/ai/check-outline - 检查项目大纲是否已填写
 * 用于前端智能续写等功能触发前校验
 *
 * @requestBody { projectId }
 * @response 200 { data: { hasOutline: boolean, nodeCount: number } }
 */
aiRouter.post('/check-outline', requireAuth, ensureConfigMiddleware, async (c) => {
  const user = c.get('user');
  if (!user?.id) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const project = await resolveAuthorizedProject(c, body?.projectId, true);
  if (!project.ok) return project.response;

  // ★ 项目库懒初始化：resolveAuthorizedProject 只做所有权校验，不初始化项目库；
  //   而 checkOutlineExists 走的是 scope='project' 的 service（BaseService.requireDb
  //   取 getProjectDbSync()），未初始化时会抛「项目库未初始化」→ 500。
  //   实测：全新项目冷调必 500，先做过一次项目级读取（如 GET /api/chapters/projects/:id）
  //   后才 200 —— 即结果依赖调用顺序。此处显式初始化，消除该竞态。
  //   initProjectDb 幂等（已初始化则复用缓存连接），重复调用无副作用。
  if (project.projectId) {
    await initProjectDb(project.projectId);
  }

  try {
    const hasOutline = await checkOutlineExists(project.projectId);
    return c.json({
      success: true,
      data: { hasOutline },
    });
  } catch (error) {
    console.error('[AI CheckOutline] 检查大纲失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '检查大纲失败' } }, 500);
  }
});

/**
 * chat-stream 的首帧：声明本次流由谁作答。
 *
 * 为什么需要：面板要在 AI 消息上显示 **agent 名**，而在此之前的 SSE 帧里
 * 只有 {thinking}/{chunk}/{tool_call}/{tool_result}/{done}/{error}，
 * **没有任何身份字段** ⇒ 前端只能硬编码一个名字，多智能体场景下会显示错人。
 *
 * 名字真源是 `skill-targets.ts` 的 `chat` 条目（不新造名字）；万一它未注册，
 * 退回同口径字面量，保证帧结构恒定（前端只依赖结构，不依赖表里有什么）。
 *
 * @param mode 实际作答的链路：'chat' 普通对话 / 'tools' 工具调用 / 'agent' SDK Agent
 */
function chatStreamAgentFrame(mode: 'chat' | 'tools' | 'agent') {
  const target = getSkillTarget('chat');
  return {
    agent: {
      id: target?.id ?? 'chat',
      name: target?.name ?? '对话智能体',
      short: target?.short ?? '我',
      color: target?.color ?? '#5B7CFA',
      mode,
    },
  };
}

// POST /api/ai/chat-stream — 流式对话（SSE）
// ★ 修复"假流式"问题：之前 /ai/chat 返回完整 JSON，前端 novelChatStream 只是同步包装
//   现在用 chatStream AsyncGenerator + SSE 逐 chunk 推送，前端可实时渲染打字效果
//   消息组装逻辑与 /ai/chat 完全一致（复用 runChatAgentSimpleStream）
aiRouter.post('/chat-stream', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', chatSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'chat');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof chatSchema>;
  console.log(`[chat-stream] 入口: enableTools=${body.enableTools} enableAgent=${body.enableAgent} projectId=${body.projectId ?? '(空)'} skillId=${body.skillId ?? '(空)'}`);
  const project = await resolveAuthorizedProject(c, body.projectId);
  if (!project.ok) return project.response;

  // ---- Mock 模式：模拟 DeepSeek R1 的 reasoning_content + content 流式返回 ----
  // 触发方式：在 AI 对话中发送以 __mock__ 开头的消息
  // 用途：无需真实 AI API 即可验证二级流式思考 UI 的渲染效果
  if (body.userMessage && body.userMessage.startsWith('__mock__')) {
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (obj: unknown) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          };

          // 模拟 DeepSeek R1 的思考过程（reasoning_content），分成多个 chunk
          const thinkingChunks = [
            '用户问的是关于角色塑造的建议。让我分析一下当前章节的上下文...\n\n',
            '首先，作者提到了主角面临抉择的场景。这种情境下，角色的内心冲突是关键。\n\n',
            '我需要从几个维度来分析：\n',
            '1. 角色动机：主角为什么犹豫？是恐惧还是道德困境？\n',
            '2. 情感层次：表面的犹豫之下，是否有更深层的原因？\n',
            '3. 行为一致性：这个决定是否符合角色之前建立的性格特征？\n\n',
            '从章节内容来看，主角之前表现出的性格是果断的，',
            '所以这里的犹豫应该有特殊原因。也许是对手的身份让主角动摇？\n\n',
            '我应该建议作者在内心独白中加入具体回忆，',
            '强化犹豫的合理性，同时为后续转折做铺垫。',
          ];

          // 模拟正文回复（content），分成多个 chunk
          const contentChunks = [
            '关于这个抉择场景，我有几点建议：\n\n',
            '1. **强化动机层次**：主角的犹豫不要只停留在表面原因，',
            '可以加入一段闪回，暗示更深的情感纠葛。\n\n',
            '2. **身体语言暗示**：在对话中穿插微动作描写——',
            '握紧的拳头、移开的视线——让读者感受到角色内心的拉扯。\n\n',
            '3. **节奏控制**：将关键抉择放在场景末尾，',
            '用短句加速节奏，制造张力。\n\n',
            '需要我帮你具体改写这段吗？',
          ];

          try {
            // ★ 首帧：身份帧（前端据此在 AI 消息上显示 agent 名）。放在最前面，
            //   保证「收到第一帧就知道对面是谁」，不必等正文。
            send(chatStreamAgentFrame('chat'));

            // 阶段一：先输出思考过程（模拟 reasoning_content）
            for (const chunk of thinkingChunks) {
              if (c.req.raw.signal?.aborted) break;
              send({ thinking: chunk });
              // 模拟真实流式的逐字延迟
              await new Promise((r) => setTimeout(r, 120));
            }

            // 思考与正文之间的短暂停顿（模拟模型从思考切换到输出）
            await new Promise((r) => setTimeout(r, 300));

            // 阶段二：输出正文内容
            for (const chunk of contentChunks) {
              if (c.req.raw.signal?.aborted) break;
              send({ chunk });
              await new Promise((r) => setTimeout(r, 100));
            }

            send({ done: true });
          } catch {
            send({ error: true, message: 'Mock 流被中断' });
          } finally {
            controller.close();
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      },
    );
  }

  const chatStream = await getChatStream(user?.id);
  const signal = c.req.raw.signal;

  // SSE 流式响应（参考 /scan-timeline-stream 的实现模式）
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            closed = true;
          }
        };

        // SSE 心跳：每 15 秒发送注释行保活，防止 nginx/cloudflare 断开长连接
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } catch {
            closed = true;
            clearInterval(heartbeat);
          }
        }, 15_000);

        try {
          // ★ 只为「章节分析」和「智能续写」自动构建增强上下文
          //   从数据库读取所有模块数据 + 前三章，作为 enhancedContext 注入
          let enhancedContext = body.enhancedContext;
          if (!enhancedContext && (body.phase === '章节分析' || body.phase === '智能续写')) {
            const projectId = project.projectId;
            const chapterOrder = body.currentChapterOrder ?? 0;
            if (projectId) {
              try {
                const ctx = await buildProjectContext(projectId, chapterOrder);
                enhancedContext = ctx.text;
              } catch (ctxErr) {
                console.warn('[chat-stream] 构建增强上下文失败，继续使用已有上下文:', ctxErr);
              }
            }
          }

          // ★ Agent 模式优先级高于普通工具调用模式
          //   enableAgent=true 时走 OpenAI Agents SDK，支持多步规划/网页搜索/章节读写
          const enableAgent = body.enableAgent === true;
          const enableTools = body.enableTools === true;
          const toolProjectId = project.projectId;

          // ★ 首帧：身份帧（前端据此在 AI 消息上显示 agent 名）。
          //   mode 取**实际**会走的那条链路，方便前端/诊断区分是谁在回答。
          send(chatStreamAgentFrame(
            enableAgent && toolProjectId ? 'agent' : enableTools && toolProjectId ? 'tools' : 'chat',
          ));

          if (enableAgent && toolProjectId) {
            // ★ Agent 模式：基于 OpenAI Agents SDK 的通用 Agent
            //   内置多步工具调用循环，可读写实体/章节/网页搜索
            const agentGen = runNovelAgentStream({
              conversationHistory: body.conversationHistory,
              userMessage: body.userMessage,
              projectName: body.projectName,
              currentChapter: body.currentChapter,
              keyCharacters: body.keyCharacters,
              keyThemes: body.keyThemes,
              phase: body.phase,
              chapterTitle: body.chapterTitle,
              characterNames: body.characterNames,
              chapterContent: body.chapterContent,
              skillId: body.skillId,
              extraContext: body.extraContext,
              enhancedContext,
              previousChapters: body.previousChapters,
            }, {
              projectId: toolProjectId,
              userId: user?.id ?? '',
              isAdmin: user?.isAdmin === true,
              // ★ 安全模式：Agent 暂时只读，章节写入（write_chapter）默认不暴露。
              //   恢复需实现服务端审批 + 快照 + 版本校验后显式开启。
              allowWriteChapter: false,
            }, signal);

            for await (const chunk of agentGen) {
              if (chunk.thinking) {
                send({ thinking: chunk.thinking });
              }
              if (chunk.content) {
                send({ chunk: chunk.content });
              }
              if (chunk.tool_call) {
                send({ tool_call: chunk.tool_call });
              }
              if (chunk.tool_result) {
                send({ tool_result: chunk.tool_result });
              }
            }
            send({ done: true });
          } else if (enableTools && toolProjectId) {
            // ★ 工具调用模式：当 enableTools=true 且有 projectId 时，使用支持工具调用的流式生成器
            //   AI 可主动调用 create_character / update_foreshadow 等工具读写实体模块
            // 确保工具已注册（幂等）
            ensureToolsRegistered();
            // 工具集合 = 只读资料工具 + 实体写入工具 + 章节提案工具 + 插件工具
            //
            // ★ 只读工具（READ_TOOL_NAMES）是无条件给的：AI 能查章节/角色/参考书/
            //   笔记，才能答得出「这本书里谁是谁」这类问题。
            // ★ 章节提案（propose_chapter_edit）也是无条件给的：它**不写库**，
            //   只是让 AI 把改法交到作者面前确认。真写入在前端点确认后走
            //   `PUT /api/chapters/:id` —— 服务端这一侧没有任何正文写入路径。
            // ★ 权限过滤：create_plugin 等同服务端代码执行，仅对管理员暴露给 LLM
            const toolDefs = getToolDefinitions([
              ...READ_TOOL_NAMES,
              ...ENTITY_TOOL_NAMES,
              PROPOSE_CHAPTER_TOOL_NAME,
              ...getPluginToolNames(),
              ...(user?.isAdmin ? PLUGIN_TOOL_NAMES : []),
            ]);
            console.log('[chat-stream] 工具模式诊断: toolDefs=' + toolDefs.length, '插件工具=' + toolDefs.map((d) => d.function.name).filter((n) => n.startsWith('autowrite')).join(','));

            const gen = runChatAgentWithTools(chatStream, {
              conversationHistory: body.conversationHistory,
              userMessage: body.userMessage,
              projectName: body.projectName,
              currentChapter: body.currentChapter,
              keyCharacters: body.keyCharacters,
              keyThemes: body.keyThemes,
              phase: body.phase,
              chapterTitle: body.chapterTitle,
              characterNames: body.characterNames,
              chapterContent: body.chapterContent,
              skillId: body.skillId,
              extraContext: body.extraContext,
              enhancedContext,
              previousChapters: body.previousChapters,
            }, {
              signal,
              tools: toolDefs,
              toolContext: { projectId: toolProjectId, user: { id: user?.id ?? '', isAdmin: user?.isAdmin } },
              maxToolRounds: 5,
            });

            for await (const chunk of gen) {
              if (chunk.thinking) {
                send({ thinking: chunk.thinking });
              }
              if (chunk.content) {
                send({ chunk: chunk.content });
              }
              // ★ 工具调用事件
              if (chunk.tool_call) {
                send({ tool_call: chunk.tool_call });
              }
              if (chunk.tool_result) {
                send({ tool_result: chunk.tool_result });
              }
            }
            send({ done: true });
          } else {
            // ★ 普通流式模式（无工具调用）
            const simpleInput = {
              conversationHistory: body.conversationHistory,
              userMessage: body.userMessage,
              projectName: body.projectName,
              currentChapter: body.currentChapter,
              keyCharacters: body.keyCharacters,
              keyThemes: body.keyThemes,
              phase: body.phase,
              chapterTitle: body.chapterTitle,
              characterNames: body.characterNames,
              chapterContent: body.chapterContent,
              partitionTitle: body.partitionTitle,
              partitionPlaceholder: body.partitionPlaceholder,
              previousSections: body.previousSections,
              sectionTitle: body.sectionTitle,
              sectionContent: body.sectionContent,
              topic: body.topic,
              genre: body.genre,
              currentParagraph: body.currentParagraph,
              precedingParagraphs: body.precedingParagraphs,
              charactersInScene: body.charactersInScene,
              location: body.location,
              knowledgeBaseContext: body.knowledgeBaseContext,
              blockType: body.blockType,
              blockReason: body.blockReason,
              atmosphere: body.atmosphere,
              writingTips: body.writingTips,
              promptCount: body.promptCount,
              text: body.text,
              styleProfile: body.styleProfile,
              skillId: body.skillId,
              extraContext: body.extraContext,
              enhancedContext,
              previousChapters: body.previousChapters,
            };

            // ★ 长流自动重试：推理模型输出慢，中转/代理链路偶发中途掐断
            //   （UND_ERR_SOCKET other side closed）。只要还没向客户端输出过正文，
            //   就自动重连重试一次（已流出的思考增量会在客户端重复累积，可接受）。
            let contentEmitted = false;
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                const gen = runChatAgentSimpleStream(chatStream, simpleInput, { signal });
                for await (const chunk of gen) {
                  if (chunk.thinking) {
                    send({ thinking: chunk.thinking });
                  }
                  if (chunk.content) {
                    contentEmitted = true;
                    send({ chunk: chunk.content });
                  }
                }
                break; // 正常结束
              } catch (streamErr) {
                const aborted = isAbortError(streamErr);
                if (attempt < 2 && !contentEmitted && !aborted) {
                  console.warn('[chat-stream] 上游流中断且正文未输出，自动重试一次:', streamErr instanceof Error ? streamErr.message : streamErr);
                  continue;
                }
                throw streamErr;
              }
            }
            send({ done: true });
          }
        } catch (err: unknown) {
          const message = isAbortError(err)
            ? '请求已取消'
            : safeInternal(err, '流式对话失败', '[chat-stream]');
          send({ error: true, message });
        } finally {
          clearInterval(heartbeat);
          if (!closed) {
            closed = true;
            try { controller.close(); } catch { /* 已关闭 */ }
          }
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  );
});

aiRouter.post('/generate-character', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', generateCharacterSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'plot');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof generateCharacterSchema>;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一个专业的小说角色设计师。请根据用户的需求，创建一个详细的角色设定。只输出 JSON，不要其他文字。',
    },
    {
      role: 'user' as const,
      content: `请为以下需求生成角色设定：
需求描述：${body.description}
${body.genre ? `体裁：${body.genre}` : ''}
${body.context ? `故事背景：${body.context}` : ''}

请按以下 JSON 格式输出（只输出 JSON）：
{
  "name": "角色名",
  "aliases": ["别名"],
  "gender": "性别",
  "age": "年龄",
  "appearance": "外貌描述",
  "personality": "性格描述",
  "backstory": "背景故事",
  "desire": "核心欲望",
  "fear": "核心恐惧",
  "belief": "核心信念",
  "weakness": "致命弱点",
  "speechStyle": "说话风格/口头禅",
  "relations": [{"target": "关联角色名", "type": "关系类型", "description": "关系描述"}]
}`,
    },
  ];

  const response = await chat(messages, { temperature: 0.8, maxTokens: 8192 }, signal);

  const cleaned = response
    .replace(/```json?\n?/g, '')
    .replace(/```/g, '')
    .trim();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(cleaned || '{}');
  } catch {
    data = { raw: response };
  }

  return c.json({ success: true, data });
});

aiRouter.post('/generate-plot', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', generatePlotSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'plot');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof generatePlotSchema>;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一个专业的小说情节设计师。请根据用户提供的上下文，生成有创意且合理的情节发展。只输出 JSON，不要其他文字。',
    },
    {
      role: 'user' as const,
      content: `请为以下上下文生成情节建议：
需求描述：${body.description}
${body.projectName ? `项目：${body.projectName}` : ''}
${body.genre ? `体裁：${body.genre}` : ''}
${body.charactersJson ? `角色列表：${body.charactersJson}` : ''}
${body.foreshadowsJson ? `已铺设伏笔：${body.foreshadowsJson}` : ''}
${body.currentSummary ? `当前剧情摘要：${body.currentSummary}` : ''}

请按以下 JSON 格式输出情节建议（只输出 JSON）：
{
  "title": "情节标题",
  "summary": "情节摘要（200字以内）",
  "stages": [
    {
      "name": "阶段名（如起因/发展/高潮/结局）",
      "description": "阶段描述",
      "characters": ["涉及角色"],
      "keyEvents": ["关键事件"],
      "foreshadowHints": ["伏笔暗示"]
    }
  ],
  "themes": ["相关主题"],
  "tone": "情感基调",
  "plotTwists": ["可能的转折"],
  "alternativeEndings": ["备选结局"]
}`,
    },
  ];

  const response = await chat(messages, { temperature: 0.8, maxTokens: 8192 }, signal);

  const cleaned = response
    .replace(/```json?\n?/g, '')
    .replace(/```/g, '')
    .trim();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(cleaned || '{}');
  } catch {
    data = { raw: response };
  }

  return c.json({ success: true, data });
});

const timelineAnalysisSchema = z.object({
  events: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    chapter: z.number().int().min(0).nullish(),
    type: z.enum(['event', 'foreshadow', 'state_change']),
    characterIds: z.array(z.string()).optional(),
    order: z.number().int().min(0),
    color: z.string().optional(),
  })),
  characters: z.array(z.object({
    id: z.string(),
    name: z.string(),
    color: z.string().optional(),
  })).optional(),
  projectName: z.string().optional(),
});

aiRouter.post('/analyze-timeline', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', timelineAnalysisSchema), async (c) => {
  const user = c.get('user');
  const frozen = await checkFeatureFrozen(c, user?.id, 'timeline');
  if (frozen) return frozen;

  const body = c.req.valid('json') as z.infer<typeof timelineAnalysisSchema>;
  const chat = await getChat(user?.id);
  const signal = c.req.raw.signal;

  const result = await runTimelineAnalysis(chat, {
    events: body.events,
    characters: body.characters,
    projectName: body.projectName,
  }, { signal });

  return c.json({ success: true, data: result });
});

// ============================================================
// AI 网关路由 - 统一入口
//
// POST /api/ai/gateway - 统一 AI 功能入口
//   - 检查用户功能冻结状态
//   - 分发到对应 Agent 执行
// ============================================================


const gatewaySchema = z.object({
  feature: z.enum(['chat', 'extract', 'consistency', 'style', 'quick-phrases']),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** 用户 AI 功能设置类型 */
interface UserAISettings {
  chat: boolean;
  extract: boolean;
  consistency: boolean;
  style: boolean;
  scanner: boolean;
  rhythm: boolean;
  timeline: boolean;
  plot: boolean;
  'quick-phrases': boolean;
}

/** 默认设置（所有功能开启） */
const DEFAULT_AI_SETTINGS: UserAISettings = {
  chat: true,
  extract: true,
  consistency: true,
  style: true,
  scanner: true,
  rhythm: true,
  timeline: true,
  plot: true,
  'quick-phrases': true,
};

/**
 * 获取用户的 AI 功能设置
 * 从数据库 user_settings 表读取，若不存在则返回默认值（全部开启）
 */
async function getUserAISettings(userId: string): Promise<UserAISettings> {
  try {
    const db = getDb();
    if (!db) {
      return { ...DEFAULT_AI_SETTINGS };
    }

    const rows = db.select({ aiFeatures: schema.userSettings.aiFeatures })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .all();

    if (rows.length > 0 && rows[0]?.aiFeatures) {
      const parsed = typeof rows[0].aiFeatures === 'string'
        ? JSON.parse(rows[0].aiFeatures)
        : rows[0].aiFeatures;
      return { ...DEFAULT_AI_SETTINGS, ...parsed };
    }

    return { ...DEFAULT_AI_SETTINGS };
  } catch (error) {
    console.warn(`[AI Gateway] 获取用户 ${userId} 的 AI 设置失败，使用默认值:`, error);
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/**
 * 检查功能是否被冻结（红石开关）。
 * 若该 feature 在用户设置中被关闭，返回 200 冻结响应；否则返回 null。
 */
async function checkFeatureFrozen(
  c: Context,
  userId: string | undefined,
  feature: keyof UserAISettings,
): Promise<Response | null> {
  if (!userId) return null;
  const settings = await getUserAISettings(userId);
  if (settings[feature] === false) {
    return c.json({ skipped: true, reason: '功能已关闭' }, 200);
  }
  return null;
}

/**
 * Agent 路由表：功能名 -> Agent 模块路径和执行函数名
 */
interface AgentRoute {
  modulePath: string;
  functionName: string;
}

const AGENT_ROUTES: Record<string, AgentRoute> = {
  chat: { modulePath: '../ai/agents/chat-agent.js', functionName: 'runChatAgent' },
  extract: { modulePath: '../ai/agents/entity-extract-agent.js', functionName: 'runExtract' },
  consistency: { modulePath: '../ai/agents/consistency-agent.js', functionName: 'runConsistencyCheck' },
  style: { modulePath: '../ai/agents/style-agent.js', functionName: 'runStyleAnalysis' },
  'quick-phrases': { modulePath: '../ai/agents/quick-phrase-agent.js', functionName: 'runQuickPhraseExtract' },
};

aiRouter.post('/gateway', requireAuth, ensureConfigMiddleware, aiRateLimit, zValidator('json', gatewaySchema), async (c) => {
  const body = c.req.valid('json') as z.infer<typeof gatewaySchema>;
  const { feature, payload } = body;

  const user = c.get('user');
  if (!user?.id) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  }

  // 1. 检查功能是否被冻结
  const settings = await getUserAISettings(user.id);
  if (settings[feature] === false) {
    return new Response(JSON.stringify({ skipped: true, reason: 'feature_frozen' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const signal = c.req.raw.signal;

  // 其他功能：走 TS Agent 路由
  const route = AGENT_ROUTES[feature];
  if (!route) {
    return c.json({ error: { code: 'NOT_FOUND', message: `未知的功能: ${feature}` } }, 404);
  }

  try {
    const agentModule = await import(route.modulePath);
    const runAgent = agentModule[route.functionName];

    if (typeof runAgent !== 'function') {
      return c.json({
        error: { code: 'INTERNAL_ERROR', message: `Agent 函数 ${route.functionName} 不存在` },
      }, 500);
    }

    const chat = await getProvider(user.id).then((p) => p.chat.bind(p));

    const result = await runAgent(chat, payload ?? {}, { signal });

    return c.json({ success: true, data: result });
  } catch (error) {
    // AbortError -> 返回 200 + skipped body
    if (isAbortError(error)) {
      return new Response(JSON.stringify({ skipped: true, reason: 'aborted' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 其他错误 -> 服务端打印完整错误，客户端仅收到脱敏提示
    const message = safeInternal(error, 'AI 功能执行失败，请稍后重试', `[AI Gateway /${feature}]`);
    return c.json({
      error: { code: 'AI_AGENT_ERROR', message },
    }, 500);
  }
});


// ============================================================
// AI 配置管理
//
// GET  /api/ai/config      - 获取当前用户 AI Provider 配置
// POST /api/ai/config      - 保存 AI Provider 配置
// POST /api/ai/config/test - 测试 AI Provider 连接
// ============================================================

import { setConfigLoader, clearConfigCache, clearProviderCache, getAIConfig } from '../ai/providers/provider-factory.js';

/**
 * 脱敏 apiKey：仅露出后 4 位，前缀以 *** 替代。
 * 旧实现 slice(0,8) 对短 key（< 8 字符）会返回完整 key，存在泄漏风险。
 */
function maskApiKey(apiKey: string | undefined | null): string {
  return apiKey ? '***' + apiKey.slice(-4) : '';
}

/** 生成参数：从配置对象里挑出已设的值（未设 / null = 不下发，前端显示为空） */
function samplingOf(cfg: {
  temperature?: number | null; topP?: number | null;
  frequencyPenalty?: number | null; presencePenalty?: number | null;
}) {
  return {
    ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
    ...(typeof cfg.topP === 'number' ? { topP: cfg.topP } : {}),
    ...(typeof cfg.frequencyPenalty === 'number' ? { frequencyPenalty: cfg.frequencyPenalty } : {}),
    ...(typeof cfg.presencePenalty === 'number' ? { presencePenalty: cfg.presencePenalty } : {}),
  };
}

/** 对外配置 DTO：完整 API Key 永不离开服务端。label 仅用于前端展示（如内置公益站）。 */
function publicAIConfig(
  config: Pick<AIConfig, 'baseUrl' | 'model' | 'provider' | 'apiKey'> & {
    temperature?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number;
  },
  source: string,
  label?: string,
) {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    provider: config.provider,
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyHint: maskApiKey(config.apiKey),
    _source: source,
    ...(label ? { label } : {}),
    // 生成参数（作者可调；未设为缺省，前端按「不干预」处理）
    ...samplingOf(config),
  };
}

/** AI Provider 配置 Schema */
const providerConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  provider: z.enum(['openai', 'ollama', 'custom']).optional(),
  /** 生成参数：范围按 OpenAI 兼容 API 的合法区间收口（越界直接 400，别等模型报错）。
   *  `.nullable()`：显式传 null = 清除该项，恢复服务商默认（前端清空输入框时用）。 */
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  frequencyPenalty: z.number().min(-2).max(2).nullable().optional(),
  presencePenalty: z.number().min(-2).max(2).nullable().optional(),
  /** 只有显式传 true 才清除服务端保存的 Key */
  clearApiKey: z.boolean().optional(),
});

/**
 * GET /api/ai/config - 获取当前用户的 AI Provider 配置
 * 返回：{ success, data: { baseUrl, apiKey(脱敏), model, provider } }
 */
aiRouter.get('/config', requireAuth, ensureConfigMiddleware, async (c) => {
  const user = c.get('user');
  if (!user?.id) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  }

    try {
      const db = getDb();
      if (!db) {
        // 数据库不可用，返回服务端默认配置
        const defaultConfig = await getAIConfig(user.id);
        const builtinActive = isBuiltinRelayKey(defaultConfig.apiKey);
        return c.json({
          success: true,
          data: publicAIConfig(defaultConfig, builtinActive ? 'builtin_relay' : 'server_env', builtinActive ? BUILTIN_RELAY_LABEL : undefined),
        });
      }

    const rows = db.select({ aiProviderConfig: schema.userSettings.aiProviderConfig })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, user.id))
      .all();

    if (rows.length > 0 && rows[0]?.aiProviderConfig) {
      const cfg = rows[0].aiProviderConfig as z.infer<typeof providerConfigSchema>;
      return c.json({
        success: true,
        data: publicAIConfig({
          baseUrl: cfg.baseUrl ?? '',
          model: cfg.model ?? '',
          provider: cfg.provider ?? 'openai',
          apiKey: cfg.apiKey ?? '',
          ...samplingOf(cfg),
        }, 'user_db'),
      });
    }

    // 无用户配置，返回服务端默认配置
    const defaultConfig = await getAIConfig(user.id);
    const builtinActive = isBuiltinRelayKey(defaultConfig.apiKey);
    return c.json({
      success: true,
      data: publicAIConfig(defaultConfig, builtinActive ? 'builtin_relay' : 'server_env', builtinActive ? BUILTIN_RELAY_LABEL : undefined),
    });
  } catch (error) {
    console.error('[AI Config] 获取配置失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '获取 AI 配置失败' } }, 500);
  }
});

/**
 * POST /api/ai/config - 保存当前用户的 AI Provider 配置
 * 配置保存后会自动刷新 Provider 缓存
 */
aiRouter.post('/config', requireAuth, ensureConfigMiddleware, zValidator('json', providerConfigSchema), async (c) => {
  const user = c.get('user');
  if (!user?.id) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  }

  const body = c.req.valid('json') as z.infer<typeof providerConfigSchema>;

  // C8：保存时即校验 SSRF——被拦截的 baseUrl 直接拒绝保存（即时反馈，
  // 避免「保存成功但所有 AI 调用失败」的困惑）
  if (body.baseUrl) {
    try {
      // ★ 深度校验：同步规则 + DNS 解析级检查（拦截解析到内网/元数据地址的域名）
      await assertSafeOutboundUrlDeep(body.baseUrl);
    } catch (error) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: error instanceof Error ? error.message : 'AI baseUrl 不合法',
          },
        },
        400,
      );
    }
  }

  try {
    const db = getDb();
    if (!db) {
      return c.json({ error: { code: 'DB_ERROR', message: '数据库不可用' } }, 500);
    }

    const now = new Date();

    // 获取已有配置（保留未传字段）
    const existing = db.select({ aiProviderConfig: schema.userSettings.aiProviderConfig })
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, user.id))
      .all();

    const existingConfig = existing.length > 0 && existing[0]?.aiProviderConfig
      ? existing[0].aiProviderConfig as {
          baseUrl?: string; apiKey?: string; model?: string; provider?: string;
          temperature?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number;
        }
      : {};
    const {
      clearApiKey, apiKey, temperature, topP, frequencyPenalty, presencePenalty, ...configPatch
    } = body;
    const mergedConfig: {
      baseUrl?: string; apiKey?: string; model?: string; provider?: string;
      temperature?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number;
    } = {
      ...existingConfig,
      ...configPatch,
    };
    // 生成参数：number = 设置；null = 显式清除（恢复默认）；undefined = 不改（保留旧值）
    const applySampling = (key: 'temperature' | 'topP' | 'frequencyPenalty' | 'presencePenalty', v: number | null | undefined) => {
      if (v === null) delete mergedConfig[key];
      else if (typeof v === 'number') mergedConfig[key] = v;
    };
    applySampling('temperature', temperature);
    applySampling('topP', topP);
    applySampling('frequencyPenalty', frequencyPenalty);
    applySampling('presencePenalty', presencePenalty);
    if (clearApiKey) {
      delete mergedConfig.apiKey;
    } else if (apiKey !== undefined && apiKey.trim()) {
      mergedConfig.apiKey = apiKey.trim();
    }

    // 写入数据库
    if (existing.length > 0) {
      db.update(schema.userSettings)
        .set({
          aiProviderConfig: mergedConfig,
          updatedAt: now,
        })
        .where(eq(schema.userSettings.userId, user.id))
        .run();
    } else {
      db.insert(schema.userSettings)
        .values({
          userId: user.id,
          aiProviderConfig: mergedConfig,
          aiFeatures: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // ★ 强制立即持久化到磁盘（sql.js 是内存数据库，必须手动 saveToDisk）
    // 之前缺少此调用导致服务器重启后 AI 配置全部丢失
    await saveToDisk(true);

    // 设置该用户的配置加载器（按 userId 隔离，避免跨用户泄漏）
    setConfigLoader(user.id, async () => {
      const db2 = getDb();
      if (!db2) {
        throw new Error('数据库不可用');
      }
      const rows = db2.select({ aiProviderConfig: schema.userSettings.aiProviderConfig })
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, user.id))
        .all();
      if (rows.length > 0 && rows[0]?.aiProviderConfig) {
        const cfg = rows[0].aiProviderConfig as {
          baseUrl?: string; apiKey?: string; model?: string; provider?: string;
          temperature?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number;
        };
        return applyBuiltinRelayFallback({
          baseUrl: cfg.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || '',
          model: cfg.model || process.env.OPENAI_MODEL || 'gpt-4-turbo',
          provider: (cfg.provider as 'openai' | 'ollama' | 'custom') || 'openai',
          ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
          ...(typeof cfg.topP === 'number' ? { topP: cfg.topP } : {}),
          ...(typeof cfg.frequencyPenalty === 'number' ? { frequencyPenalty: cfg.frequencyPenalty } : {}),
          ...(typeof cfg.presencePenalty === 'number' ? { presencePenalty: cfg.presencePenalty } : {}),
        });
      }
      // 回退到环境变量
      const provider = (process.env.AI_PROVIDER || 'openai') as 'openai' | 'ollama' | 'custom';
      let baseUrl: string;
      let apiKey: string;
      let model: string;
      switch (provider) {
        case 'ollama':
          baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
          apiKey = 'ollama';
          model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
          break;
        case 'custom':
          baseUrl = process.env.CUSTOM_AI_BASE_URL || 'https://api.openai.com/v1';
          apiKey = process.env.CUSTOM_AI_API_KEY || '';
          model = process.env.CUSTOM_AI_MODEL || 'gpt-4-turbo';
          break;
        default:
          baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
          apiKey = process.env.OPENAI_API_KEY || '';
          model = process.env.OPENAI_MODEL || 'gpt-4-turbo';
          break;
      }
      return applyBuiltinRelayFallback({ baseUrl, apiKey, model, provider });
    });

    // 刷新该用户的缓存
    clearConfigCache(user.id);
    clearProviderCache(user.id);

    return c.json({
      success: true,
      data: publicAIConfig({
        baseUrl: mergedConfig.baseUrl ?? '',
        model: mergedConfig.model ?? '',
        provider: (mergedConfig.provider as AIConfig['provider']) ?? 'openai',
        apiKey: mergedConfig.apiKey ?? '',
        ...samplingOf(mergedConfig),
      }, 'user_db'),
    });
  } catch (error) {
    console.error('[AI Config] 保存配置失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '保存 AI 配置失败' } }, 500);
  }
});

/**
 * GET /api/ai/skills - 技能列表（内置 + 插件注册）
 *
 * 前端技能选择器的唯一内容源：name/description/contextKeys 均以后端注册表为准，
 * 前端只保留 id → 图标映射。插件经 ctx.ai.skills.register 注册的技能会出现在这里，
 * 无需改动前端代码。
 */
aiRouter.get('/skills', requireAuth, (c) => {
  return c.json({ skills: listSkillMetas() });
});

// ============================================================
// 集中式 Skills 库 + 每个智能体的技能开关
//
// 设计见 docs/architecture/skills-library.md。三处入口对应三个问题：
//   · 库里有什么、归属谁     → /skill-library
//   · 装了/删了              → /skill-library/install、/skill-library/:id
//   · 某个智能体开了哪些     → /skill-targets、/skill-targets/:agentId、.../toggle
//
// 与上层 `/skills`（运行时注册表）的分工：注册表回答"这轮对话能激活什么"，
// 本库回答"这些技能归属谁、开着还是关着"。
// ============================================================

/**
 * GET /api/ai/skill-market —— 技能市场（公共目录 + 「我装没装」）
 *
 * ★ 2026-09-17 新增。作者要求「要能浏览公共技能源」。
 *   目录当前是内置常量（见 services/skill-catalog.ts），接远程源时只换那一处实现。
 *   从市场装的技能是**当前用户的私有技能**，不是公共的。
 */
aiRouter.get('/skill-market', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  try {
    const entries = await listMarket(user.id);
    return c.json({
      data: {
        entries,
        byCategory: {
          assistant: entries.filter((e) => e.category === 'assistant'),
          agent: entries.filter((e) => e.category === 'agent'),
        },
      },
    });
  } catch (error) {
    console.error('[skill-market] 读取失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '读取技能市场失败' } }, 500);
  }
});

/** GET /api/ai/skill-library —— 库里的全部技能（按两类分开给，前端不必再分组） */aiRouter.get('/skill-library', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  try {
    // ★ 2026-09-17：只返回「公共的 + 我自己的」—— 别人上传的私有技能不该出现
    const skills = await listLibrary(user.id);
    const orphans = await listOrphanOwners(user.id);
    return c.json({
      data: {
        skills,
        // ★ 分类存放是硬口径：前端按这两栏渲染，不要在前端重新判 category
        byCategory: {
          assistant: skills.filter((s) => s.category === 'assistant'),
          agent: skills.filter((s) => s.category === 'agent'),
        },
        /** 归属写了但清单没声明 —— 不报出来就是"装了却看不见、且不知道为什么" */
        orphans,
      },
    });
  } catch (error) {
    console.error('[skill-library] 读取失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '读取技能库失败' } }, 500);
  }
});

/** POST /api/ai/skill-library/install —— 安装（或重装）一个技能 */
aiRouter.post('/skill-library/install', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    // ★ 2026-09-17：用户从界面装的技能是**他私有的**（带 userId → id 加命名空间）。
    //   公共技能只由内置/插件种子路径写（那条路不传 userId）。
    const skill = await installSkill({
      id: String(body.id ?? ''),
      name: String(body.name ?? ''),
      description: body.description === undefined ? undefined : String(body.description),
      color: body.color === undefined ? undefined : String(body.color),
      iconKey: body.iconKey === undefined ? undefined : String(body.iconKey),
      category: (body.category === 'assistant' ? 'assistant' : 'agent'),
      ownerAgent: body.ownerAgent === undefined || body.ownerAgent === null ? null : String(body.ownerAgent),
      systemPrompt: body.systemPrompt === undefined ? undefined : String(body.systemPrompt),
      contextKeys: Array.isArray(body.contextKeys) ? body.contextKeys.map((x) => String(x)) : undefined,
    }, user.id);
    return c.json({ data: skill }, 201);
  } catch (error) {
    // 安装失败基本都是**输入问题**（id 非法 / 未知智能体 / 缺归属），按 400 回，
    // 并把原因原样给作者 —— 这里吞掉原因等于让人对着 500 猜。
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: 'BAD_REQUEST', message } }, 400);
  }
});

/** DELETE /api/ai/skill-library/:id —— 删除（连带清掉所有开关记录） */
aiRouter.delete('/skill-library/:id', requireAuth, async (c) => {
  // 本版 Hono 的 param() 类型是 string | undefined —— 缺了要显式兜住
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: { code: 'BAD_REQUEST', message: '缺少技能 id' } }, 400);
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  try {
    // ★ 2026-09-17：私有技能只有主人能删（服务层校验归属后返回 false）
    const ok = await removeSkill(id, user.id);
    if (!ok) return c.json({ error: { code: 'NOT_FOUND', message: `技能库中没有 ${id}` } }, 404);
    return c.json({ data: { id, removed: true } });
  } catch (error) {
    console.error('[skill-library] 删除失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '删除技能失败' } }, 500);
  }
});

/** GET /api/ai/skill-targets —— 全部智能体 + 各自的技能计数（面板左列） */
aiRouter.get('/skill-targets', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  try {
    const targets = await listTargets(user.id);
    return c.json({ data: { targets } });
  } catch (error) {
    console.error('[skill-targets] 读取失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '读取智能体清单失败' } }, 500);
  }
});

/** GET /api/ai/skill-targets/:agentId —— 该智能体的技能 + 开关状态（面板右列） */
aiRouter.get('/skill-targets/:agentId', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  const agentId = c.req.param('agentId') ?? '';
  try {
    const view = await getTargetSkills(agentId, user.id);
    if (!view) return c.json({ error: { code: 'NOT_FOUND', message: `未知智能体 ${agentId}` } }, 404);
    return c.json({ data: view });
  } catch (error) {
    console.error('[skill-targets] 读取失败:', error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '读取该智能体的技能失败' } }, 500);
  }
});

/**
 * PUT /api/ai/skill-targets/:agentId/toggle —— 开/关某个技能（左关右开那个开关）
 * body: { skillId, enabled }
 */
aiRouter.put('/skill-targets/:agentId/toggle', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  const agentId = c.req.param('agentId') ?? '';
  const body = await c.req.json().catch(() => ({})) as { skillId?: string; enabled?: unknown };
  if (!body.skillId) return c.json({ error: { code: 'BAD_REQUEST', message: '缺少 skillId' } }, 400);
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'enabled 必须是布尔值（开关只有开与关两态）' } }, 400);
  }
  try {
    const r = await setToggle({ userId: user.id, agentId, skillId: String(body.skillId), enabled: body.enabled });
    return c.json({ data: r });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: 'BAD_REQUEST', message } }, 400);
  }
});

/** PUT /api/ai/skill-targets/:agentId/toggle-all —— 批量开/关（面板上的「全部开启」） */
aiRouter.put('/skill-targets/:agentId/toggle-all', requireAuth, async (c) => {
  const user = c.get('user');
  if (!user?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  const agentId = c.req.param('agentId') ?? '';
  const body = await c.req.json().catch(() => ({})) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'enabled 必须是布尔值' } }, 400);
  }
  try {
    const n = await setAllToggles({ userId: user.id, agentId, enabled: body.enabled });
    return c.json({ data: { agentId, enabled: body.enabled, count: n } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: { code: 'BAD_REQUEST', message } }, 400);
  }
});

/**
 * GET /api/ai/models - 获取可用模型列表
 * 代理调用 LLM Provider 的 /v1/models 端点
 */
aiRouter.get('/models', requireAuth, ensureConfigMiddleware, async (c) => {
  const user = c.get('user');
  if (!user?.id) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  }

  let config: AIConfig | undefined;
  try {
    // 先尝试从用户配置初始化 Provider
    const db = getDb();
    if (db) {
      const rows = db.select({ aiProviderConfig: schema.userSettings.aiProviderConfig })
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, user.id))
        .all();

      if (rows.length > 0 && rows[0]?.aiProviderConfig) {
        const cfg = rows[0].aiProviderConfig as { baseUrl?: string; apiKey?: string; model?: string; provider?: string };
        setConfigLoader(user.id, async () => ({
          baseUrl: cfg.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || '',
          model: cfg.model || process.env.OPENAI_MODEL || 'gpt-4-turbo',
          provider: (cfg.provider as 'openai' | 'ollama' | 'custom') || 'openai',
        }));
        clearConfigCache(user.id);
        clearProviderCache(user.id);
      }
    }

    config = await getAIConfig(user.id);
    // getAIConfig 已规范化 baseUrl（自动补 /v1）
    // 此处直连 fetch 未经 provider-factory，需自行做 SSRF 校验：
    // 配置可能来自保存期校验之前的历史记录或环境变量。
    assertSafeOutboundUrl(config.baseUrl);
    const modelsUrl = `${config.baseUrl}/models`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    try {
      const headers: Record<string, string> = {};
      if (config.provider !== 'ollama') {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        // 针对中转站常见错误给出更精准的提示
        let hint = '';
        if (response.status === 401 || response.status === 403) {
          hint = '（API Key 无效或无权访问该端点，请检查密钥是否正确）';
        } else if (response.status === 404) {
          hint = '（路径不存在：中转站可能不支持 /models 端点，或 baseUrl 缺少 /v1 路径前缀）';
        } else if (response.status === 405) {
          hint = '（方法不允许：该端点可能不开放 GET /models，请改用手动输入模型名）';
        }
        return c.json({
          ok: false,
          status: response.status,
          error: `AI API 错误 ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}${hint}（请求地址：${modelsUrl}）`,
        });
      }

      // 兼容多种 /models 响应格式：
      //   - OpenAI 标准：{ data: [{ id: "gpt-4", ... }, ...] }
      //   - 部分中转站：{ models: [{ id: "..." }, ...] }
      //   - 极少数中转站：[{ id: "..." }, ...]（纯数组）
      //   - Ollama 原生：{ models: [{ name: "..." }, ...] }（用 name 而非 id）
      const raw = await response.json() as unknown;
      let modelItems: Array<{ id?: string; name?: string }> = [];
      if (Array.isArray(raw)) {
        modelItems = raw as Array<{ id?: string; name?: string }>;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as { data?: unknown; models?: unknown };
        if (Array.isArray(obj.data)) {
          modelItems = obj.data as Array<{ id?: string; name?: string }>;
        } else if (Array.isArray(obj.models)) {
          modelItems = obj.models as Array<{ id?: string; name?: string }>;
        }
      }
      const models = modelItems
        .map((m) => {
          const id = (m && typeof m === 'object' && 'id' in m ? String((m as { id?: unknown }).id) : '') ||
                     (m && typeof m === 'object' && 'name' in m ? String((m as { name?: unknown }).name) : '');
          return id ? { id, name: id } : null;
        })
        .filter((m): m is { id: string; name: string } => m !== null);

      return c.json({ ok: true, models });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const message = diagnoseFetchError(error, config?.baseUrl);
    return c.json({ ok: false, error: message });
  }
});

/**
 * POST /api/ai/config/test - 测试 AI Provider 连接
 * 向 AI API 发送简单请求验证连通性
 */
aiRouter.post('/config/test', requireAuth, ensureConfigMiddleware, async (c) => {
  const user = c.get('user');
  if (!user?.id) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: '未认证' } }, 401);
  }

  let config: AIConfig | undefined;
  try {
    // 先尝试从用户配置初始化 Provider
    const db = getDb();
    if (db) {
      const rows = db.select({ aiProviderConfig: schema.userSettings.aiProviderConfig })
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, user.id))
        .all();

      if (rows.length > 0 && rows[0]?.aiProviderConfig) {
        const cfg = rows[0].aiProviderConfig as { baseUrl?: string; apiKey?: string; model?: string; provider?: string };
        // 临时设置该用户的加载器（按 userId 隔离）
        setConfigLoader(user.id, async () => ({
          baseUrl: cfg.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || '',
          model: cfg.model || process.env.OPENAI_MODEL || 'gpt-4-turbo',
          provider: (cfg.provider as 'openai' | 'ollama' | 'custom') || 'openai',
        }));
        clearConfigCache(user.id);
        clearProviderCache(user.id);
      }
    }

    config = await getAIConfig(user.id);
    const provider = await getProvider(user.id);
    const startTime = Date.now();

    const response = await provider.chat(
      [{ role: 'user', content: 'Hi' }],
      // ★ 连通性探测不能用极小预算：推理模型（reasoning）会先把预算烧在思维链上，
      //   maxTokens=10 时正文 content 为空且 finish_reason='length'，会被 provider 层
      //   的「截断保护」判为失败 → connected=false 误报（实际链路是通的）。
      //   探测只需确认能收到响应，故给足余量。
      { temperature: 0.1, maxTokens: 256 }
    );

    const latencyMs = Date.now() - startTime;

    return c.json({
      success: true,
      data: {
        connected: true,
        latencyMs,
        response: response.slice(0, 100),
      },
    });
  } catch (error) {
    const message = diagnoseFetchError(error, config?.baseUrl);
    return c.json({
      success: false,
      data: {
        connected: false,
        error: message,
      },
    });
  }
});

export default aiRouter;
