# 更新日志

本文件记录 砚舟（听风细雨）的重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-06

停靠式工作台（Dock）重构与桌面端（Electron）首个可用版本。

### 新增

- **桌面端（Electron）**：主进程 + 内嵌 server 子进程，内置 server 负载与
  seed 插件；交付 Windows x64 的**两种形态**：NSIS 安装版与
  **标准绿色 zip**（`砚舟-Portable-0.2.0-x64.zip`，解压后进顶层
  `砚舟/` 双击 `砚舟.exe`）。
  首启自动播种数据目录，退出走优雅关闭通道。
  > 单文件便携 exe（`砚舟-Portable-0.2.0-x64.exe`）曾作为第三种形态提供，
  > 已于 **2026-10-06 移除**（见下方「变更」与 ADR D4.6）。
- **停靠式工作台（Dock）**：以 `dockview` 重建项目页布局 —— 活动栏、
  左/中/右三栏与底部细条，面板可拖拽停靠；新增 **文档标签**（DocTabs）
  接管中心区组头，可打开 / 关闭「章节正文 / 人物设定 / 大纲」等标签。
- **插件停靠协议 D9**：插件侧对接停靠面板注册与中心区抢占
  （`dock:{center:true}`），并补齐 `auto` 创作台入口。
- **编辑器批注块**：`AnnotationBlock` 扩展 / 视图 / 桥接钩子，
  选中文本可插入批注块，支持章节元信息与导出。
- **AI 对话面板**：`auto` 工作台新增 AI 对话面板与 SSE 流式通道。
- **UI 集成自测**：`scripts/e2e/e2e-ui-integration.mjs`，覆盖三栏布局、
  文档标签、视口契约、mode 切换、AI SSE 与控制台错误等 11 个小节。

### 变更

- **创作模式入口收口**：移除项目页顶栏的「AI 写作 / 手写写作」切换按钮组。
  创作模式在**建书时**决定，界面只被动展示当前模式（状态栏），不再提供
  中途切换入口 —— 进入 AI 写作就是 AI 写作，手写写作就是手写写作。
- **子界面返回键**：进入子界面（设置 / 管理员 / 工作台未安装占位）统一提供
  左上角小返回键，用户可原路返回，不再出现「进得去出不来」。
- **主题**：删除 `shuimo`（水墨）主题，统一为 VS Code Modern 亮 / 暗色。

### 修复

- **文档标签重复行**：中心区组头与文档标签曾出现两条重复行，已收敛为一行。
- **便携版首启无反馈（已修）**：单文件便携 exe 在未配 `portable.splashImage` 时，
  electron-builder 的 `portable.nsi` 会走 `SetSilent silent` ⇒ 双击后要静默自解压
  数分钟且全程无窗口，用户据此判定「启动失败」。现已配启动图
  （`build-resources/splash.bmp`），解压全程可见提示。
- **便携版负载过大（已修）**：配套把 server 负载从 **240.8 MB / 32158 文件** 裁剪到
  **68.2 MB / 5911 文件**（剔除 web-only 依赖与第三方包内 `.map`/`.d.ts`/文档），
  单文件 exe 首启自解压由约 **4.5 分钟**降到约 **1–2 分钟**；绿色 zip 约 **190 MB**，
  解压约 **5 秒**，双击即起窗。
- **便携版首启无反馈（已废）**：曾为单文件便携 exe 补 `portable.splashImage`
  以消除「双击后数分钟无窗口」。该 exe 形态已整体移除，此修复连同
  `portable` target 一并作废（ADR D4.6）。

### 变更（2026-10-06 同日修订）

- **移除单文件便携 exe**：便携版**只保留 zip 一种形态**。`win.target` 回退为
  只有 `nsis`；`portable` 配置段与 `dist:portable` 脚本一并删除；
  `release/desktop/砚舟-Portable-0.2.0-x64.exe`（122219604 B）已从产物目录删除。
  理由：与绿色 zip 功能完全重叠，且它是 NSIS 自解压 stub —— 首启实测 64–102 s，
  并独占 D4.5-1 记录的两个假象（`Error writing temporary file`、无窗口静默 exit 0）；
  zip 解压约 5 s 且解压后就是普通 exe，没有 stub 这一层。
  **文件名不变**：便携版 zip 仍叫 `砚舟-Portable-<version>-x64.zip`
  （「Portable」指便携形态，不是 portable target）。
- **修掉「封装版界面与网页版不一致」的成因**：桌面端的前端与后端**不是**从安装目录
  直接运行，而是**首启播种一次**到 `%APPDATA%\NovelMuse\app-runtime\{web-dist,app-server}`，
  之后再装新版安装包 / 换新版便携 zip **都不会刷新它**（播种闸门只看
  <code>app-runtime\version.json</code> 是否存在，从不比较版本号，见
  <code>docs/architecture/desktop-packaging-adr.md</code> D7.2）。本次已清除本地
  冻结的旧运行时（含先摘除 `app-server\data` 与 `app-server\node_modules\better-sqlite3`
  两个 junction，避免递归删除穿透链接删掉书稿库），下次启动会按新包重新播种。
  **注意：代码层面的「版本变了就重新播种」尚未实现**，是残留缺陷。
  （该残留缺陷已于下方「修复（同日修订 2）」中实现，见 ADR D7.5。）

### 修复（2026-10-06 同日修订 2）

- **播种闸门现在会识别「同版本号重新打包」（ADR D7.5）**：以往闸门只判
  `app-runtime/version.json` 是否存在，于是**在同一个版本号（如 0.2.0）下重新打包**后，
  用户装上新包仍看到旧界面/旧后端 —— 闸门跳过播种，而 `copyDirNoClobber` 又对
  已存在文件一律跳过。现在新增**载荷指纹** `buildId`：打包脚本对
  `app-server + seed-plugins + web-dist` 三棵树做 `sha256(sorted "<label>/<relpath>|<bytes>")`
  取前 32 位，写 `<resources>/app-server/build-stamp.json`。启动时三条触发条件任一成立
  即重新播种：`missing`（无 version.json）/ `shell-newer`（安装包版本更高）/
  `payload-changed`（**版本号相同但指纹不同**）。
- **重新播种会先清空旧运行时**（否则 `copyDirNoClobber` 一个文件都复制不进来）：
  清 `plugins/node_modules` → `app-runtime/app-server` → `app-runtime/web-dist` →
  `plugins/{auto,manual,shared}`；`plugins/local`（用户自装）不碰。
  **数据安全**：删除逐条目 `lstat` 判定，**链接只摘链接、绝不递归跟随**，
  也绝不对 `app-runtime/app-server` 做 `fs.rmSync(..., {recursive:true})`
  （那会穿透 `data` junction 删掉全部书稿）。另加两道自检：清理前若
  `app-server/data` 是**真实非空目录**（D7.3 junction 未建成的历史遗留）则**拒绝播种**；
  清理后自证 `<userData>/data` 仍存在。
- **应用内更新不再被误判为陈旧**：更新器替换载荷后会把更新包里的 `buildId`
  一并写入 `version.json`（ADR D14.5 步骤 8），避免下次启动被判成
  `payload-changed` 而把刚装好的运行时回退成安装包里的旧载荷。
- **开放注册（打包态）**：`apps/server/src/modules/auth.ts` 在 `ALLOW_REGISTRATION`
  未定义时按 `NODE_ENV !== 'production'` 判定，而桌面端打包态 `NODE_ENV` 恒为
  `'production'` ⇒ 桌面版「注册」页会被 403 拒绝，与网页版行为不一致。现由主进程
  在打包态显式注入 `ALLOW_REGISTRATION='true'`（ADR D6 / D12.5）。
  **注意**：这是环境变量层面的开放，**前端没有注册开关 UI**，注册页在导航上始终可见。
- **启动日志**新增 `reseeded=` 字段，便于确认本次是否发生了重新播种。

### 变更（2026-10-07 死代码清理）

全仓零入边扫描（421 个源文件，排除 node_modules / dist / payload）后删除 **21 个零引用文件**
（约 2329 行 + 一张 768 KB 启动图），并清掉随之变空的 4 个目录：

- **迁移遗留的插件组件（8 个）**：`manual/workbench/web/` 下的
  `consistency/ConsistencyPanel.tsx`、`series/SeriesManager.tsx`、`snapshot/SnapshotManager.tsx`、
  `knowledge/Heatmap.tsx`、`foreshadow/EarmarkPanel.tsx`、`foreshadow/ForeshadowsPage.tsx`、
  `editor/extensions/MentionExtension.ts`、`editor/extensions/RealtimeRhythm.tsx`。
  它们来自 web→插件拆分那轮迁移，拆分契约明令「不删除任何文件」，
  之后**再没有任何注册点挂上去**（`web/index.tsx:46` 只注册了一个 `key:'chapters'` 面板）。
- **未接入路由的页面（1 个）**：`apps/web/src/pages/ProjectSelectPage.tsx`
  —— `App.tsx` 路由表、`lazyRoute`、字符串路径三处均无引用。
- **零引用的兼容垫片（9 个）**：`apps/web/src/` 下 9 个 1–4 行的再导出壳
  （`components/layout/{BottomDrawer,RightSidebar}.tsx`、`hooks/useCurrentProjectId.ts`、
  `services/data/localUserData.ts`、`services/editor/{rhythmService,styleService}.ts`、
  `stores/{cascadeCleanFlag,editorStore,outlineNotepadStore}.ts`）。
  **只删壳**：它们指向的实体仍在 `@novel-plugins/{data-core,ui-kit}` 里并由插件直接引入
  （`apps/web/src` 另有 19 个同类垫片仍被引用，保留）。
- **无人调用的服务（1 个）**：`apps/server/src/services/demo-seed.ts`
  （`seedDemoData` 已导出但全仓无调用点）。
- **portable 目标移除后的孤儿资产（2 个）**：`apps/desktop/build-resources/splash.bmp`
  （唯一消费者 `portable.splashImage` 已随 D4.6 作废）与生成它的
  `apps/desktop/scripts/gen-splash.py`。

验证：`pnpm -r type-check`（14 workspace）✓、`pnpm --filter @novel/web build` ✓、
`pnpm verify:all` ✓。构建产物**仍是 49 个 chunk、一个都没少**
（本次删除的代码此前就已被 tree-shaking 排除在包外），仅 chunk 文件名哈希发生漂移；
因此 `buildId` 会变化，桌面端下次启动会按 D7.5 自动重新播种。

### 修复（2026-10-07 跳转加载 · 第二轮）

2026-10-06 的「全修复」只覆盖了**路由级** chunk（`PRELOAD_ON_PATH` / `ALL_ROUTE_LOADERS`
那 9 个页面 loader），漏掉了**进项目之后才出现的那批 chunk** —— 它们全是模块内部的
相对路径懒加载，kernel 连说明符都看不到。本轮补上这三处：

- **面板级预取（新增模块 `preload()` 扩展）**：`manual/workbench/web/index.tsx` 与
  `auto/workbench/web/index.tsx` 各导出一个 `preload()`，把章节左栏 + 12 个手写台停靠面板 +
  AI 对话面板的 `import()` 一次性发出。kernel 新增 `loadModulePreload(dir)`
  （`apps/web/src/plugin/moduleEntries.ts`），仍走既有的 `import.meta.glob` 模块入口解析，
  **没有新增任何指向插件内部的静态 import**（D35 / K2M 边保持不变）；模块缺席或未导出
  `preload` ⇒ loader 为 null ⇒ 自动跳过。
  预取列表与实际加载项**同源**：`panels.tsx` 的 12 个 `React.lazy` 统一经新的
  `lazyPanel()` 包装，谁被懒加载谁就自动进预取列表，不会两处各写一遍而漂移。
  触发点挂在 `PRELOAD_ON_PATH` 的 `/bookshelf` 与 `/project` 两段（进入工作台的入口）。
- **全站预热从「串行空闲队列」改为「一次并行发出」**（`apps/web/src/App.tsx`）：
  原实现一个 loader 一个空闲时间片（每次最多等 2.5 s 空闲），队列尾部的 loader
  要十几秒后才轮到 —— 那段时间跳转照样出「加载中」，等于没预热。现在在首屏稳定后的
  同一个 `requestIdleCallback` 里把全部 `import()` 一起发出，由浏览器自己复用连接排优先级；
  空闲回调保证不抢首屏，模块表缓存保证重复预热是廉价 no-op。
- **入场淡入不再从全透明起步**（`apps/web/src/routes/PageFade.tsx`）：
  `opacity: 0 → 1` 跑 280 ms 等于每次跨段跳转整页闪一下（深色界面上会透出
  `color-scheme: light` 的白底）。改为 `opacity: 0.4 → 1`、160 ms、位移 8px → 4px：
  保留过渡感，但任何一帧都不会出现空白页。

**未预热（有意保留懒加载）**：`ui-graph` 的 `Graph3D` 及其 `vendor-three`（562 KB）——
只在打开关系图时按需拉取，进项目就预下这半兆不划算。若实际使用中关系图打开偏慢，
把 `GraphShell.tsx:25` 那条 lazy 也纳入 `manual` 的 `preload()` 即可。

验证：`pnpm -r type-check`（14 workspace）✓、`pnpm --filter @novel/web build` ✓、
`pnpm verify:all` ✓。产物静态核验：kernel 入口已含 `typeof n.preload=="function"&&await n.preload()`
调用点，两个模块入口 chunk 的导出表里各有 `preload`，面板 chunk 均由模块入口 chunk 引用。
**未做浏览器级耗时实测**（`e2e:ui` / `e2e:modes` 需要 CDP 浏览器 + dev 服务，本轮未起）。

### 修复（2026-10-07 活动栏按钮 = 面板开关）

用户口径：最左侧活动栏里已有的「章节」「AI 对话」图标按钮，**点一下要能把对应面板收起来**。

- **现象与原因**（`apps/web/src/components/shell/DockShell.tsx`）：`onActivitySelect` 对
  已打开的面板只调 `p.api.setActive()`（= 只聚焦），从未调用 `closePanel` ⇒ 面板一旦打开
  就**永远收不起来**，只能去点标签上那个悬停才显形的 `×`。
- **改法**：按钮语义改为该面板的开/关开关 —— 存在性判定与 `closePanel` 同源
  （普通面板 `nm-panel:<key>`、抢占中心区者 `nm-center:<key>`），存在则 `api.closePanel(key)`，
  否则 `api.openPanel(key)`。走 `closePanel` 而非自己 `removePanel`，是为了复用它末尾的
  `reapplySideWidths()`：否则 dockview 会把腾出的空间均分，一次「开→关」就把
  240 / 636 / 340 变成 405 / 405 / 406 且不可恢复。
- **`ActivityBar` 拆开两个视觉维度**：`is-active` 仍表示「当前聚焦」（沿用 `activeKey`），
  新增 `openKeys` 驱动的 `aria-pressed` 表示「是否已打开」，提示文案随之为
  「点击收起」/「点击打开」。改造前两者都取 `activeKey`，故「已打开但未聚焦」的面板按钮
  显示为未按下，这正是看起来「点了没反应」的来源。
- **未改**：标签 `×` 的显隐（`.dock-tab-close` 仍悬停 / 激活才显形）与 `PanelMenu` 的
  「点击 = 打开或聚焦」都保持原样 —— 本轮只按用户口径改活动栏按钮。
- **「已打开」自己看得见**（`apps/web/src/components/shell/dock/dock-theme.css`，用户口径
  m01330「打开了的功能按钮需要加深颜色」）：按钮既然是开关，「已打开」就必须有视觉状态，
  否则章节 / AI 对话这类默认打开的面板，在中心区持有焦点时跟未打开的按钮一模一样。
  三级视觉：未打开 = 透明底；**已打开（未聚焦）= `--vscode-toolbar-hoverBackground` 底 +
  提亮图标色**；已打开且聚焦 = `.is-active` 的实底 + 左侧竖条（t6 已按参考图校准，保持不动）。
  该规则排在 `.is-active` 之前（同特异性，后者胜出）。取 `toolbar-hoverBackground` 而非
  `activityBar-activeBackground`：前者在**亮色**主题里比活动栏底（99.2%）更深一档，正是「加深」；
  **暗色**主题下活动栏底只有 11% 明度，再深就发黑成一团，故按 VSCode 按下态惯例取比底色亮一档的实心底。
- **回归测试**：`apps/web/src/components/shell/dock/DockShell.smoke.test.tsx` 新增 3 例
  （点已打开 ⇒ 视图移除 + 回写集合移除 + 按钮翻成「点击打开」；再点 ⇒ 重新打开；
  未打开 ⇒ 打开而非只聚焦），用受控宿主复刻 `ProjectLayout` 的 `openKeys` + `onOpenChange`
  回写路径。该文件 **32 例全过**。

验证：`pnpm -r type-check`（14 workspace）✓、`pnpm --filter @novel/web build` ✓（入口
`index-MgBlOjAu.js`）、`pnpm verify:all` ✓（web vitest **227 例 / 17 文件全过**）、
桌面端重打包（新 `buildId` `3b4093c67b28d24e8891fd97f46b90a3`）✓。
真实启动核对：`布局：seeded=true，reseeded=true`、`plugins=27`，且服务端实际发出去的
`ProjectLayout-DZOm6ZNS.js` 含「（点击收起）」文案、懒加载样式 `ProjectLayout-DO9STjik.css`
含 `.dock-activity-item[aria-pressed=true]{…}` ⇒ 端到端确认新行为确实到了用户机器上。
（注：新行为只在**新解压的副本**里生效 —— 旧副本的 `build-stamp.json` 指纹不同，
从旧副本启动会把运行时**退回**旧载荷，这是 D7.5「同版本号换载荷即重播种」的既定语义。）

### 修复（2026-10-07 同时打开面板上限 = 3）

用户口径（m01407）：**「不能同时打开，增加限制最多只能打开三个功能」**；
追问超限行为后用户选定：**自动收起「最久没看过的」那个**（即 LRU，其余候选为
「最早打开的」/「拒绝并提示」，均未选）。

- **背景（这是一次有意的政策回退）**：`docs/architecture/dock-protocol-adr.md` 的
  **D10 曾冻结「`MAX_OPEN_PANELS` 删除、无限打开」**，理由是旧行为「打开第 4 个
  **静默**挤掉第 1 个」属于「做了但用户不知道」（`docs/design/ui-tab-workspace-design.md:139`）。
  本次用户明确要求上限回归，因此问题不在「要不要淘汰」，而在**旧行为既不按最近使用、
  也不告知用户**。ADR 已增写 **§4.4 修订**并标注 D10 被取代、§4.1/§4.2 部分结论失效。
- **改法**（`apps/web/src/stores/panelOpenStore.ts`，打开集合的唯一真源）：
  - `MAX_OPEN_PANELS = 3` 回归并导出；新增模块级 `recency` 顺序（只记 key，
    `RECENCY_CAP = 64` 防御性裁剪）。
  - **「用过」= 被打开或被聚焦**：`open` / `toggle` / `_setActive`（点标签、点活动栏、
    命令式打开都会经过它）与 `seedPanelOpenKeys` 均 `touchRecency`。
  - `limitOpenKeys(keys)` 在**超出上限时**按 `ageRank` 淘汰最久没用过的若干项，
    集合自身顺序（= 打开顺序）保持不变。
  - **未知 key 视为最新**（`ageRank` = `recency.indexOf`，`-1` 即最新）：出现「store
    没记过」的 key，只可能是活动栏 / 插件走 `DockShellApi.openPanel` 直接 `addPanel`、
    视图刚把它生出来。若当最旧，`_syncFromView` 会**误杀刚打开的那个**
    （表现为「点第 4 个按钮，它自己关了」）。
  - **视图侧也统一裁剪**：活动栏与拖拽绕过 `store.open`，故 `_syncFromView`（整集合
    覆写）在合并种子后同样走 `limitOpenKeys`；被裁者由 `DockShell` 受控 effect
    （`openKeys`）从视图移除，收敛后回写 3 个、不再抖动。
- **淘汰可见（本次修订的一半意义）**：`notifyEviction` 抛 `novelmuse:toast-notify`
  （`dispatchToastEvent`，数据层直接广播 `window` 级事件，不依赖 React 树），
  文案「已收起最久未用的面板（最多同时打开 3 个）」，`duration: 2600`；
  `lastEvictNoticeAt` **600 ms 去抖**，避免「开第 4 个 → store 裁 → 视图回写 → 再裁」
  的收敛过程连弹两条。
- **未改**：`close` / `closeAll` / `opened` / `active` / `focus` 语义原样；
  `DEFAULT_OPEN_PANEL_KEYS`（章节 + AI 对话两个种子）不动，2 个种子远低于上限。
- **回归测试**：新增 `apps/web/src/stores/__tests__/panelOpenStore.test.ts`，9 例 ——
  上限常量 = 3 且种子不淘汰 / 开第 4 个裁到 3 且淘汰最久没用过的 / 淘汰依据是
  「最近使用」而非「最早打开」/ 重复打开只聚焦不淘汰且无提示 / `toggle` 同受限 /
  `_syncFromView` 越限裁剪且不误杀刚打开的 / 淘汰抛一次 `novelmuse:toast-notify` /
  `close`·`closeAll` 语义不变 / 同一批淘汰去抖只提示一次。

验证：`pnpm -r type-check`（14 workspace）✓、`pnpm --filter @novel/web exec vitest run`
（web **236 例 / 18 文件全过**，含新增 9 例）✓、`pnpm verify:all` ✓（plugin 模式分离 +
manifest 合法性门禁 5/5）✓、`pnpm --filter @novel/web build` ✓（入口
`index-CxWWzN-B.js`）✓、桌面端重打包 ✓。
真实启动核对（`release\desktop\win-unpacked\砚舟.exe`）：`布局：seeded=true，
reseeded=true`（buildId `3b4093c6…` → **`484046b7fdc335afe040d4af0f04676b`**）、
`就绪探针通过：status=ok，database=connected，plugins=27`，端口 `49761`；
服务端实际发出的 `assets/panelOpenStore-Cxs-N7Gk.js` 里含
`const m=3,o=[],w=64`（上限 3 / recency / cap 64）与
``message:`已收起最久未用的面板（最多同时打开 ${m} 个）`,duration:2600``
以及 `n-A<600||` 去抖 ⇒ 端到端确认新策略确实到了用户机器上。关闭走优雅通道
（`exitCode=0`），无残留进程；书稿库 `novelmuse.db` 442,368 B 与 `data\projects`
3 个 `.db` 各 352,256 B 完好。

### 变更（2026-10-07 手写/自动隔离改造）

- **AI 对话面板（`ai-chat` 槽）由 `auto` 工作台移交 `manual` 工作台**：面板与 SSE
  通道实现随 `novel.manual.workbench` 落位（`manual/workbench/web/ai/`），注册
  modes 由 `['manual','auto']` 收紧为 `['manual']`；`auto` 入口
  （`novel.auto.workbench`）改为**有意为之的空实现** —— `inject` 清空、
  `apply()` 只留一条日志、不再注册任何槽，`web/ai/**` 三文件保留留档。
- **AI 能力通道刻意保持共享**：`ai.scan` / `ai.quickPhrases` / `ai.timelineExtract`
  / `ai.outlineFill` / `ai.entityRefresh` 是两侧模块都可引用的共享面，
  `registerCapability` **不盖宿主模式**；曾试做「能力按模式隔离」**已回退**。
  需要隔离的是 UI 扩展点 / 模块入口（`filterByProjectMode`）与模块间静态 import。
- **修复隔离门禁红**：`apps/web/src/plugin/__tests__/plugin-dock-adaptation.test.ts`
  曾以相对路径静态引用 `manual/workbench/web/panels`（rule=K2M / B-ENTRY），
  违反「kernel 只经模块公开入口」约束。该测试已迁入
  `apps/plugins/manual/workbench/web/__tests__/`，import 改为 `'../panels'`，
  `node scripts/verify/verify-workbench-isolation.mjs` 现 **EXIT=0**。

### 新增（2026-10-07 查询缓存）

- **`useCachedQuery` 查询缓存**：新增 `@novel-plugins/data-core/hooks/useCachedQuery`
  与集中式 `queryKeys`（`apps/web/src/services/api/queryKeys.ts`），对项目元信息 /
  章节计数 / 管理员概览 / 插件清单等读多写少的查询做进程内缓存与失效；
  `apps/web/src/hooks/useCachedQuery.ts` 为兼容再导出壳。
  接入点：`ProjectLayout`（从 URL bookId 恢复项目）、`BookshelfPage`、
  `ProjectIndexPage`、`AdminPage`、`PluginManagerSection`。

### 文档（2026-10-07 架构可视化）

- **新增框架展示树**：`docs/architecture/framework-tree.md` —— 按模块 / 关键目录层级
  展示仓库骨架，每个模块附一行职责注释，并给出「三条主线」与「模块归属速查」
  （手写模式 / 自动模式 / 共享库 / 内核）。
- 该文件取代先前的 6 张架构可视化图（`architecture-map.html`、
  `architecture-plain.html`、`entry-to-end-flow.html`、`flow-current.html`、
  `mind-map.html`、`project-graph.html`）与逐文件罗列的真实文件树
  （`file-tree.txt`，903 行）：三者信息重叠，保留一份可维护的框架树即可。
- 包路径口径保持正确：`ui-kit` / `ui-graph` / `data-core` 在 `apps/plugins/shared/*`，
  `packages/` 下只有 `core` / `db` / `shared` 三个包。

### 修复（2026-10-07 跳转加载转圈 · 全修复）

- **根因（实测确认）**：停靠内核（`DockShell` / `DockPanelContent`）自身**不提供任何
  Suspense 边界**，而手写台的面板组件全是 `React.lazy`（左栏章节树、右栏 AI 对话、
  12 个停靠面板）。dockview 经 `ReactDOM.createPortal` 把面板挂到 `DockviewReact`
  所在节点之下，**不重置 Suspense 边界** ⇒ 面板首次读取 chunk 时挂起，会一路上溯到
  路由级 `RouteFallback`，整页被 32px 大转圈替换。旧版 `ProjectLayout` 原本在面板
  内容处有 `<Suspense fallback={<PanelFallback/>}>`，Dock 重构时被删掉 —— 这是
  「点开面板 / 进项目就整页转圈」的结构性根因。
- **① 抽出共享 `PanelFallback`**：新增 `apps/web/src/components/shell/PanelFallback.tsx`
  （原先是 `ProjectLayout` 里的局部函数、仅服务 auto 工作台一处），并在
  `project-shell.css` 补上此前**缺失**的 `.shell-panel-fallback` 样式（颜色取
  `--vscode-*`，不写字面色值）。
- **② 补面板级 Suspense 边界**（根治项）：`components/shell/dock/DockPanelContent.tsx`
  在 `PanelErrorBoundary` 内、`.dock-panel-body` 外包一层
  `<Suspense fallback={<PanelFallback/>}>` ⇒ 面板 chunk 未到位时，只有该面板框内显示
  小转圈，不再让整页退化。
- **③ `ProjectLayout` 复用共享 `PanelFallback`**：删掉本地实现，auto 工作台分支继续
  使用同名组件；中心槽 `centerDefault={<Outlet/>}` 有意**不**额外包边界 —— 其内容是
  `lazyRoute()` 包裹的路由元素，自身已带 Suspense，再包一层会造成双层 fallback。
- **④ 书架条目意图预取**：新增 `routes/prefetch.ts`，把原先散在 `App.tsx` 模块作用域
  的路由 loader 与预取表提为**单一真源**，并导出 `prefetchProjectEntry()`（走书架 →
  项目那条完整四段链）。`BookCard` 新增可选 `onIntent`，在 `onMouseEnter` 与
  `onPointerDown` 时触发（`onPointerDown` 复用 `useGlassRipple` 已接受的回调，不额外
  挂监听器）；`BookshelfPage` 的卡片项传入该回调 ⇒ 鼠标刚移到书封上就开始预取，点开
  时 chunk 多半已就绪。
- **⑤ `RouteFallback` 防闪烁**：`routes/Lazy.tsx` 的整页 fallback 改为**延迟 180ms
  才出现**。React.lazy 首次读取必然抛 thenable（即使 chunk 已在模块缓存），零耗时挂起
  也会闪一次「加载中...」；延迟出现即可消除这种一闪而过。有意**不做**「最短显示
  时长」—— 那会把已就绪内容压住不放，与「少转圈」目标相反。
- **回归测试**：新增 `DockPanelContent.suspense.test.tsx`（2 例，验证挂起只落在面板框
  内、外层边界不被触发；去掉 `<Suspense>` 后 2 例即失败）、`Lazy.test.tsx`（4 例，
  延迟显示 / 卸载后不显示 / 已 resolve 不闪）、`BookCard.intent.test.tsx`（3 例，
  hover 与 pointerdown 各触发一次预取）。验证：`pnpm -r type-check` ✓（14 workspace）、
  隔离门禁 `verify-workbench-isolation` ✓（210 文件 0 违规）、web vitest
  **245 例 / 21 文件全过**、`pnpm verify:all` ✓。

### 新增（2026-10-08 便携版预置运行时）

- **便携版不再需要首启播种**：`apps/desktop/scripts/package-portable-zip.mjs` 现在在
  打包时把运行时**预置**进 zip 的 `砚舟/portable-data/`，并附带启动器
  `启动便携版.cmd`（向 Electron 传 `--user-data-dir=<解压目录>\portable-data`）。
  - **首启零等待**：实测「解压 → 双击启动器 → 就绪探针通过」**4.1 s**（此前需把
    76 MB / 5994 文件复制到用户目录，实测 12.4 s）。启动日志 `seeded=false，
    reseeded=false` —— 播种闸门（D7.2/D7.5）被预置的 `version.json` 直接放行。
  - **数据随身**：数据库、插件、日志、设置全部落在解压目录内的 `portable-data\`，
    不写 `%APPDATA%`（此前 R13 记录的「便携版不重定向 userData」缺口由此闭合）。
  - **磁盘不再翻倍**：便携模式不再于用户目录复制一份 76 MB 运行时。
  - 预置内容与 `resources/` **逐字一致**，`version.json.buildId` 取自
    `resources/app-server/build-stamp.json`，`appVersion` 取自 `apps/desktop` 的
    `version` —— 三者与 D7.5 的闸门同源，否则会被判成 `payload-changed` 而重新播种。
  - **两种模式并存**：直接双击 `砚舟.exe` 仍是传统模式（数据在
    `%APPDATA%\NovelMuse`，首启走 D7.2 播种），两种模式数据互相独立。
  - 打包脚本新增两道校验：`portable-data/` 关键条目齐备、中文条目名
    （`使用说明.txt`、`启动便携版.cmd`）均置 UTF-8 标志位（bit 11）。
  - **修正 `使用说明.txt` 的登录说明**：原写「默认口令 admin / Admin1234!」与实现
    不符 —— 服务端早已移除固定默认口令（`apps/server/src/index.ts:65-88`，ADR D6.2
    保留「随机初始密码 + 用户自行修改」语义）。现改为「密码首启随机生成，弹一次性
    对话框并写入 `logs\initial-admin-password.txt`」。
  - 实测（`release/desktop/砚舟-Portable-0.2.0-x64.zip`，**227893452 B /
    217.34 MB**，SHA256 `78b15b81ef432a068452710cb1a93f5b24535563a3792013821ef5e002edb0c5`，
    12466 条目）：解压副本双击启动器 → 4.1 s 就绪、`plugins=27`、
    `%APPDATA%` 的 `version.json` 与 `novelmuse.db` mtime **零变化**；把旧
    `%APPDATA%\NovelMuse\data` 覆盖进 `portable-data\data` 后重启，原书稿库
    （2 个项目）正常列出 ⇒ 迁移路径可用。
  - 体积变化：zip 由 199.7 MB 增至 217.3 MB（+17.6 MB，即预置运行时的压缩增量）。

### 变更（2026-10-08 移除沉浸式写作模式）

- **移除编辑器右上角的「沉浸式写作」全屏专注模式**（`WriterMode`）：
  - 删除 `apps/plugins/manual/workbench/web/editor/WriterMode.tsx`（112 行）。
  - `EditorPage.tsx` 去掉该模式的入口按钮、`writerMode` 状态、
    `if (writerMode && editor)` 的整页替换分支，以及随之无用的
    `Pen` / `WriterMode` 两处 import。
  - `useEditorInstance.ts` 的编辑器根类名由 `'ProseMirror WriterMode'`
    收敛为 `'ProseMirror'` —— 该类名是历史残留，全仓 CSS 从无
    `.WriterMode` 选择器（正文排版规则一直挂在 `.ProseMirror` 上，
    移除后样式不变）。
  - 保留：`README.md`「沉浸式编辑器」特性（Typora 风格 Markdown 体验与
    实时字数仍在）、落地页文案与 `globals.css` 的正文排版规则。
- 验证：web 段 `tsc --noEmit` exit 0；模块内部
  `tsc -p apps/plugins/manual/workbench/tsconfig.typecheck.json` exit 0；
  `pnpm --filter @novel/web build` ✓（12.01 s，产物中已无 WriterMode chunk）；
  web vitest **245 例 / 21 文件全过**；隔离门禁
  `verify-workbench-isolation.mjs --with-tests` exit 0（0 违规 / 0 缺失，
  断言 E 基线 245 ≥ 182）。

### 变更（2026-10-08 快捷短语改挂底部面板）

- **新增 kernel 扩展点 `registerBottomPanelSection`
  （`apps/web/src/components/shell/bottomSections.tsx`）**：DockShell 的底部面板
  原先只有一个内容源（`DockShellProps.bottomPanel.children` 的问题清单），
  插件无法再加一栏。新注册表允许插件同时提供
  **细条右侧入口**（`ThinEntry`，收 `{ open, onOpen }`，自行决定计数/图标）与
  **展开区中的一栏**（`Component`，栏目标题由 DockShell 渲染）。
  - 展开区改为 `display:flex` 横向并排：已注册分区按注册顺序在左、调用方内容
    （问题清单）占满剩余宽度，各自独立滚动。
  - 契约要求两个组件**同步可渲染**（禁用 `React.lazy`）：底部面板展开区
    没有任何 Suspense 边界，懒加载挂起会一路上溯到路由级 fallback，
    把整页换成「加载中...」大转圈（见「跳转加载转圈」那轮修复的实测结论）。
  - 本注册表**不按模式隔离**（与 `projectPanels` / `builtinPanels` 不同），
    是否注册由插件自身在 `apply()` 内决定，并用 `ctx.effect` 挂注销。
- **「快捷短语」从漂移气泡改挂为底部面板的一栏**：
  - 删除 `apps/plugins/manual/workbench/web/editor/panels/QuickPhraseBubble.tsx`
    （467 行）。那枚气泡是 `position:fixed` 的**覆盖层**、不在文档流里：
    正文滚到底会被它压住（520px 窄屏实测压住 39px），`EditorPage` 因此要挂一个
    `useLayoutEffect` 反量滚动容器底边、动态改 `paddingBottom` 给它让位。
    改为底部面板一栏后不再覆盖正文、不再需要预留量、不再有漂移动画抢注意力。
  - 新增 `QuickPhrasePanel.tsx`，导出 `QuickPhraseThinEntry`（细条入口，带条数，
    点击请求展开）与 `QuickPhraseSection`（展开区一栏）。数据推导
    （项目短语 + 角色名/别名 + 地点 + 物品，按使用次数取前 12）保持不变。
  - `apps/plugins/manual/workbench/web/index.tsx` 的 `apply()` 注册该分区
    （key `quick-phrase`），用 `ctx.effect` 挂注销。
  - 编辑器实例经 data-core 的 `useEditorStore` 取（底部面板与编辑器不在同一
    React 子树里）。
- **`EditorPage.tsx` 相应瘦身**：删除 `QuickPhraseBubble` / `QP_BUBBLE_CLEARANCE`
  import、`qpReserve` state、整段预留量的 `useLayoutEffect`（含 `ResizeObserver`），
  滚动容器的 `paddingBottom` 回到定值 `clamp(20px, 4vh, 32px)`。
- **清理**：`globals.css` 里只服务那枚水珠气泡的 `.nm-qp-blob-drift` /
  `.nm-qp-blob-morph` / `.nm-qp-edge-wave` 及 `nm-qp-*` 四个关键帧与
  `prefers-reduced-motion` 兜底一并删除（保留无关的 `nm-qbubble*` ——
  AI 浮窗功能气泡栏仍在用）。`dock-theme.css` 补齐 `.dock-bottom-entry-*` 与
  `.dock-qp-*` 样式。
- **验证**：web 段 `tsc --noEmit` exit 0；`pnpm --filter @novel/web build` ✓
  （11.56 s）；`pnpm -r lint` 0 error；隔离门禁
  `verify-workbench-isolation.mjs --with-tests` exit 0（0 违规 / 0 缺失，
  断言 E 基线：type-check 0、test 0、**用例数 245** ≥ 182）；
  `verify-plugin-mode-separation.mjs` 全过。

### 修复（2026-10-08 AI 设置面板回归 kernel）

- **修掉「设置 → AI 设置」整页空白**：该分类下只有 `PluginSettingsSections`
  （无注册项时空集 `return null`），而全仓**没有任何** `category:'ai'` 注册 ——
  D5 裁决把 `AIConfigPanel` / `LocalModelPanel` 划给 `auto` 模块，kernel 侧那一半
  做了（`SettingsPage` 改为注册表渲染），但目的地没建：auto 的 web 入口
  （`apps/plugins/auto/workbench/web/index.tsx`）是**有意为之的空实现**
  （实现已随 t10 移出本仓）⇒ 点进去没有任何可渲染内容。
  更硬的一条：`apps/desktop/src/env.ts:55-62` 把 `AI_PROVIDER` / `OPENAI_` /
  `OLLAMA_` / `CUSTOM_AI_` / `AI_SSRF_` 冻结为**不注入**，意即提供商
  **只能**在应用内配置 —— 入口不存在，便携版就完全配不了 AI。
  故按用户裁决**回归 kernel 全模式可用**（手写台也能配），与 D5 原裁决相反。
- **新增 `apps/web/src/components/settings/AIConfigPanel.tsx`**（两段卡片）：
  「模型提供商」= 提供商切换（openai / ollama / custom，带预设 baseUrl 提示）、
  baseUrl、API Key（回显服务端脱敏提示 `***xxxx`；清除走二次确认态 + 撤消）、
  模型（`<datalist>` 可选可手填）、**测试连接**、**拉取模型列表**；
  「生成参数」= temperature / top_p / 频率惩罚 / 存在惩罚（范围与后端 zod 一致，
  留空 = 不干预，不是 0）。
  - **关键交互**：「测试连接」「拉取列表」打的都是**服务端已保存**的配置
    （`ai.ts:1922-1935` / `ai.ts:2024-2044`），故表单有未保存改动时会先落库
    再请求，按钮文案随之变为「保存并测试连接」—— 否则测的是旧配置、结果会骗人。
  - 来源非 `user_db`（`server_env` / `builtin_relay`）或未配置密钥时给出黄条，
    否则用户会以为「我配的怎么没生效」。
- **新增 `apps/web/src/services/api/aiConfigService.ts`**（数据层，纯函数 + 四个端点）：
  三态语义在此收口 —— `baseUrl`/`model` 恒提交（空串 = 清空并回落服务端默认）、
  `apiKey` 仅在非空时提交且与 `clearApiKey` 互斥、采样参数「输入非空 → number /
  输入空且服务端原本有值 → `null`（显式恢复默认）/ 输入空且原本无值 → 省略」。
  端点与超时：`GET /ai/config`、`POST /ai/config`（20 s）、
  `POST /ai/config/test`（60 s，会真发一次 chat）、`GET /ai/models`（30 s，
  该端点**响应体没有 `data` 键** ⇒ 不脱壳、整体返回 `{ok,models|error}`）。
  全部 `silent:true`，错误在面板内联展示。
- **目录归属（隔离门禁教训，勿回退）**：服务一度放在
  `apps/web/src/services/ai/aiConfigService.ts`，被隔离门禁同时判为
  **K2A**（kernel→auto 跨域 import）与 **B-ENTRY**（kernel 深引模块内部路径）——
  因为契约 §5 把 `@/services/ai/**` 冻结为 **auto 域飞地**
  （`docs/architecture/web-workbench-split-contract.md:18,185`、`:202` t5 行；
  `verify-workbench-isolation.mjs:167` 的 `DOMAIN_BY_PATH` 同口径）。
  kernel 侧**不要**占该前缀；本服务是 kernel 自有，与 `authApi.ts` 同放
  `services/api/`（该前缀在 `DOMAIN_BY_PATH:162` 明列为 kernel）。
- **验证**：web 段 `tsc --noEmit` exit 0；`pnpm --filter @novel/web test`
  **22 文件 / 276 用例全过**（新增数据层 27 用例 + 面板挂载 4 用例）；
  `pnpm --filter @novel/web build` ✓（8.79 s）；`pnpm -r lint` 0 error
  （3 个 server warning 为既有）；隔离门禁
  `verify-workbench-isolation.mjs --with-tests` exit 0（**A=0 / A'=0 / B=0 / C=0、
  0 违规 / 0 缺失**，断言 E 基线：type-check 0、test 0、**用例数 276** ≥ 182）；
  `verify-plugin-mode-separation.mjs` 全过。
  - 断言 E 的 L2 曾拦下新测试的两处 TS 错（`getAllByRole(...)[0]` 是
    `HTMLElement | undefined` → TS2345；`mock.calls[0]` 解构 → TS2488，
    均为 `noUncheckedIndexedAccess` 所致），补 `!` 后归零 —— 单跑 vitest
    **不会**暴露这两处，故改测试后必须跑门禁或 `type-check`。
  - 面板新增 `apps/web/src/components/settings/AIConfigPanel.test.tsx`（4 用例）：
    挂载即读配置并回填且不误报脏态、改动 → 脏态与「保存并测试连接」文案、
    点保存发出的**完整请求体**（`{provider,baseUrl,model}`，密钥不出现在体里、
    无基线时不发采样字段）、读取失败 → 错误态 → 「重试」恢复。
    补这层是因为数据层单测只证明「纯函数算得对」，而**「设置页 → AI 设置」这条链
    是否真能渲染出东西**才是本次要修的缺陷形态。

### 修复（2026-10-09 桌面端代理透传 + CI 门禁复活）

- **桌面端从不使用宿主代理（已修，见 ADR D6.3）**：用户实测
  「设置 → AI 设置 → 测试连接」报 `连接被重置：目标服务强制断开了连接
  （未配置代理，可能被防火墙拦截…）`，而本机 Clash 正在 `127.0.0.1:7897` 监听。
  根因是 `apps/server/src/lib/proxy-agent.ts` 的 `initProxy()` 把
  `DISABLE_PROXY_DETECT === '1'` 的**早退放在读环境变量之前** ⇒ 桌面端
  （D6 契约恒注入该变量）即使继承了 `HTTPS_PROXY` 也会被整段丢弃，
  **所有出站 AI 请求走直连**：「禁用自动探测」被误实现成了「禁用代理」。
  - 改为三档优先级（冻结）：① 环境变量 → ② 自动探测（`DISABLE_PROXY_DETECT`
    只关这一档，桌面端恒跳过）→ ③ 直连。
  - 宿主代理两条来源（`apps/desktop/src/main.ts` 新增 `resolveHostProxy()`，
    在 `startServer()` 前 `await`）：宿主已有 `HTTPS_PROXY`/`HTTP_PROXY` ⇒
    子进程直接继承；否则 `session.defaultSession.resolveProxy()` 解析系统代理，
    经新增纯函数 `parseChromiumProxy()`（`apps/desktop/src/env.ts`，接受
    `PROXY`/`HTTP`/`HTTPS` 前缀，`SOCKS*`/`DIRECT` 跳过）注入
    `HTTPS_PROXY`/`HTTP_PROXY`，并补默认 `NO_PROXY=localhost,127.0.0.1,::1`
    （不覆盖宿主已有值）。解析不到不阻断启动。
  - 实测（`win-unpacked` + 新建 `--user-data-dir`，逐字来自日志）：
    宿主有代理变量时 `logs/main.log` 记「宿主已有代理环境变量…子进程直接继承」；
    宿主无变量时记「已从系统代理解析出可用代理：http://127.0.0.1:7897
    （resolveProxy="PROXY 127.0.0.1:7897"）」；两种场景
    `logs/server.out.log` 均出现
    `[Proxy] 已启用代理(来自环境变量): http://127.0.0.1:7897`。
    端到端把 `baseUrl` 指向 `https://api.openai.com/v1` 后调
    `POST /api/ai/config/test` ⇒ `AI API 错误 403`（请求**已穿过代理抵达上游**，
    403 = 无有效密钥），而不再是网络层失败。
  - 如实记录的残留（与本次改动无关）：内置公益线路
    `https://new-api.dadfafwada.dpdns.org/v1` 在本机不可达 —— 直连 `curl`
    报 `Could not resolve host`，经 Clash 报 `schannel: failed to receive handshake`；
    面板文案已区分「已走代理」与「未配置代理」两种情况。
- **CI 自 2026-10-06 起每次 push 都是红的（已修）**：流水线在 `Setup pnpm`
  就失败，后续 Install / Type check / Lint / Test 全部被跳过（界面是「-」而非「X」），
  因此远端从未真正跑过质量门。两个根因各自暴露过一次：
  - **版本冲突**（`f1d3794`）：workflow 里 `with: version: 11` 与 `package.json` 的
    `packageManager: pnpm@11.8.0+sha512.…` 撞车 ⇒
    `Multiple versions of pnpm specified … ERR_PNPM_BAD_PM_VERSION`。
    删除 workflow 里的版本声明（版本统一由 `packageManager` 决定），
    并把 `actions/checkout` 升到 `@v5`。
  - **平台原生包缺失**（`18a2238`）：`pnpm-workspace.yaml` 的
    `supportedArchitectures.os` 只列 `win32`（本机优化），而它是 pnpm 的
    **安装期**过滤器 ⇒ ubuntu runner 不安装 linux 原生可选包，
    `packages/core` 测试启动即 `Cannot find module @rollup/rollup-linux-x64-gnu`
    （`[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @novel/core@0.2.0 test`）。
    补 `linux` 即可，lockfile 本身是全平台的（无需重新生成）。
  - 随后本次又把 `pnpm/action-setup` 与 `actions/setup-node` 升到 `@v5`
    （运行时 node24），清掉 Node 20 deprecation 告警。
  - 验证：`gh run list` 显示最新 run **✓ 全绿 1m7s**（8 个步骤全过），
    `gh api …/commits/<sha>/check-runs` 返回
    `Type Check / Lint / Test: completed/success`。
- **验证（本地全实跑）**：`pnpm -r type-check` exit 0；
  `pnpm -r lint` exit 0（3 个 server warning 为既有）；
  `pnpm -r test` exit 0（apps/web 23 文件 / 276 用例）；
  `verify-workbench-isolation.mjs --with-tests` exit 0（0 违规 / 0 缺失，
  断言 E 基线：type-check 0、test 0、**用例数 276** ≥ 182）。

### 已知限制

- 桌面端产物**未做代码签名**：首次运行会触发 Windows SmartScreen 提示，
  选择「仍要运行」即可。
- **AI 提供商只能在应用内配置**：`apps/desktop/src/env.ts` 有意冻结
  `AI_PROVIDER` / `OPENAI_` / `OLLAMA_` / `CUSTOM_AI_` 等变量前缀不受理环境变量，
  配置入口是「设置 → AI 设置」（配置落本机 DB）。
- AI 自动写作模块（`novel.autowrite` 引擎与 `novel.auto.workbench` 界面）
  处于剥离态：打开 `mode=auto` 的项目会显示「AI 写作台未安装」占位，
  这是预期行为，不会崩溃或白屏。

## [0.1.0] - 2026-10-01

首个公开版本。

### 新增

- **手写台（manual）**：章节编辑器、角色 / 势力 / 参考书 / 笔记 / 统计 / 大纲 /
  时间线 / 地点 / 伏笔 / 物品 / 关系图 / 地图 / 导出 / 字体排版等面板。
- **AI 能力**：AI 写作辅助、技能注册表、多代理流水线框架、记忆水车。
- **插件基座**：基于 Cordis 的插件宿主，27 个插件按创作模式物理拆分
  （`manual` / `auto` / `shared`）；宿主 `HOST_MODE` 可在启动期裁剪插件集合。
- **数据层**：SQLite（better-sqlite3），项目级独立数据库。
- **认证**：JWT + HttpOnly Cookie（`SameSite=Strict`），前端 JS 不可读。
- **部署**：Docker 多阶段构建；Windows 免安装运行包。

### 变更

- **AI 自动写作模块剥离**：`novel.autowrite`（服务端引擎）与
  `novel.auto.workbench`（AI 写作台界面）的实现已移出仓库，
  仓库内仅保留 7 个骨架文件作为**预留接口（插座）**：
  - `plugin.json` / `package.json` / `tsconfig.json` 逐字节保留原样；
  - `server/index.ts` 为 no-op 挂载点（满足 G1 结构门）。
  - 插拔接线保留：`apps/web/src/plugin/moduleEntries.ts` 的构建期 glob、
    workspace 依赖与 tsconfig paths。
  - 手写台与共享 AI 层不受影响，对剥离模块零编译期依赖。

  装回方式见 `F:\new1.2-detached\ai-autowrite-module\PLUG-BACK.md`
  （整包回填 `workbench/` 与 `novel.autowrite/` → 重启 vite 与 server）。

### 修复

- **CI**：`node-version` 由 20 修正为 24（项目要求 Node ≥ 24；
  better-sqlite3 为原生模块，Node 22 及以下会 `ERR_DLOPEN_FAILED`）。
- **JWT 密钥**：移除源码内公开的固定回退值，改为生产环境强制要求
  `JWT_SECRET`，开发环境使用持久化随机密钥。
- **凭据存储**：不再把密码写入 `localStorage`，仅保存用户名，
  并主动清除历史遗留的加密键。
- 插件门禁支持「受支持缺席」：剥离态下 `auto` 缺席不计违规，
  但 `manual` 缺席仍会致红。

### 已知限制

- AI 自动写作模块处于剥离态：打开 `mode=auto` 的项目会显示
  「AI 写作台未安装 —— 该创作模式对应的模块未启用」（预期行为）。
- `apps/agents`（Python Strands Agents 微服务）为可选组件。
