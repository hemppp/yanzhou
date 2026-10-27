# 砚舟 VS Code 式停靠系统重构 · 收尾交付报告（t5）

| 项 | 值 |
|---|---|
| 报告任务 | **t5**（执行者 `closeout-eng`，attempt `d000f577-8960-44ec-80ca-365b92d17a12`） |
| 团队 | `dock-refactor-finish` |
| 仓库根 | `F:\new1.2` |
| 报告日期 | 2026-10-02 |
| 独立验证方 | **t4**（`verify-eng`）→ `docs/reports/dock-refactor-verification.md`（75359 B / 1099 行，总判定 **pass**） |
| 本报告性质 | **收尾汇总 + 验收结案**。**未修改任何产品源码**；数字全部来自本机实测（§7 声明边界） |

> **一句话结论**：停靠重构的**全部交付物已落盘且相互一致**；**七条验收命令 7/7 EXIT=0**；**测试基线 12 files / 153 passed**；**三文件哈希与 captain attestation 逐字节一致**；工作区**清洁**（无回退副本、无 stash）。
> 与冻结契约 ADR 的 **3 条偏离已由 captain 裁定并已在 ADR 内就地标注**；**1 项高严重度残余风险（F-F，既存、非本次回归）** 与 **6 项需人工确认项**（含 Linux 运行时）如实移交。
> **唯一需要后续修正的是文档数字口径**：`--ink*` 消费点 t5 实测为 **186**（72/83/31），**经 captain 裁定为口径混用** —— **187 才是正确总数，需更正的是拆分（72 / 83 / 32）**。详见 §9.2（含 captain 裁定）。

---

## §1 交付物清单

> 全部指标为 t5 **本机实测**（`Get-Item` / `Get-Content` 计数），非转抄。行数 = **含空行总行数**。

### 1.1 停靠内核与宿主壳

| 路径 | 字节 | 行数 | 最后写入 | 作用 |
|---|---|---|---|---|
| `apps/web/src/components/shell/ProjectLayout.tsx` | 24186 | 462 | 2026-10-02 10:34:43 | **宿主壳**：DockShell 接线、`activeCenterKey` 派生（非硬编码 null）、`nm:open-panel` / `nm:open-settings` 事件桥 |
| `apps/web/src/components/shell/DockShell.tsx` | 24715 | 633 | 2026-10-02 11:32:21 | **停靠内核**：dockview 接线 + **center 单所有者修复**（四处） |
| `apps/web/src/components/shell/dock/types.ts` | 6202 | 130 | 2026-10-01 21:35:05 | `DockPanelDef` / `resolveDockMeta`（缺省行为单一真源） |
| `apps/web/src/components/shell/dock/layout.ts` | 6454 | 184 | 2026-10-01 21:41:00 | 布局规格构造 + 持久化（唯一方向换算点 `slotToDockDirection`） |
| `apps/web/src/components/shell/dock/DockPanelContent.tsx` | 4456 | 133 | 2026-10-01 21:37:06 | 面板内容 + **面板级错误隔离**（`PanelErrorBoundary`） |
| `apps/web/src/components/shell/dock/CenterGraphPanel.tsx` | 3421 | 92 | 2026-10-01 21:39:03 | 中心槽图面板（能力 6 的载体） |
| `apps/web/src/stores/panelOpenStore.ts` | 9929 | 262 | 2026-10-01 22:21:10 | 打开集合 store（`MAX_OPEN_PANELS` 已退役） |

### 1.2 主题与样式

| 路径 | 字节 | 行数 | 最后写入 | 作用 |
|---|---|---|---|---|
| `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css` | 13933 | 262 | 2026-10-01 22:16:29 | **主题唯一真源**（117 行定义 / 117 个唯一 `--vscode-*` token） |
| `apps/web/src/components/shell/dock/dock-tokens.css` | 1630 | 28 | 2026-10-01 22:17:29 | **主题副本**：纯 `@import` 转发层，**0 定义、0 字面色值** |
| `apps/web/src/components/shell/dock/dock-theme.css` | 16451 | 527 | 2026-10-02 00:15:46 | dockview `--dv-*` → `--vscode-*` 主题映射层（能力 5 / 7 的落点） |
| `apps/web/src/styles/globals.css` | 86812 | 2370 | 2026-10-02 11:36:48 | 水墨语义清理（**仅注释与措辞**）+ **保留** `--ink*` 三定义 / `--cover-ink` / `.glass-ripple-ink` |
| `apps/web/src/stores/themeStore.ts` | 235 | 3 | 2026-09-30 01:51:56 | **保留**（2 个活跃导入方，见 §1.5） |

### 1.3 测试与门禁

| 路径 | 字节 | 行数 | 最后写入 | 作用 |
|---|---|---|---|---|
| `apps/web/src/components/shell/dock/DockShell.smoke.test.tsx` | 15828 | 392 | 2026-10-02 11:29:01 | 内核冒烟 **17 用例**（含 5 条 center 回归守门） |
| `apps/web/src/plugin/__tests__/plugin-dock-adaptation.test.ts` | 13382 | 252 | 2026-10-02 12:15:35 | 适配镜像 **12 用例**（t2 为 F-2 新增 4 条 + 源码级漂移守卫） |
| `apps/web/vitest.config.ts` | 4680 | 89 | 2026-10-02 13:15:00 | F-1：`test.exclude` 增 `**/__scratch__/**` + `**/__scratch_*` |
| `apps/web/vitest.probe.config.ts` | 3147 | 71 | 2026-10-02 13:15:12 | F-1 逃生舱（**仅**放开 scratch 命名，其余排除项保留） |
| `scripts/verify/verify-theme-single-source.mjs` | 15000 | 363 | 2026-10-02 11:23:24 | **主题单一真源门禁**（可机检，本次新增） |
| `scripts/verify/verify-all.mjs` | 7593 | 133 | 2026-09-30 22:14:07 | 五步总门禁 |
| `scripts/verify/verify-plugin-mode-separation.mjs` | 21067 | 349 | 2026-10-01 18:02:51 | 插件层模式分离门禁 |
| `scripts/e2e/e2e-mode-separation.mjs` | 15664 | 272 | 2026-10-02 11:09:00 | e2e 模式分离（过期选择器已修正） |
| `scripts/e2e/e2e-core-flows.mjs` | 41417 | 689 | 2026-10-02 11:21:15 | e2e 核心流（过期选择器已修正） |

### 1.4 文档

| 路径 | 字节 | 行数 | 最后写入 | 作用 |
|---|---|---|---|---|
| `docs/architecture/dock-refactor-final.md` | 37861 | **547** | 2026-10-02 12:00:33 | **最终架构文档**（t1 交付：§0–§9 原文 + §10 收尾独立复核记录） |
| `docs/architecture/dock-protocol-adr.md` | 56684 | **845** | 2026-10-02 12:19:34 | **冻结契约 ADR**（t2 追加 §6.4-a / §6.5-a 偏离记录，引用 `dock-refactor-final.md` 0 → 2） |
| `docs/reports/dock-refactor-verification.md` | 75359 | **1099** | 2026-10-02 13:43:23 | **t4 独立验证报告**（§0–§11，总判定 pass） |
| `docs/reports/dock-refactor-closeout.md` | 本文件 | — | 2026-10-02 | **本报告**（t5 收尾交付） |

### 1.5 依赖锁定与保留决策

| 项 | 实测 |
|---|---|
| `apps/web/package.json` | 2638 B / 85 行；**`"dockview": "8.4.0"`、`"dockview-react": "8.4.0"` 精确锁定**（非 `^`/`~`） |
| `apps/web/src/stores/themeStore.ts` 是否可删 | **不可删 → 保留**。内容仅 3 行（`export * from '@novel-plugins/ui-kit/themeStore';`），但存在 **2 个活跃导入方**：`apps/web/src/components/settings/AppearancePanel.tsx:13`（`import { THEMES, useThemeStore, type ColorMode } from '@/stores/themeStore';`）与 `apps/web/src/main.tsx:10`（`import { applyStoredTheme } from './stores/themeStore';`）。真实现在禁改区 `apps/plugins/shared/ui-kit/src/themeStore.ts`。删除会直接破坏 `type-check`。 |

---

## §2 验收结论

### 2.1 八项能力逐条判定

> 判定**引用 t4 独立验证报告**（`docs/reports/dock-refactor-verification.md` §0.1 / §4 / §5），**本报告不重述其推导**，仅汇总结论与证据出处。
> 证据来源标注：**t4** = t4 的实测；**t5** = 本报告现场复测。

| # | 能力 | 判定 | 自动化程度 | 证据出处 |
|---|---|---|---|---|
| 1 | 多 Dock Panel（面板由外部 props 注入） | ✅ **通过** | 全自动（源码 + 单测 + 产物） | t4 §4.1 |
| 2 | 拖拽标题栏 → Floating Dock（可再拖回） | ✅ 通过（代码路径）/ ⚠️ **手感需人工** | 半自动 | t4 §4.2 + §9.1 |
| 3 | 上/下/左/右四个 Dock Area + 中心编辑区，可吸附任一区 | ✅ **通过** | 半自动（落位逻辑全自动；吸附手势需人工） | t4 §4.3 |
| 4 | Tabbed Dock Group（同组多标签堆叠、拖出/拖入重组） | ✅ 通过（代码路径）/ ⚠️ **拖拽重组需人工** | 半自动 | t4 §4.4 + §9.4 |
| 5 | Dock Preview Indicator（拖拽落点预览框） | ✅ 通过（样式与变量已接线）/ ⚠️ **视觉需人工** | 半自动 | t4 §4.5 + §9.2 |
| 6 | **中心画布可替换（关系图抢占中心区）** | ✅ **通过** | **全自动 —— 真实浏览器实测** | **t4 §5.5（见下）** |
| 7 | Dock Splitter（拖动调整大小） | ✅ 通过（sash 选择器与变量已接线）/ ⚠️ **拖动手感需人工** | 半自动 | t4 §4.7 + §9.3 |
| 8 | 深色主题 + Windows/Linux 跨平台可用 | ✅ 通过（源码级跨平台洁净度全自动；**Linux 运行时未实测**） | 半自动 | t4 §6 + §9.6 |

**能力 6 的证据来源（必须注明，避免冒充）**：

- 证据**不是本报告跑的**，而是 **t4** 用真实浏览器 raw-CDP 探针 `.verify-scratch/probe-center-slot.mjs`（仓库根 `.verify-scratch/`，7759 B）在**真实 UI 登录 + 一次性 manual 项目**上取得的。
- 口径：**用 DOM `[data-tab-panel-id]` 全量计数，刻意不用 `listPanels()`** —— 因为 `listPanels()` 按业务 key 去重，会把「双实例」藏起来。
- 实测结果（t4 §5.5 原文）：初始 `["nm-center-default"]` → 打开关系图 `["nm-center-default","nm-center:relationGraph"]` 且 **`plainRelationGraph=0`** → 再点一次**列表完全不变**（幂等）→ 关闭后回落 `["nm-center-default"]` 无残留；`RESULT = PASS`。
- **t5 未重跑该探针**（原因见 §7：t5 现场三项服务均不可用，且探针属 t4 工作范围）。

**能力 8 的边界**：源码级跨平台洁净度（内核/外壳 0 处盘符·反斜杠·UNC·`require(`·`process.`·`electron`·`ipcRenderer`）为**全自动通过**（t4 §6），但**Linux 运行时本次未实测**，按 t4 §9.6 列为**需人工确认**。

### 2.2 四条 pnpm 命令 —— 原始 exit code（t5 现场实测）

> 执行方式：`cmd /c "<命令> & echo EXIT=%ERRORLEVEL%"`（PowerShell 直接调用 `& pnpm @('--filter',…)` 会被吞参数并报 `Unknown option: 'filter …'`，故必须走 `cmd /c`）。原始输出留档：`%TEMP%\t5-verify-log.txt`（**仓库外**，避免污染工作区）。

| # | 命令 | exit | 实测输出摘要 |
|---|---|---|---|
| 1 | `pnpm --filter @novel/web type-check` | **0** | 10.2 s；`$ tsc --noEmit`，**无输出** |
| 2 | `pnpm --filter @novel/web lint` | **0** | 6.7 s；`✖ 1 problem (0 errors, 1 warning)` —— 唯一 warning = `apps/web/src/components/shell/DockShell.tsx:360:5  Unused eslint-disable directive (no problems were reported from 'react-hooks/exhaustive-deps')` ⇒ **警告口径 = 基线 1**（既存、本次不修） |
| 3 | `pnpm --filter @novel/web build` | **0** | 11.8 s；vite v6.4.3，2614 modules transformed，`✓ built in 10.26s`；产物含 `dist/assets/ProjectLayout-BE5p2nO0.js 437.53 kB`、`dist/assets/ProjectLayout-CwE2_LDR.css 154.04 kB`、`dist/assets/index-jxLsSZrK.css 176.16 kB`。另有**既存**警告：`src/services/api/authApi.ts` 同时被静态与动态导入（非本次引入） |
| 4 | `pnpm --filter @novel/web test` | **0** | 8.8 s；`Test Files 12 passed (12)` / `Tests 153 passed (153)`；含 `src/components/shell/dock/DockShell.smoke.test.tsx (17 tests)`、`src/plugin/__tests__/plugin-dock-adaptation.test.ts (12 tests)` |

**测试基线口径（关键）**：**12 files / 153 passed**。

- **153** = 149 旧基线 + **t2 为 F-2 新增的 4 条用例**（`plugin-dock-adaptation.test.ts` 8 → 12）。**不是 149**。
- **文件数保持 12** ⇒ **无探针泄漏进收集范围**（若为 13 即为 F-1 复发，属异常）。

### 2.3 三条 verify 脚本 —— 原始 exit code（t5 现场实测）

| # | 命令 | exit | 实测输出摘要 |
|---|---|---|---|
| 5 | `node scripts/verify/verify-theme-single-source.mjs` | **0** | 0.2 s；`✅ 主题单一真源不变量全部成立`。真源 = **117 行定义 / 117 个唯一 token**；副本 `dock-tokens.css` = **0 个定义**（要求 0）、转发 `@import` **有**、字面色值 **0 处**；全仓扫描 **432 个文件**，命中 `--vscode-*` 定义 **117 处**（白名单内 117 / **白名单外 0**）；`apps/web/tailwind.config.js` **90 处 `var(--vscode-*)` 引用、0 处定义** |
| 6 | `node scripts/verify/verify-all.mjs` | **0** | 22.1 s；`✅ verify-all 全过`，5 步全过：server 单测 `7 files / 63 passed`；web 单测 `12 files / 153 passed`；记忆抽查 `✅ 不变量全过`；模式分离全过；manifest 合法性（扫描 **5 个真实 `plugin.json`**，通过 5 / 违规 0；`WEB_SERVICES` 白名单 13 项；1 个受支持但缺席的 `novel.autowrite` 跳过 webEntry 检查） |
| 7 | `node scripts/verify/verify-plugin-mode-separation.mjs`（单独跑） | **0** | 9.9 s；`✅ verify-plugin-mode-separation 全过`。manual/auto 各就绪、插件条目数 27；a) manual 4 条断言全绿；b) auto 4 条全绿；c) shared 插件 `novel.typography` 两模式都挂载；d) 跨模式路由门禁（auto 插件路由已随实现移出 → 404，且 `error.code ≠ PLUGIN_MODE_MISMATCH`）；**c2) G2.5 模式门 4 条构造型探针全绿**（`novel.modeprobe` modes=['auto'] 拒、`novel.multiprobe` modes=['manual','shared'] 拒、`novel.defprobe` modes 缺省=[shared] 拒、目录 manual + modes=[manual] 通过） |

**⇒ 七条命令 7/7 EXIT=0，与 captain 预期基线完全一致，无偏差。**

### 2.4 构建产物独立复测（t5 现场）

`apps/web/dist/assets/ProjectLayout-BE5p2nO0.js`（**437530 B**）内串计数：

| 串 | 命中 | 期望 | 结论 |
|---|---|---|---|
| `dockview` | **69** | ≈69 | ✅ 真实接入（未接线会被 tree-shake） |
| `dv-theme-vscode` | **2** | 2 | ✅ 主题映射层进产物 |
| `nm-center` | 4 | ≥1 | ✅ 中心槽实例 id 进产物 |
| `nm-panel` | 2 | ≥1 | ✅ 普通实例 id 进产物 |
| `shuimo` | **0** | 0 | ✅ |
| `ink-wash` | **0** | 0 | ✅ |

全 `dist` 递归（**82 个文件**）`shuimo` = **0**、`ink-wash` = **0** ⇒ 无残留文件。

**CSS 令牌判据（按 captain 修正后的 per-chunk 口径）**：

| chunk | 字节 | `--vscode-editor-background` 定义数 | `var()` 使用 | 定义值 |
|---|---|---|---|---|
| `index-jxLsSZrK.css` | 176156 | **1** | 2 | `hsl(220 13% 13%)` |
| `ProjectLayout-CwE2_LDR.css` | 154040 | **1** | **12** | `hsl(220 13% 13%)` |
| `LandingPage-3Vt8Qvfx.css` | 9901 | 0 | 0 | — |
| `vendor-react-BZV40eAE.css` | 15851 | 0 | 0 | — |

- **同一 chunk 内不重复** ⇒ ✅（各 chunk 定义数 ≤ 1）。
- **各含定义的 chunk 值一致** ⇒ ✅（去重后值集合 = `["hsl(220 13% 13%)"]`，唯一）。
- ⇒ **判据通过**。**原判据「全 dist 恰好 1 次」是错的**（Vite 按 chunk 切分 CSS，全 dist 实际 2 次 ⇒ 会得**假失败**），详见 §3.3。

### 2.5 工作区清洁度与哈希 attestation（t5 现场，逐条原始输出）

**三文件 SHA256 + 字节数（`Get-FileHash -Algorithm SHA256`）—— 与 captain attestation 逐字节一致**：

| 文件 | t5 实测 SHA256 | 字节 | 与 attestation |
|---|---|---|---|
| `apps/web/src/components/shell/DockShell.tsx` | `AFE36EFCD83A3BCC88EFB41850F2AD7F213682F92B68E8EC860D7B319BA2C205` | 24715 | ✅ **逐字节一致** |
| `apps/web/src/components/shell/dock/DockShell.smoke.test.tsx` | `309663DE6A56E03500A293BF2E1B73AE2DBFAEB19FE029BD2BD6C3991407C190` | 15828 | ✅ **逐字节一致** |
| `apps/web/src/components/shell/dock/layout.ts` | `59EFD75CBC826F379C4340AF66D8822BDCC5D6DE1E096DE997EFF181839D0C48` | 6454 | ✅ **逐字节一致** |

> 另测（备查）：`apps/web/src/components/shell/ProjectLayout.tsx` = `62B52EFB364C064D61DC67A60926BDD2B8274D43A12D189BBBC07F2A71FE3F6F` / 24186 B。
> ⇒ **报告结论：attestation 与最终产物「已核实一致」**，无差异需要登记。这意味着评审期间的证伪/清理过程**未污染**这三个文件。

**清洁度（命令与原始输出）**：

| 检查 | 命令 | 原始输出 | 判定 |
|---|---|---|---|
| 证伪副本 | `Test-Path apps\web\src\components\shell\DockShellReverted.tsx` | **False** | ✅ 已清理 |
| 探针目录 | `Test-Path apps\web\src\components\shell\__scratch__` | **False** | ✅ 已清理 |
| 全仓残留 | `git status --porcelain`（**61 行**）过滤 `NoFix\|__scratch__\|DockShellReverted` | **NO HITS (clean)** | ✅ |
| stash | `git stash list` | **EMPTY (no stashes)** | ✅ |
| 附加 | apps/ 下 `__scratch*` 目录数 / 文件数 | **0 / 0** | ✅ |
| 逃生舱在位 | `Test-Path apps\web\vitest.probe.config.ts` | **True** | ✅ 保留 |

**git 基线（解释为何禁用毁伤性 git 命令）**：

```
git rev-parse HEAD   → a0e1db0cffa93b86bc2c9d771a16ad660f1103b8
git rev-list --count HEAD → 2
```

⇒ 本仓**只有 2 个早于重构的提交**，全部重构产物均为**未提交状态**。任何 `git checkout` / `git restore` / `git stash` / `git clean` 都会**永久销毁**它们（本任务期间已发生过一次 `ProjectLayout.tsx` 被毁事故）。**本次全程未执行任何这类命令。**

### 2.6 e2e 实测（**引用 t4，本报告未重跑**）

| 脚本 | 结果 | 证据出处 |
|---|---|---|
| `scripts/e2e/e2e-mode-separation.mjs` | ✅ **EXIT=0**（干净标签页条件下；首轮失败已定性为**测试夹具**问题） | t4 §0.2 / §7.6 |
| `scripts/e2e/e2e-core-flows.mjs` | ⚠️ **EXIT=1 → 38/39 通过**；唯一失败项**已定性为既存缺陷、非停靠重构回归** | t4 §7.2–7.5 |

**唯一失败项原文**：

```
✗ UI 创建的角色已持久化到后端（GET /api/characters/projects/:id 含该名字） — 后端列表="{\"data\":[]}"
   前置：[waitFor 超时 20000ms] 角色落库 last=""
```

⇒ 角色**已在 zustand store 且面板渲染出来了**，但**从未到达后端**。定性为 **F-F（高，既存缺陷）**，见 §4。

**t5 现场的服务可用性（说明为何本报告不能重跑 e2e）**：

| 服务 | t5 实测 |
|---|---|
| 后端 `http://127.0.0.1:3774/api/health` | **DOWN**（连接被拒） |
| 前端 `http://127.0.0.1:5174` | **DOWN** |
| CDP 浏览器 `http://127.0.0.1:9222/json/version` | **200**（Chrome 仍在，但无被测页面/服务栈） |

⇒ **t5 无 e2e 复跑能力**（且 t5 无源码 writeScope、自建服务栈属 t4 的工作范围）。故 §2.6 全部结论**引用 t4 的实测**，**不冒充为本报告实测**。

---

## §3 与冻结契约 ADR 的偏离（**登记，不判失败**）

> 冻结契约 = `docs/architecture/dock-protocol-adr.md`。以下 **3 条偏离均已由 captain 裁定**，且**已在 ADR 内就地追加记录**（原文与「冻结」历史完整保留、未被重写）。

### 3.1 ADR §6.4 —— `--ink*` / `--cover-ink` 的删除前提**不成立** ⇒ **保留**

**ADR 原文**（L718，冻结）：把 `styles/globals.css` 中 `--ink*` / `--cover-ink` / 水墨注释与 `nm-ink-*` 类分给 t7 **删除**，前提是「零引用」。

**实测事实**：前提**不成立** —— 存在**百级活跃消费点**，且**真源完全不定义 `--ink*`**。

**t5 独立复算（自建 Node 脚本，扫描 `apps/` 全树、任意扩展名、排除 `node_modules`/`.git`/`dist`/`build`/`out`；399 个文件；形式 = 严格 `var(--ink…)`）**：

> ⚠️ **captain 裁定更正（2026-10-02）**：下表 t5 原记的 `--ink-pale` **31** 与合计 **186** **不成立**（口径混用，详见 §9.2）。
> 正确值 = **32 / 187**，已就地更正（t5 原值以「←（t5 原记 …）」标注保留）。

| token | 活跃消费点 | 定义数 | 定义位置 |
|---|---|---|---|
| `var(--ink)` | **72** | 2 | `globals.css:161`（`:root`）、`globals.css:374`（深色块） |
| `var(--ink-light)` | **83** | 2 | `globals.css:162`、`globals.css:375` |
| `var(--ink-pale)` | **32** ←（t5 原记 31） | 2 | `globals.css:163`、`globals.css:376` |
| **小计** | **187** ←（t5 原记 186） | | |
| `var(--ink-deep)` | 13 | **0** | **无定义**（悬挂，见 §3.3） |
| `var(--ink-soft)` | 5 | **0** | **无定义**（悬挂，见 §3.3） |
| `var(--cover-ink)` | 2 | 1 | `globals.css:72`（**保留**） |

**按目录分组（captain 用 `measure-ink-consumers.mjs` 复算，`A_raw` 口径 **187** 处 / 涉及 **24** 个文件）**：

| 目录 | 消费点 |
|---|---|
| `apps/plugins/**` | **87** |
| `apps/web/src/pages/**` | **49** |
| `apps/web/src/components/settings/**` | **21** |
| `apps/web/src/styles/**`（`globals.css` 23 + `landing.css` **7**） | **30** ←（t5 原记 29，`landing.css` 少算 1 处注释内出现） |
| **合计** | **187** |

**写法形态**：全部为 `hsl(var(--ink…))` **三元组**消费（`hsl()` 需要裸分量，故**不能**直接换成 `--vscode-*` 的完整色值）。

**真源不含这些名字**：`apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css` 定义 `--ink*` **0 次** ⇒ 硬删定义会让这 **187** 处拿到**无效值**，静默回落为继承色 = **大面积静默视觉回归**。

**captain 裁定（已落地，登记）**：

1. **保留** `--ink` / `--ink-light` / `--ink-pale` 三定义（`globals.css` `:root` 块 **L161-163** + 深色块 **L374-376**）；
2. **保留** `--cover-ink`（**L72**）；
3. **保留** `.glass-ripple-ink`；
4. **只改写水墨语义注释**（改为中性描述，并登记消费点计数与 `--vscode-*` 等价映射）；
5. **零选择器删除**（理由见 §3.2）。

**t5 现场核实（在位）**：`globals.css` L72 `--cover-ink: #1c1c1c;`；L161-163 `--ink: 0 0% 9%;` / `--ink-light: 0 0% 38%;` / `--ink-pale: 0 0% 58%;`；L374-376 暗档 `--ink: 0 0% 94%;` / `--ink-light: 0 0% 70%;` / `--ink-pale: 0 0% 52%;` ⇒ **三定义 + `--cover-ink` 全部在场**，与裁定一致。

**彻底移除的前置条件（不在本次范围）**：需**另开迁移任务**把上述 **187** 处消费点从 `--ink*` 迁到 `--vscode-*`。该迁移跨 `apps/plugins/**`、`apps/web/src/pages/**`、`apps/web/src/components/settings/**`，且**会改变外观**（`hsl()` 三元组需改为完整色值，或引入 `--vscode-*-hsl` 分量变量），故必须独立评审、独立验收。

**ADR 内已落地的就地标注**：`docs/architecture/dock-protocol-adr.md:725` `#### 6.4-a 偏离记录：本行（--ink* / --cover-ink / nm-ink-*）的删除前提经实测不成立（t2 追加，2026-10-02）`。

### 3.2 ADR §6.5 —— 「可删类」例外清单**逐条与事实矛盾** ⇒ **零选择器删除**

**ADR 原文**（L762，冻结）：「唯一例外：名字里直接带水墨语义且**无引用**的类（如 `.nm-ink-back`、`.nm-ink-lift`、`.nm-ink-divider`、`.nm-ink-title`、`.nm-no-brush`、`.nm-logo-seal`、`.nm-qbubble*`、`.nm-qp-*`）由 t7 复核引用后删除。」

**实测事实**：该清单**逐条不成立**。

| 类 | `globals.css` 是否有定义 | 仓库是否有活跃引用 | 实测判定 |
|---|---|---|---|
| `.nm-no-brush` | 有 | **有** —— `apps/plugins/shared/ui-kit/src/aiBars.tsx:415,518` | ❌ 前提不成立，**不得删** |
| `.nm-logo-seal` | 有（L1430，含 `::before` L1451） | **有** —— `apps/web/src/pages/LoginPage.tsx:106`、`RegisterPage.tsx:216` | ❌ 前提不成立，**不得删** |
| `.nm-qbubble*` | 有（L1979-2031，含 `@keyframes`） | **有** —— `apps/plugins/shared/ui-kit/src/aiBars.tsx:138,154` | ❌ 前提不成立，**不得删** |
| `.nm-qp-*` | 有（L2041-2088，含 4 个 `@keyframes`） | **有** —— `apps/plugins/manual/workbench/web/editor/panels/QuickPhraseBubble.tsx:406,409` | ❌ 前提不成立，**不得删** |
| `.nm-ink-back` / `.nm-ink-lift` / `.nm-ink-divider` / `.nm-ink-title` | **无**（`globals.css` 内根本不存在这些选择器） | 无 | ⚠️ 引用确实为零，**但无定义可删** |
| `.nm-brush` | **无**（同上） | 无 | ⚠️ 同上 |

**结论**：8 个被点名的类中，**4 个有活跃引用**（删了会直接破坏登录页 / AI 工具条 / 快捷短语气泡），另外 4 个及 `.nm-brush` 在 `globals.css` 里**根本没有定义**（属清单笔误 —— 引用为零是因为**它从未被实现**，而不是因为它被废弃）。
⇒ **该例外清单不产生任何正当的删除动作**；t7 若按此清单执行，会造成**可见的 UI 回归**。

**captain 裁定（已落地，登记）**：保留全部 `nm-*` 类名与定义，只按 ADR §6.5 正文把其内部值改为引用 `--vscode-*`；**不执行本例外清单的任何删除**。ADR §6.5 的**主体决策**（保留类名、只换值、不重命名）仍然正确并被遵守。

**ADR 内已落地的就地标注**：`docs/architecture/dock-protocol-adr.md:766` `#### 6.5-a 偏离记录：上面「唯一例外」清单逐条与事实矛盾（t2 追加，2026-10-02）`。

**链接缺口已闭合**：ADR 对 `docs/architecture/dock-refactor-final.md` 的引用数 **0 → 2**（此前偏离记录与权威契约之间**没有任何链接**，下游成员只读 ADR 仍会照旧清单硬删）。

### 3.3 既存悬挂引用 —— `--ink-deep` / `--ink-soft`（**残余风险**，本次不修）

| 令牌 | 消费点 | 定义 | 说明 |
|---|---|---|---|
| `--ink-deep` | **13** 处（`QuickPhraseBubble.tsx:256,456`；`apps/plugins/shared/ui-kit/src/aiBars.tsx:169,243,358,381,478`；`apps/web/src/pages/AdminPage.tsx:348,357`） | **全仓 0 处** | 消费但无定义 ⇒ 该处颜色**回退为无效值** |
| `--ink-soft` | **5** 处（`QuickPhraseBubble.tsx:274,288,421`；`AdminPage.tsx:367,490`）+ 1 处文档（`docs/design/ink-wash-migration.md:142`，该文档**已自行注明**「该变量全项目并未定义」） | **全仓 0 处** | 同上 |

**定性**：**既存问题，非本次引入**（这些消费点均不在本次改动范围内，`git status` 干净）。记为 **残余风险**，**本次不修**，建议随 §3.1 / §3.2 的收尾一并处理（对应 t4 §8.3）。

### 3.4 构建产物 CSS 判据修正（**原判据会误判失败**）

| 项 | 内容 |
|---|---|
| **原判据**（`dock-refactor-final.md` §5 产物判据表 L357） | 「构建 CSS 中 `--vscode-editor-background` 定义次数 = **恰好 1 次**」 |
| **为何错** | Vite **按 chunk 切分 CSS**，每个 chunk 各带一份是**正常**的 |
| **实测** | 全 `dist` 实际出现 **2** 次（`index-*` 1 次 + `ProjectLayout-*` 1 次）⇒ 按旧判据会得 **假失败** |
| **修正判据** | **同一 chunk 内不重复**，且**各含定义的 chunk 值一致** |
| **修正后结论** | ✅ **通过**（见 §2.4） |
| **处置** | **登记**；建议后续把 ADR §5 与最终文档 §5 的判据表一并改写为 per-chunk 口径（t4 §11.3 建议 ⑤） |

> 本报告**不据此判失败**：判据是**测量方法的错误**，不是产品的缺陷。产品侧证据（`ProjectLayout-CwE2_LDR.css` 有 **12** 处 `var(--vscode-editor-background)` 使用）证明该 chunk **真实消费**该令牌，不是「只定义不使用」的死定义。

### 3.5 ADR 路径笔误修正（F-4）

`docs/architecture/dock-protocol-adr.md:206` 的 `fore-shadow/ForeshadowWarning.tsx` → **`foreshadow/ForeshadowWarning.tsx`**（行号 40 未动）。全 ADR `fore-shadow` 残留 **0**；`foreshadow/` 命中 **L206**。**已由 t2 修正并复核。**

---

## §4 残余风险（**含 1 项高严重度**）

### 4.1 F-F（**高** · 既存缺陷 · 残余风险）—— 写请求超时被**静默吞掉** ⇒ **静默丢数据**

| 项 | 内容 |
|---|---|
| **现象** | UI 已显示新建角色（store 写入成功），**后端 `{"data":[]}`** —— 用户**无任何提示** |
| **触发条件** | AI 端点饱和（8 并发、单条约 24 s 的 `analyze-style`）占满 6 条同源连接 ⇒ `POST /api/characters` 排队中被 **8 s 客户端超时** abort |
| **直接成因（t4 实测）** | ① `apps/plugins/shared/data-core/src/api/apiClient.ts:103` `const DEFAULT_TIMEOUT_MS = 8000;`；② `:234` `const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;`；③ `apps/plugins/shared/data-core/src/data/databaseService.ts:98` `async function apiSave<T …>` + `:105-112` 的 `silent: true` + `console.warn` + `return null`；④ **`apiClient.ts:362-363`** `const timeoutErr = new ApiError(0, 'TIMEOUT', \`请求超时 (${timeoutMs / 1000}s)\`); if (!options?.silent) dispatchApiErrorEvent(timeoutErr);` ⇒ **`silent:true` 使超时既不弹 toast、也不重试**（`apiClient.ts` 全文**无任何 retry 逻辑**） |
| **上游成因（captain 定位，t5 已逐行复核为真）** | **`apps/plugins/manual/workbench/web/editor/panels/StyleAdvisor.tsx:77-92`**：L77 `timerRef.current = setTimeout(() => {`；L78-81 `if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }`；L82-83 `const controller = new AbortController(); abortRef.current = controller;`；**L85 `styleService.analyzeStyle(texts).then(({ profile, isLocalFallback }) => {`** ← **controller 建了却从未传进去**；L86 / L90-92 只在 `.then` / `.catch` 里读 `signal.aborted`（**仅影响是否打日志，取消不了请求**）。**`apps/plugins/shared/data-core/src/editor/styleService.ts:146`** `async analyzeStyle(chapters: string[]): Promise<StyleAnalysisResult> {` ← **签名无 signal 参数**；**`:161`** `{ silent: true, timeoutMs: 60_000 },` ⇒ 请求**不可取消**，被 abort 后仍占 socket 至 **60 s** |
| **并发来源精度** | `StyleAdvisor` **本身有 3000 ms 防抖**；真正**无防抖**的是 `apps/plugins/manual/workbench/web/editor/EditorPage.tsx:134-157`（`:134` deps `[chapters]`，`:142` 立即调用，`:136` 建了 `AbortController` 却**从未传入**）。**两者同样不传 signal、同样不可取消** ⇒ 并发**主要来源是 `EditorPage`** |
| **范围判定** | **既存缺陷**：`git diff --stat HEAD -- apps/plugins/manual/workbench/web/editor/EditorPage.tsx` **为空**；worktree blob = HEAD blob = `1ef7b123e44b85a14630ab87c92323fd07319bce` ⇒ **与 HEAD 逐字节相同**。该 e2e 断言在 HEAD 脚本中**早已存在** |
| **是否停靠重构回归** | **否** —— 与 `DockShell` / `ProjectLayout` / `dock/**` **无任何因果关系** |
| **是否本次范围** | **不属本次范围** ⇒ **建议另开任务** |
| **建议修法** | ① 超时**可见化 / 可重试**；② 写入路径走**独立于 AI** 的连接或队列；③ 修 `EditorPage.tsx` 的**未防抖** + `styleService.analyzeStyle` 的**缺 signal 参数**两处 |

> **路径勘误（重要）**：任务交底与 t4 报告均引用 `apps/web/src/pages/EditorPage.tsx` —— **该路径不存在**（`Get-FileHash` 报 `Could not find file`）。**真实位置 = `apps/plugins/manual/workbench/web/editor/EditorPage.tsx`**（26730 B，mtime 2026-09-30 11:22:41）。§4.1 的逐行复核均在该真实路径上完成，结论与 t4 一致。

### 4.2 其余残余风险

| # | 项 | 严重度 | 定性 | 处置 |
|---|---|---|---|---|
| 1 | `--ink-deep`（13 处）/ `--ink-soft`（5 处）**悬挂引用**（全仓 0 定义） | 中 | **既存**，非本次引入 | 登记（§3.3），本次不修 |
| 2 | **F-E** e2e 夹具附着「第一个 page target」⇒ 遗留标签页 `Runtime.enable` **回放**历史 console ⇒ **假失败** | 中 | **夹具/环境问题**，非产品缺陷 | 夹具侧修 `page = pages.find(...)` 增加 URL 校验；或运行前清理遗留 page target（t4 §11.3 建议 ②） |
| 3 | **F-A / F-B / F-C / F-D**（各低） | 低 | 见 §6 台账 | 随后续清理任务一并处理 |

### 4.3 未自动化交互项（**6 项「需人工确认」，未伪造通过**）

见 §5。

---

## §5 「需人工确认」清单（t4 §9 的 6 项，**原样转录**）

> 以下项目在 headless/CDP 环境下**无法稳定自动化**（依赖真实鼠标轨迹、hover 时序、拖拽释放坐标）。
> 按硬约束，**一律标「需人工确认」**，给出可执行的人工核对步骤；**本报告不将其计为 PASS**，也**未伪造为已通过**。

| 编号 | 项目 | 状态 | 人工核对要点（完整步骤见 t4 §9） |
|---|---|---|---|
| 9.1 | 能力 2 拖拽浮窗 + 拖回停靠 | **需人工确认** | 按住面板标签页拖动 → 期望脱离成**浮窗**、可移动可缩放 → 拖回停靠区任意槽位 → 期望重新停靠、**无残影、无重复实例** |
| 9.2 | 能力 5 落位预览可见性 | **需人工确认** | 拖动面板**不松手** → 期望目标区出现**半透明填充（`--vscode-panel-dropBackground`）+ 2px 高亮描边（`--vscode-focusBorder`）**的预览块、**圆角为 0** → 分别拖向中心区与侧边区，预览块位置应分别对应编辑区/侧栏 → 松手后预览消失、面板落入该槽 |
| 9.3 | 能力 7 分栏拖拽（sash） | **需人工确认** | 鼠标移到分隔条 → 期望高亮为 `--vscode-sash-hoverBorder` → 拖动期望两侧宽度**实时变化**、松手**保持** → 拖到极窄期望**不塌陷、不出现 0 宽面板** |
| 9.4 | 能力 4 标签堆叠的交互顺序 | **需人工确认** | 同区打开 2 个面板 → 拖动 tab 改变左右顺序 → 期望顺序变化并保持；`closable:false` 的面板标签**不应出现 ×** |
| 9.5 | VS Code 外观一致性 | **需人工确认** | 对照 `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css` 令牌语义，核对活动栏/侧边栏/编辑区/底部面板/状态栏的**底色、描边、悬停高亮、圆角**；重点核对**圆角为 0**、**分栏线 1px**、**落位描边 2px** |
| 9.6 | **能力 8 —— Linux 运行时未实测** | **需人工确认** | 在 Linux（建议 Node 24，`better-sqlite3` 需对应 ABI）安装并 `build` / `test`（期望 EXIT=0）→ 启动后端 + vite → 进入 manual 项目 → 期望停靠外壳正常渲染、§4 八项能力表现与 Windows 一致；重点核对路径分隔符（`import.meta.glob` 展开是否仍命中 `moduleEntries.ts:79`）、原生模块加载、文件监听 |

> **自动化程度说明**：9.1–9.5 的**代码路径与样式令牌已全自动 PASS**（t4 §4.2 / §4.5 / §4.7 / §4.4 / §4.8），未自动验证的是**真实鼠标交互与主观视觉**；9.6 的**源码级跨平台洁净度已全自动 PASS**（t4 §6），未自动验证的是 **Linux 运行时**。
> 除上述 6 项外，本报告与 t4 报告的其余全部结论均由**可复现的命令/探针输出**支撑。

---

## §6 Findings 处置台账

> 口径：**只登记，不改源码**（本任务为报告任务）。凡**非本次重构引入**者均明确标注，**不据此判失败**。
> 台账分两组：**收尾期 findings（F-1…F-6，t2/t3 阶段）** 与 **验证期 findings（F-A…F-F，t4 阶段）**。

### 6.1 收尾期 findings（F-1…F-6）

| ID | 严重度 | 内容 | 处置 | 状态 |
|---|---|---|---|---|
| **F-1** | 中 | **临时探针污染 vitest 收集范围**：`__scratch__/reverted-probe.test.tsx` 落在 `src/**` 收集树内，修复前 `vitest list --filesOnly` = **13 文件**（含 4 条探针用例） | **已闭环**（t2）：`apps/web/vitest.config.ts` 的 `test.exclude` 增 `'**/__scratch__/**'` + `'**/__scratch_*'`（+12 行注释说明危害）；新增 `apps/web/vitest.probe.config.ts` 逃生舱（与主配置**仅**差在放开 scratch 命名，`node_modules`×4 / `dist` / `e2e` 排除项一律保留）。修复后 = **12 文件** | ✅ **闭环** |
| **F-1 附带** | — | **工具用法更正**（曾在 t2 的源码注释里写成过宽表述：「探针仍可显式指定路径运行」） | **已更正落盘**：明确 vitest 位置参数是「对**已收集文件**的过滤」⇒ 被 exclude 的**探针**连显式路径也报 `No test files found`；**普通**测试文件显式路径运行**不受影响**（实测 `DockShell.smoke.test.tsx` → 17 passed / EXIT=0）。`vitest.probe.config.ts` 头部同步加「⚠ 适用面**仅限探针命名**」 | ✅ **更正完成** |
| **F-2** | 中 | **测试镜像与源码漂移**：`plugin-dock-adaptation.test.ts` 未覆盖 `ProjectLayout.tsx` 的 `activeKey` 优先分支 | **已闭环**（t2）：镜像补 `activeKey` 优先分支 + 3 条用例 + **源码级漂移守卫**（直读 `ProjectLayout.tsx` 断言优先分支在倒序扫描**之前**、判定经 `resolveDockMeta(def).center` **单点取值**）。**修复前失败证据已留**（旧镜像跑新用例 → case A FAIL `AssertionError: expected 'storyMap' to be 'relationGraph'`）。该文件 8 → **12 tests 全绿** | ✅ **闭环** |
| **F-3** | 低 | `apps/web/src/components/shell/DockShell.tsx:360:5` Unused eslint-disable directive（`react-hooks/exhaustive-deps`） | **仅记录不改**（既存；维持 **0 errors / 1 warning**，即基线口径） | 📝 登记 |
| **F-4** | 低 | ADR 路径笔误 `fore-shadow/` → `foreshadow/` | **已闭环**（t2）：ADR L206 修正，全 ADR `fore-shadow` 残留 **0** | ✅ **闭环** |
| **F-5** | — | （**编号未使用**） | t2 阶段该编号未产生独立 finding | — |
| **F-6** | 中 | **ADR 契约与实测事实矛盾且无链接**：§6.4 移除清单仍无标注地写「删除 `--ink*`」；§6.5 例外清单仍写「无引用的类可删」；全 ADR 对 `dock-refactor-final.md` 的引用数 = **0** | **已闭环**（t2）：新增 **§6.4-a**（L725）+ **§6.5-a**（L766），**原文与「冻结」历史完整保留**、未重写契约；§6.5-a 逐条带行号证据；ADR 对 `dock-refactor-final.md` 的引用 **0 → 2** | ✅ **闭环** |

### 6.2 验证期 findings（F-A…F-F）

| ID | 严重度 | 一句话 | 本次引入？ | 影响验收结论？ | 处置 |
|---|---|---|---|---|---|
| **F-A** | 低 | `DockShell.tsx:450-451` 注释与 dockview「重复 id 会 throw」的真实行为**不符** | 否（**文档/注释**） | **否** | 登记；**建议更正措辞**（见下） |
| **F-B** | 低 | `addPanel` 参数在 `buildAddSpec`（`:613-628`）与 `openPanel` center 分支（`:458-469`）**重复硬编码**（`component`/`title`/`params`/`position`/`minSize`），有漂移风险 | 否（既存结构） | **否** | 登记不改；建议后续抽取为单一 `buildAddSpec` 调用 |
| **F-C** | 低 | `onActivitySelect`（`:533-545`）只查普通 id，对已抢占 center 面板必然落空，靠 **fix 4** 兜成幂等 `setActive` ⇒ **隐式依赖** | 否 | **否**（功能正确） | 登记不改；建议显式用 `meta.center ? centerPanelInstanceId(key) : panelInstanceId(key)` 或在注释中声明该依赖 |
| **F-D** | 低 | `[aria-label="设置"]` **全仓 2 处**（`ProjectLayout.tsx:397` 与 `apps/web/src/pages/BookshelfPage.tsx:351`）⇒ 最终文档 §4 的「仓库唯一」表述应改为「**外壳内唯一**」 | 否（文档表述） | **否** | 登记；建议修正表述为「外壳内唯一」 |
| **F-E** | 中 | e2e 脚本附着「第一个 page target」⇒ 遗留标签页 `Runtime.enable` 回放历史 console（实测 15 条 `[ErrorSystem] API Error dispatched`，到达跨度仅 **1 ms**）⇒ **假失败** | 否（**夹具**） | **否** | 登记；夹具侧修 `scripts/e2e/e2e-core-flows.mjs:118` 与 `scripts/e2e/e2e-mode-separation.mjs:101-103` 的 `page = pages.find(...)` 增加 URL 校验 |
| **F-F** | **高** | 写请求 8 s 超时被 `silent:true` **静默吞掉** ⇒ **静默丢数据** | **否（既存）** | **否**（非停靠重构范围） | 登记为**残余风险**（§4.1）；**建议另开任务** |

> **F-F 是本次唯一「高」严重度发现**，但它**不属于停靠重构范围**（与 HEAD 逐字节相同），故**不影响本次验收判定**。

### 6.3 F-A 的独立复核与建议更正措辞

**t5 独立复核（比 t4 的单一引用更细：dockview 8.4.0 有两条独立的重复 id throw 路径，任务交底与 t4 报告各引其一，两者都是真的）**：

| 站点 | 位置（`node_modules/dockview-core/dist/package/main.cjs.js`，788254 B，version **8.4.0**） | 性质 |
|---|---|---|
| **入口校验** | **L17784** `addPanel(options) {` → L17785 `return this.mutation("add", () => this._doAddPanel(options));` → L17787 `_doAddPanel(options) {` → **L17788** `if (this.panels.some((_) => _.id === options.id)) throw new Error(\`dockview: panel with id ${options.id} already exists\`);` | `addPanel` **入口**的重复 id 校验 |
| **事件序列守卫** | **L14800** `if (panels.has(panel.api.id)) throw new Error(\`dockview: Invalid event sequence. [onDidAddPanel] called for panel ${panel.api.id} but panel already exists\`);`（在 `init()` 的 `onDidAddPanel` 订阅内） | 事件序列一致性守卫 |

⇒ **结论：dockview 8.4.0 对重复 id 是 `throw`，绝无「静默忽略」。** 因此 `DockShell.tsx:450-451` 的注释「靠 dockview 静默忽略才没炸」**为假**。

**旧代码的真实后果（比注释所述更严重）**：旧 `canonicalId = panelInstanceId(key)` **漏掉了 `nm-center:<key>`** ⇒ `addPanel({id:'nm-panel:<key>'})` 是一个**全新 id** ⇒ **不报错**，而是**真的多建了一个普通实例**。`listPanels()` 按业务 key 去重**把它藏起来了**，只有 DOM `[data-tab-panel-id]` 才暴露它（这正是 t4 §5.5 用 DOM 计数而非 `listPanels()` 的原因）。

**修复本身正确**（四处修复已由 t4 §5.2 与 t3 逐条独立确认）；**仅注释措辞不实**，作为**低 severity 遗留项**登记。

**建议更正措辞**（以 `:450-451` 上下文复核为准）：

> 原文（不实）：「旧代码只查普通 id，故对已抢占中心区的 center 面板会再 `addPanel` 同一个 `nm-center:<key>`（重复 id）——靠 dockview 静默忽略才没炸，属隐式依赖。」
>
> **建议改为**：「旧代码只查普通 id，故对已抢占中心区的 center 面板会走 `addPanel`，且用的是**普通 id** `nm-panel:<key>`（与已有的 `nm-center:<key>` 不是同一个 id）⇒ dockview **不会**报重复，而是**真的建出第二个普通实例**（`listPanels()` 按 key 去重会掩盖它，只有 DOM `[data-tab-panel-id]` 能看出）。属隐式依赖，现已改为查规范 id。」

---

## §7 方法与边界声明（**必须读**）

> 本节用于防止读者把 **t4 的实测**误读为 **t5 的实测**。

### 7.1 t5 **本人现测**的范围（可复现，全部有原始输出）

- §1 全部交付物的**字节数、行数、最后写入时间**（`Get-Item` / 行计数）。
- §2.2 / §2.3 的**七条命令 exit code 与输出摘要**（`cmd /c`，原始退出码，留档 `%TEMP%\t5-verify-log.txt`）。
- §2.4 的 **dist 产物串计数与 CSS per-chunk 判据**（自建 Node 脚本）。
- §2.5 的**三文件 SHA256 / 字节数**与**工作区清洁度**（`Get-FileHash` / `Test-Path` / `git status --porcelain` / `git stash list` / `git rev-parse`）。
- §3.1 / §3.3 的 **`--ink*` 消费点计数**（自建 Node 脚本，五种口径交叉验证）、**定义位置在位核实**、**真源 0 定义核实**。
- §6.3 的 **dockview 双 throw 站点定位**（直接读 `main.cjs.js`）。
- §4.1 的**上游成因逐行复核**（在**真实路径** `apps/plugins/manual/workbench/web/editor/EditorPage.tsx` 与 `StyleAdvisor.tsx` / `styleService.ts` / `apiClient.ts` 上）。
- §2.6 的**服务可用性探测**（`3774` DOWN / `5174` DOWN / `9222` 200）。

### 7.2 t5 **没有做**的事（**不得冒充**）

- ❌ **t5 没有重跑 e2e**（`scripts/e2e/*.mjs` 一个都没跑）—— §2.6 的 e2e 结论**全部引用 t4**。
- ❌ **t5 没有重跑浏览器探针** —— §2.1 能力 6 的证据来自 **t4** 的 `.verify-scratch/probe-center-slot.mjs`，**不是 t5 跑的**。
- ❌ **t5 没有自建服务栈**（后端 / vite / headless Chrome）—— 那是 t4 §1.3 的工作；t5 现场三项服务已有两项不可用。
- ❌ **t5 没有修改任何产品源码**（本任务为报告任务，无源码 writeScope）。
- ❌ **t5 没有删除任何文件**（含 `docs/reports/**` 下的历史报告，一份未删）。
- ❌ **t5 没有执行** `git checkout` / `git restore` / `git stash` / `git clean`；**没有新建 commit**。

### 7.3 证据来源一览（谁测的）

| 结论 | 证据来源 |
|---|---|
| 八项能力判定 | **t4**（§4）+ **t4** 真实浏览器探针（能力 6） |
| 七条命令 exit code | **t5 实测**（与 t4 的 §2 结论一致，相互独立复现） |
| 构建产物判据 | **t5 实测**（与 t4 §3 独立复测一致） |
| 三文件哈希 | **t5 实测**（与 captain attestation、t4 §1.2 **三方一致**） |
| 工作区清洁度 | **t5 实测** |
| e2e 38/39 与失败项定性 | **t4**（§7.2–7.5） |
| F-F 两层机制链 | **t4 实测直接成因** + **captain 定位上游成因** + **t5 逐行复核确认** |
| ADR 三条偏离的裁定 | **captain 裁定**；**t2** 已在 ADR 内就地标注；**t4 独立复算一致**；**t5 独立复算一致**（§3） |
| 6 项需人工确认 | **t4** §9（本报告原样转录） |

### 7.4 与 t4 报告的交叉引用（**t4 是独立验证方**）

- t4 报告 = `docs/reports/dock-refactor-verification.md`（**75359 B / 1099 行**，§0–§11，**总判定 pass**）。
- **t4 §11.2 的 10 项与 captain 基线交叉核对全部一致**（测试基线 12 files / 153 passed、lint 0 error / 1 warning、`ProjectLayout-BE5p2nO0.js` 重建后 hash/体积一致、`dockview` = 69、唯一 `center:true` = 1 处、CSS per-chunk 判据、三文件哈希、`--ink*` 消费点、§6.5 零删除正当、工作区清洁）。
- **t4 §11.4 的方法与边界声明**与本报告 §7.2 同构：t4 亦**未修改任何产品源码**、**未执行**毁伤性 git 命令；其 e2e 变体为 `scripts/e2e/*.mjs` 的**影子副本**（存于**仓库外** `.verify-scratch/`，与原文的字节差异**仅为注入块**，`node --check` 均 EXIT=0）。
- **两份报告的分工**：t4 = **独立验证**（含真实浏览器与 e2e 实测）；t5 = **收尾汇总与结案**（含现场命令复测、哈希 attestation、清洁度、偏差登记）。**二者结论无冲突**。

---

## §8 诚实登记（**不许粉饰**）

### 8.1 哈希 attestation 与最终产物的关系

**结论：已核实一致。**

t5 在开工时（t4 已完成、评审期临时产物已清理后）重算三文件 SHA256 与字节数，**逐字节等于** captain attestation 与 t4 §1.2 的值（见 §2.5）。⇒ 评审期间的证伪/回退/清理过程**未污染**这三个文件；attestation 仍然有效，**无需登记任何差异**。

### 8.2 t3 的三条局限（**逐条如实登记，不美化**）

| # | 局限 | 如实表述（**必须使用此口径**） |
|---|---|---|
| **(a)** | 冒烟测试的 **12 个既有用例无 git 基线可 diff** | 该文件（`DockShell.smoke.test.tsx`）**untracked**，仓库内**无 git 基线**，全树搜标题只命中自身。因此**只能**证明「**12 用例全部存在且断言未减**」（逐条 verbatim 复核标题 + 字段级断言）。**不得宣称做过「逐字 diff」或「与基线比对」** —— 任何此类声称都是**虚假保证**。 |
| **(b)** | task-5 窗口（11:20–11:40）内另有 3 份实质改动与「只改 DockShell.tsx」自述范围不符 | **已由 captain 补全为「跨成员并发，非越界」**（**不得再写「窗口归属未证」**）：`apps/web/src/components/shell/DockShell.tsx` mtime **11:32:21 → restore-eng**（一号 task-5，唯一 writeScope）；`scripts/e2e/e2e-core-flows.mjs` **11:21:15** / `apps/web/src/styles/globals.css` **11:36:48** / `apps/web/src/styles/landing.css` **11:37:08** → **cleanup-eng**（一号 task-2，其 writeScope 含 `scripts/e2e` 与 `apps/web/src/styles`）⇒ 三文件**全部落在 cleanup-eng 的 writeScopes 内**，与 restore-eng 是**一号团队内部两名成员并行**（**不是二号的任务**），时间窗重叠属**正常并发**。**保留澄清句**：「『只改 DockShell.tsx』的自述**本身没错**，它描述的是 restore-eng 自己的改动集，不是整个窗口的全仓改动集。」 |
| **(c)** | F-A 的注释口径不实 | `DockShell.tsx:450-451` 称「靠 dockview 静默忽略重复 id 才没炸」**为假**：dockview 8.4.0 `_doAddPanel` 对重复 id **throw**（两条独立站点，见 §6.3）；**真实后果更严重** —— 旧代码另建全新 id `nm-panel:<key>` ⇒ **真的建出第二个普通实例**。**修复正确，仅注释措辞不实**；报告已给出**建议更正措辞**（§6.3）。 |

### 8.3 e2e 角色面板持久化 1 项失败（38/39）

如实记录：`scripts/e2e/e2e-core-flows.mjs` 为 **38/39 通过、EXIT=1**，唯一失败项 = 「UI 创建的角色已持久化到后端」。**已定性为既存缺陷 F-F、非停靠重构回归、不属本次范围**（§4.1）。

> t4 在早期同步中曾报告「脱离 e2e 壳直连 CDP 复现同一操作时角色创建与持久化均成功」，但**最终报告**（§7.5）给出的是**两层机制链 + 已排除项 6 条**的完整定性（连接池饱和 ⇒ 8 s abort ⇒ `silent:true` 静默吞掉）。本报告采用**最终报告**的定性。
> **本报告不对该失败项做任何额外推断**：机制链的每一环都有文件:行与实测证据支撑；**未测到的部分不猜**。

### 8.4 lint 警告口径

**基线 = 1**（唯一 warning = `DockShell.tsx:360:5` Unused eslint-disable，**既存**）。
- 评审期该数字曾因 reviewer 的临时产物升至 **12**（`DockShellReverted.tsx` 1 条 + `__scratch__/reverted-probe.test.tsx` 5 条 `no-console`，加上后续自建副本）。
- 临时产物**已全部清理**（§2.5 实测 `False` / `False` / NO HITS / stash EMPTY）。
- **t5 现场实测回到 1** ⇒ 与 captain 基线一致。
- **口径**：**0 errors / 1 warning**，exit code **0**。

### 8.5 t5 现场与任务书不符的两处（**均已定性**）

**① dockview 重复 id throw 的站点引用不同（**两者都是真的，不是矛盾**）**：任务交底引 **L17784-17790**（`addPanel` 入口的 `_doAddPanel` 校验，实际 throw 在 **L17788**），t4 报告引 **L14800**（`init()` 内 `onDidAddPanel` 的事件序列守卫）。t5 独立复核确认 **dockview 8.4.0 存在两条独立的重复 id throw 路径**，报告已将两者**同时登记**（§6.3）。⇒ **不是错误，是两处不同站点**。

**② F-F 的 `EditorPage.tsx` 路径不存在**：任务交底与 t4 报告均写 `apps/web/src/pages/EditorPage.tsx`；实测**该文件不存在**，真实位置 = `apps/plugins/manual/workbench/web/editor/EditorPage.tsx`。已在 §4.1 登记勘误，逐行复核改在真实路径完成（**结论与 t4 一致**，仅路径需更正）。

---

## §9 偏差登记（与任务书数字不一致者）

> 原则：**报告内所有数字必须来自实际执行，不得估算、不得转述未验证的自述。** 凡与任务书/既有文档不一致者，**登记我实测的值并说明成因**。

### 9.1 七条命令：**无偏差**

type-check 0 / lint 0 / build 0 / test 0 / verify-theme-single-source 0 / verify-all 0 / verify-plugin-mode-separation 0 —— **7/7 与 captain 预期基线完全一致**。
测试基线 **12 files / 153 passed** ✅ 一致；lint **0 errors / 1 warning** ✅ 一致。

### 9.2 `--ink*` 消费点计数：t5 实测 **186**，**经 captain 裁定为口径混用，187 才是正确值**（本节已被裁定覆盖）

> ⚠️ **裁定结论（captain，2026-10-02，追加于 t5 原文之后）**：t5 在本节提出的「187 应更正为 186」**被否决**。
> 187 **是正确的**；真正需要更正的是**拆分**（应为 72 / 83 / **32**，而非 73 / 83 / 31）。
> **t5 的 186 无法用任何单一定义复现** —— 它是 `A_raw + A_raw + B_code` 的**混合口径**（72 + 83 + 31），
> 而 187（`A_raw`）与 182（`B_code`）都是可复现的单一取值。按 t5 的建议改，会把文档从
> 「可复现的保守口径」改成「无法用任何定义复现的拼凑数字」，属**退步**，故不采纳。
> **t5 原文完整保留于下方**（含其五轮扫描记录），因为其中对「73 的来源」的归因是**正确且有价值**的，
> 仅**结论方向用错**（应改拆分，而非改总数）。

**t5 原文（保留）**：

**三方数字不一致**（任务书交底 / t1 报告 / 既有文档）：

| 来源 | `var(--ink)` | `var(--ink-light)` | `var(--ink-pale)` | 合计 |
|---|---|---|---|---|
| 任务书交底 & `dock-refactor-final.md` §6.1 & ADR §6.4-a | 73 | 83 | 31 | **187** |
| t1 §10.3 复测 | 72 | 83 | **32** | 187 |
| **t5 实测（本报告采用）** | **72** | **83** | **31** | **186** |

**t5 的五轮独立扫描（自建 Node 脚本，逐次更换口径，均排除 `node_modules`/`.git`/`dist`/`build`/`out`）**：

1. `apps/` 全树、限定代码扩展名（334 文件）：**72 / 83 / 31 = 186**。
2. 全仓（1277 文件）：**127 / 106 / 42 = 275**（其中 `.md` 贡献 13）—— 含 `.workbuddy` / `.agent-teams` / `docs`，**不属于产品消费点**。
3. 按 scope 分：`apps/`（399 文件，**任意扩展名**）= **72 / 83 / 31 = 186**；`docs/`（41 文件）= 16 / 2 / 2 = 20；仓库根散文件（17 个）= **0**。
4. **变体口径**（关键）：`var(--ink)` 严格 **72**、前缀 `var(--ink` **206**、带回退 `var(--ink,` **0**、定义 `--ink:` **2**；`--ink-light` 严格 **83**；`--ink-pale` 严格 **31** / 前缀 **32** / **回退 1**。
5. **dist 影响验证**：含 dist/build（481 文件）= 131 / 165 / 61 = 357；排除 dist/build（399 文件）= **72 / 83 / 31 = 186**。

**差异成因（已定位，可解释）**：

- **t1 的 32 可解释**：来自**前缀计数** `var(--ink-pale`，多算了 `apps/web/src/styles/landing.css:21` 的 **`hsl(var(--ink-pale, 0 0% 58%))` 回退写法** 1 处。⇒ **31 是严格计数，32 是前缀计数。**
- **captain 交底的 73 无法复现**：五种口径下 `var(--ink)` 均为 **72**，未发现第 73 处。**唯一能把 73 数出来的正则**是 `--ink($|[,);\s])`（匹配裸 token 名而非 `var()` 用法），它在 `apps/` 上得 **73** —— 多的那一处是 `globals.css:150` 的**说明性注释行**：
  ```
  --ink        ≈ --vscode-editor-foreground         (L41  hsl(220 14% 85%))
  ```
  该行是 t2 新增的**映射说明注释**（§3.1 裁定第 4 条「登记 `--vscode-*` 等价映射」的产物），**不是消费点**。同理该正则对 `--ink-light` 得 84（多 `globals.css:151`）、对 `--ink-pale` 得 33（多 `globals.css:152` + `landing.css:21` 回退）。⇒ **73/83/31 是「把注释里的裸 token 名也算进去」的口径**。

**⇒ 磁盘事实（本报告采用）**：

| 口径 | `--ink` | `--ink-light` | `--ink-pale` | 合计 |
|---|---|---|---|---|
| **严格 `var(--ink…)`（消费点，推荐）** | **72** | **83** | **31** | **186** |
| 剥离注释后严格计数 | 69 | 82 | 30 | **181** |
| 裸 token 名（含注释里的映射说明行） | 73 | 84 | 33 | 190 |

**结论方向不变**：三个口径都得出「**百级活跃消费点 ≫ 零引用**」，**§3.1 的裁定（保留三定义）在任一口径下都成立**。本报告采用**严格 `var()` 计数 186**，并同时登记 181（剥注释）与 190（裸 token）以覆盖读者可能的复核口径。
**建议**：后续更新 `dock-refactor-final.md` §6.1、ADR §6.4-a 与 t4 报告 §8.1 的 `187` → **186**，并在 ADR §6.4-a 内注明三种口径。

---

#### ★ captain 裁定后的最终口径（**取代上方 t5 结论**，2026-10-02）

口径已固化为**可复现脚本** `scripts/verify/measure-ink-consumers.mjs`（**测量工具，非门禁，退出码恒为 0**），一次输出三列：

| 口径 | 定义 | `--ink` | `--ink-light` | `--ink-pale` | 合计 |
|---|---|---|---|---|---|
| **`A_raw`** | `var(\s*<token>(?=\s*[,)]))`，**含**块注释内出现（历史文档口径，保守） | **72** | **83** | **32** | **187** ✅ **文档应采用此值** |
| **`B_code`** | 同 `A_raw` 但剔除 `/* … */` 内的出现 ⇒ **真实代码消费点** | 69 | 82 | 31 | **182** |
| **`C_bare`** | `<token>(?=$|[,);\s])` ⇒ 裸 token 名（含注释说明行，**非消费点**） | 73 | 84 | 33 | **190** |

**⇒ 裁定：187 正确，拆分 = 72 / 83 / 32。**

**逐条更正 t5 本节的三处判断**：

1. **「186 才是严格计数」→ 错。** 186 = 72 + 83 + 31，是 `A_raw` 的前两项 + `B_code` 的第三项，**不是任何单一口径**。
   严格 `A_raw` = **187**；严格 `B_code` = **182**。t5 的 `--ink-pale` = 31 是 **`B_code` 值**（它把 `globals.css:155` 这处**位于注释内**的 `var(--ink-pale)` 剔除了），
   而 `--ink` 的 72 却是 **`A_raw` 值**（t5 保留了注释内的 `var(--ink)`）。**同一张表里混用了两个口径** ⇒ 这才是差异的真因。
2. **「32 来自前缀计数、31 才是严格计数」→ 错。** captain 逐行枚举验证：`apps/` 全树（334 文件，与 t5 同口径）严格 `var(--ink-pale…)` 命中 **恰好 32 处**，逐一定位为
   `FindReplaceBar.tsx:206,223,251,316,330`、`WriterMode.tsx:49,66,68,79,104`、`QuickPhraseBubble.tsx:337`、`CharacterManager.tsx:427,462,500,502`、`TrashDialog.tsx:139,153,190`、`NoteManager.tsx:115,135,136,167,219,259,267,269`、`ProjectIndexPage.tsx:192`、`globals.css:155,1172,1173,1181`、`landing.css:21`。
   **`landing.css:21` 的 `hsl(var(--ink-pale, 0 0% 58%))` 是真实消费点**（它读取该变量），**不是** 32 的来源。
   第 32 处正是 **`globals.css:155` 自身那句注释**（`` `var(--ink-pale)` 32），全部是… ``）—— **自引用**。
3. **「73 无法复现」→ 部分对，但方向用错。** 73 **可以**复现，即 `C_bare` 口径（裸 token 正则含注释行），t5 对成因的定位**正确**。
   但正确结论是「**73 是 `C_bare`、72 是 `A_raw` ⇒ 文档里的 73 应改为 72**」，
   **而不是**「73 无法复现 ⇒ 把总数 187 改成 186」。**改的是拆分，不是总数。**

**最终更正清单（captain 已执行）**：`dock-refactor-final.md` §6.1（73→72、31→32、`--ink-deep` 14→13）、§10.3 复测表（`--ink-deep` 14→13）、ADR §6.4-a（73→72、31→32）、`apps/web/src/styles/globals.css:154-155`（注释内 73→72、31→32）、t4 报告 §2.7 与 §8.1。**187 与 182 两个总数均保留不动。**

**另：`--ink-deep` 与 432 文件两项，t5 的登记成立、已被采纳**（见 §9.3、§9.4）。

### 9.3 `--ink-deep` 计数：实测 **13**（既有文档记 14）

`--ink-deep` 严格计数 = **13**（`QuickPhraseBubble.tsx:256,456`；`aiBars.tsx:169,243,358,381,478`；`AdminPage.tsx:348,357`），全仓**定义 0 处**。
`dock-refactor-final.md` §6.1 记 **14** ⇒ **差 1**，属既有文档笔误。`--ink-soft` = **5**，与文档一致。
（§3.3 已按 **13 / 5** 登记。）

**captain 裁定（2026-10-02）**：**t5 的登记完全成立、已采纳**。captain 用 `scripts/verify/measure-ink-consumers.mjs` 独立复算，`--ink-deep` 在 `A_raw` / `B_code` / `C_bare` **三个口径下一致为 13** ⇒ 原记 14 是**纯笔误**（非口径差异）。已回改 `dock-refactor-final.md:386` 与 `:527`（含其自注「⚠️ 差 1」一并修正为一致），并在 §10.3 复测表同步。

### 9.4 verify-theme-single-source 的全仓扫描文件数：**432**（t4 §2.7 记 421）

t5 实测 `全仓扫描 432 个文件`；t4 报告记 421。差异**不影响任何不变量结论**（白名单内 117 / 白名单外 0 在两次运行中一致）。**仅登记，不判失败。**

**captain 裁定（2026-10-02）**：成因已查明 —— `scripts/verify/verify-theme-single-source.mjs` 从**仓库根**递归扫描，`SCAN_EXTS` 含 `.css .scss .sass .less .ts .tsx .js .jsx .mjs .cjs .html .vue .svelte`，`SKIP_DIRS` = `node_modules dist build .git .workbuddy coverage` ⇒ `docs/`、`scripts/` 与**现场临时产物**都会计入。三个快照构成：t4 **421** → t5 **432** → captain **433**（`.tmp_b410e32_ProjectLayout.tsx` 1 + `.verify-scratch/` 44 + `apps` 335 + `docs` 2 + `packages` 24 + `scripts` 27）。**这是同一口径在不同时刻的快照，不是缺陷**，**该数字不用于任何判定**。**t5 的登记成立、已采纳。**

---

## §10 结论与移交建议

### 10.1 收尾判定

| 维度 | 判定 | 依据 |
|---|---|---|
| **交付物完整性** | ✅ **齐备**（26 项，路径/字节/行数/时间全部现测） | §1 |
| **八项能力** | ✅ **通过**（能力 6 由 t4 真实浏览器实测；其余 6 项交互子项标「需人工确认」） | §2.1 + t4 §4/§5.5 |
| **验收命令** | ✅ **7/7 EXIT=0**（与预期基线完全一致，无偏差） | §2.2 / §2.3 |
| **测试基线** | ✅ **12 files / 153 passed**（文件数 12 ⇒ 无探针泄漏） | §2.2 |
| **构建产物** | ✅ **通过**（按修正后的 per-chunk 判据） | §2.4 |
| **哈希 attestation** | ✅ **已核实一致**（三文件逐字节等于 attestation 与 t4 复算） | §2.5 / §8.1 |
| **工作区清洁度** | ✅ **清洁**（无回退副本、无 scratch、无 stash 命中） | §2.5 |
| **ADR 偏离** | ✅ **3 条已裁定并已在 ADR 内就地标注**（原文保留） | §3 |
| **残余风险** | ⚠️ **1 项高（F-F，既存、非本次回归）+ 2 项中** | §4 |
| **需人工确认** | ⚠️ **6 项**（含 Linux 运行时），**未伪造通过** | §5 |
| **findings** | ✅ **F-1/F-2/F-4/F-6 已闭环；F-3/F-A…F-F 已登记** | §6 |

**总判定：停靠重构收尾交付完成，基线通过；未发现本次重构引入的功能缺陷。** 与 t4 的独立验证结论**一致**。

### 10.2 移交建议（按优先级）

| # | 建议 | 优先级 |
|---|---|---|
| 1 | **F-F 另开任务**：超时**可见化 / 可重试**；写入路径走**独立于 AI** 的连接或队列；修 `EditorPage.tsx` 未防抖 + `styleService.analyzeStyle` 缺 signal 参数 | **高** |
| 2 | **§5 的 6 项人工核对**（含 **Linux 运行时**）由具备真实桌面环境的人员按步骤执行 | **高** |
| 3 | **数字口径更正**（**captain 已执行**，结论与 t5 建议不同）：`--ink*` **总数 187 保留**，只更正**拆分**为 `72 / 83 / 32`（t5 建议的「总数改 186」已否决，理由见 §9.2）；`--ink-deep` `14` → **13** ✅ 已改 | ✅ 已完成 |
| 4 | **判据表更正**（**captain 已执行**）：`dock-refactor-final.md` §5 构建产物判据表的「`--vscode-editor-background` 定义次数 = 恰好 1 次」已改为「**同一 chunk 内不重复，且各 chunk 值一致**」。**ADR 侧无需改** —— 全文 grep `恰好 1 次` / `定义次数` **0 命中**（ADR §5 只定义 `--dv-*` → `--vscode-*` 映射表，不含产物计数判据） | ✅ 已完成 |
| 5 | **F-E 夹具侧修**：`scripts/e2e/e2e-core-flows.mjs:118` 与 `e2e-mode-separation.mjs:101-103` 的 `page = pages.find(...)` 增加 URL 校验 | 中 |
| 6 | **F-A 注释更正**（措辞见 §6.3）；**F-D 文档表述**改为「外壳内唯一」 | 低 |
| 7 | **F-B 参数抽取**（`buildAddSpec` 与 `openPanel` center 分支去重）；**F-C 显式双 id 查找** | 低 |
| 8 | **`--ink*` 迁移任务**（**187** 处 → `--vscode-*`，**会改变外观**，需独立评审）—— 完成后才可删除三定义 | 低（独立立项） |

### 10.3 t5 硬约束遵守声明

- ✅ **未执行** `git checkout` / `git restore` / `git stash` / `git clean`（本仓仅 **2 个**早于重构的提交，这些命令会**永久销毁**全部未提交重构产物）。
- ✅ **未新建 commit**。
- ✅ **未修改任何产品源码**（本任务为报告任务；唯一新增文件 = 本报告）。
- ✅ **未改** `apps/plugins/shared/ui-kit/`、`apps/web/src/components/shell/`、`apps/web/src/plugin/`。
- ✅ **未删除任何文件**（含 `docs/reports/**` 下全部历史报告，20 份一份未删）。
- ✅ 报告内**所有数字均来自实际执行**，未估算、未转述未验证的自述；转述他人实测处**均已标注来源**（§7.3）。

---

*本报告由 t5（`closeout-eng`，attempt `d000f577-8960-44ec-80ca-365b92d17a12`）交付。*
*原始命令输出留档：`%TEMP%\t5-verify-log.txt`（仓库外，避免污染工作区）。*

---

## §11 captain 裁定与回改记录（追加，2026-10-02）

> 本节由 **captain** 追加。t5 原文（§1–§10）**完整保留未改**，仅在必要处就地标注「←（t5 原记 …）」并加 ⚠️ 裁定说明。本节的目的是让「t5 报了什么 / captain 怎么判的 / 磁盘上最终是什么」三者都可追溯。

### 11.1 三项决策与结论

| # | t5 的建议 | captain 裁定 | 磁盘最终状态 |
|---|---|---|---|
| 1 | `--ink*` 总数 **187 → 186**（72/83/31） | ❌ **否决**。186 = 72+83+31 是 `A_raw + A_raw + B_code` 的**混合口径**，不等于任何单一定义（`A_raw`=187、`B_code`=182）⇒ **不可复现**。**正确动作 = 保留总数 187，只更正拆分** | **187 / 72 / 83 / 32** ✅ |
| 2 | `--ink-deep` **14 → 13** | ✅ **采纳**（三口径一致为 13，原记 14 属纯笔误） | **13** ✅ |
| 3 | 全仓扫描 **421 → 432** | ✅ **采纳并查明成因**（同一口径不同时刻快照；captain 现测 433） | 三值并列登记，**不用于任何判定** ✅ |

### 11.2 `--ink*` 裁定详证（可复现）

**权威工具**：`scripts/verify/measure-ink-consumers.mjs`（captain 亲写，**测量工具、非门禁、退出码恒为 0**），一次输出三列口径。

```
token             A_raw   B_code   C_bare    合计
--ink                72       69       73     214
--ink-light          83       82       84     249
--ink-pale           32       31       33      96
合计                  187      182      190     559
```

| 口径 | 定义 | 合计 | 用途 |
|---|---|---|---|
| **`A_raw`** | `var(\s*<token>(?=\s*[,)]))`，**含**块注释 | **187** | **历史文档口径，保守，文档采用此值** |
| **`B_code`** | 同上但**剔除** `/* … */` 内的出现 | **182** | 真实代码消费点 |
| **`C_bare`** | `<token>(?=$|[,);\s])` 裸 token 名 | **190** | 仅解释「为何有人数出更大值」，**非消费点口径** |

**t5 的三处判断，逐条更正**：
1. **「186 才是严格计数」→ 错。** t5 的 `--ink`=72 取自 `A_raw`（保留了注释内的 `var(--ink)`），而 `--ink-pale`=31 取自 `B_code`（剔除了 `globals.css:155` 注释内的出现）—— **同一张表混用两个口径**，这才是 186 的真因，**不是「正则边界差异」**。
2. **「32 来自前缀计数、31 才是严格计数」→ 错。** captain 逐行枚举：`apps/` 全树（334 文件，与 t5 同口径）严格 `var(--ink-pale…)` 命中**恰好 32 处**（已全部列出于 `measure-ink-consumers.mjs` 输出）。**`landing.css:21` 的 `hsl(var(--ink-pale, 0 0% 58%))` 是真实消费点**（它读取该变量），**不是** 32 的来源；第 32 处正是 **`globals.css:155` 自身那句注释**（**自引用**）。
3. **「73 无法复现」→ 部分对，方向用错。** 73 **可以**复现（= `C_bare`，t5 对成因的定位正确），但正确结论是「**73 是 `C_bare`、72 是 `A_raw` ⇒ 文档里的 73 应改为 72**」，**而不是**「把总数 187 改成 186」。**改的是拆分，不是总数。**

### 11.3 已执行的回改清单（captain 亲改，逐项实测确认）

| 文件 | 位置 | 原值 | 现值 |
|---|---|---|---|
| `docs/architecture/dock-refactor-final.md` | §6.1 表（L372/L374） | `--ink` 73 / `--ink-pale` 31 | **72 / 32** ✅ |
| `docs/architecture/dock-refactor-final.md` | §6.1 悬挂引用（L386） | `--ink-deep` 14 | **13** ✅ |
| `docs/architecture/dock-refactor-final.md` | §10.3 复测表（L525/L527/L536） | 14；「⚠️ 差 1」 | **13；「原记 14 属笔误，已更正」** ✅ |
| `docs/architecture/dock-refactor-final.md` | §5 产物判据表（L357） | 「恰好 1 次」 | **「同一 chunk 内不重复，且各 chunk 值一致」** ✅ |
| `docs/architecture/dock-protocol-adr.md` | §6.4-a 表（L732/L734） | 73 / 31 | **72 / 32** ✅ |
| `docs/architecture/dock-protocol-adr.md` | §6.4-a（表后） | — | **新增口径可复现化说明段**（三列口径 + 脚本路径） ✅ |
| `apps/web/src/styles/globals.css` | L154-155 注释 | 73 / 31 | **72 / 32** ✅ |
| `docs/reports/dock-refactor-verification.md` | §8.1（L823 附近） | 「正则边界差异」 | **「口径混用，已更正为 72/83/32」+ 三口径表** ✅ |
| `docs/reports/dock-refactor-verification.md` | §2.7（L225） | 全仓 421（无限定） | **加「随现场临时产物漂移」说明 + 三快照并列** ✅ |
| `docs/reports/dock-refactor-verification.md` | §7.5（L709） | `…/EditorPage.tsx` | **加路径勘误（真实路径 = `apps/plugins/manual/workbench/web/editor/EditorPage.tsx`）** ✅ |
| `docs/reports/dock-refactor-closeout.md` | 本报告（多处） | 186 / 31 / 29 / 「187→186」 | **就地更正 + ⚠️ 裁定标注，t5 原文保留** ✅ |

**回改后复测**：`measure-ink-consumers.mjs` 仍输出 **187 / 72 / 83 / 32**（`globals.css:154-155` 注释行本身仍含 `var(--ink)` 与 `var(--ink-pale)` 各 1 处 ⇒ 自引用使 `A_raw` 总数不变）。**七条验收命令全部重跑，仍 7/7 EXIT=0**（type-check 0 / lint 0（0 errors, 1 warning `DockShell.tsx:360`）/ build 0（`ProjectBuilt-BE5p2nO0.js` 437.53 kB）/ test 0（12 files / **153 passed**）/ verify-theme-single-source 0 / verify-all 0 / verify-plugin-mode-separation 0）。

### 11.4 独立第二信源（团队一号 `verifier` 的交叉印证）

团队一号 `verifier` 在同一时点独立复跑，**与 captain 及二号 t4 逐字吻合**，可作为第二信源：
- `dockview` **69** 次、`dv-theme-vscode` **2** 次、`nm-center-default` 1 次、`dockview-host` 1 次、`dndPanelOverlay` 4 次、`addFloatingGroup` 14 次、`moveTo` 9 次
- `--vscode-editor-background`：**每个 CSS chunk 各 1 次定义**、值均 `hsl(220 13% 13%)` ⇒ **per-chunk 判据成立，非双真源**
- `shuimo|ink-wash` 全 dist 残留 = **0**；`test` = **12 files / 153 passed**（`DockShell.smoke.test.tsx` **17 tests**，含 3 条中心槽回归）
- **零文件落盘**（只读侦察 + 执行命令，未创建/修改任何文件）；**未执行任何** `git checkout`/`restore`/`stash`/`clean`

### 11.5 未采纳的 t5 建议（保留分歧记录）

| t5 建议 | 处置 | 理由 |
|---|---|---|
| `--ink*` 总数 187 → 186 | ❌ 否决 | 混合口径，不可复现（§11.2） |
| `landing.css:21` 归因为「32 的来源」 | ❌ 否决 | 该处**确是消费点**，被 `A_raw` 与 `B_code` 同时计入 |
| 「31 严格 / 32 前缀计数」 | ❌ 否决 | 实测严格计数即 **32**（第 32 处 = `globals.css:155` 注释自引用） |

**t5 报告的其余全部内容（§1–§8 的事实登记、§9.3/§9.4、§10 判定与移交建议）经 captain 复核全部成立，予以采纳。** t5 对 `73` 的**成因归因**亦正确，仅**结论方向**用错 —— 这类「把正确观察接到错误结论」的模式值得在后续任务中留意。