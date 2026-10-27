# 砚舟 桌面端打包与更新器 —— 收尾报告（t6）

- **任务**：t6 — 汇总交付物清单 / 逐条验收结论 / 残余风险 / 安装与使用说明
- **契约基线**：`docs/architecture/desktop-packaging-adr.md`（ADR-0008，状态**已冻结**，2026-10-02）
- **依赖前置**：t2（打包）、t3（外部审计）、t4（评审）、t5（端到端验证）均已完成
- **本报告性质**：**唯一新增文件**（不改 `release/**`，不改实现代码）
- **证据来源约定**：`[t1]`/`[t2]`/`[t3]`/`[t4]`/`[t5]` = 对应任务产出；`[本报告]` = 本次收尾期间现场复核；`[ADR]` = 冻结条款本身

---

## 1. 交付物清单（路径 + 字节数）

### 1.1 安装/便携产物 `F:\new1.2\release\desktop\`（2026-10-03 19:13 那轮正式打包）

| 文件 | 字节数 | SHA-256 | 来源 |
| --- | --- | --- | --- |
| `砚舟-Setup-0.1.0-x64.exe` | 177,697,975 | `1D53021050DE2929EC59CF3F03E74B62ED741F28C7FEB8D61A43A14DC49EB4D1` | `[t5]`/`[本报告]` |
| `砚舟-Setup-0.1.0-x64.exe.blockmap` | 180,795 | `6F4C1B7413983CD2F5D09286BB5FAB5103C7998E6A3C76C78979E1AB4009BB15` | `[t5]`/`[本报告]` |
| `砚舟-Portable-0.1.0-x64.exe` | 177,302,758 | `DDDF3A98CB2C7E75DB55FEEC0F1A134B4FB6CAF9CF2CB2353D8AC8D8D2D27ECB` | `[t5]`/`[本报告]` |
| `win-unpacked\砚舟.exe` | 245,877,248 | `C65C770A6FFFC5991F3AE9A94EDF368955B17E016AF04096CC4A7C973A345833` | `[t5]` |
| `win-unpacked\resources\app.asar` | 778,506 | — | `[t5]` |
| `win-unpacked\resources\app-server\`（214 个顶层包） | 222,591,959 | — | `[t5]` |
| `win-unpacked\resources\app-server\node_modules\better-sqlite3\...\better_sqlite3.node` 等价物（asar.unpacked 侧） | 1,921,024 | — | `[t5]`（= D20-R2 冻结值） |
| `builder-debug.yml` | 6,041 | `15D7357863DE12D611DEE40A23817B38AD974695091CCB830A35BB7B40121D9E` | `[本报告]` |
| `K1__uninstaller.exe`（历史残留中间物，非交付物） | 36,859 | `83F0023272DE348249C9F16B7C4CEEB8BEE13C711FD9623693687DA29B3EA1DC` | `[t2]`/`[本报告]` |

> 注：`[t2]` 报告的是 18:47 那一轮（132,393,031 / 131,997,821 B）；`[t5]` 与 `[本报告]` 复核的是 **19:13 最后一轮**（177,697,975 / 177,302,758 B）。**当前磁盘上的产物即 19:13 那轮**，字节数与哈希以本表为准。

### 1.2 更新源 `F:\new1.2\release\updates\`（`[t1]`，恰 7 项）

| 文件 | 字节数 | SHA-256（前 8 位，`[t4]` 独立复算 MATCH） |
| --- | --- | --- |
| `manifest.json` | 2,431 | —（schema 10/10 PASS） |
| `novelmuse-app-0.1.0.zip` | 69,076,232 | `f8008010…57ef` |
| `novel.auto.workbench-0.1.0.zip` | 11,096,747 | `627e2389…b2bd` |
| `novel.manual.workbench-0.1.0.zip` | 11,334,357 | `45347780…ec89` |
| `novel.autowrite-0.1.0.zip` | 5,353,042 | `bd663b7d…3372` |
| `novel.bookscan-0.1.0.zip` | 7,258 | `d74afd1a…df84` |
| `novel.typography-0.1.0.zip` | 7,263 | `b3ad4182…6576` |

### 1.3 代码与配置交付物

| 路径 | 字节数 | 说明 |
| --- | --- | --- |
| `apps/desktop/scripts/build-update.mjs` | 17,398 | `[t1]` 新建：D17 发布工具（幂等、字节级可复现） |
| `apps/desktop/scripts/build-server-payload.mjs` | 11,794 | server 负载生成 |
| `apps/desktop/scripts/bundle-shell.mjs` | 4,028 | 壳代码打包（esbuild） |
| `apps/desktop/scripts/gen-icon.py` | 3,735 | 图标生成 |
| `apps/desktop/src/main.ts` | 21,834 | 主进程（生命周期 D12） |
| `apps/desktop/src/server-process.ts` | 28,596 | server 子进程与端口握手 D5 |
| `apps/desktop/src/paths.ts` | 21,542 | userData 布局 D7 + junction |
| `apps/desktop/src/updater/index.ts` | 33,854 | 更新器主体 D14 |
| `apps/desktop/src/updater/zip.ts` | 15,792 | 解压安全 D14.3 |
| `apps/desktop/src/updater-manifest.ts` | 11,323 | manifest 解析 D14.2 |
| `apps/desktop/src/{env,logger,window,preload,ipc-channels,types,desktop-api}.ts` | 8,753 / 8,174 / 7,707 / 5,402 / 2,242 / 6,394 / 5,131 | D6 / D12.4 / D12.2 / preload / D11 / 类型 / 共享 API |
| `apps/desktop/src/updater/{backup,config,http,plugins,semver,types}.ts` | 4,437 / 3,885 / 8,169 / 4,833 / 2,972 / 5,852 | D14.3-③ / D14.1 / 下载 / 插件安装 / 版本比较 / 类型 |
| `apps/desktop/build-resources/{icon.ico,icon.png}` | 187,891 / 527,794 | D10 图标（目录名符合约束③） |
| `docs/reports/desktop-shell-audit.md` | 52,141 | `[t3]` 审计报告 |
| `docs/reports/desktop-e2e-verification.md` | 23,524 | `[t5]` 端到端验证报告 |
| `docs/reports/desktop-packaging-closeout.md` | 本文件 | `[t6]` 收尾报告 |
| `apps/desktop/package.json` | **320** | ⚠️ 见 §3「配置漂移」——**已不含 `build` 块** |
| `apps/desktop/electron-builder.yml` | 4,377 | 非加载路径的镜像文件（DEV-03） |

---

## 2. 逐条覆盖：ADR D1–D21 + D17（含证据来源）

判定基于 `[t3]` 审计（代码层）+ `[t5]`/`[本报告]` 实测（运行期）。`符合` = 冻结字面与实现/产物一致；`偏离` = 实现了但语义或形态与冻结字面不同（附 DEV 编号）；`未验证` = 无独立证据。

| 条目 | 结论 | 证据来源与要点 |
| --- | --- | --- |
| **D1** 产物矩阵 | **符合** | `[t3]`：`package.json` 各字段就位；`[本报告]`：产物恰为 `砚舟-Setup-0.1.0-x64.exe` / `砚舟-Portable-0.1.0-x64.exe`，无 mac/Linux/arm64 产物 |
| **D2** 文件清单与约束 | **偏离（低）** DEV-02 | `[t3]`：清单内文件齐备；唯 `src/updater.ts` 实现为 `src/updater/**`（8 文件），并多出 `src/desktop-api.ts`（ADR 未列）。约束①②③均满足 |
| **D3** 依赖与安装纪律 | **符合** | `[t3]`：D3.2 版本全部匹配；`[本报告]`：`node_modules` 实装 electron 44.5.1 / electron-builder 26.15.3 / esbuild 0.28.2 / typescript 5.9.3 / better-sqlite3 12.11.1 / yauzl 3.4.0，且 `node_modules\.bin\electron-builder.cmd` 在位 |
| **D4** server 运行模式（Mode B） | **符合** | `[t5]`：三形态 server 子进程命令行均为 `…\砚舟.exe --import tsx …\apps\server\src\index.ts`，探针 `plugins=27`。**DEV-09**：Mode B 闭包 265 包 / 252,475,413 B 超 D4.2 基线 189 包 / 107,768,288 B |
| **D5** 端口握手 | **符合** | `[t5]`/`[本报告]`：每次启动端口不同（58828 / 64454 / 57220 / 59924 / 58556 / 49334 / 53501 / 49718），均记 `端口握手成功：http://127.0.0.1:<port>（来自子进程 stderr，D5.1）` 且探针通过 |
| **D6** 环境变量契约 | **符合** | `[t5]`：`D6 环境变量装配完成：注入 78 项（win-unpacked）/ 79 项（安装版）/ 82 项（便携版）`，JWT 复用/新生成逻辑正确 |
| **D7** userData 布局 | **符合** | `[t5]`：首启后 `app-runtime/`、`data/`、`plugins/`、`backups/`、`logs/`、`updates/` 全部按 D7.1 落盘；junction 三项日志断言为真 |
| **D8** better-sqlite3 ABI + D8.2 junction | **符合** | `[t5]`：`better_sqlite3.node` = 1,921,024 B；`/api/health.database === 'connected'` |
| **D9** sql-wasm.wasm | **符合** | `[t3]` 代码层符合；回退路径未触发（`[t5]` 未观察到 sql.js 回退日志） |
| **D10** 图标 | **符合** | `[t3]`：`build-resources/{icon.ico,icon.png}` 存在，源为 `apps/web/public/images/bamboo-ink.png` |
| **D11** desktopAPI + IPC | **符合** | `[t5]`：日志 `已注册 9 条 IPC 通道（D11.2）`；`[t5]` renderer 正常加载前端 |
| **D12** 生命周期 | **符合（含 DEV-13）** | `[t5]`：`砚舟 桌面壳启动完成（D12.3 全部 8 步已完成）`、`主窗口 ready-to-show ⇒ 显示窗口（D12.2）`、单实例 `收到 second-instance ⇒ 已聚焦既有窗口（未创建新窗口）`。DEV-13：启动失败路径经 before-quit `preventDefault` 改走 `shutdownAndExit` |
| **D13** 优雅退出（stdin） | **符合** | `[t5]`：`向 stdin 写入 "novelmuse:shutdown"` → `server 子进程已退出（exitCode=0）` → `数据库已在 closeGracefully() 中落盘`；`server.err.log` 见 `[Server] 收到 stdin，正在优雅关闭...`。**R3 闭环** |
| **D14 / D14.1** 更新器总则 | **符合** | `[t3]` 代码层；`[t4]` 更新源 schema 10/10 PASS |
| **D14.2** `manifest.json` 字段 | **符合** | `[t4]`：顶层 `{version,notes,publishedAt,app,plugins}`；`plugins` 恰 5 条，每条 `{id,name,version,url,sha256,notes}`；`[本报告]`：`publishedAt="2026-10-03T08:26:12Z"`、`app.sha256=f8008010…57ef`。**`compareVersions` 预发布后缀（R12）已单测 15/15 通过**（§3.4） |
| **D14.3** 安全三项 | **偏离（低）** DEV-06 / DEV-14 | ①SHA-256 校验 `[t3]` 符合；②路径穿越 `[t3]` 符合，唯硬链接检测缺失（`isLinkEntry()` 恒 false 死代码）；③旧版本备份在源目录缺失时返回 `{bytes:0}` 视为成功 |
| **D14.4** updater 状态与路径 | **偏离（低）** DEV-04 | `[t3]`：`updaterGetState().appVersion` 恒为 `app.getVersion()`，未按 ADR 取 `version.json`（后者仅用于播种判定） |
| **D14.5** 更新源协议限制 | **符合** | `[t3]`：仅允许 `http:`/`https:`；单文件 512 MB、下载超时 120 s |
| **D15** 打包与验证命令 | **偏离（低）** DEV-11；**并有一处实证更正** | DEV-11：npm script 内用裸 `electron-builder`（pnpm 注入本地 `.bin`，等价）。**更正**：ADR 写「在 `F:\new1.2` 执行」，`[t2]` 实测**必须 `cwd=F:\new1.2\apps\desktop`**（仓库根 `package.json` 无 `build` 键 ⇒ 读不到配置）。`[本报告]` 复核：`apps/desktop` 为正确 projectDir |
| **D16 / D16.1** 配置块位置与形态 | **⚠️ 偏离（中）** 现场已不成立 | `[t3]` 审计时符合（build 块内嵌）；**但 `[本报告]` 复核发现 `apps/desktop/package.json` 于 2026-10-03 19:26:48 被改写为 320 B，`build` 块、`devDependencies`、`scripts` 全部消失** ⇒ 当前**违反 D16.1**。详见 §3.1 |
| **D16.2** 逐字配置块 | **偏离（中）** DEV-01；**且已不可达** | DEV-01：`files` 缺第三项 `!node_modules/**/*`（经实测移除是必要的，见 DEV-15）；`extraResources` 为 4 条（含 DEV-10 修复条目，ADR 冻结为 3 条）。因 §3.1，当前逐字复现已不可能 |
| **D16.3** asarUnpack 理由 | **符合** | `[t5]`：`app.asar.unpacked/node_modules/{better-sqlite3,bindings,file-uri-to-path}` 三者在场 |
| **D16.4** 不做项 | **符合** | `[t5]`：无 Squirrel/签名/notarize 痕迹；`allowBuilds` 未改 |
| **D17 / D17.1–D17.4** 更新器与 `release/updates/` | **符合（R-1 低风险）** | `[t1]`：`build-update.mjs` 跑通 5 次 EXIT=0；`[t4]`：7/7 产物 PASS、schema 10/10 PASS、6/6 sha256 独立复算 MATCH、幂等复跑哈希不变、yauzl 读回 52,335 entry 违规 0。D17.4 闭环：adm-zip 实测 **0.5.18**、yauzl **3.4.0** |
| **D18 / D18.1–D18.3** 跨平台洁净度 | **偏离（低）** DEV-12 | `[t3]`：9 类符号复测命中 2 处（`desktop-api.d.ts:3` 仅注释、`ui-kit/src/ErrorBoundary.tsx:55` 用 `process.env.NODE_ENV`）；D18-B/C 符合 |
| **D19** 范围外 | **符合** | `[t3]`：未改动面确认 |
| **D20** 风险清单 | **见 §3** | R1/R2/R3 已闭环；R7/R8/R13 已闭环；R9/R12 已闭环；R4/R5/R6/R10/R11 见 §3.5 |
| **D21** 验收标准映射 | **符合** | 本报告即映射的兑现：全文含 D1–D21 编号条目（本节）；数字均溯源自 §0 F1–F35 与 D20 或标注为现场复核值 |

---

## 3. 残余风险与偏差（必录项加粗）

### 3.1 **配置漂移：`apps/desktop/package.json` 丢失 `build` 块（本报告最重要的发现）**

| 事实 | 证据 |
| --- | --- |
| 当前内容 320 B / 13 行：`name`、`version`、`private`、`description`、`author`、`license`、`main`、`dependencies{better-sqlite3,yauzl}` | `[本报告]` 逐字读取 |
| **无 `devDependencies`、无 `scripts`、无 `build` 块** | `[本报告]`：`has build = False` |
| mtime = **2026-10-03 19:26:48**，晚于 19:13 那次成功打包 | `[本报告]` |
| 19:13 打包日志逐字含 `loaded configuration  file=package.json ("build" field)` ⇒ **当时 build 块还在** | `[t2]`/`[t5]` 构建日志 |
| 全仓搜索无任何代码重写该文件；`apps/desktop/` 整目录**未被 git 跟踪** ⇒ 无法从 git 恢复 | `[本报告]`：`git ls-files apps/desktop` 空；`git show HEAD:apps/desktop/package.json` → `fatal: path ... not in 'HEAD'` |
| 全仓不存在该文件的备份副本 | `[本报告]` |

**影响**：D16.1（build 块须内嵌 `package.json`）与 D3.2/D3.3（devDependencies/scripts 声明）**当前不成立**；若现在按 D15 重跑正式打包，**将读不到任何 electron-builder 配置**（日志不会出现 `loaded configuration … "build" field`），D15 流程不可复现。

**缓释（现状可用）**：依赖实体（`node_modules` 内 electron/electron-builder/esbuild 等齐备）与配置镜像（`apps/desktop/electron-builder.yml` 4,377 B，含 DEV-10 修复）**都还在**；按 yml 头注释，显式 `--config electron-builder.yml` 仍可打包。

**建议处置（需用户/captain 决定，本报告不改码）**：
1. **首选**：从 `electron-builder.yml` + 既有 ADR D16.2 逐字重建 `package.json` 的 `build` 块与 `devDependencies`/`scripts`，使 D16.1 形态复原（AD 中已具备全部字面量，含 DEV-01 移除项与 DEV-10 新增项的裁定结论）。
2. 若裁定「以 yml 为真源」，则须在 ADR 修订记录中正式改判 D16.1，并同步 D15 命令为显式 `--config electron-builder.yml`。
3. 无论哪种，都应把 `apps/desktop/` 纳入 git（当前整目录未跟踪，任何误改都不可回溯）。

### 3.2 **R8 — `artifactName` 覆盖优先级（闭环）**
`[t2]` 实测 + `[t5]` 复核：产物名恰为 `砚舟-Setup-0.1.0-x64.exe` / `砚舟-Portable-0.1.0-x64.exe`，**不存在** `砚舟-0.1.0-x64.exe` 形态 ⇒ **target 专属 `nsis/portable.artifactName` 覆盖 `win.artifactName`，后者仅兜底**。源码依据：`app-builder-lib/out/platformPackager.js:552` `const userSpecifiedPattern = (targetSpecificOptions?.artifactName) || this.platformSpecificBuildOptions.artifactName || <default>`。ADR D16.2 末注①「需人工确认」**可标注为已实测确认**。

### 3.3 **R13 — 便携版 userData 落点（闭环，结论为「不重定向」）**
`[t5]` 实测：便携版运行时 `app.getPath('userData')` = **`C:\Users\1\AppData\Roaming\砚舟`**，与安装版**相同**；便携版只把**运行体**解压到 `$TEMP\<随机名>` 并在退出后 `RMDir /r` 清理，不触碰 userData。源码**未检出** `PORTABLE_EXECUTABLE*` 的消费点。
⇒ 若产品语义要求「便携 = 数据随身」，**当前实现不满足**，需新增 `--data-dir`/读 `PORTABLE_EXECUTABLE_DIR` 的覆盖逻辑（ADR 明确记为**超出本 ADR 范围，须 captain 决定**）。

> ✅ **后续（2026-10-08，ADR D4.7）**：已闭合。方案不是新增 `--data-dir`，而是复用 Electron
> 自带的 `--user-data-dir`：便携版 zip 随包提供 `启动便携版.cmd`，把 `userData` 重定向到
> 解压目录内 `portable-data\`，**应用源码零改动**，数据随文件夹走；同时打包时预置运行时，
> 便携模式首启零等待（12.4 s → 4.1 s）。本节的结论对「直接双击 `砚舟.exe`」的传统
> 模式仍然成立。

### 3.4 **R12 — `compareVersions` 预发布后缀（闭环，加强实现）**
`[本报告]` 用 tsx 直跑 `apps/desktop/src/updater/semver.ts`，**15/15 用例全部 PASS**（`F:\new1.2\.verify-scratch\semver-test.mts` / `.log`）。覆盖：核心段数值比较（`2.0.0 < 10.0.0`、`1.10.0 > 1.9.0`）、`v` 前缀、build metadata 忽略（`1.0.0+build.5 == 1.0.0`）、预发布排序（`1.0.0-beta.1 < 1.0.0`、`beta.10 > beta.9`、`alpha < beta`、数字标识符 < 字母数字标识符、段数少者优先级低）。
实现按 **semver 2.0.0 §11** 处理（比 ADR 写的「按字符串比较」更严格），属对 ADR 的**加强**；D14.2 的 `appOutdated = compareVersions(manifest.version, appVersion) > 0` 语义不变。

### 3.5 其余 D20 风险（如实登记）
| 项 | 状态 |
| --- | --- |
| **R1**（高）`--import tsx` 在 Electron 44.5.1 | **闭环：可用**（`[t5]` 三形态实测，退路未启用） |
| **R2**（高）asarUnpack + ABI + junction | **闭环：通过**（`[t5]` 1,921,024 B + `database=connected`） |
| **R3**（高）stdin 优雅关停 | **闭环：通过**（`[t5]` 三形态） |
| R4（中）Mode B 依赖闭包 | **部分**：`[t5]` 全链路无 `Cannot find package`（`server.err.log` 已 grep 无命中）；**DEV-09 的闭包超基线 134 MB 未解决** |
| R5（中）tsx 把 `.js` 解析到 `.ts`（`ai.ts:1351` 五路由） | **未验证**：`[t5]` 未对 5 个 AI feature 逐一实调（见 §5） |
| R6（中）`@novel-plugins/worldbuilding` 实体副本可解析 | **部分**：`[t5]` `/api/health.plugins[]` 含 `novel.worldbuilding` 且 `status=ok`（27 条全在） ⇒ 运行时解析成功；`[t1]` 亦按 ADR 在更新包中排除该 builtin |
| R7（中）`!node_modules/**/*` 与 asarUnpack 冲突 | **闭环**：`[t3]` + `[t2]` 实测该项是 asarUnpack 失效的原因，**移除是必要的**（DEV-01/DEV-15 结论） |
| R9（中）yauzl / adm-zip 解析版本 | **闭环**：`[t4]` adm-zip **0.5.18**、yauzl **3.4.0** |
| R10（低）`[MODULE_TYPELESS_PACKAGE_JSON]` 警告 | **闭环：未在打包态复现**：`[本报告]` 对 `D:\Temp\t8` 全部 `.log`/`.txt` grep `MODULE_TYPELESS` **0 命中**；`server.err.log` 内容正常 |
| R11（低）打包态 `[Server]` 日志落盘 | **闭环：非空**：`[t5]` `server.err.log` 1,243 B（含基座就绪、优雅关停、路由提示），`server.out.log` 5,669 B |
| **R-1**（`[t4]` 残余，低）`build-update.mjs:207-211` 同版本沿用旧 `publishedAt` | **登记**：版本号不变而载荷变更时，会沿用既有 manifest 的 `publishedAt` ⇒ 发布方应显式传 `PUBLISHED_AT` |

### 3.6 t3 审计的 15 条偏差归属
DEV-01（medium）、DEV-02…DEV-08（low）、DEV-09（medium）、DEV-10（high，**已由 t7 修复并实测落地**）、DEV-11…DEV-14（low）、DEV-15（info）——逐条说明见 `docs/reports/desktop-shell-audit.md` §5。**本报告处置建议**：DEV-10 已闭环；DEV-01/DEV-15 为同一事项的两面（已裁定「移除必要」，须写入 ADR 修订记录）；DEV-09 建议后续收窄闭包；DEV-03 因 §3.1 升级为需正式裁定；其余登记为「已知可接受偏差」。

---

## 4. 安装与使用说明

### 4.1 NSIS 安装版
1. 运行 `砚舟-Setup-0.1.0-x64.exe`。
   - 图形安装：`oneClick=false`，可自选安装目录（`allowToChangeInstallationDirectory=true`）。
   - 静默安装：`砚舟-Setup-0.1.0-x64.exe /S`（实测 285 s，退出码 0）。
2. 默认落点：`%LOCALAPPDATA%\Programs\砚舟`（`perMachine=false` ⇒ 仅当前用户，不写 HKLM）。
3. 会自动创建**开始菜单**快捷方式 `听风细雨`；**不创建桌面快捷方式**（实测确认）。
4. 注册表卸载项：HKCU `…\Uninstall\{GUID}`，`UninstallString = "…\Uninstall 砚舟.exe" /currentuser`。
5. **卸载**：设置 → 应用，或直接运行 `Uninstall 砚舟.exe /S /currentuser`。卸载会删除安装目录与开始菜单项，但**保留 userData**（`deleteAppDataOnUninstall=false`）。
6. 首次启动会弹一次性「管理员初始密码」对话框，密码同时写入 `<userData>\logs\initial-admin-password.txt`（23 B）；**登录后请立即改密**。

### 4.2 便携版
1. 直接运行 `砚舟-Portable-0.1.0-x64.exe`，**无需安装**。
2. **首启自解压约 3 分钟**（解压到 `%TEMP%\<随机目录>`，退出后自动删除）——期间看不到窗口属正常。
3. **注意**：便携版 **不**把数据放在 exe 旁边，`userData` 仍为 `%APPDATA%\NovelMuse`（见 §3.3）。如需「数据随身」，须等后续版本的 `--data-dir` 支持。

> ⚠️ **本节描述的是 0.1.0 的单文件便携 exe（D4.5 形态）**，该形态**已于 D4.6 移除**。
> 0.2.0 起便携版是**绿色 zip**：解压后双击 `启动便携版.cmd`，数据落在解压目录内
> `portable-data\`（数据随身），首启零等待；直接双击 `砚舟.exe` 则是传统模式。
> 详见 ADR D4.7（2026-10-08）。

### 4.3 启动注意（本机环境特有）
- 若在带 `ELECTRON_RUN_AS_NODE=1` 的 shell 里启动（如本机 DSH 终端），Electron 会退化为纯 Node、窗口不出现。**启动前清除该变量**：
  ```powershell
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -EA 0
  Start-Process <exe> -ArgumentList "--user-data-dir=<可选覆盖>"
  ```
- 不要用重定向 stdio 的方式启动（会触发 §4.4 缺陷）。

### 4.4 已知缺陷（非验收项，如实登记）
- **`main.log` EPIPE 自激写盘**：当父进程 stdio 管道被关闭/断开时，`logger.ts` 的 `echoToConsole` 会在 `console.error` 抛 EPIPE → `uncaughtException` 处理器再写日志 → 自激循环，`main.log` 可涨到数 GB。正常双击/分离启动不触发。详见 `docs/reports/desktop-e2e-verification.md` §6。
- **更新源**：`updater` 的 `baseUrl` 为空串时**关闭更新**；要启用更新，把 `release/updates/` 通过 http(s) 暴露并把 `baseUrl` 指向该目录即可（§1.2 即更新源内容）。
- 未签名安装包会触发 SmartScreen 提示（D16.4 明确不做签名）。
- 未安装 VC++/系统缺组件时的行为**未验证**。

---

## 5. 未验证项清单（不得视为通过）

| # | 未验证项 | 缺什么证据 | 归属 |
| --- | --- | --- | --- |
| 1 | **R5**：tsx 在打包布局下把 `.js` 说明符解析到 `.ts`（`ai.ts:1351` 五条 AI 路由） | 需在打包态逐一对 5 个 AI feature 实调 `/api/ai/gateway` | D20-R5 |
| 2 | **R4 的量化部分**：Mode B 闭包是否「够用」 | 已知 265 包（超基线）；缺「哪些包被判为多余」的收窄证据 | DEV-09 |
| 3 | 完整 UI 交互链路（渲染层点击流、编辑器、AI 写作台等） | 本会话无 GUI 交互条件下的点击流验证 | `[t5]` §8 |
| 4 | 自动更新端到端（下载 → 校验 → 解压 → 备份 → 替换 → 重启） | 未搭真实 http 更新源跑一次真实升级 | D14 |
| 5 | 便携版 `PORTABLE_EXECUTABLE*` 语义落地 | 源码未使用；若产品需要须先实现 | D20-R13 |
| 6 | 代码签名 / SmartScreen 放行 | ADR D16.4 明确不做 | D16.4 |
| 7 | `apps/desktop/package.json` 的最终形态裁定 | 需用户/captain 在 §3.1 两个方案中择一 | §3.1 |
| 8 | 冒烟打包 `--win dir --x64` 在当前（漂移后）配置下能否复现 | 因 §3.1，D15 全流程当前不可复现 | §3.1 |
| 9 | `pnpm install` 后 ABI 复原（D8.4 硬性纪律）的现场复核 | 本次未在打包后执行 `pnpm install` | D8.4 |

---

## 6. 一句话结论

19:13 那轮产出的 NSIS 安装版 + 便携版**功能上端到端可用**（启动 / 后端 / 落盘 / 持久化 / 单实例 / 优雅退出 / 安装 / 卸载 全部实测通过），ADR D20 的三项高风险（R1/R2/R3）与 R7/R8/R9/R10/R11/R12/R13 均已闭环；**唯一需要在进入发布前处置的实质性事项是 `apps/desktop/package.json` 于 19:26:48 丢失 `build` 块（§3.1）——它使 D16.1/D15 的复现链当前断裂，但依赖实体与 yml 镜像尚在，可恢复。**

---

*报告生成：2026-10-03（t6，closeout-eng 角色，由本会话直接执行）。本报告为唯一新增文件；`release/**` 与实现代码均未改动。*

---

## 附注：哈希基线重算（2026-10-04）

**结论：§1.1 的表格对应 2026-10-03 19:13 那轮打包，已过期。** 磁盘现存 `release/desktop/` 产物是 **21:13 那轮**（`apps/desktop/package.json` 的 `build` 块恢复之后重新打包的一轮），其字节数与 SHA-256 与 §1.1 不再一致 ⇒ **发布校验以本节表格为准**。§1.1 与 §3.1 为历史记录，原文保留不改。

### A.1 发布产物实测基线

以下全部为本次现场复算值（`Get-FileHash -Algorithm SHA256`，2026-10-04，读取 `F:\new1.2\release\desktop\`）：

| 产物 | 字节数 | SHA-256 | LastWriteTime |
| --- | --- | --- | --- |
| `砚舟-Setup-0.1.0-x64.exe` | 177,697,975 | `15EC9B37B5E5965AEA5E47384291648FE89B23047BDA70DE9ACCBB26FD1A3CC8` | 2026-10-03 21:13:35 |
| `砚舟-Setup-0.1.0-x64.exe.blockmap` | 180,800 | `186AEB2ACB1771D97F9A33372EAEE6F970BFCFE7BE451E6A6355347AB328C1F7` | 2026-10-03 21:13:42 |
| `砚舟-Portable-0.1.0-x64.exe` | 177,302,760 | `CB2FD64BF33FA530B5C49E2E975CA0D1BD5936AAE7B1AB1134A3AFD8AA3C57DC` | 2026-10-03 21:13:43 |

与 §1.1 的逐项差异（证明 §1.1 对应更早一轮）：

| 产物 | §1.1 字节数 | 本节字节数 | 差异 | §1.1 SHA-256 | 本节 SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `砚舟-Setup-0.1.0-x64.exe` | 177,697,975 | 177,697,975 | 0 | `1D53021050DE2929EC59CF3F03E74B62ED741F28C7FEB8D61A43A14DC49EB4D1` | `15EC9B37…3CC8` |
| `砚舟-Setup-0.1.0-x64.exe.blockmap` | 180,795 | 180,800 | **+5 B** | `6F4C1B7413983CD2F5D09286BB5FAB5103C7998E6A3C76C78979E1AB4009BB15` | `186AEB2A…C1F7` |
| `砚舟-Portable-0.1.0-x64.exe` | 177,302,758 | 177,302,760 | **+2 B** | `DDDF3A98CB2C7E75DB55FEEC0F1A134B4FB6CAF9CF2CB2353D8AC8D8D2D27ECB` | `CB2FD64B…57DC` |

`builder-debug.yml` 亦为 21:13 轮产物：6,041 B、mtime 2026-10-03 21:13:44、SHA-256 `EEA3163194E84C41D8A274A861ACDAF20B2E2B7C9A315253666B9D1FB435F565`（§1.1 记录的 `15D73578…D9E` 对应更早一轮）。

### A.2 时间链：21:13 轮 = `build` 块恢复后重新打包

| 实测 LastWriteTime | 事件 |
| --- | --- |
| 2026-10-03 19:26:48 | §3.1 记载的漂移时刻：`apps/desktop/package.json` 被改写为 320 B，`build` / `scripts` / `devDependencies` 全部消失 |
| 2026-10-03 **21:10:54** | `apps/desktop/package.json` **当前** mtime；现内容 **2,547 B**（初版此表误记为 2,512 B——那是字符数），`build` / `scripts` / `devDependencies` **均已恢复** ⇒ 即「恢复」发生的时刻 |
| 2026-10-03 21:11:56 | `win-unpacked/` 目录落盘（`win-unpacked\砚舟.exe` 245,877,248 B，mtime 21:12:16） |
| 2026-10-03 21:13:35 / 21:13:42 / 21:13:43 | `砚舟-Setup-0.1.0-x64.exe` / `.blockmap` / `砚舟-Portable-0.1.0-x64.exe` 依次落盘 |
| 2026-10-03 21:13:44 | `builder-debug.yml` 落盘（打包元数据最后写出） |

`package.json` 的恢复时刻（21:10:54）**早于**全部产物 mtime（最早 21:11:56），且 §1.1 自己声称的 19:13 轮不可能产生 21:13 的 mtime ⇒ **磁盘现存产物即「`build` 块恢复后重新打包」的 21:13 轮**，与 §1.1 表格所描述的 19:13 轮不是同一批文件。

### A.3 限制（不得外推）

- 本附注**只重算了哈希基线**：**未重新打包**、**未验证打包可复现性**；§3.1 的 D15 复现链是否真正复原，仍取决于 `apps/desktop/package.json` 最终形态的裁定。
- 本次**只读取** `release/**`，未改动其中任何文件、未触碰任何 mtime；基线数值全部来自本机 `Get-FileHash -Algorithm SHA256`，非引用历史记录。
- **发布前必须重跑一次正式打包并重新登记基线**；本节数值仅在 `release/desktop/` 产物 mtime 仍为本表所列值时有效。任何一次重打包都会使本节再次过期。
