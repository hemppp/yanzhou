# 砚舟 模块化 / 插件化改造方案

> 参照系：DeepSeek Harness (DSH) 插件机制（cordis 框架 + 双面插件 + manifest 热插拔）
> 目标：让「新增一个写作功能模块」从 *改 6 个文件* 变成 *写一个插件目录*
> 状态：✅ 已在 F:\new1.2 落地（v2 实现版） · 本文件前段为 v1 设计稿，见文末「v2 落地说明」

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [现状分析](#2-现状分析)
3. [参照系：DSH 插件机制](#3-参照系dsh-插件机制)
4. [可行性评估](#4-可行性评估)
5. [目标架构总览](#5-目标架构总览)
6. [插件 Manifest 规范](#6-插件-manifest-规范)
7. [Server 端扩展点 API](#7-server-端扩展点-api)
8. [Web 端扩展点 API](#8-web-端扩展点-api)
9. [数据层扩展](#9-数据层扩展)
10. [AI 层扩展](#10-ai-层扩展)
11. [安全与权限模型](#11-安全与权限模型)
12. [插件加载与热插拔](#12-插件加载与热插拔)
13. [内置模块插件化改造路线](#13-内置模块插件化改造路线)
14. [分期实施计划](#14-分期实施计划)
15. [风险与对策](#15-风险与对策)
16. [示例插件设计](#16-示例插件设计)
17. [附录：与 DSH 机制对照表](#17-附录与-dsh-机制对照表)

---


---

## ✅ v2 落地说明（F:\new1.2）

本设计稿的「自研内核」路线在落地时被替换为**直接采用 @deepseek-ai/cordis**（DSH 生产级插件生态、fiber 生命周期、注入/依赖解析、热插拔开箱即用，无需再造轮子）。落地清单：

| 组件 | v2 实现 |
|------|---------|
| 内核 | `@deepseek-ai/cordis 4.0.1`（root `link:` 依赖，指向本机 DSH 安装树） |
| HTTP 服务 | `@deepseek-ai/dsh-host-webserver rc.6` → `ctx.webServer`（路由/静态/upgrade/fallback） |
| 宿主 | `apps/server/src/plugin/host.ts`：`createServerPluginHost({kv})` → 真实 cordis `Context` + `ctx.provide(...)` 扩展点 |
| 契约包 | `packages/core` v2：server 入口 + 浏览器安全入口 `@novel/core/web` |
| 模块挂载 | 20 个 API 模块 + AI + 管理 = 内置插件（`builtinEntry`，`modes: ['shared']`）；插件管理 = `novel.plugin-manager`；目录插件扫描 `apps/plugins/{manual,auto,shared,local}` |
| 模式拆分 | 插件层按创作模式物理拆目录：`manual/`（手写台）/ `auto/`（AI 写作）/ `shared/`（共享）/ `local/`（AI 动态创建，默认 shared）。manifest 新增 `modes` 字段；宿主 `HOST_MODE` 启动过滤；运行时跨模式路由 404 `PLUGIN_MODE_MISMATCH`；安装门 G2.5 校验目录↔modes 一致（`MODE_MISMATCH`） |
| 静态托管 | 生产态由 webServer fallback 托管 web dist（SPA 回退） |
| 已知约束 | Hono 路由运行时不可摘除 → 插件卸载后路由需重启生效（启动时打印警告，与 v1 设计一致） |

### 实测验证

- `pnpm type-check`（全工作区 8 包）✅ · server/web 构建 ✅
- 冒烟：22 插件全 ok（health 200）、登录/建项目/读取/删除 ✅、生产静态 + SPA 回退 ✅、未授权 401 ✅
- 模式分离（2026-09-29）：`scripts/verify/verify-plugin-mode-separation.mjs` 起 `HOST_MODE=manual/auto` 两个临时 server，断言插件集合正确分离、跨模式 404 `PLUGIN_MODE_MISMATCH`、G2.5 构造用例、worldbuilding 真加载 ✅；`scripts/e2e/e2e-mode-separation.mjs` 浏览器断言 manual 项目无 AI UI、auto 项目无手写面板 ✅
- 启动命令：`pnpm dev`（web+server）／`pnpm dev:server` ／`pnpm build && pnpm start:server`

## 1. 背景与目标

### 1.1 为什么要插件化

当前 砚舟 的功能增长模式是「往 monorepo 里加文件」：每新增一个实体类型（角色/地点/物品/伏笔…），都要触碰至少 6 处代码：

| 改动点 | 位置 |
|--------|------|
| 数据表 | `packages/db/src/schema.ts` + drizzle 迁移 |
| 后端路由 | `apps/server/src/modules/*.ts` + `index.ts` 手写 `app.route()` |
| 后端服务 | `apps/server/src/services/*.ts` |
| AI 工具 | `apps/server/src/ai/tools/*.ts` + `tools/registry.ts` 注册 |
| AI 技能 | `apps/server/src/ai/agents/skills.ts` + 前端 `skillsConfig.ts` |
| 前端面板 | `apps/web/src/components/layout/ProjectLayout.tsx` 的 `floatingPanelConfigs` 数组 |

问题：
- **改核心**：`index.ts`（19 个路由静态 import）、`ProjectLayout.tsx`（12 个面板硬编码）成为每次迭代都要动的热点文件，极易冲突。
- **无法外部化**：第三方作者（或你自己写工具脚本）无法在不改源码的情况下给 砚舟 加能力。
- **功能无法开关**：扫描、风格分析、周报等能力全部常驻，无法按项目/用户启用或禁用。
- **AI 能力与 UI 割裂**：新增一个 AI 技能需要同时改后端 `skills.ts` 和前端 `skillsConfig.ts`，两处容易失同步。

### 1.2 改造目标

1. **定义稳定的插件契约**：一套 Manifest + 扩展点 API，内置模块与外部插件走同一套注册机制。
2. **渐进式改造**：先把「注册机制」建起来，现有 19 个路由 / 12 个面板逐个迁移成「内置插件」，不搞一步到位的大重写。
3. **安全默认**：插件声明权限、AI 工具延续「不暴露 delete + 项目隔离」约束、前端 CSP 不放宽。
4. ~~保留现有技术栈，自研轻量内核~~ —— **已否决**：v2 最终采用真实 **@deepseek-ai/cordis 4.0.1** 作为内核（DSH 同款），自研宿主代码全部移除；`packages/core` 退化为纯契约包。

---

## 2. 现状分析

### 2.1 后端（apps/server）

- **入口**：`src/index.ts` —— 静态 import 19 个 router，`app.route('/api/xxx', router)` 硬编码注册；同时承担健康检查、静态文件服务、DB 初始化、定时清理、优雅关闭。
- **应用工厂**：`src/lib/app-factory.ts` —— `createApp()` 集中 CORS / 安全头 / body 限制 / 日志 / 错误处理。**这是天然的宿主注入点**。
- **模块**：`src/modules/*.ts` —— 每个文件一个 Hono Router，模式高度统一（zValidator + service 调用）。共 19 个。
- **服务**：`src/services/*.ts` —— `BaseService<T>` 泛型 CRUD 基类（`loadAll/getById/save/update/delete/loadAllSafe`），支持 `scope: 'global' | 'project'` 双库作用域。**抽象度已经很好，插件可直接复用 BaseService**。
- **AI 层**（`src/ai/`）已有「准插件」雏形：
  - `tools/registry.ts` —— **已经是一个注册表**：`registerTool / registerTools / getAllToolDefinitions / executeTool / isRegisteredTool / clearRegistry`，含项目隔离（ToolContext.projectId）与「不暴露 delete」约束。这是整个改造最好的起点。
  - `agents/skills.ts` —— `SKILLS: Record<string, SkillDef>` 静态表（后端 prompt + contextKeys）。
  - `agents/sdk/` —— 基于 `@openai/agents` 的通用 Agent 运行时（多步规划、工具调用循环、流式事件映射）。
  - `providers/provider-factory.ts` —— provider 工厂 + `configLoaders`。
  - `context-builder.ts` —— AI 对话上下文组装。

### 2.2 前端（apps/web）

- **路由**：`src/App.tsx` 硬编码 8 个顶级路由；`src/routes/paths.ts` 硬编码 `PATHS` / `PROJECT_ROUTES` 常量。
- **项目工作台**：`src/components/layout/ProjectLayout.tsx` —— **硬编码 12 个浮窗面板** `floatingPanelConfigs`（icon/label/key/Component/width/height，lazy import），`MAX_OPEN_PANELS = 3`。这是前端最大的改造热点。
- **布局**：`LeftSidebar`（章节列表）、`PanelSection`、`BottomDrawer`、`StatusBar`、`AIRedstonePanel`（AI 侧栏）。
- **状态**：Zustand，`stores/index.ts` 聚合 + 各独立 store（authStore/projectStore/aiStore/editorStore…）。
- **服务**：`services/api/apiClient.ts`（统一 fetch 封装）+ 各模块 API；`services/data/databaseService.ts`（本地缓存/同步）。
- **编辑器**：Tiptap，`components/editor/extensions/*`（MentionExtension、CustomHighlight、LeadCharacterHighlight）。
- **命令面板**：`components/ui/CommandPalette.tsx`（全局 Ctrl+K）—— 天然的命令注册点。

### 2.3 数据层（packages/db）

- **schema**：20 张表（users/projects/chapters/characters/items/locations/storyEvents/foreshadows/earmarks/annotations/outlineNodes/timelineEvents/notes/referenceBooks/writingStats/snapshots/aiConversations/textMarkers/series/userSettings）。
- **双库架构**：主库（`getDb()`，全局限定）+ 项目库（`getProjectDbSync(projectId)`，每本书一个独立 .db），`BaseService.scope` 已抽象。
- **迁移**：drizzle 单次初始迁移 + `migrate-to-project-dbs.ts`（主库→项目库拆分）。
- **难点**：插件要加「正式表」需要一套独立于集中 schema 的迁移通道；因此第一版提供 **KV 兜底表**，正式表迁移作为 v2 能力。

### 2.4 结论

砚舟 的**后端抽象度显著好于前端**：
- 服务层有 `BaseService`、AI 工具层有注册表 → 后端插件化改造量小、风险低。
- 前端硬编码集中（路由表、面板数组）→ 前端插件化的本质是把这两个数组 + PATHS 变成「注册表 + 渲染循环」，改造集中、可一步到位。
- 数据层双库 + 集中 schema → 插件数据扩展需要专门设计。

---

## 3. 参照系：DSH 插件机制

DSH 的插件化是「cordis 插件框架 + 双面插件 + manifest 热插拔」三件套，直接照搬到 砚舟 不现实（cordis 是通用 agent 平台的产物），但它的**设计模式**值得逐条借鉴：

| DSH 机制 | 要点 | 砚舟 借鉴 |
|----------|------|----------------|
| 插件 = npm 包 | package.json 的 `dsh` 字段声明 manifest；`exports "."` 服务端面 + `exports "./client"` 浏览器面 | Manifest 字段 `novelMuse`，双面入口同上 |
| cordis `apply(ctx, config)` | 插件入口是一个纯函数，接收上下文与配置 | `plugin.apply(ctx, config)` 同构 |
| `inject` 依赖声明 | 声明需要的服务，运行时按依赖注入等待 | 同 |
| `ctx.effect(() => disposer, label)` | 注册/清理配对，重注册先拆旧的。execute 会被立即调用，其返回值才是 disposer——直接传 disposer 会导致挂载瞬间被清理 | 同 |
| 扩展点 = 服务 | `webServer.register(route)`、`tools.register(tool)`、`systemPrompt.section()`、settings section、slots（UI 插槽）、locale | 映射为 `ctx.routes` / `ctx.ai.tools` / `ctx.settings` / Web 注册点 |
| 配置 = schema | schemastery 定义 Config，设置页即配置源，改动触发 `sync()` 重挂载 | 简化：Zod schema + 设置 section 回调 |
| 热插拔 | `dsh plugin --profile add` + `cordis.patch.yml` + node_modules 符号链接，不改源码 | `data/plugins.json` 启用列表 + `apps/plugins/` 内置 + 外部本地目录 |
| 失败策略 | 客户端挂载失败只 log 不 throw，插件不能拖垮 GUI | 插件 apply 抛错只禁用该插件 |
| 双面分离 | 引擎/路由/工具在宿主进程；DOM/面板在浏览器 | 同上：server 面做逻辑，web 面做 UI |

---

## 4. 可行性评估

### 4.1 有利因素

- ✅ **monorepo 已就位**：`apps/*` + `packages/*` + pnpm workspaces，新增 `packages/core`、`packages/plugin-api` 是零成本。
- ✅ **后端抽象成熟**：`BaseService` 泛型 CRUD + 双库 scope，插件服务层可以直接继承。
- ✅ **AI 工具已是注册制**：`tools/registry.ts` 就是现成的插件注册表，只需包装成 `ctx.ai.tools`。
- ✅ **统一技术栈**：全 TS + Hono + React + Zustand，插件 API 类型天然共享（`packages/shared` 已有）。
- ✅ **前端改造点集中**：路由表（App.tsx）+ 面板数组（ProjectLayout）是仅有的两处硬编码聚合点，替换为注册表驱动的渲染循环即可，不涉及组件内部重写。

### 4.2 挑战

- ⚠️ **281 项未提交变更**：改造前必须先提交基线，否则无法定位回归。
- ⚠️ **ProjectLayout 巨型组件**（面板管理 + 拖拽 + 动画 + 参考书 + AI 侧栏混在一起）：需先抽取「面板宿主」再注册化。
- ⚠️ **数据层集中 schema**：插件正式表需要迁移通道，第一版用 KV 兜底降低风险。
- ⚠️ **前端构建管线**：Vite 对「外部动态加载插件」不友好（CSP `script-src 'self'` + 打包后无法 import 任意路径）→ 采用**构建期插件清单**（启用列表静态 import，输出独立 chunk），不做运行时远程加载。
- ⚠️ **双库迁移**：主库/项目库两套迁移要同时支持插件表。

### 4.3 结论

**可行，且成本可控。** 整体工作量主要落在「前端扩展点 + 插件内核 + 构建管线」三块；后端因为已有注册表和泛型服务层，改造是包装级工作量。建议以「新增实体全栈插件」为第一个试点，验证契约后再铺开内置模块迁移。

---

## 5. 目标架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     砚舟 宿主 (host)                     │
│                                                               │
│  apps/web  ──┐                                          ┌── apps/server
│  ┌──────────▼───┐   REST /api/*      ┌─────────────────▼───┐
│  │ Web Shell     │◄──────────────────►│ Server Core         │
│  │ · 路由渲染    │   WebSocket(SSE)   │ · createApp()       │
│  │ · 面板宿主    │                    │ · 中间件链          │
│  │ · 命令面板    │                    │ · 双库 (主/项目)    │
│  │ · 设置宿主    │                    │ · AI pipeline       │
│  └──────┬────────┘                    └─────────┬───────────┘
│         │                                       │
│  ┌──────▼──────────────────┐   ┌───────────────▼───────────┐
│  │ WebPluginHost (注册表)   │   │ ServerPluginHost (注册表)  │
│  │ route/panel/command/    │   │ routes/services/ai/db/    │
│  │ setting/editor/toolbar  │   │ events/hooks/scheduler    │
│  └──────┬──────────────────┘   └───────────────┬───────────┘
│         │                                       │
│  ┌──────▼──────────────────┐   ┌───────────────▼───────────┐
│  │ 插件 Web 面 (./web)      │   │ 插件 Server 面 (./server)  │
│  │ apply(ctx, config)       │   │ apply(ctx, config)        │
│  └──────────────────────────┘   └───────────────────────────┘
│         ▲                                       ▲
│         └─────────── Manifest (novelMuse) ──────┘
│                      npm 包 / apps/plugins/* 目录
└─────────────────────────────────────────────────────────────┘
```

### 5.1 新增包结构

```
packages/
  core/               # 插件内核（零依赖，~500 行）
    src/
      context.ts      # PluginContext / WebPluginContext 类型
      registry.ts     # 通用注册表（register/get/list/clear + dispose 配对）
      loader.ts       # manifest 解析 + 依赖排序 + apply + 生命周期
      manifest.ts     # Manifest 类型 + zod 校验
      events.ts       # 事件总线（on/emit/off，支持 async 序列）
      hooks.ts        # 钩子（before/after/around，支持拦截与短路）
  plugin-api/         # 插件作者依赖的类型包（re-export core + shared）
    package.json      # exports: { ".": 类型, "./web": Web 类型 }
  db/                 # 现有，新增 plugin_kv 表 + 迁移注册通道
apps/
  plugins/            # 内置插件仓库（按创作模式物理拆分 —— 2026-09-29 落地）
    manual/           # 仅手写台：worldbuilding（示例）/ novel.bookscan
    auto/             # 仅 AI 写作：novel.autowrite
    shared/           # 两种模式共享：novel.typography
    local/            # AI 对话动态创建区（默认 shared，当前为空）
  server/             # 宿主改造
  web/                # 宿主改造
```

> 父目录名即插件适用模式的**事实来源**（`local` → `shared`），`manifest.modes` 必须与之严格一致，
> 否则安装门 G2.5 拒绝（`MODE_MISMATCH`）。完整规范见 [`plugin-standard.md`](./plugin-standard.md)。

### 5.2 插件生命周期

```
load ──► validate(manifest) ──► resolveDeps(inject 排序) ──► configure(合并默认配置)
  ──► apply(ctx, config) ──► ready ──► (运行期 sync：设置变更 → 重挂载)
  ──► unload(按逆序调用 disposers) ──► disposed
```

- 失败策略：某插件 `apply` 抛错 → 记录错误、标记 `status: 'error'`、**跳过该插件**，宿主继续启动；管理页可见错误信息。
- 生命周期清理：插件内所有注册必须通过 `ctx.effect(() => disposer)` 配对，宿主卸载时逆序执行。

---

## 6. 插件 Manifest 规范

采用 **package.json 的 `novelMuse` 字段**（npm 包形态）或 **`plugin.json`**（本地目录形态），两套等价，加载器统一解析。
完整校验规则与安装门见 [`docs/architecture/plugin-standard.md`](./plugin-standard.md)。

```jsonc
{
  "name": "@novel-plugins/worldbuilding",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/server.js",        // Server 面入口
  "exports": {
    ".": "./dist/server.js",
    "./web": "./dist/web.js"          // Web 面入口（浏览器）
  },
  "novelMuse": {
    "id": "novel.worldbuilding",             // 全局唯一，反向域名风格
    "name": "世界观建造师",
    "description": "势力/宗教/科技树实体管理 + AI 世界观顾问",
    "version": "0.1.0",
    "minHostVersion": "0.9.0",               // 宿主最低版本（内核 API 兼容性）
    "modes": ["manual"],                     // 适用创作模式 manual/auto/shared；缺省 ['shared']，须与目录一致
    "permissions": ["routes", "db:project", "ai:tools", "ai:skills", "events"],
    "server": {
      "entry": ".",                          // 默认 main；可省略
      "inject": ["routes", "ai", "db", "events", "settings", "scheduler"]
    },
    "web": {
      "entry": "./web",
      "inject": ["projectPanels", "routes", "settings", "commands", "editor"]
    },
    "db": {
      "globalMigrations": "./migrations/global",   // 可选：主库迁移目录
      "projectMigrations": "./migrations/project"  // 可选：项目库迁移目录
    }
  }
}
```

Manifest 校验（zod）：`id` 唯一、`permissions` 必须是白名单子集、`inject` 引用已注册服务名、`minHostVersion` 语义化版本比较。校验失败 → 插件不加载，错误进管理页。

---

## 7. Server 端扩展点 API

`packages/core/src/context.ts` 定义，插件 Server 面 `apply(ctx, config)` 使用：

```ts
export interface PluginContext {
  /** 插件 id（manifest 注入） */
  readonly id: string;
  /** 解析后的配置（默认配置 + 用户设置合并，设置变更自动重挂载） */
  readonly config: Readonly<Record<string, unknown>>;

  /** ── 路由：注册 Hono 子路由（替代 index.ts 手写 app.route）── */
  routes: {
    register(prefix: string, router: Hono): () => void;
  };

  /** ── 服务：注册业务服务（供其他插件 inject 复用）── */
  services: {
    register<T>(name: string, instance: T): () => void;
    get<T>(name: string): T | undefined;
  };

  /** ── 数据库 ── */
  db: {
    /** 主库（全局限定，users/settings/plugin_kv） */
    global: () => ReturnType<typeof getDb>;
    /** 项目库（项目隔离，实体数据） */
    project: (projectId: string) => ReturnType<typeof getProjectDbSync>;
    /** 插件 KV：第一版唯一推荐的数据扩展方式 */
    kv: KvService;
    /** 注册迁移：v2 能力，插件可带正式表迁移 */
    migrate(migrations: PluginMigration[], scope: 'global' | 'project'): void;
  };

  /** ── AI 层（全部复用/包装现有注册表）── */
  ai: {
    tools: ToolRegistry;          // 包装 ai/tools/registry.ts
    skills: SkillRegistry;        // 包装 ai/agents/skills.ts（SKILLS → 可注册）
    agents: AgentRegistry;        // 新增：name + handler 注册
    providers: ProviderRegistry;  // 包装 provider-factory configLoaders
    contextBuilder: ContextBuilderRegistry; // 上下文注入器
  };

  /** ── 事件总线（跨插件、跨端解耦）── */
  events: {
    on<T>(name: string, handler: (payload: T) => void | Promise<void>): () => void;
    emit<T>(name: string, payload: T): Promise<void>;
  };
  /** 内置事件：chapter.saved / chapter.deleted / entity.updated / ai.scan.completed / project.opened / export.before … */

  /** ── 钩子（可拦截可短路，如导出前校验）── */
  hooks: {
    before(name: string, fn: HookFn): () => void;
    after(name: string, fn: HookFn): () => void;
    around(name: string, fn: AroundHookFn): () => void;
  };

  /** ── 设置：注册设置 section（设置页自动渲染）── */
  settings: {
    registerSection(def: SettingSectionDef): () => void;
  };

  /** ── 调度：定时任务（复用现有 setInterval 清理模式）── */
  scheduler: {
    register(cron: string | { intervalMs: number }, fn: () => void | Promise<void>): () => void;
  };

  /** ── 系统提示：往 AI 对话注入能力声明（对应 DSH systemPrompt.section）── */
  prompt: {
    section(def: { name: string; order: number; text: string }): () => void;
  };

  /** ── 生命周期：注册清理器，卸载时逆序执行 ── */
  effect(disposer: () => void, label?: string): void;

  /** ── 日志（带插件名前缀）── */
  logger: Logger;
}
```

### 7.1 路由注册（核心）

`index.ts` 的改造：把 19 行 `app.route()` 替换为「内置插件列表驱动」：

```ts
// 现状（index.ts 89–107 行）
app.route('/api/auth', authRouter);
app.route('/api/projects', projectsRouter);
// … 共 19 行硬编码

// 改造后
const host = createServerPluginHost({ app, db, ai });
for (const plugin of loadPlugins(PLUGIN_CONFIG)) {
  await host.mount(plugin);   // 内部：validate → resolve → apply → collect disposers
}
```

每个现有模块变成一个「内置插件」的 Server 面：

```ts
// apps/plugins/characters/server.ts（内置插件示例）
import { Hono } from 'hono';
import type { PluginContext } from '@novel/core';

export const name = 'novel.characters';
export const inject = ['routes', 'db'];

export function apply(ctx: PluginContext) {
  const router = new Hono();
  router.get('/', (c) => c.json({ ok: true }));
  router.post('/', ...);
  ctx.effect(() => ctx.routes.register('/api/characters', router), 'characters: routes');
}
```

### 7.2 事件总线

内置事件命名空间（`<domain>.<action>`），插件与宿主、插件与插件之间通过事件解耦：

```ts
// 宿主在 chapter-service 保存后 emit
await ctx.events.emit('chapter.saved', { projectId, chapterId, wordCount });

// 插件（如写作周报）订阅
ctx.events.on('chapter.saved', async ({ projectId }) => {
  await statsService.recordDaily(projectId);
});
```

事件处理器 `await` 串行等待；处理器抛错被捕获并记录，不中断 emit 链（避免一个坏插件打断其他订阅者）。

---

## 8. Web 端扩展点 API

`packages/core/src/context.ts` 定义 `WebPluginContext`，插件 Web 面 `apply(ctx)` 使用：

```ts
export interface WebPluginContext {
  readonly id: string;

  /** ── 路由：注册顶级/项目内路由（App.tsx 的路由表变成注册表驱动）── */
  registerRoute(path: string, Component: React.ComponentType, opts?: {
    layout?: 'landing' | 'protected' | 'admin';  // 对应 ProtectedRoute 分级
    parent?: 'project';                           // 挂到 /project/:bookId 下
  }): () => void;

  /** ── 项目浮窗面板：直接映射 ProjectLayout.floatingPanelConfigs ── */
  registerProjectPanel(panel: {
    icon: LucideIcon; label: string; key: string;
    Component: React.ComponentType; width?: number; height?: number;
  }): () => void;

  /** ── 侧边栏 / AI 侧栏入口 ── */
  registerSidebarEntry(def: { key: string; icon: LucideIcon; label: string; onClick(): void }): () => void;

  /** ── 命令面板（Ctrl+K）── */
  registerCommand(cmd: { id: string; title: string; keywords?: string[]; run(): void | Promise<void> }): () => void;

  /** ── 设置页 section ── */
  registerSettingSection(def: { key: string; title: string; icon?: LucideIcon; Component: React.ComponentType }): () => void;

  /** ── 编辑器扩展：Tiptap extensions ── */
  registerEditorExtension(extension: AnyExtension): () => void;
  /** ── 编辑器工具条按钮 ── */
  registerToolbarAction(def: { key: string; icon: LucideIcon; label: string; run(): void; active?(): boolean }): () => void;

  /** ── 编辑器划词菜单 / 右键菜单 ── */
  registerSelectionAction(def: SelectionActionDef): () => void;

  /** ── 前端 API 客户端：插件自带 API 的封装 ── */
  registerApiModule<T>(name: string, api: T): () => void;

  /** ── 本地化 ── */
  registerLocale(dict: Record<string, string>, lang?: 'zh' | 'en'): () => void;

  /** ── Zustand：插件状态切片（可选，多数插件用本地 state）── */
  registerStoreSlice<S>(name: string, slice: S): () => void;

  /** ── 事件：订阅服务端事件（经 SSE/轮询转发）── */
  onServerEvent<T>(name: string, handler: (payload: T) => void): () => void;

  /** ── 统一 API 客户端 ── */
  readonly api: ApiClient;

  /** ── 生命周期 ── */
  effect(disposer: () => void, label?: string): void;

  /** ── 日志 ── */
  readonly logger: Logger;
}
```

### 8.1 关键改造：面板宿主

`ProjectLayout.tsx` 抽取为「面板宿主」+「面板注册表」：

```tsx
// 现状：floatingPanelConfigs 是文件内硬编码数组
// 改造后：floatingPanels = usePluginPanels('projectPanel')   // 注册表聚合
//   ├── 内置 12 面板由内置插件各自 registerProjectPanel()
//   └── ProjectLayout 只负责：渲染、拖拽、MAX_OPEN_PANELS、缓存
```

改造收益：ProjectLayout 不再随功能迭代而膨胀；新增面板 = 新建插件目录，不再触碰宿主文件。

### 8.2 前端插件加载（构建期清单）

由于 CSP 限制（`script-src 'self'`）与打包后可执行性，**不做运行时远程加载**：

1. 构建时读取 `data/plugins.json`（或 `novelmuse.config.ts`）启用列表；
2. 生成 `plugins.manifest.ts`（静态 import 所有启用插件的 `./web` 入口 + manifest 元数据）；
3. 打包成独立 chunk（沿用现有 manualChunks 策略）；
4. 运行时按 manifest 顺序 `apply`，每个插件包一层 `<ErrorBoundary>`，apply 失败只禁插件。

开发态热插拔：启用 `vite-plugin` 监听 `apps/plugins/**` 变更 → 重生成 manifest → HMR。

---

## 9. 数据层扩展

### 9.1 第一版：插件 KV 表（推荐）

新增两张表（主库 + 项目库各一），满足绝大多数插件「存配置/存轻量数据」的需求，**不需要迁移机制**：

```ts
// packages/db/src/schema.ts 新增
export const pluginKv = sqliteTable('plugin_kv', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  key: text('key').notNull(),                    // 命名空间：'settings.theme' / 'stats.weekly'
  value: text('value').notNull(),                // JSON 序列化
  projectId: text('project_id'),                 // null = 全局；有值 = 项目隔离
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // 唯一约束：(pluginId, key, projectId)
});

// KvService 接口
interface KvService {
  get<T>(pluginId: string, key: string, opts?: { projectId?: string }): T | undefined;
  set(pluginId: string, key: string, value: unknown, opts?: { projectId?: string }): Promise<void>;
  list(pluginId: string, prefix?: string, opts?: { projectId?: string }): Array<{ key: string; value: unknown }>;
  delete(pluginId: string, key: string, opts?: { projectId?: string }): Promise<void>;
}
```

**规则**：写操作必须带 `projectId` 或显式声明全局；插件 KV 的 key 强制加插件前缀（防冲突）。这正是现有 AI 工具「项目隔离」约束的延续。

### 9.2 第二版：插件正式表 + 迁移通道

插件 manifest 的 `db.migrations` 指向迁移目录，加载时执行：

```ts
// 插件迁移文件格式（每文件一个版本，命名 0001_name.sql）
// 支持 global / project 两套作用域，分别应用到主库和项目库
ctx.db.migrate([
  { version: 1, scope: 'project', sql: `
      CREATE TABLE IF NOT EXISTS factions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        name TEXT NOT NULL, description TEXT,
        createdAt INTEGER, updatedAt INTEGER
      );
  ` },
], 'project');
```

- 迁移在插件**首次启用**时执行；`plugin_registry` 表记录每个插件已应用的迁移版本。
- 数据访问：插件自行用 drizzle `sqliteTable` 定义对应表结构（与迁移 SQL 保持同步），或直接用 `ctx.db.project(projectId).exec(sql)` 查询。
- 卸载插件：**不删表**（数据是用户的），只停止注册。

### 9.3 双库策略总结

| 数据 | 位置 | 插件可用性 |
|------|------|-----------|
| 用户/设置/插件注册 | 主库 | ✅ `ctx.db.global()` + KV(无 projectId) |
| 实体/章节/项目数据 | 项目库 | ✅ `ctx.db.project(projectId)` + KV(带 projectId) |
| 插件正式表 | 迁移通道 | v2 能力，`ctx.db.migrate` |

---

## 10. AI 层扩展

AI 层是**改造收益最大、风险最低**的部分，因为 `tools/registry.ts` 已是注册表：

### 10.1 工具（现成）

```ts
// 现有 ai/tools/registry.ts 已经支持：
registerTool(name, definition, handler);   // handler(args, { projectId })
// 插件包装：
ctx.ai.tools.register({ definition, handler });
```
安全约束自动继承：不暴露 delete、ToolContext 强制 projectId、未知工具返回错误而非抛异常。

### 10.2 技能（SKILLS 静态表 → 注册表）

```ts
// 现状：SKILLS: Record<string, SkillDef> 静态导出，前端 skillsConfig.ts 单独维护一份
// 改造：
ctx.ai.skills.register({
  id: 'worldbuilder',
  systemPrompt: '…世界观顾问…',
  contextKeys: ['locations', 'items', 'factions'],
});
// 前端由 /api/ai/skills 或构建期清单同步渲染技能列表，消除双份维护
```

### 10.3 Agent（新增注册表）

```ts
ctx.ai.agents.register({
  name: 'timeline-analyst',           // 现有 timeline-analysis-agent 迁移示例
  description: '时间线一致性分析',
  input: z.object({ projectId: z.string(), range: z.string().optional() }),
  handler: async ({ projectId }, deps) => { /* 复用现有 runTimelineAnalysis */ },
});
```

### 10.4 Provider 适配器

```ts
ctx.ai.providers.registerConfigLoader('my-provider', {
  priority: 10,
  load: () => ({ type: 'openai-compatible', baseURL: '…', apiKey: '…' }),
});
```

### 10.5 上下文构建器

```ts
ctx.ai.contextBuilder.register({
  name: 'faction-context',
  contextKeys: ['factions'],
  build: async (projectId, opts) => ({ factions: await factionService.list(projectId) }),
});
```

---

## 11. 安全与权限模型

### 11.1 权限声明（manifest.permissions）

白名单权限（与 DSH 的声明式插件一致，但简化）：

| 权限 | 含义 |
|------|------|
| `routes` | 注册后端路由（影响服务面） |
| `db:global` | 读/写主库（用户级数据，高风险） |
| `db:project` | 读/写项目库（需绑定 projectId） |
| `ai:tools` | 注册 AI 工具（默认继承「不暴露 delete」约束） |
| `ai:skills` / `ai:agents` | 注册技能 / 智能体 |
| `events` | 订阅/发布事件 |
| `settings` | 读写用户设置 |
| `scheduler` | 注册定时任务 |
| `filesystem` | 读写磁盘（预留，暂不开放） |
| `network` | 发起外部网络请求（预留，暂不开放） |

- 声明未授权权限 → 插件校验失败，拒绝加载。
- 管理页展示每个插件的权限清单，用户可禁用单个插件。

### 11.2 运行约束

- **Server 面**：与宿主同进程（单机工具信任模型，同 DSH 的 cordis patch）。风险通过「权限声明 + 用户知情」控制，不引入进程沙箱（本地单机场景收益低、成本高）。
- **Web 面**：仅通过统一 `apiClient` 访问后端（不放开 `fetch` 直连后端之外的目标）；CSP 保持 `script-src 'self'` 不放宽；插件 UI 包一层 ErrorBoundary。
- **数据隔离**：所有写操作必须绑定 `projectId` 或显式全局声明（KV 与 AI 工具同规则）。
- **AI 工具**：延续「只 create/update 不 delete + 项目隔离 + 未知工具容错」。

### 11.3 插件市场（v2，可选）

本地目录 / zip 安装：用户下载 → 校验 manifest + 权限清单 → 展示权限 → 确认启用。不做自动更新（数据安全优先）。

---

## 12. 插件加载与热插拔

### 12.1 启用列表（`data/plugins.json`）

```jsonc
{
  "version": 1,
  "enabled": [
    { "id": "novel.characters", "source": "builtin" },
    { "id": "novel.worldbuilding", "source": "local", "path": "./apps/plugins/worldbuilding" },
    { "id": "some.external", "source": "npm", "package": "@novel-plugins/foo", "enabled": false }
  ]
}
```

- 启动顺序：`builtin` 内置 → `local` 本地目录 → `npm` 外部包（按 `inject` 依赖拓扑排序）。
- 管理页（现有 `/admin`）提供启用/禁用/查看错误 UI。

### 12.2 热插拔（分两档）

| 档位 | 机制 | 适用 |
|------|------|------|
| 开发态 | 监听 `apps/plugins/**` → 重生成 manifest → Vite HMR（web）/ tsx watch 重启（server） | 插件作者 |
| 生产态 | 改 `plugins.json` → 重启服务生效；不做运行时热加载（数据一致性优先） | 用户 |

---

## 13. 内置模块插件化改造路线

不重写现有功能，只把「注册方式」从硬编码改为注册表。每个内置模块 = 一个内置插件，迁移顺序按风险从低到高：

| 批次 | 模块 | Server 面 | Web 面 | 风险 |
|------|------|-----------|--------|------|
| 0（试点） | AI 工具层 | `tools/registry` 包装成 `ctx.ai.tools` | — | 极低 |
| 0（试点） | 新增实体「世界观」 | 完整全栈插件（验证契约） | 面板 + API + AI 工具 | 低（新代码） |
| 1 | 路由注册 | 19 个 router 改内置插件注册 | — | 中（改 index.ts） |
| 2 | 项目面板 | — | 12 个面板改 `registerProjectPanel` | 中（改 ProjectLayout） |
| 3 | 技能/Agent | SKILLS → 注册表；agents 注册化 | skillsConfig 由清单驱动 | 低 |
| 4 | 设置页 | settings section | registerSettingSection | 低 |
| 5 | 命令面板/编辑器扩展 | — | registerCommand / registerEditorExtension | 低 |

每批次独立可回滚：宿主保留一个「legacy 直连模式」开关（`NOVELMUSE_LEGACY=1` 走旧 index.ts），迁移完删除。

---

## 14. 分期实施计划

> 估计基于单人全职；兼职按 ×2–×3 折算。每个 Phase 结束都有可运行、可测试的交付物。

### Phase 0 — 基线 & 内核骨架（0.5–1 周）

- [ ] 提交当前 281 项未提交变更（或至少打成 2–3 个大 commit），建立回归基线
- [ ] 新建 `packages/core`：`manifest.ts`（zod 校验）、`registry.ts`（通用注册表 + dispose 配对）、`events.ts`、`hooks.ts`、`context.ts`（类型）
- [ ] 写内核单元测试（vitest）
- **交付**：`packages/core` 可独立测试，宿主尚未改动，功能零变化

### Phase 1 — Server 插件宿主 + 路由注册化（1–2 周）

- [ ] `createServerPluginHost`：load → validate → resolveDeps → apply → 收集 disposers；失败隔离
- [ ] `data/plugins.json` 启用列表 + 内置插件扫描
- [ ] 将 19 个 router 迁移为内置插件（`apps/plugins/` 或 `packages/plugins/`），`index.ts` 只留宿主引导
- [ ] `ctx.settings` + 设置 section 雏形（对接现有设置页）
- **交付**：后端启动路径完全由插件宿主驱动，`/api/health` 暴露插件状态

### Phase 2 — 数据层扩展（1 周）

- [ ] `plugin_kv` 表（主库 + 项目库）+ `KvService`
- [ ] `ctx.db.migrate` 迁移通道 + `plugin_registry` 版本记录（v2 能力，先实现框架）
- [ ] 迁移 `demo-seed` / `event-dedupe` 等独立 service 为可注册服务（试点 `ctx.services`）
- **交付**：任意插件可安全存读自己的 KV 数据

### Phase 3 — Web 插件宿主 + 面板/路由注册化（1–2 周）

- [x] `WebPluginHost`：构建期 manifest 生成 + 运行时 apply + ErrorBoundary 包装
- [x] ProjectLayout 抽取「面板宿主」，12 面板改 `registerProjectPanel`
- [x] App.tsx 路由表改 `registerRoute` 驱动；PATHS 增加注册路由聚合
- [x] `registerCommand` / `registerSettingsSection`（2026-08-30：另加 `registerEditorExtension` /
      `registerEditorToolbarItem` / `registerSelectionAction`，Web 扩展点已全部落地并有示例插件覆盖；
      见 `apps/web/src/plugin/registry.ts` 与 docs/architecture/plugins.md §2.3）
- **交付**：前端所有聚合点注册表化，新增面板/路由不再改宿主文件

### Phase 4 — AI 层收口 + 完整插件示例（1–2 周）

- [x] `ctx.ai.skills/agents/providers/contextBuilder` 实现（复用/包装现有）
- [x] 前端技能列表由清单驱动（消灭 skillsConfig 双份维护）
      （2026-08-31：技能内容唯一来源改为后端注册表，GET /api/ai/skills 下发内置+插件技能；
      前端 skillsConfig.ts 只保留 id→图标映射，插件技能零前端改动即可见可激活）
- [x] 示例插件 ①「世界观建造师」（全栈：KV + 面板 + 路由 + AI 工具 + 技能）
- [ ] 示例插件 ②「写作周报」（轻量：scheduler + 面板 + 导出钩子）
- [x] 管理页插件管理 UI（启用/禁用/权限/错误）

### Phase 5 — 外部插件格式 & 收尾（1 周）

- [ ] 外部插件安装：本地目录 / npm 包 / zip，manifest 校验 + 权限确认流程
- [ ] 开发态热插拔（vite plugin + tsx watch）
- [ ] 插件开发文档 + 模板仓库（`create-novel-plugin` 脚手架）
- [ ] 内置模块迁移收尾（编辑器面板批次 2026-08-31 迁移后同日删除：AI 扫描/节奏/文风/章节统计/本章批注
      5 个面板与工作台既有功能重复，组件已删；scope:'editor' 扩展点与 EditorPanelRail 保留，供插件注册编辑器面板）
- **交付**：完整的插件生态闭环（开发 → 安装 → 管理 → 分发）

**总工期：约 6–10 周（全职）/ 2–3 个月（兼职）**。Phase 0–2 期间现有功能不受影响，可随时发布。

---

## 15. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 281 项未提交变更，改造难以定位回归 | 高 | Phase 0 先提交基线；每 Phase 独立可回滚；`NOVELMUSE_LEGACY` 开关 |
| ProjectLayout 巨型组件重构引入 UI 回归 | 高 | 先抽取面板宿主（纯重构，不改渲染逻辑）再注册化；以现有 e2e-full.mjs + vitest 覆盖 |
| 双库（主/项目）迁移复杂化 | 中 | v1 只开放 KV（无迁移）；正式表迁移 v2 且作用域明确 |
| 前端构建管线（Vite + CSP）限制动态加载 | 中 | 构建期清单静态打包；不做运行时远程加载 |
| 插件 API 设计不稳导致返工 | 中 | 以 2 个示例插件作为 API 验收测试；内核先写类型后用（type-first） |
| AI 工具注册表与插件注册表双轨混乱 | 低 | `ctx.ai.tools` 直接包装现有 registry，单一事实源 |

---

## 16. 示例插件设计

### 16.1 「世界观建造师」（全栈插件，验证完整契约）

能力：管理势力 / 宗教 / 科技树三类新实体，并提供 AI 世界观顾问技能。

```
apps/plugins/worldbuilding/
├── package.json                  # novelMuse manifest（workspace 包形态）
├── migrations/project/0001.sql   # factions / religions / techs 三张项目表（v2 迁移通道）
├── src/
│   ├── server/
│   │   ├── index.ts              # apply(ctx)：注册路由 + KV 迁移 + AI 工具 + 技能 + 事件订阅
│   │   ├── factions-router.ts    # Hono router，复用 BaseService
│   │   └── ai-tools.ts           # create_faction / list_factions（继承项目隔离 + 不暴露 delete）
│   └── web/
│       ├── index.ts              # apply(ctx)：registerProjectPanel + registerCommand + registerLocale
│       └── FactionsPanel.tsx     # 面板 UI（复用现有 CharacterManager 的模式）
└── package.json                  # exports { ".": server, "./web": web }
```

关键点：这是**第一版契约的验收件**——如果「世界观建造师」不用改任何宿主文件就能跑通，插件化就成功了。

> **落地位置（2026-09-29）**：目录已按模式拆分，实际落在 `apps/plugins/manual/worldbuilding/`，manifest 声明 `modes: ["manual"]`。

### 16.2 「写作周报」（轻量插件，验证纯扩展点）

能力：每周日自动汇总写作统计，导出 Markdown 报告。

```ts
// server/index.ts
export function apply(ctx: PluginContext) {
  ctx.scheduler.register({ cron: '0 9 * * 0' }, async () => {
    const projects = await projectService.listAll();
    for (const p of projects) {
      const weekly = await statsService.weekly(p.id);
      await reportService.generateAndSave(p.id, weekly);   // 存 KV
    }
  });
  ctx.events.on('chapter.saved', async ({ projectId }) => { /* 增量记录 */ });
  ctx.hooks.after('export.md', async ({ projectId, path }) => { /* 追加周报 */ });
}

// web/index.ts
export function apply(ctx: WebPluginContext) {
  ctx.registerProjectPanel({ key: 'weekly-report', label: '写作周报', Component: WeeklyReportPanel });
  ctx.registerCommand({ id: 'report.export', title: '导出本周周报', run: () => exportWeekly() });
}
```

不需要任何数据库迁移（数据全走 KV），**零权限**即可运行——展示「轻量插件」的极简路径。

---

## 17. 附录：与 DSH 机制对照表

| DSH | 砚舟 方案 | 差异说明 |
|-----|----------------|----------|
| cordis 插件框架 | `packages/core` 自研内核 | DSH 用 Koishi 系 cordis；砚舟 体量小，自研 ~500 行更贴合，不引外部框架 |
| `apply(ctx, config)` | `apply(ctx, config)` | 同构 |
| `inject` 依赖声明 | `inject`（manifest.server/web） | 同 |
| `ctx.effect(() => disposer)` | `ctx.effect(() => disposer)` | 同 |
| `dsh` manifest 字段 | `novelMuse` manifest 字段 | 同构，字段按 砚舟 裁剪 |
| 双面插件（`exports "."` / `"./client"`） | 双面插件（`"."` / `"./web"`） | 同 |
| `webServer.register(route)` | `ctx.routes.register(prefix, router)` | 同 |
| `tools.register(tool)` | `ctx.ai.tools.register(...)` | 砚舟 已有 tools/registry，直接包装 |
| `systemPrompt.section()` | `ctx.prompt.section()` / `ctx.ai.skills` | 技能系统是 砚舟 已有概念，更具体 |
| settings section（schemastery） | `ctx.settings.registerSection`（Zod） | schema 校验换成 Zod（项目已用） |
| slots / locale | `registerProjectPanel` / `registerRoute` / `registerLocale` | 扩展点按 砚舟 UI 结构定制 |
| `cordis.patch.yml` + 热插拔 | `data/plugins.json` + 构建期清单 | 开发态热插拔，生产态重启生效 |
| client inject | Web 面 `inject` | 同 |
| 插件失败不拖垮宿主 | apply 抛错只禁用该插件 | 同 |

---

## 附：本方案对应的首批代码改动清单

| 文件 | 动作 |
|------|------|
| `packages/core/src/{manifest,registry,events,hooks,context,loader}.ts` | 新建（内核） |
| `packages/plugin-api/package.json` + `src/index.ts` | 新建（插件作者 SDK） |
| `packages/db/src/schema.ts` | 新增 `plugin_kv` 表 |
| `apps/server/src/index.ts` | 改造为宿主引导（删除 19 行硬编码 route） |
| `apps/server/src/lib/app-factory.ts` | 暴露 app 给宿主（已可） |
| `apps/server/src/ai/tools/registry.ts` | 包装为 `ctx.ai.tools`（几乎不动） |
| `apps/server/src/ai/agents/skills.ts` | SKILLS → 可注册（保留静态表兼容） |
| `apps/web/src/App.tsx` | 路由表 → `registerRoute` 驱动 |
| `apps/web/src/components/layout/ProjectLayout.tsx` | 抽取面板宿主 + 12 面板注册化 |
| `apps/web/src/components/ui/CommandPalette.tsx` | 命令项 → `registerCommand` 聚合 |
| `data/plugins.json` | 新建启用列表 |
| `apps/plugins/worldbuilding/` + `apps/plugins/writing-report/` | 新建示例插件 |
| `docs/plugin-development.md` | 新建插件开发指南（Phase 5） |
