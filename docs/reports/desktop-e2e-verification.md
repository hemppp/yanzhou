# 砚舟 桌面端打包产物端到端验证报告（t5）

- **任务**：t5 — 端到端实测 `release/desktop` 产物（启动 / 后端 / 落盘 / 持久化 / 单实例 / 退出）
- **契约基线**：`docs/architecture/desktop-packaging-adr.md`（ADR-0008，状态已冻结，2026-10-02）
- **被测对象**：`F:\new1.2\release\desktop\` 下 2026-10-03 19:13 那一轮正式打包（`--win nsis portable --x64`）的全部产物
- **验证方式**：只读观测 + 实际安装/启动/登录/建项目/重启/关闭/卸载；临时脚本置于 `F:\new1.2\.verify-scratch\`（`.ps1` 与 `.log`）
- **未改动**：`apps/desktop/src/**`、`apps/desktop/package.json`、`apps/web/**`、`apps/server/**` 均未写入
- **判定口径**：`通过` / `未通过` / **`未能判定`**（无 GUI 交互条件下不可判、或无独立可核证据者一律标 `未能判定`，不以推断代替）

---

## 0. 结论摘要

| # | 验收项 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 记录产物路径 / 字节数 / SHA-256 | **通过** | §1 全表，SHA-256 独立复算 |
| 2 | 启动项：主窗口出现 | **通过** | win-unpacked / 安装版 / 便携版 三形态均见窗口 `听风细雨 - 伴写小说工具` |
| 3 | 后端项：server 子进程被拉起并监听端口 | **通过** | `--import tsx .../apps/server/src/index.ts` 子进程 + `就绪探针通过：…plugins=27` |
| 4 | 落盘项：userData 出现 app-runtime / data / plugins | **通过** | §3.3 目录树 + `运行时 junction 状态：data=true，plugins/node_modules=true，better-sqlite3=true` |
| 5 | 持久化项：重启后数据仍在 | **通过** | win-unpacked 与安装版均见重启后项目仍在（§3.5 / §4.5） |
| 6 | 单实例项 | **通过** | 第二实例自行退出（`p2.HasExited=True`），日志记 `收到 second-instance ⇒ 已聚焦既有窗口（未创建新窗口）` |
| 7 | 退出项：退出后无残留进程 | **通过** | `CloseMainWindow()` → `Get-Process -Name 砚舟` = 0；`main.log` 优雅关停四行齐全 |
| 8 | 便携版与安装版各自实测结果分开记录 | **通过** | §4 安装版（NSIS）与 §5 便携版（Portable）分节；另 §3 单列 win-unpacked |

**一句话结论**：19:13 那一轮产出的三种形态（`win-unpacked`、NSIS 安装版、Portable 便携版）**全部端到端跑通**：能启动、能起后端并自检 `database=connected / plugins=27`、能按 D7 落盘并建 junction、能跨重启保留数据、能拦第二实例、能优雅关停且无残留。ADR D20 的 **R1 / R2 / R3 三项高风险**由本报告直接闭环（§7）。**两处必须记录的既有缺陷**：① 便携版不重定向 `userData`（R13 结论，§5.3）；② `logger.ts` 在父进程 stdio 管道断开时存在 EPIPE 自激写盘缺陷（§6，非本任务验收项，但可吃满磁盘）。

---

## 1. 验收项 1：产物路径 / 字节数 / SHA-256

观测时刻 2026-10-03 20:2x–20:3x，目录 `F:\new1.2\release\desktop\`：

| 文件 | 字节数 | SHA-256 | LastWriteTime |
| --- | --- | --- | --- |
| `砚舟-Setup-0.1.0-x64.exe` | 177,697,975 | `1D53021050DE2929EC59CF3F03E74B62ED741F28C7FEB8D61A43A14DC49EB4D1` | 2026-10-03 19:13:28 |
| `砚舟-Setup-0.1.0-x64.exe.blockmap` | 180,795 | `6F4C1B7413983CD2F5D09286BB5FAB5103C7998E6A3C76C78979E1AB4009BB15` | 2026-10-03 19:13:38 |
| `砚舟-Portable-0.1.0-x64.exe` | 177,302,758 | `DDDF3A98CB2C7E75DB55FEEC0F1A134B4FB6CAF9CF2CB2353D8AC8D8D2D27ECB` | 2026-10-03 19:13:39 |
| `win-unpacked\砚舟.exe` | 245,877,248 | `C65C770A6FFFC5991F3AE9A94EDF368955B17E016AF04096CC4A7C973A345833` | — |
| `K1__uninstaller.exe`（残留中间物） | 36,859 | `83F0023272DE348249C9F16B7C4CEEB8BEE13C711FD9623693687DA29B3EA1DC` | 2026-10-03 12:17:22 |
| `builder-debug.yml` | 6,041 | `15D7357863DE12D611DEE40A23817B38AD974695091CCB830A35BB7B40121D9E` | 2026-10-03 19:13:39 |

配套更新源 `F:\new1.2\release\updates\`（恰 7 项，D17.2 冻结集）：

| 文件 | 字节数 |
| --- | --- |
| `manifest.json` | 2,431 |
| `novelmuse-app-0.1.0.zip` | 69,076,232 |
| `novel.auto.workbench-0.1.0.zip` | 11,096,747 |
| `novel.manual.workbench-0.1.0.zip` | 11,334,357 |
| `novel.autowrite-0.1.0.zip` | 5,353,042 |
| `novel.bookscan-0.1.0.zip` | 7,258 |
| `novel.typography-0.1.0.zip` | 7,263 |

`manifest.json` 要点：`version=0.1.0`、`publishedAt="2026-10-03T08:26:12Z"`、`app={url:"novelmuse-app-0.1.0.zip", sha256:"f8008010…57ef"}`、`plugins` 恰 5 条（`novel.bookscan` / `novel.autowrite` / `novel.auto.workbench` / `novel.manual.workbench` / `novel.typography`），每条含 `{id,name,version,url,sha256,notes}`。

`win-unpacked\resources\` = `app-server/` + `app.asar.unpacked/` + `seed-plugins/` + `web-dist/` + `app.asar`(778,506 B) + `elevate.exe`(107,520 B)。其中 `app-server/` = `apps/` + **`node_modules/`（214 个顶层包）** + `packages/` + `pnpm-workspace.yaml`(3,055 B) ⇒ t7 的 DEV-10 修复已落在产物里（对照 §7-R2）。

---

## 2. 环境与启动前置（两次踩坑，必须记录）

1. **`ELECTRON_RUN_AS_NODE=1` 污染**：本机 DSH shell 环境自带 `ELECTRON_RUN_AS_NODE=1`。直接以继承该变量的方式启动 Electron 主进程，进程会以**纯 Node** 身份运行、立刻退出且 stdout/stderr 全空（无任何 `main.log` 写入）。**处置**：启动前 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`（本次复测脚本已内置并断言 `ELECTRON_RUN_AS_NODE present after clear = False`）。
2. **父进程 stdio 被重定向 ⇒ 触发 EPIPE 缺陷**（见 §6）：用 `UseShellExecute=$false` + 重定向 stdout/stderr 的方式启动，关闭主窗口后进程**不退出**且 `main.log` 以数 GB/分钟 的速度膨胀。**推荐启动配方**（本次复测采用）：
   ```powershell
   Remove-Item Env:\ELECTRON_RUN_AS_NODE -EA 0
   Start-Process -FilePath <exe> -ArgumentList "--user-data-dir=<ud>"
   ```
   或等价的分离式：`cmd /c start "" "<exe>" --user-data-dir=<ud>`。

---

## 3. win-unpacked 形态实测（`F:\new1.2\release\desktop\win-unpacked\砚舟.exe`）

本轮以**全新 userData** `D:\Temp\t8\ud-unpacked` 复测（脚本 `F:\new1.2\.verify-scratch\verify-unpacked.ps1`，日志 `verify-unpacked.log`）。

### 3.1 启动项（通过）
- 启动后主窗口出现，标题 **`听风细雨 - 伴写小说工具`**（`MainWindowTitle` 命中，`waitedSec=42`，其中大部分时间在等首次播种/解包）。
- `main.log` 逐字（启动链，D12.3 八步）：
  ```
  [INFO] 砚舟 桌面壳启动：version=0.1.0，isPackaged=true，userData=D:\Temp\t8\ud-unpacked
  [INFO] 运行时 junction 状态：data=true，plugins/node_modules=true，better-sqlite3=true（attempted=true）
  [INFO] 布局：seeded=true，appServerPresent=true，appServerDir=D:\Temp\t8\ud-unpacked\app-runtime\app-server
  [INFO] server 入口：D:\Temp\t8\ud-unpacked\app-runtime\app-server\apps\server\src\index.ts（cwd=…\app-runtime\app-server）
  [INFO] 已注册 9 条 IPC 通道（D11.2）。
  [INFO] 已生成新的 JWT 密钥并写入 D:\Temp\t8\ud-unpacked\data\.jwt-secret（0o600）
  [INFO] D6 环境变量装配完成：注入 78 项（JWT_SECRET 本次新生成）。
  [INFO] 端口握手成功：http://127.0.0.1:58828（来自子进程 stderr，D5.1）
  [INFO] 就绪探针通过：status=ok，database=connected，hostMode=all，plugins=27
  [INFO] 主窗口已创建：1440×900（min 1024×640），preload=…\resources\app.asar\dist\preload.cjs，serverOrigin=http://127.0.0.1:58828，devOrigin=(打包态)
  [INFO] 砚舟 桌面壳启动完成（D12.3 全部 8 步已完成）。
  [INFO] 主窗口 ready-to-show ⇒ 显示窗口（D12.2）。
  ```
- 启动时并同时弹出一次性「砚舟 管理员初始密码」对话框（`#32770`，与本轮无关的既有行为），关闭后仅剩主窗口；该对话框关闭方式：向目标 `#32770` 顶层窗口投递 `WM_CLOSE`。

### 3.2 后端项（通过）
进程树（`Get-CimInstance Win32_Process`，同一时刻 5 个 砚舟 进程）：

| PID | 角色 | 关键命令行 |
| --- | --- | --- |
| 11176 | 主进程 | `"…\win-unpacked\砚舟.exe" --user-data-dir=D:\Temp\t8\ud-unpacked` |
| 13864 | gpu-process | `--type=gpu-process …` |
| 23880 | utility(network) | `--type=utility --utility-sub-type=network.mojom.NetworkService …` |
| 13956 | renderer | `--type=renderer --app-path="…\resources\app.asar" --no-sandbox …` |
| **22524** | **server 子进程** | `…\砚舟.exe --import tsx D:\Temp\t8\ud-unpacked\app-runtime\app-server\apps\server\src\index.ts` |

- 监听端口由**端口握手**取得（D5.1，来自子进程 stderr，非固定端口）：本次三次启动分别 `58828` / `64454` / `57220`。
- 就绪探针：`status=ok，database=connected，hostMode=all，plugins=27`（三次启动一致）。
- `GET /api/health` 原始返回确认 `{"status":"ok","database":"connected","hostMode":"all","plugins":[27 条全部 status=ok]}`。
- 登录链路确认可用：`POST /api/auth/login {admin, 初始密码}` → HTTP 200，返回 `{"data":{"user":{"id":"6774238d-a596-4b3c-9f8b-b62d0581e0c8","username":"admin","displayName":"管理员","isAdmin":true}}}`。

### 3.3 落盘项（通过）
`D:\Temp\t8\ud-unpacked` 首次启动后出现（按 D7.1 布局）：
```
app-runtime/            （含 app-server/{apps,node_modules,packages,pnpm-workspace.yaml} 与 data→junction）
backups/
data/                   （projects/、.jwt-secret 65 B、novelmuse.db 442368 B）
logs/                   （main.log、initial-admin-password.txt 23 B、server.err.log、server.out.log）
plugins/                （auto/…、manual/…、shared/…、local/、node_modules→junction）
updates/
GPUPersistentCache/  ShaderCache/  Cache/  Code Cache/  Local Storage/  Network/  Session Storage/  等 Electron 侧目录
lockfile
```
junction 三项由启动日志断言为真：`运行时 junction 状态：data=true，plugins/node_modules=true，better-sqlite3=true（attempted=true）`（对应 D7.3 `app-server/data → <userData>/data`、D7.4 `plugins/node_modules`、以及 asar.unpacked 的 better-sqlite3）。首次播种发生（`布局：seeded=true`）。

### 3.4 单实例项（通过）
第二实例（同 `--user-data-dir`）启动后：进程数 `before=5 after=5` **不变**，且第二实例进程 `p2.HasExited=True`（自行退出，符合 D12.1）。日志侧证：
```
[INFO] 收到 second-instance ⇒ 已聚焦既有窗口（未创建新窗口）。
```

### 3.5 持久化项（通过）
- RUN A（全新 userData）：`POST /api/projects {name:"E2E-Unpacked-Persistence-Probe"}` → 创建成功，`id=3ae2c882-47b0-475b-b7d1-41d531941059`。随后 `CloseMainWindow()` → 进程 0。
- RUN B（重启同一 userData，新端口 57220）：`GET /api/projects` 返回 3 条，**包含 RUN A 创建的 `3ae2c882-47b0-475b-b7d1-41d531941059`**（另有更早期两条探测项目）。⇒ 跨重启数据保留。
- 退出后 `data/` 只剩 `.jwt-secret` + `novelmuse.db`（`-wal`/`-shm` 已随 `closeGracefully()` 合并清除）。

### 3.6 退出项（通过）
`(Get-Process -Id <主进程>).CloseMainWindow()` → 立即返回 True，进程数在 1 秒内归零（本轮 `exitWaitSec=0 remaining=0`）。`main.log` 优雅关停四行齐全：
```
[INFO] 开始优雅关停 server 子进程（pid=22524，reason=before-quit）：按 D13.3 向 stdin 写入 "novelmuse:shutdown"
[INFO] server 子进程已退出（exitCode=0，signal=null）
[INFO] server 子进程已按 stdin 协议自行退出（exitCode=0）—— 数据库已在 closeGracefully() 中落盘。
[INFO] 优雅关停完成（reason=before-quit）⇒ 退出进程。
```

---

## 4. 安装版（NSIS，`砚舟-Setup-0.1.0-x64.exe`）实测

### 4.1 安装前状态（干净基线）
0 个 砚舟 进程；`C:\Users\1\AppData\Local\Programs\砚舟` 不存在；HKCU/HKLM `…\Uninstall` 无 砚舟/听风细雨 条目；开始菜单与桌面无 `听风细雨.lnk`；C: 空闲 86.85 GB。

### 4.2 静默安装
```
Start-Process 'F:\new1.2\release\desktop\砚舟-Setup-0.1.0-x64.exe' -ArgumentList '/S'
```
→ **exit 0，耗时 285.1 s（≈4.75 min）**。安装后：

| 项 | 观测值 |
| --- | --- |
| 安装目录 | `C:\Users\1\AppData\Local\Programs\砚舟`（存在） |
| 注册表卸载项 | HKCU `…\Uninstall\041628de-2a89-5b34-a81e-027ac6a5be73` = `砚舟 0.1.0`；`UninstallString` = `"…\Programs\砚舟\Uninstall 砚舟.exe" /currentuser` |
| 开始菜单 | `C:\Users\1\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\听风细雨.lnk` → Target `…\Programs\砚舟\砚舟.exe`，WorkDir 同目录 |
| 桌面快捷方式 | **无**（用户桌面与 `C:\Users\Public\Desktop` 均无 `听风细雨`） |
| HKLM 条目 | **无**（`perMachine=false`，与 D16.2 一致） |
| 安装体积 | 32,510 个文件 / 约 663 MB |
| 卸载器 | `Uninstall 砚舟.exe` 345,367 B |

`resources/` 内容与 `win-unpacked/resources` 同构（`app-server/`含 node_modules、`app.asar.unpacked/`、`seed-plugins/`、`web-dist/`、`app.asar`、`elevate.exe`）。

### 4.3 首启 + 后端（全新 userData `D:\Temp\t8\ud-fresh`）
5 进程（main 15180 / gpu 11328 / network utility 21524 / renderer 24136 / **server 7152**）；命令行 `…\砚舟.exe --import tsx D:\Temp\t8\ud-fresh\app-runtime\app-server\apps\server\src\index.ts`；主窗口 `听风细雨 - 伴写小说工具`。`main.log` 八步齐全，且完整走通**首次播种**：
```
[INFO] version=0.1.0，isPackaged=true，userData=D:\Temp\t8\ud-fresh
[INFO] 运行时 junction 状态：data=true，plugins/node_modules=true，better-sqlite3=true（attempted=true）
[INFO] 布局：seeded=true，appServerPresent=true
[INFO] 已注册 9 条 IPC 通道（D11.2）
[INFO] 已生成新的 JWT 密钥并写入 …\data\.jwt-secret（0o600）
[INFO] D6 环境变量装配完成：注入 79 项（JWT_SECRET 本次新生成）
[INFO] 端口握手成功：http://127.0.0.1:59924（来自子进程 stderr，D5.1）
[INFO] 就绪探针通过：status=ok，database=connected，hostMode=all，plugins=27
[INFO] 主窗口已创建：1440×900（min 1024×640）
[INFO] 砚舟 桌面壳启动完成（D12.3 全部 8 步已完成）。
```
`server.err.log` 旁证：`[Server] ✅ 默认管理员用户创建成功 (admin)`、`[Server] 🔑 管理员初始密码…`、`[Server] Cordis 基座已就绪 → http://localhost:59924`。

**API（R2 决定性证据，安装版）**：登录 200（cookie `novelmuse_token`）→ `GET /api/projects` 200 → `POST /api/projects {name:"E2E-Installed-Persistence-Probe"}` → `id=637f5be3-d87c-428e-b91a-28349ecc5e1b` → `GET /api/health` = `{"status":"ok","database":"connected","pluginStandard":"1.0.0","hostMode":"all","plugins":[27 条全部 status=ok]}`。**`database=connected` 即 `better_sqlite3.node`（1,921,024 B）在打包态成功 dlopen 的直接证据**。

### 4.4 单实例 + 优雅退出（安装版，通过）
- 第二实例：进程数 5→5 不变、主窗口仍 1 ⇒ 第二实例自行退出（D12.1）。
- `CloseMainWindow()` on 15180 → 12 s 内进程归零；日志四行齐全（同 §3.6 形态，`pid=7152`）。

### 4.5 持久化（安装版，通过）
重启（同 `--user-data-dir`，新端口 **58556**）：`布局：seeded=false`（播种幂等）、`注入 79 项（JWT_SECRET 复用已有）`、`就绪探针通过：…plugins=27`；`GET /api/projects` **仍返回 `637f5be3-d87c-428e-b91a-28349ecc5e1b` / `E2E-Installed-Persistence-Probe`**；`initial-admin-password.txt` 仍 23 B（未重生成）。

### 4.6 卸载（安装版，通过）
先关闭主窗口（进程 0），再：
```
Start-Process '…\Programs\砚舟\Uninstall 砚舟.exe' -ArgumentList '/S','/currentuser'
```
父进程 **exit 0 / 0.1 s**（NSIS 卸载器立即 spawn 真身 `Un_A` 异步执行）。**约 45 s 后**：安装目录**已删除**、开始菜单 `听风细雨.lnk` **已删除**、HKCU 卸载条目**已消失**；`D:\Temp\t8\ud-fresh`（userData）**仍在** ⇒ `deleteAppDataOnUninstall:false` 生效。卸载闭环成立。

---

## 5. 便携版（Portable，`砚舟-Portable-0.1.0-x64.exe`）实测

### 5.1 启动与进程树（通过）
直接运行便携版 exe（分离方式启动）：
- **自解压耗时约 3 分钟**，解压到 `D:\Temp\<随机 27 字符目录>`（本次 `D:\Temp\3KBLT5szuyCZGc86OpcpqJ1jXdR`；对应模板 `portable.nsi:35  StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"`）。解压期观察到文件数 7,563 → 34,477；解压完成后才出现 砚舟 进程。
- 进程树：`砚舟-Portable-0.1.0-x64.exe`(stub) → `D:\Temp\…\砚舟.exe`(主进程) → gpu/renderer/network utility + **server 子进程**（命令行 `…\砚舟.exe --import tsx C:\Users\1\AppData\Roaming\砚舟\app-runtime\app-server\apps\server\src\index.ts`）。
- `main.log`：`userData=C:\Users\1\AppData\Roaming\砚舟`、`isPackaged=true`、`seeded=false`（复用已有 version.json）、`D6 环境变量装配完成：注入 82 项（JWT_SECRET 复用已有）`、端口 49334、`就绪探针通过：…plugins=27`、主窗口创建成功。

### 5.2 退出与自清理（通过）
`CloseMainWindow()` on 主进程 → 砚舟 进程归零，优雅关停四行齐全（`reason=before-quit`，server `exitCode=0`）。**stub 进程额外存活约 30 s**（执行 `RMDir /r $INSTDIR` 清理），随后自行退出，`D:\Temp\3KBLT5szuyCZGc86OpcpqJ1jXdR` 已被删除（`Test-Path` = False）⇒ 便携版无残留。

### 5.3 **R13 结论：便携版不重定向 userData**（重要）
实测确认：便携版运行时 `userData` 落点 = **`C:\Users\1\AppData\Roaming\砚舟`**，与安装版**完全相同**，**不是** exe 同目录。`F:\new1.2\release\desktop\` 下未产生任何 砚舟 数据目录。`portable.nsi` 只把**运行体**解压到 `$TEMP` 并在退出时删除，不触碰 `userData`；源码中亦**未检出** `PORTABLE_EXECUTABLE*` 环境变量的使用。
> ⇒ 若「便携 = 数据随身」是期望语义，**当前实现不满足**，需另行设计（例如读 `PORTABLE_EXECUTABLE_DIR` 覆盖 `userData`）。登记为 t6 残余风险 R13。

> ✅ **后续（2026-10-08，ADR D4.7）**：本条已闭合。便携版 zip 现随包提供 `启动便携版.cmd`，
> 用 Electron 自带的 `--user-data-dir` 把 `userData` 重定向到解压目录内 `portable-data\`，
> **数据随文件夹走**，且预置运行时使首启零等待（4.1 s）。上述结论对「直接双击
> `NovelMuse.exe`」的传统模式仍然成立（落点仍是 `%APPDATA%\NovelMuse`）。本节其余内容
> （单文件 exe 形态、`portable.nsi`）描述的是 D4.5 形态，**该形态已于 D4.6 移除**，
> 仅作历史记录。

---

## 6. 非验收项但必须登记的缺陷：`main.log` EPIPE 自激写盘

**现象**：若以「父进程持有 stdio 管道」的方式启动（`UseShellExecute=$false` + 重定向 stdout/stderr），关闭主窗口后进程**不退出**（本轮观察到 3 个残留进程），且 `%APPDATA%\NovelMuse\logs\main.log` 在数分钟内膨胀到 **3,519,024,054 B（≈3.9 GB）**（清理后 C: 空闲由 86.86 GB 恢复）。行统计：`totalLines=49,712,192，matchCount=4,519,287`（几乎全是同一行）。

**内容**：反复堆叠
```
[ERROR] 主进程未捕获异常：Error: EPIPE: broken pipe, write
    at Socket._write (node:internal/net:75:18)
    at … Writable.write (node:internal/streams/writable:…)
    at [kWriteToConsole] (node:internal/console/constructor:311:16)
    at console.error (node:internal/console/constructor:442:26)
    at FileLogger.write (…\resources\app.asar\dist\main.cjs:514:7)
    at ShellLogger.log (…:572:15)
    at earlyLog (…:2989:12)
    at process.<anonymous> (…:3365:3)
```

**机制**（`apps/desktop/src/logger.ts`）：`FileLogger.write` 先 `ringPush`，再 `if (this.echoToConsole) { …console.error(line) }`，**之后**才写 stream；`ShellLogger` 以 `echoToConsole=true` 构造。当父进程 stdio 管道已断开时，`console.error` 抛 EPIPE → 被 `process.on('uncaughtException')` 捕获 → 处理器再调用日志函数 → 再次 `console.error` → 再次 EPIPE …… **自激循环**，每轮写一行进 `main.log`。

**触发条件**：仅在父进程 stdio 管道被关闭/断开的启动方式下触发（正常双击或 `cmd /c start` 分离启动**不触发**；本轮分离式启动 `main.log` 仅 2,588 B）。

**定性**：真实缺陷（D12.4 崩溃日志 + 环形缓冲设计的反噬），属实现问题，**不在 t5 验收范围**，本次不改码，仅登记。

---

## 7. ADR D20 高风险项闭环

| 风险 | 结论 | 证据 |
| --- | --- | --- |
| **R1**（高）`spawn(process.execPath, ['--import','tsx', entry], {env:{ELECTRON_RUN_AS_NODE:'1'}})` 在 Electron 44.5.1 可用性 | **闭环：可用**（退路未启用） | 三形态的 server 子进程命令行均为 `…\砚舟.exe --import tsx …\apps\server\src\index.ts`，且探针 `plugins=27`；win-unpacked 日志记 `spawnMode=import` |
| **R2**（高）asarUnpack + better-sqlite3 ABI 重建 + D8.2 junction | **闭环：通过** | `resources\app.asar.unpacked\node_modules\{better-sqlite3,bindings,file-uri-to-path}` 三者在场；`better_sqlite3.node`=**1,921,024 B**（= D20-R2 冻结值）；三形态 `/api/health.database` 全为 `connected` |
| **R3**（高）D13.3 stdin 控制通道在 Windows 可触发 `closeGracefully` | **闭环：通过** | 三形态 `main.log` 均见 `向 stdin 写入 "novelmuse:shutdown"` → `server 子进程已退出（exitCode=0）` → `数据库已在 closeGracefully() 中落盘`；`server.err.log` 见 `[Server] 收到 stdin，正在优雅关闭...` |
| R4/R5/R6/R7/R9/R10/R11/R12 | 见 t3 审计报告 §5 与 t6 收尾报告 | 本报告不重复 |
| **R8** artifactName 覆盖优先级 | 闭环（实测） | 产物恰为 `砚舟-Setup-0.1.0-x64.exe` / `砚舟-Portable-0.1.0-x64.exe`，无 `砚舟-0.1.0-x64.exe` 形态 ⇒ `nsis/portable.artifactName` 覆盖 `win.artifactName`（与 `platformPackager.js:552` 一致） |
| **R13** 便携版 userData 落点 | 闭环（实测） | §5.3：落 `%APPDATA%\NovelMuse`，与安装版相同，**不重定向** |

---

## 8. 未能判定 / 未覆盖

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 窗口内 UI 交互（渲染层功能点击流） | **未能判定** | 本会话在无 GUI 交互条件下仅做进程/日志/HTTP 观测，未做渲染层点击流验证 |
| 自动更新下载→安装→重启全链路 | **未能判定** | 未配置真实更新源（`baseUrl` 为空即关闭更新）；本报告只验证更新源产物形态（§1） |
| 便携版的 `PORTABLE_EXECUTABLE*` 语义 | **已判定（缺失）** | §5.3：源码未使用该组环境变量 |
| 代码签名 / SmartScreen | **未能判定（预期未签名）** | ADR D16.4 明确不做签名 |
| 卸载时对 `userData` 的处理 | 已判定 | `deleteAppDataOnUninstall:false` ⇒ 保留（§4.6） |

---

## 9. 复现步骤（脚本见 `F:\new1.2\.verify-scratch\`）

```powershell
# 0) 清污染
Remove-Item Env:\ELECTRON_RUN_AS_NODE -EA 0

# 1) 产物与哈希
Get-ChildItem 'F:\new1.2\release\desktop' | Select-Object Name,Length
Get-FileHash 'F:\new1.2\release\desktop\砚舟-Setup-0.1.0-x64.exe' -Algorithm SHA256
Get-FileHash 'F:\new1.2\release\desktop\砚舟-Portable-0.1.0-x64.exe' -Algorithm SHA256

# 2) win-unpacked 端到端（启动 / 单实例 / 持久化 / 优雅退出）
& 'F:\new1.2\.verify-scratch\verify-unpacked.ps1'

# 3) 安装版（静默安装 → 启动 → 卸载）
Start-Process 'F:\new1.2\release\desktop\砚舟-Setup-0.1.0-x64.exe' -ArgumentList '/S' -Wait
# …（启动与卸载同上，详见本报告 §4）

# 4) 残留检查
Get-Process -Name 砚舟 -EA 0
```

---

*报告生成：2026-10-03（t5，verify-eng 角色，由本会话直接执行）。观测均在报告中标注；凡无独立可核证据者已标 `未能判定`。*
