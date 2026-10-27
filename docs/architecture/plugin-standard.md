# 砚舟 插件安装标准（novel-plugin-standard/1.0）

> 目的：**让"装一个插件"不再可能弄崩宿主。** 任何来源的插件（内置 / 本地 / npm / AI 对话创建）
> 进入宿主前必须通过本标准定义的安装门；任何一门失败都只隔离该插件并给出标准错误码，
> 其余插件与宿主照常启动运行。
>
> 代码落点：纯判定逻辑在 `packages/core/src/install.ts`（`INSTALL_STANDARD_VERSION = '1.0.0'`），
> 模式契约在 `packages/core/src/mode.ts`（`PLUGIN_MODES` / `pluginModeFromDir` / `pluginAppliesToProjectMode`），
> 宿主管线在 `apps/server/src/plugin/host.ts` 的 `mount()`，扫描器封装在
> `apps/server/src/plugin/local-scanner.ts` 的 `scanLocalPluginsDetailed()`。

## 1. 插件的合法形态

### 1.1 本地目录形态（AI 创建 / 手动放置）

```text
apps/plugins/{mode}/{dirName}/
  plugin.json          # manifest（本标准的唯一元数据来源）
  server/index.ts      # Server 面入口（exports { name, apply(ctx) } 或 default router 适配）
  web/index.tsx        # Web 面入口（exports { name, apply(ctx) }，vite 构建期 glob 收集）
```

`{mode}` 是**模式父目录**，取值 `manual | auto | shared | local`（见 §1.4）。目录名 `{dirName}`
必须是 **完整 id**（如 `novel.typography`，AI `create_plugin` 形态，防不同 id 尾段碰撞）
或 **id 尾段**（如 `typography`，手写形态）。其余命名一律拒绝（`ID_MISMATCH`）。

### 1.2 内置插件

`apps/server/src/plugin/builtin.ts` 中注册，manifest 由代码内联声明，走同一套安装门。

### 1.3 npm / workspace 包形态

`package.json` 的 `novelMuse` 字段承载 manifest（与本地形态同 schema），经 `PluginEntry` 进入宿主。

### 1.4 模式目录布局（manual / auto / shared / local）

产品有两个**互斥**的创作模式：手写台（`project.mode === 'manual'`）与 AI 写作（`'auto'`）。
插件层按模式**物理目录拆分**，父目录名即插件适用模式的**事实来源**：

```text
apps/plugins/
├── manual/{dirName}/    # 仅手写台加载 / 路由
├── auto/{dirName}/      # 仅 AI 写作加载 / 路由
├── shared/{dirName}/    # 两种模式共享
└── local/{dirName}/     # AI 对话动态创建区（默认视为 shared）
```

- 映射由 `@novel/core` 的 `pluginModeFromDir(dirName)` 给出：`manual/auto/shared → 同名`，
  **`local → shared`**，未知目录名 → `null`（非法布局）。
- 扫描器遍历 `PLUGIN_MODE_DIRS = ['manual','auto','shared','local']` 四个根目录，
  把推导结果写入 `PluginEntry.modes`；宿主据此做启动过滤与运行时门禁。
- `manifest.modes` 必须与目录推导结果**严格一致**，否则 **G2.5 模式门**拒绝安装（`MODE_MISMATCH`，见 §3）。
- 桌面端根目录可用环境变量覆盖：`PLUGINS_ROOT`（优先）或 `PLUGINS_DIR`（历史名，语义升级为「根」）。

> **一插件 = 一个模式桶。** 想让插件两种模式通用，就放 `shared/` 并声明 `['shared']`；
> 声明多元素（如 `['manual','shared']`）会因不满足「严格单元素」而被 G2.5 拒绝。

## 2. Manifest 规范（plugin.json）

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | ✅ | 反向域名风格，`/^[a-z0-9]+(\.[a-z0-9]+)+$/`，如 `novel.worldbuilding` |
| `name` | ✅ | 展示名称，非空 |
| `version` | ✅ | semver（`x.y.z`） |
| `description` | — | 一句话说明 |
| `minHostVersion` | — | semver；宿主版本低于它 → 拒绝（`HOST_VERSION_MISMATCH`） |
| `dependsOn` | — | 硬依赖的其他插件 id 数组；缺失/被禁用 → 跳过（`DEP_MISSING`）；成环 → 整环拒绝（`DEP_CYCLE`）；自依赖 → 拒绝 |
| `modes` | — | 适用创作模式，`PluginMode[]`（`manual` / `auto` / `shared`）；**缺省（或空数组）视为 `['shared']`**。必须与插件所在模式目录一致，否则 G2.5 拒绝（`MODE_MISMATCH`）；与 `permissions` / `inject` 无耦合 |
| `permissions` | ✅ | 白名单子集：`routes, db:global, db:project, ai:tools, ai:skills, ai:agents, ai:providers, events, settings, scheduler` |
| `server.inject` | — | 白名单子集：`routes, services, db, ai, events, hooks, settings, scheduler, prompt` |
| `web.inject` | — | 白名单子集：`routes, projectPanels, commands, settings, editor, toolbar, selection, skills, chatRail, api` |
| `serverEntry` | — | Server 入口相对路径，默认 `./server/index.ts`；**仅允许插件目录内相对路径**（绝对路径 / `..` 穿越 → `ENTRY_UNSAFE`） |
| `webEntry` | — | Web 入口相对路径，默认 `./web/index.tsx`，同上 |
| `db.globalMigrations` / `db.projectMigrations` | — | 迁移目录 |

> `serverEntry`/`webEntry` 自标准 1.0 起是 **manifest 正式字段**（schema 校验路径安全），
> 不再是扫描器的私有旁路约定。

## 3. 安装门

| 门 | 内容 | 失败错误码 | 执行位置 |
|---|---|---|---|
| G0 | Manifest 门：plugin.json 存在、JSON 可解析、通过 zod schema | `MANIFEST_INVALID` | 扫描器 / host.mount |
| G1 | 结构门：入口路径安全 + Server 入口文件存在 | `ENTRY_UNSAFE` / `ENTRY_MISSING` | 扫描器（`load()` 前再做一次 realpath 逃逸检查） |
| G2 | 身份门：目录名匹配 + id 全局唯一 | `ID_MISMATCH` / `ID_CONFLICT` | 扫描器 + host.mount |
| **G2.5** | **模式门：父目录推导的适用模式与 `manifest.modes` 严格一致** | **`MODE_MISMATCH`** | **扫描器（`checkManifestPolicy(..., { parentDirName })`）/ host.mount** |
| G3 | 版本门：`minHostVersion ≤ 宿主版本` | `HOST_VERSION_MISMATCH` | 扫描器 + host.mount + addPluginEntry |
| G4 | 依赖门：dependsOn 存在、未禁用、无环、无自依赖 | `DEP_MISSING` / `DEP_CYCLE` | 扫描器（静态）+ host.mount（拓扑排序）+ setPluginEnabled/addPluginEntry（运行时） |
| G5 | 注入门：`server.inject` 的服务宿主可提供 | `INJECT_MISSING` | host.mount 拓扑排序 |
| G6 | 装载门：模块加载成功且导出 `apply()` | `LOAD_FAILED` / `APPLY_MISSING` | mountEntry（try/catch 隔离） |

### 3.1 G2.5 模式门（`MODE_MISMATCH`）

纯判定在 `@novel/core` 的 `checkPluginModeConsistency(parentDirName, manifest)`：

- **事实来源 = 父目录名**（`manual/auto/shared/local`，`local` 视为 `shared`）；未知目录名直接判 `MODE_MISMATCH`。
- `declared = manifest.modes?.length ? manifest.modes : ['shared']`（缺省视为 `['shared']`）。
- **通过条件 = `declared 恰为单元素且等于目录推导模式`**（严格单元素，`size === 1 && has(dirMode)`）。
  - ✅ `manual/` + `['manual']`、`shared/` + `['shared']`、`local/` + `['shared']`
  - ❌ `manual/` + `['auto']`（交叉不一致）
  - ❌ `manual/` + 未声明（缺省 `['shared']` ≠ `manual`）
  - ❌ 任何多元素声明（如 `['manual','shared']`）——「一插件 = 一个模式桶」
- 触发点：**启动扫描阶段**（`scanLocalPluginsDetailed` 对每个模式目录传入 `parentDirName`），
  产出 `InstallIssue` 写入 `rejected`，插件被拒绝安装（不是 HTTP 响应）。
- `checkManifestPolicy(manifest, { parentDirName })` 传 `parentDirName` 时一并跑该门；不传则跳过
  （避免与显式调用重复报错）。

> ⚠️ 不要与 §6.1 的运行时码 `PLUGIN_MODE_MISMATCH` 混淆：前者是**安装门**（拒绝安装），
> 后者是**运行时路由门禁**（HTTP 404）。

## 4. 挂载顺序与失败策略

1. `host.mount()` 先逐门筛选出 **admitted** 插件，再按
   `sortByDependencies()`（Kahn 拓扑排序，稳定）排序后依序挂载 ——
   **依赖者永远晚于被依赖者**，不再依赖清单书写顺序的偶然正确。
2. 已禁用插件不进入可用集合：依赖它的插件按标准 **跳过**（`DEP_MISSING`），
   而不是挂着等运行时炸。重启后由管线自动重排。
3. 循环依赖 **整环拒绝**（全部成员 `DEP_CYCLE`），不部分挂载。
4. 单个插件的任何失败（门拒绝 / load 抛错 / apply 抛错）**只影响它自己**：
   状态置 `error` 或 `skipped`，宿主与其余插件正常启动。
5. 宿主模式（`HOST_MODE`）为 `manual`/`auto` 时，**不匹配该模式的插件不进入挂载管线**
   （`status: 'skipped'`，见 §6.2）—— 这是按机器角色裁剪插件集合的正常过滤，不是失败。
6. 运行期由守护器（guardian）继续兜底：非内置插件错误归因、熔断（自动禁用）、隔离放行。

## 5. 状态可观测性

- `GET /api/health` → `pluginStandard`（标准版本）+ `plugins[]`（每插件 `id/status/error/modes`）。
- `GET /api/admin/plugins`（需管理员）→ 状态 + 权限 + 依赖 + 被依赖 + `source`（builtin/local/npm）+ 守护器快照。
- 被扫描器拒绝的插件也会登记进宿主状态（`recordInstallRejections`），**不会静默消失**。
- 被 **HOST_MODE 过滤**（见 §6.2）的插件不进入挂载管线，但仍在状态表中可见，`status: 'skipped'`，
  `error` 形如 `HOST_MODE_FILTERED: 宿主模式 manual，插件模式 [auto]` —— 是「跳过」而非「消失」。
- 错误信息格式统一为 `错误码: 面向插件作者的可读原因`。

## 6. 模式分离：宿主过滤与运行时门禁

模式拆分有两层语义，**别与 G2.5 安装门（§3.1）混淆**：

### 6.1 运行时路由门禁 —— `PLUGIN_MODE_MISMATCH`

插件按模式物理拆分后，`/api/plugins/*` 路由在请求携带 `X-Project-Id` 时校验项目模式：
该项目的 `mode` 不被插件 `modes` 覆盖 → **HTTP 404**，body：

```json
{ "error": { "code": "PLUGIN_MODE_MISMATCH", "message": "插件 novel.autowrite 不适用于 manual 模式的项目" } }
```

- 语义：「该插件路由对本项目不存在」。
- 判定复用 `pluginAppliesToProjectMode(modes, projectMode)`；`modes` 缺省/空按 `shared` 处理，
  故 shared 插件恒通过。
- 项目不存在 / 无 `X-Project-Id` → 不做此门（`projectModeOf` 返回 `null`）。
- 读项目模式：`projects.mode`（NULL / 旧数据 → `manual`）。

### 6.2 启动过滤 —— `HOST_MODE`

环境变量 `HOST_MODE`（`apps/server/src/index.ts` → `normalizeHostMode`）：

| 取值 | 语义 |
|---|---|
| `manual` | 仅挂载 `modes` 含 `manual` 或 `shared` 的插件 |
| `auto` | 仅挂载 `modes` 含 `auto` 或 `shared` 的插件 |
| `all`（**未设 / 非法值**） | 不过滤，挂载全部 |

- 被过滤插件**不进入挂载管线**，但仍在 `/api/health` 状态表中，`status: 'skipped'`，
  `error` = `HOST_MODE_FILTERED: 宿主模式 {mode}，插件模式 [...]`（**可见，非消失**）。
- 用途：桌面端 / 部署可按机器角色固定宿主模式，一台机器只跑一种创作模式的插件集合。

## 7. Web 面同步规则

Web 端（`apps/web/src/main.tsx`）挂载任何 Web 面插件前，先拉取 `/api/health`：
Server 端该插件状态非 `ok`（disabled / error / skipped）→ Web 面不挂载（console.warn 说明原因）。
Server 不可达时放行全部（保持前端可打开）。这样禁用/熔断一个插件后，
它的面板、命令、设置不会残留成"点了就 404"的僵尸 UI。

Web 侧**再按当前项目模式过滤**：`project.mode`（缺省 `manual`）经
`filterByProjectMode()` / `entryAppliesToProjectMode()`（`apps/web/src/plugin/registry.ts`）
筛掉不适用模式的注册表条目 —— 于是 manual 项目看不到 AI 工作台面板，auto 项目看不到手写台面板。

## 8. 运行时动态安装（AI create_plugin / 插件管理）

`host.addPluginEntry()` 与启动挂载走同一套门（G0/G2/G2.5/G3/G4），
依赖未启用直接拒绝安装并返回原因。`setPluginEnabled(id, true)` 同样检查硬依赖，
提示先启用依赖。落盘环节保留原子写（临时目录 → rename），不留可被扫描的半成品。
AI `create_plugin` 落盘到 `apps/plugins/local/{id}/`（`local` → 默认 `shared`）。

## 9. 已知边界

- Hono 路由无法热摘除（架构限制）：禁用/熔断后动态插件路由由 muted gate 立即 404，
  彻底移除需重启。
- 启用被依赖插件后，先前因它被禁用而跳过的插件需重启恢复（管线只在启动期排序）。
- `HOST_MODE` 是**进程级**过滤（启动期），不随请求变化；单进程内无法同时服务两种模式。
- 模式过滤依赖 `projects.mode` 的正确性：旧数据 NULL 一律按 `manual` 处理。
- permissions 当前是 **声明与审计** 用途（manifest 校验白名单），同进程插件不构成内存级沙箱。
