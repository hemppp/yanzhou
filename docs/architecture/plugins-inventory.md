# 砚舟 插件化清单

> 生成于 **2026-09-15**；**2026-09-29 更新**（插件层按创作模式物理拆分 `manual / auto / shared / local`）；**2026-10-09 复核**：`GET /api/health` 实测 = **27** 个插件 —— 上表漏记了 `manual/workbench` 与 `auto/workbench` 两个目录插件，且 `apps/plugins/local/` 当前并不存在（不随仓库分发）。
> 数据来源：`GET /api/health` 实测 + 源码静态扫描（行数、路由、模式归属均实测，非文档推测）。
> 装配入口：`apps/server/src/plugin/host.ts`。HTTP 层由 `@deepseek-ai/dsh-host-webserver` 提供，业务路由经 `lib/hono-adapter.ts` 接入 Hono。
> 模式契约见 [`plugin-standard.md`](./plugin-standard.md) §1.4 / §3.1 / §6。

## 一、总览：27 个插件怎么来的

| 类别 | 数量 | 来源 | 模式归属 | 装配方式 |
|---|---|---|---|---|
| 核心业务模块 | **20** | `apps/server/src/modules/*.ts` | `shared` | 宿主统一包装后 `ctx.plugin()` 挂载 |
| 宿主管理插件 | **1** | `apps/server/src/plugin/manager.ts` | `shared` | 宿主启动时以"插件"身份挂载 |
| 示例插件 | **1** | `apps/plugins/manual/worldbuilding/` | `manual` | 扫描 `apps/plugins/{manual,auto,shared}/*/` 自动加载 |
| 模式插件 | **5** | `apps/plugins/{manual,auto,shared}/*/` | `manual` / `auto` / `shared` | 扫描 + `guardian` 隔离审查 |
| | **27** | | | |

> 5 个模式插件（2026-10-09 实测）：`manual` = `novel.bookscan`、`novel.manual.workbench`；`auto` = `novel.autowrite`、`novel.auto.workbench`；`shared` = `novel.typography`。

> 模式归属规则：内置 API 模块与插件管理器为 `shared`（两种模式都复用其数据 / 能力）；
> 目录插件按父目录名推导（`local` → `shared`）。缺省（未声明）一律按 `shared`。
>
> 每个插件的运行时状态可在 `GET /api/health` 的 `plugins[]` 里看到（每项含 `modes`）。
> 被 `HOST_MODE` 过滤的插件为 `status: 'skipped'`（可见，非消失）。

---

## 二、核心业务插件（20 个）

这些是 `apps/server/src/modules/` 下的模块，由宿主包装为 cordis 插件。**全部路由要求 `requireAuth`**（`admin.ts` 另加 `requireAdmin`）。

### 2.1 内容资产类（写作对象的 CRUD）

| 插件 id | 文件 | 行数 | 作用 | 主要路由 |
|---|---|---|---|---|
| `novel.projects` | `projects.ts` | 149 | 项目（书）管理，带用户隔离与输入校验 | `GET/POST /`、`GET/PUT/DELETE /:id` |
| `novel.chapters` | `chapters.ts` | 207 | 章节：含**回收站**（软删/恢复/清空）与重排 | `GET /projects/:pid`、`GET /projects/:pid/trash`、`POST /`、`PUT /:id`、`POST /:id/restore`、`PUT /:id/reorder` |
| `novel.characters` | `characters.ts` | 262 | 角色：含**关系增删**与**相似角色合并** | `GET /search`、`POST /:id/relations`、`POST /merge-similar`、`POST /:id/merge/:targetId` |
| `novel.items` | `items.ts` | 104 | 物品/道具 | 标准 CRUD |
| `novel.locations` | `locations.ts` | 129 | 地点：含**坐标批量分配**（地图用） | 标准 CRUD + `POST /assign-coords` |
| `novel.events` | `events.ts` | 89 | 故事事件 | 标准 CRUD |
| `novel.foreshadows` | `foreshadows.ts` | 126 | 伏笔：含**活跃/逾期**两个专用视图 | `GET /projects/:pid/active`、`GET /projects/:pid/overdue` |
| `novel.timeline` | `timeline.ts` | 128 | 时间线事件：含**去重** | 标准 CRUD + `POST /dedupe` |
| `novel.outline` | `outline.ts` | 88 | 大纲节点（树形） | 标准 CRUD |
| `novel.notes` | `notes.ts` | 86 | 便签笔记 | 标准 CRUD |
| `novel.annotations` | `annotations.ts` | 92 | 正文划词标注 | 标准 CRUD |
| `novel.earmarks` | `earmarks.ts` | 95 | 书角标记（Earmark） | 标准 CRUD |
| `novel.credits` | `credits.ts` | 96 | **系统文**专用：积分流水。结余不入库、前端实时派生 | 标准 CRUD |
| `novel.snapshots` | `snapshots.ts` | 72 | 章节版本快照 | `GET /chapters/:cid`、`POST /`、`DELETE /:id` |
| `novel.references` | `references.ts` | 115 | 参考书（替代早期前端 IndexedDB 方案） | 标准 CRUD |

### 2.2 平台能力类

| 插件 id | 文件 | 行数 | 作用 | 主要路由 |
|---|---|---|---|---|
| `novel.auth` | `auth.ts` | 316 | 认证：注册/登录/刷新/登出。JWT 写 **HttpOnly + SameSite=Strict Cookie** | `POST /register`、`/login`、`/refresh`、`/logout`、`GET /me`、`/check-username`（均带限流） |
| `novel.admin` | `admin.ts` | 240 | 管理后台：用户管理（需 `requireAdmin`） | `GET /users`、`PATCH /users/:id/password`、`DELETE /users/:id`、`PATCH /users/:id/admin`、`GET /stats` |
| `novel.ai` | `ai.ts` | **1978** | **全项目最大的模块**：AI 端点 + 技能库 + 模型配置（见下） | 25 条路由 |
| `novel.stats` | `stats.ts` | 134 | 写作统计（日目标/习惯追踪） | `GET /projects/:pid`、`POST /`、`GET /projects/:pid/summary` |
| `novel.search` | `search.ts` | 33 | 外部搜索代理（DuckDuckGo） | `POST /`（带独立限流） |

### 2.3 `novel.ai` 的路由全貌（25 条）

| 分组 | 路由 |
|---|---|
| 分析 | `POST /scan`、`/scan-timeline-stream`、`/extract-events-stream`、`/check-consistency`、`/analyze-style`、`/analyze-rhythm`、`/analyze-timeline`、`/check-outline` |
| 对话 | `POST /chat`、`/chat-stream`（SSE） |
| 生成 | `POST /generate-character`、`/generate-plot` |
| 网关 | `POST /gateway`（转 Python agents 微服务） |
| 配置 | `GET /config`、`POST /config`、`POST /config/test`、`GET /models` |
| 技能库 | `GET /skills`、`GET /skill-library`、`POST /skill-library/install`、`DELETE /skill-library/:id` |
| 技能开关 | `GET /skill-targets`、`GET /skill-targets/:agentId`、`PUT /skill-targets/:agentId/toggle`、`PUT .../toggle-all` |

> `ai.ts` 用**自己的 Hono 实例**（`aiRouter`）挂到 `/api/ai`，不是 `router.get` 风格 —— 这是全仓唯一这么写的模块。

---

## 三、宿主与示例插件

### `novel.plugin-manager` —— 插件管理器

- **文件**：`apps/server/src/plugin/manager.ts`（宿主启动时以插件身份挂载，刻意演示"管理功能本身也是插件"）
- **模式**：`shared`（未显式声明 → 缺省 `shared`）
- **作用**：查看/开关插件、检查全局依赖
- **路由**（全部 `requireAuth + requireAdmin`）：`GET /api/admin/plugins`、`GET /api/admin/plugins/deps`、`POST /api/admin/plugins/:id/enable`、`POST /api/admin/plugins/:id/disable`

### `novel.worldbuilding` —— 世界观建造师（示例插件）

- **文件**：`apps/plugins/manual/worldbuilding/`（4 个文件：`package.json` + `src/server/index.ts` + `src/web/index.tsx` + `src/web/faction-highlight.ts`）
- **模式**：`manual`（目录 `manual/` + `novelMuse.modes: ["manual"]`；其面板/命令/选区动作仅手写台露出）
- **定位**：**演示完整插件契约**的活样板，注释里逐条列出用到的能力
- **内容**：
  1. `ctx.routes.register` —— 势力 CRUD 路由（数据存 KV，**无需数据库迁移**）
  2. `ctx.ai.tools.register` —— AI 工具 `create_faction` / `list_factions`
  3. `ctx.ai.skills.register` —— 「世界观顾问」技能
  4. `ctx.events.on` —— 订阅章节保存事件，**自动累计势力出场次数**
  5. `ctx.db.kv` —— 插件 KV 存储（项目隔离）

---

## 四、模式插件（`apps/plugins/{manual,auto,shared}/*/`）

这里的 **5 个**插件都有各自的 `plugin.json` manifest；**父目录名 = 适用模式**（`local/` 为运行时 AI 动态创建区，不随仓库分发）。

### 4.1 `novel.autowrite` —— 自动写作引擎（`auto/`，53 个文件，本仓最重插件）

- **manifest 描述**：写作技能框架 —— 承载全部聊天技能（自核心剥离）+ AI 自动写作多代理流转（规划→写作→校对→润色→交付）与治理（自治/审查/台账）
- **模式**：`auto`（目录 `auto/` + `modes: ["auto"]`）—— 仅 AI 写作模式加载，其 `/api/plugins/autowrite/*` 路由在 manual 项目下返回 404 `PLUGIN_MODE_MISMATCH`
- **权限**：`routes`、`db:global`、`db:project`、`ai:tools`、`ai:skills`、`ai:agents`
- **server 注入**：`routes`、`db`、`ai`；**web 注入**：`projectPanels`、`skills`、`api`
- **实际内容（两层链路，详见 `docs/handover/ai-writing-handover.md`）**：

| 子模块 | 位置 | 内容 |
|---|---|---|
| **讨论链路（现役）** | `server/discuss/` | 三设计角色讨论 → 定稿官收敛 → 写作官落笔 → 篇幅自检 → 意图门 → 校对门 → 润色门 → 交付 → 实体沉淀。入口 `POST /api/plugins/autowrite/session`（SSE） |
| **多智能体流水线** | `server/pipeline/` | `brief→cast→bible→plot→drift→pilot` 六段已实现（`production` 待做），带闸门三态 + 台账 |
| **分层记忆** | `server/framework/memory/` | L1 全局记忆（唯一写通道 `ingest()`）+ L2 专属记忆（`agent_memory` 表）+ 每 agent 一台"水车" |
| **技能注入** | `server/framework/agent-skills.ts` | 把「用户开关的技能正文」拼进 system 后缀，接到三处发言点 |
| **旧批次流水线（死代码）** | `server/autowrite/` + `framework/flow-store.ts` | 8 个 `autowrite_*` AI 工具 + `FlowStore` + 3 条 `/batches` 路由，已脱节，**是否物理删待拍板** |
| **Web 面** | `web/index.tsx`、`chat-wheel.tsx`、`panel.tsx` | 注册 AI 聊天气泡栏（转轮选择器）+ 9 个技能图标 |

### 4.2 `novel.bookscan` —— 扫榜拆书（`manual/`，3 个文件）

- **模式**：`manual`（目录 `manual/` + `modes: ["manual"]`）
- **作用**：抓取公共书榜（晋江 VIP强推榜/总分榜/编辑推荐榜），一键把书加入「参考书」（含文案），并可就地 AI 拆书
- **权限**：`routes`、`db:global`
- **缓存**：榜单结果写 `plugin_kv`（key `rankings:*`），**这是主库最大的软性负担来源**

### 4.3 `novel.typography` —— 字体排版（`shared/`，3 个文件）

- **模式**：`shared`（目录 `shared/` + `modes: ["shared"]`）—— 两种模式都加载
- **作用**：调整编辑器文字的显示粗细与颜色（实时预览，**项目无关的用户级设置**）
- **权限**：`routes`、`db:global`
- ⚠️ 已知问题：三条路由 `GET/PUT/DELETE /settings` **缺 `requireAuth`**（安全报告 C7）

### 4.4 `novel.manual.workbench` —— 手写台（`manual/`，73 个文件）

- **manifest 描述**：手写台大模块 —— 12 个内置面板（参考书 / 笔记 / 统计 / 大纲 / 时间线 / 角色 / 地点 / 伏笔 / 物品 / 关系图 / 地图 / 导出）+ 章节编辑器 + 章节气泡浮窗；大类子插件以 `web/<大类>/` 目录体现
- **模式**：`manual`（目录 `manual/` + `modes: ["manual"]`）
- **权限**：`[]`（无服务端权限声明）
- **web 注入**：`projectPanels`、`builtinBubble`；入口 `web/index.tsx`
- **近期变更**：「快捷短语」从编辑器正文上方的固定漂移气泡改为**底部面板的一栏**（新 kernel 扩展点 `registerBottomPanelSection`，见 `apps/web/src/components/shell/bottomSections.tsx`）

### 4.5 `novel.auto.workbench` —— AI 写作台（`auto/`，8 个文件）

- **manifest 描述**：AI 写作台大模块 —— AI 对话浮窗 + 编辑器气泡栏 + 自动写作工作台 + 技能库 + 流水线 / 记忆面板
- **模式**：`auto`（目录 `auto/` + `modes: ["auto"]`）
- **权限**：`[]`（无服务端权限声明）
- **web 注入**：`projectPanels`、`builtinBubble`、`chatRail`、`workbench`、`settings`、`capability`；入口 `web/index.tsx`

> 这两个 `workbench` 插件在 2026-10-09 的复核中被补入总览：它们各自带 `plugin.json` 与 web 入口，会被目录扫描加载（`GET /api/health` 实测可见），但**不在 `pnpm verify:modes` 的断言清单内**。

---

## 五、插件机制要点

- **契约**：插件 = `{ name, inject, apply(ctx, config) }`，经 `inject` 声明依赖（如 `['routes','db','ai']`），宿主据此做装配顺序与缺依赖报错。
- **manifest**：`plugin.json` 声明 `id / name / description / version / modes / permissions / server.inject / web.inject`，由 `@novel/core` 的 zod schema 校验。
- **模式**：`modes`（`manual`/`auto`/`shared`，缺省 `['shared']`）必须与插件所在模式目录（`manual/auto/shared/local`）一致，否则 G2.5 拒绝（`MODE_MISMATCH`）；运行时跨模式路由 404 `PLUGIN_MODE_MISMATCH`。宿主可用 `HOST_MODE=manual|auto|all` 按机器角色裁剪插件集合（被裁者 `status: 'skipped'`）。
- **生命周期**：`ctx.plugin()` 挂载 → fiber 隔离 → `dispose()` 卸载；禁用清单持久化在 `novel.host/disabled-plugins`。所有工具注册走 `ctx.effect(...)` 包裹，卸载时随 DisposerBag 自动注销。
- **`guardian` 审查**：本地插件先隔离，**连续 2 个会话零错误才放行**（策略见 `plugin/host.ts`，记录在 `plugin_kv` 的 `novel.host/guardian`）。
- **Web 面收集是构建期行为**：vite 用 `import.meta.glob` 在**构建时**扫描插件 Web 入口 —— **新增插件必须重启 vite**，服务端的 enable/disable 对 Web 面无效。
- **AI 工具白名单**：插件经 `ctx.ai.tools.register` 注册的工具会被 `host.ts:303` 自动 `markPluginTool`，**无条件进入所有用户的聊天工具列表**；而 `create_plugin` / `list_local_plugins` 属另一套常量，**仅对管理员可见**。

---

## 六、前端 UI 插件

**关键认知：前端的 UI 面本身就是插件化的** —— 连宿主自己的 12 个核心工作台面板都是"内置插件"注册的（原先硬编码在 `ProjectLayout.tsx` 的 `floatingPanelConfigs` 数组里）。

### 6.1 九个扩展点（白名单是单点真相）

单点真相：`packages/core/src/manifest.ts` 的 `WEB_SERVICES`（10 项，其中 `api` 不是注册器而是注入能力）。

| manifest 声明 | 插件调用 | 效果 | 去重 key |
|---|---|---|---|
| `projectPanels` | `ctx.registerProjectPanel` | 工作台浮窗面板（`scope: 'editor'` 则进编辑器侧栏） | `key` |
| `commands` | `ctx.registerCommand` | `Ctrl+K` 命令 | `id` |
| `routes` | `ctx.registerRoute` | 顶级路由 | `path` |
| `settings` | `ctx.registerSettingsSection` | 设置页区块（`category`: general/ai/security/plugins/updates） | `key` |
| `editor` | `ctx.registerEditorExtension` | Tiptap 扩展（工厂，每编辑器实例 create） | `key` |
| `toolbar` | `ctx.registerEditorToolbarItem` | 编辑器工具栏按钮 | `key` |
| `selection` | `ctx.registerSelectionAction` | 划词后浮出菜单项 | `key` |
| `skills` | `ctx.registerSkillIcons` | 技能选择器图标（`{技能id: LucideIcon}`） | 技能 id |
| `chatRail` | `ctx.registerChatRail` | **AI 聊天浮窗左缘功能气泡栏**（单槽，后注册覆盖，注销回退宿主兜底） | — |
| `api` | `ctx.api` | 带鉴权 fetch（自动带 JWT / 项目头） | — |

> ⚠️ 白名单必须与 `WebPluginContext` 的 `register*` 方法**一一对应**。`manifest.ts` 注释里留着教训：曾经多列了 `sidebar` / `locale` / `store` 等未实现项 —— manifest 校验放行，但插件调不到任何 API，"等于给插件作者一个假承诺"。**新增扩展点要先加 ctx 方法，再加白名单。**

> **模式标注（2026-09-29）**：上表各注册项（`projectPanels` / `commands` / `routes` / `settings` / `editor` / `toolbar` / `selection` / `chatRail`）的 Def 均可带 `modes?: PluginMode[]`；`ctx` 在挂载时会把插件的模式写入未显式声明的条目（`withModes`，见 `apps/web/src/plugin/host.ts`）。消费侧按 `project.mode` 过滤，缺省 `['shared']`。

### 6.2 两路发现机制（注意：都是构建期行为）

| 路 | 登记方式 | 适用 |
|---|---|---|
| **静态清单** | `apps/web/src/main.tsx` 的 `staticEntries` **手写一行**（每条显式带 `modes`） | 内置面板插件、workspace 包形态插件（如 worldbuilding） |
| **自动收集** | `import.meta.glob` 覆盖 `apps/plugins/{manual,auto,shared,local}/*/web/index.tsx` | 四个模式目录下的插件 —— **落盘即被发现**；适用模式由父目录名经 `pluginModeFromDir` 推导（`local`→`shared`） |

⚠️ 两者都在 **vite 构建期**完成 —— **新增插件文件后必须重启 vite dev / 重新构建**。服务端对插件 enable/disable 也**不会**摘除已注册的 Web 面 UI。

### 6.3 挂载前先对齐宿主状态 + 按项目模式过滤

`mountAllWebPlugins()` 会先拉 `/api/health`：Server 端状态**非 `ok`**（disabled / error / skipped）的插件，Web 面**直接跳过挂载**（`console.warn` 说明原因）；Server 不可达则放行全部，保证前端仍能打开。目的是避免"面板还在、接口全 404"的僵尸 UI。

注册完成后，消费点（`ProjectLayout` / `AutoWriteWorkbench` 等）用 `useProjectMode()` +
`filterByProjectMode()`（`apps/web/src/plugin/registry.ts`）按当前 `project.mode`（缺省 `manual`）
过滤注册表条目 —— manual 项目不渲染 auto 面板，auto 项目不渲染 manual 面板。

### 6.4 注册表机制（`apps/web/src/plugin/registry.ts`）

- Zustand store 驱动 —— 任何注册/注销立刻触发订阅组件重渲染。
- **按 key 去重**：同 key 重复注册 = 覆盖且**保持原位置**（HMR / 重载友好）。
- **排序**：`order` 升序 → 同 order 按**首次注册序号**稳定排序（未声明 order 的按注册先后，既有 12 个面板顺序因此不变）。
- ⚠️ **卸载函数必须从「当前 state」重新读列表再过滤** —— 早期实现闭包捕获了注册时刻的快照，卸载时用旧快照覆盖，会**连带丢弃此后注册的所有条目**（插件热禁用 / Vite HMR 时必踩）。
- `chatRail` 是单槽；`skillIcons` 是合并 map（注销时按 key 删）。

### 6.5 现状：谁注册了什么

| 插件 | 模式 | 注册的前端 UI |
|---|---|---|
| `novel.builtin-panels`（内置，`plugin/builtin.ts`） | `manual` | **12 个工作台面板**：参考书 / 笔记 / 统计 / 大纲 / 时间线 / 角色 / 地点 / 伏笔 / 物品 / 关系图 / 地图 / 导出 |
| `novel.autowrite.workbench-panels`（内置，`plugin/autoBuiltin.ts`） | `auto` | **5 个 AI 工作台面板**：流水线 / 本章计划 / 实体与设定 / 记忆审计 / 技能库（原内联于 `AutoWriteWorkbench`，已迁出） |
| `novel.worldbuilding` | `manual` | 面板「势力」+ 命令「新增势力」+ **Tiptap 扩展** + **划词菜单动作**（4 种扩展点，覆盖度最全） |
| `novel.autowrite` | `auto` | **接管 AI 聊天气泡栏**（转轮选择器 `ChatWheelRail`）+ 9 个技能图标 |
| `novel.typography` | `shared` | 面板「字体排版」+ 设置区「字体排版」（通用栏）+ 命令「切换显示粗细」 |
| `novel.bookscan` | `manual` | 命令（1 条） |

> 即：一个插件能提供的 UI 形态，从「一个面板」到「接管整个聊天气泡栏」都有实例可参照 —— 想加什么，先看上表里谁的写法最接近。
> `novel.builtin-panels`（manual）与 `novel.autowrite.workbench-panels`（auto）**物理互斥**，由消费侧按 `project.mode` 二选一。

### 6.6 消费侧：每个扩展点落在哪个 UI 位置

**注册了不等于显示** —— 宿主里有一对一的消费组件。这是完整的 10 个落点（全部实测）：

| 扩展点 | 消费点 | 渲染成什么 |
|---|---|---|
| `projectPanels` | `components/layout/ProjectLayout.tsx:521` | 工作台浮窗面板（`scope !== 'editor'`，进顶栏按钮组；`filterByProjectMode` 过滤） |
| `projectPanels`（`scope: 'editor'`） | `components/editor/EditorPanelRail.tsx:16` | **编辑器内的面板栏**（按 `useProjectMode` 过滤） |
| `commands` | `components/ui/CommandPalette.tsx` | `Ctrl+K` 命令面板 |
| `routes` | `App.tsx` | 顶级路由表 |
| `settings` | `components/settings/PluginSettingsSections.tsx` | 设置页区块 |
| `editor` | `components/editor/hooks/useEditorInstance.ts` | Tiptap 扩展链 |
| `toolbar` | `components/editor/PluginEditorToolbar.tsx` | 编辑器工具栏 |
| `selection` | `components/editor/SelectionMenu.tsx` | 划词浮出菜单 |
| `skills` | `components/ai/skillsConfig.ts` | 技能选择器图标（未注册的走 `Puzzle` 兜底） |
| `chatRail` | `components/layout/ProjectLayout.tsx:364` | AI 聊天气泡栏（**插件优先，宿主内置兜底**；按模式过滤） |

> **模式过滤（2026-09-29）**：上述消费点均接入 `useProjectMode()` + `filterByProjectMode()` /
> `entryAppliesToProjectMode()`（`apps/web/src/plugin/registry.ts`），按当前 `project.mode` 过滤后渲染 ——
> 手写台项目不出现 auto 面板/气泡栏，反之亦然。行号会随迭代漂移，**以符号名为准**。

**这 10 处就是「插件化的 UI」的全部落点** —— 反过来说，宿主里只有这 10 个位置可被插件追加/改写；其余 UI（编辑器本体、书架、登录页）仍是硬编码。**同一个 `projectPanels` 有两个落点**（顶栏 vs 编辑器侧栏），靠 `scope` 字段分流，这点容易漏。

### 6.7 AI 动态创建的插件也自带 UI

`create_plugin` 工具的代码模板会给新插件生成三种 UI（`apps/server/src/ai/tools/plugin-tools.ts`）：一个 `registerProjectPanel` + 一个 `registerSettingsSection` + 一个 `registerCommand`（用于重新打开自己的面板）。也就是说，AI 对话里一句话建出来的插件，落地就是「面板 + 设置区 + 命令」三件套。落盘目录 `apps/plugins/local/{id}/`，适用模式默认 `shared`。

### 6.8 机制本体有多大

`apps/web/src/plugin/` 整个前端插件机制为 **5 个文件 / 729 行**：

| 文件 | 行数 | 职责 |
|---|---|---|
| `types.ts` | 141 | 各扩展点的 Def 类型（`FloatingPanelDef` / `CommandDef` / `ChatRailDef` …，均含 `modes?`） |
| `registry.ts` | 304 | Zustand 注册表（去重 / 排序 / 卸载）+ 模式过滤（`useProjectMode` / `filterByProjectMode`） |
| `host.ts` | 163 | `mountWebPlugin()`：把插件的 `apply(ctx)` 接到注册表 + 模式标注（`withModes`）+ 失败隔离 |
| `builtin.ts` | 60 | 手写台内置 Web 插件：注册那 12 个 `manual` 面板 |
| `autoBuiltin.ts` | 61 | AI 写作内置 Web 插件：注册 5 个 `auto` 工作台面板（`novel.autowrite.workbench-panels`） |

> 前端插件化不是框架级工程，**729 行**就能把「9 个扩展点 + 模式过滤 + 去重排序 + 热卸载」做扎实 —— 想扩新扩展点，改动面就在这 5 个文件 + 对应消费组件。


