// ============================================================
// Server 插件宿主 —— 基于 @deepseek-ai/cordis 的基座装配
//
// v2（Cordis 底座版）：不再使用自研 PluginHost。
//   - 内核：真实 cordis（Context / ctx.plugin / ctx.effect / fiber）
//   - HTTP：DSH 的 dsh-host-webserver 服务（exact/prefix 动态路由 + disposer）
//   - 全部业务模块 = cordis 插件：{ name, inject, apply(ctx) }
//   - 兼容面：ctx.routes / ctx.db / ctx.ai / ctx.events / ctx.effect / ctx.logger
//     （与旧 ServerPluginContext 契约一致，插件代码无需改动）
// ============================================================

import { Hono } from 'hono';
import type { IncomingMessage, ServerResponse } from 'http';
import { Context, type Plugin } from '@deepseek-ai/cordis';
import { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { honoListener } from '../lib/hono-adapter.js';
import { createApp } from '../lib/app-factory.js';
import { requireAuth } from '../middleware/auth.js';
import { verifyProjectOwnership } from '../lib/ownership.js';
import { getDb, getProjectDbSync, initProjectDb, schema, eq } from '@novel/db';
import { EventBus } from '@novel/core';
import {
  HookBus,
  analyzeDependencies,
  sortByDependencies,
  checkManifestPolicy,
  validateManifest,
  pluginAppliesToProjectMode,
  INSTALL_STANDARD_VERSION,
  SERVER_SERVICES,
  type PluginEntry,
  type PluginManifest,
  type PluginModule,
  type PluginMode,
  type ProjectMode,
  type ServerPluginContext,
  type DependencyAnalysis,
} from '@novel/core';
import { registerTool, unregisterTool, getAllToolDefinitions, markPluginTool } from '../ai/tools/registry.js';
import { registerSkill, unregisterSkill, SKILLS } from '../ai/agents/skills.js';
import { declareSkillTarget, undeclareSkillTarget, listSkillTargets } from '../ai/agents/skill-targets.js';
import { listEnabledSkills } from '../services/skill-library.js';
import { Agent, Runner, MaxTurnsExceededError } from '@openai/agents';
import { getAIConfig } from '../ai/providers/provider-factory.js';
import { ensureConfigMiddleware } from '../ai/user-config-loader.js';
import { getSdkProvider, runWithThinkingSink } from '../ai/agents/sdk/provider.js';
import { getAllSdkTools, type NovelAgentContext } from '../ai/agents/sdk/tools.js';
import { createSqliteKvService } from './kv-service.js';
import { createStaticFallback } from './frontend-static.js';
import { createPluginGuardian, createGuardedPluginHandle, attributeBuiltinRoutes, type GuardianSnapshot } from './guardian.js';

export interface ServerPluginHostOptions {
  port?: number;
  host?: '127.0.0.1' | '0.0.0.0';
  kv?: import('@novel/core').KvService;
  disabledIds?: string[];
  /**
   * 宿主模式（HOST_MODE 环境变量）：'manual' | 'auto' | 'all'。
   * 缺省/非法值 = 'all'（挂载全部插件）。设为 manual/auto 时，仅挂载
   * modes 含该模式或 'shared' 的插件；被过滤者记入状态表 status='skipped'。
   */
  hostMode?: HostMode;
}

export interface PluginStatusItem {
  id: string;
  name: string;
  status: 'ok' | 'error' | 'disabled' | 'skipped';
  error?: string;
  order: number;
  enabled: boolean;
  /** 来源（builtin | local | npm），便于诊断坏插件出处 */
  source: PluginEntry['source'];
  /** 适用创作模式（缺省视为 ['shared']）——供管理面/健康检查按模式区分插件 */
  modes?: PluginMode[];
  permissions: string[];
  dependsOn: string[];
  /** 守护器状态（仅非内置插件有：隔离中/已放行/已熔断） */
  guardian?: GuardianSnapshot;
}

/** 宿主模式：all = 挂载全部；manual/auto = 仅挂该模式 + shared 的插件 */
export type HostMode = 'manual' | 'auto' | 'all';

/** 解析 HOST_MODE 环境变量（未设/非法 → 'all'） */
export function normalizeHostMode(raw: string | undefined): HostMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'manual' || v === 'auto' ? v : 'all';
}

/** 从项目 id 读取创作模式（NULL/旧数据 → 'manual'）；项目不存在返回 null */
function projectModeOf(projectId: string): ProjectMode | null {
  try {
    const db = getDb();
    if (!db) return null;
    const row = db.select({ mode: schema.projects.mode })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get() as { mode: string | null } | undefined;
    if (!row) return null;
    return row.mode === 'auto' ? 'auto' : 'manual';
  } catch (err) {
    console.warn(`[cordis-host] 读取项目模式失败 (${projectId}):`, err);
    return null;
  }
}

export interface ServerPluginHost {
  readonly ctx: Context;
  readonly events: Context;
  readonly hooks: HookBus;
  mount(entries: PluginEntry[]): Promise<void>;
  start(opts?: { port?: number; host?: '127.0.0.1' | '0.0.0.0'; distIndex?: string }): Promise<{ port: number; url: string }>;
  getPluginStatus(): PluginStatusItem[];
  setPluginEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  /** 手动放行（跳过剩余隔离期） */
  promotePlugin(id: string): { ok: boolean; error?: string };
  /** 重置守护计数回隔离态；被禁用的插件同时重新挂载启用 */
  requarantinePlugin(id: string): Promise<{ ok: boolean; error?: string; remounted: boolean }>;
  /** 守护器策略（放行/熔断阈值，供管理 UI 展示） */
  getGuardianPolicy(): { promoteAfterSessions: number; errorThreshold: number };
  addPluginEntry(entry: PluginEntry): Promise<{ ok: boolean; error?: string }>;
  /** 登记"安装门"拒绝的插件（如扫描器发现 manifest 非法），使其在 /api/health 与管理界面可见 */
  recordInstallRejections(items: Array<{ id: string; message: string }>): void;
  setInitialDisabled(ids: string[]): void;
  getDependencyAnalysis(): DependencyAnalysis;
  getDisabledIds(): string[];
  dispose(): Promise<void>;
}

/** 便捷工具：从 (id, prefix, load) 构造内置插件条目（Hono 模块 → cordis 插件） */
export function builtinEntry(
  id: string,
  prefix: string,
  load: () => Promise<{ default: any }>,
  extra?: Partial<PluginManifest>,
): PluginEntry {
  return {
    id,
    source: 'builtin',
    manifest: {
      id,
      name: id,
      version: '0.1.0',
      // ★ 内置 API 模块默认 shared（两模式共用）；显式 extra 可覆盖为 manual/auto
      modes: ['shared'],
      permissions: ['routes', 'db:project'],
      server: { inject: ['routes'] },
      ...extra,
    },
    load: async () => {
      const mod = await load();
      return {
        name: id,
        apply: (ctx: ServerPluginContext) => {
          ctx.routes.register(prefix, mod.default);
        },
      };
    },
  };
}

// ============================================================
// 宿主装配
// ============================================================

// ============================================================
// 子代理「输出预算被打穿」的取证与补救（2026-09-17）
//
// 为什么抽到模块顶层：这三样分别决定「要不要重试」与「重试给多少预算」——
// 判错一边的代价都是实打实的（重试盖住真错误，或整段白跑），必须能被单测钉住；
// 埋在 createServerPluginHost 的闭包里就测不到了。
// 与 sdk/provider.ts 把 reasoningDeltaOf 抽出来的理由完全一致。
// ============================================================

/**
 * 空转取证：从 SDK 的**公开流事件**判断这次 run 有没有产出过正文 / 发起过工具调用。
 *
 * 为什么需要它：推理模型的思考 token 也计入 max_tokens。某一轮思考一旦吃满额度，
 * 中转站会回 `content: null` + `finish_reason: length`，SDK 的 turnResolution 便认为
 * 「这一轮没结束」→ `next_step_run_again` → 再跑一轮 → …… 直到 `Max turns (N) exceeded`，
 * **整次调用作废**。2026-09-17 实测：cast 段前 4 个发言人全部正常，第 5 个「定稿官」
 * （要吞下整段 transcript，输入最长）就死在这里。
 * 用事件名（events.d.ts 的 RunItemStreamEventName）判断而**不读 SDK 私有字段** ——
 * 将来升级 SDK 最坏退化成「判不出来 = 不重试」，不会误判。
 */
export function noteStreamEvidence(ev: unknown, saw: { text: boolean; tool: boolean }): void {
  const e = ev as { type?: string; name?: string };
  if (e?.type !== 'run_item_stream_event') return;
  if (e.name === 'message_output_created') saw.text = true;
  else if (e.name === 'tool_called' || e.name === 'tool_search_called') saw.tool = true;
}

/**
 * 补救轮的 system 追加语。
 *
 * 为什么这句话有用：推理模型额度告急时，「先出答案、别展开」这类指令能明显压缩 reasoning
 * —— 同一个模型、同一个任务、同一个 temperature，reasoning 实测能在 4787 token 与 26 token
 * 之间波动，说明它**是可被指令影响的**。补救轮只许成功，宁可牺牲一点思考深度也要先拿到正文。
 */
export const STARVATION_RETRY_HINT = [
  '【输出预算告急 · 本次请直接作答】',
  '你上一轮的推理占满了全部输出额度，最终一个字都没有产出。',
  '这一次请**先写出最终答案**，把推理压到最短：不要复述任务、不要罗列思路、不要自我检查。',
].join('\n');

/**
 * 这次失败是否属于「轮次耗尽、但全程一个字正文都没产出」——也就是需要补救的那一类。
 *
 * ★ 为什么判定**只看 `saw.text`，不看 `saw.tool`**（2026-09-17 故障注入实测修正）：
 *   最初写成「零正文 **且** 零工具调用」，结果漏掉了真实的一类现场 ——
 *   **带工具的发言人**（如设定管家）预算被打穿时会先成功调一次查库工具
 *   （于是 `saw.tool=true`），之后每轮都拿不到正文，直到轮次耗尽。
 *   注入实测原文：`设定管家 → Max turns (6) exceeded`，而当时代码把它当"工具循环"放行了。
 *   反过来，**正常的工具流程最后一定会产出正文**（模型拿到工具结果后作答）⇒ `saw.text=true`
 *   ⇒ 不会误触发补救。所以「全程零正文」本身就是充分且必要的判据。
 *
 * 其余错误（网络 / 鉴权 / 工具本身抛错 / 结构化输出校验失败）一律不得重试 ——
 * 拿重试盖住真错误比失败本身更糟（2026-09-12「静默跳过比报错更危险」的教训）。
 */
export function isStarvationFailure(err: unknown, saw: { text: boolean; tool: boolean }): boolean {
  return err instanceof MaxTurnsExceededError && !saw.text;
}

/** 补救轮预算：不低于首次的 2 倍、至少 16384，上限 65536（防个别中转站拒收超大值） */
export function retryBudgetOf(first?: number): number {
  return Math.min(Math.max((first ?? 8192) * 2, 16384), 65536);
}

export function createServerPluginHost(options: ServerPluginHostOptions = {}): ServerPluginHost {
  const kv = options.kv ?? createSqliteKvService();
  const ctx = new Context();
  const hookBus = new HookBus();

  // ---- 状态 / fiber / 条目跟踪 ----
  const statuses = new Map<string, PluginStatusItem>();
  const fibers = new Map<string, { dispose(): unknown }>();
  const entriesById = new Map<string, PluginEntry>();
  const disabledIds = new Set<string>(options.disabledIds ?? []);
  let seq = 0;

  // ---- 宿主模式（HOST_MODE）：all（默认）/ manual / auto ----
  const hostMode: HostMode = options.hostMode ?? 'all';
  // 每个插件的适用模式（缺省 ['shared']）：HOST_MODE 过滤 + 运行时门禁就近读取
  const pluginModes = new Map<string, PluginMode[]>();

  const persistDisabled = async () => {
    try {
      await kv.set('novel.host', 'disabled-plugins', [...disabledIds]);
    } catch (err) {
      console.error('[cordis-host] 持久化禁用清单失败:', err);
    }
  };

  // ---- 插件守护器：非内置插件进隔离箱（错误归因 / 熔断 / 自动放行） ----
  let hostRef: ServerPluginHost | null = null;
  const guardian = createPluginGuardian({
    kv,
    onFuse: (pluginId) => {
      // 熔断 = 复用宿主禁用（dispose fiber，逆序清理插件注册的资源）
      void hostRef?.setPluginEnabled(pluginId, false).catch((err) => {
        console.error('[guardian] 熔断禁用 ' + pluginId + ' 失败:', err);
      });
    },
  });
  // 守护包装层兜底资源清理器（插件忘记 ctx.effect 包裹时熔断/禁用也能清干净）
  const guardedBags = new Map<string, () => void>();

  // ---- 根 Hono 应用（全局中间件 + 全部模块路由 + 健康检查） ----
  const rootApp = createApp();

  // ★ 插件禁用/熔断后的路由 active gate：
  //   Hono 已合并路由无法摘除（架构限制），但插件禁用/被守护器熔断时，
  //   其 fiber disposer 会把路由前缀加入 mutedRoutePrefixes，
  //   本中间件立即对这些前缀返回 404，不再等重启。仅作用于 /api/plugins/* 动态插件路由。
  const mutedRoutePrefixes = new Set<string>();
  /** 路由前缀 → 插件 id（供 /api/plugins/* 运行时模式门禁查该插件的 modes） */
  const routeModes = new Map<string, string>();
  (rootApp as Hono).use('/api/*', async (c, next) => {
    if (mutedRoutePrefixes.size > 0) {
      const path = new URL(c.req.url).pathname;
      for (const p of mutedRoutePrefixes) {
        if (path === p || path.startsWith(p + '/')) {
          return c.json({ error: { code: 'PLUGIN_DISABLED', message: '插件已禁用或熔断，该路由不可用' } }, 404);
        }
      }
    }
    await next();
  });

  const registeredPrefixes = new Set<string>();

  const routesService = {
    register(prefix: string, router: unknown, opts?: { pluginId?: string }): () => void {
      if (registeredPrefixes.has(prefix)) return () => undefined;
      // ★ 前缀边界：动态/本地插件（携带 pluginId）只允许注册 /api/plugins/{id}；
      //   /api/plugin-manager 等其他前缀仅限内置模块，防止插件劫持宿主或管理面。
      if (opts?.pluginId && !/^\/api\/plugins\/[a-z0-9][a-z0-9-]*$/.test(prefix)) {
        console.error(`[cordis-host] 插件 ${opts.pluginId} 试图注册非插件前缀路由 ${prefix}，已拒绝（仅允许 /api/plugins/{id}）`);
        return () => undefined;
      }
      registeredPrefixes.add(prefix);
      mutedRoutePrefixes.delete(prefix);
      // 登记前缀 → 插件 id（运行时模式门禁据此查该插件的适用模式）
      if (opts?.pluginId) routeModes.set(prefix, opts.pluginId);
      try {
        let target = router as Hono;
        // ★ 插件路由默认认证（C7）：/api/plugins/* 一律要求登录；
        //   若请求携带 X-Project-Id 则额外校验项目所有权（防跨项目读写）。
        //   内置模块（/api/auth 等）不走此前缀，登录/注册等公开路由不受影响。
        if (prefix.startsWith('/api/plugins/')) {
          const guarded = new Hono();
          guarded.use('*', requireAuth as never);
          // ★ 插件路由也必须先注册用户的 AI 配置 loader（2026-09-17 加）。
          //   插件里大量路由会调 AI（如 autowrite 的讨论 / 连写），而
          //   `ensureConfigMiddleware` 原先只挂在 /api/ai/* 上 —— 用户不进设置页时
          //   loader 就没注册，`getAIConfig(userId)` 静默回退到内置公益中转站。
          //   表现：讨论照跑、但模型被悄悄换掉（思维链因此永远是空的）。
          guarded.use('*', ensureConfigMiddleware as never);
          guarded.use('*', async (c, next) => {
            const projectId = c.req.header('X-Project-Id');
            if (projectId) {
              const denial = await verifyProjectOwnership(c as never, projectId);
              if (denial) return denial;
              // ★★ 必须**预热项目库缓存**（2026-09-17 修）：
              //   `ctx.db.kv.get(id, key, { projectId })` 内部走的是 **同步** 的
              //   `getProjectDbSync()` —— 它**只查缓存，不打开库**，未命中直接返回 null，
              //   而 KvService.get 遇到 null 是**静默返回 undefined**（不抛错）。
              //   后果：server 一重启，项目库缓存是空的 → 所有项目级 KV 读全部读成「没有」。
              //   实测表现：重启后 GET /pipeline 回 `started:false`（数据其实好好躺在
              //   plugin_kv 里），接着 advance 被判 NOT_STARTED —— 整条流水线状态"消失"。
              //   kv.set 里已经 initProjectDb 了（见 kv-service.ts），get 这条路缺了同一手。
              try {
                await initProjectDb(projectId);
              } catch (e) {
                console.warn(`[cordis-host] 预热项目库失败 (${projectId}):`, e);
              }
              // ★★ 运行时模式门禁（插件按模式物理拆分后）：
              //   带 X-Project-Id 且该项目的创作模式不被本插件 modes 覆盖时，
              //   返回 404 PLUGIN_MODE_MISMATCH —— 语义上「该插件路由对本项目不存在」。
              //   缺省 modes（空）按 shared 处理，故 shared 插件恒通过。
              const pluginId = routeModes.get(prefix);
              if (pluginId) {
                const modes = pluginModes.get(pluginId) ?? [];
                const pm = projectModeOf(projectId);
                if (pm && !pluginAppliesToProjectMode(modes, pm)) {
                  return c.json({
                    error: {
                      code: 'PLUGIN_MODE_MISMATCH',
                      message: `插件 ${pluginId} 不适用于 ${pm} 模式的项目`,
                    },
                  }, 404);
                }
              }
            }
            await next();
          });
          guarded.route('/', router as Hono);
          target = guarded;
        }
        (rootApp as Hono).route(prefix, target);
      } catch (err) {
        console.error('[cordis-host] 路由注册失败', prefix, err);
      }
      return () => {
        // ★ fiber dispose（插件禁用/熔断）→ 动态插件路由立即进入 muted，
        //   由上方 active gate 返回 404；重启后路由才真正从 Hono 中移除。
        if (prefix.startsWith('/api/plugins/')) {
          mutedRoutePrefixes.add(prefix);
        }
        console.warn('[cordis-host] 路由 ' + prefix + ' 需要重启才能卸载（Hono 架构限制）');
      };
    },
  };

  // ---- 插件间服务注册表 ----
  const servicesMap = new Map<string, unknown>();
  const servicesService = {
    register(name: string, instance: unknown): () => void {
      servicesMap.set(name, instance);
      return () => servicesMap.delete(name);
    },
    get(name: string): unknown {
      return servicesMap.get(name);
    },
  };

  // ---- AI 注册表（复用既有实现，暴露为 ctx.ai） ----
  const agentRegistry = new Map<string, unknown>();
  const providerRegistry = new Map<string, unknown>();

  // ★ 「输出预算被打穿」的取证与补救三件套（noteStreamEvidence / STARVATION_RETRY_HINT /
  //   retryBudgetOf）已抽到**模块顶层**并 export —— 它们决定"要不要重试"，必须能被单测钉住。

  /**
   * 子代理运行器（ctx.ai.agents.run / ctx.ai.complete 的实现底座）。
   * SDK 装配与 runNovelAgentStream 同款：getSdkProvider + Runner（Chat Completions 强制）。
   * tools 白名单缺省 = 纯生成；allowWriteChapter 只影响 write_chapter 是否进入候选集，
   * 且 SDK 工具 handler 内还有二次拒绝兜底（tools.ts）。
   *
   * ★ 2026-09-17：「预算被打穿」的自救 —— 见下面 catch 里的说明。
   *   这一层是通用的：pipeline 各段发言、讨论链路、实体沉淀（ctx.ai.complete 的 maxTurns 只有 1，
   *   比谁都脆弱）都走这里，所以修在这一层而不是某个调用方里。
   */
  async function runSubagent(o: {
    system: string;
    input: string;
    tools?: string[];
    model?: string;
    temperature?: number;
    /** 采样参数（可选）。显式传入优先，其次用用户 AI 配置里的值；都没有则不发送该字段 */
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    maxTokens?: number;
    maxTurns?: number;
    projectId?: string;
    userId?: string;
    allowWriteChapter?: boolean;
    /** 思维链增量回调；不传 = 不做旁路截取（零开销，也不会去解析 reasoning_content） */
    onThinking?: (delta: string) => void;
  }): Promise<{ text: string; model: string; thinking?: string }> {
    const config = await getAIConfig(o.userId);
    const provider = await getSdkProvider(o.userId);
    const model = o.model ?? config.model;

    // 这两项由 attempt 每次重置/填充，catch 里要用它们判定「是不是被打穿后的空转」
    const saw = { text: false, tool: false };
    let thinking = '';

    /** 单次尝试：跑完整个 run 并返回 finalOutput */
    const attempt = async (a: {
      maxTokens?: number;
      maxTurns: number;
      extraSystem?: string;
    }): Promise<string> => {
      saw.text = false;
      saw.tool = false;
      thinking = '';
      const allowed = o.tools ? new Set(o.tools) : undefined;
      const sdkTools = allowed
        ? getAllSdkTools({ allowWriteChapter: o.allowWriteChapter === true })
            .filter((t) => allowed.has((t as { name: string }).name))
        : [];
      // ★ maxTokens 必须显式透传：不传时 SDK 不发送 max_tokens，由服务商默认值兜底；
      //   推理模型（如 glm-5.3-flash）的思考 token 也计入该上限，默认值偏小时
      //   模型会自行收短输出 —— 长文写作上表现为「总是写不到约定字数」。
      // ★ 采样参数（temperature/topP/frequencyPenalty/presencePenalty）：
      //   显式传入优先（如校对门 0.1 / 润色门 0.2 的机判稳定性），
      //   否则用用户在「AI 设置」里配的值；两者都没有则**不下发**，保持原有行为。
      const effTemperature = o.temperature ?? config.temperature;
      const effTopP = o.topP ?? config.topP;
      const effFreqPenalty = o.frequencyPenalty ?? config.frequencyPenalty;
      const effPresPenalty = o.presencePenalty ?? config.presencePenalty;
      const modelSettings = (
        effTemperature != null || effTopP != null || effFreqPenalty != null
        || effPresPenalty != null || a.maxTokens != null
      )
        ? {
            ...(effTemperature != null ? { temperature: effTemperature } : {}),
            ...(effTopP != null ? { topP: effTopP } : {}),
            ...(effFreqPenalty != null ? { frequencyPenalty: effFreqPenalty } : {}),
            ...(effPresPenalty != null ? { presencePenalty: effPresPenalty } : {}),
            ...(a.maxTokens != null ? { maxTokens: a.maxTokens } : {}),
          }
        : undefined;
      const agent = new Agent({
        name: 'novel-subagent',
        instructions: a.extraSystem ? `${o.system}\n\n${a.extraSystem}` : o.system,
        tools: sdkTools,
        model,
        ...(modelSettings ? { modelSettings } : {}),
      });
      const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
      const context: NovelAgentContext = {
        projectId: o.projectId ?? '',
        userId: o.userId ?? '',
        allowWriteChapter: o.allowWriteChapter === true,
      };

      // ★ 思维链旁路：SDK 的 Chat Completions 通道不解析 reasoning_content（见 sdk/provider.ts 文件头），
      //   所以这里把 sink 放进 ALS，由 provider 的 fetch 旁路推回来。
      //   不传 onThinking 时完全不注册 sink —— 不白花解流的开销。
      const sink = o.onThinking
        ? (d: string) => { thinking += d; o.onThinking?.(d); }
        : undefined;

      // ★★ 必须走 `stream: true`：旁路只挂在 SSE 响应上。
      //   非流式时中转站返回的是 `application/json`（实测 content-type 就是它），
      //   reasoning_content 在那一整个 JSON body 里，旁路**一次都不会触发** ——
      //   表现就是「思维链一条都没有」，而且不报任何错。
      //   流式结果的 `finalOutput` 与之前一样可用（已实测：正文一致，工具轮次不会污染它），
      //   所以正文口径没变。整个 run（含流消费）都在 sink 作用域内，保证旁路拿得到接收器。
      const result = await runWithThinkingSink(sink, async () => {
        const streamed = await runner.run(agent, o.input as any, {
          stream: true,
          context,
          maxTurns: a.maxTurns,
        } as any);
        // 流式结果必须被**消费**才会真正跑完（模型调用就发生在这一步）
        for await (const ev of streamed as unknown as AsyncIterable<unknown>) {
          /* 只为驱动流；正文取 finalOutput，不逐字推送（子代理没有逐字展示的需求）。
             顺带取证：这一轮到底有没有产出文本 / 发起工具调用。 */
          noteStreamEvidence(ev, saw);
        }
        return streamed;
      });
      return String(result.finalOutput ?? '');
    };

    try {
      const text = await attempt({ maxTokens: o.maxTokens, maxTurns: o.maxTurns ?? 8 });
      return thinking ? { text, model, thinking } : { text, model };
    } catch (e) {
      // ★ 只捞「轮次耗尽但全程零正文」这一种失败（判据见 isStarvationFailure 的注释）。
      //   其余错误必须原样抛 —— 拿重试盖住真错误比失败本身更糟。
      if (!isStarvationFailure(e, saw)) throw e;

      const retryTokens = retryBudgetOf(o.maxTokens);
      // 补救轮不需要那么多轮次：判据已确认"全程没产出"，所以只需要「给出正文」的机会。
      // 留 4 轮是给带工具的发言人（查库 → 作答）留一个来回，同时比原始的 6/8 轮省。
      const retryTurns = Math.min(o.maxTurns ?? 8, 4);
      console.warn(
        `[subagent] 轮次耗尽但全程零正文：${model} 跑了 ${o.maxTurns ?? 8} 轮没有产出`
        + `（${saw.tool ? '有' : '无'}工具调用${thinking ? `，思考累计 ${thinking.length} 字` : ''}）。`
        + `改用 maxTokens=${retryTokens} / maxTurns=${retryTurns} 重试一次。`,
      );
      try {
        const text = await attempt({
          maxTokens: retryTokens,
          maxTurns: retryTurns,
          extraSystem: STARVATION_RETRY_HINT,
        });
        if (text.trim()) return thinking ? { text, model, thinking } : { text, model };
        throw new Error('重试后依然没有产出正文');
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        // 注：`e` 在 isStarvationFailure 里才被收窄，这里仍是 unknown，故显式取 message
        const first = e instanceof Error ? e.message : String(e);
        throw new Error(
          `模型（${model}）跑满 ${o.maxTurns ?? 8} 轮仍未产出正文：`
          + `首次失败（${first}），以 maxTokens=${retryTokens} 重试一次仍失败（${msg}）。`
          + '建议调大该次调用的 maxTokens，或在设置里改用非推理模型。',
        );
      }
    }
  }

  const aiService = {
    tools: {
      register(definition: import('@novel/core').ToolDefinition, handler: unknown) {
        registerTool(definition.function.name, definition, handler as Parameters<typeof registerTool>[2]);
        markPluginTool(definition.function.name); // 聊天工具白名单动态纳入插件工具
        return () => unregisterTool(definition.function.name);
      },
      getAllDefinitions: () => getAllToolDefinitions(),
    },
    skills: {
      register(skill: unknown) {
        registerSkill(skill as import('../ai/agents/skills.js').SkillDef);
        return () => unregisterSkill((skill as { id: string }).id);
      },
      getAll: () => ({ ...SKILLS }),
    },
    skillTargets: {
      // 插件声明自己的 agent（"后续还要继续加入其他 agent 的 skills"靠这个入口）
      declare(def: Omit<import('../ai/agents/skill-targets.js').SkillTarget, 'source'>) {
        declareSkillTarget({ ...def, source: 'plugin' });
        return () => undeclareSkillTarget(def.id);
      },
      getAll: () => listSkillTargets().map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
    },
    agentSkills: {
      // 执行链路用：返回"这个智能体当前启用、且有正文"的技能（库在主库，插件读不到 → 宿主代读）
      getEnabled: (agentId: string, opts?: { userId?: string }) => listEnabledSkills(agentId, opts?.userId),
    },
    agents: {
      register(def: { name: string }) {
        const id = 'plugin:ai:agents:' + def.name;
        agentRegistry.set(id, def);
        return () => agentRegistry.delete(id);
      },
      run: (opts: import('@novel/core').AgentRunOptions) => runSubagent({
        system: opts.system,
        input: opts.input,
        tools: opts.tools,
        model: opts.model,
        temperature: opts.temperature,
        topP: opts.topP,
        frequencyPenalty: opts.frequencyPenalty,
        presencePenalty: opts.presencePenalty,
        maxTokens: opts.maxTokens,
        maxTurns: opts.maxTurns,
        projectId: opts.context.projectId,
        userId: opts.context.userId,
        allowWriteChapter: opts.allowWriteChapter,
        onThinking: opts.onThinking,
      }),
    },
    providers: {
      register(def: { name: string }) {
        const id = 'plugin:ai:providers:' + def.name;
        providerRegistry.set(id, def);
        return () => providerRegistry.delete(id);
      },
    },
    complete: (opts: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      model?: string;
      json?: boolean;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      maxTokens?: number;
      userId?: string;
    }) => {
      const systemParts = opts.messages.filter((m) => m.role === 'system').map((m) => m.content);
      if (opts.json) {
        systemParts.push('只输出 JSON。不要输出 JSON 以外的任何文字（不要代码围栏、不要解释）。');
      }
      const input = opts.messages
        .filter((m) => m.role !== 'system')
        .map((m) => (m.role === 'assistant' ? `[上一轮助手回复]\n${m.content}` : m.content))
        .join('\n\n');
      return runSubagent({
        system: systemParts.join('\n\n'),
        input,
        model: opts.model,
        temperature: opts.temperature,
        topP: opts.topP,
        frequencyPenalty: opts.frequencyPenalty,
        presencePenalty: opts.presencePenalty,
        maxTokens: opts.maxTokens,
        maxTurns: 1,
        userId: opts.userId,
      }).then((r) => r.text);
    },
  };

  // ---- db / settings / scheduler / prompt / events ----
  const dbService = {
    global: () => getDb(),
    project: (projectId: string) => getProjectDbSync(projectId),
    kv,
    // 注意：ctx.db.migrate 只在守护器包装层提供（guardian.wrapDb → migrations.ts），
    // 按挂载条目归因 pluginId 并校验 db:global / db:project 权限；
    // 内置插件不经包装层，数据请走 KV（plugin_kv）或直接使用 global()/project()。
  };
  // ★ events 服务（C7 附带修复）：插件 manifest 常 inject 'events'（如 worldbuilding 订阅
  //   chapter.saved）。此前宿主未提供该服务 → cordis 使插件停留在等待态，apply 永不执行、
  //   路由/工具全部丢失（worldbuilding 的 /api/plugins/worldbuilding 一直 404 即此原因）。
  const eventBus = new EventBus();
  const eventsService = {
    on<T>(name: string, handler: (payload: T) => void | Promise<void>): () => void {
      return eventBus.on(name, handler);
    },
    emit<T>(name: string, payload: T): Promise<void> {
      return eventBus.emit(name, payload);
    },
  };
  const settingsService = {
    // 已废弃：插件 UI 统一走工作台面板；设置页只显示插件管理列表
    registerSection: () => () => undefined,
  };
  const schedulerService = {
    register(def: { label: string; intervalMs: number; run: () => Promise<void> | void }) {
      const timer = setInterval(() => {
        Promise.resolve(def.run()).catch((err: unknown) =>
          console.error('[cordis-plugin] 定时任务 ' + def.label + ' 失败:', err));
      }, def.intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  const promptSections = new Map<string, { order: number; text: string }>();
  const promptService = {
    section(def: { name: string; order: number; text: string }) {
      const key = 'plugin:prompt:' + def.name;
      promptSections.set(key, { order: def.order, text: def.text });
      return () => promptSections.delete(key);
    },
  };

  // ---- 注入服务到 cordis ctx（命名与旧契约一致 → 插件 inject 直接生效） ----
  const proxy = ctx as unknown as { provide?: (name: string, value: unknown) => void };
  proxy.provide?.('routes', routesService);
  proxy.provide?.('services', servicesService);
  proxy.provide?.('db', dbService);
  proxy.provide?.('ai', aiService);
  proxy.provide?.('settings', settingsService);
  proxy.provide?.('scheduler', schedulerService);
  proxy.provide?.('prompt', promptService);
  proxy.provide?.('events', eventsService);
  proxy.provide?.('hooks', hookBus);

  // ---- 健康检查 ----
  rootApp.get('/api/health', (c) => {
    const dbReady = !!getDb();
    return c.json({
      status: dbReady ? 'ok' : 'degraded',
      database: dbReady ? 'connected' : 'unavailable',
      pluginStandard: INSTALL_STANDARD_VERSION,
      // 宿主模式（all/manual/auto）：便于按模式核对插件集合
      hostMode,
      plugins: [...statuses.values()].map((p) => ({
        id: p.id,
        status: p.status,
        modes: p.modes ?? ['shared'],
        error: p.error,
      })),
      timestamp: Date.now(),
    });
  });

  // ---- 插件挂载（真实 cordis：ctx.plugin + fiber） ----
  async function mountEntry(entry: PluginEntry): Promise<void> {
    const order = seq++;
    entriesById.set(entry.id, entry);
    // 记录适用模式（供运行时门禁）；缺省 ['shared']
    const modes = entry.modes ?? entry.manifest?.modes ?? ['shared'];
    pluginModes.set(entry.id, modes);

    if (disabledIds.has(entry.id)) {
      statuses.set(entry.id, {
        id: entry.id,
        name: entry.manifest?.name ?? entry.id,
        source: entry.source,
        status: 'disabled',
        order,
        enabled: false,
        modes,
        permissions: entry.manifest?.permissions ?? [],
        dependsOn: entry.manifest?.dependsOn ?? [],
      });
      return;
    }

    try {
      const mod = await entry.load();
      if (typeof (mod as PluginModule | undefined)?.apply !== 'function') {
        throw new Error('插件模块缺少 apply() 导出');
      }
      // 非内置插件：给 apply 收到的 ctx 套守护归因（路由/AI/事件/定时器/db 错误按插件计数）
      const watched = entry.source !== 'builtin';
      let mountedMod: PluginModule = mod as unknown as PluginModule;
      if (watched) {
        // 重挂场景：先清理上一次经包装层注册的资源
        guardedBags.get(entry.id)?.();
        guardedBags.delete(entry.id);
        const handle = createGuardedPluginHandle(mod as PluginModule, entry.id, guardian, entry.manifest?.permissions ?? []);
        mountedMod = handle.mod;
        guardedBags.set(entry.id, handle.disposeTracked);
      } else {
        // ★ 内置条目也做轻量 routes 归因（仅透传 pluginId，不进守护器计数）：
        //   否则其 /api/plugins/* 路由在宿主模式门禁的 routeModes 里查不到 pluginId，
        //   manual 插件对 auto 项目会被静默放行（novel.worldbuilding 即此情形）。
        mountedMod = attributeBuiltinRoutes(mountedMod, entry.id);
      }
      const fiber = await ctx.plugin(mountedMod as Plugin, {});
      fibers.set(entry.id, fiber as unknown as { dispose(): unknown });
      statuses.set(entry.id, {
        id: entry.id,
        name: entry.manifest?.name ?? entry.id,
        source: entry.source,
        status: 'ok',
        order,
        enabled: true,
        modes,
        permissions: entry.manifest?.permissions ?? [],
        dependsOn: entry.manifest?.dependsOn ?? [],
      });
      guardian.onMounted(entry.id, entry.source);
      console.info('[cordis-host] 插件已挂载: ' + entry.id + ' (cordis fiber)');
    } catch (err) {
      // 挂载失败：已产生的包装层资源一并清理
      guardedBags.get(entry.id)?.();
      guardedBags.delete(entry.id);
      const message = err instanceof Error ? err.message : String(err);
      statuses.set(entry.id, {
        id: entry.id,
        name: entry.manifest?.name ?? entry.id,
        source: entry.source,
        status: 'error',
        error: 'LOAD_FAILED: ' + message,
        order,
        enabled: false,
        modes,
        permissions: entry.manifest?.permissions ?? [],
        dependsOn: entry.manifest?.dependsOn ?? [],
      });
      console.error('[cordis-host] 插件 ' + entry.id + ' 挂载失败（已隔离，不影响宿主）: ' + message);
    }
  }

  const host: ServerPluginHost = {
    ctx,
    events: ctx,
    hooks: hookBus,

    async mount(entries: PluginEntry[]) {
      // ── 安装管线（novel-plugin-standard/1.0，见 docs/architecture/plugin-standard.md）──
      // 逐门校验：任何一门失败都只隔离该插件并记录标准错误码，绝不中断整批挂载。
      //   G0 Manifest 门 → G2 身份门（重复 id）→ G3 版本门 + G4 静态依赖门
      //   → G4/G5 挂载期门（拓扑排序 + 环检测 + 注入校验）→ mountEntry（load/apply 隔离）
      const admitted: PluginEntry[] = [];
      for (const entry of entries) {
        const order = seq++;
        // G0 Manifest 门（AI 创建的本地产物可能是 rawManifest）
        if (!entry.manifest && entry.rawManifest) {
          try {
            entry.manifest = validateManifest(entry.rawManifest as Parameters<typeof validateManifest>[0]);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            statuses.set(entry.id, {
              id: entry.id,
              name: entry.id,
              source: entry.source,
              status: 'error',
              error: 'MANIFEST_INVALID: ' + message,
              order,
              enabled: false,
              modes: entry.modes ?? entry.manifest?.modes ?? ['shared'],
              permissions: [],
              dependsOn: [],
            });
            console.error('[install-gate] ' + entry.id + ' 未通过 G0 Manifest 门: ' + message);
            continue;
          }
        }
        if (!entry.manifest) {
          statuses.set(entry.id, {
            id: entry.id,
            name: entry.id,
            source: entry.source,
            status: 'error',
            error: 'MANIFEST_INVALID: 插件条目缺少 manifest',
            order,
            enabled: false,
            modes: entry.modes ?? ['shared'],
            permissions: [],
            dependsOn: [],
          });
          continue;
        }
        const manifest = entry.manifest;
        // ★ HOST_MODE 过滤：宿主模式为 manual/auto 时，仅挂载 modes 含该模式或 shared 的插件。
        //   被过滤者不进挂载管线（status='skipped'），但仍留在状态表 → /api/health 可区分。
        const entryModes = entry.modes ?? manifest.modes ?? ['shared'];
        if (hostMode !== 'all' && !entryModes.includes('shared') && !entryModes.includes(hostMode)) {
          pluginModes.set(entry.id, entryModes);
          statuses.set(entry.id, {
            id: entry.id,
            name: manifest.name,
            source: entry.source,
            status: 'skipped',
            error: `HOST_MODE_FILTERED: 宿主模式 ${hostMode}，插件模式 [${entryModes.join(', ')}]`,
            order,
            enabled: false,
            modes: entryModes,
            permissions: manifest.permissions,
            dependsOn: manifest.dependsOn ?? [],
          });
          console.info('[host-mode] ' + entry.id + ' 因宿主模式 ' + hostMode + ' 被跳过（modes: ' + entryModes.join(', ') + '）');
          continue;
        }
        // G2 身份门：id 全局唯一（重复注册会覆盖 fibers/statuses，引发卸载错乱）
        if (entriesById.has(entry.id) || admitted.some((e) => e.id === entry.id)) {
          statuses.set(entry.id, {
            id: entry.id,
            name: manifest.name,
            source: entry.source,
            status: 'error',
            error: 'ID_CONFLICT: 插件 id 与已注册插件重复',
            order,
            enabled: false,
            modes: entryModes,
            permissions: manifest.permissions,
            dependsOn: manifest.dependsOn ?? [],
          });
          console.error('[install-gate] ' + entry.id + ' 未通过 G2 身份门: id 重复注册');
          continue;
        }
        // G3 版本门 + G4 静态依赖门（自依赖 / 依赖被禁用）
        const policyIssues = checkManifestPolicy(manifest, { disabledPluginIds: disabledIds });
        if (policyIssues.length > 0) {
          statuses.set(entry.id, {
            id: entry.id,
            name: manifest.name,
            source: entry.source,
            status: 'error',
            error: policyIssues.map((i) => i.code + ': ' + i.message).join('; '),
            order,
            enabled: false,
            modes: entryModes,
            permissions: manifest.permissions,
            dependsOn: manifest.dependsOn ?? [],
          });
          console.error('[install-gate] ' + entry.id + ' 未通过安装门: ' + policyIssues.map((i) => i.code).join('/'));
          continue;
        }
        admitted.push(entry);
      }

      // G4/G5 挂载期门：按 inject 服务 + dependsOn 拓扑排序；
      // 已禁用插件不进 available 集合 → 依赖它的插件按标准跳过（硬依赖不可用）。
      const available = new Set<string>(SERVER_SERVICES);
      for (const e of admitted) {
        if (!disabledIds.has(e.id)) available.add(e.id);
      }
      const plan = sortByDependencies(
        admitted.map((e) => ({
          entry: e,
          id: e.id,
          inject: e.manifest?.server?.inject ?? [],
          dependsOn: e.manifest?.dependsOn ?? [],
        })),
        available,
      );
      for (const cycle of plan.cycles) {
        for (const id of cycle) {
          const entry = admitted.find((e) => e.id === id);
          statuses.set(id, {
            id,
            name: entry?.manifest?.name ?? id,
            source: entry?.source ?? 'local',
            status: 'error',
            error: 'DEP_CYCLE: 循环依赖 ' + cycle.join(' → '),
            order: seq++,
            enabled: false,
            modes: entry?.modes ?? entry?.manifest?.modes ?? ['shared'],
            permissions: entry?.manifest?.permissions ?? [],
            dependsOn: entry?.manifest?.dependsOn ?? [],
          });
        }
        console.error('[install-gate] 检测到循环依赖，已整环隔离: ' + cycle.join(' → '));
      }
      const serviceNames: readonly string[] = SERVER_SERVICES;
      for (const { item, missing } of plan.skipped) {
        const entry: PluginEntry = item.entry;
        const missingServices = missing.filter((x) => serviceNames.includes(x));
        const error = missingServices.length === missing.length
          ? 'INJECT_MISSING: 宿主无法提供注入服务（' + missing.join(', ') + '）'
          : 'DEP_MISSING: 硬依赖不可用（' + missing.join(', ') + '）';
        statuses.set(entry.id, {
          id: entry.id,
          name: entry.manifest?.name ?? entry.id,
          source: entry.source,
          status: 'skipped',
          error,
          order: seq++,
          enabled: false,
          modes: entry.modes ?? entry.manifest?.modes ?? ['shared'],
          permissions: entry.manifest?.permissions ?? [],
          dependsOn: entry.manifest?.dependsOn ?? [],
        });
        console.error('[install-gate] ' + entry.id + ' 被跳过: ' + error);
      }
      // 按拓扑序挂载（load/apply 失败在 mountEntry 内隔离为 LOAD_FAILED）
      for (const item of plan.sorted) {
        await mountEntry(item.entry);
      }
    },

    async start(startOpts) {
      const port = startOpts?.port ?? options.port ?? 3774;
      const hostAddr = startOpts?.host ?? options.host ?? '127.0.0.1';
      const distIndex = startOpts?.distIndex;

      // 真实 DSH webServer 服务（node:http，动态路由 + disposer）
      await ctx.plugin(WebServer, { host: hostAddr, port });

      // /api → 根 Hono 应用（全部模块路由 + 全局中间件）
      // 路由插件依赖 webServer 服务存在后才注册（inject）
      await ctx.plugin({
        name: 'novel.web-bridge',
        inject: ['webServer'],
        apply(c: any) {
          c.effect(
            () => c.webServer.register({ kind: 'prefix', path: '/api', handler: honoListener(rootApp) }),
            'novel: /api 路由桥',
          );
          if (distIndex) {
            const handler = createStaticFallback(distIndex);
            c.effect(() => c.webServer.registerFallback(async (req: IncomingMessage, res: ServerResponse) => {
              try {
                await handler(req, res);
              } catch (err) {
                console.error('[cordis-host] fallback 处理异常:', err);
                if (!res.headersSent) { res.writeHead(500); res.end(); } else { res.destroy(); }
              }
            }), 'novel: 前端静态资源 fallback');
          } else {
            console.warn('[cordis-host] distIndex 未提供，跳过静态服务');
          }
        },
      } as Plugin);

      const port2 = (ctx as unknown as { webServer: { port: number } }).webServer.port;
      const url = 'http://localhost:' + port2;
      console.warn('[Server] Cordis 基座已就绪 → ' + url);
      return { port: port2, url };
    },

    getPluginStatus() {
      // 守护器快照实时合并（调用次数/错误数随运行变化）
      return [...statuses.values()].map((p) => {
        const g = guardian.snapshotOf(p.id);
        return g ? { ...p, guardian: { ...g } } : p;
      });
    },

    promotePlugin(id) {
      if (!entriesById.has(id)) return { ok: false, error: '未知插件 ' + id };
      const rec = guardian.promote(id);
      if (!rec) return { ok: false, error: '插件 ' + id + ' 不受守护器观察（内置插件）' };
      return { ok: true };
    },

    async requarantinePlugin(id) {
      if (!entriesById.has(id)) return { ok: false, error: '未知插件 ' + id, remounted: false };
      // 被熔断禁用的插件：直接重新挂载（onMounted 见 failed 态会自动重置为隔离观察）
      if (disabledIds.has(id)) {
        const r = await this.setPluginEnabled(id, true);
        if (!r.ok) return { ok: false, error: r.error ?? '重新挂载失败', remounted: false };
        return { ok: true, remounted: true };
      }
      const rec = guardian.requarantine(id);
      if (!rec) return { ok: false, error: '插件 ' + id + ' 不受守护器观察（内置插件）', remounted: false };
      return { ok: true, remounted: false };
    },

    getGuardianPolicy() {
      return { ...guardian.policy };
    },

    async setPluginEnabled(id: string, enabled: boolean) {
      const entry = entriesById.get(id);
      if (!entry) return { ok: false, error: '未知插件 ' + id };

      if (enabled) {
        // 标准 G4 依赖门：硬依赖必须已启用（与安装管线/动态安装语义一致），
        // 否则插件挂上了但依赖能力缺失，运行时才炸 —— 那正是"装插件就崩"的根源之一。
        for (const d of entry.manifest?.dependsOn ?? []) {
          const dep = statuses.get(d);
          if (!dep || !dep.enabled || dep.status !== 'ok') {
            return { ok: false, error: '依赖插件 ' + d + ' 未启用（请先启用依赖，或重启 server 由安装管线自动排序）' };
          }
        }
        if (disabledIds.has(id)) {
          disabledIds.delete(id);
          await mountEntry(entry);
          if (statuses.get(id)?.status !== 'ok') {
            disabledIds.add(id);
            await persistDisabled();
            return { ok: false, error: '插件 ' + id + ' 重新挂载失败（详见服务端日志）' };
          }
          await persistDisabled();
        }
        return { ok: true };
      }

      const fiber = fibers.get(id);
      if (fiber) {
        try {
          await Promise.resolve(fiber.dispose());
        } catch (err) {
          console.error('[cordis-host] 卸载插件 ' + id + ' 出错:', err);
        }
        fibers.delete(id);
      }
      // 守护包装层兜底清理（插件未用 ctx.effect 包裹的注册物：定时器/AI 工具/事件订阅等）
      const disposeTracked = guardedBags.get(id);
      if (disposeTracked) {
        try {
          disposeTracked();
        } catch (err) {
          console.error('[guardian] 兜底清理 ' + id + ' 失败:', err);
        }
        guardedBags.delete(id);
      }
      const st = statuses.get(id);
      statuses.set(id, {
        id,
        name: st?.name ?? id,
        source: entry.source,
        status: 'disabled',
        order: st?.order ?? 0,
        enabled: false,
        modes: st?.modes ?? entry.modes ?? entry.manifest?.modes ?? ['shared'],
        permissions: st?.permissions ?? [],
        dependsOn: st?.dependsOn ?? [],
      });
      disabledIds.add(id);
      await persistDisabled();
      return { ok: true };
    },

    async addPluginEntry(entry: PluginEntry) {
      // 标准安装门：运行时动态安装与启动挂载走同一套校验（novel-plugin-standard/1.0）
      if (!entry.manifest && entry.rawManifest) {
        try {
          entry.manifest = validateManifest(entry.rawManifest as Parameters<typeof validateManifest>[0]);
        } catch (err) {
          return { ok: false, error: 'MANIFEST_INVALID: ' + (err instanceof Error ? err.message : String(err)) };
        }
      }
      if (!entry.manifest) return { ok: false, error: 'MANIFEST_INVALID: 插件条目缺少 manifest' };
      const policyIssues = checkManifestPolicy(entry.manifest, { disabledPluginIds: disabledIds });
      if (policyIssues.length > 0) {
        return { ok: false, error: policyIssues.map((i) => i.code + ': ' + i.message).join('; ') };
      }
      if (entriesById.has(entry.id)) {
        return { ok: false, error: 'ID_CONFLICT: 插件 ' + entry.id + ' 已注册' };
      }
      // G4 运行时依赖门：依赖必须已挂载且启用
      const deps = entry.manifest?.dependsOn ?? [];
      for (const d of deps) {
        const dep = [...statuses.values()].find((s) => s.id === d);
        if (!dep || !dep.enabled || dep.status !== 'ok') {
          return { ok: false, error: 'DEP_MISSING: 依赖插件 ' + d + ' 未启用' };
        }
      }
      entriesById.set(entry.id, entry);
      await mountEntry(entry);
      const st = statuses.get(entry.id);
      if (!st || st.status !== 'ok') return { ok: false, error: '插件 ' + entry.id + ' 挂载失败（详见服务端日志）' };
      return { ok: true };
    },

    recordInstallRejections(items: Array<{ id: string; message: string }>) {
      for (const item of items) {
        if (statuses.has(item.id) || entriesById.has(item.id)) continue;
        statuses.set(item.id, {
          id: item.id,
          name: item.id,
          source: 'local',
          status: 'error',
          error: item.message,
          order: seq++,
          enabled: false,
          // 被拒插件未进入挂载管线，无 entry.modes；按 local 目录语义记 shared
          modes: ['shared'],
          permissions: [],
          dependsOn: [],
        });
      }
    },

    setInitialDisabled(ids: string[]) {
      disabledIds.clear();
      for (const id of ids) disabledIds.add(id);
    },

    getDependencyAnalysis() {
      return analyzeDependencies([...entriesById.values()]);
    },

    getDisabledIds() {
      return [...disabledIds];
    },

    async dispose() {
      try {
        await Promise.resolve((ctx as unknown as { fiber?: { dispose(): unknown } }).fiber?.dispose?.());
      } catch (err) {
        console.error('[cordis-host] 释放基座出错:', err);
      }
    },
  };

  // 守护器熔断回调经 hostRef 延迟引用宿主（避免构造期循环依赖）
  hostRef = host;

  return host;
}
