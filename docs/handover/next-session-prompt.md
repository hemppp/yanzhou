# 新会话入口 · 砚舟 接手交接

> **2026-10-04 更新（团队一号 `handover-scribe`）**
> 本文件此前的全部内容是 2026-09-28 一条**已过期任务线**（用 desktop-control MCP 操控浏览器把小说「空山雨后」写到第 30 章）的自我包含任务书。
> 那段原文**未删除**，整体移到文末「附录 A」保留作现场记录；**新会话请从下面的入口读起。**
> 本次只更新本文件与新增 `dock-and-desktop-handover-2026-10-04.md`，未改动 `ai-writing-handover.md`、`UNFINISHED-pipeline-blocked.md`，也未改源码。
> **2026-10-04 收盘（提交后二次同步 · 散列已按重建后的提交链更正）**：四条工作线已分 **4 个内容提交**入库 —— `3e3754e`（Dock 重构 + 删 shuimo 主题，52 files, +4844/−4575）/ `b567758`（插件侧对接停靠协议，11 files）/ `c97d03f`（Electron 桌面端 `apps/desktop/`，30 files）/ `79f7e32`（三份 ADR + 五份报告 + 本目录文档，11 files）；**本文件与交接文档的这次同步构成第 5 个提交**（散列无法自述）。本地 `main` **领先 `origin/main` 5 个提交、未 push**，工作区/索引双干净。提交链于同日经**两轮 plumbing 修正**定稿：第二轮重建 C2/C3/C4 的树，消除 `apps/web/src/components/shell/DockShell.tsx` 的抖动，该修复归 `3e3754e`。下面第二节已同步；提交前写过「都还没入库」的地方以本节为准。

---

## 一、先读什么（按顺序）

1. **`docs/handover/dock-and-desktop-handover-2026-10-04.md`** —— 2026-10-01 之后**四条工作线**的接手交接：
   停靠（Dock）重构 + 主题单一真源（ADR-0007）、插件按创作模式物理拆分、Electron 桌面端（ADR-0008）。
   含：工作区/git 现状、验收基线、残余风险、**9 项「不得视为通过」的未验证项**、打包后 ABI 纪律、本机两处坑，以及一张「转述 vs 原报告」勘误表。
2. `docs/handover/ai-writing-handover.md` —— AI 写作模块「现在什么能用」的口径（**注意其 §0 基线数字已过期**，见第三节）。
3. `docs/handover/UNFINISHED-pipeline-blocked.md` —— 多代理流水线卡死的故障现场（**问题早已修复**，且其中引用的源码路径已失效，见第三节）。

---

## 二、30 秒现状（2026-10-04 提交后实测）

- 仓库共 **7 个 commit**，**HEAD = 本文件所属的第 5 个提交**（2026-10-04，主题 `docs(handover): 交接文档同步入库后现状`；其散列无法写入它自己的内容，**其父 = `79f7e32`**），分支 `main`；`origin/main` 仍是 `a0e1db0`，**本地领先 5 个提交、未 push**；工作区与索引**双干净**。
- **2026-10-01 之后四条工作线的产物已全部入库**，按 4 个内容提交拆分：`3e3754e` Dock 重构 + 删除 shuimo 主题（52 files, +4844/−4575）、`b567758` 插件侧对接停靠协议 D9（11 files）、`c97d03f` Electron 桌面端 `apps/desktop/` 整目录（30 files, +6775）、`79f7e32` 三份 ADR + 五份报告 + `docs/handover/**`（11 files, +5529）；**第 5 个提交就是本文件与交接文档的这次同步**。逐文件归属见交接文档 §6.2；提交前那批「68 项未跟踪/未提交」的描述已完成历史。
- **接手第一件事**：决定**何时 `git push`**（5 个提交只在本地），再照交接文档 §6.1 跑一遍基线。
- **两个立刻会绊倒人的点**：
  - 桌面端打包会把仓库 `node_modules/better-sqlite3` 就地改成 Electron ABI 149；**打包后不 `pnpm install` 恢复 ABI 137，`pnpm dev` / `pnpm test` 全红**。
  - 磁盘上的 `release/desktop/` 安装包是 2026-10-03 21:11–21:13 的**重新打包产物**，SHA256 与两份报告记录的 19:13 产物**不一致**——报告 §1.1 的哈希 attestation 只对旧那轮成立。**当前发布校验请以 `docs/reports/desktop-packaging-closeout.md` §A.1（215–255 行，2026-10-04 增补）为准**。

---

## 三、历史文档的过期之处（只在此指出，不改那两个文件）

| 文档 | 过期点 |
|---|---|
| `ai-writing-handover.md`（最后更新 2026-09-12） | §0 写 `pnpm type-check`「**8 个包**必须全绿」——当前 workspace 是 **15 个项目**（含根 package）；server 单测基线写「16 文件 / 213 用例（2026-09-17 实测）」——当前是 **7 files / 63 passed**；web 侧当前是 **12 files / 153 passed**。 |
| `UNFINISHED-pipeline-blocked.md`（标题已是「✅ 已修复」） | 修法 1 引用的 `apps/plugins/local/novel.autowrite/server/pipeline/roles-phase.ts` **路径与文件都已不存在**：引擎整包移出仓库到 `F:\new1.2-detached\ai-autowrite-module\`（含 `novel.autowrite/`、`workbench/`、`MANIFEST.json`、`PLUG-BACK.md`），仓库内只剩 4 个骨架文件（`plugin.json`、`package.json`、`tsconfig.json`、`server/index.ts`）。装回方式见 `PLUG-BACK.md`。 |
| 附录 A（2026-09-28 旧任务书） | 整条任务线的前提已变：`mode=auto` 的 AI 自动写作模块处于**剥离态**（打开 `mode=auto` 项目会显示「AI 写作台未安装 —— 该创作模式对应的模块未启用」，属预期行为）。其中引用的界面坐标、`scripts/run-chapters.mjs` 续跑命令等**未在本轮复核**，标注为未验证。 |

---

## 四、本文件（`next-session-prompt.md`）的定位

它曾经是「把一段自包含任务书发给新会话」的载体。现在改成**接手入口 + 现状导航**：新会话从这里出发，按第一节的顺序读。若将来又出现需要「整段粘贴给新会话」的独立任务书，建议另建独立文件（如 `docs/handover/<主题>-prompt-<日期>.md`），不要再覆盖本入口。

---

## 附录 A：2026-09-28 旧任务书原文（另一条工作线，已过期，保留作现场记录）

> 以下为 2026-09-28 的原文件内容，**逐字保留**，未做修改。除排版外不表任何新结论。

# 新会话任务：用 MCP 操控浏览器，把「空山雨后」写到第 30 章

> 把下面 `===` 之间的内容整段发给新会话即可（新会话看不到上一轮上下文，所以是自包含的）。

===

【任务】用 desktop-control MCP 工具（真鼠标键盘）操控浏览器，确认（必要时续跑）AI 写作项目「空山雨后」的第 3–30 章。

【背景 — 你没有上一轮上下文，这里是全部所需】

- 项目根：`F:\new1.2`（砚舟，AI 长篇小说创作工具，pnpm monorepo）
- **服务已在跑**：server `http://127.0.0.1:3774`（Node 24 启动）、vite `http://localhost:5173`
  （vite 只监听 IPv6，**必须用 localhost**，用 127.0.0.1 连不上）
- 测试账号：`probemty3qnbx` / `Probe1234!`（已配好 AI provider）
- 目标项目：书架里的「空山雨后」（`mode=auto`，id `c980335a-026a-413f-9717-fcc9a8f05e44`）
- 已完成：第 1 章 3382 字、第 2 章 3727 字。
  **上一轮已在界面上设「连写 28 章」并发出「写第3章…」**，若界面没断，此刻正在自动写 3–30 章。

【第一步：先查进度，不要急着动鼠标】

```bash
cd F:/new1.2 && "D:/ruanjian/node.24/node.exe" -e "
const D=require('better-sqlite3');
const d=new D('F:/new1.2/data/projects/c980335a-026a-413f-9717-fcc9a8f05e44.db',{readonly:true});
console.log('章节数:', d.prepare('select count(*) c from chapters').get().c);
for(const r of d.prepare('select \"order\" o, word_count w from chapters order by \"order\"').all()) console.log('  第'+r.o+'章 '+r.w+'字');
d.close();"
```

- 章节数在增长（>2 且持续增加）→ 界面连写在跑，**别重复发**，每隔几分钟查一次，跑完做验收。
- 停在 2 → 界面断了，按下面步骤在界面上重新触发。

【第二步：用 MCP 工具驱动界面】

工具前缀 `mcp__desktop-control__`：`focus_window` / `run_actions` / `screenshot` / `click` /
`type_text` / `press_key` / `hotkey` / `active_window` / `screen_size`。

**两条纪律（不遵守必踩坑）**：

1. **每次动作前先 `focus_window("砚舟")`** —— 你执行操作时宿主会抢到前台，
   不置前点击/输入会打在自己身上（上一轮把登录密码敲进了别的窗口）。
2. **优先用 `run_actions` 把一串动作一次下发**（换行分隔），不要逐个工具调用 ——
   调用之间的空档正是被抢焦点的时间窗。

中文一律用 `type_text`（走剪贴板，绕开输入法）。操作前后 `screenshot` 确认，别凭想象。

【界面坐标（1920x1080 整屏，窗口最大化后）】

| 元素 | 坐标 |
|---|---|
| 落地页「开始创作」 | 954, 723 |
| 登录 用户名框 | 954, 547 |
| 书架「+ 新建」 | 1552, 153 |
| 书卡「空山雨后」 | 455, 387 |
| 新建弹窗「AI 写作」 | 1074, 399 |
| 新建弹窗 书名框 | 954, 489 |
| 新建弹窗「创建」 | 1104, 812 |
| 工作台 输入框 | 134, 865 |
| 工作台「连写 N 章」数字框 | 225, 962 |

【登录序列（run_actions 可直接用）】

```
focus 砚舟
wait 0.6
click 954 723
wait 3
click 954 547
wait 0.8
hotkey ctrl a
type_text probemty3qnbx
wait 0.5
press_key tab
wait 0.5
hotkey ctrl a
type_text Probe1234!
wait 0.5
press_key enter
wait 9
screenshot C:/temp/s1.png
```
（若页面直接是书架就不用点「开始创作」；工作台输入框有 autoFocus，进去直接打字即可。）

【触发 3–30 章连写】

```
focus 砚舟
wait 0.6
click 455 387
wait 13
press_key tab
hotkey ctrl a
type_text 28
wait 1
screenshot C:/temp/s2.png
hotkey shift tab
type_text 写第3章：陈默决定主动查清姐姐失踪的真相，却发现三年前那通电话和他自己有关。
wait 1
press_key enter
```
⚠️ **连写数字框只需按 1 次 Tab**：输入框为空时发送按钮是 disabled、不可聚焦（按 2 次会跳过去）。
`wait 1` 后截图确认左下角显示「连写 28 章」，再往下走。

【关键坑】

1. 窗口位置会漂 → 坐标不对就先 `screenshot` 看一眼再调
2. Chrome 用**独立 profile** 启动最稳：`python scripts/desktop-control.py chrome http://localhost:5173/`——
   日常 profile 会反复弹「Chrome 未正常关闭 → 恢复页面」挡住页面，登录态还每轮丢
3. 首页可能停在落地页而非书架 → 登录序列里「开始创作」那步不能省
4. 界面连写中断不要紧：已交付的章不会被重写（有「已有正文不覆盖」保护），重发指令接着写
5. 完全不想用鼠标时，脚本也能续跑：
   `node scripts/run-chapters.mjs --user probemty3qnbx --project c980335a-026a-413f-9717-fcc9a8f05e44 --from <下一章> --count <剩余> --batch 5 --resume`

【验收】

跑完汇总：章节数（应到 30）、各章字数、实体累积（characters / items / locations / foreshadows /
story_events）、以及质检结果（意图门打回次数 / 校对门是否有冲突 / 润色分）。
脚本方式跑的明细在 `data/run-chapters-*.jsonl`。

===

## 备注

- MCP 工具**只在会话启动时快照**，所以「信任」后必须**新开会话**才看得到这些工具。
- 相关代码：`scripts/mcp-desktop-server.py`（MCP 形态）、`scripts/desktop-control.py`（CLI 形态，
  同一套底座，当次会话就能用）。
