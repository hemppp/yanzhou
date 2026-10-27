# ADR-0008 · 桌面端打包契约（P0 契约冻结）

- 状态：**已冻结（Frozen）**
- 日期：2026-10-02
- 决策者：architect（P0 任务 t1）
- 范围声明：本 ADR **只定义契约**，不修改 `apps/` / `packages/` 下任何代码。本次任务唯一新增文件即本文件。
- 下游消费者：t2（主进程 / 预加载 / 窗口）、t3（server 子进程与生命周期）、t4（electron-builder 配置与原生模块）、t5（updater 与 `build-update.mjs`）、t6（E2E 验证）、t7（评审）、t8（报告）

> **本 ADR 的冻结强度**
> 凡标注「**已冻结**」的条目——路径、文件名、包名、环境变量名、IPC 通道名字面量、`window.desktopAPI` 方法名与返回字段名、`manifest.json` 字段名、资源布局、图标路径与尺寸——后续实现任务（t2–t5）**不得改写**。
> 实现任务如认为某条契约本身有误，必须**回到 captain 重新开 P0 修订**，不得就地变更。
> 凡标注「**需人工确认**」的条目，表示该结论**尚未被本任务实测证实**，实现任务必须先验证再依赖它。

---

## 0. 事实基线与取证方式

本 ADR 的每条数字与路径均来自下表所列的**实际读取**（`read` / `grep` / `Select-String`）或**实际探针运行**。探针均在仓库外 `D:\Temp\*` 执行，仓库仅新增本文件。

| 编号 | 事实 | 取证来源 | 方式 |
|---|---|---|---|
| F1 | Electron 运行时 `process.versions.modules` = **149**；`app.isPackaged` = true | `D:\Temp\pnpm-eb\trace.json` = `{"electron":"44.5.1","modules":"149","isPackaged":true}` | 探针实跑 |
| F2 | 本机 Node v24.14.1 ⇒ modules **137** | `node -v` / `process.versions.modules` | 实跑 |
| F3 | 仓库内 `electron` / `electron-builder` **均未安装** | `git grep '"electron' -- '**/package.json'` = 空（exit 1）；`pnpm-lock.yaml` 仅含 `electron-to-chromium@1.5.357`；`node_modules\electron\package.json` 与 `node_modules\electron-builder\package.json` 均 ABSENT | grep + Test-Path |
| F4 | 端口就绪行由 `console.warn` 输出 ⇒ 走 **stderr** | `apps/server/src/plugin/host.ts:996`；实测 `D:\Temp\nm-adr-probe\err4.txt` 末行 `[Server] Cordis 基座已就绪 → http://localhost:58764` | 读取 + 探针实跑 |
| F5 | `start()` 返回 `{port, url}`，但调用点丢弃返回值 | `host.ts:997 return { port: port2, url };`；`apps/server/src/index.ts:178 await serverPluginHost.start({ port, host: bindHost, distIndex });` | 读取 |
| F6 | `PORT=0` 被注释显式标为 Electron 场景 | `apps/server/src/index.ts:21-22` | 读取 |
| F7 | Windows 上 `child.kill('SIGTERM')` **不触发子进程 SIGTERM handler** | `D:\Temp\sig-probe`：`kill(SIGTERM) returned: true` / `exitCode: null signalCode: SIGTERM` / `sigterm.txt exists: false` / `sigint.txt exists: false` | 探针实跑（**证伪**） |
| F8 | server 当前**无任何 stdin 通道** | `apps/server/src` 全目录 grep `process\.stdin\|stdin` = **0 命中** | grep |
| F9 | 生产环境缺 `JWT_SECRET` 直接拒绝启动 | `apps/server/src/index.ts:37-40`（`process.exit(1)`） | 读取 |
| F10 | 生产环境下 `jwt.ts` 拒绝文件回退 | `apps/server/src/lib/jwt.ts:63-64`（`if (process.env.JWT_SECRET) return …; if (process.env.NODE_ENV === 'production') return undefined;`） | 读取 |
| F11 | 4 处路径解析依赖 `pnpm-workspace.yaml` 标记向上查找 | `packages/db/src/index.ts:53-61`、`packages/db/src/project-db.ts:79-87`、`packages/db/src/better-sqlite3-adapter.ts:22-45`、`apps/server/src/lib/jwt.ts:31-48` | 读取 |
| F12 | 项目库**无 env 覆盖口**，恒落 `<marker root>/data/projects/` | `packages/db/src/project-db.ts` 全文无 `process.env`；`:142 projectsDir = path.resolve(root,'data','projects')` | 读取 |
| F13 | 缺 `<PLUGINS_ROOT>/node_modules` 时依赖 `hono` 的插件被隔离 | `D:\Temp\nm-adr-probe\eS.txt` / `eP1.txt`：`PLUGIN_FAIL Cannot find package 'hono' imported from …plugins\manual\novel.bookscan\server\index.ts` | 探针实跑 |
| F14 | `sql-wasm.wasm` = **659730 B**；`initSqlJs()` 无参调用 | `node_modules/sql.js/dist/sql-wasm.wasm`；`packages/db/src/index.ts:132-134` | 读取 |
| F15 | 仓库内**无 `.ico` / `.icns`** | `Get-ChildItem -Recurse -Include *.ico,*.icns`（排除 node_modules）= 空 | 实跑 |
| F16 | 图标源图 `bamboo-ink.png` = 1672×941 RGB, 2876515 B | Pillow 12.3.0 实测 | 探针实跑 |
| F17 | 图标生成产物：`icon.png` 512×512 RGBA 527794 B；`icon.ico` 256×256 RGBA 190206 B | `D:\Temp\nm-adr-probe\icon\` | 探针实跑 |
| F18 | `yauzl` / `adm-zip` / `extract-zip` / `png-to-ico` 均 **ABSENT** | `Test-Path node_modules\<m>\package.json` | 实跑 |
| F19 | electron 44.5.1 与 NSIS 工具链**已离线缓存** | `$env:LOCALAPPDATA\electron\Cache\electron-v44.5.1-win32-x64.zip`（110740332 B）；`$env:LOCALAPPDATA\electron-builder\Cache\{nsis,nsis-3.0.4.1,nsis-resources-3.4.1,winCodeSign,7zip@1.0.0}` | 实跑 |
| F20 | Windows 目录 junction 可创建，但 `lstat().isDirectory()` = false | `D:\Temp` junction 探针：`JUNCTION_OK ["marker.txt"]`，`lstatSync(link).isDirectory()` = false | 探针实跑 |
| F21 | 打包产物形态（`build` 内嵌 `apps/desktop/package.json`）已跑通 | `D:\Temp\eb-probe\out2\win-unpacked\EbProbe.exe` 存在；`D:\Temp\mainbundle\out\win-unpacked\mainbundle-probe.exe` 245726208 B；`app.asar` 2904 B | 探针实跑 |
| F22 | 纯目录（非 asar）部署下动态 import 全部可用 | 探针输出 `PKG_TEST {"dynBs3":"OK","dynDrz":"OK","dynRoute":"OK","migDirExists":true}` | 探针实跑 |
| F23 | Mode A（esbuild CJS 单 bundle）= 5637379 B，exit 0，但变量说明符 `import()` **未被重写** | `D:\Temp\modeA\server.cjs`；`D:\Temp\dynprobe2` 报 `DYN_FAIL ../ai/agents/chat-agent.js ERR_MODULE_NOT_FOUND` | 探针实跑 |
| F24 | Mode B（tsx + TS 源）负载 = **189 packages / 107768288 B**；tsx 包 518243 B | 探针实测 | 探针实跑 |
| F25 | better-sqlite3 无 Electron 预编译包，必须源码编译 | `prebuild-install --runtime=electron --target=44.5.1` → HTTP 404 `better-sqlite3-v12.11.1-electron-v149-win32-x64.tar.gz` | 探针实跑 |
| F26 | electron-builder 驱动 rebuild 后 `.node` 1919488 B → **1921024 B**（ABI 137→149） | 探针实测 | 探针实跑 |
| F27 | rebuild 会**就地改写项目 node_modules** ⇒ 之后需 `pnpm install` 恢复 Node ABI | 探针实测 | 探针实跑 |
| F28 | pnpm × electron-builder 崩溃根因与修复 | `app-builder-lib/node_modules/@electron/get` 3.0.0 缺 `ElectronDownloadCacheMode`；加 `overrides: '@electron/get': ^3.1.0` 后 `--win dir --x64` exit=0 | 探针实跑 |
| F29 | 现有跨平台洁净度判据原文 | `docs/reports/dock-refactor-verification.md:567-568` | 读取 |
| F30 | 仓库仅 2 个提交，桌面/重构产物全部未入库 | `git log --oneline --all` = `a0e1db0`、`c2583f8` | 实跑 |
| F31 | `apps/desktop` **不存在** | `Test-Path apps\desktop` = False | 实跑 |
| F32 | 前端构建产物为 root-absolute 引用 ⇒ 必须从源根 `/` 提供 | `apps/web/dist/index.html` 引用 `/assets/index-_34EEzhp.js`、`/favicon.svg`、`/fonts/PressStart2P-Regular.woff2` | 读取 |
| F33 | CSP 冻结：`connect-src 'self' http://localhost:* https: wss: ws:` | `apps/web/vite.config.ts:54-64`；同样烘焙进 `apps/web/dist/index.html:36` | 读取 |
| F34 | API base 单一真源 = `resolveApiUrl()`，默认 `'/api'` | `apps/plugins/shared/data-core/src/api/apiClient.ts:423-437` | 读取 |
| F35 | `apps/server/node_modules` 仅 5 项：`@novel/{core,db,shared}`、`@novel-plugins/worldbuilding`（junction）、`openai`（实体） | 目录枚举 | 实跑 |

---

## D1 · 产物矩阵与目标平台 —— **已冻结**

| 项 | 冻结值 |
|---|---|
| 平台 | **仅 `win32` / `x64`**（`pnpm-workspace.yaml:27-31` `supportedArchitectures: {os:[win32], cpu:[x64]}`） |
| 分发形态 | ① NSIS 安装版 ② 标准便携版 zip（解压即用，D4.4）——**单文件便携 exe 已于 D4.6 移除** |
| 应用显示名 `productName` | `砚舟` |
| 应用 ID `appId` | `com.novelmuse.desktop` |
| 桌面壳包名 | `@novel/desktop`，版本随 `novel-companion` 根版本（当前 `0.2.0`） |
| 快捷方式名 `shortcutName` | `听风细雨` |
| 产物输出目录 | `F:\new1.2\release\desktop`（`/release/` 已在 `.gitignore:28`） |
| NSIS 安装包文件名 | `砚舟-Setup-${version}-x64.exe` |
| 便携版文件名（单文件 exe） | ~~`砚舟-Portable-${version}-x64.exe`（自解压，D4.5）~~ **已于 D4.6 移除，不再产出** |
| 便携版文件名（绿色 zip） | `砚舟-Portable-${version}-x64.zip`（内含顶层 `砚舟/`，D4.4） |

**不做**：macOS / Linux / arm64 / Squirrel / MSI / AppX。**不做** macOS/Linux 目标是硬约束（见 D18）。

---

## D2 · `apps/desktop` 文件清单（逐文件职责） —— **已冻结**

`apps/desktop` 当前不存在（F31），从零新建。最终形态冻结为：

```
apps/desktop/
├─ package.json                      @novel/desktop；main=dist/main.cjs；内嵌 electron-builder 的 build 配置块
├─ tsconfig.json                     仅类型检查（noEmit），target ES2022 / module ESNext / strict
├─ build-resources/
│  ├─ icon.ico                       安装包与 EXE 图标（256×256 多尺寸 ICO，190206 B）
│  ├─ icon.png                       512×512 源图标（527794 B）
│  └─ splash.bmp                     便携版 exe 启动图（640×400 24-bit BMP，768054 B；D4.5）
├─ scripts/
│  ├─ gen-icon.py                    由 apps/web/public/images/bamboo-ink.png 生成 build-resources/icon.{png,ico}
│  ├─ gen-splash.py                  生成 build-resources/splash.bmp（便携版启动图，D4.5）
│  ├─ bundle-shell.mjs               esbuild 打包 src/*.ts → dist/main.cjs + dist/preload.cjs
│  ├─ build-server-payload.mjs       生成 app-server 负载（TS 源 + 依赖闭包 + 标记文件 + worldbuilding）
│  └─ build-update.mjs               发布工具：产出 release/updates/（manifest.json + app zip + 插件 zip + SHA-256）
└─ src/
   ├─ main.ts                        主进程入口：单实例锁 → 首启播种 → 起 server 子进程 → 建窗口 → 生命周期编排
   ├─ preload.ts                     contextBridge 注入 window.desktopAPI（9 方法，逐字对齐 desktop-api.d.ts）
   ├─ ipc-channels.ts                IPC 通道名字面量唯一真源（主进程与 preload 共用，见 D11）
   ├─ paths.ts                       userData 布局解析与播种（data / plugins / logs / app-runtime / backups）
   ├─ env.ts                         子进程环境变量装配（逐条实现 D6 冻结表）
   ├─ server-process.ts              内嵌 server 子进程：spawn、stderr 握手、健康探针、优雅退出
   ├─ logger.ts                      主进程日志 + 子进程 stdout/stderr 落盘到 <userData>/logs/
   ├─ window.ts                      主窗口尺寸 / 最小尺寸 / 菜单 / 外链处理
   ├─ updater.ts                     远程更新：检查 / 下载 / SHA-256 校验 / 解压防穿越 / 备份 / 切换
   ├─ updater-manifest.ts            manifest.json 解析与版本比较
   └─ types.ts                       主进程内部共享类型
```

**冻结约束**：
1. `apps/desktop/src/preload.ts` 这一路径被 `apps/web/src/types/desktop-api.d.ts:2` 逐字引用（`// 运行时由 apps/desktop/src/preload.ts 的 contextBridge 注入`）⇒ **不可改名、不可移位**。
2. `dist/` 由 `bundle-shell.mjs` 产出，已被 `.gitignore:6 dist/` 覆盖，不入库。
3. 图标与构建资源目录必须叫 **`build-resources/`** 而**不是** `build/`：`.gitignore:12` 的 `build/` 会忽略任意层级同名目录，且本任务**不允许修改 `.gitignore`**（只允许新增本 ADR 一个文件）。

---

## D3 · 新增依赖与安装步骤 —— **已冻结**

### D3.1 仓库当前状态（F3）
`electron`、`electron-builder`、`@electron/rebuild`、`@electron/packager`、`@electron/asar`、`app-builder-lib`、`yauzl`、`adm-zip`、`extract-zip`、`png-to-ico`、`sharp` 在 `F:\new1.2\node_modules` 下**全部 ABSENT**。仓库内唯一含 `electron` 字样的是 `pnpm-lock.yaml` 的 `electron-to-chromium@1.5.357`。

### D3.2 必须新增的依赖（冻结）

| 包 | 版本 | 位置 | 理由 |
|---|---|---|---|
| `electron` | `44.5.1`（精确） | `apps/desktop/package.json` → **`devDependencies`** | 运行时宿主；electron-builder 强制要求它在 devDependencies |
| `electron-builder` | `26.15.3`（精确） | `apps/desktop/package.json` → **`devDependencies`** | 打包器 |
| `@electron/rebuild` | `4.2.0`（传递依赖，不显式声明） | 由 electron-builder 拉入 | better-sqlite3 ABI 重建 |
| `esbuild` | `0.28.2`（仓库已装，`node_modules/esbuild`） | 复用根依赖 | 打包 `main.ts` / `preload.ts` |
| `better-sqlite3` | `12.11.1`（精确） | `apps/desktop/package.json` → **`dependencies`** | **唯一目的：触发 electron-builder 的 ABI 重建**（见 D8）。放在 devDependencies 会被 electron-builder 拒绝 |
| `yauzl` | `^3.4.0` **需人工确认精确解析版本** | `apps/desktop/package.json` → **`dependencies`** | 更新包解压。Node 24 **无内置 zip 读取**，仓库内 `yauzl`/`adm-zip`/`extract-zip` 均 ABSENT（F18） |

### D3.3 `pnpm-workspace.yaml` 必须新增（冻结）

```yaml
overrides:
  '@electron/get': ^3.1.0      # 必须。否则 electron-builder 崩溃（F28）
```

- 现有 `overrides` 块（`pnpm-workspace.yaml:46-56`）已存在，**在其后追加**该键，不要新建第二个 `overrides` 键。
- `allowBuilds` / `onlyBuiltDependencies`（`pnpm-workspace.yaml:17-24`）**已含** `better-sqlite3`、`electron`、`esbuild` ⇒ **无需改动**。
- **不需要**把 `electron-winstaller` 加进 `allowBuilds`：`electron-winstaller` 只服务 Squirrel.Windows，本 ADR 已排除 Squirrel（D1）。
- `apps/desktop` 已在 `packages: apps/*` 覆盖范围内 ⇒ 无需新增 workspace 条目。

### D3.4 安装步骤（冻结，按序执行）

```powershell
cd F:\new1.2
# 1) 写入 overrides 与 apps/desktop/package.json（含 D16 的 build 配置块）
pnpm install
# 2) 校验 electron-builder 可跑（离线，F19 缓存已就绪）
.\apps\desktop\node_modules\.bin\electron-builder.cmd --win dir --x64
```

**注意（实测教训，冻结为规则）**：
- **必须使用本地 `apps\desktop\node_modules\.bin\electron-builder.cmd`**；`npx electron-builder` 不可靠（探针中曾因 TLS/套接字下载栈失败 exit=1）。
- `--config.resolutionMode=highest` 对 `@electron/get` 问题**无效**；pnpm 11.8.0 **拒绝** `--resolution-mode`。唯一有效修复是 `overrides`。
- **不得**手工调用 `@electron/rebuild`：`node node_modules\@electron\rebuild\lib\cli.js -v 44.5.1 -a x64 -m better-sqlite3` → `✖ Rebuild Failed ENOENT … 'better-sqlite3\package.json'`；加 `-w .` → `No native modules found / ✔ Rebuild Complete`（静默空转）。**必须让 electron-builder 驱动。**
- 打包后 `F:\new1.2\node_modules\better-sqlite3\build\Release\better_sqlite3.node` 会被改写成 ABI 149（F26/F27）⇒ **桌面打包后必须 `pnpm install`（或 `pnpm rebuild better-sqlite3`）恢复 Node ABI 137**，否则 `pnpm dev` 起不来。此条为硬性操作纪律。

---

## D4 · server 运行模式 —— **已冻结：Mode B（tsx + 真实文件）**

### D4.1 唯一决策

**采用 Mode B：把 server 以「真实文件」形式投递到 `resources/app-server/`，由 tsx 在 Electron 的 Node 运行时里加载 TS 源码。**

**拒绝 Mode A（esbuild CJS 单 bundle）**，理由如下（均实测）：
1. Mode A 产出 `5637379 B`、exit 0，但 `apps/server/src/modules/ai.ts:1351 const agentModule = await import(route.modulePath);` 是**运行时变量说明符**，esbuild 无法静态分析 ⇒ 5 条 AI agent 路由的 `.js` 文件不会被产出，运行时 `ERR_MODULE_NOT_FOUND`（F23，探针原文 `DYN_FAIL ../ai/agents/chat-agent.js`）。
2. 动态 `import()` 的相对说明符是相对**bundle 自身目录**解析的，不是相对原源码目录 ⇒ 需要把 5 个 agent 模块**展平**投递到 bundle 的 `../ai/agents/`，脆弱。
3. asar 内动态 `import()` 裸说明符直接失败（探针 `Cannot find module 'bindings'`）⇒ 无论如何都要走真实文件。

### D4.2 Mode B 的硬要求（冻结）

| 项 | 冻结值 |
|---|---|
| 负载根 | `resources/app-server/`（`extraResources` 投递） |
| 负载生成器 | `apps/desktop/scripts/build-server-payload.mjs`（**确定性脚本**，不得手工拷贝） |
| 体积基线 | **189 packages / 107768288 B（≈102.8 MB）**（F24）；**2026-10-06 方案 A 修订后实测 165 包 / 71503210 B（≈68.2 MB）**，见下「D4.2-修订」 |
| tsx | `<app-server>/node_modules/tsx`（518243 B，F24） |
| server 入口 | `<app-server>/apps/server/src/index.ts` |
| 子进程 cwd | `<userData>/app-runtime/app-server` |
| 启动方式（首选） | `spawn(process.execPath, ['--import', 'tsx', '<entry>.ts'], { cwd, env })`，`env.ELECTRON_RUN_AS_NODE = '1'` |
| 启动方式（备选，**需人工确认**首选是否可用） | `spawn(process.execPath, ['<app-server>/node_modules/tsx/dist/cli.mjs', '<entry>.ts'], { cwd, env })` |

**必须随负载投递的内容（冻结清单）**：

| 路径 | 内容 | 依据 |
|---|---|---|
| `app-server/apps/server/src/**` | server 全部 TS 源码 | Mode B 本体 |
| `app-server/packages/{core,db,shared}/**` | 三个 workspace 包的 `src/`、`package.json`（含 `exports`） | `packages/*/package.json` 的 `main`/`types` 直指 `src/index.ts` |
| `app-server/packages/db/drizzle/**` | `0000_common_lester.sql`(10874 B)、`0001_skills_library.sql`(1952 B)、`0002_skill_library_owner.sql`(1043 B)、`project_tables.sql`(13285 B)、`meta/{_journal.json,0000_snapshot.json}` | `better-sqlite3-adapter.ts:488` `migrationsDir = path.resolve(_moduleDir,'../drizzle')`；`project-db.ts:172-173` 同型 |
| `app-server/node_modules/@novel/{core,db,shared}` | `packages/*` 的实体副本 | 使 `@novel/db` 等裸说明符可解析 |
| `app-server/node_modules/@novel-plugins/worldbuilding` | `apps/plugins/manual/worldbuilding` 的**实体副本（解引用 junction）** | `builtin.ts:55-65 () => import('@novel-plugins/worldbuilding')`；开发态该包只存在于 `apps/server/node_modules/`（F35） |
| `app-server/node_modules/**`（第三方闭包） | server 运行期依赖闭包（tsx / hono / drizzle-orm / sql.js / better-sqlite3 / zod / openai / jsonwebtoken / bcryptjs / undici / uuid / @hono/* / @deepseek-ai/* 等） | 189 packages 基线 |
| `app-server/pnpm-workspace.yaml` | **仓库根同名文件的逐字副本** | 4 处路径解析依赖该标记（F11） |
| `app-server/seed-plugins/{auto,manual,shared}/**` | `apps/plugins/` 下 5 个磁盘插件 | 首次启动播种到 `<userData>/plugins/`（D7） |

**必须排除**：`apps/plugins/**/node_modules/**`（仅 `auto/novel.autowrite` 与 `manual/workbench` 有插件局部 `node_modules`，会污染解析）。

#### D4.2-修订（2026-10-06，方案 A：启动图 + 裁剪负载）

> **后续状态（同日，D4.4）**：本节新增的 `portable.splashImage` 随 `portable` 目标一并废弃；下文的启动图论述保留为历史记录。裁剪负载两项过滤器**仍然有效**，是当前便携版 zip 体积的基础。

**动机**：便携版（NSIS 自解压）首次启动需把负载解到 `%TEMP%`。实测原负载 **32158 文件 / 240.8 MB**，解压耗时约 **4.5 分钟**且全程无窗口（未配 `splashImage` 时 `portable.nsi:11-13` 会 `SetSilent silent`），用户据此误判为「启动失败」。故做两项改动：

1. **启动图**：`portable.splashImage = build-resources/splash.bmp`（640×400 24-bit BMP，768054 B）。`NsisTarget.js:250` 按 `packager.projectDir` 解析该路径；`portable.nsi:21-24` 走 `BgImage::SetBg` ⇒ 解压全程有可视反馈，且 `!ifndef SPLASH_IMAGE` 不再成立 ⇒ 不进入静默分支。
2. **裁剪负载**：`build-server-payload.mjs` 新增两道过滤器，均**确定性**、可复算：
   - `WEB_ONLY` 名单：**整包不投递**且**不再向下展开**。判定依据 = 扫 server 侧全部源码（`apps/server/src`、`packages/{core,db,shared}/src`、各插件 `server/` 目录）本名单包 **0 处真实 import**；插件 web 面由 vite 构建期收集（`apps/web/src/plugin/moduleEntries.ts:71-72`），server 运行期不读 `webEntry`；`plugin-tools.ts:123-124` 的 `react`/`lucide-react` 只在 `webTemplate()` 模板字符串内部；`workbench/stores/index.ts` 的 `zustand` 只被 web 面引用。含 `react`/`react-dom`/`react-is`/`scheduler`/`use-sync-external-store`/`lucide-react`/`three`/`@xyflow/*`/`classcat`/`leaflet`/`d3-force*`/`@tiptap/{core,pm,react,starter-kit,extension-*}`/`@remirror/core-constants`/`prosemirror-*`/`markdown-it`+其链/`date-fns`/`dompurify`/`html-to-image`/`tippy.js`/`@popperjs/core`/`zustand`/`nanoid`。**安全闸** `assertNoRetainedDependsOnWebOnly()`：闭包内任何保留包若把被剔除项声明为 `dependencies`/`optionalDependencies` 即**抛错**，绝不静默产出坏负载。
   - `stripFromThirdParty`：第三方包内 `.map` / `.d.ts` / `.md` / `.txt` / `LICENSE*` / `CHANGELOG*` / `.github` / `.vscode` / `__tests__` / `.nycrc` / `.editorconfig` / `.eslintrc*` 不复制（仅服务 tsc、调试器与人类，node/tsx 运行期不读）。**仅作用于第三方闭包**；workspace 包是 TS 源，原样投递。
   - `stripNodeModules`：`packages/{core,db,shared}` 实体副本排除其自带 `node_modules`。原先 `dereference:true` 会把 `packages/core/node_modules/lucide-react`（27 MB）实体拖进负载（`@novel/core` 下 3544 文件即此）。

**实测收益**（`node apps/desktop/scripts/build-server-payload.mjs`）：

| 指标 | 修订前 | 修订后 | 变化 |
|---|---|---|---|
| `app-server` 体积 | 252477088 B | **71503210 B** | −71.7% |
| `app-server` 文件数 | 32158 | **5935** | −81.5% |
| 第三方闭包包数 | 261 | 165 | −96 包 |
| `.map`+`.d.ts` 残留 | 13471 文件 / 115.9 MB | **0 / 0** | 全清 |

10 项自检全 ✔（含 D9 冻结的 `sql-wasm.wasm` 659730 B、`tsx/dist/cli.mjs`、`@novel/db` 实体、drizzle 迁移、worldbuilding 实体、`pnpm-workspace.yaml` 标记）。`better-sqlite3` 仍按 D8.2 不投递实体（运行期 junction 指向 `app.asar.unpacked`）。

**保留项说明**：`@tiptap/*` 整族剔除后，`packages/core` 的根 barrel（`index.ts`）**不**再导出 `web.ts`（仅 `./loader.js` 等 server 面），故 web-only 类型不再被 server 模块图拉入；`@novel/core/web` 子路径导出仍由 `package.json` 的 `exports["./web"]` 声明，web 面走 vite 构建，不受影响。

### D4.3 动态 import 点清单（**验收标准 3 要求**）

以下为 `apps/server/src` 与 `packages/db/src` 中**全部**运行时动态 `import()`。**在 Mode B 下它们全部无需特殊处理**——因为每个说明符都能作为真实文件/真实包解析。此清单的作用是**约束 `build-server-payload.mjs` 的依赖闭包必须覆盖它们**。

| # | 位置 | 说明符 | Mode B 处置 |
|---|---|---|---|
| 1 | `apps/server/src/modules/ai.ts:1351` | `route.modulePath`（**变量**，实际值 `../ai/agents/{chat,entity-extract,consistency,style,quick-phrase}-agent.js`） | 源码实体投递即可；tsx 会把 `.js` 说明符解析到同目录 `.ts`（探针 `ABS_JS_TSX_OK` 已证 tsx 会改写 `.js`→`.ts`） |
| 2 | `apps/server/src/plugin/local-scanner.ts:155` | `pathToFileURL(join(meta.dir, meta.serverEntry)).href`（**绝对 file://**，指向 `<PLUGINS_ROOT>/**/server/index.ts`） | 无特殊处理；但 `<PLUGINS_ROOT>/node_modules` 必须存在（D7.4） |
| 3–23 | `apps/server/src/plugin/builtin.ts:25-65` | 21 条：20 条 `import('../modules/<name>.js')` + 1 条 `import('@novel-plugins/worldbuilding')` | 前 20 条随 `apps/server/src` 投递；第 21 条依赖 D4.2 的 worldbuilding 实体副本 |
| 24 | `packages/db/src/index.ts:132` | `import('sql.js')` | 依赖闭包含 `sql.js`；见 D9 |
| 25 | `packages/db/src/index.ts:1346` | `import('./better-sqlite3-adapter.js')` | 同源投递 |
| 26 | `packages/db/src/better-sqlite3-adapter.ts:817-818` | `import(BETTER_SQLITE3)` / `import(DRIZZLE_BETTER_SQLITE3)`（**变量**，L19-20 常量 = `'better-sqlite3'` / `'drizzle-orm/better-sqlite3'`） | 依赖闭包 + D8 的 junction |
| 27–35 | `packages/db/src/project-db.ts:67,68,72,93,94,138,160,161,165`、`migrate-to-project-dbs.ts:228,229` | `better-sqlite3` / `./project-db.js` 等 | 依赖闭包 |
| 36 | `apps/server/src/index.ts:147` | `import('net')` | Node 内建 |
| 37 | `apps/server/src/index.ts:195` | `import('./services/chapter-service.js')` | 同源投递 |
| 38–39 | `apps/server/src/middleware/auth.ts:45,82` | `import('../services/auth-service.js')` | 同源投递 |
| 40 | `apps/server/src/services/chapter-service.ts:344`、`demo-seed.ts:15,736`、`project-service.ts:60` | `import('@novel/db')` | D4.2 的 `@novel/db` 副本 |
| 41 | `apps/server/src/modules/characters.ts:233` | `import('../services/character-merge-service.js')` | 同源投递 |
| 42 | `apps/server/src/modules/admin.ts:193` | `import('fs')` | Node 内建 |
| 43 | `apps/server/src/lib/ssrf-guard.ts:159` | `import('dns/promises')` | Node 内建 |

**非运行时**（TS 类型位置，不构成动态 import）：`apps/server/src/plugin/types.ts:27-28`、`apps/server/src/plugin/host.ts:55,551,560,567,583`。

**Mode B 风险等级：中。** 风险点：① 102.8 MB 体积；② `--import tsx` 在 Electron-as-Node 下的可用性（**需人工确认**，t4 冒烟验证）；③ 依赖闭包若漏包则运行期才暴露（**必须** t4 起真机冒烟）。

### D4.4 便携版分发形态：标准绿色 zip（**2026-10-06 决策，取代原 NSIS portable**）

**背景**：原「便携版」= electron-builder 的 `portable` target，产出**单个自解压 exe**。它有两个硬伤：

1. **首启极慢且无反馈**。双击后要把 490 MB 解包内容释放到 `%TEMP%`，耗时以分钟计；未配 `splashImage` 时 `portable.nsi:11-13` 走 `SetSilent silent`，全程无窗口，用户会判定「双击没反应 / 启动失败」。（D4.2-修订 加启动图只是缓解，不改变形态本身非常规。）
2. **单文件 exe 易被拦**。未签名的自解压 exe 常被邮件网关、网盘与杀软直接拒绝或标记。

**决策**：改用**标准绿色便携版**——一个普通 `.zip`，解压后得到顶层 `砚舟/` 目录，进去双击 `砚舟.exe` 即运行。删除 `portable` target 与 `portable.splashImage`（连同 `build-resources/splash.bmp`）。

**为什么不直接用 electron-builder 的 `zip` target**：实测它产出的压缩包是**平铺**的——6273 个文件（`chrome_*.pak`、`*.dll`、`砚舟.exe`、`locales/`、`resources/` …）直接铺在压缩包根，用户解压会把目标目录炸开一片，不符合「一个文件夹」的绿色版惯例。

**实现**：`apps/desktop/scripts/package-portable-zip.mjs`（新增）。职责：

1. 校验 `release/desktop/win-unpacked/砚舟.exe` 存在（否则提示先跑 `--dir`）。
2. 把 `win-unpacked/` **复制**到 `%TEMP%` 下的干净暂存目录，重命名为顶层 `砚舟/`。
3. 写入 `使用说明.txt`（用法 / 首启较慢提示 / 默认管理员账号 / 数据目录 / 系统要求 / 版本）。
4. 用 Windows 自带 `tar --format=zip` 打成 `release/desktop/砚舟-Portable-<version>-x64.zip`。
5. 打印体积、耗时与 SHA256；无论成败都清理暂存目录。

**为什么必须先复制到暂存区（关键，勿优化掉）**：直接对 `win-unpacked/` 打包会把该目录树上的 ACL 一并写进 zip。在受限/沙箱环境（如 Codex 沙箱、DSH 工作区）里仓库树会被注入低完整性标签（`Mandatory Label\Low Mandatory Level`、`Everyone:(DENY)(DC)`、`CodexSandboxUsers` 等），解压出来的副本继承这些 ACE 后 **Electron 启动即崩**：加载 V8 snapshot 时 CHECK 失败，stderr 报 `Received fatal exception EXCEPTION_BREAKPOINT`（`electron::fuses::IsLoadBrowserProcessSpecificV8SnapshotEnabled`），退出码 `0x80000003`（= `-2147483645`），且**不写任何日志**——极难定位。复制到 `%TEMP%` 后条目权限是干净的标准 ACL。

> 实测对照（同一份 `win-unpacked`，仅位置不同）：原地 `F:\new1.2\release\desktop\win-unpacked` → 立即崩、无日志；复制到 `F:\ptest2` / `C:\...\Temp\ptest3` / `D:\t6work\ptest` → 正常起窗（5 进程，窗口标题 `听风细雨 - 伴写小说工具`）。三处 `砚舟.exe` SHA256 完全一致（`FD3D6AF4…25A45`），排除二进制差异。

**一键入口**：`pnpm -C apps/desktop dist:zip` = `build-server-payload` → `bundle-shell` → `electron-builder --win --x64 --dir` → `package-portable-zip`。

**验收实测（2026-10-06）**：早期构建为 199732376 B / SHA256 `9d59d6ddf9aba8d3f13ffb8f49f6d80dc02ce786bdf136ce370cdb2f4f3b4bc8`（7223 条目）；**最终发布构件**（`release/desktop/砚舟-Portable-0.2.0-x64.zip`，即 GitHub v0.2.0 Release 资产）为 **199732384 B（190.48 MB）**，SHA256 `eeaa7a48998e0333c095e78360162fb83dc0386f28c8f6ed8127fc1055e660ec`，**7224 条目**，顶层为 `砚舟/`；解压约 5 s；解压后双击 exe → 5 进程、窗口标题 `听风细雨 - 伴写小说工具`、`main.log` 有正常启动记录。

**数据落点不变**：仍是 `%APPDATA%\NovelMuse`（R13 结论），升级时覆盖文件夹即可保留书稿。

> ⚠️ **该结论已由 D4.7（2026-10-08）修订**：直接双击 `砚舟.exe` 时落点仍是
> `%APPDATA%\NovelMuse`；但双击新附带的 `启动便携版.cmd` 时，`userData` 被
> `--user-data-dir` 重定向到解压目录内的 `portable-data\`，**数据随文件夹走**。

### D4.5 单文件便携 exe（**2026-10-06 同日追加；与 D4.4 的绿色 zip 并行提供**）

> ⛔ **本节已被 D4.6 取代，仅作历史记录。** `portable` target、`dist:portable` 脚本、
> `portable.splashImage` 均已移除；下文的命令与配置**不要再执行**。
> `#### D4.5-1` 的冒烟纪律仅对 `win-unpacked\砚舟.exe` 仍有参考价值。

> **背景**：D4.4 把便携版改成绿色 zip 后，用户仍要「一个 exe 双击即用」。判断：zip 需「解压 → 进目录 → 双击」三步，单文件 exe 一步；D4.4 列的两条硬伤已缓解——① 负载已裁剪（240.8 MB → 68.2 MB），静默解压从 ~4.5 分钟降到 ~1–2 分钟，且配 `splashImage` 后首启全程有启动图反馈；② 未签名 exe 的拦截风险如实记录，由用户在 zip 与 exe 之间自行选择。

**决策**：恢复 electron-builder 的 `portable` target，`win.target` 同时产出 `nsis` 与 `portable`；两种便携形态**并存**——zip 走 D4.4 的 `package-portable-zip.mjs`，exe 走 electron-builder 原生自解压。`build-resources/splash.bmp` 随之恢复入库。

**冻结配置**（`apps/desktop/package.json` 的 `build`，与 `apps/desktop/electron-builder.yml` 必须同步）：

```jsonc
"win": {
  "target": [
    { "target": "nsis", "arch": ["x64"] },
    { "target": "portable", "arch": ["x64"] }
  ],
  "icon": "build-resources/icon.ico",
  "artifactName": "砚舟-${version}-${arch}.${ext}"
},
"portable": {
  "artifactName": "砚舟-Portable-${version}-${arch}.${ext}",
  "splashImage": "build-resources/splash.bmp",
  "unpackDirName": "砚舟"
}
```

一键入口：`pnpm -C apps/desktop dist:portable` = `build-server-payload` → `bundle-shell` → `electron-builder --win portable --x64`。

**`splashImage` 不是可选项**：`portable.nsi:11-13` 在**未**定义 `SPLASH_IMAGE` 时执行 `SetSilent silent` ⇒ 双击后全程无窗口，用户会判定「没反应 / 启动失败」（这正是 132af47 之前的真实反馈）。配了启动图才会走 `.onGUIInit` 的 `BgImage::SetBg` 分支。`unpackDirName: 砚舟` 让 `%TEMP%` 下的解压目录带产品名（否则是 `%TEMP%\app`）。

**首启实测**（2026-10-06，产物 `砚舟-Portable-0.2.0-x64.exe`，**122219604 B**，SHA256 `CBDF6A11CF09A96276178628FA231FDF4B1E9F33DDC3FB441EEEF8146C88CCB4`）：stub 起窗 → 解压 7223 条 → 窗口 `听风细雨 - 伴写小说工具`，耗时约 **64–102 s**；日志 `就绪探针通过：status=ok，database=connected，hostMode=all，plugins=27`；优雅关窗后 stub **自行退出（ExitCode=0）并删除 `%TEMP%\砚舟`**，日志 `server 子进程已按 stdin 协议自行退出（exitCode=0）`、`优雅关停完成（reason=before-quit）⇒ 退出进程。`

#### D4.5-1 冒烟纪律（**关键，勿重蹈覆辙**）

工作区 `F:\new1.2` 整棵树被注入**低完整性标签**（`icacls F:\new1.2` = `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`）并向下继承 ⇒ **在其中构建或放置的 exe 会继承 `Low`**，该进程以 Low IL 运行，写不了 Medium IL 的 `%TEMP%` 与 `%APPDATA%`。由此产生两个**极易误判为「产物坏了」**的症状：

| # | 症状 | 机制 |
|---|---|---|
| 1 | 双击 portable exe ⇒ 1 秒内弹 `NSIS Error`，正文 `Error writing temporary file. Make sure your temp folder is valid.`；不解压、`%TEMP%` 零新增条目（连 `ns*.tmp` 都没有） | stub 在 `.onInit` 阶段 `InitPluginsDir` 要往 `%TEMP%` 落插件/临时文件，Low IL 进程被拒 |
| 2 | 直接运行 `win-unpacked\砚舟.exe` ⇒ 无窗口、无日志、`ExitCode=0` 静默退出 | Chromium 单实例锁文件建不了：stderr `process_singleton_win.cc:318 Lock file can not be created: 拒绝访问。(0x5)` ⇒ `app.requestSingleInstanceLock()` 返回 false ⇒ `main.ts:451-456` 立即 `app.quit()`（位于 `app.whenReady()` 与 logger 构造**之前**，故不落任何日志） |

**判据（实测）**：只有「exe 在 `F:\new1.2` 下**且** `%TEMP%` 在工作区之外」才失败；把同一份字节复制到 `D:\…` / 无标签目录即正常，或让 `TEMP` 指向工作区内也可绕过。**产物二进制本身无缺陷**，与其他机器的下载者无关（下载到本地的文件继承的是正常 ACL）。

**纪律（四条）**：
1. **冒烟必须在 Medium IL 位置进行**：把产物复制到 `%TEMP%` / `D:\...` 等无 `Low` 标签的目录再跑，或对其执行 `icacls <path> /setintegritylevel Medium`。
2. **发布目录本身打 Medium 标签**：`icacls F:\new1.2\release /setintegritylevel (OI)(CI)Medium`（连同 `release\desktop`），否则**每次重新构建**出的新 exe 又会继承 `Low`。工作区根 `F:\new1.2` 的 `Low` 标签本 ADR **不改动**（属 DSH 沙箱姿态，改它会影响宿主沙箱语义）。
3. **启动 GUI 前清掉 `ELECTRON_RUN_AS_NODE`**（见 D12.5 末注）：本机 harness 全局设了该变量，否则 Electron exe 退化成 Node——表现为 `--version` 打印 `v24.21.0`、`--user-data-dir=…` 报 `bad option`、ExitCode=0 静默退出。
4. **失败先看 stderr 与 `<userData>\logs\main.log`**，不要以「无窗口」直接判定产物损坏。

> D4.4 的 zip 路径不受症状 1 影响：`package-portable-zip.mjs` 会先复制到 `%TEMP%` 暂存再压缩，故 zip 内条目是干净 ACL（D4.4 已有同源论述）。**exe 形态才需要上面的纪律 1/2。**

### D4.6 移除单文件便携 exe（**2026-10-06 决策，取代 D4.5**）

**决策**（用户要求「删除 exe 那个便携式」）：便携版**只保留 zip 一种形态**。删除 `release/desktop/砚舟-Portable-0.2.0-x64.exe`（122219604 B）及仓库内同字节副本 `release/__t_Frel.exe`；`win.target` 回退为**只有 `nsis`**；`portable` 配置段与 `dist:portable` 脚本一并移除。

**理由**：
1. **形态冗余**：D4.4 的绿色 zip 与 D4.5 的单文件 exe 交付同一套 `win-unpacked/`，功能完全重叠；两套维护（含 `splash.bmp`、`gen-splash.py`）是净成本。
2. **exe 形态本身最不可靠**：它是 NSIS 自解压 stub，首启实测 **64–102 s** 且依赖 `portable.nsi` 的启动图分支；而 zip 解压约 5 s、解压后直接是普通 exe，没有 stub 这一层。D4.5-1 记录的两个假象（`Error writing temporary file`、无窗口静默 exit 0）**只影响 exe 形态**。
3. **与本地运行方式的现实一致**：用户实际运行的正是 zip 解压目录（实测 `%APPDATA%\NovelMuse\app-runtime\app-server\node_modules\better-sqlite3` junction 指向 `D:\下载\NovelMuse-Portable-0.2.0-x64\NovelMuse\resources\app.asar.unpacked\...`）。

**保留项**：便携版 zip 的**文件名不变**，仍叫 `砚舟-Portable-<version>-x64.zip` —— 「Portable」描述的是便携形态，**不是** portable target。`package-portable-zip.mjs`、`build-resources/splash.bmp`、`scripts/gen-splash.py` 均保留（splash 只有 exe 形态引用，现为无用资产，但删除与否不影响构建）。

**冒烟纪律 1/2 是否仍需要**：**不再需要为 exe 执行**（该形态已不存在）。纪律 3/4（清 `ELECTRON_RUN_AS_NODE`、先看 `logs\main.log`）对 `win-unpacked\砚舟.exe` 仍然有效。

### D4.7 便携版预置运行时（**2026-10-08 决策，闭合 R13；免首启播种**）

**问题**（两个，同源）：

1. **首启要播种**。D7.2 会在首启把 `resources/app-server`（68.1 MB / 5910 文件）与
   `resources/web-dist`（8.1 MB / 84 文件）复制到 `<userData>/app-runtime/`。
   实测复制耗时 **12.4 s**，用户看到的是「双击后十几秒才出界面」。
2. **便携版数据不随身**（R13）。`app.getPath('userData')` 恒为 `%APPDATA%\NovelMuse`，
   与安装版相同、**不重定向**。⇒ 「拷走文件夹」并不等于「拷走书稿」，
   「绿色便携」名不副实。D20-R13 自 2026-10-06 起登记为未落地缺口。

**决策**：`package-portable-zip.mjs` 在打包时把运行时**预置**进 zip，并附一个启动器。
产物仍是同一个 `砚舟-Portable-<version>-x64.zip`（文件名不变，D4.6 保留项不变）。

**预置布局（冻结）**：

```
砚舟/
├─ 启动便携版.cmd          ← 启动器：--user-data-dir="<解压目录>\portable-data"
├─ 使用说明.txt
├─ 砚舟.exe / resources/ …   （electron-builder 的 win-unpacked 原样）
└─ portable-data/                 ← ★ 新增：预置的 userData
   ├─ app-runtime/
   │  ├─ app-server/         ← 逐字复制自 resources/app-server
   │  ├─ web-dist/           ← 逐字复制自 resources/web-dist
   │  └─ version.json        ← { appVersion, updatedAt, buildId }
   └─ plugins/{auto,manual,shared} ← 复制自 resources/seed-plugins/*
      plugins/local          ← 空目录（D7.2 步骤 4）
```

**为什么这样就不播种了**：`shouldReseed()`（D7.5）三条触发条件全部不命中 ——
`version.json` 存在（非 `missing`）、`appVersion` 与外壳**相等**（非 `shell-newer`）、
`buildId` 与 `build-stamp.json` **一致**（非 `payload-changed`）⇒ 闸门跳过播种，
直接使用预置运行时。

**★ 指纹必须同源（冻结，改了就会静默回退）**：
`portable-data/app-runtime/version.json` 的 `buildId` **必须**取自
`resources/app-server/build-stamp.json` 的 `buildId`，`appVersion` **必须**等于
`apps/desktop/package.json` 的 `version`。任一不符 ⇒ 判 `payload-changed` ⇒
清空 `portable-data/app-runtime` 重新播种，用户白等一场（功能仍正常，只是
「免播种」失效）。打包脚本已内建条目级校验。

**为什么用 `--user-data-dir` 而不是改代码**：Electron 自带该开关，把 `userData`
（含 `data` / `plugins` / `logs` / 缓存）整体重定向到指定目录。**应用源码零改动**，
D7.1 布局与 D7.3/D7.4/D8.2 三个 junction 全部照常（`<userData>/app-runtime/app-server/data`
→ `<userData>/data` 仍成立，只是 `<userData>` 换了根）。这比在 `paths.ts` 里加
「就地模式」分支更稳：应用内更新器（D14.5）仍写自己的 `app-runtime`，
不会穿进只读的 `resources/`。

**两种模式并存（冻结）**：

| 启动方式 | userData | 首启 | 数据随文件夹走 |
|---|---|---|---|
| 双击 `启动便携版.cmd` | `<解压目录>\portable-data` | **零等待**（预置） | ✅ |
| 直接双击 `NovelMuse.exe` | `%APPDATA%\NovelMuse` | 走 D7.2 播种（≈12 s） | ❌ |

两种模式数据**互相独立**，`使用说明.txt` 已显式提示不要混用。

**迁移旧书稿**：把旧的 `%APPDATA%\NovelMuse\data` 整个目录覆盖到
`<解压目录>\portable-data\data` 即可（先关程序）。

**代价**：zip 由 199.7 MB 增至 217.3 MB（+17.6 MB 压缩增量；解压后磁盘多 93.4 MB）。
换来的是便携模式首启 12.4 s → 4.1 s，且用户目录不再多一份 76 MB。

**验收实测（2026-10-08）**：产物 `release/desktop/砚舟-Portable-0.2.0-x64.zip`，
**227893452 B（217.34 MB）**，SHA256 `78b15b81ef432a068452710cb1a93f5b24535563a3792013821ef5e002edb0c5`，
12466 条目。解压到 `D:\Temp\nm-f` 后双击启动器：
- `userData=D:\Temp\nm-f\砚舟\portable-data`；
- `布局：seeded=false，reseeded=false，appServerPresent=true`；
- `就绪探针通过：status=ok，database=connected，hostMode=all，plugins=27`，**4.1 s**；
- `%APPDATA%\NovelMuse` 的 `app-runtime\version.json` 与 `data\novelmuse.db`
  **mtime 零变化** ⇒ 确实没写系统用户目录；
- 新实例自建**独立**书稿库（`portable-data\data\novelmuse.db`）；
- 覆盖旧 `data` 后重启，原书稿库（2 个项目）正常列出；
- 关窗优雅退出（stdin 协议关停 server，exitCode=0），无残留进程。

**`使用说明.txt` 顺带修正**：原写「默认管理员账号 admin / Admin1234!」与实现不符 ——
服务端早已移除固定默认口令（`apps/server/src/index.ts:65-88`；ADR D6.2 保留
「随机初始密码 + 用户自行修改」的安全语义）。现改为「密码首启随机生成，
弹一次性对话框并写入 `logs\initial-admin-password.txt`」。**旧文案属既有缺陷，
本次一并修正。**

---

## D5 · 端口握手与就绪判定 —— **已冻结**

### D5.1 唯一决策：零改动，从 **stderr** 正则取端口

```
stderr 行正则：  ^\[Server\] Cordis 基座已就绪 → http://localhost:(\d+)$
```

- 前缀字面量 `[Server] Cordis 基座已就绪 → http://localhost:` 来自 `apps/server/src/plugin/host.ts:996`，**逐字**。
- 该行由 **`console.warn`** 输出 ⇒ 走 **stderr**（F4）。**「console.warn 走 stderr」本身是本 ADR 的冻结事实**，实现任务不得改为解析 stdout。
- 实测样本：`D:\Temp\nm-adr-probe\err4.txt` 末行 `[Server] Cordis 基座已就绪 → http://localhost:58764`；junction 就位后 `eA2.txt` → `…:56247`、`eP2.txt` → `…:64517`。
- stderr 首行固定为 `[Server] HOST_MODE=<mode>`（实测），可一并捕获用于日志。

**为什么不改 `index.ts:178`**：`host.ts:997` 确实 `return { port: port2, url };`（F5），但调用点 `apps/server/src/index.ts:178` 丢弃了返回值。改它可以拿到结构化端口，但需要改动 server 源码；本 ADR 冻结**零改动**方案以降低耦合面。**备选通路（不在本次冻结范围）**：t3 若判断需要结构化握手，须回到 captain 开修订，届时冻结 `index.ts:178` 改为 `const { port: actualPort, url } = await serverPluginHost.start({...});` 并新增 `process.stdout.write('NOVELMUSE_READY ' + JSON.stringify({port: actualPort, url}) + '\n')`。

### D5.2 端口取值 —— **已冻结**

| 项 | 冻结值 | 依据 |
|---|---|---|
| `PORT` | **`0`**（OS 自动分配） | `apps/server/src/index.ts:21-22` 注释显式标注 `PORT=0` 为「Electron 桌面端场景」；避免用户机上 3774 被占用 |
| `HOST` | **`127.0.0.1`** | `apps/server/src/index.ts:177`：非 `0.0.0.0` 一律回落到 `127.0.0.1` ⇒ 只监听回环，不对外暴露 |
| 渲染进程访问地址 | `http://127.0.0.1:<port>/` | 必须同源（F33 `connect-src 'self'`；F34 默认 `'/api'`） |
| 窗口 URL | `http://127.0.0.1:<port>/`（打包态） | F32 root-absolute 资源引用要求从源根 `/` 提供 |

`PORT=0` 与 `index.ts:189-192` 的守卫相容：`if (!started && port === 0) process.exit(1);`（PORT=0 时不可能端口冲突，失败即基座起不来）。

### D5.3 超时与失败判定 —— **已冻结**

| 阶段 | 超时 | 失败判定 | 失败动作 |
|---|---|---|---|
| 端口握手（stderr 正则匹配） | **15000 ms** | 超时未匹配到正则 | 弹错误对话框（含 stderr 末 2000 字符），`app.exit(1)` |
| 就绪探针 `GET /api/health` | **30 次 × 500 ms = 15000 ms** | 超时或非 200 | 同上 |
| 子进程早期退出 | 握手期间收到 `exit` | `exitCode !== 0` 或 `signalCode !== null` | 同上，并在对话框中标注 exitCode/signalCode |
| 总启动预算 | **30000 ms** | 超出 | 同上 |

### D5.4 就绪判据（JSON 字段名冻结）

`GET /api/health`（`apps/server/src/plugin/host.ts:697-714`）返回 JSON，**冻结字段名**：

```json
{ "status": "ok" | "degraded",
  "database": "connected" | "unavailable",
  "pluginStandard": "1.0.0",
  "hostMode": "all",
  "plugins": [ { "id": "novel.auth", "status": "…", "modes": ["shared"], "error": null } ],
  "timestamp": 0 }
```

**就绪判定（冻结，逐字）**：`status === 'ok' && database === 'connected'` ⇒ 视为就绪，创建窗口。
`status === 'degraded'`（即 `database === 'unavailable'`）⇒ **仍然创建窗口**，但主进程必须在 `<userData>/logs/` 落一条 `WARN database unavailable`，并在 D8.4 的引擎如实记录里登记实际生效引擎。

---

## D6 · 环境变量契约 —— **已冻结**

下表是主进程注入子进程的**完整**环境变量集合。**未列出的变量一律不注入**（子进程继承 `process.env` 的其余部分，但下列键必须显式设定或显式删除）。

| 变量名 | 值来源 | 存储位置 | 权限 | 用户可见 |
|---|---|---|---|---|
| `NODE_ENV` | 打包期常量：打包态 `'production'`；开发态 `'development'` | 无 | — | 否 |
| `PORT` | 常量 `'0'` | 无 | — | 否 |
| `HOST` | 常量 `'127.0.0.1'` | 无 | — | 否 |
| `WEB_DIST_PATH` | 运行时计算：`<userData>/app-runtime/web-dist` | 无 | 目录可读 | 否 |
| `DB_PATH` | 运行时计算：`<userData>/data/novelmuse.db` | `<userData>/data/novelmuse.db`（+ `-wal` / `-shm`） | 文件 `0o600` | 否 |
| `PLUGINS_ROOT` | 运行时计算：`<userData>/plugins` | 目录 | 目录可写 | **是**（设置→更新页显示 `插件目录`） |
| `ALLOW_REGISTRATION` | 打包期常量：打包态 `'true'`；开发态 **不处置**（既不注入也不剔除，沿用宿主环境） | 无 | — | **是**（登录页是否显示并可用「注册」入口） |
| `JWT_SECRET` | **首启生成**：`crypto.randomBytes(32).toString('hex')`（64 个十六进制字符），之后读取复用 | `<userData>/data/.jwt-secret` | 文件 `0o600` | 否 |
| `ADMIN_USERNAME` | **不注入**（server 默认 `'admin'`） | DB `users` 表 | — | 是（登录页） |
| `ADMIN_PASSWORD` | **不注入**（server 随机生成，`index.ts:68` `randomBytes(16).toString('base64url')`） | DB + `<userData>/logs/initial-admin-password.txt` | 文件 `0o600` | **是**（仅首启对话框） |
| `DISABLE_PROXY_DETECT` | 常量 `'1'`（**只跳过「自动探测」，不影响 `HTTPS_PROXY` 等环境变量**，见 D6.3） | 无 | — | 否 |
| `HOST_MODE` | 常量 `'all'` | 无 | — | 是（`/api/health.hostMode`） |
| `ELECTRON_RUN_AS_NODE` | 常量 `'1'`（**必须显式设置**，使 `process.execPath` 以 Node 身份运行 tsx） | 无 | — | 否 |
| `JWT_EXPIRES_IN` | **不注入**（server 默认 `'3h'`） | 无 | — | 否 |
| `COOKIE_SECURE` | **不注入**（本机 HTTP ⇒ 必须保持未设/false） | 无 | — | 否 |
| `NOVELMUSE_DB_ENGINE` | **不注入**（默认走 better-sqlite3，失败自动回退 sql.js） | 无 | — | 是（启动日志 `[DB] …`） |
| AI 供应商变量（`AI_PROVIDER` / `OPENAI_*` / `OLLAMA_*` / `CUSTOM_AI_*`） | **不注入**（由用户在应用内配置，落 DB） | DB | — | 是 |
| `AI_SSRF_*` | **不注入**（沿用代码默认） | 无 | — | 否 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` / `no_proxy` | **继承宿主**；宿主没有时由主进程 `resolveProxy()` 解析系统代理后注入（见 D6.3） | 无 | — | 否 |

### D6.1 为什么 `JWT_SECRET` 必须注入（**关键**）

两条实测事实叠加：
- F9：`NODE_ENV === 'production'` 且未设 `JWT_SECRET` ⇒ `apps/server/src/index.ts:37-40` 打印 `[Server] ❌ 生产环境必须设置 JWT_SECRET 环境变量（生成方式：openssl rand -hex 32）。已拒绝启动。` 并 `process.exit(1)`。
- F10：`apps/server/src/lib/jwt.ts:63-64`：先看 `process.env.JWT_SECRET`；**再判 `NODE_ENV === 'production'` 直接 `return undefined`** ⇒ 生产环境下 `jwt.ts` **不会**走 `<root>/data/.jwt-secret` 文件回退（`jwt.ts:62-97`）。

⇒ 桌面端（`NODE_ENV=production`）**必须**由主进程生成并持久化密钥后以环境变量注入。存储位置冻结为 `<userData>/data/.jwt-secret`（与 `DB_PATH` 同目录，符合 `jwt.ts:67-70` 的候选目录语义），权限 `0o600`。

**副作用（冻结记录）**：`jwt.ts:107-110` 的 token 吊销名单是**进程内内存**结构 ⇒ 子进程重启后所有已签发 token 失效，用户需重新登录。这是既有行为，桌面端不额外处理。

### D6.2 管理员初始密码的捕获（**冻结**）

子进程 **stderr** 在首次创建管理员时会打印一行（`apps/server/src/index.ts:88`）：

```
[Server] 🔑 管理员初始密码（仅本次启动显示，请立即登录后修改）: <password>
```

正则：`^\[Server\] 🔑 管理员初始密码（仅本次启动显示，请立即登录后修改）: (\S+)$`

主进程**必须**：
1. 捕获该行；
2. 写 `<userData>/logs/initial-admin-password.txt`（`0o600`，覆盖写）；
3. **仅当本次启动捕获到该行时**弹出一次性对话框展示密码，提示「登录后请立即修改」；
4. 未捕获到（非首启）则静默。

若 `ADMIN_PASSWORD` 被注入，server 改为每次启动同步密码（`index.ts:90-96`，日志 `[Server] 已按 ADMIN_PASSWORD 环境变量同步管理员密码（admin）`）⇒ 本 ADR **不注入**该变量，以保留「随机初始密码 + 用户自行修改」的安全语义。

### D6.3 宿主代理透传（**2026-10-09 决策，修正 D6 表 `HTTPS_PROXY` 行**）

**问题**（用户实测「设置 → AI 设置 → 测试连接」失败，报 `连接被重置：目标服务强制断开了连接（未配置代理，可能被防火墙拦截，请启动代理软件或设置 HTTPS_PROXY 环境变量）`，而本机 Clash 正在 `127.0.0.1:7897` 监听）：
`apps/server/src/lib/proxy-agent.ts` 的 `initProxy()` 把 `DISABLE_PROXY_DETECT === '1'` 的**早退放在读环境变量之前** ⇒ 桌面端（D6 表恒注入 `DISABLE_PROXY_DETECT='1'`）即使继承了 `HTTPS_PROXY` 也会被整段丢弃，所有出站 AI 请求走直连。「禁用自动探测」被误实现成了「禁用代理」。

**决策（三档优先级，冻结）**：
1. **环境变量**（`HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`）—— 最高优先；
2. **自动探测** —— 仅当 ① 为空且**未**注入 `DISABLE_PROXY_DETECT='1'` 时执行（桌面端恒跳过）；
3. **直连**。

即 `DISABLE_PROXY_DETECT` **只关 ②，不关 ①**。

**宿主代理的两条来源**（`apps/desktop/src/main.ts` → `resolveHostProxy()`，在 `startServer()` 前 `await`）：
- **A 环境变量继承**：宿主已有 `HTTPS_PROXY`/`HTTP_PROXY` ⇒ 不解析，直接让子进程继承（`buildServerEnv()` 以 `{...process.env}` 起底）；
- **B 系统代理解析**：宿主没有 ⇒ `session.defaultSession.resolveProxy('https://api.openai.com/')` → `parseChromiumProxy()` 解析 Chromium PAC 结果（接受 `PROXY` / `HTTP` / `HTTPS` 前缀；`SOCKS*` / `DIRECT` 跳过），命中则写 `HTTPS_PROXY` / `HTTP_PROXY`，并补默认 `NO_PROXY=localhost,127.0.0.1,::1`（**不覆盖**宿主已有值）。
解析不到或抛错 ⇒ 不注入、不阻断启动，落一条 INFO 日志。

**实测（2026-10-09，`win-unpacked\砚舟.exe` + 新建 `--user-data-dir`，两句均逐字来自日志）**：

| 场景 | `logs/main.log` | `logs/server.out.log` |
|---|---|---|
| A 宿主有 `HTTPS_PROXY=http://127.0.0.1:7897` | `宿主已有代理环境变量（HTTPS_PROXY/HTTP_PROXY）⇒ 子进程直接继承，不解析系统代理。` | `[Proxy] 已启用代理(来自环境变量): http://127.0.0.1:7897 (NO_PROXY: localhost,127.0.0.1,::1,[::1])` |
| B 宿主无代理变量 | `已从系统代理解析出可用代理：http://127.0.0.1:7897（resolveProxy="PROXY 127.0.0.1:7897"）`、`已把系统代理解析结果注入子进程（D6.3）：HTTPS_PROXY=http://127.0.0.1:7897，NO_PROXY=localhost,127.0.0.1,::1,[::1]` | 同上 |

**端到端（B 场景）**：经 `POST /api/ai/config` 把 `baseUrl` 改为 `https://api.openai.com/v1` 后调 `POST /api/ai/config/test` ⇒
`{"success":false,"data":{"connected":false,"error":"AI API 错误 403"}}` —— 请求**已穿过代理抵达上游**（403 = 无有效密钥），而不再是此前的网络层失败。
同一场景 `curl --proxy http://127.0.0.1:7897 https://api.openai.com/v1/models` 同样返回 403（代理本身可用）。

**如实记录的残留（非本 ADR 缺陷）**：内置公益线路 `https://new-api.dadfafwada.dpdns.org/v1` 在本机**不可达**，与代理无关 —— 直连 `curl` 报 `Could not resolve host`，经 Clash 报 `schannel: failed to receive handshake`。面板错误文案已相应区分「已走代理」与「未配置代理」两种情况。

---

## D7 · userData 与资源布局 —— **已冻结**

### D7.1 userData 布局

`<userData>` = `app.getPath('userData')`（Windows 上为 `%APPDATA%\NovelMuse`）。

```
<userData>/
├─ data/
│  ├─ novelmuse.db                  主库（better-sqlite3 WAL ⇒ 同目录另有 -wal / -shm）
│  ├─ .jwt-secret                   JWT 密钥（0o600）
│  └─ projects/                     项目库目录（每项目一个 <projectId>.db）
├─ plugins/                         运行期插件根（= PLUGINS_ROOT）
│  ├─ auto/  manual/  shared/  local/
│  └─ node_modules                  ★ 目录 junction → app-runtime/app-server/node_modules（见 D7.4）
├─ app-runtime/                     可写运行时（被 updater 替换的目标）
│  ├─ app-server/                   server 负载（Mode B）
│  │  ├─ apps/ packages/ node_modules/ pnpm-workspace.yaml
│  │  └─ data                       ★ 目录 junction → <userData>/data（见 D7.3）
│  ├─ web-dist/                     前端构建产物
│  └─ version.json                  { "appVersion": "0.1.0", "updatedAt": "<ISO8601>" }
├─ backups/<oldVersion>/            更新前自动备份
├─ updates/                         更新下载暂存与解压暂存
└─ logs/
   ├─ main.log                      主进程日志
   ├─ server.out.log / server.err.log
   └─ initial-admin-password.txt    （0o600）
```

### D7.2 首次启动播种（冻结）

若 `<userData>/app-runtime/version.json` 不存在（**或 D7.5 的重新播种条件成立**）：
1. 复制 `resources/app-server` → `<userData>/app-runtime/app-server`；
2. 复制 `resources/web-dist` → `<userData>/app-runtime/web-dist`；
3. 复制 `resources/seed-plugins/{auto,manual,shared}` → `<userData>/plugins/{auto,manual,shared}`（已存在则跳过，**不覆盖用户改动**）；
4. 创建 `<userData>/plugins/local`（当前磁盘上无此目录，scanner 容忍缺失，但 AI 插件工具会写入 `LOCAL_PLUGINS_DIR`）；
5. 建立 D7.3、D7.4 的 junction；
6. 写 `version.json`。

**为什么运行时副本放 userData 而不是直接用 `resources/`**：NSIS 安装到 `Program Files` 时 `resources/` 只读；`updaterApplyApp()`（「应用本体（后端 + 前端）」）要替换后端与前端，若直接写 `resources/` 就需要管理员权限。userData 方案零提权。

### D7.3 `app-runtime/app-server/data` → `<userData>/data`（**关键冻结**）

**问题**：`packages/db/src/project-db.ts` 的 `resolveProjectRoot()` 从 `_moduleDir` **向上**查找 `pnpm-workspace.yaml` 标记（`:79-87`），**全文无 `process.env`**（F12）⇒ 项目库恒落 `<marker root>/data/projects/`。在 Mode B 布局下 marker root = `<userData>/app-runtime/app-server`，项目库会落在被更新替换的目录里 ⇒ **应用更新会毁掉所有项目数据**。

**冻结解法**：在 `<userData>/app-runtime/app-server/data` 建立**目录 junction** → `<userData>/data`。于是：
- 主库默认路径（`packages/db/src/index.ts:53-61` `getDefaultDbPath()`）= `<userData>/data/novelmuse.db` ⇒ 与注入的 `DB_PATH` 一致；
- 项目库 = `<userData>/data/projects/*.db` ⇒ 持久、与 `app-runtime` 解耦；
- `jwt.ts:31-48` 的 `.jwt-secret` 兜底目录 = `<userData>/data` ⇒ 与 D6 冻结位置一致。

**硬规则（冻结，t5 必须遵守）**：更新切换 `app-runtime/app-server` 时**只能替换 `apps/`、`packages/`、`node_modules/`、`pnpm-workspace.yaml` 四项**，**绝不能删除或替换 `data` 条目**；若 `data` junction 丢失，每次启动必须重建。

### D7.4 `<userData>/plugins/node_modules` junction（冻结）

F13 实测：`<PLUGINS_ROOT>/node_modules` 缺失时，`novel.bookscan` 与 `novel.typography` 被隔离（`Cannot find package 'hono'`），宿主仍能起但功能缺失。

**冻结**：启动时确保 `<userData>/plugins/node_modules` 为**目录 junction** → `<userData>/app-runtime/app-server/node_modules`。

**实测注意（F20）**：`fs.symlinkSync(target, link, 'junction')` 在 Windows 可用，但 junction 的 `fs.lstatSync(link).isDirectory()` 返回 **false** ⇒ **存在性判断必须用 `fs.statSync` / `fs.existsSync`，禁止用 `lstat().isDirectory()`**。

### D7.5 重新播种 —— 版本或载荷指纹变更时（冻结）

D7.2 只判「`version.json` 是否存在」，于是**在同一个版本号下重新打包后，用户装的仍是旧前端/旧后端**：`version.json` 还在 ⇒ 闸门跳过 ⇒ `copyDirNoClobber` 又对一切已存在文件跳过 ⇒ 一个字节都不会更新。用户必须手工删掉 `<userData>/app-runtime` 才能看到新界面。D7.5 补上这一环。

**触发条件（`paths.ts` 的 `shouldReseed()`，三条互斥，按优先级）**：

| 原因 | 条件 | 场景 |
|---|---|---|
| `missing` | `version.json` 不存在 | 首次安装（= D7.2 原条件） |
| `shell-newer` | `isNewer(appVersion, version.json.appVersion)` | 装了更高版本号的安装包 |
| `payload-changed` | `version.json.appVersion === appVersion` **且** `version.json.buildId !== build-stamp.buildId` | **同版本号重新打包** |

**载荷指纹（`build-stamp.json`，冻结）**：打包脚本 `apps/desktop/scripts/build-server-payload.mjs` 在生成 `payload/app-server` 后追加一步，对 `app-server/`、`seed-plugins/`、`web-dist/` 三棵树的每个文件取 `<label>/<相对路径>|<字节数>`，**排序**后拼接做 `sha256`，取前 32 位十六进制作为 `buildId`，写 `<payload>/app-server/build-stamp.json`：

```json
{ "version": "<apps/desktop 的 version>", "buildId": "<32 位 hex>", "algorithm": "sha256(sorted \"<label>/<relpath>|<bytes>\" of app-server + seed-plugins + web-dist)" }
```

该文件**不含时间戳**（保持载荷生成器「确定性、幂等」的既有承诺），非隐藏文件名（避免 electron-builder 的 `extraResources` glob 漏掉 dotfile），随安装包与更新包一起分发。

**`payload-changed` 为什么限定「版本号相同」**：应用内更新器（D14.5）装好运行时后会写入它自己的 `appVersion`（可能**高于**外壳版本）。若不限定版本号，下次启动会看到「指纹不同」而把刚装好的运行时**回退**成安装包里的旧载荷。限定后，只有「版本号一致但指纹不同」才重新播种 —— 那必然是重新打包了安装包。

**重新播种必须先清空旧运行时（冻结）**：`copyDirNoClobber`（D7.2 步骤 1–3）对已存在文件一律跳过 ⇒ 不清空就一个文件都复制不进来。清理范围：`<userData>/plugins/node_modules` → `<userData>/app-runtime/app-server` → `<userData>/app-runtime/web-dist` → `<userData>/plugins/{auto,manual,shared}`（刷新插件代码；`plugins/local` 用户自装目录**不碰**），随后补建 `<userData>/app-runtime`。

**★ 数据安全（D7.3 红线的延伸，冻结）**：清理**只能逐条目 `lstat` 后判定**：
- 条目是链接（junction/symlink）⇒ 只 `unlink` 摘掉链接本身，**绝不递归进去**；
- 条目自身是链接 ⇒ **绝不 `readdir`**（那会列到目标的真实内容），直接摘链接；
- 真实目录 ⇒ 递归；真实文件 ⇒ `unlink`。

**禁止**对 `app-runtime/app-server` 使用 `fs.rmSync(dir, { recursive: true })` —— Node 的递归删除会**穿过 reparse point**，把 `data` junction 指向的 `<userData>/data`（用户全部书稿）删掉。

**两道自检（冻结）**：
- **前置** `isSafeToClearRuntime()`：若 `app-runtime/app-server/data` 是**真实非空目录**（D7.3 junction 从未建立成功的历史遗留，项目库就落在这里）⇒ **拒绝重新播种**并打 `error`，宁可让用户继续看旧界面也不销毁书稿。
- **后置**：清理结束后自证 `<userData>/data` 仍存在，否则打 `error` 并放弃。

**可观测**：`ensureLayout()` 的返回值新增 `reseeded: boolean`；启动日志行形如 `布局：seeded=…，reseeded=…，appServerPresent=…，appServerDir=…`。

**updater 侧（D14.5 步骤 8）**：更新器替换完载荷后，读更新包里的 `<appServerRoot>/build-stamp.json`，把 `buildId` 一并写进 `version.json`（缺失则维持两字段结构）。否则下次启动会被判成 `payload-changed` 而回退。

---

## D8 · better-sqlite3 ABI 重建 —— **已冻结**

### D8.1 事实
- 仓库内 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` = **1919488 B**，Node ABI **137**（F2）。
- Electron 44.5.1 运行时 ABI = **149**（F1）。
- 无 Electron 预编译包：`prebuild-install --runtime=electron --target=44.5.1` → HTTP 404，`No prebuilt binaries found`（F25）⇒ **必须从源码编译**。
- 未重建直接跑：`NODE_MODULE_VERSION 137 vs 149`，日志 `[Server] 数据库初始化失败，将以降级模式运行`（不阻断启动）。
- electron-builder 驱动 rebuild 后 `.node` → **1921024 B**，ABI 149（F26）。

### D8.2 冻结策略

| 项 | 冻结值 |
|---|---|
| 触发方式 | `better-sqlite3: 12.11.1` 声明在 `apps/desktop/package.json` 的 **`dependencies`**（非 devDependencies），让 electron-builder 自动驱动 `@electron/rebuild` |
| 重建参数 | `electronVersion=44.5.1`、`arch=x64`、`buildFromSource=false`（无预编译包 ⇒ node-gyp 源码编译） |
| 手工调用 `@electron/rebuild` | **禁止**（静默空转，见 D3.4） |
| asar 打包 | `asar: true`，`asarUnpack` 必须包含 `node_modules/better-sqlite3/**` 与 `node_modules/bindings/**`、`node_modules/file-uri-to-path/**`（见 D16.3 理由） |
| 重建后 `.node` 落点 | `resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` |
| server 侧解析 | 启动时确保 `<userData>/app-runtime/app-server/node_modules/better-sqlite3` 为**目录 junction** → `<resources>/app.asar.unpacked/node_modules/better-sqlite3` |

**为什么用 junction 而不是 `extraResources` 再拷一份**：`@electron/rebuild` 只在 asar 侧重建；用 junction 指向已重建的实体目录，避免出现「两份 better-sqlite3、其中一份 ABI 错误」的隐患。

**降级路径（冻结，若 junction 不可行）**：改用 `extraResources` 把 `node_modules/better-sqlite3` 复制到 `resources/app-server/node_modules/better-sqlite3`，并在 `files` 中排除 `!node_modules/**`；**但必须先实测 electron-builder 的 rebuild 是否发生在 `extraResources` 复制之前**（**需人工确认**）。若顺序不对，加 `afterPack` 钩子重编译。

### D8.3 失败降级行为（**冻结**）

| 场景 | 行为 |
|---|---|
| `.node` ABI 不匹配 / 加载失败 | `packages/db/src/index.ts:1351-1356` 捕获 ⇒ 日志 `[DB] better-sqlite3 引擎启用失败（需先安装 better-sqlite3），回退 sql.js：` ⇒ **自动回退 sql.js，不阻断启动** |
| 回退后引擎 | `sqljs`（内存库 + WASM） |
| **数据持久性差异（必须如实记录）** | sql.js 下数据库在**内存**中，只有显式 `saveToDisk()` 才落盘（`packages/db/src/index.ts:1371-1373`）。默认 `better-sqlite3` 为 WAL 增量写入 ⇒ **引擎不同，掉电/强杀的数据损失风险不同** |
| 上报要求 | t6 的 E2E 报告**必须**写明实际生效引擎（从 stdout 抓 `[DB] 已切换到 better-sqlite3 引擎（WAL 增量写入）` 或 `[DB] 使用 sql.js 引擎（NOVELMUSE_DB_ENGINE=sqljs）` 或回退告警），**不得只写「数据库正常」** |

### D8.4 开发环境复原（硬性操作纪律）
桌面打包会把仓库 `node_modules/better-sqlite3` 就地改成 ABI 149（F27）⇒ 打包后必须 `pnpm install`（或 `pnpm rebuild better-sqlite3`）恢复 ABI 137，否则 `pnpm dev` / `pnpm test` 全部失败。

---

## D9 · sql.js / `sql-wasm.wasm` 投递 —— **已冻结**

- `packages/db/src/index.ts:132-134`：`const sqlJsModule = await import('sql.js'); _sqlModule = await initSqlJs();` —— **无参数调用**。
- `node_modules/sql.js/dist/sql-wasm.js:163`：`Na ??= k.locateFile ? k.locateFile("sql-wasm.wasm", za) : za + "sql-wasm.wasm";`，其中 `za = __dirname + "/"` ⇒ 默认在 **sql.js 包自身 dist 目录**找 wasm。

**冻结**：`resources/app-server/node_modules/sql.js/dist/sql-wasm.wasm`（**659730 B**）必须存在。Mode B 下 `import('sql.js')` 命中该真实包，`locateFile` 默认路径即同目录 ⇒ **无需额外拷贝**。

**若 t4 改为把 sql.js 内联进 bundle（不推荐）**：实测会报 `ENOENT … open '<entrydir>/sql-wasm.wasm'` ⇒ 此时必须把 `sql-wasm.wasm` 复制到 **bundle 所在目录**同级。此为**需人工确认**项，仅在偏离 Mode B 时适用。

---

## D10 · 图标契约 —— **已冻结**

### D10.1 事实
- 仓库内**不存在任何 `.ico` / `.icns`**（F15）。
- 唯一可栅格化的位图候选：`apps/web/public/images/bamboo-ink.png`（1672×941 RGB，2876515 B，F16）。
- `apps/web/public/shuimo/logo.svg`（169472 B）**无法栅格化**：本机 `magick` 不存在，无 ImageMagick / cairosvg。
- Pillow **12.3.0** 可用：`C:\Users\1\AppData\Local\Programs\Python\Python312\python.exe`。
- 已实测产出：`icon.png` 512×512 RGBA **527794 B**；`icon.ico` 256×256 RGBA **190206 B**（F17）。

### D10.2 冻结值

| 项 | 冻结值 |
|---|---|
| 图标源 | `apps/web/public/images/bamboo-ink.png`（**唯一**源，不得引用不存在的文件） |
| 生成脚本 | `apps/desktop/scripts/gen-icon.py`（Python + Pillow） |
| 裁剪框 | `(365, 0, 1306, 941)` ⇒ 941×941 正方形（居中于墨竹主体） |
| PNG 目标 | `apps/desktop/build-resources/icon.png`，**512×512**，`Image.LANCZOS` 重采样，RGBA |
| ICO 目标 | `apps/desktop/build-resources/icon.ico`，`save(sizes=[(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)])`，RGBA |
| 尺寸下限 | **≥256×256**（NSIS 要求） |
| 参考体积 | icon.png ≈ 527794 B；icon.ico ≈ 190206 B |
| builder 引用 | `win.icon: "build-resources/icon.ico"`；`directories.buildResources: "build-resources"` |
| 入库 | `apps/desktop/build-resources/icon.{png,ico}` **必须提交**（该目录不被 `.gitignore` 忽略；**不得**放到 `build/`，见 D2 约束 3） |

**注意**：图标文件本身由 t4 产出并入库；本 ADR 只冻结路径、源、尺寸与生成方法。**不得**在本任务中创建这两个文件。

---

## D11 · `window.desktopAPI` 形状与 IPC 通道 —— **已冻结**

### D11.1 preload 契约（逐字对齐 `apps/web/src/types/desktop-api.d.ts`）

`apps/desktop/src/preload.ts` 通过 `contextBridge.exposeInMainWorld('desktopAPI', { … })` 注入的对象，**键名与返回结构必须与 `apps/web/src/types/desktop-api.d.ts:10-31` 逐字一致**（9 个方法，无多余键、无缺失键）：

| # | 方法名 | 签名（与 `.d.ts` 逐字一致） |
|---|---|---|
| 1 | `getVersion` | `() => Promise<string>` |
| 2 | `getDataPath` | `() => Promise<string>` |
| 3 | `relaunch` | `() => Promise<void>` |
| 4 | `updaterGetState` | `() => Promise<{ appVersion: string; baseUrl: string; pluginsDir: string; plugins: Array<{ id: string; version: string \| null; dir: string }>; }>` |
| 5 | `updaterSetBaseUrl` | `(baseUrl: string) => Promise<{ ok: boolean; baseUrl: string }>` |
| 6 | `updaterCheck` | `() => Promise<{ ok: boolean; manifest?: unknown; appOutdated?: boolean; pluginUpdates?: unknown[]; error?: string }>` |
| 7 | `updaterApplyApp` | `() => Promise<{ ok: boolean; version?: string; notes?: string; error?: string }>` |
| 8 | `updaterInstallPlugin` | `(pluginId: string) => Promise<{ ok: boolean; id?: string; version?: string; notes?: string; error?: string }>` |
| 9 | `updaterRelaunch` | `() => Promise<{ ok: boolean }>` |

**冻结约束**：
- 9 个方法**全部**走 `ipcRenderer.invoke`（请求/响应）。**不使用** `ipcRenderer.send` / `ipcRenderer.on`（避免为渲染进程引入事件订阅面）。
- 返回对象一律**可结构化克隆**：不得含 `Error` 实例、函数、`Buffer`、`Date`；失败一律以 `{ ok: false, error: string }` 形式返回，**不得 reject**（`UpdateSection.tsx:53-66` 直接读 `r.ok` / `r.error`）。
- `window.desktopAPI` **只在 Electron 下存在**；浏览器 dev 下 `UpdateSection.tsx:35` 的 `!!window.desktopAPI?.updaterGetState` 判定必须为 false（不注入任何 polyfill）。

### D11.2 IPC 通道名（**字符串字面量，本次冻结**）

通道名唯一真源 = `apps/desktop/src/ipc-channels.ts`，主进程与 preload **共用同一常量**。

| 通道名字面量 | 对应方法 |
|---|---|
| `novelmuse:app:get-version` | `getVersion` |
| `novelmuse:app:get-data-path` | `getDataPath` |
| `novelmuse:app:relaunch` | `relaunch` |
| `novelmuse:updater:get-state` | `updaterGetState` |
| `novelmuse:updater:set-base-url` | `updaterSetBaseUrl` |
| `novelmuse:updater:check` | `updaterCheck` |
| `novelmuse:updater:apply-app` | `updaterApplyApp` |
| `novelmuse:updater:install-plugin` | `updaterInstallPlugin` |
| `novelmuse:updater:relaunch` | `updaterRelaunch` |

**冻结**：**恰好这 9 条**。新增任何通道必须回到 captain 开 ADR 修订。主进程侧必须 `ipcMain.handle(channel, …)` 逐条注册；未注册的通道调用必须被 preload 侧拒绝。

### D11.3 `webPreferences`（冻结）

```ts
webPreferences: {
  preload: <abs path to dist/preload.cjs>,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,          // 实测可用的组合
  webSecurity: true,
}
```

实测佐证：`main.cjs` 1460 B / `preload.cjs` 209 B 的 esbuild CJS 打包形态，在 `contextIsolation: true, sandbox: false` 下 `ipcRenderer.invoke` 往返成功（探针返回 `{"isPackaged":true,"keys":"ping","pong":"pong"}`）。

---

## D12 · 生命周期契约 —— **已冻结**

### D12.1 单实例
- `app.requestSingleInstanceLock()`；未取得锁 ⇒ 立即 `app.quit()`。
- 已取得锁的实例监听 `second-instance` ⇒ 若窗口最小化则 `restore()`，然后 `focus()`。**不**创建第二个窗口、**不**重启 server 子进程。

### D12.2 主窗口（冻结尺寸）
| 项 | 冻结值 |
|---|---|
| 初始尺寸 | `width: 1440, height: 900` |
| 最小尺寸 | `minWidth: 1024, minHeight: 640` |
| 显示时机 | `show: false` + `once('ready-to-show', () => win.show())`（避免白屏） |
| 菜单 | `autoHideMenuBar: true`（Windows 上隐藏默认菜单栏） |
| 外链 | `setWindowOpenHandler` 一律 `{ action: 'deny' }`，改用 `shell.openExternal(url)`（仅允许 `https:` / `http:`） |
| 同源 | 只允许导航到 `http://127.0.0.1:<port>` 与（开发态）`http://localhost:5173`；其他一律 `will-navigate` 拦截 |

### D12.3 启动顺序（冻结）
1. `app.requestSingleInstanceLock()`
2. `app.whenReady()`
3. `paths.ts`：解析 userData 布局；若 `version.json` 缺失（或 D7.5 的 `shell-newer` / `payload-changed` 成立）则执行 D7.2 播种（D7.5 时先清空旧运行时）
4. 建立 D7.3 / D7.4 junction
5. `env.ts`：装配 D6 环境变量（含生成/读取 `JWT_SECRET`）
6. `server-process.ts`：spawn 子进程 → stderr 握手（D5.1）→ `GET /api/health` 就绪探针（D5.4）
7. `window.ts`：创建窗口并 `loadURL('http://127.0.0.1:<port>/')`
8. 注册 `before-quit` / `window-all-closed` 的优雅退出路径（D13）

### D12.4 崩溃重启（冻结）
- 监听子进程 `exit` 事件（**不能**依赖 server 自己退出：`apps/server/src/index.ts:235-244` 的 `handleFatal` 明确**不退出进程**，注释说明「dev 模式 tsx watch 依赖进程存活」）。
- 策略：**60 秒窗口内最多重启 3 次**；每次重启前重置握手状态。
- 超过 3 次 ⇒ 弹错误对话框（含 stderr 末尾），`app.exit(1)`。
- 主进程自身 `uncaughtException` ⇒ 记日志到 `<userData>/logs/main.log`，**不静默退出**。

### D12.5 开发态 vs 打包态差异（冻结）
| 维度 | 开发态（`!app.isPackaged`） | 打包态 |
|---|---|---|
| 前端来源 | `http://localhost:5173`（vite dev server） | `http://127.0.0.1:<port>/`（server 静态回退） |
| `NODE_ENV` | `development` | `production` |
| server 来源 | 仓库 `apps/server/src/index.ts`（cwd = 仓库根） | `<userData>/app-runtime/app-server/apps/server/src/index.ts` |
| `DB_PATH` | 仓库 `data/novelmuse.db` | `<userData>/data/novelmuse.db` |
| `PLUGINS_ROOT` | **不注入**（走 `local-scanner.ts:77-81` 的 `<repo>/apps/plugins` 默认） | `<userData>/plugins` |
| `WEB_DIST_PATH` | **不注入**（distIndex 为 undefined，不注册静态回退） | `<userData>/app-runtime/web-dist` |
| `JWT_SECRET` | 不注入（dev 下 `jwt.ts` 走文件回退 `<repo>/data/.jwt-secret`） | 注入 |
| `ALLOW_REGISTRATION` | **不处置**（既不注入也不剔除，沿用宿主环境；未设时 `NODE_ENV !== 'production'` 已使注册开放） | 注入 `'true'`（否则打包态 `NODE_ENV='production'` 使注册默认关闭，与网页版行为不一致） |
| `ELECTRON_RUN_AS_NODE` | 同打包态 | `'1'` |

**注意（实测教训，冻结为纪律）**：本机 harness 全局设置了 `ELECTRON_RUN_AS_NODE=1`。**任何启动 GUI 的测试必须先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**，否则 `app.isPackaged` 流程不会启动、进程以 ExitCode=0 静默退出（探针中曾误判为「打包产物无法启动」）。

---

## D13 · 优雅退出与 stdin 控制通道 —— **已冻结（含必须的上游最小改动）**

### D13.1 决定性证伪（F7）
`D:\Temp\sig-probe` 实测：父进程 `spawn(process.execPath, [child.cjs], {stdio:['pipe','pipe','pipe']})`，800 ms 后 `child.kill('SIGTERM')`：

```
kill(SIGTERM) returned: true
exitCode: null   signalCode: SIGTERM
sigterm.txt exists: false
sigint.txt exists: false
```

子进程已注册 `process.on('SIGTERM', …)` 写文件，**未触发**。

⇒ **Windows 上 Node 的 `child.kill('SIGTERM')` / `kill('SIGINT')` 走 `TerminateProcess`，子进程的信号处理器根本不会执行。**
⇒ **`apps/server/src/index.ts:246-249` 的 `SIGINT`/`SIGTERM` → `closeGracefully` 通道在 Windows 桌面端完全不可用。**
⇒ 本 ADR **明确否决**把 SIGTERM 当作优雅退出通道。任何实现任务不得以 `child.kill('SIGTERM')` 作为优雅关闭手段。

### D13.2 stdin 通道缺口（F8）
`apps/server/src` 全目录 grep `process\.stdin|stdin` = **0 命中** ⇒ server 当前**没有任何**可用作优雅关闭的 stdin 通道。

### D13.3 冻结方案：stdin 控制通道（**t3 必须实施的上游最小改动**）

| 项 | 冻结值 |
|---|---|
| 改动文件 | `apps/server/src/index.ts`（**唯一**允许改动的 server 文件） |
| 协议 | 父进程向子进程 **stdin** 写入**一行**：`novelmuse:shutdown\n` |
| 子进程行为 | 用 `readline`（或 `process.stdin.on('data')` 按行切分）监听；收到该行 ⇒ 调用**既有** `closeGracefully('stdin')` |
| 不可改动 | `closeGracefully` 的既有实现与语义（`index.ts:209-233`）：`serverPluginHost.dispose()` → `Promise.race([closeAllProjectDbs(), 3000ms])` → `Promise.race([closeDatabase(), 3000ms])` → `process.exit(0)` |
| 不可改动 | `SIGINT`/`SIGTERM` 的既有注册（保留，供非 Windows 场景） |
| 触发来源 | 主进程在 `before-quit` / 窗口关闭 / `updaterRelaunch` 前调用 |
| 子进程 stdin | 必须以 `stdio: ['pipe', 'pipe', 'pipe']` 启动（stdin 必须是管道） |

**为什么必须**：sql.js 回退引擎下数据库仅在内存，**只有** `closeDatabase()` 才落盘（D8.3）⇒ 若只能强杀，sql.js 引擎下会**丢数据**。

**升级路径（若 t3 被判定不得改动 `apps/server/src/index.ts`）**：本 ADR 不提供等价零改动方案——只能退化为 ①强制 `NOVELMUSE_DB_ENGINE=better-sqlite3`（WAL，落盘及时）+ ②接受 sql.js 回退时强杀的数据损失风险 + ③在报告里显式登记该风险。**该退化路径为「需人工确认」，且必须由 captain 批准。**

### D13.4 退出时序（冻结）

```
① 主进程写 stdin: "novelmuse:shutdown\n"
② 等待子进程 'exit'，上限 5000 ms
③ 若超时 ⇒ 强杀：taskkill /PID <childPid> /T /F
④ app.exit(0)
```

`/T` 必须保留（连同子树一起结束）。

---

## D14 · updater 契约 —— **已冻结**

### D14.1 更新源语义
- `baseUrl` 语义（逐字来自 `UpdateSection.tsx:174` 标签）：**`更新源地址（manifest.json 所在目录 URL）`** ⇒ 清单地址 = `${baseUrl}/manifest.json`。
- `baseUrl` 为空字符串 ⇒ **更新功能关闭**（`UpdateSection.tsx:75` 提示 `更新源已保存: （空，更新已关闭）`）。
- 默认值：首启 `''`（关闭）。
- 持久化位置：`<userData>/updates/config.json`，`{ "baseUrl": "…" }`。**不是** `localStorage`（主进程需要在渲染进程未起时也能读）。
- placeholder 参考值 `https://example.com/novelmuse-updates`（`UpdateSection.tsx:180`）。

### D14.2 `manifest.json` 字段（**冻结**）

```json
{
  "version": "0.2.0",
  "notes": "本次更新说明（可选）",
  "publishedAt": "2026-10-02T00:00:00Z",
  "app": { "url": "novelmuse-app-0.2.0.zip", "sha256": "<64 位小写十六进制>" },
  "plugins": [
    { "id": "novel.bookscan", "name": "拆书", "version": "0.1.1",
      "url": "novel.bookscan-0.1.1.zip", "sha256": "<64 位小写十六进制>",
      "notes": "可选" }
  ]
}
```

**字段名冻结理由**：
- `plugins[]` 的 `{ id, name, version, url, sha256, notes? }` 必须与 `UpdateSection.tsx:18-25` 的 `PluginUpdateInfo` **逐字一致**（UI 直接读这 6 个字段）。
- `updaterCheck()` 返回 `{ ok, manifest?, appOutdated?, pluginUpdates?, error? }`，其中 `pluginUpdates` 为 `plugins[]` 的子集（仅版本高于本地的项）。
- `appOutdated = compareVersions(manifest.version, appVersion) > 0`（语义化版本比较，纯数字段比较；预发布后缀按字符串比较，**需人工确认**是否够用）。
- `url` 允许为**相对路径**（相对 `baseUrl` 解析）或绝对 `http(s):` URL。
- 更新源必须是 `http:` 或 `https:`；其他协议拒绝。

### D14.3 安全要求（冻结，逐字来自 `UpdateSection.tsx:258` 的既有承诺）

`UpdateSection.tsx:258` 逐字写着：`生成的 release/updates/ 目录即为更新源。安全：下载后校验 SHA-256，解压防路径穿越，旧版本自动备份。` 本 ADR 把这三条升级为**强制验收项**：

| # | 要求 | 冻结实现要点 |
|---|---|---|
| 1 | **下载后校验 SHA-256** | 下载完成 → `crypto.createHash('sha256')` 流式计算 → 与 `manifest.json` 的 `sha256` **小写十六进制**比较；不一致 ⇒ 删除临时文件、返回 `{ ok: false, error: 'SHA-256 校验失败' }`。**校验失败绝不进入解压** |
| 2 | **解压防路径穿越** | 逐个 entry 规范化：`path.resolve(destRoot, entryName)` 必须 `startsWith(destRoot + path.sep)`；否则整包拒绝并清理。同时拒绝：绝对路径、含 `..` 的段、Windows 保留名、符号链接/硬链接 entry |
| 3 | **旧版本自动备份** | 替换 `app-runtime/app-server` 或 `web-dist` 前，先把旧目录整体复制到 `<userData>/backups/<oldVersion>/`；备份失败 ⇒ **中止更新**，返回 `{ ok: false, error: '备份失败' }` |

补充冻结：`url` 只允许 `http:` / `https:`；单文件下载上限 **512 MB**；下载超时 **120 s**。

### D14.4 updater 状态与路径（冻结）

| 项 | 冻结值 |
|---|---|
| 更新源配置 | `<userData>/updates/config.json` = `{ "baseUrl": "<string>" }` |
| 下载暂存 | `<userData>/updates/downloads/<sha256>.zip` |
| 解压暂存 | `<userData>/updates/extract/<sha256>/` |
| 备份根 | `<userData>/backups/<oldVersion>/` |
| 版本记录 | `<userData>/app-runtime/version.json` = `{ "appVersion": "0.1.0", "updatedAt": "<ISO8601>" }` |
| `updaterGetState().appVersion` | 当前生效版本，取自 `version.json`（缺失则回落 `app.getVersion()`） |
| `updaterGetState().pluginsDir` | `<userData>/plugins`（与 `PLUGINS_ROOT` 同源；UI 直接展示该字符串） |
| `updaterGetState().plugins[]` | 扫描 `<userData>/plugins/{auto,manual,shared,local}/*/plugin.json`，每项 `{ id, version: string \| null, dir }`；无 `plugin.json` ⇒ `version: null` |

### D14.5 应用更新切换流程（冻结）

```
① updaterCheck() → appOutdated?
② updaterApplyApp() ：
   a. 下载 manifest.app.url → updates/downloads/<sha>.zip
   b. SHA-256 校验（D14.3-1）
   c. 备份 <userData>/app-runtime/{app-server,web-dist} → backups/<oldVersion>/
   d. 安全解压到 updates/extract/<sha>/
   e. 替换 app-runtime/app-server 的 apps/ packages/ node_modules/ pnpm-workspace.yaml 四项
      ★ 绝不动 data 条目（D7.3）
      ★ 绝不动 plugins/（插件是独立更新单元）
   f. 替换 app-runtime/web-dist
   g. 重建 D7.3 / D7.4 junction
   h. 更新 version.json（含从更新包 build-stamp.json 取来的 buildId，见 D7.5）
   i. 返回 { ok: true, version, notes }
③ 渲染进程 UpdateSection.tsx:77-95 收到 ok ⇒ 显示 "✅ 应用已更新到 v…，即将重启..." ⇒ 1200 ms 后调用 updaterRelaunch()
④ updaterRelaunch() ⇒ 优雅关闭子进程（D13.4）⇒ app.relaunch() + app.exit(0)
```

插件更新（`updaterInstallPlugin`）只替换 `<userData>/plugins/<mode>/<pluginId>/`，**不重启后端**；返回 ok 后 `UpdateSection.tsx:97-115` 提示「重启应用后生效（插件重新扫描加载）」。

---

## D15 · 打包与验证命令 —— **已冻结**

| 用途 | 命令（在 `F:\new1.2` 执行） |
|---|---|
| 构建前端 | `pnpm --filter @novel/web build` |
| 生成图标 | `python apps/desktop/scripts/gen-icon.py` |
| 生成 server 负载 | `node apps/desktop/scripts/build-server-payload.mjs` |
| 打包壳代码 | `node apps/desktop/scripts/bundle-shell.mjs` |
| 快速冒烟打包（不产安装包） | `apps\desktop\node_modules\.bin\electron-builder.cmd --win dir --x64` |
| 正式打包（安装版） | `apps\desktop\node_modules\.bin\electron-builder.cmd --win nsis --x64` |
| 打包便携版 zip（一步到位） | `pnpm -C apps/desktop dist:zip`（= 负载 → 壳 → `--dir` → 压 zip，见 D4.4） |
| ~~打包单文件便携 exe~~ | ~~`pnpm -C apps/desktop dist:portable`~~ **已于 D4.6 移除该脚本与 target** |
| 发布工具 | `node apps/desktop/scripts/build-update.mjs` |
| 打包后恢复开发环境 | `pnpm install`（D8.4 硬性纪律） |

**冻结**：`--win dir --x64` 为**冒烟首选**（快、无需 NSIS）；正式出包只有两种：`nsis`（安装版）与 `pnpm -C apps/desktop dist:zip`（便携版 zip，D4.4）。单文件便携 exe 已于 **D4.6** 移除。

---

## D16 · electron-builder 配置块 —— **已冻结（逐字）**

### D16.1 位置与形态
`build` 块**内嵌在 `apps/desktop/package.json`**（**非**独立 `electron-builder.yml`）。此形态已实测跑通（F21：`D:\Temp\eb-probe\out2\win-unpacked\EbProbe.exe` 存在）。

### D16.2 配置块（冻结，逐字）

> **2026-10-06 更新（D4.6）**：下方配置块为**当前实仓逐字**内容 —— `win.target` 只剩 `nsis`，`portable` 段已随 **D4.6** 移除（D4.4 曾移除、D4.5 曾恢复、D4.6 再次移除且为终态）。其余 D4.4 起的改动仍有效：`files` 去掉 `!node_modules/**/*`（R7 已实测：该排除会连带压掉 `asarUnpack` 需要的实体，去掉后 electron-builder 按 `asarUnpack` 自行拆分）；`extraResources` 补回 `payload/app-server/node_modules` 一条（D4.2 显式投递 node_modules，不能只靠 `from: payload/app-server` 隐式带出）。

```jsonc
{
  "name": "@novel/desktop",
  "version": "0.2.0",
  "private": true,
  "description": "砚舟 桌面端（Electron 主进程 + 内嵌 server 子进程）",
  "author": "砚舟",
  "main": "dist/main.cjs",
  "dependencies": {
    "better-sqlite3": "12.11.1",
    "yauzl": "^3.4.0"
  },
  "devDependencies": {
    "electron": "44.5.1",
    "electron-builder": "26.15.3",
    "esbuild": "^0.28.2",
    "typescript": "^5.7.0"
  },
  "build": {
    "appId": "com.novelmuse.desktop",
    "productName": "砚舟",
    "copyright": "Copyright © 2026 砚舟",
    "directories": {
      "output": "../../release/desktop",
      "buildResources": "build-resources"
    },
    "files": [
      "dist/**/*",
      "package.json"
    ],
    "asar": true,
    "asarUnpack": [
      "node_modules/better-sqlite3/**/*",
      "node_modules/bindings/**/*",
      "node_modules/file-uri-to-path/**/*"
    ],
    "extraResources": [
      { "from": "payload/app-server", "to": "app-server" },
      { "from": "payload/app-server/node_modules", "to": "app-server/node_modules" },
      { "from": "../../apps/web/dist", "to": "web-dist" },
      { "from": "payload/seed-plugins", "to": "seed-plugins" }
    ],
    "win": {
      "target": [
        { "target": "nsis", "arch": ["x64"] }
      ],
      "icon": "build-resources/icon.ico",
      "artifactName": "砚舟-${version}-${arch}.${ext}"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "听风细雨",
      "artifactName": "砚舟-Setup-${version}-${arch}.${ext}",
      "deleteAppDataOnUninstall": false
    }
  }
}
```

**关于 `artifactName`**：`win.artifactName` 与 `nsis.artifactName` 存在覆盖关系。若实测两者冲突，**以 `nsis.artifactName` 为准**（它更具体）；`win.artifactName` 为兜底。

**关于 `files` 里的 `!node_modules/**/*`（R7 已闭环）**：**已去掉**。该排除会连带压掉 `asarUnpack` 需要的实体；去掉后 electron-builder 按 `asarUnpack` 自行拆分，实测 `app.asar.unpacked` 含 `better-sqlite3` 实体（`better_sqlite3.node` = 1921024 B，ADR F26 期望值 ✓）。

**关于便携版 `portable.splashImage`（D4.4 曾废弃 → D4.5 恢复 → **D4.6 再次废弃，终态**）**：`portable` target 已于 D4.6 移除，故 `splashImage` / `build-resources/splash.bmp` **不再被任何构建引用**。该文件（640×400 24-bit BMP / 768054 B，由 `python apps/desktop/scripts/gen-splash.py` 生成）与 `gen-splash.py` **保留在仓库**（不再参与打包，删除与否不影响构建）。D4.5-1 中「未配 `splashImage` 会走 `SetSilent silent` ⇒ 首启全程无窗口」的论述随之失效——**因为该形态本身已不存在**。

**关于 `portable` 的冒烟纪律**：见 D4.5-1。D4.6 移除 exe 形态后，纪律 1/2（把产物搬到 Medium IL 位置）**仅对 `win-unpacked\砚舟.exe` 仍有意义**。

### D16.3 为什么 `asarUnpack` 必须含 `bindings` 与 `file-uri-to-path`
`better-sqlite3` 通过 `bindings` 包定位 `.node` 文件，`bindings` 又依赖 `file-uri-to-path`。asar 内动态 `require` 裸说明符实测失败（探针 `Cannot find module 'bindings'`）⇒ 三者必须一起解包。同时 `**/*.node` 本身必须解包（原生模块无法从 asar 内 `dlopen`）。

### D16.4 不做的配置项（冻结）
- **不做** `electron-winstaller` / Squirrel.Windows（D1 已排除）⇒ `pnpm-workspace.yaml` 的 `allowBuilds` **无需**新增该键。
- **不做** 代码签名（`win.certificateFile` 等）：无证书；未签名安装包会触发 SmartScreen 提示，**如实记录在 t8 报告**。
- **不做** 自动更新框架（`electron-updater`）：更新逻辑由 `updater.ts` 自实现（D14），以匹配已冻结的 9 方法 `desktopAPI` 契约。
- **不做** `afterSign` / `notarize`（仅 Windows）。
- **不改** `pnpm-workspace.yaml` 的 `allowBuilds` / `onlyBuiltDependencies`（已含所需三项）。

---

## D17 · `build-update.mjs` 与 `release/updates/` 产物 —— **已冻结**

路径冻结为 `apps/desktop/scripts/build-update.mjs`（**逐字**来自 `UpdateSection.tsx:257` 的 `<code>node apps/desktop/scripts/build-update.mjs</code>`）。当前该文件不存在，`scripts/desktop/` 下只有 `desktop-control.py` 与 `mcp-desktop-server.py`。

### D17.1 输入
1. 已构建的 `apps/web/dist/`（F32：8393733 B / 47 文件）
2. 已生成的 `apps/desktop/payload/app-server/`
3. 已打包的 `release/desktop/win-unpacked/`（或由参数指定）
4. `apps/plugins/**/plugin.json`（5 个磁盘插件，全部 `0.1.0`）

### D17.2 输出（冻结）
```
release/updates/
├─ manifest.json                              ← 更新源清单（D14.2 字段）
├─ novelmuse-app-<version>.zip                ← 应用本体（后端 + 前端）
├─ novel.bookscan-<version>.zip
├─ novel.autowrite-<version>.zip
├─ novel.auto.workbench-<version>.zip
├─ novel.manual.workbench-<version>.zip
└─ novel.typography-<version>.zip
```

### D17.3 冻结要求
- `release/updates/` 已在 `.gitignore:28`（`/release/`）⇒ **不入库**。
- 每个 zip 的 `sha256` 必须是**小写十六进制**，写进 `manifest.json`（D14.2）。
- zip 内路径**必须相对包根**，不得含前导 `/` 或 `..`（与 D14.3-2 的校验互为正反）。
- `manifest.json` 的 `plugins[]` 必须含 **5** 个磁盘插件；**builtin 插件（`apps/server/src/plugin/builtin.ts` 的 21 条）不列入**（它们是 server 的一部分，随应用本体更新）。
- `@novel-plugins/worldbuilding` **不列入** `plugins[]`（它是 builtin，`builtin.ts:55-65`）⇒ 其更新随应用本体。
- 脚本**幂等**：重复运行覆盖同名产物，不残留旧版本 zip。

### D17.4 zip 库选择（冻结）
用 **`yauzl` ^3.4.0**（读取）——`updater.ts` 侧只需要**读** zip（解压下载的更新包），不需要写。`build-update.mjs` 侧**需要写** zip ⇒ 用 Node 24 **无内置 zip 写入**，因此打包侧允许使用 **`adm-zip`** 作为 `devDependency`，或调用系统 `Compress-Archive`。**冻结优先顺序**：① 优先 `adm-zip`（devDependency，跨平台确定性）；② 备选 `Compress-Archive`（无新依赖，但依赖 PowerShell）。**需人工确认** `adm-zip` 的实际解析版本。

**与「不得新增 dockview 之外的运行期依赖」的关系**：`yauzl` 是**桌面壳的**运行期依赖（`apps/desktop`），不是 `apps/web` 的运行期依赖 ⇒ **不违反**该范围声明（D19）。此解释为冻结口径。

---

## D18 · 跨平台洁净度判据的新边界 —— **已冻结**

`docs/reports/dock-refactor-verification.md:567-568` 的既有判据原文：

- L567：`| \`require(\` / \`process.\` / \`.node\` / \`electron\` / \`ipcRenderer\` / \`@electron\` / \`remote.\` | 同上 | **0** 处 ✅ |`（「同上」= `apps/web/src/components/shell/**`（含 `dock/**`））
- L568：`| \`from 'electron'\` / \`ipcRenderer\` / \`require('electron')\` | 整个 \`apps/web/src\` | **0** 处 ✅ |`

### D18.1 问题
新增 `apps/desktop` 后，仓库内**必然**出现 `electron`、`ipcRenderer`、`require(` 等字样。若不重新划界，后续验证任务会与既有报告自相矛盾。

### D18.2 冻结的新边界（逐字）

> **判据 D18-A（渲染层洁净度）**：在 `apps/web/src` 与 `apps/plugins/**` 范围内，以下模式命中数必须为 **0**：
> `from 'electron'`、`require('electron')`、`ipcRenderer`、`@electron/remote`、`contextBridge`、`process.env`、`process.platform`、`node:fs`、`node:path`（测试文件 `**/__tests__/**` 与 `*.test.ts(x)` 除外）。
>
> **判据 D18-B（边界归属）**：`apps/desktop/**` 是**唯一**允许出现 Electron API、`process.env`、`node:*` 内建模块的位置。任何 Electron 能力进入渲染进程必须且只能经 `apps/desktop/src/preload.ts` 的 `contextBridge.exposeInMainWorld('desktopAPI', …)`（D11.1 的 9 方法）。
>
> **判据 D18-C（原生模块）**：全仓 `.node` 文件允许的落点为 3 个既有项（`@rollup/rollup-win32-x64-gnu`、`@rollup/rollup-win32-x64-msvc`、`better-sqlite3/build/Release/better_sqlite3.node`）+ 打包产物目录（`release/**`，已 gitignore）。**任何 `.node` 不得被 `apps/web/src` 或 `apps/plugins/**` 导入。**

### D18.3 保留不变的部分
- `apps/web/src/components/shell/**`（含 `dock/**`）的**硬编码盘符/反斜杠/UNC** = 0 —— **不变**。
- `apps/web/src` 内 `from 'electron'` / `ipcRenderer` / `require('electron')` = 0 —— **不变**（实测复核 `git grep -nE "from 'electron'|require\('electron'\)|ipcRenderer|@electron/remote" -- apps/web/src` = **0 行**）。
- 变化**仅**在于：判据的**作用域被显式写出**（原来是隐含的「全仓」，现在明确为「`apps/web/src` 与 `apps/plugins/**`」），并新增 D18-B 的边界归属规则。

---

## D19 · 范围外声明 —— **已冻结**

| # | 不做的事 | 依据 |
|---|---|---|
| 1 | **不新增 `apps/web` 的运行期依赖**（`dockview` 8.4.0 / `dockview-react` 8.4.0 为既有精确 pin，不改） | `apps/web/package.json` 已读 |
| 2 | **不引入非 Electron 的桌面框架**（Tauri / NW.js / WPF / .NET / JavaFX 一律不做） | 团队目标已定 Electron |
| 3 | **不引入 C++ / Qt / CMake** | `git grep -nE "QGraphicsView\|QApplication\|CMakeLists\|#include <Q" -- apps packages` = **EMPTY**（exit 1），保持为空 |
| 4 | **不修改 dock-refactor 产物**：`apps/web/src/components/shell/**`（含 `dock/**`） | 既有冻结契约（ADR-0007） |
| 5 | **不修改 `.gitignore`** | 本任务只允许新增本 ADR 一个文件 |
| 6 | **不修改 `apps/web/src/types/desktop-api.d.ts`** | 它是既有冻结契约（F34 同族） |
| 7 | **不做 macOS / Linux / arm64 目标** | D1 |
| 8 | **不清理仓库外的临时产物**（`D:\Temp\*` 探针目录保留） | 任务硬约束 |
| 9 | **不执行任何 git 回退类命令**（`checkout` / `restore` / `stash` / `clean`） | 仓库仅 2 个提交（F30），桌面与重构产物**全部未入库** ⇒ 任何回退都会造成不可恢复的数据丢失 |
| 10 | **不修改 `packages/db/src/**`** | 桌面端适配全部通过路径布局（D7.3）与 junction 完成，无需改动 db 包 |
| 11 | **不修改 `apps/web/src/**`** | 前端契约已冻结且已满足同源要求（F32/F33/F34） |

**允许的、且必须实施的上游改动（唯一例外）**：`apps/server/src/index.ts` 新增 stdin 优雅关闭监听（D13.3）。除此之外，`apps/server/**` 与 `packages/**` 不得改动。

---

## D20 · 待验证 / 风险清单 —— **已冻结**

按风险等级排列。每项标注**验证方式**，t4/t6 必须逐项给出结论。

| # | 等级 | 待验证项 | 验证方式 | 若不成立的退路 |
|---|---|---|---|---|
| R1 | **高** | `spawn(process.execPath, ['--import','tsx', entry], { env: { ELECTRON_RUN_AS_NODE:'1' } })` 在 Electron 44.5.1 下可用 | t4 冒烟：`--win dir --x64` 后运行 `win-unpacked\砚舟.exe`，看能否打印端口就绪行 | 改用备选：直接 spawn `<app-server>/node_modules/tsx/dist/cli.mjs`（D4.2） |
| R2 | **高** | electron-builder 的 `asarUnpack` + `dependencies` 里的 `better-sqlite3` 能在 asar 侧完成 ABI 重建，且 D8.2 的 junction 方案可行 | t4 冒烟后检查 `resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node` 存在且为 **1921024 B**（F26）；并在应用内查 `/api/health.database === 'connected'` | 退化到 D8.2 的 `extraResources` 方案 + `afterPack` 钩子 |
| R3 | **高** | D13.3 的 stdin 控制通道在 Windows 上确实能触发 `closeGracefully` | t3/t6 实测：应用内点「重启」→ 观察 `<userData>/data/novelmuse.db-wal` 是否被正常收尾、`[Server] 收到 stdin，正在优雅关闭...` 是否出现在 `server.err.log` | 无等价零改动方案；须 captain 批准 D13.3 的退化路径 |
| R4 | **中** | Mode B 依赖闭包完整性（189 packages 基线是否真的够） | t4 起真机冒烟，检查 `server.err.log` 无 `Cannot find package`；并跑一次 AI `/api/ai/gateway` 的 5 个 feature | 按报错补包 |
| R5 | **中** | tsx 是否把 `.js` 说明符解析到 `.ts`（对 `ai.ts:1351` 的 5 条路由至关重要） | 探针已给 `ABS_JS_TSX_OK`，但**未在打包布局下复现** ⇒ t4 实测 5 个 feature 各调一次 | 若失败，需为 5 个 agent 额外投递 `.js`（需 `tsc` 编译），并回到 captain 修订 D4 |
| R6 | **中** | `apps/plugins/manual/worldbuilding` 以**实体副本**（解引用 junction）投递后 `import('@novel-plugins/worldbuilding')` 可解析 | t4 检查 `/api/health.plugins[]` 含 `novel.worldbuilding` 且 `status` 正常 | 若失败，在 `app-server/node_modules/@novel-plugins/worldbuilding` 做 junction，或改用 `tsc` 产出 |
| R7 | **中** | D16.2 中 `files: ["!node_modules/**/*"]` 与 `asarUnpack` 是否互相冲突 | t4 冒烟后检查 `app.asar.unpacked` 是否真的含 better-sqlite3 | **已闭环（2026-10-06）**：实测该排除会连带压掉实体 ⇒ 已从 `files` 去掉；`app.asar.unpacked` 含 `better_sqlite3.node` 1921024 B ✓ |
| R8 | **中** | `win.artifactName` 与 `nsis.artifactName` 的覆盖优先级 | t4 出包后看 `release/desktop/` 实际文件名是否匹配 D1 冻结名 | 以 `nsis.artifactName` 为准（D16.2 末注）；`portable.artifactName` 随 D4.4 一并删除 |
| R9 | **中** | `apps/desktop` 的实际解析版本（`yauzl` / `adm-zip`） | `pnpm install` 后读 `pnpm-lock.yaml` | 按实际版本回填本 ADR（须走 captain 修订） |
| R10 | **低** | 打包后插件 TS 源加载会打印 `[MODULE_TYPELESS_PACKAGE_JSON]` 警告（探针实测 `err4.txt`） | t4 观察 `server.err.log` | 无害，仅记录；若要消除需给插件 `package.json` 加 `"type":"module"`（属插件仓改动，本次不做） |
| R11 | **低** | 打包后 Electron 主进程 stdout 的 `[Server]` 日志是否完整落盘 | t4 检查 `<userData>/logs/server.err.log` 非空 | 若为空，改由 stdin/临时文件传递 |
| R12 | **低** | `compareVersions` 对预发布后缀（`1.0.0-beta.1`）的处理 | t6 单测 | 降级为纯数字段比较并记录限制 |
| R13 | **低** | 便携版下 `app.getPath('userData')` 的落点是否仍为 `%APPDATA%\NovelMuse` | t6 实跑便携版并读 `updaterGetState().pluginsDir` | **已确认（2026-10-06，D4.4）**：仍为 `%APPDATA%\NovelMuse`；zip 解压版不改变数据落点，升级时覆盖文件夹即可保留书稿。**已于 2026-10-08 闭合（D4.7）**：便携版新增 `启动便携版.cmd`，用 `--user-data-dir` 把 `userData` 重定向到解压目录内 `portable-data\`，数据随文件夹走；直接双击 exe 的传统模式落点不变 |

**已知的、不修复的既有行为（如实记录，不作为缺陷）**：
- 未签名安装包会触发 Windows SmartScreen 提示（无证书，D16.4）。
- 子进程重启后所有 JWT token 失效（`jwt.ts:107-110` 内存吊销名单，D6.1）。
- `handleFatal` 故意不退出进程（`index.ts:235-244`）⇒ 主进程必须自己做崩溃检测与重启（D12.4）。

---

## D21 · 验收标准映射 —— **已冻结**

| 验收标准 | 对应条目 |
|---|---|
| (1) 文件存在，含编号冻结条目 D1..Dn，每条可直接执行、路径/名字/签名逐字 | 全文 D1–D21，均标「**已冻结**」 |
| (2) 端口握手给出唯一确定答案（前缀字面量 + JSON 字段名 + 超时 + 失败判定），并引用 `host.ts` `start()` 返回值与 `index.ts:178` 丢弃返回值的事实 | **D5**（D5.1 前缀字面量、D5.3 超时与失败判定、D5.4 JSON 字段名；F5 记录 `start()` 返回 `{port,url}` 与 `index.ts:178` 丢弃） |
| (3) server 运行模式 = 单一决策 + 需特殊处理的动态 import 点清单 | **D4**（D4.1 决策 Mode B；D4.3 共 43 条动态 import 点全表） |
| (4) better-sqlite3 重建策略 + 失败降级 + `sql-wasm.wasm` 投递各自结论明确 | **D8**（D8.2 策略、D8.3 降级、D8.4 复原纪律）+ **D9**（wasm 投递） |
| (5) 图标来源确定，且不引用不存在的文件 | **D10**（源 = `apps/web/public/images/bamboo-ink.png`，实测存在；`build-resources/icon.{png,ico}` 由 t4 产出；明确排除不可栅格化的 SVG） |
| (6) 写出 `apps/web/src` electron 零命中判据的新边界 | **D18**（D18-A/B/C 三条冻结判据 + D18.3 保留不变部分） |
| (7) 每个数字/路径可溯源到实际读过的文件+行；未证实项标「需人工确认」；无无据推测 | **§0 事实基线表 F1–F35**（每条标注来源与方式）+ **D20 待验证/风险清单**（13 项）；全文未证实项均标「**需人工确认**」 |
| (8) 除本文件外无其他文件变更 | 本任务仅 `write` 本文件；**未**执行任何其他写入、**未**执行任何 git 回退类命令 |

---

## 附：本 ADR 明确否决的既有结论（修订记录）

| 被否决的结论 | 否决依据 | 本 ADR 的替代 |
|---|---|---|
| 「`SIGTERM` 是冻结的优雅退出通道（`index.ts:246-249`）」 | **F7 探针证伪**：Windows 上 `child.kill('SIGTERM')` 走 `TerminateProcess`，子进程 SIGTERM handler 不执行（`sigterm.txt exists: false`） | **D13.3** stdin 控制通道（`novelmuse:shutdown\n`） |
| 「Mode A（esbuild CJS 单 bundle）可作为 server 运行模式」 | **F23 探针证伪**：变量说明符 `import()` 未被重写，5 条 AI agent 路由 `ERR_MODULE_NOT_FOUND` | **D4** Mode B（tsx + 真实文件） |
| 「`apps/desktop` 可直接放在 `build/` 下作为构建资源目录」 | `.gitignore:12` 的 `build/` 会忽略任意层级同名目录，且本任务不得改 `.gitignore` | **D2/D10** 改用 `build-resources/` |

---

*本 ADR 由 t1（architect）产出，唯一新增文件。所有探针均在 `D:\Temp\*` 执行，仓库除本文件外未被修改。*