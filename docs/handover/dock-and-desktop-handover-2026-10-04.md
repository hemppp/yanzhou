# 砚舟 接手交接 · 停靠重构 / 主题单一真源 / 插件模式拆分 / Electron 桌面端

> **编写**：团队一号（DSH 内置 Agent Teams）成员 `handover-scribe`，2026-10-04
> **覆盖范围**：2026-10-01 20:56（原 HEAD `a0e1db0`）之后、至 2026-10-04 四条工作线的产物与结论
> **2026-10-04 二次修订（提交后）**：四条工作线已于 12:07–12:09 分 4 个内容提交入库（散列见 §1.1；该提交链同日经两轮 plumbing 修正定稿，第二轮重建了 C2/C3/C4 的树，C2/C4 的散列因此与初次记录不同）。本次修订把 §0 / §1 / §2 / §3.1 / §4.1 / §4.6 / §5 / §6.1–6.3 / §8 与文末小结改为**入库后的现状**；§7 勘误台账是提交前的历史比较，**原文保留**（表下已加时间口径说明）。提交**不是本文件作者做的**（git 写操作由主理人执行）；本文自身这次修订构成**第 5 个提交**，其散列无法事先写入。
> **不覆盖**：AI 写作模块现状（→ `ai-writing-handover.md`）、多代理流水线历史故障现场（→ `UNFINISHED-pipeline-blocked.md`）
> **口径**：`[实测]` = 2026-10-04 本次交接期现场跑出的结果；`[报告]` = 引用仓库内已有报告原文；`[未验证]` = 仓库内找不到依据的事项，**不得当作通过**。
> **本文未做的事**：本文**作者**没有执行任何 git 写操作（不 commit / 不 add / 不 stash / 不 clean）；没有改源码；只写 `docs/handover/`。§1.1 的 4 个内容提交与本次修订所属的第 5 个提交均由**主理人**执行（2026-10-04 12:07–12:09 生成，同日稍后经两轮 plumbing 修正定稿），本文只登记其结果。

---

## 0. 先看这 6 件事

1. **四条工作线已入库：本地 `main` 领先 `origin/main` 5 个提交，未 push。** HEAD = **本文件所属的第 5 个提交**（主题 `docs(handover): 交接文档同步入库后现状`）——它的散列**无法写进它自己的内容**，所以本文里没有、也不应有「HEAD = 某散列」；它的父 = `79f7e3224d363d3c5fd536dc573e647b9fb443b3`（`79f7e32`）。`origin/main` 仍是 `a0e1db0cffa93b86bc2c9d771a16ad660f1103b8`，工作区与索引**双干净**（`git status --porcelain` 为空）`[实测]`。接手第一件事变成**决定何时 push**（§6.3 第 1 条）。
2. **`apps/desktop/`（整个 Electron 桌面端）已入库**：随第 3 个提交 `c97d03f` 落地（30 files, +6775），其自带的 `apps/desktop/.gitignore`（忽略 `payload/`）一并入库。
3. **三份 ADR 与五份 10-02/10-03 报告已入库**：随第 4 个提交 `79f7e32` 落地（11 files, +5529）。`git show --stat 79f7e32` 即可看到全部文档清单。
4. **桌面端打包会污染本机 ABI**：打包把仓库 `node_modules/better-sqlite3` 就地改成 Electron ABI 149，**打包后不 `pnpm install` 恢复 ABI 137，`pnpm dev` / `pnpm test` 全部失败**（详见 §4.4）。
5. **停靠重构有一项「高」残余风险未修**：写请求超时被静默吞掉 ⇒ 静默丢数据（`§3.5 F-F`）。另有 `--ink*` 主题变量迁移（187 处）未做。
6. **`release/desktop/` 里的安装包已被重新打包过**：磁盘上是 2026-10-03 21:11–21:13 的产物，SHA256 与两份报告 §1.1 记录的 19:13 产物**不一致** `[实测]`（详见 §4.6）。报告 §1.1 的哈希 attestation 只对 19:13 那轮成立；**当前发布校验基线是 `docs/reports/desktop-packaging-closeout.md` §A.1（215–255 行，2026-10-04 增补）**。

---

## 1. 版本库 / 工作区现状（2026-10-04 提交后实测）

### 1.1 git

| 项 | 值 | 来源 |
|---|---|---|
| HEAD | **本文件所属的第 5 个提交**（散列不可自述；父 = `79f7e32`） | `[实测]` |
| 分支 | `main`；`origin/main` = `a0e1db0cffa93b86bc2c9d771a16ad660f1103b8` | `[实测]` |
| 领先 / 落后 | `git rev-list --left-right --count origin/main...main` = `0  5` ⇒ **领先 5 个提交（含本文件所属的第 5 个）、未 push** | `[实测]` |
| commit 总数 | **7**（`c2583f8`、`a0e1db0` + 本次 5 个） | `[实测]` |
| 工作区 / 索引 | **双干净**：`git status --porcelain` 为空（提交前是 68 项，含 2 个 `D ` 暂存项） | `[实测]` |

本次入库的 5 个提交（前 4 个依次叠在 `a0e1db0` 之上，第 5 个即本文件）：

| # | 短散列 | 完整散列 | 主题 | 规模 |
|---|---|---|---|---|
| 1 | `3e3754e` | `3e3754ea254a78b6be2be81299de5b4672829943` | `refactor(web): 完成 Dock 重构并删除 shuimo 主题` | 52 files, **+4844**/−4575 |
| 2 | `b567758` | `b5677585ff69c5434c12c3e00f4ac7c277eeb4f5` | `refactor(plugins): 插件侧对接停靠协议 D9 并补 auto 创作台入口` | 11 files, +1945/−78（**不含 `DockShell.tsx`**） |
| 3 | `c97d03f` | `c97d03f7b06d7d3976898458e43692681538b240` | `feat(desktop): Electron 桌面端入库并补齐 server 优雅关闭通道` | 30 files, +6775 |
| 4 | `79f7e32` | `79f7e3224d363d3c5fd536dc573e647b9fb443b3` | `docs: 补全停靠/桌面端 ADR、验证报告与交接文档` | 11 files, +5529（**不含 `DockShell.tsx`**） |
| 5 | —（不可自述） | —（本文件自身，散列无法自述） | `docs(handover): 交接文档同步入库后现状` | 2 files（本文件 + `next-session-prompt.md`，详见 §6.2） |

> 提交历史于 2026-10-04 12:07–12:09 生成，同日稍后经**两轮纯 plumbing 修正**定稿；正文、作者、提交者、时间与最初重写前**逐字节一致**；上表是**最终散列**。第一轮修正：改 C2 主题、删除 `DockShell.tsx` 那条无用 `eslint-disable`、修正 `docs/reports/desktop-packaging-closeout.md` 第 244 行「2,512 B」→「2,547 B」。第二轮修正：**重建 C2/C3/C4 的树**，消除 `apps/web/src/components/shell/DockShell.tsx` 在 C1 被删、C2 被加回、C4 再删的**抖动**，使这四个提交里该文件内容始终一致（都不含那行）⇒ 该修复自然归属 C1 `3e3754e`，C2/C4 **不再触碰该文件**（C2/C4 的散列因此变化）。
> 历史基线两个提交：`c2583f8` 2026-10-01 19:43:37「chore: 剥离 AI 自动写作模块（保留插拔接口）」—— 513 files changed, 110355 insertions；`a0e1db0` 2026-10-01 20:56:49「chore: 版本定为 0.1.0 + 修正 CI Node 版本」—— 4 files changed, 55 insertions。

### 1.2 workspace 项目数口径

`pnpm -r list --depth -1` 列出 **15 个**：根 `novel-companion` + 14 个子项目 `[实测]`。
工程目录下实测的 14 个子项目：`apps/agents`、`apps/desktop`、`apps/plugins/auto/novel.autowrite`、`apps/plugins/auto/workbench`、`apps/plugins/manual/workbench`、`apps/plugins/manual/worldbuilding`、`apps/plugins/shared/data-core`、`apps/plugins/shared/ui-graph`、`apps/plugins/shared/ui-kit`、`apps/server`、`apps/web`、`packages/core`、`packages/db`、`packages/shared`。
> `apps/plugins/local/` **目录不存在**（多份旧文档里的路径已失效，见 §6.4）。
> `apps/desktop/payload/**` 与 `release/desktop/**` 下的 `package.json` 是打包产物，不是 workspace 项目。

### 1.3 四条工作线的文件落在哪个提交（`git show --name-only` 实测）

| 工作线 | 代表路径 | 入库提交 |
|---|---|---|
| ① 停靠（Dock）重构 | `apps/web/src/components/shell/{DockShell.tsx,PanelMenu.tsx,project-shell.css}`、`shell/dock/{CenterGraphPanel,DockPanelContent,DockShell.smoke.test,dock-theme,dock-tokens,layout,types}`、`shell/{FloatingBubbles,PanelSection}.tsx`(删)、`apps/web/src/plugin/__tests__/plugin-dock-adaptation.test.ts`、`apps/web/vitest.probe.config.ts` | `3e3754e` |
| ② 主题单一真源 | `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css`、`…/ui-kit/src/themeStore.ts`、`ui-kit/src/InkBackButton.tsx`(删)、`apps/web/src/styles/{shuimo,themes}.css`(删)、`components/{shuimo,effects}/…`(删)、`apps/web/src/main.tsx` | `3e3754e` |
| ③ 插件按模式拆分 | 结构（`apps/plugins/{manual,auto,shared}/…`、**146 个受跟踪文件**）+ 增量（`apps/plugins/auto/workbench/web/index.tsx`、`manual/workbench/web/**`、`shared/typography/web/index.tsx`） | 结构在 `c2583f8`；增量在 `b567758` |
| ④ Electron 桌面端 | `apps/desktop/`（整个目录 30 files，含 `src/**`、`scripts/{build-update,build-server-payload,bundle-shell,gen-icon}`、`electron-builder.yml`、`build-resources/`、`.gitignore`） | `c97d03f` （另含 `apps/server/src/index.ts`） |
| 治理/验证脚本 | `scripts/verify/{measure-ink-consumers.mjs,verify-theme-single-source.mjs}` | `3e3754e` |
| 文档 | 3 份 ADR（`dock-protocol-adr.md`、`dock-refactor-final.md`、`desktop-packaging-adr.md`）+ 5 份报告（§8）+ 本目录两个文件 | `79f7e32` |
| 夹具/杂项 | `scripts/e2e/{e2e-core-flows,e2e-mode-separation}.mjs`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | `b567758`；`.gitignore` 在 `79f7e32` |

> **历史澄清（该说法在提交前成立）**：插件模式拆分的目录结构早在 `c2583f8`（2026-10-01）就已入库，当时未提交的只是拆分后的增量——这与「四条线全部未提交」的说法不同，见 §7 勘误第 1 行。

### 1.4 忽略规则（与接手相关）

- `/release/` 已被 `.gitignore` 忽略 `[实测]` ⇒ 发布产物**不会**入库；`release/desktop/` 当前有 **32,521 个文件 / 1,146,962,174 B**（≈1.07 GB）`[实测]`。
- `/data/`、`dist/`、`node_modules/`、`*.db`、`.env`、`.agent-teams/` 均已忽略。
- `.gitignore` **已入库**（提交前是 ` M`）：2026-10-04 新增了 `.ps-smoke/` 与 `.verify-scratch/` 的忽略块（注释里写明这两个目录被三份报告引用为证据路径，**只忽略入库、保留磁盘实体，勿删**）。当前忽略规则的实际行号 `[实测]`：`:92` `.tmp_*`、`:94` 现场证据目录注释、`:101` `.ps-smoke/`、`:102` `.verify-scratch/`、`:153` 说明注释、`:156` `apps/desktop/package-lock.json`（旧文档若写 96/97 之类坐标均以本节为准）。`apps/desktop/.gitignore`（忽略 `payload/`）亦已随 `c97d03f` 入库。

---

## 2. 四条工作线总览

| # | 工作线 | 契约文档 | 结论文档 | 状态 |
|---|---|---|---|---|
| ① | 停靠（Dock）重构：把工作台壳换成 dockview，外观改成 VS Code Dark Modern | `docs/architecture/dock-protocol-adr.md`（ADR-0007，845 行，2026-10-02 15:18）+ 收尾定稿 `dock-refactor-final.md`（549 行，15:33） | `docs/reports/dock-refactor-verification.md`（1099 行，15:22）、`dock-refactor-closeout.md`（735 行，15:42） | 收尾交付完成，**1 高 + 2 中残余风险**，6 项需人工确认，`--ink*` 迁移未做 |
| ② | 主题单一真源：三档水墨主题 → 单档 `vscode-dark-modern` | ADR-0007 §6（冻结） | 同 ① | 已完成；`verify-theme-single-source.mjs` 可复跑 |
| ③ | 插件按创作模式物理拆分（`manual`/`auto`/`shared`） | `docs/architecture/plugin-standard.md`、`plugins-inventory.md` | README L51、CHANGELOG 0.1.0 | 结构 2026-10-01 入库（`c2583f8`）；增量随 `b567758` 入库 |
| ④ | Electron 桌面端打包 | `docs/architecture/desktop-packaging-adr.md`（ADR-0008，951 行，2026-10-02 21:06） | `docs/reports/desktop-e2e-verification.md`（295 行）、`desktop-packaging-closeout.md`（211 行）、`desktop-shell-audit.md` | 19:13 那轮端到端可用；**§5 有 9 项未验证**；打包 ABI 纪律必须遵守 |

---

## 3. 工作线 ① + ②：停靠重构与主题单一真源（ADR-0007）

### 3.1 做了什么

- 工作台外壳改为 **dockview 8.4.0** 停靠模型：新文件 `apps/web/src/components/shell/DockShell.tsx`、`PanelMenu.tsx`、`shell/dock/`、`shell/project-shell.css`；删除 `shell/FloatingBubbles.tsx`、`shell/PanelSection.tsx`。
- 外观从「水墨（shuimo）」整体迁到 **VS Code Dark Modern**：
  - `ThemeId` 从 `'ink' | 'shuimo' | 'soot'` **收缩为单值字面量联合 `'vscode-dark-modern'`**；`THEMES` 恰好一项；默认 `mode` / `lockedMode` 均为 `dark`；`MIGRATION_KEY` 常量整体删除，旧值**静默回落默认**（不抛错、不提示、不写迁移标记）`[报告]`（`docs/architecture/dock-protocol-adr.md:677-687`）。
  - 色值真源唯一：`apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css`（13933 B，2026-10-01 22:16:29）`[实测]`，由 `apps/web/src/main.tsx:7` `import '@novel-plugins/ui-kit/styles/vscode-dark-modern.css';` 引入 `[实测]`。
  - 删除清单（ADR-0007 §6.4）：`apps/web/src/styles/shuimo.css`（127 处水墨引用）、`components/shuimo/`（13 处）、`dev/shuimoPreview.tsx`、`styles/themes.css`、`components/effects/{AmbientBackdrop,BambooLeafFollow}.tsx`、`ui-kit/src/InkBackButton.tsx`、`components/ui/InkBackButton.tsx`——以上**均已删除并随 `3e3754e` 入库**（提交前它们在 `git status` 里是 `D` 行，`[实测]`）。

### 3.2 验收证据（`[报告]`，均为 2026-10-02）

- 收尾报告 §10.1：十项判定全部 ✅/⚠️；**验收命令 7/7 EXIT=0**；测试基线 **12 files / 153 passed**；`shuimo|ink-wash` 全 `dist` 递归（82 个文件）残留 **0 / 0**。
- captain 回改后复测（§11.3）：七条命令全部重跑仍 7/7 EXIT=0 —— `type-check` 0 / `lint` 0（0 errors, 1 warning `DockShell.tsx:360`）/ `build` 0（`ProjectLayout-BE5p2nO0.js` 437.53 kB）/ `test` 0（12 files / 153 passed）/ `verify-theme-single-source` 0 / `verify-all` 0 / `verify-plugin-mode-separation` 0。
- 独立第二信源（团队一号 `verifier` 交叉印证，§11.4）：dockview 69 次、`dv-theme-vscode` 2 次、`nm-center-default` 1、`dockview-host` 1、`dndPanelOverlay` 4、`addFloatingGroup` 14、`moveTo` 9；`--vscode-editor-background` 每 CSS chunk 各 1 次且值均 `hsl(220 13% 13%)`；`DockShell.smoke.test.tsx` 17 tests（含 3 条中心槽回归）。
- 主题变量口径（§11.2，权威工具 `scripts/verify/measure-ink-consumers.mjs`，**测量工具、非门禁、退出码恒 0**）：`--ink` 72/69/73、`--ink-light` 83/82/84、`--ink-pale` 32/31/33，合计 `A_raw`(含块注释)=**187** / `B_code`(剔除注释)=182 / `C_bare`(裸 token)=190。

### 3.3 需人工确认的 6 项（`[报告]` closeout §5，t4 §9 原样转录，**未计 PASS**）

1. 能力 2：拖拽浮窗 + 拖回停靠；
2. 能力 5：落位预览可见性（`--vscode-panel-dropBackground` + 2px `--vscode-focusBorder`，圆角 0）；
3. 能力 7：分栏拖拽 sash（`--vscode-sash-hoverBorder`）；
4. 能力 4：标签堆叠交互顺序；
5. VS Code 外观一致性（对照 `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css`）；
6. 能力 8：**Linux 运行时未实测**（源码级跨平台洁净度已自动 PASS，未自动验证的是 Linux 运行时）。

### 3.4 已登记的 findings（`[报告]` closeout §6）

收尾期 F-1（临时探针污染 vitest 收集范围）/F-1 附带（vitest 位置参数语义更正）/F-2（测试镜像漂移 ⇒ 8→12 tests）/F-3（`DockShell.tsx:360:5` 未用 eslint-disable，维持 0 errors / 1 warning）/F-4（ADR `fore-shadow`→`foreshadow` 笔误）/F-6（ADR 契约与实测矛盾，新增 §6.4-a 与 §6.5-a）。
验证期 F-A（`DockShell.tsx:450-451` 注释不实：dockview 8.4.0 对重复 id 是 **throw** 而非忽略）/F-B（`buildAddSpec` `:613-628` 与 openPanel center 分支 `:458-469` 重复硬编码）/F-C（`onActivitySelect` `:533-545` 隐式依赖）/F-D（`[aria-label="设置"]` 全仓 2 处：`ProjectLayout.tsx:397` 与 `pages/BookshelfPage.tsx:351`）/F-E（e2e 夹具附着「第一个 page target」⇒ 遗留标签页回放历史 console 造成假失败）。

> **F-3 已修复（2026-10-04，落在 C1 `3e3754e`）**：`apps/web/src/components/shell/DockShell.tsx` 原第 360 行那条无用的 `// eslint-disable-next-line react-hooks/exhaustive-deps` 已删除 ⇒ `pnpm -r lint` 由 4 warnings 降为 **3 warnings**（余下 3 条是 `apps/server` 的未使用变量）`[报告]` 本次提交前交底 / `[实测]` 该行现不存在。该文件随 `3e3754e` **首次入库时就不含那行**（C2 `b567758` / C4 `79f7e32` 均未触碰该文件，见 §1.1 注与 §6.2）。
> 上面 F-1…F-6 / F-A…F-E 的**行号与措辞是报告原文**，写的是修复前的状态，保留不改。

### 3.5 残余风险与待办（`[报告]` closeout §4 / §10.2）

- **F-F（高，既存缺陷，非本次回归）——写请求超时被静默吞掉 ⇒ 静默丢数据。** 现象：UI 已显示新建角色（store 写入成功），后端返回 `{"data":[]}`，用户无提示。触发链：AI 端点饱和（8 并发、单条约 24 s 的 `analyze-style`）占满 6 条同源连接 ⇒ `POST /api/characters` 排队中被 **8 s 客户端超时** abort。关键位置：
  - `apps/plugins/shared/data-core/src/api/apiClient.ts:103` `const DEFAULT_TIMEOUT_MS = 8000;`，`:234` `const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;`，`:362-363` 超时错误 `if (!options?.silent) dispatchApiErrorEvent(timeoutErr);` ⇒ `silent: true` 时既不弹 toast 也不重试（该文件全文无 retry）。
  - `apps/plugins/shared/data-core/src/data/databaseService.ts:98` `async function apiSave<T …>`，`:105-112` 用 `silent: true` + `console.warn` + `return null`。
  - 上游成因：`apps/plugins/manual/workbench/web/editor/panels/StyleAdvisor.tsx:77-92`（建了 AbortController 却从未传入）与 `apps/plugins/shared/data-core/src/editor/styleService.ts:146` `async analyzeStyle(chapters: string[])`（签名无 `signal`，`:161` 固定 `{ silent: true, timeoutMs: 60_000 }`）⇒ 请求不可取消，abort 后仍占 socket 至 60 s。
  - 并发主来源：`apps/plugins/manual/workbench/web/editor/EditorPage.tsx:134-157`（`:134` deps `[chapters]`、`:142` 立即调用、`:136` 建 AbortController 从未传入）。
  - **范围判定**：`git diff --stat HEAD -- …/EditorPage.tsx` 为空，worktree blob = HEAD blob（`1ef7b123e44b85a14630ab87c92323fd07319bce`）⇒ 与 HEAD 逐字节相同，**不是停靠重构的回归**，建议另开任务。
  - ⚠️ **路径勘误**：任务交底与 t4 报告引用的 `apps/web/src/pages/EditorPage.tsx` **不存在**；真实路径是 `apps/plugins/manual/workbench/web/editor/EditorPage.tsx`（26730 B，2026-09-30 11:22:41）。
- **F-E（中）**：修 `scripts/e2e/e2e-core-flows.mjs:118` 与 `scripts/e2e/e2e-mode-separation.mjs:101-103` 的 `page = pages.find(...)`，加 URL 校验。
- **`--ink*` 悬挂引用**：`--ink-deep` 13 处、`--ink-soft` 5 处，全仓 0 定义（既存，登记不修）。
- **`--ink*` → `--vscode-*` 迁移任务（低·独立立项）**：涉及 **187 处**，**会改变外观，需独立评审，完成后才可删除三定义**。

---

## 4. 工作线 ④：Electron 桌面端（ADR-0008）

### 4.1 产物

- 代码在 `apps/desktop/`（**已随 `c97d03f` 入库**，30 files）：`src/main.ts`(21834 B)、`src/server-process.ts`(28596)、`src/paths.ts`(21542)、`src/updater/index.ts`(33854)、`updater/zip.ts`(15792)、`updater-manifest.ts`(11323)，以及 `env/logger/window/preload/ipc-channels/types/desktop-api.ts`、`updater/{backup,config,http,plugins,semver,types}.ts` `[报告]` closeout §1.3。
- 构建脚本：`apps/desktop/scripts/{build-update.mjs 17398, build-server-payload.mjs 11794, bundle-shell.mjs 4028, gen-icon.py 3735}`；配置 `apps/desktop/electron-builder.yml`(4377 B)；图标 `build-resources/{icon.ico 187891, icon.png 527794}`。
- 更新源 `release/updates/` **恰 7 项** `[实测]`（mtime 2026-10-03 16:58）：`manifest.json` 2431 B、`novelmuse-app-0.1.0.zip` 69,076,232、`novel.auto.workbench-0.1.0.zip` 11,096,747、`novel.manual.workbench-0.1.0.zip` 11,334,357、`novel.autowrite-0.1.0.zip` 5,353,042、`novel.bookscan-0.1.0.zip` 7,258、`novel.typography-0.1.0.zip` 7,263。

### 4.2 已验证（`[报告]` closeout §2 D1–D21 / e2e §0）

- e2e 报告：三形态（`win-unpacked` / NSIS / Portable）**全部端到端跑通**——启动、后端 `database=connected`、`plugins=27`、按 D7 落盘并建 junction、跨重启持久化、拦第二实例、优雅关停无残留。
- D5 端口握手成功（`http://127.0.0.1:<port>`，来自子进程 stderr）；D6 注入 78/79/82 项环境变量；D7 userData 布局 `app-runtime/ data/ plugins/ backups/ logs/ updates/` + junction 断言真；D8 `better_sqlite3.node` 1,921,024 B；D11 注册 9 条 IPC 通道；D12 全部 8 步完成 + 单实例聚焦；D13 stdin 优雅退出闭环；D17 **6/6 sha256 独立复算 MATCH**（针对 19:13 那轮产物）。
- R12 `compareVersions` 15/15 PASS（`.verify-scratch/semver-test.mts`）；R10 闭环（`.log`/`.txt` grep `MODULE_TYPELESS` 0 命中）；R11 `server.err.log` 1,243 B / `server.out.log` 5,669 B。

### 4.3 安装 / 运行事实（`[报告]` closeout §4）

- NSIS 静默 `/S` 实测 **285 s 退出码 0**；默认落点 `%LOCALAPPDATA%\Programs\砚舟`；只建开始菜单快捷方式「听风细雨」，**不建桌面快捷方式**；卸载保留 userData（`deleteAppDataOnUninstall=false`）。
- 首启一次性管理员初始密码写入 `<userData>\logs\initial-admin-password.txt`（23 B）。
- 便携版首启自解压约 3 分钟到 `%TEMP%\<随机目录>`，退出后删除。
- 便携版 userData 落 `C:\Users\1\AppData\Roaming\砚舟`，**与安装版完全相同、不重定向**；源码未消费 `PORTABLE_EXECUTABLE*`（R13，即使携版语义未落地）。
- 未签名安装包会触发 SmartScreen；**未安装 VC++ 运行库的行为未验证**。

### 4.4 ⚠️ 打包后 ABI 纪律（必须遵守，`[报告]` ADR-0008 §D8.1/§D8.4）

- 仓库内 `node_modules/better-sqlite3/…/better_sqlite3.node` = 1,919,488 B / **Node ABI 137**；Electron 44.5.1 运行时 = **ABI 149**。
- 桌面打包会**就地把仓库的 `.node` 重建成 ABI 149**（重建后 1,921,024 B）。没有 Electron 预编译包（`prebuild-install --runtime=electron --target=44.5.1` → **HTTP 404**），必须源码编译。
- **打包后必须 `pnpm install`（或 `pnpm rebuild better-sqlite3`）恢复 ABI 137**，否则 `pnpm dev` / `pnpm test` 全部失败；未重建直接跑会报 `NODE_MODULE_VERSION 137 vs 149`，日志出现 `[Server] 数据库初始化失败，将以降级模式运行`（**不阻断启动**）。
- 降级路径：`packages/db/src/index.ts:1351-1356` 捕获后回退 **sql.js**（内存库 + WASM）。
- closeout §5 第 9 项「`pnpm install` 后 ABI 复原（D8.4）的现场复核」**本次未执行** ⇒ 属未验证项。

### 4.5 ⚠️ 本机两处坑（`[报告]` closeout §4.3 / e2e §2）

1. **`ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化为纯 Node**：启动前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE -EA 0`。
2. **不要用重定向 stdio 的方式启动**（父进程持有 stdout/stderr 管道）——会触发下面的 EPIPE 缺陷。

**`main.log` EPIPE 自激写盘（真实缺陷，非验收项，本次未改码）** `[报告]` e2e §6：
以「父进程持有 stdio 管道」方式启动（`UseShellExecute=$false` + 重定向 stdout/stderr），关闭主窗口后进程不退出（观察到 3 个残留进程），`%APPDATA%\NovelMuse\logs\main.log` 数分钟内膨胀到 **3,519,024,054 B（≈3.9 GB）**，`totalLines=49,712,192`、`matchCount=4,519,287`（几乎全是同一行）。
机制：`apps/desktop/src/logger.ts` 的 `FileLogger.write` 先 `ringPush`，再 `if (this.echoToConsole) { … console.error(line) }`，之后才写 stream；`ShellLogger` 以 `echoToConsole=true` 构造 ⇒ `console.error` 抛 `EPIPE` → `process.on('uncaughtException')` 处理器再写日志 → 自激循环。
触发条件：**仅**在父进程 stdio 管道被关闭/断开时触发；正常双击或 `cmd /c start` 分离式启动不触发（分离式启动 `main.log` 仅 2,588 B）。

### 4.6 报告与磁盘的差异（本次实测发现）

| 项 | 报告（19:13 那轮） | 磁盘现状（2026-10-03 21:11–21:13） |
|---|---|---|
| `砚舟-Setup-0.1.0-x64.exe` | 177,697,975 B / SHA256 `1D53021050DE2929EC59CF3F03E74B62ED741F28C7FEB8D61A43A14DC49EB4D1` | **177,697,975 B**（同尺寸）/ SHA256 `15EC9B37B5E5965AEA5E47384291648FE89B23047BDA70DE9ACCBB26FD1A3CC8` **≠** |
| `砚舟-Portable-0.1.0-x64.exe` | 177,302,758 B / SHA256 `DDDF3A98…27ECB` | **177,302,760 B**（+2 B）/ SHA256 `CB2FD64BF33FA530B5C49E2E975CA0D1BD5936AAE7B1AB1134A3AFD8AA3C57DC` **≠** |
| `K1__uninstaller.exe` | 36,859 B | 存在，36,859 B |
| `builder-debug.yml` | 6,041 B | 存在，6,041 B |
| `win-unpacked/砚舟.exe` | 245,877,248 B | 245,877,248 B（mtime 21:12:16） |

⇒ **`release/desktop/` 当前不是两份报告验证过的那批产物**。报告 §1.1 的哈希 attestation（D17 6/6 MATCH）只对 19:13 那轮成立；磁盘上这批（21:11–21:13，由 `apps/desktop/package.json` 于 21:10:54 恢复 `build` 块之后的重新打包产生）的实测哈希**已于 2026-10-04 登记进 `docs/reports/desktop-packaging-closeout.md` §A.1（现 215–255 行）** ⇒ **发布校验以 §A.1 为准，不要再引用该报告 §1.1**（§A.1 另给出 `blockmap` 与 `builder-debug.yml` 的实测 SHA-256，并注明「任何一次重打包都会使本节再次过期」）`[报告]`。
> 顺带：closeout §2/D16 与 §6 记的「`apps/desktop/package.json` 于 2026-10-03 19:26:48 被改写为 320 B、`build` 块 / `devDependencies` / `scripts` 全部消失，使打包不可复现，是发布前唯一需处置项」——**该偏离在交接时点已不复存在**：`[实测]` 2026-10-04 读到的 `apps/desktop/package.json` = **2547 B**（mtime 2026-10-03 21:10:54），`scripts`/`build`/`devDependencies` 均在场（`build` 块含 `directories.output=../../release/desktop`、`asarUnpack`、`extraResources`、`win.target=[nsis,portable]`、`nsis.shortcutName="听风细雨"`、`deleteAppDataOnUninstall=false`）。是否与 ADR-0008 D16.1 逐字一致 **未验证**。
> 该报告的 §A.2 表格已把初版误记的「现内容 2,512 B」就地更正为 **2,547 B**（2,512 是字符数）`[报告]`（closeout 第 244 行）。

### 4.7 closeout §5「未验证项清单」全文 9 项（标题原文为「不得视为通过」）

1. R5：打包态 tsx `.js`→`.ts`（`ai.ts:1351` 五条 AI 路由）需实调 `/api/ai/gateway`；
2. R4：量化的 Mode B 闭包「够用」缺收窄证据；
3. 完整 UI 交互链路（渲染层点击流）；
4. 自动更新端到端（下载→校验→解压→备份→替换→重启）未搭真实 http 更新源跑真实升级；
5. 便携版 `PORTABLE_EXECUTABLE*` 语义落地；
6. 代码签名 / SmartScreen；
7. `apps/desktop/package.json` 最终形态裁定；
8. 漂移后配置的冒烟打包 `--win dir --x64` 能否复现；
9. `pnpm install` 后 ABI 复原（D8.4）的现场复核（本次未在打包后执行）。

> 另：Mode B 依赖闭包实测 **265 包 / 252,475,413 B**，超 D4.2 基线 **189 包 / 107,768,288 B**（closeout §2/D4、`desktop-shell-audit.md` DEV-09）。closeout §3.5 与 shell-audit 把它写作「超基线 **134 MB** 未解决」；按同处两个数字相减为 252,475,413 − 107,768,288 = **144,707,125 B ≈ 144.7 MB（十进制）/ ≈ 138.0 MiB**，与 134 不符 —— 引用时请照抄原报告的「134 MB」并注明该算术差额。

---

## 5. 工作线 ③：插件按创作模式物理拆分

- 结构 `apps/plugins/{manual,auto,shared}/…`，父目录名即适用模式；manifest 新增 `modes` 字段（缺省 `['shared']`）；`HOST_MODE=manual|auto|all` 启动期裁剪；跨模式 `/api/plugins/*` 返回 **404 `PLUGIN_MODE_MISMATCH`**；目录与 `modes` 不一致由安装门 **G2.5 拒绝（`MODE_MISMATCH`）** `[报告]` README L51、`docs/architecture/plugin-standard.md`。
- 仓库内实际 `plugin.json` 共 **5 份** `[实测]`：`novel.autowrite`(modes `["auto"]`)、`novel.auto.workbench`(`["auto"]`)、`novel.bookscan`(`["manual"]`)、`novel.manual.workbench`(`["manual"]`)、`novel.typography`(`["shared"]`)。另外 `apps/plugins/manual/worldbuilding`、`shared/{data-core,ui-graph,ui-kit}` 只有 `package.json`、无 `plugin.json`（属被插件消费的工作区包）。
  > 「27」与「25」的差额已于 **2026-10-09 复核**对齐（`GET /api/health` 实测）：`plugins=27` = 20 个业务模块 + 1 个插件管理器 + **6 个目录插件**（`worldbuilding`、`novel.bookscan`、`novel.manual.workbench`、`novel.autowrite`、`novel.auto.workbench`、`novel.typography`）。`plugins-inventory.md` 旧版记 25 是**漏了两个 `workbench` 目录插件**，该文档已于同日改为 27。**「27」与「5 份 `plugin.json`」确实不是同一计量单位**：`worldbuilding` 只有 `package.json`、无 `plugin.json`，故「目录插件 6 个 ↔ `plugin.json` 5 份」。
- 更新安装包口径：`release/updates/` 里的插件 zip 恰 **5 个**（auto.workbench / autowrite / bookscan / manual.workbench / typography），与 5 份 `plugin.json` 一一对应 `[实测]`。
- 拆分增量**已随 `b567758` 入库**（下面是提交前实测的清单）：`?? apps/plugins/auto/workbench/web/index.tsx`、`M apps/plugins/manual/workbench/web/{editor/BookScanDirectory.tsx, editor/panels/QuickPhraseBubble.tsx, index.tsx, outline/OutlineManager.tsx, panels.tsx}`、`M apps/plugins/shared/typography/web/index.tsx`、`M apps/plugins/shared/ui-kit/{package.json, src/aiBars.tsx, src/index.ts, src/themeStore.ts}`、`D apps/plugins/shared/ui-kit/src/InkBackButton.tsx`；同提交还带上 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`scripts/e2e/{e2e-core-flows,e2e-mode-separation}.mjs`（`git show --name-only b567758`）`[实测]`。
  > ⚠️ `apps/web/src/components/shell/DockShell.tsx` **原本被列在本行**，但 C2 的树已重建 ⇒ 该文件**不在 `b567758` 的清单里**（只在 C1 `3e3754e`）。

---

## 6. 接手后的前 30 分钟

### 6.1 先跑一遍基线（`[实测]` 2026-10-04 全部通过；lint 口径见下）

```bash
cd F:\new1.2
git status --porcelain                       # 应为空（5 个提交后工作区 / 索引双干净）
git log --oneline -5                         # 应看到 第5个提交(本文件修订) / 79f7e32 / c97d03f / b567758 / 3e3754e
pnpm install                                 # 若刚打过桌面包，必须先做这步恢复 ABI 137
pnpm -r type-check                           # EXIT=0（Scope: 14 of 15；实际执行 5 个包）
pnpm -r lint                                 # EXIT=0；0 errors / 3 warnings（见下）
pnpm --filter @novel/web test                # 12 files / 153 passed
pnpm --filter @novel/server exec vitest run  # 7 files / 63 passed
pnpm build                                   # EXIT=0，12.93s，ProjectLayout-BE5p2nO0.js 437.53 kB
pnpm verify:all                              # node scripts/verify/verify-all.mjs
pnpm verify:modes                            # 插件模式隔离门
node scripts/verify/measure-ink-consumers.mjs # 主题变量三口径（测量工具，退出码恒 0）
```

`[实测]` 明细（提交前 2026-10-04 上午）：`pnpm -r type-check` 只对 **5 个**带该脚本的项目实际执行（`apps/desktop`、`packages/core`、`apps/plugins/auto/novel.autowrite`、`apps/server`、`apps/web`），全部 `Done`，EXIT=0；`pnpm -r lint` 全仓 **0 errors / 4 warnings**（`apps/web` 1 条 = `DockShell.tsx:360:5` 未用 eslint-disable；`apps/server` 3 条 = 未使用变量）；web+server 单测合计 **19 files / 216 passed**。
`[报告]` 提交后（该修复落在 C1 `3e3754e`，`DockShell.tsx` 首次入库时就不含那行）`apps/web` 那条 eslint-disable 已删除 ⇒ `pnpm -r lint` 现为 **0 errors / 3 warnings**（本次未重跑，属未复核）。

### 6.2 本次入库清单与提交归属（提交前标题是「还没入库的东西」）

| 提交 | 落进来的东西（`git show --name-only` 实测） |
|---|---|
| `3e3754e` | Dock 重构 + 主题单一真源全部产物（52 files）：`apps/web/src/components/shell/{DockShell.tsx,PanelMenu.tsx,project-shell.css}`、`shell/dock/{CenterGraphPanel,DockPanelContent,DockShell.smoke.test,dock-theme,dock-tokens,layout,types}`、删除 `shell/{FloatingBubbles,PanelSection}.tsx`、`apps/web/vitest.probe.config.ts`、`apps/web/src/plugin/__tests__/plugin-dock-adaptation.test.ts`、`apps/plugins/shared/ui-kit/**`（含 `src/styles/vscode-dark-modern.css`）、删除 `apps/web/src/styles/{shuimo,themes}.css` 与 `components/{shuimo,effects,ui/InkBackButton}`、`scripts/verify/{measure-ink-consumers,verify-theme-single-source}.mjs` |
| `b567758` | 插件侧增量（11 files）：`apps/plugins/auto/workbench/web/index.tsx`、`apps/plugins/manual/workbench/web/**`、`apps/plugins/shared/typography/web/index.tsx`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`scripts/e2e/{e2e-core-flows,e2e-mode-separation}.mjs`（**已不含 `apps/web/src/components/shell/DockShell.tsx`**） |
| `c97d03f` | `apps/desktop/` 整目录 30 files（`src/**`、`scripts/{build-server-payload,build-update,bundle-shell,gen-icon}`、`electron-builder.yml`、`build-resources/{icon.ico,icon.png}`、`.gitignore`、`tsconfig.json`）+ `apps/server/src/index.ts` |
| `79f7e32` | 文档收口 11 files：`docs/architecture/{dock-protocol-adr,dock-refactor-final,desktop-packaging-adr}.md`、`docs/reports/{dock-refactor-verification,dock-refactor-closeout,desktop-e2e-verification,desktop-packaging-closeout,desktop-shell-audit}.md`、`docs/handover/{dock-and-desktop-handover-2026-10-04,next-session-prompt}.md`、`.gitignore`（**已不含 `apps/web/src/components/shell/DockShell.tsx`**） |
| 第 5 个（散列不可自述） | **本文件这次修订**（主题 `docs(handover): 交接文档同步入库后现状`）；散列由执行提交者填写，作者无法预知 |

> 逐文件归属可用 `git show --stat <散列>` 复核。`release/`（含 `release/desktop/`、`release/updates/`）被 `.gitignore` 忽略，**不在这些提交里** `[实测]`。

### 6.3 建议的处置顺序

1. ~~先提交/建分支锁住当前状态（68 项里含已验证与未验证混装，建议按工作线拆 commit）~~ —— **已于 2026-10-04 12:07–12:09 完成**（4 个内容提交 + 本文件所属的第 5 个，见 §1.1；工作区/索引双干净）。**剩余**：决定何时 `git push`（本地 `main` 领先 `origin/main` 5 个提交）、以及是否把四条工作线写进 `CHANGELOG.md`（当前最新条目仍是 `[0.1.0] - 2026-10-01`，无 10-01 之后条目 `[实测]`）。
2. 修 **F-F（高）**：给 `styleService.analyzeStyle` 加 `signal`，把 `EditorPage.tsx:136` 与 `StyleAdvisor.tsx:85` 的 AbortController 真正传进去，并把 `apiSave` 的 `silent` 收窄（`docs/reports/dock-refactor-closeout.md` §4.1 有完整链路）。
3. 补 §3.3 的 6 项人工确认（含 Linux 运行时）。
4. 决定 `--ink*`（187 处 → `--vscode-*`）迁移是否立项——**会改变外观**。
5. 桌面端若要再发版：先按 §4.4 确认 ABI，再按 ADR-0008 重跑打包，并**重新登记哈希基线**——现基线在 `docs/reports/desktop-packaging-closeout.md` §A.1，报告 §1.1 已过期；§A.1 自己写明「任何一次重打包都会使本节再次过期」，重打包后必须再刷一次。
6. 修 EPIPE 自激写盘（`apps/desktop/src/logger.ts` 的 `echoToConsole` 递归），或在文档里明确「禁止重定向 stdio 启动」。

### 6.4 已失效的旧引用（别照抄）

- `apps/plugins/local/novel.autowrite/server/pipeline/roles-phase.ts`（`UNFINISHED-pipeline-blocked.md` 里的修法路径）：**该目录已不存在**，文件也已不在（`[实测]` `Test-Path` 为 False）。引擎整包移出仓库到 `F:\new1.2-detached\ai-autowrite-module\`（含 `novel.autowrite/`、`workbench/`、`MANIFEST.json`、`PLUG-BACK.md`）`[实测]`；仓库内只剩 4 个骨架文件（`plugin.json`、`package.json`、`tsconfig.json`、`server/index.ts`）。
- `ai-writing-handover.md`（最后更新 2026-09-12）里的基线数字已过期：原文写 `pnpm type-check`「**8 个包**必须全绿」、server 单测「16 文件 / 213 用例」（2026-09-17 实测）——当前是 15 个 workspace 项目、server 7 files / 63 passed。
- `apps/web/src/pages/EditorPage.tsx` 不存在（见 §3.5 路径勘误）。

---

## 7. 勘误台账：转述 vs 原报告/实测

| # | 转述 | 原报告 / 本次实测 | 结论 |
|---|---|---|---|
| 1 | 「四条工作线**全部**在工作区未提交」 | `[实测]` 插件模式拆分的结构**已在 HEAD**（`git ls-files apps/plugins` = 146 个文件，`apps/plugins/{manual,auto,shared}` 均在 `c2583f8` 里）；未提交的只是拆分后的增量 | **部分不成立** |
| 2 | 「type-check **14/14** 通过」 | `[实测]` `pnpm -r type-check` 的原文是 `Scope: 14 of 15 workspace projects`（14 = **被选中的项目数**，不是通过数）；实际带 `type-check` 脚本并执行的只有 **5 个**，全部 `Done`、EXIT=0 | **数字来源被误读** |
| 3 | 「workspace **15** 个项目」 | `[实测]` pnpm 列 **15** 个（含根 `novel-companion`）+ 14 个子项目 | 成立（口径要写明含根 package） |
| 4 | 「lint 0 error」 | `[实测]` 全仓 `pnpm -r lint` EXIT=0，**0 errors / 4 warnings**；报告里的「0 errors, 1 warning」是 **web 单包**口径 | 成立但需补口径 |
| 5 | 「单测 **216** 通过」 | `[实测]` web 12 files/153 + server 7 files/63 = **19 files / 216 passed**，两套 EXIT=0。**两份报告自身都不写「216」**（216 是两处相加：dock 收尾 web 153 + desktop 收尾 server 63） | 成立（需注明是求和） |
| 6 | 「Mode B 闭包超基线 **134 MB**」 | `[报告]` closeout §3.5、shell-audit DEV-09 原话确实是 134 MB；但 252,475,413 − 107,768,288 = **144,707,125 B ≈ 144.7 MB / ≈138.0 MiB** | 原报告内部算术不自洽，引用需注明 |
| 7 | 「桌面端报告 §5 的**四条**未验证项」 | `[报告]` closeout §5 是 **9 行**表格；转述的 4 条对应第 1、2、4、5 行 | **不成立** |
| 8 | 「ABI 137/149 的打包后纪律」 | `[报告]` ADR-0008 §D8.1/§D8.4 原文一致：打包把 `.node` 就地改成 ABI 149 ⇒ 打包后必须 `pnpm install`（或 `pnpm rebuild better-sqlite3`）恢复 ABI 137，否则 `pnpm dev` / `pnpm test` 全部失败 | **成立** |
| 9 | 「`apps/desktop/package.json` 丢失 `build` 块，是发布前唯一需处置项」 | `[实测]`（提交前）该文件现为 **2547 B**（mtime 2026-10-03 21:10:54），`scripts`/`build`/`devDependencies` 均在 ⇒ 偏离已被修复；但修复后重新打包的产物（21:13）**哈希当时未经验证**（此后已由 `docs/reports/desktop-packaging-closeout.md` §A.1（215–255 行）登记），报告 §1.1 的哈希已与磁盘不符 | **报告结论已过期** |
| 10 | 「旧交接三文件 mtime 全是 2026-09-28」 | `[实测]` `ai-writing-handover.md` 2026-09-28 23:51:13 / `next-session-prompt.md` 2026-09-28 19:19:00 / `UNFINISHED-pipeline-blocked.md` 2026-09-28 19:19:00 | **成立** |

> **时间口径（重要）**：上表全部 `[实测]` 发生在 **2026-10-04 12:07–12:09 的 4 个提交之前**——写它时仓库还是「2 个 commit + 68 项工作区改动」的未入库状态，因此它记录的是「转述 vs 当时的原始报告」这一历史比较，**不是入库后的现状**。入库后的现状见 §1。表中「已在 HEAD」「未提交的只是增量」「哈希未经验证」等括号内表述同样限于该时刻。
> **第 9 行补充**：21:13 那轮重新打包产物的实测 SHA-256 现已登记在 `docs/reports/desktop-packaging-closeout.md` §A.1，**不再属于「无出处」**；发布校验请以 §A.1 为准。

---

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| `docs/architecture/dock-protocol-adr.md` | ADR-0007：停靠协议 + 主题单一真源契约（845 行，2026-10-02 15:18） |
| `docs/architecture/dock-refactor-final.md` | ADR-0007 收尾定稿：判据表、数字口径、与 ADR 的已知偏差（549 行，15:33） |
| `docs/reports/dock-refactor-verification.md` | 停靠重构验证详录（1099 行，15:22） |
| `docs/reports/dock-refactor-closeout.md` | 停靠重构收尾报告：D1–D21 式判定、残余风险、findings 台账、captain 回改（735 行，15:42） |
| `docs/architecture/desktop-packaging-adr.md` | ADR-0008：桌面打包契约（951 行，2026-10-02 21:06，已冻结） |
| `docs/reports/desktop-e2e-verification.md` | 桌面端 e2e 验证（295 行，2026-10-03 20:35）——含 §6 EPIPE 缺陷现场 |
| `docs/reports/desktop-packaging-closeout.md` | 桌面打包收尾：D1–D21、§5 未验证 9 项（255 行，20:39）；**§1.1 的产物哈希已过期，发布校验以 §A.1「发布产物实测基线」（现 215–255 行，2026-10-04 增补）为准**；§A.2 是「`build` 块恢复 → 21:13 重新打包」的时间链 |
| `docs/reports/desktop-shell-audit.md` | 桌面壳审计（52,141 B，17:12）——DEV-09 闭包超基线 |
| `docs/architecture/plugin-standard.md` | 插件标准：模式拆分、`modes`、G2.5 门 |
| `docs/architecture/plugins-inventory.md` | 插件清单（2026-10-09 复核版，记 27 个） |
| `apps/plugins/shared/ui-kit/src/themeStore.ts` | 主题 store 现状（单档，`ThemeId = 'vscode-dark-modern'`） |
| `README.md` L117–121 | 接手开发指路牌（`docs/handover/` 在先） |
| `docs/handover/dock-and-desktop-handover-2026-10-04.md` | **本文件**：四条工作线的接手交接；入库后现状见 §1、commit 归属 §6.2 |
| `docs/handover/next-session-prompt.md` | 新会话入口：先读顺序 + 30 秒现状 + 旧任务书附录 A |
| `docs/handover/ai-writing-handover.md` / `UNFINISHED-pipeline-blocked.md` | 另两条工作线的历史文档（未随本次提交改动；过期点见 `next-session-prompt.md` 第三节） |

---

> **一句话总结**：四条工作线的结论**已随第 1–4 个提交入库，本文件自身构成第 5 个提交**（本地 `main` 领先 `origin/main` 5、**未 push**；散列与归属见 §1.1 / §6.2，工作区双干净）。接手时：先决定 push 与版本/CHANGELOG 口径 → 按 §6.1 跑一遍基线 → 按 §6.3 处置 **F-F（高）** 与 **产物哈希基线（以 closeout §A.1 为准，不要再用 §1.1）** → 再看 §3.3 / §4.7 的未验证项清单，那些**不得视为通过**；§7 勘误表是**提交前**的历史比较，只用来校正数字来源。
