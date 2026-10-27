# 桌面壳与打包/更新器实现审计报告（对照 ADR-0008 D1–D21）

- **审计任务**：t3 — 外部审计：桌面壳与打包/更新器实现对照 ADR D1–D21（attempt 1）
- **审计对象（只读）**：`apps/desktop/src/**`、`apps/desktop/package.json` 的 `build` 块、`apps/desktop/scripts/{build-server-payload.mjs,bundle-shell.mjs,build-update.mjs}`
- **契约基线**：`docs/architecture/desktop-packaging-adr.md`（ADR-0008，状态已冻结，2026-10-02，951 行）
- **审计性质**：外部只读审计（kind=work，非质量门）。未修改任何实现文件；本报告是唯一产出。
- **审计方法**：逐条冻结字面量与磁盘实现比对（文件级 grep + 行号定位 + 关键函数逐行阅读 + 制品独立复核）。凡无独立可核证据者标「未验证」，不以「符合」代替。
- **判定口径**：`符合` / `偏离`（实现了但语义或形态与冻结字面不同）/ `缺失`（未实现）/ `未验证`（无证据，且已在报告中标明缺什么证据）。
- **证据可复现性提示**：凡涉及 `release/**`、`apps/desktop/payload/**` 的观测，均标注观测时刻；这些目录在审计期间正被其它任务（t2/t4）重建，属**中间态**，制品层结论以其后 t4 端到端实测为准。

---

## 0. 结论摘要

| 判定 | 数量 | 条目 |
| --- | --- | --- |
| 符合 | 16 | D2、D3、D5、D6、D7、D9、D10、D11、D12、D13、D14.1、D14.3-1、D14.3-2（路径穿越部分）、D14.3-3、D14.4（部分）、D14.5、D15、D17、D18-C、D19（未改动面） |
| 偏离（低危） | 9 | 见 §5 偏差清单 |
| 偏离（中/高危） | 2 | DEV-01（`files` 缺第三项）、DEV-10（extraResources 源根 `node_modules` 被过滤 → 打包产物缺依赖闭包） |
| 未验证 | 1 组 | 见 §6 未验证清单（打包产物形态、首次启动播种/junction、握手/探针/优雅退出、`--import tsx` 可用性、sql.js 回退、D8.4 复原） |

**一句话结论**：`apps/desktop` 的**外壳、IPC 契约、路径/环境装配、优雅关闭、更新器安全三项**在代码层面与 ADR 冻结字面**高度一致**，可直接采信；但**打包配置层存在两处需人工处置的实质问题**——`files` 缺失 D16.2 冻结的第三项 `!node_modules/**/*`，以及 `extraResources` 的源根 `node_modules` 被 electron-builder 内置过滤（`app-builder-lib/out/util/filter.js:43`）导致 `resources/app-server` 不带依赖闭包。后者是「重跑正式打包 + 端到端实测」必须先解决的问题（其影响与 D8.2 的 asar.unpacked junction 设计相关联）。

---

## 1. 逐条覆盖：ADR D1–D21 × 代码位置 × 判定

> 说明：ADR 位置列为 `docs/architecture/desktop-packaging-adr.md` 内行号区间；代码位置列为 `file:line`。

### D1 产物矩阵（ADR:60-74）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| productName=砚舟 | `apps/desktop/package.json:33` | 符合 |
| appId=com.novelmuse.desktop | `apps/desktop/package.json:32` | 符合 |
| 壳包名 @novel/desktop、version 随根 0.1.0 | `apps/desktop/package.json:2-3`（根 `package.json` version 亦 0.1.0） | 符合 |
| shortcutName=听风细雨 | `apps/desktop/package.json:67` | 符合 |
| 输出目录 `F:\new1.2\release\desktop` | `apps/desktop/package.json:36`（`../../release/desktop`） | 符合 |
| NSIS 名 `砚舟-Setup-${version}-x64.exe` | `apps/desktop/package.json:68`（`砚舟-Setup-${version}-${arch}.${ext}`，x64 展开即冻结名） | 符合 |
| 便携名 `砚舟-Portable-${version}-x64.exe` | `apps/desktop/package.json:72`（`砚舟-Portable-${version}-${arch}.${ext}`） | 符合 |
| 仅 win32/x64，不做 mac/Linux/arm64/Squirrel/MSI/AppX | `apps/desktop/package.json:54-61`（target 仅 nsis+portable，arch 仅 x64） | 符合（不做项见 D16.4） |

### D2 文件清单与冻结约束（ADR:78-111）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| `package.json`（main=dist/main.cjs，内嵌 build 块） | `apps/desktop/package.json:8`、`:30-74` | 符合 |
| `tsconfig.json`（noEmit） | `apps/desktop/tsconfig.json:13`（noEmit:true）、`:3-8`（target ES2022/module ESNext/strict） | 符合 |
| `build-resources/{icon.ico,icon.png}` 且目录名不得为 `build/` | `apps/desktop/build-resources/`（icon.ico、icon.png 实测存在）；`apps/desktop/.gitignore:1-3` 注释显式记载该约束 | 符合 |
| `scripts/{gen-icon.py,bundle-shell.mjs,build-server-payload.mjs,build-update.mjs}` | `apps/desktop/scripts/`：四者均在（`build-update.mjs` 已由 t2 补齐） | 符合 |
| `src/{main.ts,preload.ts,ipc-channels.ts,paths.ts,env.ts,server-process.ts,logger.ts,window.ts,updater.ts,updater-manifest.ts,types.ts}` | `src/main.ts`、`preload.ts`、`ipc-channels.ts`、`paths.ts`、`env.ts`、`server-process.ts`、`logger.ts`、`window.ts`、`updater-manifest.ts`、`types.ts` 均在；**`src/updater.ts` 不存在，实现为 `src/updater/**` 目录（8 文件）** | **偏离（低）** → DEV-02 |
| 约束①：`preload.ts` 路径被 `apps/web/src/types/desktop-api.d.ts:2` 逐字引用，不可改名移位 | `apps/web/src/types/desktop-api.d.ts:2` 逐字「运行时由 `apps/desktop/src/preload.ts` 的 `contextBridge` 注入」；`apps/desktop/src/preload.ts` 就位 | 符合 |
| 约束②：`dist/` 不入库 | `apps/desktop/.gitignore:4`（`dist/`）；`git status` 中 `apps/desktop/src/`、`scripts/` 为未跟踪但 `dist/` 未出现 | 符合 |
| 约束③：目录必须叫 `build-resources/`，不得改 `.gitignore` | 根 `.gitignore:12`（`build/`）未改动（`git status --porcelain .gitignore` 无输出） | 符合 |
| 额外文件（ADR 未列）：`src/desktop-api.ts` | `apps/desktop/src/desktop-api.ts`（145 行） | **偏离（低）** → DEV-02 |

### D3 依赖与安装纪律（ADR:115-158）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| electron 44.5.1（精确，devDependencies） | `apps/desktop/package.json:26` | 符合 |
| electron-builder 26.15.3（精确，devDependencies） | `apps/desktop/package.json:27` | 符合 |
| better-sqlite3 12.11.1 放 dependencies（触发 ABI 重建） | `apps/desktop/package.json:20` | 符合 |
| yauzl ^3.4.0 放 dependencies | `apps/desktop/package.json:21` | 符合 |
| esbuild ^0.28.2、typescript ^5.7.0 | `apps/desktop/package.json:28`（esbuild ^0.28.2）、`:29`（typescript ^5.7.0） | 符合 |
| `overrides` 追加 `'@electron/get': ^3.1.0`（D3.3） | `pnpm-workspace.yaml:63`（追加于既有 overrides 块内，附 F28 理由注释 `:60-62`） | 符合 |
| 不得手工调用 `@electron/rebuild` | 全仓 `apps/desktop/**` 无 `@electron/rebuild` 调用 | 符合 |
| 打包后必须 `pnpm install` 恢复 Node ABI 137 | 无自动执行证据（纪律项）；实测 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` = 1919488 B（mtime 06-16），属已复原的 ABI 137 副本 | **部分未验证** → §6 |
| 须用 `apps\desktop\node_modules\.bin\electron-builder.cmd` | `apps/desktop/package.json:14-15` 的 `dist:dir`/`dist` 使用裸 `electron-builder` | **偏离（低）** → DEV-11 |

### D4 Mode B 负载与投递清单（ADR:161-226）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| 生成器 `scripts/build-server-payload.mjs` | `apps/desktop/scripts/build-server-payload.mjs`（294 行） | 符合 |
| 负载根 `resources/app-server` | `apps/desktop/scripts/build-server-payload.mjs:152-223`（输出 `apps/desktop/payload/app-server`，经 `package.json extraResources` 落 `resources/app-server`） | 符合 |
| 入口 `<app-server>/apps/server/src/index.ts` | `apps/desktop/src/main.ts:93-116`（`resolveServerTarget` 打包态 entry） | 符合 |
| 子进程 cwd `<userData>/app-runtime/app-server` | `apps/desktop/src/main.ts:93-116`（cwd=appServerDir）；`src/paths.ts:64`（`versionJsonPath`）、`resolveLayout:48-83` | 符合 |
| 首选 `spawn(process.execPath,['--import','tsx',entry])` | `apps/desktop/src/server-process.ts:485-508`（mode 非 `cli` 时 `['--import','tsx',entry]`） | 符合 |
| 备选 `tsx/dist/cli.mjs` | `apps/desktop/src/server-process.ts:485-508`（mode `cli` ⇒ `[tsxCliPath, entry]`）；回退逻辑 `apps/desktop/src/main.ts:316-328` | 符合 |
| tsx 位于 `<app-server>/node_modules/tsx` | payload 实测含 `node_modules/tsx`（tsx 4.22.3，`dist/cli.mjs` 120402 B） | 符合 |
| 投递 `apps/server/src/**` | `apps/desktop/scripts/build-server-payload.mjs:156-166` | 符合 |
| 投递 `packages/{core,db,shared}/**` 双份（`packages/` 与 `node_modules/@novel/`） | `apps/desktop/scripts/build-server-payload.mjs:172-177` | 符合 |
| 投递 `packages/db/drizzle/**` | `apps/desktop/scripts/build-server-payload.mjs:180-183`（含校验）；实测 6 文件 | 符合 |
| `@novel-plugins/worldbuilding` 实体副本 | `apps/desktop/scripts/build-server-payload.mjs:186-194`（`filter` 排除 node_modules） | 符合 |
| 第三方闭包 + `pnpm-workspace.yaml` 逐字副本 | `apps/desktop/scripts/build-server-payload.mjs:118-142`（BFS 闭包）、`:220-223`（逐字副本）；实测 payload 的 `pnpm-workspace.yaml` 与仓库根 **Hash 相同** | 符合 |
| `seed-plugins/{auto,manual,shared}/**` | `apps/desktop/scripts/build-server-payload.mjs:227-238`；实测 5 个 seed 插件，`node_modules` 目录数=0 | 符合 |
| 排除 `apps/plugins/**/node_modules/**` | 同上（`filter`/排除逻辑）；实测 payload `seed-plugins` 无 node_modules | 符合 |
| D4.2 基线 189 packages / 107768288 B | 实测 payload/app-server = **252475413 B / 265 包** | **偏离（中）** → DEV-09 |
| 闭包完整性（R4） | 抽检 hono / drizzle-orm / sql.js / zod / openai / jsonwebtoken / bcryptjs / undici / uuid / @hono/node-server / @hono/zod-validator / @deepseek-ai/* 全部就位；`@openai/agents` 就位 | 符合（抽检，非穷举） |

### D5 握手/探针/超时/health（ADR:227-276）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| stderr 端口正则 `^\[Server\] Cordis 基座已就绪 → http://localhost:(\d+)$` | `apps/desktop/src/server-process.ts:68`（`PORT_LINE_RE`），与 ADR:232 逐字一致 | 符合 |
| 正则行首锚定（`console.warn` 走 stderr 为冻结事实） | `apps/desktop/src/logger.ts:119-127`（`writeRaw` 逐字落盘不加时间戳，注释 `:114-117` 说明保锚定）；`server-process.ts:533-552`（行首锚定匹配） | 符合 |
| PORT=0 / HOST=127.0.0.1 | `apps/desktop/src/env.ts:28-31`（`CONST_PORT '0'`、`CONST_HOST '127.0.0.1'`） | 符合 |
| 窗口 URL `http://127.0.0.1:<port>/` | `apps/desktop/src/main.ts:416-447`（`url = `${origin}/``） | 符合 |
| 握手 15000 ms | `apps/desktop/src/server-process.ts:44`（`HANDSHAKE_TIMEOUT_MS = 15_000`） | 符合 |
| 探针 30×500 ms | `apps/desktop/src/server-process.ts:46,48`（`HEALTH_PROBE_ATTEMPTS=30`、`HEALTH_PROBE_INTERVAL_MS=500`） | 符合 |
| 总预算 30000 ms | `apps/desktop/src/server-process.ts:54`（`TOTAL_STARTUP_BUDGET_MS=30_000`） | 符合 |
| 失败弹错误框（含 stderr 末 2000 字符）+ `app.exit(1)` | `apps/desktop/src/main.ts:175-183`（`fatal` ⇒ `dialog.showErrorBox` + `shutdownAndExit(code)`）；`server-process.ts:770,824`（`stderrTail(2000)`）；`logger.ts:36`（`STDERR_TAIL_CHARS=2000`）、`:210-213`（合并主日志尾 + server stderr 尾再截末 2000 字符） | 符合（退出码见 DEV-15） |
| health JSON 六字段 | `apps/desktop/src/types.ts:30-42`（`status/database/pluginStandard/hostMode/plugins[{id,status,modes,error}]/timestamp`）；探测 `server-process.ts:141-201` | 符合 |
| 就绪判据 `status==='ok' && database==='connected'` | `apps/desktop/src/server-process.ts:655-720`（`waitForHealth`） | 符合 |
| degraded ⇒ 仍建窗 + 落 `WARN database unavailable` | `apps/desktop/src/main.ts:357-364`（`degraded || database !== 'connected'` ⇒ `logger.warn`，随后继续 `openWindow`） | 符合 |

### D6 注入 env 表（ADR:280-331）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| 常量 PORT/HOST/DISABLE_PROXY_DETECT/HOST_MODE/ELECTRON_RUN_AS_NODE | `apps/desktop/src/env.ts:28-32` | 符合 |
| 打包态注入 WEB_DIST_PATH/DB_PATH/PLUGINS_ROOT/JWT_SECRET | `apps/desktop/src/env.ts:204-209` | 符合 |
| 开发态差异（DB_PATH=<repo>/data/novelmuse.db，删 PLUGINS_ROOT/WEB_DIST_PATH/JWT_SECRET） | `apps/desktop/src/env.ts:212-218`（注释 `:146-158`） | 符合 |
| 不注入 ADMIN_USERNAME/ADMIN_PASSWORD/JWT_EXPIRES_IN/COOKIE_SECURE/NOVELMUSE_DB_ENGINE | `apps/desktop/src/env.ts:47-53`（`NEVER_INJECT_EXACT`）+ 循环剥离 `:179-184` | 符合 |
| 不注入 AI_*/AI_SSRF_* | `apps/desktop/src/env.ts:56-62`（`NEVER_INJECT_PREFIXES`：`AI_PROVIDER/OPENAI_/OLLAMA_/CUSTOM_AI_/AI_SSRF_`） | 符合 |
| 代理变量继承 | `apps/desktop/src/env.ts:163-229`（未剥离代理变量） | 符合 |
| D6.1 JWT_SECRET=randomBytes(32).toString('hex') 存 `<userData>/data/.jwt-secret`(0o600) | `apps/desktop/src/env.ts:105-130`（`loadOrCreateJwtSecret`，仅接受 `/^[0-9a-f]{64}$/i`，`writeFileSync(..., {mode:0o600})`） | 符合 |
| D6.2 管理员初始密码正则 | `apps/desktop/src/server-process.ts:73-74`，与 ADR:323 逐字一致 | 符合 |
| D6.2 写 `<userData>/logs/initial-admin-password.txt`(0o600 覆盖写) | `apps/desktop/src/server-process.ts:555-568`（`captureAdminPassword`，`PASSWORD_FILE_MODE=0o600`，`:77`） | 符合 |
| D6.2 仅本次捕获到才弹一次性对话框 | `apps/desktop/src/main.ts:388-413`（`maybeShowAdminPasswordDialog`，`password === null` 直接返回） | 符合 |

### D7 布局/播种/junction（ADR:335-393）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| D7.1 布局树（data/plugins/app-runtime/backups/updates/logs） | `apps/desktop/src/paths.ts:48-83`（`resolveLayout`）；`apps/desktop/src/types.ts:109-156`（`UserDataLayout` 11 冻结字段 + 11 派生字段） | 符合 |
| D7.1 userData 落 `%APPDATA%\NovelMuse` | `apps/desktop/src/main.ts:54`（`app.setName('NovelMuse')`） | 符合 |
| D7.1 三日志落点 | `apps/desktop/src/logger.ts:163-173`（`main`/`server.out`/`server.err` 三条流） | 符合 |
| D7.2 播种 6 步（version.json 缺失才播种、不覆盖） | `apps/desktop/src/paths.ts:331-394`（`seedFromResources`）+ `:542-592`（`ensureLayout`，`:559-569` 仅在 `version.json` 缺失时播种） | 符合 |
| D7.2 步骤⑤「建立 junction」在播种之后 | `apps/desktop/src/paths.ts:389` 注释 + `:584`（`ensureRuntimeJunctions` 在 `seedFromResources` 之后调用） | 符合 |
| D7.3 `<userData>/app-runtime/app-server/data` → `<userData>/data` 目录 junction | `apps/desktop/src/paths.ts:438-442`（`ensureRuntimeJunctions` 内 data junction） | 符合 |
| D7.3 更新切换只准替换 apps/packages/node_modules/pnpm-workspace.yaml 四项，绝不动 data | `apps/desktop/src/updater/types.ts:159`（`APP_REPLACE_ENTRIES`）；`apps/desktop/src/updater/index.ts:635-647`（循环 + `neverTouch` 双保险）；`:574-580`（备份排除 `data`，注释 `:572-573`） | 符合 |
| D7.3 junction 丢失须每次启动重建 | `apps/desktop/src/paths.ts:584`（`ensureLayout` 每次启动调用 `ensureRuntimeJunctions`） | 符合 |
| D7.4 `<userData>/plugins/node_modules` → app-server/node_modules junction | `apps/desktop/src/paths.ts:452-456` | 符合 |
| F20：junction 存在性判断必须 `statSync/existsSync`，禁 `lstat().isDirectory()` | `apps/desktop/src/paths.ts:90-98`（`pathExists` 用 `statSync`）；`lstat` 仅用于 `isSymbolicLink()`（`:101-107`）；`updater/index.ts:86-116` 同类处理 | 符合 |

### D8 ABI / asar / 降级（ADR:397-431）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| better-sqlite3 放 dependencies 触发 ABI 重建 | `apps/desktop/package.json:20` | 符合 |
| `asar:true` | `apps/desktop/package.json:43` | 符合 |
| `asarUnpack` 必含 `node_modules/{better-sqlite3,bindings,file-uri-to-path}/**` | `apps/desktop/package.json:44-48` | 符合（与 D16.2 逐字一致） |
| app-server/node_modules/better-sqlite3 用 junction 指向 asar.unpacked | `apps/desktop/src/paths.ts:465-514`（`ensureRuntimeJunctions`，`unpackedBetterSqlite3` 计算 `:574-582`） | 符合（**但依赖 app-server/node_modules 存在** → 见 DEV-10） |
| 重建后 `.node` 落 `resources/app.asar.unpacked/.../better_sqlite3.node`（1921024 B） | **未验证**（无当前打包产物证据；实测仓库内副本为 1919488 B 的 ABI 137 版本） | 未验证 → §6 |
| D8.3 失败回退 sql.js 不阻断 | `apps/desktop/src/paths.ts:465-514`（失败仅告警）；运行期行为**未验证** | 符合（静态）/ 未验证（运行期） |
| D8.4 打包后 `pnpm install` 复原 | 纪律项，无自动执行证据；实测 `.node` 为 ABI 137 副本 | 未验证 → §6 |

### D9 sql-wasm.wasm（ADR:435-442）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| `resources/app-server/node_modules/sql.js/dist/sql-wasm.wasm`（659730 B）存在 | 实测 `apps/desktop/payload/app-server/node_modules/sql.js/dist/sql-wasm.wasm` = **659730 B**；`build-server-payload.mjs:241-258` 自检含该文件 | 符合 |

### D10 图标（ADR:446-469）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| 源 `apps/web/public/images/bamboo-ink.png`、裁剪 `(365,0,1306,941)` | `apps/desktop/scripts/gen-icon.py:38`（`CROP_BOX=(365,0,1306,941)`） | 符合 |
| icon.png 512×512 RGBA | `apps/desktop/scripts/gen-icon.py:39`（`PNG_SIZE=(512,512)`）、`:69`（RGBA）、`:72`（LANCZOS）；实测 icon.png 512×512、bitdepth 8、colortype 6（RGBA） | 符合 |
| icon.ico sizes `[(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)]` | `apps/desktop/scripts/gen-icon.py:40`（`ICO_SIZES` 六项）、`:80-81`；实测 ico 6 entries 16/32/48/64/128/256 | 符合 |
| `win.icon=build-resources/icon.ico` | `apps/desktop/package.json:56` | 符合 |
| `directories.buildResources=build-resources` | `apps/desktop/package.json:37` | 符合 |
| 两图标必须入库 | `apps/desktop/build-resources/{icon.ico,icon.png}` 存在 | 符合 |

### D11 IPC 契约（ADR:473-526）— **本次重点，逐字核对**

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| 9 方法签名与返回字段须与 `apps/web/src/types/desktop-api.d.ts:10-31` 逐字一致 | `apps/desktop/src/desktop-api.ts:77-98`（`DesktopApi`）、`:27-69`（各 Result 类型）与 `.d.ts:10-31` 逐字一致；`apps/desktop/src/preload.ts:112-127` 9 方法同名同序；`updater/types.ts:64-106` 各 Result 逐字对齐 | 符合 |
| 9 条 IPC 通道字面量，唯一真源 `src/ipc-channels.ts` | `apps/desktop/src/ipc-channels.ts:27-36`（9 条逐字）；`IPC_CHANNELS :46-56`；主进程 `main.ts:202-259` 与 preload `preload.ts:112-127`（经 `DESKTOP_API_CHANNELS`）共用 | 符合 |
| 恰好 9 条 | `apps/desktop/src/ipc-channels.ts:59`（`IPC_CHANNEL_COUNT = 9`）；`main.ts:261-268` 注册数校验 != 9 告警 | 符合 |
| 全部 `ipcRenderer.invoke`，禁用 `send/on` | `apps/desktop/src/preload.ts:43-105`（`invokeChecked`/`invokeOrFailure`/… 全部 `ipcRenderer.invoke`）；全文无 `send(`/`.on(` | 符合 |
| 失败一律 `{ok:false,error}` 不 reject | `preload.ts:51-60`（`invokeOrFailure`）；`main.ts:189-200`（`handle()` try/catch ⇒ `failure`）；`updater/index.ts` 各方法返回 `{ok:false,...}` | 符合 |
| 浏览器 dev 不注入 polyfill | `preload.ts:133-135`（无 `contextBridge` 仅 warn 不注入） | 符合 |
| D11.3 webPreferences `{preload,contextIsolation:true,nodeIntegration:false,sandbox:false,webSecurity:true}` | `apps/desktop/src/window.ts:163-169` 逐字一致 | 符合 |

### D12 生命周期（ADR:530-574）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| D12.1 单实例锁，未取得即 `app.quit` | `apps/desktop/src/main.ts:451-456` | 符合 |
| D12.1 second-instance ⇒ restore+focus，不建第二窗口、不重启子进程 | `apps/desktop/src/main.ts:458-467` | 符合 |
| D12.2 窗口 1440×900、min 1024×640、`show:false`+`once('ready-to-show')`、`autoHideMenuBar:true` | `apps/desktop/src/window.ts:40-46,171-186` | 符合 |
| D12.2 `setWindowOpenHandler` 一律 deny，仅 http/https 转 `shell.openExternal` | `apps/desktop/src/window.ts:189-199` | 符合 |
| D12.2 `will-navigate` 只允许 `127.0.0.1:<port>` 与开发态 `localhost:5173` | `apps/desktop/src/window.ts:202-208`；开发 origin 见 DEV-08 | 符合（含偏离：开发 origin 实为 5174） |
| D12.3 启动 8 步顺序 | `apps/desktop/src/main.ts:449-571`（锁 `:451` → `whenReady :470` → `ensureLayout :477` → junction `:496-514`（在 ensureLayout 内）+ 装配/startServer/openWindow） | 符合 |
| D12.4 崩溃重启：60 s 内最多 3 次；超限弹框含 stderr 末尾 + `app.exit(1)` | `apps/desktop/src/server-process.ts:58-60`（常量）、`:726-776`（`runRestartPolicy`）；`main.ts:297-307`（`onRestartExhausted` ⇒ `fatal`，含 `stderrTail`） | 符合 |
| D12.4 主进程 `uncaughtException` 记日志不静默退出 | `apps/desktop/src/main.ts:574-579` | 符合 |
| D12.5 差异表 + 启动 GUI 前 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 纪律 | `apps/desktop/src/env.ts:146-158` 注释记载差异；纪律属操作项（未验证） | 符合（静态）/ 未验证（操作纪律） |

### D13 优雅关闭（ADR:578-624）— **本次重点**

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| D13.1 不得用 `child.kill('SIGTERM')` 作优雅关闭 | `apps/desktop/src/server-process.ts` 全文无 `kill('SIGTERM')`；`main.ts:7-17` 注释明示 | 符合 |
| D13.2 server 无 stdin 通道 → D13.3 新增 | `apps/server/src/index.ts:251-281`（`stdin` 控制通道，`:252-255` 注释引 D13.3） | 符合 |
| D13.3 唯一允许改的 server 文件；协议一行 `novelmuse:shutdown\n`；不改 `closeGracefully` 语义 | `apps/server/src/index.ts:209-233`（`closeGracefully` 未改）、`:246-247`（SIGINT/SIGTERM 保留）、`:260-281`（stdin 通道，`SHUTDOWN_TOKEN='novelmuse:shutdown'`）；父进程 `server-process.ts:435`（写 `${SHUTDOWN_TOKEN}\n`） | 符合 |
| D13.3 子进程 stdio 必须 `['pipe','pipe','pipe']` | `apps/desktop/src/server-process.ts:505` | 符合 |
| D13.4 ①写 stdin ②等 exit ≤5000 ms ③超时 `taskkill /PID <pid> /T /F`（`/T` 必须保留）④`app.exit(0)` | `apps/desktop/src/server-process.ts:402-468`（`:435` 写信、`:440` `Promise.race` 5 s、`:458` `taskkillTree`、`:460` 再等 2 s）；`:207-247`（`taskkillTree` ⇒ `spawn('taskkill',['/PID',pid,'/T','/F'])`，`:228`）；`main.ts:162-165`（`app.exit`） | 符合 |

### D14 更新器（ADR:628-705）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| D14.1 baseUrl=manifest.json 所在目录；清单=`${baseUrl}/manifest.json`；空串=关闭；默认 `''`；持久化 `updates/config.json {"baseUrl":…}` | `apps/desktop/src/updater/config.ts:19-30`（读，缺失/损坏 ⇒ `{baseUrl:''}`）、`:36-42`（原子写）、`:53-70`（校验，`''` 合法、仅 http/https）、`:73-75`（`manifestUrlOf`） | 符合 |
| D14.2 manifest 字段 `{version,notes?,publishedAt,app{url,sha256},plugins[{id,name,version,url,sha256,notes?}]}`，与 `UpdateSection.tsx` 的 `PluginUpdateInfo` 逐字一致 | `apps/desktop/src/updater-manifest.ts:136-237`（`parseManifest`）；`apps/desktop/src/updater/types.ts:123-133` | 符合 |
| D14.2 `appOutdated=compareVersions(manifest.version,appVersion)>0` | `apps/desktop/src/updater/index.ts:447`（`doCheck` 内） | 符合 |
| D14.2 `pluginUpdates` 为仅版本高于本地的子集 | `apps/desktop/src/updater-manifest.ts:277-303`（`selectPluginUpdates`）**额外纳入未安装/本地无 plugin.json 的项** | **偏离（低）** → DEV-05 |
| D14.2 url 可相对或 http(s) 绝对，仅 http/https | `apps/desktop/src/updater/config.ts:81-97`（`resolveArtifactUrl`） | 符合 |
| D14.3-① SHA-256 流式校验、小写十六进制、不一致删临时文件 + `{ok:false,error:'SHA-256 校验失败'}`、绝不进入解压 | `apps/desktop/src/updater/http.ts:139-215`（`:151` `createHash('sha256')` 增量、`:212` 抛 `SHA-256 校验失败：期望 …，实际 …`、失败 `rm` `:204`）；`apps/desktop/src/updater-manifest.ts:29`（`/^[0-9a-f]{64}$/`）；`updater/index.ts:560-567`（失败即 return，注释 `:564` 明示「绝不进入解压」） | **符合** |
| D14.3-② 路径穿越：`path.resolve(destRoot,entryName)` startsWith 校验；拒绝对路径/`..` 段/Windows 保留名/符号链接与硬链接 entry；否则整包拒绝并清理 | `apps/desktop/src/updater/zip.ts:95-134`（`assertSafeEntryName`：`:111` 前导 `/`、`:117` `..` 段、`:123` 保留名、`:129-130` `path.resolve`+`startsWith` 兜底）、`:299-393`（阶段 1 全量校验后才写盘：`:310-311` S_IFLNK 拒、`:315` 加密拒、`:319` method 拒、`:340-344` 父/目标越界拒、`:368-372` CRC-32 校验、`:383` 异常 `rm -rf`）、`updater/index.ts:591-597`（整包拒绝 ⇒ `{ok:false}`） | **符合（路径穿越/符号链接）**；**硬链接 entry 未检测** → DEV-06 |
| D14.3-③ 替换前先整体复制旧目录到 `<userData>/backups/<oldVersion>/`，失败 ⇒ 中止 + `{ok:false,error:'备份失败'}` | `apps/desktop/src/updater/backup.ts:101-130`（`backupDir`，失败抛 `BackupError('备份失败: …')` `:125`）；`updater/index.ts:569-586`（失败 ⇒ `备份失败，已中止更新：…` `:585`） | **符合** |
| D14.3 补充：单文件上限 512 MB、下载超时 120 s、url 仅 http/https | `apps/desktop/src/updater/http.ts:17`（`MAX_DOWNLOAD_BYTES`）、`:18`（`DOWNLOAD_TIMEOUT_MS=120_000`）、`:157,194`；`apps/desktop/src/updater/types.ts:153,156` | 符合 |
| D14.4 下载暂存 `updates/downloads/<sha256>.zip`；解压暂存 `updates/extract/<sha256>/`；版本记录 `app-runtime/version.json` | `apps/desktop/src/updater/index.ts:551,589`；`apps/desktop/src/paths.ts:64,299-322` | 符合 |
| D14.4 `updaterGetState().appVersion` 取 version.json，缺失回落 `app.getVersion()` | `apps/desktop/src/updater/index.ts:408-415`（初值恒为 `ctx.appVersion` ⇒ `app.getVersion()`，见 `main.ts:368`）；`version.json` 仅被 `paths.ts:559` 用于播种判断，updater 侧从不读 | **偏离（低）** → DEV-04 |
| D14.4 `pluginsDir=<userData>/plugins`；`plugins[]` 扫 `plugins/{auto,manual,shared,local}/*/plugin.json` 给 `{id,version\|null,dir}` | `apps/desktop/src/updater/plugins.ts:21-55`（`scanModeDir`，跳过 node_modules）、`:58-61`；`updater/types.ts:149`（`PLUGIN_MODES`） | 符合 |
| D14.5 a–i 全流程 | 见 §2 专项 | 符合 |
| D14.5 插件更新只替换 `plugins/<mode>/<pluginId>/`，不重启后端 | `apps/desktop/src/updater/index.ts:765-850`（`installPlugin`，注释 `:840` 明示不重启） | 符合 |

### D15 命令表（ADR:709-722）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| `pnpm --filter @novel/web build`、`python apps/desktop/scripts/gen-icon.py`、`node apps/desktop/scripts/build-server-payload.mjs`、`node apps/desktop/scripts/bundle-shell.mjs`、`electron-builder … --win dir --x64`（冒烟首选）、`--win nsis portable --x64`（正式）、`node apps/desktop/scripts/build-update.mjs`、`pnpm install` | `apps/desktop/package.json:9-18`（`icon`/`payload`/`bundle`/`dev`/`build`/`type-check`/`dist:dir`/`dist`）；`scripts/` 三个 `.mjs` 均在 | 符合（封装为 npm scripts；D15 命令可用） |
| 命令用 `apps\desktop\node_modules\.bin\electron-builder.cmd` | `apps/desktop/package.json:14-15` 用裸 `electron-builder` | **偏离（低）** → DEV-11 |

### D16 build 块（ADR:726-812）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| D16.1 build 块内嵌 `package.json`（非独立 `electron-builder.yml`） | `apps/desktop/package.json:30-74`（内嵌 ✓）；但仓库另存 `apps/desktop/electron-builder.yml`（83 行镜像） | **偏离（低）** → DEV-03 |
| D16.2 appId/productName/copyright/directories | `apps/desktop/package.json:32,33,34,35-38` | 符合 |
| D16.2 `files: ["dist/**/*","package.json","!node_modules/**/*"]` | `apps/desktop/package.json:39-42` = `["dist/**/*","package.json"]`（**缺第三项**） | **偏离（中）** → DEV-01 |
| D16.2 `asar:true`、`asarUnpack` 三项、`extraResources` 三项 | `apps/desktop/package.json:43,44-48,49-53` | 符合（字面一致） |
| D16.2 `win{target nsis+portable x64,icon,artifactName}` | `apps/desktop/package.json:54-61` | 符合 |
| D16.2 `nsis{…shortcutName 听风细雨…}` | `apps/desktop/package.json:62-71` | 符合 |
| D16.2 `portable{artifactName 砚舟-Portable-…}` | `apps/desktop/package.json:72-74` | 符合 |
| D16.2 末注（artifactName 覆盖优先级 / `!node_modules/**/*` 是否保留，均「需人工确认」） | `apps/desktop/electron-builder.yml:31-38` 注释记录了删除该项的实测理由（否则 40 个依赖 `filesCount=0`、asar 内零 node_modules、`asarUnpack` 三项落空） | 需人工确认（本报告 §5 给出结论建议） |
| D16.3 `asarUnpack` 必含 bindings/file-uri-to-path | `apps/desktop/package.json:44-48` | 符合 |
| D16.4 不做 Squirrel/签名/electron-updater/afterSign/notarize | `apps/desktop/package.json:30-74` 无相关键 | 符合 |

### D17 build-update.mjs（ADR:816-849）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| 路径 `apps/desktop/scripts/build-update.mjs` 冻结 | `apps/desktop/scripts/build-update.mjs`（400 行，已补齐） | 符合 |
| 输入：`apps/web/dist`、`payload/app-server`、`win-unpacked`、5 个磁盘插件 `plugin.json` | `apps/desktop/scripts/build-update.mjs:60-61`（`OUT_DIR`/`APP_SERVER_DIR`）、`:62`（`WEB_DIST_DIR`）、`:87-93`（`PLUGIN_SOURCES` 5 项） | 符合 |
| 输出 `release/updates/{manifest.json + 6 zip}` | 实测 `release/updates/` 含 `manifest.json` + `novelmuse-app-0.1.0.zip` + 5 个插件 zip（观测：16:33 重跑后） | 符合 |
| sha256 小写十六进制 | `apps/desktop/scripts/build-update.mjs:107-108`（`createHash('sha256')`）、`:347,349`（`SHA_RE` 自检） | 符合 |
| zip 内路径相对包根、无前导 `/` 或 `..` | `apps/desktop/scripts/build-update.mjs:112-158`（`assertSafeEntryName` + `addTree`）；实测全 entry `bad=[]` | 符合 |
| `plugins[]` 含 5 个磁盘插件；不含 builtin 21 条与 worldbuilding | `apps/desktop/scripts/build-update.mjs:96-97`（`BUILTIN_ONLY_IDS`/`FORBIDDEN_PLUGIN_IDS`）、`:264-276`（漂移校验 fail-closed）；实测 manifest `plugins[5]` 与 5 个磁盘插件一致，未含 builtin/worldbuilding | 符合 |
| 脚本幂等 | `apps/desktop/scripts/build-update.mjs:67-79`（`ENTRY_TIME` 钉死 ⇒ sha256 复跑不变）、`:296-301`（清旧 zip） | 符合 |
| D17.4 读用 `yauzl ^3.4.0` | 未采用 `yauzl`（`apps/desktop/src/updater/zip.ts:10-14` 自实现 ZIP 读取器，理由：仓库无 yauzl 实体）；实测 `node_modules/yauzl` = 3.4.0 已装 | **偏离（低）** → DEV-07 |
| D17.4 写优先 `adm-zip` | `apps/desktop/scripts/build-update.mjs:55`（`import AdmZip from 'adm-zip'`）；实测 `adm-zip` = 0.5.18 | 符合 |

### D18 渲染层洁净度与边界（ADR:853-875）

| 冻结项 | 代码位置 | 判定 |
| --- | --- | --- |
| D18-A `apps/web/src` 与 `apps/plugins/**` 内 `from 'electron'`/`require('electron')`/`ipcRenderer`/`@electron/remote`/`contextBridge`/`process.env`/`process.platform`/`node:fs`/`node:path` 命中 = 0（测试除外） | 复测命中 **2 处**：`apps/web/src/types/desktop-api.d.ts:3`（**仅注释**含 `contextBridge`）、`apps/plugins/shared/ui-kit/src/ErrorBoundary.tsx:55`（`process.env.NODE_ENV === 'development'`） | **偏离（低）** → DEV-12 |
| D18-B `apps/desktop/**` 是唯一允许 Electron API/`process.env`/`node:*` 的位置；Electron 能力进渲染只能经 preload contextBridge | `apps/desktop/src/**` 内 Electron API 仅在 `main.ts`/`window.ts`/`preload.ts`/`logger.ts`（node:fs）；`preload.ts:130-131` 仅经 `contextBridge.exposeInMainWorld` | 符合 |
| D18-C `.node` 白名单（3 个既有项 + `release/**`） | 排除 `node_modules`/`release` 后 `apps`、`packages` 下 `.node` 命中 = **0** | 符合 |

### D19 不做清单（ADR:879-895）

| 冻结项 | 证据 | 判定 |
| --- | --- | --- |
| 不改 `apps/web` 运行期依赖 | `git diff apps/web/package.json` 仅新增 `dockview`/`dockview-react`（属 dock-refactor 任务，非桌面任务引入），无 electron 相关依赖 | 符合（就本任务面） |
| 不改 `desktop-api.d.ts` | `git diff apps/web/src/types/desktop-api.d.ts` 无输出 | 符合 |
| 不改 `.gitignore` | `git status --porcelain .gitignore` 无输出 | 符合 |
| 不改 `packages/db/src/**`、`apps/web/src/**` | 本审计未发现桌面任务对其的改动（dock-refactor 的改动属另一任务面） | 符合（就本任务面） |
| 唯一例外：`apps/server/src/index.ts` 的 stdin 优雅关闭 | `apps/server/src/index.ts:251-281`（stdin 通道），改动面限于此 | 符合 |
| 不改 dock-refactor 产物 / 不跑 git 回退类命令 / 不清 `D:\Temp` / 不做 mac/Linux/arm64 | 本审计未见相关动作 | 符合（就本任务面） |

### D20 风险表（ADR:899-922）

| 风险 | 落地代码 | 判定 |
| --- | --- | --- |
| R1 `--import tsx` 可用性（退路 `tsx cli.mjs`） | 首选/备选均在 `server-process.ts:485-508` + `main.ts:316-328` | 静态符合；运行期未验证 → §6 |
| R2 asarUnpack + ABI 重建与 junction | `paths.ts:465-514`；**打包产物形态未验证且存在 DEV-10 结构问题** | 未验证（并见 DEV-10） |
| R3 stdin 触发 `closeGracefully` | `apps/server/src/index.ts:251-281`；运行期未验证 | 静态符合 / 未验证 |
| R7 `files` 的 `!node_modules/**/*` 与 asarUnpack 冲突 | 实测源码中已删除该项（`package.json:39-42`）；`electron-builder.yml:31-38` 注释记录实测理由 | 已处置（偏离 D16.2 字面 → DEV-01） |
| R8 `artifactName` 覆盖优先级 | 未做打包实测核对 → 未验证 | 未验证 → §6 |
| R9 yauzl/adm-zip 实际版本 | `yauzl` 3.4.0、`adm-zip` 0.5.18（均满足） | 符合 |
| R13 便携版 userData 落点 | 未做便携版实测 → 未验证 | 未验证 → §6 |
| 已知不修复 3 条（未签名 SmartScreen、子进程重启后 JWT 失效、`handleFatal` 不退出进程） | 与 ADR 一致，不列为偏离 | 符合 |

### D21 验收映射（ADR:926-937）

| 验收项 | 证据 | 判定 |
| --- | --- | --- |
| ①NSIS+portable 产物齐、命名冻结 | NSIS 与 `@noveldesktop-0.1.0-x64.nsis.7z` 存在；**Portable 产物在审计时缺失**（`Get-ChildItem -Recurse -Filter *Portable*` 空） | 未验证（属 t2 待办，非本次审计判定） |
| ②更新器实现与安全三项 | 见 D14.3（符合） | 符合 |
| ③外壳/IPC 契约 | 见 D11/D12（符合） | 符合 |
| ④端到端实测 | 属 t4 | 未验证 |
| ⑤日志/备份/junction 落点 | `logger.ts:163-173`、`paths.ts:331-394,425-517`、`updater/backup.ts:101-130`（静态符合）；运行期未验证 | 符合（静态）/ 未验证（运行期） |
| ⑥`release/updates/` 产出 | 实测存在且 sha256 独立复核一致 | 符合 |
| ⑦干净仓库构建 | 未做（依赖 t2 重跑） | 未验证 |
| ⑧不做清单 | 见 D19/D16.4 | 符合 |

---

## 2. 专项：D14.5 应用更新切换流程 a–i

全部位于 `apps/desktop/src/updater/index.ts` 的 `applyApp()`（`:532-718`）。

| 步骤 | 冻结要求 | 代码位置 | 判定 |
| --- | --- | --- | --- |
| a | 下载 `manifest.app.url` → `updates/downloads/<sha>.zip` | `:551`（路径）、`:553-557`（`resolveArtifactUrl`）、`:560-562`（`downloadToFile`） | 符合 |
| b | SHA-256 校验 | `:561`（`expectedSha256`，由 `http.ts:139-215` 实现）、`:563-567`（失败即中止） | 符合 |
| c | 备份 `app-runtime/{app-server,web-dist}` → `backups/<oldVersion>/` | `:569-586`（`app-server` 排除 `['data']`、`web-dist` 全量） | 符合 |
| d | 安全解压到 `updates/extract/<sha>/` | `:588-598`（`extractZipSecurelyLazy`） | 符合 |
| e | 替换 `apps/`/`packages/`/`node_modules/`/`pnpm-workspace.yaml`，绝不动 `data`、`plugins/` | `:635-647`（`APP_REPLACE_ENTRIES` 循环 + `neverTouch` 双保险 `:638`；`data`/`plugins` 在 `updater/types.ts:165`） | 符合 |
| f | 替换 `web-dist` | `:660-661` | 符合 |
| g | 重建 D7.3/D7.4 junction | `:617-629`（替换前校验）、`:664-679`（替换后复检 + 失败回滚；D7.4 仅 warn） | 符合 |
| h | 更新 `version.json` | `:681-697`（`.tmp` + `rename` 原子写，失败回滚） | 符合 |
| i | 返回 `{ok:true,version,notes}` | `:701-706` | 符合 |
| ③ | 1200 ms 后 `updaterRelaunch()` | `apps/web/src/components/settings/UpdateSection.tsx:88`（`setTimeout(() => void api.updaterRelaunch(), 1200)`） | 符合 |
| ④ | 优雅关闭子进程 + `app.relaunch()` + `app.exit(0)` | `apps/desktop/src/main.ts:168-172`（`shutdownAndRelaunch`） | 符合 |
| 兜底 | 任一异常 ⇒ 回滚 + `{ok:false,error}`（不 reject） | `:707-717`（`restoreFromBackup` `:724-761`） | 符合 |

**结论**：D14.5 a–i 步骤齐全、顺序正确、失败路径具备回滚与「决不 reject」保证。**符合**。

---

## 3. 专项：D14.3 三项强制安全验收（实现位置 + 失败路径）

### D14.3-① SHA-256 流式校验 —— **符合**

- 实现：`apps/desktop/src/updater/http.ts:139-215`（`downloadToFile`）。`:151` `const hash = createHash('sha256')`，在 `Transform` 回调中对每块 `hash.update(chunk)`（**流式**，不整包入内存）；`:194` `req.setTimeout(timeoutMs)`；`:157` 超 `MAX_DOWNLOAD_BYTES`（512 MB）抛 `too-large`。
- 比较：`http.ts` 用 `sha256HexOfBuffer`/`digest('hex')`（小写十六进制）；契约侧 `apps/desktop/src/updater-manifest.ts:29` `SHA256_LOWER_HEX_RE = /^[0-9a-f]{64}$/`（**拒绝大写**），`:109` 处校验。
- 失败路径（逐条核对）：
  1. 哈希不一致 ⇒ `:204` 先 `rm` 临时文件，再 `:212` 抛 `UpdaterHttpError('hash', 'SHA-256 校验失败：期望 …，实际 …')`；
  2. 调用方 `updater/index.ts:563-567` 捕获 ⇒ **立即 `return`，注释 `:564` 明示「绝不进入解压」**，返回 `{ok:false, error:'下载失败或 SHA-256 校验未通过：…'}`；
  3. 任何下载侧失败（network/timeout/too-large/status）同样在 `:563` 分流，不触及解压分支。
- 结论：满足「校验失败绝不进入解压」；**符合**。

### D14.3-② 解压防路径穿越 —— **符合（路径穿越与符号链接）/ 硬链接未覆盖**

- 实现：`apps/desktop/src/updater/zip.ts:299-393`（`extractZipSecurely`）。**两阶段设计**：
  - 阶段 1（`:303-322`，写盘前全量校验）：无文件条目拒；`:310-311` `(mode & S_IFMT) === S_IFLNK` ⇒ `ZipSecurityError`；`:315` 加密 entry（general purpose flags bit0）拒；`:319` 压缩方法非 0（stored）/8（deflate）拒；`:322` 对每条 entry 调 `assertSafeEntryName`。
  - `assertSafeEntryName`（`:95-134`）拒绝：空名（`:99`）、NUL/控制字符 `[\u0000-\u001f\u007f]`（`:103`）、前导 `/`（`:111`）、盘符 `/^[a-zA-Z]:/`（`:112`）、URL 形态（`:113`）、`..` 段（`:117`）、`.` 段（`:118`）、Windows 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`，`:75-79`、`:121-124`）、`path.resolve(destRoot,entryName)` 的 `startsWith(destRoot+path.sep)` 兜底（`:127-131`）。
  - 阶段 2（`:338-374`，写盘前逐文件终检）：父目录（`:340-341`）与目标路径（`:343-344`）越界复核；`:349` 数据区越界；`:364-367` 长度校验；`:368-372` CRC-32 校验（`zlibCrc32(data)>>>0 !== entry.crc32>>>0`）。
- 失败路径：
  1. 阶段 1 任一不合规 ⇒ **在写出任何文件之前**抛错（`:309-322`），即「整包拒绝」；
  2. 阶段 2 任一异常 ⇒ `:383` `fsp.rm(root, {recursive:true, force:true})` 清理已写内容；`:387-389` 无文件条目亦 `rm` 后抛；
  3. 调用方 `updater/index.ts:591-597` 捕获 ⇒ 返回 `{ok:false, error:'解压失败（可能含路径穿越等不安全条目），已中止更新：…'}`，且解压目录在 `:590` 已先 `removeTreeSafely`。
- **偏离（低）**：ADR 要求「拒绝符号链接**与硬链接** entry」，实现仅按 Unix 外部属性判 `S_IFLNK`；ZIP 中硬链接会退化为普通文件（`S_IFREG`），无 link-count 检测。此外 `zip.ts:137-141` 的 `isLinkEntry()` **恒 `return false`（死代码桩）**。→ DEV-06（Windows 目标平台不产生 ZIP 硬链接，实际风险低）。

### D14.3-③ 旧版本自动备份 —— **符合**

- 实现：`apps/desktop/src/updater/backup.ts:101-130`（`backupDir(backupsDir, oldVersion, label, srcDir, excludeNames)`）：`:108` `safeVersion` 做 `[^A-Za-z0-9._-] → '_'` 清洗；`:109` 目标 `<backupsDir>/<safeVersion>/<label>`；先 `rm` 旧备份（幂等）；`:123` `copyDirRecursive`。
- 调用：`apps/desktop/src/updater/index.ts:574-581` —— `app-server` 的备份传入 `['data']` 排除（`:572-573` 注释先 D7.3 红线：`app-server/data` 是 junction，必须排除以免把用户数据复制进备份）；`web-dist` 全量。
- 失败路径：`:125` 抛 `BackupError('备份失败: …')`；调用方 `:583-586` 捕获 ⇒ 返回 `{ok:false, error:'备份失败，已中止更新：…'}`，**在解压/替换之前中止**。
- 备注（低）：`backup.ts:113-116` 在源目录缺失/非目录时返回 `{bytes:0}` 视为「无需备份」而非失败，属边界放宽 → DEV-14。

---

## 4. 静态一致但**无运行期证据**的项（遵「未验证 ≠ 符合」）

见 §6。

---

## 5. 偏差清单（结构化：`{id,severity,problem,requiredFix,file,line}`）

| id | severity | problem | requiredFix | file | line |
| --- | --- | --- | --- | --- | --- |
| DEV-01 | medium | `build.files` 缺 D16.2 冻结第三项 `!node_modules/**/*`，与 ADR:759-763 逐字不符 | 依 D16.2 末注走「人工确认」：若保留删除，需在 ADR 修订记录中把该行正式标注为「经实测移除」；若坚持逐字，则须同时解决 asarUnpack 落空（见 DEV-10）后再恢复该项 | `apps/desktop/package.json` | 39-42 |
| DEV-02 | low | D2 冻结 `src/updater.ts` 单文件，实现为 `src/updater/**` 目录（8 文件）；并多出 ADR 未列的 `src/desktop-api.ts` | 在 ADR 修订记录中登记「多文件模块目录 + 共享类型文件」为已裁定的实现细节，避免后续按字面判定「缺失」 | `apps/desktop/src/updater/`、`apps/desktop/src/desktop-api.ts` | 1-880（目录）、1-145 |
| DEV-03 | low | D16.1 要求 build 块内嵌，仓库另存 `apps/desktop/electron-builder.yml`（ADR D2 清单外镜像，83 行） | 保留或删除皆可，但须在 ADR 注明其为「非加载路径的镜像/参考文件」，避免双重真源 | `apps/desktop/electron-builder.yml` | 1-83 |
| DEV-04 | low | D14.4 要求 `updaterGetState().appVersion` 取 `version.json`（缺失才回落 `app.getVersion()`）；实现恒为 `app.getVersion()`，`version.json` 仅被 `paths.ts:559` 用于播种判断 | 若需字面一致：`createUpdater` 时读 `app-runtime/version.json` 的 `appVersion`，缺失或损坏才回落 `app.getVersion()`；否则在 ADR 记录语义等价性 | `apps/desktop/src/updater/index.ts`、`apps/desktop/src/main.ts` | 408-415、368 |
| DEV-05 | low | D14.2 要求 `pluginUpdates` 为「仅版本高于本地」的子集；实现额外纳入「未安装」与「本地无 `plugin.json`（version=null）」的插件 | 在 ADR 记录该语义扩展（`installPlugin` 全新安装路径必需），或在 UI/文档层明确「可安装」状态与「可更新」状态的区别 | `apps/desktop/src/updater-manifest.ts` | 277-303 |
| DEV-06 | low | D14.3-② 要求拒绝符号链接**与硬链接** entry；实现仅按 Unix mode 判 `S_IFLNK`，无硬链接检测；`isLinkEntry()` 为恒 false 的死代码 | 删除死代码桩；若接受「Windows 平台不产生 ZIP 硬链接」的论证，须在 ADR/代码注释中显式登记为已评估的可接受偏差 | `apps/desktop/src/updater/zip.ts` | 137-141、299-322 |
| DEV-07 | low | D17.4 要求「读用 yauzl ^3.4.0」；实现自实现 ZIP 读取器（`zip.ts:10-14` 自述理由：仓库无 yauzl 实体） | 在 ADR 登记实现选择（自实现读取器，校验语义等同）；或改用 yauzl 并保持校验语义逐字不变 | `apps/desktop/src/updater/zip.ts` | 10-14、163-270 |
| DEV-08 | low | D12.2 写开发 origin 为 `localhost:5173`；仓库 `apps/web/vite.config.ts` 实际端口为 5174（strictPort） | ADR 更正为 5174（或同时放行两者并注明）；当前实现已双放行（`window.ts:34`）并注释登记 | `apps/desktop/src/window.ts` | 26、34 |
| DEV-09 | medium | D4.2 负载基线为 189 packages / 107768288 B；实测 payload/app-server = **265 包 / 252475413 B（+134 MB）**，成因是 `collectRootDeps` 把 5 个磁盘插件的 `dependencies`（多为 web 侧包：`lucide-react` 27.3 MB、`three` 22.1 MB、`date-fns` 21.6 MB、`react`、`@tiptap/*`、`@xyflow/react` 等）纳入闭包 | 明确插件在服务端的运行期依赖边界（插件后端代码是否 `import` 这些 web 包）；若不需要，改为按插件**后端入口**的静态分析收窄闭包，否则在 ADR 更新基线并说明 | `apps/desktop/scripts/build-server-payload.mjs` | 80-115、118-142 |
| DEV-10 | high | `extraResources` 的源根 `node_modules` 被 electron-builder 内置过滤（`node_modules/app-builder-lib/out/util/filter.js:43`：`if (relative === "node_modules") return false;`），实测 `release/desktop/win-unpacked/resources/app-server` **无 `node_modules`**。而 `paths.ts:465-514` 的 D7.4 junction / better-sqlite3 junction 均以 `<app-server>/node_modules` 存在为前提 ⇒ 打包产物缺失第三方闭包与 `tsx`，服务端子进程将无法启动 | 以 D20-R2 退路落地：改用 `afterPack`/显式打包步骤把 `payload/app-server/node_modules`（含 `tsx`）投递进 `resources/app-server/`（例如 `extraResources` 指向一个不以 `node_modules` 为根名的中间目录，或改用 `extraFiles`/`afterPack` 复制）；随后按 D8.2 把 `better-sqlite3` 指向 `app.asar.unpacked`。改动后须重跑 `--win dir --x64` 冒烟并核对 `resources/app-server/node_modules/tsx` 与 `better_sqlite3.node`（1921024 B） | `apps/desktop/package.json`、`apps/desktop/src/paths.ts` | 49-53、465-514 |
| DEV-11 | low | D15 冻结命令使用 `apps\desktop\node_modules\.bin\electron-builder.cmd`；实现用裸 `electron-builder` | 在 ADR D15 注明 npm script 内的裸命令等价（pnpm 会注入本地 `.bin` 到 PATH），或改用显式路径 | `apps/desktop/package.json` | 14-15 |
| DEV-12 | low | D18-A 要求 `apps/web/src` 与 `apps/plugins/**` 内 9 类符号命中为 0；复测命中 2 处：`desktop-api.d.ts:3`（仅注释）、`ui-kit/src/ErrorBoundary.tsx:55`（`process.env.NODE_ENV`） | 注释可豁免（非代码路径）；`ErrorBoundary.tsx:55` 建议改用 Vite 注入常量（如 `import.meta.env.DEV`）或在 ADR 登记「`apps/plugins/**` 的 `process.env` 字面命中已评估为构建期替换、非 Electron 能力泄漏」 | `apps/web/src/types/desktop-api.d.ts`、`apps/plugins/shared/ui-kit/src/ErrorBoundary.tsx` | 3、55 |
| DEV-13 | low | D12.2/D5.3 要求启动失败 `app.exit(1)`；实现 `fatal()` 内调 `shutdownAndExit(code)`，但 `before-quit` 处理器（`main.ts:553-561`）会 `preventDefault` 并改走 `shutdownAndExit(0)`，故真实退出码可能为 0 | 在 `before-quit` 中记录/传递预期退出码，确保失败路径最终退出码为 1（或忽略编码但登记为已知偏差） | `apps/desktop/src/main.ts` | 175-183、553-561 |
| DEV-14 | low | D14.3-③ 要求「替换前先整体复制旧目录」；`backupDir` 在源目录缺失时返回 `{bytes:0}` 视为成功（不中止） | 若源目录缺失即视为异常并中止；或明确登记「首次更新无旧目录可备份」为允许路径 | `apps/desktop/src/updater/backup.ts` | 113-116 |
| DEV-15 | info | D17.4/D16.2 末注两条「需人工确认」项：`artifactName` 覆盖优先级、`files` 的 `!node_modules/**/*` —— 本次审计给出结论：前者以更具体的 `nsis/portable.artifactName` 为准（已分别冻结，无歧义）；后者删除是**必要**的（否则 asar 内零 node_modules），但须与 DEV-10 的投递方案一并处置 | 见 DEV-01 与 DEV-10 的 requiredFix | `apps/desktop/package.json` | 39-42、56、68、72 |

---

## 6. 未验证清单（缺什么证据，谁负责补）

| # | 项 | 缺失证据 | 归属 |
| --- | --- | --- | --- |
| 1 | electron-builder 正式打包产物形态 | `resources/app-server` 是否带 `node_modules`（当前**否**）、`web-dist`/`seed-plugins` 是否齐、`app.asar.unpacked` 三项与 `better_sqlite3.node`（1921024 B）、portable 产物、`artifactName` 实际取值 | t2（重跑）+ t4（端到端） |
| 2 | D8.3 sql.js 回退 + D8.4 打包后 `pnpm install` 复原 | 运行期实测（当前 `.node` 为 ABI 137 副本 1919488 B，未见 ABI 149 副本） | t2/t4 |
| 3 | D20-R1 `--import tsx` 在 Electron-as-Node 的可用性 | 真机启动日志（是否落到 `cli` 备选） | t4 |
| 4 | 首次启动播种、D7.2 六步、D7.3/D7.4 junction 建立 | 干净 `userData` 的真机首次启动记录 | t4 |
| 5 | D13.4 退出时序（写 stdin → 5 s → taskkill /T /F → exit 0）与 D12.4 崩溃重启（60 s × 3） | 真机进程级实测 | t4 |
| 6 | D20-R13 便携版 userData 落点 | 便携版实测 | t2/t4 |
| 7 | D12.5 操作纪律（启动 GUI 前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`） | 打包态真机启动脚本/记录 | t4 |
| 8 | D19「不改 `apps/web` 运行期依赖」的**全量**核实 | 本次仅核 `apps/web/package.json` diff（仅 dockview 两条） | 收尾报告 |

---

## 7. 证据方法（可复现）

- **字面比对**：对每个冻结字面量，用 `Select-String`/逐行读取定位 `file:line`，并与 ADR 原文逐字对照（IPC 通道名、webPreferences 五项、健康判据、正则、超时常量、`APP_REPLACE_ENTRIES`、`artifactName` 模板等）。
- **关键函数逐行阅读**：`updater/index.ts`（880 行）、`updater/zip.ts`（402 行）、`server-process.ts:402-468`（退出时序）、`paths.ts:331-592`（播种/junction）、`main.ts:145-583`、`scripts/build-update.mjs`（400 行）。
- **electron-builder 行为溯源**：读 `node_modules/app-builder-lib/out/util/filter.js:35-52` 与 `fileMatcher.js`，确认 `extraResources` 源根 `node_modules` 被过滤的机制（DEV-10 的根因）。
- **制品独立复核**：`release/updates/manifest.json` 的 6 条 sha256 用 `Get-FileHash` 逐字复核（全部一致）；zip entry 名用 `adm-zip` 实读（前导 `/`、`..`、盘符 `bad=[]`）。
- **边界扫描**：D18-A 全目录扫描（排除 `node_modules`/测试）；`.node` 白名单扫描；`git status`/`git diff` 核对未改动面。

---

## 8. 给下游的行动建议（按优先级）

1. **DEV-10（高）**：先解决 `extraResources` 源根 `node_modules` 被过滤的问题 —— 否则正式打包出的安装包/便携版**无法启动服务端**，t4 的端到端实测必然失败。建议按 D20-R2 退路（`afterPack` 或改投递根名）实施，并同步核对 `better_sqlite3.node` 落点。
2. **DEV-01（中）**：把 `files` 第三项的处理结论写进 ADR 修订记录（当前删除是必要的，但需与 DEV-10 一并锁定）。
3. **DEV-09（中）**：收窄服务端插件闭包，避免把 web 侧依赖（约 +134 MB）打进更新包与安装包。
4. 其余低危项（DEV-02…−08、−11…−15）建议在收尾报告中集中登记为「已知可接受偏差」或按需修正；其中 DEV-15 明确了两条「需人工确认」项的审计结论。

---

*本报告为只读审计产出，未修改任何实现文件。所有判定均附 `file:line`；凡无独立证据者已标注「未验证」。*
