// ============================================================
// @novel/core - 插件上下文契约（Server 面 / Web 面）
//
// 插件作者只依赖 @novel/core 即可获得全部扩展点类型。
// 宿主（apps/server、apps/web）实现这些上下文并注入具体服务。
// 本文件全部为类型（type-only），运行时零开销。
// ============================================================

import type { BasePluginContext } from './context.js';
import type { PluginMode } from './mode.js';
import type { CapabilityName } from './manifest.js';

// ---- AI 工具类型（与 server 的 provider-factory 结构化一致）----

/** 工具定义（OpenAI function calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前项目 ID（项目隔离：所有写入必须绑定项目） */
  projectId: string;
}

/** 工具处理结果 */
export interface ToolHandlerResult {
  success: boolean;
  result: string;
  entity?: {
    type: string;
    action: 'create' | 'update';
    id?: string;
    name?: string;
    payload?: Record<string, unknown>;
  };
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolHandlerResult>;

// ---- 插件 KV 服务 ----

export interface KvService {
  get<T>(pluginId: string, key: string, opts?: { projectId?: string }): T | undefined;
  set(pluginId: string, key: string, value: unknown, opts?: { projectId?: string }): Promise<void>;
  list(pluginId: string, prefix?: string, opts?: { projectId?: string }): Array<{ key: string; value: unknown }>;
  delete(pluginId: string, key: string, opts?: { projectId?: string }): Promise<void>;
}

// ---- 插件正式表迁移（v2 数据扩展，替代「只能走 KV」的限制）----

/** 一条插件迁移：版本号严格升序唯一，幂等应用（已记录版本自动跳过） */
export interface PluginMigration {
  /** 版本号（正整数，同一插件内升序唯一） */
  version: number;
  /** 迁移名（记账与排查用） */
  name: string;
  /** 建表/加列 SQL（可多语句；禁止 PRAGMA/ATTACH） */
  sql: string;
}

export interface PluginMigrateResult {
  /** 本次实际执行的迁移 */
  applied: Array<{ version: number; name: string }>;
  /** 因已应用而跳过的数量 */
  skipped: number;
}

// ---- Server 面上下文 ----

export interface ServerPluginContext extends BasePluginContext {
  /** 路由：注册 Hono 子路由（prefix + router） */
  routes: {
    register(prefix: string, router: unknown): () => void;
  };

  /** 服务：注册/获取业务服务（供插件间复用） */
  services: {
    register<T>(name: string, instance: T): () => void;
    get<T>(name: string): T | undefined;
  };

  /** 数据库 */
  db: {
    /** 主库（用户/设置/插件 KV） */
    global(): unknown;
    /** 项目库（项目隔离） */
    project(projectId: string): unknown;
    /** 插件 KV（v1 数据扩展） */
    kv: KvService;
    /**
     * 插件正式表迁移（v2 数据扩展）。
     * - scope 'global'（缺省）：表建在主库，需要权限 db:global；
     * - scope 'project'：表建在每个项目库，需要权限 db:project；对已打开的库立即执行，
     *   之后新创建的项目库由宿主在 initProjectDb 钩子里自动补跑。
     * - 幂等：以 plugin_migrations 记账表为准，重复调用只返回 skipped。
     * 注意：非内置插件经守护器代理获得此方法（按 pluginId 归因记账）；
     * 内置插件数据请走 KV。
     */
    migrate(migrations: PluginMigration[], opts?: { scope?: 'global' | 'project' }): Promise<PluginMigrateResult>;
  };

  /** AI 层 */
  ai: {
    /** 注册 AI 工具 */
    tools: {
      register(definition: ToolDefinition, handler: ToolHandler): () => void;
      getAllDefinitions(): ToolDefinition[];
    };
    /** 注册 AI 技能 */
    skills: {
      register(skill: {
        id: string;
        systemPrompt: string;
        contextKeys: string[];
        /** 展示名称（GET /api/ai/skills 下发；缺省回退为 id） */
        name?: string;
        /** 一句话描述 */
        description?: string;
        /** 主题色（hex / hsl 皆可；水墨主题下统一给灰阶） */
        color?: string;
        /**
         * 归属智能体 —— 集中式 skills 库种子用（落到 `skill_library.owner_agent`）。
         *
         * 2026-09-15 新增：此前种子逻辑把注册表里的技能**一律**归到写作官（硬编码），
         * 后果是 10 条技能全堆在 writer 名下、另外 7 个 agent 的技能列表全空。
         * 归属是技能的固有属性，应当由技能自己声明。
         * 取值必须是 `ctx.ai.skillTargets.declare()` 声明过的 agent id；省略时回落 'writer'。
         */
        ownerAgent?: string;
      }): () => void;
      getAll(): Record<string, unknown>;
    };
    /**
     * 声明「技能目标」（智能体清单）—— 供集中的 skills 库把技能归属到具体智能体。
     *
     * 为什么需要它：技能要标 `ownerAgent`，而界面左列要把所有智能体列出来。
     * 声明是**可扩展**的（后续加入其他 agent 的 skills 只需 declare，不必改核心）。
     * ★ id 必须与该 agent 在别处使用的标识一致（例如写作流水线角色的 `DesignRole.key`），
     *   否则将来把开关接到执行链路上时两边对不上。
     */
    skillTargets: {
      declare(def: {
        id: string;
        name: string;
        /** 'assistant' = 智能体本体；'agent' = 子智能体 */
        kind: 'assistant' | 'agent';
        /** 头像字（单字） */
        short: string;
        /** 主题色（hex） */
        color: string;
        /** 一句话职责 */
        description: string;
        /** 界面分组（如「写作流水线」） */
        group: string;
      }): () => void;
      getAll(): Array<{ id: string; name: string; kind: 'assistant' | 'agent' }>;
    };
    /**
     * 智能体**已启用**的技能（集中式 skills 库 → 执行链路）。
     *
     * 库与开关存在主库（插件读不到），所以必须由宿主代读。
     * 调用方拿到的是"这个智能体当前启用、且有正文的技能"，用来拼进 system prompt ——
     * **开着的技能必须真的作用到模型身上**，否则开关就只是装饰。
     * 没有配置过 / 查询失败一律返回空数组（fail-closed：宁可不加技能，也不要凭空生效）。
     */
    agentSkills: {
      getEnabled(agentId: string, opts?: { userId?: string }): Promise<Array<{
        id: string;
        name: string;
        systemPrompt: string;
      }>>;
    };
    /** 注册 AI 智能体 */
    agents: {
      register(def: { name: string; description?: string; handler: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> }): () => void;
      /**
       * 运行一个子代理（宿主实现：SDK 装配 + 工具白名单 + 项目隔离上下文）。
       * flow 型技能的执行底座：插件只声明 system/input/工具名单，运行细节归宿主。
       * 需要 ai:agents 权限。
       */
      run(opts: AgentRunOptions): Promise<AgentRunResult>;
    };
    /**
     * 裸补全（无工具，机判/生成步骤用）。需要 ai:agents 权限。
     * json=true 时请求 JSON 输出（不保证合法，调用方自行解析兜底）。
     */
    complete(opts: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      /** 覆盖默认模型（缺省用当前 AI 配置的模型） */
      model?: string;
      json?: boolean;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      /** 输出 token 上限（语义同 AgentRunOptions.maxTokens） */
      maxTokens?: number;
      userId?: string;
    }): Promise<string>;
    /** 注册模型提供商（扩展 provider-factory 的 provider 池） */
    providers: {
      register(def: { name: string; create: (config: Record<string, unknown>) => unknown }): () => void;
    };
  };

  /** 设置 section */
  settings: {
    registerSection(def: { key: string; title: string }): () => void;
  };

  /** 定时任务 */
  scheduler: {
    register(def: { label: string; intervalMs: number; run: () => void | Promise<void> }): () => void;
  };

  /** 系统提示 section（AI 能力声明） */
  prompt: {
    section(def: { name: string; order: number; text: string }): () => void;
  };
}

// ---- Web 面上下文 ----

/** 跨模块能力名（取自 core 常量 WEB_CAPABILITIES，唯一来源） */
export type WebCapabilityName = CapabilityName;

/**
 * 模块级工作台根组件定义（registerWorkbench）。
 * 每个创作模式一个槽位；缺席时宿主渲染 <WorkbenchMissing/>。
 */
export interface WorkbenchDef {
  key: string;
  /** 适用的创作模式（如 ['auto']）；宿主按当前 project.mode 选用 */
  modes: PluginMode[];
  Component: unknown;
}

/**
 * 内核内置气泡浮窗定义（registerBuiltinBubble）。
 * 取代 ProjectLayout 对 LeftSidebar / ChatPanel 的静态 import（按 def.key 键控多槽）：
 *   manual 注册 { key:'chapters', Component: LeftSidebar }
 *   auto   注册 { key:'ai-chat',  Component: ChatPanel  }
 */
export interface BuiltinBubbleDef {
  key: string;
  Component: unknown;
  icon?: unknown;
  label?: string;
  width?: number;
  height?: number;
  modes?: PluginMode[];
  /** ★ 2026-10-29：工作台左竖栏的分区标题（语义见 `FloatingPanelDef.section`） */
  section?: string;
}

export interface FloatingPanelDef {
  icon: unknown;
  label: string;
  key: string;
  Component: unknown;
  width?: number;
  height?: number;
  /** 排序权重（升序；缺省 0，同权重按注册先后） */
  order?: number;
  /**
   * 呈现位置：'workspace'（缺省）进工作台顶栏按钮组，由 ProjectLayout 承载；
   * 'editor' 不进顶栏，由编辑器内的面板栏（EditorPanelRail）开关，
   * 面板组件自行经 useEditorStore 获取编辑器实例。
   */
  scope?: 'workspace' | 'editor';
  /**
   * 浮窗左缘外侧贴附的功能气泡栏（如 AI 写作面板旁的技能快捷入口）。
   * 浮窗根 div 是绝对定位基准，组件自行绝对定位（参考 AI 对话气泡栏：absolute -left-14 top-4）。
   */
  rail?: unknown;
  /**
   * ★ 2026-10-29 新增：工作台左竖栏（活动栏）里的**分区标题**。
   *
   * 竖栏此前是一列等距无字图标，只能靠悬停 tooltip 逐个认门；
   * 声明本字段即把该面板归进同名分区，宿主会渲染一个小标题把同组图标框在一起。
   * 约定名：`'写作'` / `'资料'` / `'工具'`（宿主按此顺序排列已知分区）。
   *
   * 全可选：不声明 ⇒ 归入兜底分区（宿主侧 `DEFAULT_RAIL_SECTION`），
   * 不会报错、不会被隐藏 ⇒ 已发布插件零改动兼容。
   * 未知分区名按**首次出现顺序**追加在已知分区之后，同样不会丢。
   */
  section?: string;
}

export interface WebCommandDef {
  id: string;
  title: string;
  keywords?: string[];
  run: () => void | Promise<void>;
  order?: number;
}

export type WebRouteGuard = 'landing' | 'protected' | 'admin';

export interface WebRouteDef {
  path: string;
  Component: unknown;
  guard?: WebRouteGuard;
  inProject?: boolean;
  order?: number;
}

/** 设置页可挂载的分类（对应 SettingsPage 左侧导航） */
export type SettingsCategory = 'general' | 'appearance' | 'ai' | 'security' | 'plugins' | 'updates';

/**
 * 设置页区块：渲染在指定分类下方，宿主负责卡片外壳（标题 + 描述 + nm-card）。
 * Component 无 props，自行通过 ctx.api 读写自己的配置。
 */
export interface SettingsSectionDef {
  key: string;
  title: string;
  /** 卡片标题下的一行说明（可选） */
  description?: string;
  icon?: unknown;
  Component: unknown;
  /** 挂载到哪个设置分类，缺省 'plugins' */
  category?: SettingsCategory;
  order?: number;
}

/**
 * 编辑器 Tiptap 扩展：create() 返回 Tiptap Extension/Mark/Node 实例。
 * 用工厂函数而非实例，避免多个编辑器实例共享同一份扩展状态。
 * 宿主在构造编辑器时收集，注册表变更会重建编辑器扩展列表。
 */
export interface EditorExtensionDef {
  key: string;
  create: () => unknown;
  order?: number;
}

/** 编辑器工具栏条目：渲染在正文卡片上方的插件工具栏 */
export interface EditorToolbarItemDef {
  key: string;
  label: string;
  icon?: unknown;
  /** 点击回调，收到当前 Tiptap editor 实例（unknown，插件侧自行断言） */
  run: (editor: unknown) => void | Promise<void>;
  /** 是否处于激活态（如 mark 已应用）；用于按钮高亮 */
  isActive?: (editor: unknown) => boolean;
  order?: number;
}

/** 选区菜单动作：选中正文时浮出的菜单里追加一项 */
export interface SelectionActionDef {
  key: string;
  label: string;
  /** 图标（LucideIcon 组件或 emoji 字符串皆可） */
  icon?: unknown;
  /** hover 背景色（缺省用主题色） */
  color?: string;
  /** 点击回调，收到选中文本与 editor 实例 */
  run: (payload: { text: string; editor: unknown }) => void | Promise<void>;
  order?: number;
}

/**
 * 带鉴权的 API fetch：自动附加 JWT Authorization 与当前项目 X-Project-Id 头。
 * 插件 Web 面必须通过它访问后端（不要使用裸 fetch——服务端 /api/plugins/* 默认要求登录）。
 */
export type WebApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

// ---- 子代理运行契约（宿主实现，flow 型技能执行底座）----

/** 子代理运行选项 */
export interface AgentRunOptions {
  /** 子代理 system 指令 */
  system: string;
  /** 任务输入（任务描述 + 上下文材料） */
  input: string;
  /** 允许调用的工具名白名单（缺省 = 不挂任何工具，纯生成） */
  tools?: string[];
  /** 覆盖默认模型（缺省用当前 AI 配置的模型） */
  model?: string;
  /**
   * 单次模型调用的输出 token 上限。
   * 不传时宿主不发送 max_tokens，由服务商默认值兜底 —— 而推理模型的**思考 token
   * 也计入该上限**，默认值偏小时模型会自行收短输出（长文写作尤其明显），
   * 所以需要长输出的调用方应显式给足。
   */
  maxTokens?: number;
  /**
   * 采样参数（可选）。缺省时用用户在「AI 设置」里配的值；
   * 显式传入则覆盖配置 —— 机判类调用（校对/润色）应显式给低温以保证稳定。
   */
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** 项目隔离上下文 */
  context: { projectId: string; userId?: string };
  /** 章节写入能力（默认 false；仅流程收尾交付步显式开启，宿主二次校验） */
  allowWriteChapter?: boolean;
  /** 最大工具轮数（防失控，缺省 8） */
  maxTurns?: number;
  /**
   * 思维链增量的实时回调（推理型模型的 reasoning_content）。
   *
   * 为什么要这个口子：宿主用的 OpenAI Agents SDK（0.14.3）在 Chat Completions 通道下
   * **完全不解析 reasoning_content**，SDK 层拿不到 —— 宿主改为在 provider 的 fetch 上做只读旁路
   * 截取，再从这里推给调用方。拿不到（模型不吐 / 非推理模型 / 非流式）时**一次都不回调**，
   * 调用方必须按「可能没有」处理。
   */
  onThinking?: (delta: string) => void;
}

/** 子代理运行结果（审计台账的最小记录面） */
export interface AgentRunResult {
  /** 最终文本输出 */
  text: string;
  /** 实际使用的模型名（审计台账用） */
  model: string;
  /**
   * 本次运行的完整思维链（无则 undefined）。
   * 与 onThinking 是**同一份内容**：这里给「结束后要展示/落库」的调用方，
   * 那里给「边跑边显示」的调用方。
   */
  thinking?: string;
}

export interface WebPluginContext extends BasePluginContext {
  /** 注册项目浮窗面板（插件主功能 UI 入口） */
  registerProjectPanel(panel: FloatingPanelDef): () => void;
  /** 注册命令（Ctrl+K） */
  registerCommand(cmd: WebCommandDef): () => void;
  /** 注册顶级路由 */
  registerRoute(def: WebRouteDef): () => void;
  /** 注册设置页区块（默认挂在「插件」分类下） */
  registerSettingsSection(def: SettingsSectionDef): () => void;
  /** 注册编辑器 Tiptap 扩展（正文高亮/标记/输入规则等） */
  registerEditorExtension(def: EditorExtensionDef): () => void;
  /** 注册编辑器工具栏按钮 */
  registerEditorToolbarItem(def: EditorToolbarItemDef): () => void;
  /** 注册选区菜单动作（选中正文后浮出） */
  registerSelectionAction(def: SelectionActionDef): () => void;
  /**
   * 注册技能图标映射（key = 技能 id，value = 图标组件）。
   * 技能内容归插件所有后，图标映射也随技能走：技能选择器按「插件注册 → 内置兜底 → Puzzle」解析。
   */
  registerSkillIcons(icons: Record<string, unknown>): () => void;
  /**
   * 接管 AI 聊天浮窗左缘的功能气泡栏（模式开关/技能/快捷语）。
   * 宿主持有全部状态，按 ChatRailProps 下发并接收回调；先注册者生效，无插件注册时回退内置气泡栏。
   * 组件 props：syncInsert/enableTools/enableAgent/activeSkillId +
   * onToggleSync/onToggleTools/onToggleAgent/onSkillChange(id: string | null)。
   */
  registerChatRail(def: { key: string; Component: unknown }): () => void;
  /**
   * 注册模块级工作台根组件（每模式单槽）。
   * 缺席时宿主渲染 <WorkbenchMissing/>（「工作台未安装」），另一模式不受影响。
   * 供 kernel 据此删除对具体工作台组件（如 AutoWriteWorkbench）的静态 import。
   */
  registerWorkbench(def: WorkbenchDef): () => void;
  /**
   * 注册内核内置气泡浮窗组件（按 def.key 键控多槽）。
   * 取代 kernel 对 LeftSidebar / ChatPanel 的静态 import；缺席时对应气泡不渲染。
   */
  registerBuiltinBubble(def: BuiltinBubbleDef): () => void;
  /**
   * 注册跨模块能力实现（name 取自 core 常量 WEB_CAPABILITIES）。
   * 返回注销函数；同 name 后注册覆盖前者。
   */
  registerCapability(name: WebCapabilityName, impl: unknown): () => void;
  /**
   * 获取跨模块能力实现；未注册时返回 null。
   * 消费点必须隐藏入口或本地兜底，**禁止 throw**（缺席降级契约）。
   */
  getCapability<T = unknown>(name: WebCapabilityName): T | null;
  /** 带鉴权的 API fetch（自动附加 JWT 与项目头，替代裸 fetch） */
  api: WebApiFetch;
}

// ---- Web 插件模块契约 ----

export interface WebPluginModule {
  name?: string;
  inject?: string[];
  apply(ctx: WebPluginContext): void | Promise<void>;
}
