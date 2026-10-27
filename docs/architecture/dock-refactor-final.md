# 砚舟 停靠系统重构 · 最终架构与单一真源结论

> **状态**：收尾完成（task-2 cleanup-eng）
> **契约真源**：`docs/architecture/dock-protocol-adr.md`（ADR-0007，789 行，P0 冻结）
> **本文档定位**：**结论性**文档 —— 记录重构落地后的最终形态、单一真源的唯一答案、以及可机检的不变量。
> 与 ADR 的分工：ADR 是「决策与冻结契约」（改造前写），本文是「落地结果与验收口径」（改造后写）。
> **两者冲突时以本文记录的实测为准**，并已在 §6 列出与 ADR 的**已知偏差**。

---

## 0. 一句话结论

**砚舟 的面板系统已从「自研绝对定位浮窗引擎 + 功能转轮罗盘气泡」整体迁移到 dockview@8.4.0 停靠系统；主题色收敛为唯一真源 `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css`（117 个 `--vscode-*` token），全仓其他任何文件都不得定义 `--vscode-*`。**

这两条都有**可机检脚本**兜底，不依赖人工审查：

```bash
node scripts/verify/verify-theme-single-source.mjs   # 主题单一真源不变量
```

---

## 1. 主题单一真源（唯一答案）

### 1.1 真源与副本

| 角色 | 路径 | 要求 | 实测 |
|---|---|---|---|
| **唯一真源** | `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css` | 定义全部 token | **117 行定义 / 117 个唯一 token / 零重复** |
| **副本转发层** | `apps/web/src/components/shell/dock/dock-tokens.css` | **0 个定义** | 0 定义，仅 1 行 `@import`，0 字面色值 |

真源结构（只有两个块，两处各声明同一套全量 token）：

```css
/* L35-36 */  :root,
              html.dark { … 117 个 --vscode-* … }        /* L225 结束 */
/* L240-241 */ :root,
              html.dark { … 核心语义位 + 派生位 … }      /* L262 结束 */
```

**为什么必须在 `:root` 与 `html.dark` 上重复声明**（ADR §5.1）：写在 `.some-component { --x: … }` 上时，插件包（`apps/plugins/**`）的组件不在该子树内，**继承不到** ⇒ 插件只能自己硬编码色值，单一真源即告失效。两档都声明，切换 `html.dark` 时全站一次性换值，无需任何组件参与。

### 1.2 token 值形态（冻结，易踩坑）

token 存 **完整颜色值**，不是 `H S% L%` 三元组：

```css
--vscode-editor-foreground: hsl(220 14% 85%);   /* ✅ 正确：自包含 */
/* --background: 0 0% 96%;  +  hsl(var(--background))  ← ❌ 已退役的旧式三元组 */
```

理由（ADR §5.1）：三元组要求**每个消费者**都记得外面包一层 `hsl()`；插件作者极易写成 `background: var(--vscode-editor-background)`，而拿到 `220 13% 18%` 这种裸三元组是**无效值** ⇒ 静默不生效。自包含值可以直接用，也允许 `color-mix()` 派生。

> ⚠️ **遗留例外**：`--ink` / `--ink-light` / `--ink-pale` 三个名字仍是**三元组**形态，因为它们有 187 处既存消费点全部写成 `hsl(var(--ink…))`。详见 §6.1。

### 1.3 `--vscode-*` 定义禁令

**除真源外，仓库内任何文件都不得出现 `--vscode-*` 定义。**

全仓（排除 `node_modules`）实测定义站点只有 3 处：真源 117 行 + `apps/web/dist/assets/` 下两个**构建产物**（`index-jxLsSZrK.css`、`ProjectLayout-CwE2_LDR.css`，各 1 行，由构建从真源内联而来，非手写源文件）。

**关键分类规则**：`var(--vscode-x)` 是**引用**，不是定义。`apps/web/tailwind.config.js` 有 90 处 `var(--vscode-*)`，全部是 Tailwind 映射表的引用值（`editor: 'var(--vscode-editor-background)'`），**0 处定义**。脚本必须把二者分开，否则会对 tailwind 误报 —— 这是本脚本最容易写错的地方，已用「先剥离注释、再迭代剥离 `var(...)` 调用、最后才匹配 `--vscode-x:`」实现，并额外加了**反向探针**（若 tailwind 里 `var(--vscode-*)` 引用数变成 0，会告警，防止「0 定义」被「文件被清空」平凡满足）。

### 1.4 可机检脚本

`scripts/verify/verify-theme-single-source.mjs`（本任务 ③ 交付）

```bash
node scripts/verify/verify-theme-single-source.mjs
# 退出码：0 = 不变量全部成立；1 = 有违规（逐条打印 文件:行）；2 = 契约文件缺失（环境问题）
```

检查项：

| # | 检查 | 失败条件 |
|---|---|---|
| 0 | 两个契约文件存在 | 缺任一 → exit 2 |
| 1a | 真源每个定义都在根选择器内（`:root` / `html.dark` / `html[data-theme=…]`，支持逗号分组） | 有定义落在组件选择器内 |
| 1b | `:root` 与 `html.dark` 两块都有定义 | 任一块为空 |
| 1c | 真源无重复 token 名 | 有重名 |
| 1d | 唯一 token 数 ≥ 117 | 少于基线（缺失）；多于基线 → **告警**（提示同步 ADR §5.3 与本脚本基线常量） |
| 2 | 副本 0 定义 + 含 `@import` 且指向真源 + 0 字面色值 | 任一不成立 |
| 3 | 全仓递归扫描（排除 `node_modules`/`dist`/`build`/`.git`/`.workbuddy`/`coverage`），白名单外 `--vscode-*` 定义数 = 0 | 有白名单外定义（逐条 `文件:行`） |
| 4 | `apps/web/tailwind.config.js` 定义 0 处 + 反向探针（引用数 > 0） | 有定义；或引用数 0（告警） |

**实测输出（exit 0）**：

```
  · 真源：apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css —— 117 行定义 / 117 个唯一 token
  · 副本：apps/web/src/components/shell/dock/dock-tokens.css —— 0 个定义（要求 0），转发 @import：有，字面色值：0 处（要求 0）
  · 全仓扫描：387 个文件，命中 --vscode-* 定义 117 处（白名单内 117 / 白名单外 0）
  · apps/web/tailwind.config.js：90 处 var(--vscode-*) **引用**，0 处定义（引用不算定义 —— 分类规则生效）
✅ 主题单一真源不变量全部成立
```

> **未注册进 `verify-all.mjs`**：`verify-all.mjs` 是既有 CI 门禁（5 步），本脚本不属其中，故**不擅自加入**（加步骤会改变门禁语义）。需要时单独调用，或在 CI 中独立加一条。

### 1.5 副本为什么保留而不是删除

`dock-tokens.css` 的历史：t3 交付 DockShell 时其 inScope 不含 ui-kit，于是按 ADR §5.3 **自足维护了一份 token 副本**。归并时发现副本与真源**并非逐字一致**（真源 104 个、副本 117 个；副本独有 13 个，含 `--vscode-font-*` / `--vscode-menu-*` / `--vscode-tab-unfocused*`）。两者都定义 `:root`，而本文件经 `DockShell.tsx` 在**组件内** import（晚于 `main.tsx` 的真源）⇒ **副本覆盖真源，且副本缺真源的部分变量** ⇒ 这是**真实的静默错色**，不是「待清理的重复」。

修复方式：把副本独有的 13 个定义**上收进真源**，副本退化为纯 `@import` 转发。

保留副本文件的三条理由（已写入该文件头部注释）：
1. 不破坏既有 import 路径（`DockShell.tsx:41` 仍引用它）；
2. 保留一层间接，将来若要拆分 dock 专属 token 有落点；
3. `@import` 幂等，与真源重复加载无副作用。

**CSS 导入顺序（务必知晓）**：`main.tsx:7` 先 import 真源，`:8` 再 import `globals.css`；`DockShell.tsx:41-42` 在组件内 import `dock-tokens.css` / `dock-theme.css`。⇒ **任何后加载文件里的 `--vscode-*` 定义都会压过真源**，这正是本禁令要防的事。

---

## 2. 最终架构

### 2.1 分层

```
apps/web/src/components/shell/
├── ProjectLayout.tsx        462 行  ← 项目路由壳（t4 接线层）
├── DockShell.tsx            633 行  ← 停靠内核（t3）
├── PanelMenu.tsx            129 行  ← 顶栏下拉面板菜单（第三入口）
├── WorkbenchMissing.tsx             ← auto 模式工作台缺席降级占位
├── project-shell.css        357 行  ← 顶栏/状态栏骨架样式
└── dock/
    ├── types.ts             130 行  ← 类型 + resolveDockMeta（缺省真源，纯函数，不 import dockview）
    ├── layout.ts            184 行  ← 槽位→dockview Direction/Position 映射 + 布局装配（纯函数）
    ├── DockPanelContent.tsx 133 行  ← 通用面板渲染器 + 面板级 ErrorBoundary
    ├── CenterGraphPanel.tsx  92 行  ← 中心槽画布面板（@xyflow/react）
    ├── dock-theme.css       527 行  ← .dv-theme-vscode：--dv-* → --vscode-* 映射 + 外壳骨架
    ├── dock-tokens.css       28 行  ← 纯 @import 转发（§1.5）
    └── DockShell.smoke.test.tsx     ← 内核冒烟测试（jsdom，补 ResizeObserver/matchMedia）
```

外部协作方：

| 文件 | 职责 |
|---|---|
| `apps/web/src/stores/panelOpenStore.ts`（262 行） | 面板「打开/聚焦/关闭」唯一状态真源 + `getPanelNavigation()` 命令单例 + 视图桥（`registerPanelViewOpener` / `registerPanelViewSync`） |
| `apps/web/src/plugin/registry.ts` | 面板/工作台注册表 + `filterByProjectMode` |
| `apps/web/src/plugin/host.ts` | 插件 ctx 扩展点（`registerProjectPanel` / `registerBuiltinPanel` / `registerWorkbench`） |
| `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css` | **主题唯一真源**（§1） |
| `apps/plugins/manual/workbench/web/panels.tsx` | 12 个内置面板定义（**零改动**，向后兼容） |

### 2.2 数据流

```
插件模块 (apps/plugins/**)
   │  ctx.registerProjectPanel(def) / registerBuiltinPanel(def)
   ▼
pluginRegistry.projectPanels / builtinPanels
   │
   ▼  ProjectLayout §3.4 候选池合成：builtinPanels ∪ projectPanels，按 key 去重（前者优先）
candidatePanels ──► filterByProjectMode(candidatePanels, projectMode) ──► floatingPanels
   │
   ├──► <PanelMenu panels={floatingPanels} />         （顶栏下拉菜单）
   └──► <DockShell panels={allShellPanels} … />       （整池透传，槽位由内核分桶）
             │
             │  resolveDockMeta(def).slot → left/right/bottom/center
             ▼
        dockview (DockviewReact)  ← 布局/拖拽/悬浮/标签堆叠/Splitter 全部由它承担
             │
             ▼  视图事件回写
        onOpenChange(keys) / onActiveChange(key)
             │
             ▼
        usePanelOpenStore  ←→  getPanelNavigation()  ←── nm:open-panel 事件（4 个前端派发点 + AI 模板）
```

**关键设计点：宿主不做槽位分流。** `ProjectLayout` 把整池传给 `DockShell`，槽位判定**唯一**由 `resolveDockMeta(def).slot` 在内核内完成（ADR §1.5「缺省行为的单一真源」）。宿主若也写一份 `?? 'right'` 兜底，两处口径会逐渐漂移 —— 这是被显式禁止的。

### 2.3 缺省真源

`apps/web/src/components/shell/dock/types.ts` 的 `resolveDockMeta(def)` 是**唯一**缺省来源：

```ts
DOCK_META_DEFAULTS = {
  slot: 'right', defaultOpen: false, allowMultiple: false,
  closable: true, floatable: true,
  fallbackFloatingSize: { width: 1024, height: 720 },
  minSize: { width: 240, height: 160 },
  center: false,
}
```

`DockShell`、`ProjectLayout`、`panelNavigation` **一律经它取值**，不得各自写 `?? 默认值`。`types.ts` 刻意不 import dockview / React 运行时，以便在没有 dockview 的环境下也能安全取值（例如 `ProjectLayout` 的 `activeCenterKey` 推导）。

### 2.4 中心槽（可替换插槽）

- 默认占用者 = `centerDefault` = `<Outlet />`（章节编辑器路由出口），由 `ProjectLayout` 注入。
- 声明 `dock: { center: true, slot: 'center' }` 的面板打开时**替换**中心槽（当前唯一：`relationGraph` 关系图）。
- 切换机制：`activeCenterKey` prop（`null` = 交回 `centerDefault`）。内核在 `[activeCenterKey, centerDefault, ready]` 的 effect 里 `addPanel({ position: { direction: 'within', referencePanel: CENTER_DEFAULT_PANEL_ID } })` 或 `setActive()`；置 `null` 时移除全部 `isCenterPanelInstanceId(p.id)` 面板。
- `activeCenterKey` 的推导（F1 修复，在 `ProjectLayout.tsx:217-233`）：优先级 = ① dockview 当前**激活**面板若声明 center ⇒ 用它；② 否则倒序扫描 `openPanelKeys`（打开顺序）取最近打开的 center 面板；③ 否则 `null`。判定口径与内核**完全一致**（只认 `resolveDockMeta(def).center`）。该推导是 hook，**必须位于 `mode === 'auto'` 提前 return 之前**，否则两种模式下 hooks 调用顺序不一致。

### 2.5 三类入口（退役「功能转轮」的替代）

| 入口 | 组件 | 语义 |
|---|---|---|
| **活动栏** | `DockShell` 内 `ActivityBar` | 最左窄条，图标按钮。**由候选池派生**，不硬编码业务面板。点击 = 已开则聚焦、未开则打开（一步） |
| **侧边栏** | `DockShell` 内 `.dock-side-bar` | 停靠区骨架 |
| **面板菜单** | `PanelMenu.tsx` | 顶栏右侧下拉，按 `order` 列出**整个候选池**，点击 = 打开或聚焦。`panels.length === 0` 时返回 `null` |

「气泡」一词在本仓库有三种含义，退役的**只有**「功能转轮」那一种（ADR §0.3）：
- ❌ 功能转轮（罗盘 + 卫星气泡入口，`FloatingBubbles.tsx`）→ **整体退役**，由上面三入口替代；
- ✅ 内置气泡槽（`BuiltinPanelDef` 注册的 `'chapters'` / `'ai-chat'`）→ **保留**，作为扩展点，已更名为 `builtinPanels` / `registerBuiltinPanel`；
- ✅ 面板本身 → 保留。

### 2.6 dockview 接线

```ts
// DockShell.tsx 导出（冻结）
export const VSCODE_DOCK_THEME: DockviewTheme = {
  name: 'vscode-dark-modern',
  className: 'dv-theme-vscode',
  colorScheme: 'dark',
  dndPanelOverlay: 'group',
  dndTabIndicator: 'line',
  dndOverlayBorder: '2px solid var(--vscode-focusBorder)',
  tabGroupIndicator: 'none',
};
```

`--dv-*` **不被覆盖**，而是在 `.dv-theme-vscode` 里**映射**到 `--vscode-*`（`dock-theme.css`，44 个 `--dv-*` 声明，0 字面色值）：

```css
.dv-theme-vscode {
  --dv-group-view-background-color: var(--vscode-editor-background);
  --dv-tabs-and-actions-container-background-color: var(--vscode-tab-inactiveBackground);
  --dv-activegroup-visiblepanel-tab-background-color: var(--vscode-tab-activeBackground);
  …
}
```

> ⚠️ `dockview@8.4.0` **没有** `--dv-background-color`（随包 `styles/dockview.css` 命中 0 次）—— 该版本底色真源是 `--dv-group-view-background-color`。ADR §5.5 表格里那一行**与实装版本不符**，已按脚注授权以实际版本为准。`dock-theme.css` 底部列有「实际使用的 `--dv-*` 变量名清单」（逐名对 8.4.0 实测）。

依赖（`apps/web/package.json`，**精确锁定，非 `^`**）：`dockview@8.4.0`、`dockview-react@8.4.0`（`dockview-core@8.4.0` 为传递依赖）。`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已列入这三个包（新发布版本默认受冷却期限制）。

`DockShell.tsx` 导入：`import 'dockview/dist/styles/dockview.css'` → `import './dock/dock-tokens.css'` → `import './dock/dock-theme.css'`。顺序有意义：dockview 自带样式先加载，映射层后加载才能生效。

### 2.7 八项能力的落位

| # | 能力 | 落位 |
|---|---|---|
| 1 | 多停靠面板，来源外部传入 | `DockShellProps.panels`；`ActivityBar`/`PanelMenu` 均由池派生，内核**不硬编码**业务面板 |
| 2 | 标题栏拖拽 → 悬浮窗口，可拖回 | dockview `floatingGroupDragHandle="titlebar"` + `disableFloatingGroups={false}`；`DockShellApi.floatPanel` 用 `addFloatingGroup(p, {width, height})`；`dockPanel(key, slot)` 用 `p.api.moveTo()` 拖回 |
| 3 | 上下左右四个 dock area + 中心编辑区 | `addPanel({ position: { direction } })`；`slotToDockDirection` 把 `bottom` 映射为 dockview 的 `'below'`（唯一转换点） |
| 4 | 同 group 多面板标签堆叠 | dockview 原生 Tabbed Group；`singleTabMode="fullwidth"`；自定义 `DockTab` 渲染器让 × 受 `dock.closable` 控制（dockview 无内建 per-panel closable） |
| 5 | 拖拽落点预览指示器 | `.dv-theme-vscode .dv-drop-target-selection` 等；落区填充 = `--vscode-panel-dropBackground`，边框 2px `--vscode-focusBorder`，圆角 0 |
| 6 | 中心区可替换插槽 | §2.4；画布类面板经 `CenterGraphPanel`（`@xyflow/react`，D16 无 C++/Qt） |
| 7 | 面板间可拖动 Splitter | dockview sash；`.dv-sash-container .dv-sash`（8.4.0 实测路径）+ `--dv-active-sash-color` |
| 8 | VS Code 式外壳骨架 | `.dock-shell.dv-theme-vscode` → 活动栏 / 侧边栏 / 编辑区 / 辅助侧栏 / 底部面板区 / 状态栏，全部 `aria-label` 标注 |

### 2.8 命令接口

```ts
export interface DockShellApi {
  openPanel(key: string): void;
  closePanel(key: string): void;
  focusPanel(key: string): void;
  listPanels(): string[];
  activePanel(): string | null;
  floatPanel(key: string): void;          // 停靠 → 悬浮
  dockPanel(key: string, slot: DockSlot): void;  // 悬浮 → 停靠
}
```

经 `useImperativeHandle(ref, …)` **与** `useImperativeHandle(props.apiRef ?? null, …)` 双路暴露（两种用法都被支持）。`ProjectLayout` 用 `apiRef` 把 `openPanel` 接到 `registerPanelViewOpener` 回调上。

### 2.9 事件桥（不得删除）

| 事件 | 处置 | 原因 |
|---|---|---|
| `nm:open-panel` | **长期保留**（ADR D6） | `apps/server/src/ai/tools/plugin-tools.ts:189` 的 AI 插件生成模板会**永久**为已落盘插件吐这个字面量；已发布的第三方插件也只发它。监听体已迁移为 `getPanelNavigation().open(key)`，守卫 `var key = (e as CustomEvent<{key}>).detail?.key; if (!key) return;` **逐字保留** |
| `nm:open-settings` | **保留**（ADR D7） | 当前**零派发点**，但是公开契约（`docs/architecture/web-workbench-split.md:896` 有正式记载） |

监听挂在 `ProjectLayout`（而非 `DockShell`）的理由：dockview 初始化是**异步**的，挂在内核里要额外处理 ready 前的窗口期；挂在路由壳上时命令式入口会**静默排队**，DockShell ready 后回放。

`MAX_OPEN_PANELS` **已退役**（ADR D10）：打开第 N 个面板**永不关闭**任何已打开面板，容量交给 dockview 布局承担。

---

## 3. 面板级错误隔离

`PanelErrorBoundary` 位于 `dock/DockPanelContent.tsx`，**包住每个面板的 `def.Component`**：

```tsx
<PanelErrorBoundary label={def.label}>
  <div className="dock-panel-body" data-panel-key={def.key}><Component /></div>
</PanelErrorBoundary>
```

- 单个面板渲染抛错 ⇒ 只有该面板退化为 `.dock-panel-error`（`role="alert"` + 重试按钮），其余面板不受影响。
- 重试经 `setState(s => ({ error: null, attempt: s.attempt + 1 }))` 换 key 强制重挂载。
- 这是旧 `PanelGuard` 的**等价迁移**：旧的浮窗引擎被删除时，隔离能力**必须**随之搬进内核，不得随之消失（ADR §3.4-3）。

应用级致命错误另由 `ProjectLayout` 的根 `ErrorBoundary` + `ShellFatal` 兜底。

---

## 4. 稳定选择器清单（e2e / 自动化可用）

新外壳的 `aria-label` 全部经实测确认**全仓唯一**（`apps/**`，排除 `node_modules`）：

| 选择器 | 位置 | 用途 |
|---|---|---|
| `[aria-label="面板菜单"]` | `PanelMenu.tsx:90` | **「手写台外壳已挂载」的首选门禁**（替代退役的 `[aria-label="功能转轮"]`） |
| `[aria-label="活动栏"]` | `DockShell.tsx:202` | 外壳骨架存在 |
| `[aria-label="侧边栏"]` | `DockShell.tsx:554` | 同上 |
| `[aria-label="编辑区"]` | `DockShell.tsx:562` | 同上 |
| `[aria-label="辅助侧栏"]` | `DockShell.tsx:582` | 同上 |
| `[aria-label="底部面板区"]` | `DockShell.tsx:590` | 同上 |
| `nav[aria-label="活动栏"] button[aria-label="角色"]` | `DockShell.tsx:212`（`aria-label={it.label}` 运行期求值） | 打开某个具体面板。**注意：`[aria-label="角色"]` 单独用不唯一** —— 活动栏按钮与面板标题都可能命中，故必须带 `nav[aria-label="活动栏"]` 前缀 |
| `[data-panel-key="<key>"]` | `DockPanelContent.tsx:107` | **面板本体**（打开状态的权威判据） |
| `[data-dock-slot="center"]` | `DockPanelContent.tsx:129` | 中心槽 |
| `[aria-label="加载中"]` | `ProjectLayout.tsx:72`（`role="status"`） | 面板 Suspense 加载态 |
| `[aria-label="工作台未安装"]` | `WorkbenchMissing.tsx:29` | auto 模式工作台缺席降级 |
| `[aria-label="返回"]` / `"设置"` / `"管理员后台"` / `"登出"` | `ProjectLayout.tsx:374/397/406/423` | 顶栏按钮 |

**已死选择器（不要再用）**：

| 旧选择器 | 现状 |
|---|---|
| `[aria-label="功能转轮"]` / `[aria-label="展开功能转轮"]` / `[aria-label="打开角色面板"]` | 功能转轮已退役 ⇒ 恒 0 命中 |
| `[aria-label="Loading"]` | **全仓（含 `node_modules`）0 命中**，从来就是死选择器；现用 `[aria-label="加载中"]` |
| `[aria-label="状态栏"]` / `"智能体对话"` / `"编辑器标签"]` | 0 命中。AI 写作工作台实现已移出仓外；内核的 `StatusBar` 是 `<footer className="dock-status-bar">`，**无** `aria-label` |

> `e2e` 脚本里的 `AUTO_MARKERS` 保留为**反向探针**（断言「不得出现」）：它们今天结构上恒为 0，不具区分力，但若 AI 工作台实现被误装回，断言会立刻变红（非恒真），故保留。

---

## 5. 验收命令与判据

```bash
# 1) 类型 / 静态检查 / 构建
pnpm --filter @novel/web type-check      # exit 0
pnpm --filter @novel/web lint            # exit 0，0 errors
pnpm --filter @novel/web build           # exit 0

# 2) 既有门禁（5 步：server 单测 / web 单测 / 记忆抽查 / 模式分离 / manifest 合法性）
node scripts/verify/verify-all.mjs       # exit 0

# 3) 插件层模式分离
node scripts/verify/verify-plugin-mode-separation.mjs   # exit 0

# 4) 主题单一真源（本次新增，不属 verify-all 的 5 步）
node scripts/verify/verify-theme-single-source.mjs      # exit 0

# 5) 浏览器级 e2e（需 dev server + 后端 + 开 remote-debugging 的 Chrome）
node scripts/e2e/e2e-mode-separation.mjs # exit 0；1 = 断言失败；2 = 环境不可用
```

构建产物判据（`apps/web/dist/assets/`）：

| 判据 | 期望 | 意义 |
|---|---|---|
| `ProjectLayout-*.js` chunk 含 `dockview` | 命中约 69 次，chunk ~437 kB | **接线真的生效了** —— 未接线时 dockview 会被 tree-shake 掉 |
| 同上含 `dv-theme-vscode` | 命中 2 次 | 主题映射层被打进产物 |
| 构建 CSS 中 `--vscode-editor-background` 定义次数 | **同一 chunk 内不重复，且各 chunk 值一致**（~~恰好 1 次~~ 判据已修正） | 单一真源在产物层面也成立 |
| `shuimo` / `ink-wash` 残留 | 0 | 水墨体系确已退役 |

---

## 6. 与 ADR 的已知偏差（**必须知晓**）

以下三处 ADR 的冻结内容与落地实测**不一致**。处置原则：**不改业务行为、不硬删仍在使用的代码**，保留并在本文记录。

### 6.1 `--ink*` 三兄弟不能删（ADR §6.4 的前提不成立）

ADR §6.4 把 `globals.css` 的 `--ink*` 删除分给 t7，前提是「零引用」。**实测前提不成立**：

| token | 活跃消费点 | 写法 |
|---|---|---|
| `var(--ink)` | **72** | 全部 `hsl(var(--ink))` / `hsl(var(--ink) / 0.65)` 等三元组合成形式 |
| `var(--ink-light)` | **83** | 同上 |
| `var(--ink-pale)` | **32** | 同上 |
| `.glass-ripple-ink` | 5 | `apps/plugins/shared/ui-kit/src/useGlassRipple.ts:40` 动态注入 |

共 **187 处**，绝大多数位于 `apps/plugins/**`、`apps/web/src/pages/**`、`apps/web/src/components/settings/**` —— 都在清理任务的 writeScope **之外**。而真源 `vscode-dark-modern.css` **完全不定义** `--ink*`（grep 为空）⇒ 硬删定义会让这 187 处拿到**无效值**，静默回落为继承色 = 大面积静默视觉回归。

**处置**：`--ink` / `--ink-light` / `--ink-pale` 的**亮档 + 暗档定义全部保留**（`globals.css:161-163` 与 `:374-376`），并在定义上方写明：

- 三个名字与 VS Code 前景三级的等价映射：`--ink` ≈ `--vscode-editor-foreground`(L41 `hsl(220 14% 85%)`)、`--ink-light` ≈ `--vscode-panel-foreground`(L74)、`--ink-pale` ≈ `--vscode-input-placeholderForeground`(L152)；
- 187 处活跃消费点计数；
- 删除条件 = 全部消费点改为引用 `--vscode-*` 之后；
- 值仍须是 **HSL 三元组**（勿改成整色值，否则 `hsl(var(--ink))` 失效）。

另有 **既存**悬挂引用（从未定义、非本次引入）：`--ink-deep`（13 处）、`--ink-soft`（5 处）—— 位于 `apps/plugins/manual/workbench/web/editor/panels/QuickPhraseBubble.tsx`、`apps/plugins/shared/ui-kit/src/aiBars.tsx`、`apps/web/src/pages/AdminPage.tsx`。它们是**重构前就坏**的引用，修不修都不改变本次范围，此处仅记录。

### 6.2 `nm-*` 例外删除清单每一条都不成立（ADR §6.5）

ADR §6.5 的「可删」例外清单经逐条 grep 实测，**除两个本身没有对应选择器的名字外，全部与事实矛盾**：

| 类名 | ADR 判定 | 实测 |
|---|---|---|
| `.nm-ink-back` / `.nm-ink-lift` / `.nm-ink-divider` / `.nm-ink-title` | 可删 | 全仓 0 引用 ✅ —— 但 `globals.css` 里**根本不存在这些选择器**，无可删 |
| `.nm-brush` | （同类） | 0 引用，同样无对应选择器 |
| `.nm-no-brush` | 可删 | **活跃**：`apps/plugins/shared/ui-kit/src/aiBars.tsx:415,518` |
| `.nm-logo-seal` | 可删 | **活跃**：`apps/web/src/pages/LoginPage.tsx:106`、`apps/web/src/pages/RegisterPage.tsx:216`（定义 `globals.css:1415,1436`） |
| `.nm-qbubble` / `.nm-qbubble-text` | 可删 | **活跃**：`apps/plugins/shared/ui-kit/src/aiBars.tsx:138,154`（定义 `globals.css:1964,1983,1987,1994,2004,2012,2016`） |
| `.nm-qp-*` | 可删 | **活跃**：`apps/plugins/manual/workbench/web/editor/panels/QuickPhraseBubble.tsx:406,409,413,453`（定义 `globals.css:2026-2073`） |
| `.glass-ripple-ink` | 未列 | **活跃**：`useGlassRipple.ts:40`；容器 `.glass-ripple` 被 `BookCard.tsx:93`、`BookshelfPage.tsx:349`、`BottomDrawer.tsx:135` 使用 ⇒ **必须保留** |

⇒ **结论：无任何选择器/类删除是正当的。** 本次**未删除任何 `nm-*` 类或选择器**。ADR §6.5 的主体决策（保留类名、只换值、不重命名）仍然正确并被遵守。

### 6.3 `--cover-ink` 明确保留（ADR §6.4 把它列在移除行里）

`--cover-ink: #1c1c1c`（`globals.css:72`）是**封面专用**色，与水墨主题体系**不同源**（书封渲染需要固定深墨，不随主题明暗翻转）。任务书亦明确要求保留。**已保留**，连同 `globals.css:63`（`color-mix(in srgb, var(--cover-ink) P%, var(--cover-paper))` 注释）与 `:88`（`fill={ink}` 注释）。

### 6.4 「墨韵工艺层」术语刻意保留

`globals.css` 的「墨韵工艺层 · Ink Craft Layer」小节标题**保留未改**，因为它是**跨文件活跃术语**，改名会造成文档/代码漂移：

- `apps/plugins/shared/ui-kit/src/primitives/index.ts:7`、`primitives/utils.ts:4`（注释指向 globals.css 该节）
- `apps/web/tailwind.config.js:124,245,343,352,358`
- `docs/design/design-system.md:5,159,165`

且该节承载的 `--paper*` / `--tone*` / `--radius*` / `--shadow*` / `--ease-*` / `--sig*` 等 token **不在** ADR §6.4 移除清单内（§6.5 明确要求保留这些 `nm-*` 类、只换值）。

---

## 7. 本次清理实际做了什么

### 7.1 水墨语义清理（`globals.css` + `landing.css`，**仅注释与措辞**）

| 位置 | 改动 |
|---|---|
| `globals.css:148-160` | 新增 13 行说明块（§6.1 内容）；行尾注释 `焦墨/淡墨/清墨` → `前景·主/前景·次/前景·弱` |
| `globals.css:372-373` | 暗色档上方新增 2 行说明（语义指向 :root 同名注释；两档必须分开声明） |
| `globals.css:239` | `黑白水墨主题` → `黑白灰主题` |
| `globals.css:256` | `移植到水墨体系上` → `移植到本设计体系上` |
| `globals.css:339` | `明度按水墨调子收紧` → `明度按灰阶调子收紧` |
| `globals.css:351` | `暗色模式（夜墨：纸转入夜，墨转为亮）` → `暗色模式（html.dark：底转深，前景转亮）` |
| `globals.css:378` | `夜墨质感：…` → `暗色质感：…` |
| `globals.css:1429` | `Logo 印章 — 山青渐变圆 + 水墨笔触感` → `Logo 印章 — 圆形渐变底（--mountain-* 已是灰阶，色相恒 0）` |
| `globals.css:2094-2095` | `水墨质感层` / `随水墨体系整体退役` → `质感层` / `随旧主题体系整体退役` |
| `globals.css:2290` | `只用墨线…与水墨基调一致` → `只用中性描边…与 VS Code Dark Modern 的克制基调一致` |
| `landing.css:2-12` | 整段注释重写：`水墨化` → `灰阶化`；删除「松烟」「水墨UI」主题名；`--ink` 描述改为「前景色遗留别名」并加 187 处消费点警示 |

清理后 `globals.css` + `landing.css` 内 `水墨|夜墨|墨韵` 仅剩 7 行，全部是刻意保留的「墨韵工艺层」术语（§6.4）与我新写的说明注释。

### 7.2 过期 e2e 断言修正（两个脚本）

| 文件 | 改动 |
|---|---|
| `scripts/e2e/e2e-mode-separation.mjs` | `MANUAL_MARKERS` → `{ '面板菜单': '[aria-label="面板菜单"]', '活动栏': '[aria-label="活动栏"]' }`；manual 门禁改等 `[aria-label="面板菜单"]`；两处 check 文案改写；失败定位提示更新 |
| `scripts/e2e/e2e-core-flows.mjs` | 同上；另将「展开功能转轮 → 点角色气泡」两步改为**一步活动栏点击** `nav[aria-label="活动栏"] button[aria-label="角色"]`；面板本体查找 `[aria-label="角色"]` → `[data-panel-key="characters"]`；加载态 `[aria-label="Loading"]` → `[aria-label="加载中"]` |

两文件 `node --check` 均 exit 0；残留的非注释过期选择器 = 0 行。

### 7.3 ⑤ `apps/web/src/stores/themeStore.ts` 复核结论：**保留**

该文件仅 3 行（`export * from '@novel-plugins/ui-kit/themeStore';` + 两行说明注释）。**不可删除**，因为仍有 **2 个活跃 in-app 导入方**：

- `apps/web/src/components/settings/AppearancePanel.tsx:13` — `import { THEMES, useThemeStore, type ColorMode } from '@/stores/themeStore';`
- `apps/web/src/main.tsx:10` — `import { applyStoredTheme } from './stores/themeStore';`

真实现位于 `apps/plugins/shared/ui-kit/src/themeStore.ts`（**禁改区**，`apps/plugins/shared/ui-kit/` 不在本任务 writeScope 内）。删除条件：上述两个导入方改为直接从 ui-kit 导入后。

---

## 8. 未做 / 明确不做

- **不引入 C++ / Qt / CMake / QGraphicsView**（ADR D16）：画布类需求一律用既有的 `@xyflow/react` 承载。
- **未删除 `docs/reports/**`**：历史评审报告一律留档。
- **未修改** `apps/plugins/shared/ui-kit/**`、`apps/web/src/components/shell/**`、`apps/web/src/plugin/**`（分别为真源、内核、宿主范围，不属本任务 writeScope）。
- **未执行任何 `git checkout` / `git restore` / `git stash` / `git clean`**：工作区含大量**未提交**的重构产物（`DockShell.tsx`、`PanelMenu.tsx`、`dock/`、`project-shell.css`、ADR 文档等），这些命令会**永久销毁**它们 —— 本重构早期正是这样丢失过 `ProjectLayout.tsx`。
- **未把 `verify-theme-single-source.mjs` 注册进 `verify-all.mjs`**：后者是既有 5 步门禁，加步骤会改变其语义。

---

## 9. 相关文档

| 文档 | 关系 |
|---|---|
| `docs/architecture/dock-protocol-adr.md` | **契约真源**（决策与冻结契约，改造前写）。本文记录落地结果，冲突处以本文 §6 为准 |
| `docs/architecture/web-workbench-split.md` | 三层拆分契约（`nm:open-settings` 的正式记载见其 :896） |
| `docs/architecture/plugin-architecture.md` | 插件体系与扩展点 |
| `docs/design/design-system.md` | 设计体系（含「墨韵工艺层」小节） |
| `docs/reports/web-split-runtime-verification.md` | 运行时验证报告（历史） |

---

## 10. 收尾独立复核记录（t1 · 2026-10-02）

本节由 **t1（closeout-eng）** 在**只读校验**本文档后追加。**未重写本文任何结论**，仅：① 记录本轮**实测 exit code**；② 修正 §4 中 4 处**过期行号**；③ 记录对本文关键数据的**独立复测**结果。

### 10.1 验收命令实测 exit code

在仓库根 `F:\new1.2` 实测（`cmd /c` 调用，原始退出码，未经包装）：

| # | 命令 | exit | 耗时 | 备注 |
|---|---|---|---|---|
| 1 | `pnpm --filter @novel/web type-check` | **0** | 10.8 s | `tsc --noEmit` 无输出 |
| 2 | `pnpm --filter @novel/web lint` | **0** | 6.8 s | `eslint src/`：**0 errors / 1 warning** —— `DockShell.tsx:360` Unused eslint-disable directive（**既存**，按裁定不改，仅记录） |
| 3 | `pnpm --filter @novel/web build` | **0** | 11.5 s | `✓ built in 9.97s` |
| 4 | `pnpm --filter @novel/web test` | **0** | 8.2 s | **12 files / 149 passed**，含 `DockShell.smoke.test.tsx` 17 用例 |
| 5 | `node scripts/verify/verify-theme-single-source.mjs` | **0** | 0.2 s | `✅ 主题单一真源不变量全部成立` |
| 6 | `node scripts/verify/verify-all.mjs` | **0** | 20.3 s | 5 步全过（server 单测 / web 单测 / 记忆抽查 / 模式分离 / manifest 合法性） |
| 7 | `node scripts/verify/verify-plugin-mode-separation.mjs` | **0** | 8.8 s | `✅ verify-plugin-mode-separation 全过` |

**7/7 全绿**，与 §5 的判据一致。原始输出留档：`%TEMP%\t1-verify-log.txt`（非仓库内，避免污染工作区）。

### 10.2 §4 过期行号修正

本文档写定于 `DockShell.tsx` 的**修复前**修订（文档 11:43:53 落盘，内核 11:32:21 修改），故 §4 表内 4 处行号已漂移。**已就地修正**：

| 选择器 | 原记 | 实测（当前修订） |
|---|---|---|
| `[aria-label="侧边栏"]` | `:522` | **`:554`** |
| `[aria-label="编辑区"]` | `:530` | **`:562`** |
| `[aria-label="辅助侧栏"]` | `:550` | **`:582`** |
| `[aria-label="底部面板区"]` | `:558` | **`:590`** |

其余选择器行号（`PanelMenu.tsx:90`、`DockShell.tsx:202/212`、`DockPanelContent.tsx:107/129`、`ProjectLayout.tsx:72`、`WorkbenchMissing.tsx:29`）**实测全部仍然正确**。

> 教训：**行号是易腐证据**。选择器本身（`aria-label` 字面量）才是稳定契约，行号仅供定位。后续引用请优先以「文件 + aria-label 字面量」为准。

### 10.3 关键数据的独立复测

以下均由 t1 用独立脚本重测（排除 `node_modules`/`dist`/`build`/`.git`/`.workbuddy`/`coverage`），结论与本文一致：

| 本文结论 | 复测结果 | 判定 |
|---|---|---|
| 真源 117 行定义 / 117 唯一 token / 零重复 | 定义行 **117**、唯一 token **117** | ✅ 一致 |
| 副本 `dock-tokens.css` 0 定义、纯 `@import` | 28 行，**1 行 `@import`**，0 定义、0 字面色值 | ✅ 一致 |
| `--ink` / `--ink-light` / `--ink-pale` 共 **187** 处活跃消费点 | 代码文件内 `var()` 引用原样计数 = **187**（72 / 83 / 32） | ✅ 总数一致（见下注） |
| 消费者分布在 `apps/plugins/**`、`pages/**`、`components/settings/**` | 逐目录计数确认，另含 `apps/web/src/styles/globals.css` 与 `landing.css` | ✅ 一致 |
| `--ink-deep` 13 处 / `--ink-soft` 5 处悬挂引用 | `--ink-deep` **13**、`--ink-soft` **5**（代码文件） | ✅ 一致（原记 14 属笔误，已更正） |
| 构建产物：`ProjectLayout-*.js` 含 `dockview` 约 69 次 | **69** 次，chunk **437.53 kB** | ✅ 一致 |
| 同上含 `dv-theme-vscode` 2 次 | **2** 次 | ✅ 一致 |
| 构建 CSS 中 `--vscode-editor-background` **定义**恰好 1 次 | `index-jxLsSZrK.css` **1** 次、`ProjectLayout-CwE2_LDR.css` **1** 次（**每产物各 1**，非全产物合计 1） | ✅ 一致（原文「恰好 1 次」应按**单产物**理解） |
| `shuimo` / `ink-wash` 残留 0 | **0 / 0**（全 `dist` 递归） | ✅ 一致 |
| `globals.css` + `landing.css` 内 `水墨\|夜墨\|墨韵` 仅剩 7 行 | `globals.css` **7 行**、`landing.css` **0 行** ⇒ 合计 **7 行** | ✅ 一致 |
| `dock/` 各文件行数（§2.1） | 130 / 184 / 133 / 92 / 527 / 28 —— **逐一相符** | ✅ 一致 |
| 外壳 `aria-label` 在 `apps/**` 全仓唯一 | 7 个外壳标签各 **1** 命中；`功能转轮`/`Loading`/`状态栏`/`角色` 各 **0** 命中 | ✅ 一致 |

**注（口径差异，非缺陷）**：本文的 187 / 13 / 5 是**原样 grep 计数**（含注释与文档字符串中的出现）。t1 另做了**剥离注释后**的严格计数，得 `--ink` 69 / `--ink-light` 82 / `--ink-pale` 31 = **182**，`--ink-deep` 13 / `--ink-soft` 5。

两个口径的**结论完全一致**：消费点数量级为「百级且全部活跃」，远超「零引用」；真源确实不定义 `--ink*` ⇒ **§6.1 的裁定（保留定义）在任一计数口径下都成立**。原文取原样计数是**更保守**的方向（宁可多算），故**不修改** §6.1 的 187 这一数字，仅在此登记口径。

**口径可复现化（captain 补充）**：上述三个口径已固化为可复现脚本 `scripts/verify/measure-ink-consumers.mjs`（**测量工具，非门禁，退出码恒为 0**），一次输出三列：`A_raw`（原样计数，含块注释）/ `B_code`（剥离块注释的真实代码消费点）/ `C_bare`（裸 token 名，含注释说明行）。现测 `A_raw` = `--ink` **72** / `--ink-light` **83** / `--ink-pale` **32** = **187**；`B_code` = 69 / 82 / 31 = **182**；`C_bare` = 73 / 84 / 33 = **190**。**§6.1 采用的 187 即 `A_raw`，拆分应为 72 / 83 / 32**（本文原记 `--ink` 73 / `--ink-pale` 31，是把 `C_bare` 的一列混入了 `A_raw` 的拆分，已更正）。`--ink-deep` 在三个口径下**一致为 13**，故原记 14 属纯笔误。

### 10.4 本轮未做的事

- **未重写本文档任何既有结论**（仅 §4 行号修正 + 本 §10 追加）。
- **未改动任何业务代码**：`apps/plugins/shared/ui-kit/**`、`apps/web/src/components/shell/**`、`apps/web/src/plugin/**` 一字未动。
- **未执行任何 `git checkout` / `git restore` / `git stash` / `git clean`**；未新建 commit。
- **未删除任何文件**（含 `docs/reports/**` 历史报告）。
- `--ink*` 三个定义、`--cover-ink`、`.glass-ripple-ink` **均保持在场**，仅注释为水墨语义清理版本 —— 与 §6.1 / §6.3 裁定一致。
- **未在 ADR 内加偏离标注**：ADR（`dock-protocol-adr.md`）属 **t2** 的 writeScope（F-4 / F-6），本轮为 t1，**未越界修改**。ADR §6.4 / §6.5 的失真标注待 t2 完成。