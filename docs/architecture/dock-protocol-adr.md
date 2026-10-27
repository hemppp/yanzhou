# ADR-0007 · DOCK 协议与 VS Code Dark Modern 主题契约（P0 契约冻结）

- 状态：**已冻结（Frozen）**
- 日期：2026-09-29
- 决策者：architect（P0 任务 t1）
- 范围声明：本 ADR **只定义契约**，不修改 `apps/` / `packages/` 下任何代码。
- 下游消费者：t2（theme-eng）、t3（dock-eng）、t4（host-eng）、t5（plugin-eng）、t6/t9/t10（reviewer）、t7（cleanup-eng）、t8（verifier）

> **本 ADR 的冻结强度**
> §1–§5 中标注为「**冻结**」的字段名、API 签名、CSS 变量名，实现任务**不得改写**。
> 若实现过程中发现契约本身错误，**必须回到 captain 重新开 P0 修订**，不得由实现任务就地变更 —— 否则 6 个并行任务的接口会各说各话。

---

## 0. 背景与范围

### 0.1 现状（改造起点，均为实测）

| 关注点 | 现状位置 | 现状行为 |
|---|---|---|
| 面板定义 | `apps/web/src/plugin/types.ts:28-50` `FloatingPanelDef`；镜像于 `packages/core/src/plugin-context.ts:263` | `icon/label/key/Component/width/height/order/scope/group/rail/modes` |
| 面板宿主 | `apps/web/src/components/shell/ProjectLayout.tsx`（36 KB）| 自研 `useFloatingPanel` + `FloatingPanelWindow`，绝对定位 + 八向缩放 |
| 面板入口 | `apps/web/src/components/shell/FloatingBubbles.tsx`（命名与 `BuiltinBubbleDef` 无关）| 「罗盘 + 卫星气泡」转轮，`fixed z-50`，悬停展开 |
| 打开状态 | `apps/web/src/stores/panelOpenStore.ts` | `MAX_OPEN_PANELS = 3`；超限按**最近使用（LRU）**收起最久没用过的那个并抛 toast（§4.4 修订，取代超限静默挤掉最早的旧行为） |
| 跨域打开面板 | `window` 事件 `'nm:open-panel'`，`detail.key` | 派发点 5 处（见 §2.1） |
| 跨域打开设置 | `window` 事件 `'nm:open-settings'` | 派发点 0 处（**已死**，见 §2.2） |
| 章节 / AI 对话面板 | `ctx.registerBuiltinBubble` 按 `key` 键控 | `'chapters'` 由 manual 模块注册；`'ai-chat'` **全仓无注册点**（见 §3.2） |
| 主题 | `apps/web/src/styles/globals.css`（:root = ink 档）+ `themes.css` + `shuimo.css`；store 在 `apps/plugins/shared/ui-kit/src/themeStore.ts` | `ThemeId = 'ink' \| 'shuimo' \| 'soot'`，默认 `shuimo`，含 `MIGRATION_KEY` 一次性迁移 |
| 主题应用 | `themeStore.applyTheme` → `documentElement.dataset.theme` + `.dark` | 非默认主题靠 `html[data-theme="..."]` |
| 关系图 | `apps/plugins/manual/workbench/web/knowledge/RelationGraph.tsx` | 已用 `@xyflow/react@^12.10.2`（`apps/web/package.json` 已声明） |

### 0.2 范围外（明确不做）

- ❌ **本重构不引入任何 C++ / Qt / CMake / QGraphicsView。**
  用户原话里的「QGraphicsView」是对**关系图画布能力**的类比，不是技术选型。
  关系图 / 图谱画布**继续以现有 `@xyflow/react` 为实现**（`apps/web/package.json` 已声明 `"@xyflow/react": "^12.10.2"`），
  仅把外层容器从「绝对定位浮窗」换成 dockview 停靠面板。
  验收命令 `git grep -nE "QGraphicsView|QApplication|CMakeLists|#include <Q" -- apps packages` 必须为空。
- ❌ 新增 dockview 之外的依赖（dockview 由 t3 在 `apps/web/package.json` 声明）。

### 0.3 术语消歧（下游必须统一用词）

**「气泡」一词在本仓库有 3 个不同含义，本 ADR 后文一律按下表用词：**

| 词 | 指代 | 现状载体 | 重构后 |
|---|---|---|---|
| **功能转轮** | 罗盘 + 卫星气泡的**面板入口 UI** | `components/shell/FloatingBubbles.tsx` | **退役**，改为活动栏 / 侧边栏 / 面板菜单 |
| **内置气泡槽** | `ctx.registerBuiltinBubble` 注册的**面板定义槽**（`BuiltinBubbleDef`） | `'chapters'` → `LeftSidebar` | **保留扩展点，改名**（§3.3） |
| **面板** | 一个可停靠的 dockview panel | `FloatingPanelDef` | 保留（§1） |

---

## 1. §a · `FloatingPanelDef` 字段契约

### 1.1 既有字段逐一判定

现有字段共 **11** 个（`types.ts:29-50`）。判定如下 —— **`key/label/icon/Component/modes/order/scope/rail` 八个字段全部保留**，无一废弃。

| # | 字段 | 类型（冻结后） | 判定 | 消费者（重构后） | 对现有插件注册代码的影响 |
|---|---|---|---|---|---|
| 1 | `key` | `string` | ✅ **保留，且强化为身份主键** | `DockShell`（panel id）、`panelNavigation.open/focus/close`、`panelOpenStore` | 无影响。世界观的 `'factions'`、手写台 12 个 key 全部继续有效 |
| 2 | `label` | `string` | ✅ **保留** | dockview tab 标题、活动栏 tooltip、`PanelGuard label=` | 无影响 |
| 3 | `icon` | `LucideIcon` | ✅ **保留** | 活动栏图标、dockview tab 前置图标 | 无影响。`PanelSection` 已能画 |
| 4 | `Component` | `React.ComponentType<any>` | ✅ **保留** | `DockShell` 面板内容槽 | 无影响。`<any>` 保持不变，AI 对话经 `ChatPanelControlProps` 透传的既有约定不动 |
| 5 | `modes` | `PluginMode[]` | ✅ **保留** | `filterByProjectMode`（**该函数必须继续存在**）| 无影响 |
| 6 | `order` | `number` | ✅ **保留** | 活动栏 / 侧边栏 / 面板菜单排序 | 无影响 |
| 7 | `scope` | `'workspace' \| 'editor'` | ✅ **保留，语义收窄**（见 1.2） | `ProjectLayout` 面板来源过滤 | ⚠️ 见 1.2 |
| 8 | `rail` | `React.ComponentType` | ✅ **保留，但渲染位置迁移**（见 1.3） | 由 panel content 组件自持 | ⚠️ 见 1.3 |
| 9 | `width` | `number` | 🔶 **降级为「建议值」** | dockview 面板初始宽度 | 无影响（仍可读） |
| 10 | `height` | `number` | 🔶 **降级为「建议值」** | dockview 面板初始高度 | 无影响（仍可读） |
| 11 | `group` | `'live' \| 'data'` | ⚪ **保留但不在本重构消费** | 仅 AI 写作工作台内部分页 | 无影响（`FloatingPanelDef` 的可选字段，非破坏性） |

**关于 9/10（`width`/`height`）→ 「建议值」的精确语义（冻结）：**

> 停靠（docked）状态下，尺寸**由 splitter / dock area 决定**，`width`/`height` 被忽略；
> 仅当面板**作为 floating group** 首次出现时，才作为初始几何的**建议值**；
> dockview 若因视口约束无法满足，**静默夹取**，不报错。
>
> **因此：`width`/`height` 的既有声明（如手写台 12 面板的 `900×800`）无需任何改动，也不会因此报错。**

### 1.2 `scope` 语义收窄（冻结）

```
scope === 'editor'  → 面板归属「编辑器面板栏」，重构后 = dockview 的 **右侧辅助侧栏（auxiliary bar）**
scope 缺省/'workspace' → 面板归属「工作台面板栏」，重构后 = **活动栏 + 左侧主侧栏 + 底部面板区** 三者的候选池
```

- **判定：保留字段，不新增枚举值。** 不引入 `'bottom' | 'right' | 'left'` 这类「位置」枚举。
  **理由**：位置是**用户运行时状态**，不是插件声明 —— 由 `layout.slot` 只给出**初始建议**（§1.5），用户拖拽后以用户状态为准。
- **迁移方案（t4 照做）**：`ProjectLayout` 现有的
  `floatingPanels.filter(p => p.scope !== 'editor')` 一行**原样保留**，只把结果数组喂给 `DockShell` 的候选池。
  `scope === 'editor'` 的面板喂给辅助侧栏槽。`apps/plugins/manual/workbench/web/editor/EditorPanelRail.tsx`
  **不需要改** —— 它只读 `usePanelOpenStore`（§4 后由 `panelNavigation` 兜住）。

### 1.3 `rail` 渲染位置迁移（冻结）

现状：`rail` 组件由浮窗根 div 绝对定位承载（`ProjectLayout.tsx:436`，注释「绝对定位由组件自理」）。

**决策：保留字段，渲染位置改为「panel content 内部自持」。**

- 理由：dockview 面板的根 div 不是插件可预测的定位基准（拖动 / 停靠 / 悬浮三种形态下 DOM 结构不同）。继续依赖外层定位会让 `rail` 在停靠态错位。
- **迁移方案（t5 照做）**：`rail` 的消费者从「宿主渲染」改为「panel content 内部渲染」，即插件在自己的 `Component` 里渲染 `rail`。
  `FloatingPanelDef.rail` 类型**保留不删**（避免破坏第三方插件），但**宿主不再读取它**；t5 需在 output 中说明哪些插件声明了 `rail` 并已内部化。
- **缺省行为**：未声明 `rail` → 无任何渲染（本就如此）。

### 1.4 新增字段（全部为可选，对既有注册代码 100% 向后兼容）

新增字段放在**新的可选嵌套对象 `dock`** 内，**不污染顶层**：

```ts
/**
 * dock 布局元数据（P0 新增，全字段可选）。
 * 未声明 = 宿主按本表「缺省行为」列处理。
 */
export interface FloatingPanelDockMeta {
  /** 初始落位建议（可被用户拖拽覆盖） */
  slot?: 'center' | 'left' | 'right' | 'bottom';
  /** 初始启用状态。false = 注册进候选池但默认不显示 */
  defaultOpen?: boolean;
  /** 同 key 多实例。缺省 false = 再次 open 只聚焦，不新开 */
  allowMultiple?: boolean;
  /** 允许用户关闭（标签上的 ×）。缺省 true */
  closable?: boolean;
  /** 可被拖出为 floating group。缺省 true */
  floatable?: boolean;
  /** 首次作为 floating group 出现时的几何建议值（替代顶层 width/height 的猜测语义） */
  floatingSize?: { width: number; height: number };
  /** 强制最小尺寸（用户拖拽不可突破） */
  minSize?: { width: number; height: number };
  /** 该面板打开时「抢占」中心区：渲染到 center 槽而非普通侧栏槽（详见 §1.6） */
  center?: boolean;
}
```

```ts
export interface FloatingPanelDef {
  // …… §1.1 既有 11 个字段全部保留 ……
  /** ★ P0 新增：dock 布局元数据。缺省 undefined = 全部走缺省行为 */
  dock?: FloatingPanelDockMeta;
}
```

**逐字段：消费者 + 缺省行为（冻结）**

| 新增字段 | 类型 | 消费者（具体文件 / 任务） | 缺省行为（未声明时宿主如何处理） |
|---|---|---|---|
| `dock` | `FloatingPanelDockMeta` | `apps/web/src/components/shell/DockShell.tsx`（t3 读）<br>`apps/web/src/components/shell/ProjectLayout.tsx`（t4 透传）<br>`apps/web/src/stores/panelOpenStore.ts`（t4 重写为 `panelNavigation` 时读） | `undefined` → 等价于 `{}`，即下表全部缺省 |
| `dock.slot` | `'center' \| 'left' \| 'right' \| 'bottom'` | `DockShell` 组装 `DockviewReact` 初始 `layout`（t3） | 缺省 → **`'right'`**（与 §1.2 的 `scope:'editor'` 同落点） |
| `dock.defaultOpen` | `boolean` | `DockShell` 初始化 `panelOpenStore`（t3/t4） | 缺省 → `false`（不自动打开，与现状一致） |
| `dock.allowMultiple` | `boolean` | `panelNavigation.open(key)`（t4） | 缺省 → `false`：`open` 已存在则**只聚焦，不再新增实例** |
| `dock.closable` | `boolean` | `DockShell` → dockview `panel.api.setTitle` / `closable`（t3） | 缺省 → `true` |
| `dock.floatable` | `boolean` | `DockShell` → dockview `floatingGroup` 限制（t3） | 缺省 → `true`（全部面板可拖出悬浮） |
| `dock.floatingSize` | `{width,height}` | `DockShell` 创建 floating group 时（t3） | 缺省 → 依次回落：顶层 `width`/`height` → `1024×720` |
| `dock.minSize` | `{width,height}` | `DockShell` → dockview `minimumWidth/minimumHeight`（t3） | 缺省 → `{width: 240, height: 160}`（VS Code 侧栏量级） |
| `dock.center` | `boolean` | `DockShell` 中心槽路由（t3） | 缺省 → `false` |

> **裁定：`center` 用显式布尔，不用 `slot:'center'` 表达。**
> 二者语义不同：`slot` 是「初始落位建议」（可被用户拖走并被记忆），`center` 是「面板打开时**抢占中心替换槽**且不参与侧栏候选池」。
> 混用一个枚举会让 t3 无法区分「拖到中间的普通面板」与「本质就是中心画布的面板」。

### 1.5 缺省行为的单一真源（冻结）

```
未声明 dock / dock.*  →  宿主按 §1.4 表逐字段取缺省，等价于：
  { slot: 'right', defaultOpen: false, allowMultiple: false, closable: true,
    floatable: true, minSize: {width:240, height:160}, center: false }
```
`DockShell` 内部实现为一个 `resolveDockMeta(def): Required<FloatingPanelDockMeta>` 纯函数，
**这是唯一的缺省真源**；`ProjectLayout` 与 `panelNavigation` 一律经它取值，不得各自写 `?? 默认值`。

### 1.6 三类内容的落位（冻结，t3/t4 必须一致）

| 内容 | 现状 key | `dock.slot` | 说明 |
|---|---|---|---|
| 章节主编辑区 | 路由 `/project/:bookId/:chapterId` | `'center'`（由 **t4 在 ProjectLayout 侧** 作为「中心替换槽」注入，不经 `FloatingPanelDef`） | 中心槽的默认占用者 |
| 关系图 / 图谱等重画布面板 | `'relationGraph'` 等 | 声明 `dock: { center: true, slot: 'center' }` | 打开时替换中心槽 |
| 12 个功能面板 / 势力面板 | 手写台 + 世界观 | 缺省 `'right'` | 进辅助侧栏候选池 |
| 章节列表 / AI 对话（内置气泡槽） | `'chapters'` / `'ai-chat'` | 缺省 `'right'` | 见 §3 |

**中心槽「可替换插槽」的接口（冻结，t3 交付给 t4）：**

```ts
// apps/web/src/components/shell/DockShell.tsx  导出
export interface DockShellProps {
  /** 候选面板定义池（已按当前 project.mode 过滤） */
  panels: FloatingPanelDef[];
  /** 中心区默认内容（章节编辑器路由出口）；被 center panel 抢占时替换 */
  centerDefault: React.ReactNode;
  /** 当前被占用时显示的中心面板 key（null = 用 centerDefault） */
  activeCenterKey: string | null;
  /** 命令式控制句柄（经 ref 暴露，见 §2.3） */
  apiRef?: React.Ref<DockShellApi>;
}
```

---

## 2. §b · 面板打开 / 聚焦 API 与 `nm:open-settings` 迁移

### 2.1 `'nm:open-panel'` 现状（实测，5 个派发点）

| # | 文件 | 行 | 派发的 key | 用途 |
|---|---|---|---|---|
| 1 | `apps/plugins/manual/worldbuilding/src/web/index.tsx` | 25（经由 `openPanel()` 包装） | `'factions'` | 命令面板 / 选区动作 |
| 2 | `apps/plugins/manual/worldbuilding/src/web/faction-highlight.ts` | 102 | `'factions'` | 正文高亮点击 |
| 3 | `apps/plugins/manual/workbench/web/foreshadow/ForeshadowWarning.tsx` | 40 | `'foreshadows'` | 伏笔警告「查看」 |
| 4 | `apps/plugins/manual/workbench/web/editor/extensions/LeadCharacterHighlight.ts` | 53 | （角色/地点类 key）| 正文高亮点击 |
| 5 | `apps/server/src/ai/tools/plugin-tools.ts` | 189 | 动态 `${shortId}` | **AI 生成插件的命令模板**（写入用户插件源码，冻结后不可批量改） |

> ⚠️ **第 5 条是本决策的硬约束**：`apps/server` 生成的插件源码会**永远**派发 `window.dispatchEvent(new CustomEvent('nm:open-panel', …))`。
> 已经生成并落盘的第三方插件也只会发这个事件。**因此 `'nm:open-panel'` 不能被删除。**

### 2.2 `'nm:open-settings'` 现状（实测）

- **监听方**：仅 `ProjectLayout.tsx:605`（→ `navigate(PATHS.settings)`）。
- **派发方**：**全仓 0 处**。`apps/plugins/**` 中搜索 `open-settings` 无任何命中。
- 结论：这是一条**已经死掉的桥**，但它是**约定的公开契约**（`docs/architecture/web-workbench-split.md:217,896` 明确记载「插件包不依赖 react-router-dom，故经此桥导航」）。

### 2.3 决策：新建 **`panelNavigation` 命令式 API**，事件桥降级为**兼容适配层**

**这是本 ADR 唯一"新旧并存"的地方，并存的理由与退出条件都是硬性的。**

#### 2.3.1 新增 API（冻结）

新建 `apps/web/src/stores/panelOpenStore.ts`（**沿用它作为文件位置**，t4 负责重写；不新增文件以免下游路径猜测）：

```ts
// apps/web/src/stores/panelOpenStore.ts  —— 重构后

/** 面板导航句柄（命令式，非 React 组件可直接调用） */
export interface PanelNavigation {
  /** 打开或聚焦面板。allowMultiple=false 时已存在则只聚焦 */
  open(key: string): void;
  /** 已打开则聚焦，未打开则打开（语义等同 open —— 保留旧名仅为对称） */
  focus(key: string): void;
  /** 切换：未打开→打开，已打开→关闭 */
  toggle(key: string): void;
  /** 关闭。不存在则 no-op */
  close(key: string): void;
  /** 关闭全部；opts.except 内的 key 保留 */
  closeAll(opts?: { except?: string[] }): void;
  /** 当前已打开 key（打开顺序，**不再有上限**，见 §4） */
  opened(): string[];
  /** 当前聚焦 key（dockview active panel），无则 null */
  active(): string | null;
}

/** ★ 冻结：命令式单例入口（非 React 环境唯一可用入口） */
export function getPanelNavigation(): PanelNavigation;

/** React 订阅 hook（组件内用这个） */
export function usePanelOpenStore<T>(selector: (s: PanelOpenState) => T): T;
```

**为什么是「命令式单例 + hook」双入口（冻结理由）**：
`nm:open-panel` 的派发方全部是**非 React 上下文**（插件 `apply(ctx)` 的 `run()` 回调、Tiptap 扩展工厂、事件回调）。
只暴露 hook 会让这些调用点被迫引入 `useXxx` 之外的访问路径而再次发明事件。故**必须**有 `getPanelNavigation()`。

#### 2.3.2 `'nm:open-panel'` 迁移方案（t4 照做，逐步精确）

1. **保留** `ProjectLayout.tsx` 中现有的 `addEventListener('nm:open-panel', …)` 监听，**但把回调体从 `openPanel(key)` 改为 `getPanelNavigation().open(key)`**。
2. 监听挂载位置**从 `ProjectLayout` 移到 `DockShell`**（或 `ProjectLayout` 里 DockShell 的父层）—— 因为手写台以外的路由（如书架页）也应能响应。**t4 二选一，但必须在 output 中说明选择**；推荐挂 `DockShell`，其生命周期与 dockview 一致。
3. 回调体保持不变的前置校验：`const key = (e as CustomEvent<{key:string}>).detail?.key; if (!key) return;`
4. **不得**在派发点做任何改动（`apps/plugins/**` 5 个派发点一行不改；`apps/server` 模板一行不改）—— 这是 t5 的验收项之一。
5. **退出条件（写进代码注释）**：当 `apps/server/src/ai/tools/plugin-tools.ts` 的模板改为派发新的 `nm:panel` 事件 **且** 已落盘的第三方插件完成迁移后，才可删除本监听。**本重构不满足该条件，故本监听长期保留。**

#### 2.3.3 `'nm:open-settings'` 迁移方案（t4 照做）

**决策：保留监听，补上文档化的派发约定，但在 `apps/*` 内不新增派发点。**

1. 现有 `window.addEventListener('nm:open-settings', onOpenSettings)` 与 `navigate(PATHS.settings)` **原样保留**。
2. 新增**命名导出**供插件直接调用（替代「必须发事件」的旧约定）：
   ```ts
   // apps/web/src/routes/paths.ts 已有 PATHS.settings —— 不改
   // apps/web/src/stores/panelOpenStore.ts 追加（可选便利函数，t4 决定是否落地）
   export function openSettings(): void; // 内部：navigate(PATHS.settings)
   ```
   > 注：`openSettings()` 是**便利项**，不是验收项。若 t4 认为它迫使 store 依赖 router 而违反分层，**允许不落地**，此时 `'nm:open-settings'` 就是插件触达设置页的唯一路径。
3. **不得**删除 `'nm:open-settings'` 监听 —— 它是已发布插件契约，且 `web-workbench-split.md:896` 有正式记载。

### 2.4 `DockShell` 对外暴露的命令接口（冻结，t3 交付）

```ts
export interface DockShellApi {
  openPanel(key: string): void;
  closePanel(key: string): void;
  focusPanel(key: string): void;
  /** 当前已打开 key 顺序 */
  listPanels(): string[];
  /** 当前聚焦 key */
  activePanel(): string | null;
  /** 把某面板弹为 floating group（用户拖拽的程序化等价物） */
  floatPanel(key: string): void;
  /** 恢复为停靠 */
  dockPanel(key: string, slot: 'left' | 'right' | 'bottom'): void;
}
```

#### 2.4-R1 ★ 2026-10-25 修订：新增分屏方法（4 个）

**动机**：用户口径「标签页可以同时看两个页面」。原 §2.4 的接口面只有
`floatPanel`/`dockPanel`，没有任何「把两个面板并排显示」的能力；且 2026-10-11 的单列化
把全部面板塞进**同一个中心组**、并隐藏了所有 dockview 原生组头，连拖拽抓手都没有。

**追加的契约**（`apps/web/src/components/shell/dock/types.ts`）：

```ts
  splitPanel(key: string, side: 'left' | 'right'): void;  // 拆到左/右新组（两栏并排）
  unsplitPanel(key: string): void;                        // 该面板并回中心组
  unsplitAll(): void;                                     // 所有组并回中心组（一键退出分屏）
  isSplit(): boolean;                                     // 当前是否分屏（组数 > 1）
```

`key` 既接受业务面板 key，也接受基础标签的保留 key（`doc:chapter`）。

**⚠️ 实现铁律（dockview 8.4.0 实测，勿凭直觉改写）**：
**panel 级** `panel.api.moveTo({ position })` **不建组** —— 不传 `group` 时目标组回落为
当前组、`position` 被强制 `'center'`，恒为 no-op。能建组的是 **group 级** `moveTo`
（其内部才调 `addGroup`）。故正确配方是：

```
api.addGroup({ direction, referenceGroup })   // direction 是 Direction 字面量（'below'，非 'bottom'）
  → panel.api.moveTo({ group: newGroup, position: 'center' })
  → 原组若空，dockview 自动回收
```

**视图态而非数据态**：分屏只改「面板摆在哪一栏」，**不改 `openKeys`**（「打开了什么」）。
`emitOpenChange` 另需按受控 `openKeys` 的顺序上报（而非 `dock.panels` 的
「组序 × 组内序」），否则分屏会把 store 的「打开顺序」改写成组序，连带影响标签条顺序
与 localStorage 持久化 —— 见 `DockShell.tsx` `emitOpenChange` 注释。

**UI 入口**（非契约，仅供追溯）：拖拽标签到编辑区左/右边缘（`dock/DocSplitDropZone.tsx`）、
标签右键菜单、分屏态下的「合并分屏」按钮。
`DockShellApi` 与 `PanelNavigation` 是**同一套能力的两层视图**：
`PanelNavigation`（store 层，稳定，插件可见）→ 内部转发到 `DockShellApi`（视图层，dockview 绑定）。
`DockShell` 未挂载时 `getPanelNavigation().open()` **必须静默排队**（不抛错），挂载后回放 —— 否则插件在 `apply(ctx)` 期间调用会崩。

---

## 3. §c · `chapters` / `ai-chat` 两个按 key 取用面板的迁移

### 3.1 现状

```ts
// apps/web/src/components/shell/ProjectLayout.tsx:547-558
var builtinBubbles = usePluginRegistry(s => s.builtinBubbles);
var chapterBubbleDef = useMemo(() => builtinBubbles.find(b => b.key === 'chapters'), [builtinBubbles]);
var chatBubbleDef    = useMemo(() => builtinBubbles.find(b => b.key === 'ai-chat'),  [builtinBubbles]);
var bubblePanels = useMemo(() =>
  [chapterBubbleDef, chatBubbleDef].filter(Boolean).concat(panels.filter(p => p.scope !== 'editor')),
  [chapterBubbleDef, chatBubbleDef, floatingPanels]);
```

**关键事实（实测）**：
- `'chapters'` 注册点：`apps/plugins/manual/workbench/web/index.tsx:35`（`Component: LeftSidebar`，`width:320, height:640`）。✅ 存在。
- `'ai-chat'` 注册点：**全仓 0 处**。`apps/plugins/auto/**` 只有 `server/index.ts`，**没有 `web/index.tsx`**。⇒ 当前 `chatBubbleDef` **恒为 null**，AI 对话气泡**从不渲染**。

### 3.2 决策（冻结）

> **决策 3-A：把两个面板的取用，从「特殊耦合点」降级为「普通面板」。**
> 即：**取消 `ProjectLayout` 里对 `'chapters'` / `'ai-chat'` 的 `key` 硬编码查找**，
> 改由**注册表统一候选池**（`projectPanels ∪ builtinBubbles`）承载，`DockShell` 对二者**无任何特殊分支**。

**为什么可以这样做（不损失任何语义）**：
- 按 key 查找**唯一的作用**是把 `BuiltinBubbleDef` 强转成 `FloatingPanelDef` 塞进候选池（`ProjectLayout.tsx:550,554`）。
- `BuiltinBubbleDef` 的字段集（`types.ts:181-190`：`key/Component/icon/label/width/height/order/modes`）**是 `FloatingPanelDef` 的真子集**（多了 `icon/label/width/height/order` 可选，少了 `scope/rail/group/dock`）。
- 所以**合池后类型天然成立**，`as unknown as FloatingPanelDef` 这种不安全的双断言可以**删掉**。
- 「缺席即不渲染」的优雅降级语义**完全保留**：合池后 `'chapters'` 不在池里就是不渲染，与现状 β 逐字相同。
- ✅ **顺带修复了 `'ai-chat'` 从不渲染的既存缺陷**（若 t5 在 auto 模块补 `web/index.tsx` 注册 `'ai-chat'`，合池后自动生效，无需 ProjectLayout 改动）。

### 3.3 扩展点重命名（冻结，t5 必须照做）

| 现状 | 冻结后 | 理由 |
|---|---|---|
| 类型 `BuiltinBubbleDef` | **`BuiltinPanelDef`** | 「bubble」是退役的 UI 形态词，继续用它命名扩展点会让 t5 误以为要保留气泡 |
| `ctx.registerBuiltinBubble(def)` | **`ctx.registerBuiltinPanel(def)`**（**保留 `registerBuiltinBubble` 作为 deprecated 别名**） | 同上；别名保证已发布插件不炸 |
| `registry.builtinBubbles: BuiltinBubbleDef[]` | **`registry.builtinPanels: BuiltinPanelDef[]`**（移除 `builtinBubbles`） | 内部 state 名，无插件依赖；`_reset()` 同步更名 |
| `_registerBuiltinBubble` | **`_registerBuiltinPanel`** | 内部方法 |

**必须同步改的 1 个调用点**：`apps/plugins/manual/workbench/web/index.tsx:35`
`ctx.registerBuiltinBubble({key:'chapters',…})` → `ctx.registerBuiltinPanel({key:'chapters',…})`。
**合池（3.4）与更名（3.3）必须在同一提交内完成**，否则 `builtinPanels` 为空而 `builtinBubbles` 有值，`'chapters'` 会静默消失。

### 3.4 候选池合成（冻结，t4 照做）

```ts
// ProjectLayout.tsx —— 替换原 547-558 段
const builtinPanels = usePluginRegistry(s => s.builtinPanels);   // 更名后
const allFloatingPanels = usePluginRegistry(s => s.projectPanels);

/** 冻结：候选池 = 内置面板槽 ∪ 插件面板槽，按 key 去重（前者优先，与现状一致） */
const candidatePanels = useMemo<FloatingPanelDef[]>(() => {
  const byKey = new Map<string, FloatingPanelDef>();
  for (const p of builtinPanels) byKey.set(p.key, p as FloatingPanelDef); // 无需 as unknown
  for (const p of allFloatingPanels) if (!byKey.has(p.key)) byKey.set(p.key, p);
  return [...byKey.values()];
}, [builtinPanels, allFloatingPanels]);

const floatingPanels = useMemo(
  () => filterByProjectMode(candidatePanels, projectMode),   // ★ 模式过滤语义不变
  [candidatePanels, projectMode],
);
// 传给 DockShell:
const shellPanels = floatingPanels.filter(p => p.scope !== 'editor');      // 主候选池
const auxPanels   = floatingPanels.filter(p => p.scope === 'editor');      // 右侧辅助侧栏
```

**保留不变的 3 条既有语义**（t4 / t9 验收）：
1. `filterByProjectMode(panels, projectMode)` —— 函数名与行为均不变。
2. 「内置面板缺席 ⇒ 不渲染」—— 合池后天然成立。
3. `PanelGuard` 错误隔离 —— 从 `ProjectLayout` 的 `PanelContent` 搬进 `DockShell` 的面板内容槽，**必须搬走，不得留在已删的浮窗引擎里**。

---

## 4. §d · `MAX_OPEN_PANELS` 退役后的语义

### 4.1 现状

```ts
// apps/web/src/stores/panelOpenStore.ts
export const MAX_OPEN_PANELS = 3;
open:    next.length > MAX_OPEN_PANELS ? next.slice(next.length - MAX_OPEN_PANELS) : next
toggle:  next.length > MAX_OPEN_PANELS ? next.slice(next.length - MAX_OPEN_PANELS) : next
```
行为：打开第 4 个面板时，**静默挤掉第 1 个**（`docs/design/ui-tab-workspace-design.md:139` 已判定这是「做了但用户不知道」的错误）。

### 4.2 退役方案（冻结）

| 问题 | 冻结答案 |
|---|---|
| **是否删除 `MAX_OPEN_PANELS` 常量？** | ✅ **删除**。`export const MAX_OPEN_PANELS` 从 `panelOpenStore.ts` 移除，全仓 `git grep -n "MAX_OPEN_PANELS" -- apps packages` 必须为空 |
| **数量上限的替代语义是什么？** | **「无限打开，容量由 dockview 布局承担」**。面板不再互相挤兑 —— 打开第 N 个面板**永不关闭**任何已打开面板。可见性由 dockview 保证：标签堆叠（同一 group 内多 tab）+ 停靠区分割 + 悬浮组 |
| **`open(key)` 已打开时的行为** | **只聚焦**（`focus`），不新增、不重排、不关闭任何面板。对应 `dock.allowMultiple=false` 的缺省 |
| **打开顺序还需要维护吗？** | ✅ 需要。`opened()` 返回**打开顺序**的 key 数组，作为 `DockShell` 首次构建布局与「最近使用」排序的输入。**但顺序不再触发任何淘汰** |
| **内存/性能兜底有没有？** | **不做静默淘汰**。若 `DockShell` 检测到同 group 内 tab 数 > `DOCK_TAB_OVERFLOW_HINT = 8`，**允许**把溢出 tab 视觉压缩（dockview 自带滚动），但**不得自动关闭**。该常量为 UI 提示阈值，非容量上限 |
| **有没有真正的硬上限？** | 没有。**唯一**的边界是 `dock.minSize`（§1.4）：当所有面板的最小尺寸之和超过视口时，dockview 自动出滚动/折叠，属于布局问题，不是开闭策略问题 |
| **`closeAll()` 存在吗？** | ✅ 存在（§2.3.1）。这是用户显式意图的批量关闭，与静默淘汰完全不同 |

### 4.3 迁移动作清单（t4 照做）

1. 删除 `MAX_OPEN_PANELS` 常量与其在两处 `set(...)` 中的 `slice` 逻辑。
2. `open(key)`：`if (keys.includes(key)) return { keys, activeKey: key };`（只更新焦点）；否则 `concat`，**不做任何截断**。
3. `toggle(key)`：已存在 → 关闭；不存在 → `concat`，**不做任何截断**。
4. 新增 `activeKey` 状态（聚焦面板），与 `keys` 分离 —— 因为「打开」与「聚焦」在 dockview 里是两个独立维度。
5. `git grep -n "MAX_OPEN_PANELS" -- apps packages` 必须返回空（t4 verify + t9 复核）。

### 4.4 修订（2026-10-07 · 用户口径：上限回归 + 最近使用淘汰 + 可见提示）

**本节取代 §4.1 与 §4.2 中「删除上限 / 无限打开 / 不做任何淘汰」的结论**；§4.2 的其余条目（已打开只聚焦、维护打开顺序、不与用户显式 `closeAll` 混淆）仍然有效。

| 问题 | 现行答案（取代 §4.2 对应行） |
|---|---|
| 有没有硬上限？ | **有：`MAX_OPEN_PANELS = 3`**（`apps/web/src/stores/panelOpenStore.ts`，已导出）。依据用户口径「最多只能打开三个功能」：第 4 个面板会把 240/636/340 三段布局挤到不可用宽度 |
| 淘汰依据？ | **LRU（最近使用）**，不是 §4.1 的「最早打开的」。模块级 `recency` 记录「被打开或**被聚焦**」的相对顺序（`open` / `toggle` / `_setActive` / `seedPanelOpenKeys` 均 touch）；淘汰最久没用过的那个 |
| 是否静默？ | **不静默 —— 必须可见**：淘汰时抛 `novelmuse:toast-notify`（`dispatchToastEvent`），文案「已收起最久未用的面板（最多同时打开 3 个）」，600 ms 去抖避免收敛过程连弹。§4.2 禁止的是「静默」，不是「淘汰」 |
| 未知 key 怎么排序？ | 视为**最新**（`ageRank` = `recency.indexOf`，`-1` 即最新）。未知 = 面板由视图侧直接生出（活动栏走 `DockShellApi.openPanel`、插件直接 `addPanel`）、store 还没记过它；当最旧会在 `_syncFromView` 里**误杀刚打开的那个** |
| 视图上报越限怎么办？ | 活动栏与拖拽绕过 `store.open` ⇒ `_syncFromView` 也统一裁剪；被裁者由 `DockShell` 受控 effect（`openKeys`）从视图移除，收敛后回写 3 个、不再抖动 |
| 「`git grep MAX_OPEN_PANELS` 必须为空」 | **作废**（§4.2 第 1 行、§4.3 第 1/5 步的反向要求失效）—— 常量回归且导出，供测试与文案引用 |

回归测试：`apps/web/src/stores/__tests__/panelOpenStore.test.ts`（9 例：上限常量、LRU 而非最早打开、重复打开只聚焦、`toggle` 同受限、`_syncFromView` 越限裁剪不误杀新面板、可见提示、同批去抖、`close`/`closeAll` 语义不变）。

---

## 5. §e · VS Code Dark Modern CSS 变量契约

### 5.1 定义位置与作用域（冻结）

**唯一真源文件：`apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css`**
（t2 负责创建；`apps/plugins/shared/ui-kit/` 在 t2 的 inScope 内）

作用域要求（**t2 验收项**）：

```css
:root                { /* 全量 token。VS Code Dark Modern 是暗色主题，:root 直接就是暗值 */ }
html.dark            { /* 与 :root 相同的全量 token（重复声明，保证 html.dark 单独生效） */ }
```

- ✅ **必须定义在 `:root` / `html.dark`**，**不得**定义在 `.some-component { --x: … }` 里 —— 否则插件（`apps/plugins/*`）无法继承。
- ✅ 插件包**只通过 CSS 变量消费颜色**，不新增硬编码颜色常量（t2/t5/t10 共同验收）。
- ✅ 变量统一用 **`hsl(...)` 可直接消费的三元组**（`H S% L%`）还是**完整颜色**？

> **冻结：统一用完整颜色值（`hsl(220 13% 18%)`），不使用 `H S% L%` 三元组。**
> 理由：现有仓内 `--background: 0 0% 96%` + `hsl(var(--background))` 的三元组写法要求**每个消费点都记得包 `hsl()`**，
> 插件作者极易写成 `background: var(--vscode-editor-background)` 得到非法值。
> 新 token 一律自包含完整颜色，**允许 `color-mix()` 派生**（Node/Chromium 基线已支持，仓内 `globals.css` 已在用）。

### 5.2 token 命名空间（冻结）

```
--vscode-<surface>-<role>         表面/容器色
--vscode-<surface>-<role>-<state> 状态派生
--vscode-semantic-<name>          error / warning / info 语义色
```

**前缀一律 `--vscode-`**，避免与既有 `--background/--primary/--border/...` 命名空间冲突。

### 5.3 完整变量清单（冻结 · 逐条对应验收要求）

#### 5.3.1 编辑器（要求：编辑器背景 / 前景）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-editor-background` | `hsl(220 13% 13%)` | 编辑区 / 中心画布底 |
| `--vscode-editor-foreground` | `hsl(220 14% 85%)` | 正文前景 |
| `--vscode-editor-lineHighlight` | `hsl(220 13% 18%)` | 当前行 |
| `--vscode-editor-selection` | `hsl(207 88% 40% / 0.45)` | 选区 |
| `--vscode-editor-inactiveSelection` | `hsl(220 13% 26% / 0.6)` | 失焦选区 |
| `--vscode-editorCursor-foreground` | `hsl(207 88% 60%)` | 光标 |
| `--vscode-editorGroup-border` | `hsl(220 13% 22%)` | 编辑区之间的分隔 |

#### 5.3.2 侧边栏（要求：侧边栏）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-sideBar-background` | `hsl(220 13% 15%)` | 主侧栏底 |
| `--vscode-sideBar-foreground` | `hsl(220 14% 78%)` | 侧栏文字 |
| `--vscode-sideBar-border` | `hsl(220 13% 20%)` | 侧栏边框 |
| `--vscode-sideBarSectionHeader-background` | `hsl(220 13% 18%)` | 分区标题条 |
| `--vscode-sideBarSectionHeader-foreground` | `hsl(220 14% 72%)` | 分区标题文字 |
| `--vscode-sideBarSectionHeader-border` | `hsl(220 13% 22%)` | 分区标题下边框 |

#### 5.3.3 活动栏（要求：活动栏）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-activityBar-background` | `hsl(220 13% 11%)` | 活动栏底 |
| `--vscode-activityBar-foreground` | `hsl(220 10% 60%)` | 未激活图标 |
| `--vscode-activityBar-inactiveForeground` | `hsl(220 8% 45%)` | 更暗的未激活态 |
| `--vscode-activityBar-activeBorder` | `hsl(220 14% 90%)` | 激活项顶部/左缘指示条 |
| `--vscode-activityBar-activeBackground` | `hsl(220 13% 15%)` | 激活项底 |
| `--vscode-activityBar-border` | `hsl(220 13% 18%)` | 活动栏与侧栏分界 |
| `--vscode-activityBarBadge-background` | `hsl(207 88% 46%)` | 徽标底 |
| `--vscode-activityBarBadge-foreground` | `hsl(0 0% 100%)` | 徽标文字 |

#### 5.3.4 面板 / 停靠区（要求：面板）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-panel-background` | `hsl(220 13% 13%)` | 底部面板区 / dock area 底 |
| `--vscode-panel-foreground` | `hsl(220 14% 80%)` | 面板文字 |
| `--vscode-panel-border` | `hsl(220 13% 20%)` | 面板外框 |
| `--vscode-panelTitle-activeBackground` | `hsl(220 13% 13%)` | 激活面板标题条 |
| `--vscode-panelTitle-activeForeground` | `hsl(220 14% 90%)` | 激活面板标题文字 |
| `--vscode-panelTitle-inactiveForeground` | `hsl(220 8% 55%)` | 非激活面板标题文字 |
| `--vscode-panelTitle-border` | `hsl(220 13% 22%)` | 标题条下边框 |
| `--vscode-panelSectionHeader-background` | `hsl(220 13% 18%)` | 面板内分区标题条 |
| `--vscode-panel-dropBackground` | `hsl(207 88% 50% / 0.25)` | dockview 落区预览底（§5.6） |

#### 5.3.5 状态栏（要求：状态栏）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-statusBar-background` | `hsl(220 13% 16%)` | 状态栏底 |
| `--vscode-statusBar-foreground` | `hsl(220 14% 82%)` | 状态栏文字 |
| `--vscode-statusBar-border` | `hsl(220 13% 22%)` | 状态栏上边框 |
| `--vscode-statusBarItem-hoverBackground` | `hsl(220 13% 24%)` | 状态项悬停 |
| `--vscode-statusBarItem-activeBackground` | `hsl(220 13% 28%)` | 状态项按下 |
| `--vscode-statusBarItem-prominentBackground` | `hsl(207 88% 40%)` | 强调状态项 |
| `--vscode-statusBarItem-remoteBackground` | `hsl(207 88% 46%)` | 远程/在线指示 |

#### 5.3.6 标题栏（要求：标题栏）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-titleBar-activeBackground` | `hsl(220 13% 11%)` | 窗口标题栏（激活）|
| `--vscode-titleBar-activeForeground` | `hsl(220 14% 85%)` | 标题文字 |
| `--vscode-titleBar-inactiveBackground` | `hsl(220 13% 13%)` | 标题栏（失焦）|
| `--vscode-titleBar-border` | `hsl(220 13% 18%)` | 标题栏下边框 |
| `--vscode-topBar-background` | `hsl(220 13% 13%)` | 工作台顶栏（原 `ProjectLayout` header）|

#### 5.3.7 标签：活动与非活动（要求：标签活动与非活动）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-tab-activeBackground` | `hsl(220 13% 13%)` | 活动标签底（与编辑区同色，视觉连通）|
| `--vscode-tab-activeForeground` | `hsl(220 14% 92%)` | 活动标签文字 |
| `--vscode-tab-activeBorderTop` | `hsl(207 88% 60%)` | 活动标签顶部指示条 |
| `--vscode-tab-activeBorder` | `hsl(220 13% 26%)` | 活动标签左右描边 |
| `--vscode-tab-inactiveBackground` | `hsl(220 13% 15%)` | 非活动标签底 |
| `--vscode-tab-inactiveForeground` | `hsl(220 8% 58%)` | 非活动标签文字 |
| `--vscode-tab-unfocusedActiveBackground` | `hsl(220 13% 14%)` | 组失焦时的活动标签 |
| `--vscode-tab-hoverBackground` | `hsl(220 13% 19%)` | 标签悬停 |
| `--vscode-tab-border` | `hsl(220 13% 20%)` | 标签组外框 |
| `--vscode-tab-lastPinnedBorder` | `hsl(220 13% 30%)` | 固定/未固定分界 |

#### 5.3.8 边框与聚焦边框（要求：边框 / 聚焦边框）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-border` | `hsl(220 13% 22%)` | 通用边框 |
| `--vscode-divider` | `hsl(220 13% 20%)` | 分隔线（Splitter 中线）|
| `--vscode-splitter-background` | `hsl(220 13% 18%)` | Splitter 底 |
| `--vscode-splitter-hoverBackground` | `hsl(207 88% 46%)` | Splitter 悬停（**拖拽抓手可见性关键**）|
| `--vscode-splitter-activeBackground` | `hsl(207 88% 56%)` | Splitter 拖拽中 |
| `--vscode-focusBorder` | `hsl(207 88% 66%)` | **全局聚焦环**（键盘焦点）|
| `--vscode-widget-border` | `hsl(220 13% 26%)` | 浮层/下拉/悬浮窗边框 |
| `--vscode-widget-shadow` | `hsl(0 0% 0% / 0.36)` | 浮层投影 |

#### 5.3.9 按钮（要求：按钮）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-button-background` | `hsl(207 88% 46%)` | 主按钮底 |
| `--vscode-button-foreground` | `hsl(0 0% 100%)` | 主按钮文字 |
| `--vscode-button-hoverBackground` | `hsl(207 88% 52%)` | 主按钮悬停 |
| `--vscode-button-secondaryBackground` | `hsl(220 13% 26%)` | 次按钮底 |
| `--vscode-button-secondaryForeground` | `hsl(220 14% 88%)` | 次按钮文字 |
| `--vscode-button-secondaryHoverBackground` | `hsl(220 13% 32%)` | 次按钮悬停 |
| `--vscode-button-border` | `hsl(0 0% 100% / 0.08)` | 按钮描边 |
| `--vscode-toolbar-hoverBackground` | `hsl(220 13% 24%)` | 图标按钮悬停 |
| `--vscode-toolbar-activeBackground` | `hsl(220 13% 28%)` | 图标按钮按下 |

#### 5.3.10 输入框（要求：输入框）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-input-background` | `hsl(220 13% 11%)` | 输入框底 |
| `--vscode-input-foreground` | `hsl(220 14% 88%)` | 输入文字 |
| `--vscode-input-border` | `hsl(220 13% 26%)` | 输入框边框 |
| `--vscode-input-placeholderForeground` | `hsl(220 8% 48%)` | 占位符 |
| `--vscode-inputOption-activeBorder` | `hsl(207 88% 60%)` | 勾选态边框 |
| `--vscode-inputOption-activeBackground` | `hsl(207 88% 40% / 0.25)` | 勾选态底 |
| `--vscode-inputValidation-errorBackground` | `hsl(0 63% 20%)` | 校验错误底 |
| `--vscode-inputValidation-errorBorder` | `hsl(0 63% 50%)` | 校验错误边框 |
| `--vscode-dropdown-background` | `hsl(220 13% 16%)` | 下拉底 |
| `--vscode-dropdown-border` | `hsl(220 13% 26%)` | 下拉边框 |

#### 5.3.11 滚动条（要求：滚动条）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-scrollbar-shadow` | `hsl(220 13% 8% / 0.6)` | 滚动条侧投影 |
| `--vscode-scrollbarSlider-background` | `hsl(220 10% 50% / 0.20)` | 滑块常态 |
| `--vscode-scrollbarSlider-hoverBackground` | `hsl(220 10% 55% / 0.42)` | 滑块悬停 |
| `--vscode-scrollbarSlider-activeBackground` | `hsl(220 10% 60% / 0.60)` | 滑块拖拽中 |

> 注：`themeStore.applyTheme()` 已在设 `el.style.colorScheme`，原生滚动条会跟随；下列变量用于**自定义滚动条**（`::-webkit-scrollbar`）。

#### 5.3.12 列表悬停与选中（要求：列表悬停与选中）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-list-hoverBackground` | `hsl(220 13% 22%)` | 列表项悬停 |
| `--vscode-list-hoverForeground` | `hsl(220 14% 88%)` | 悬停文字 |
| `--vscode-list-activeSelectionBackground` | `hsl(220 13% 28%)` | **激活列表选中**（有焦点）|
| `--vscode-list-activeSelectionForeground` | `hsl(0 0% 100%)` | 激活选中文字 |
| `--vscode-list-inactiveSelectionBackground` | `hsl(220 13% 22%)` | **非激活列表选中**（无焦点）|
| `--vscode-list-inactiveSelectionForeground` | `hsl(220 14% 82%)` | 非激活选中文字 |
| `--vscode-list-focusOutline` | `hsl(207 88% 60%)` | 列表聚焦环 |
| `--vscode-list-highlightForeground` | `hsl(207 88% 70%)` | 搜索匹配高亮 |
| `--vscode-list-dropBackground` | `hsl(207 88% 50% / 0.22)` | **拖拽落点行高亮**（树/大纲重排复用）|

#### 5.3.13 error / warning / info 语义色（要求：语义色）

| 变量 | 值 | 用途 |
|---|---|---|
| `--vscode-semantic-error` | `hsl(0 68% 58%)` | 错误语义色（文字/图标）|
| `--vscode-semantic-error-background` | `hsl(0 63% 20%)` | 错误块底 |
| `--vscode-semantic-error-border` | `hsl(0 63% 50%)` | 错误块边框 |
| `--vscode-semantic-warning` | `hsl(36 90% 58%)` | 警告语义色 |
| `--vscode-semantic-warning-background` | `hsl(36 60% 20%)` | 警告块底 |
| `--vscode-semantic-warning-border` | `hsl(36 70% 48%)` | 警告块边框 |
| `--vscode-semantic-info` | `hsl(207 88% 66%)` | 信息语义色 |
| `--vscode-semantic-info-background` | `hsl(207 60% 22%)` | 信息块底 |
| `--vscode-semantic-info-border` | `hsl(207 70% 50%)` | 信息块边框 |
| `--vscode-semantic-success` | `hsl(145 55% 55%)` | 成功（VS Code 无独立 token，本项目补充）|
| `--vscode-semantic-success-background` | `hsl(145 45% 18%)` | 成功块底 |
| `--vscode-semantic-success-border` | `hsl(145 50% 42%)` | 成功块边框 |

> **映射到 shadcn/daisyUI 既有变量（t2 必须补，否则 Tailwind 工具类仍走旧值）：**
> `--destructive` ← `--vscode-semantic-error`；`--border` ← `--vscode-border`；
> `--ring` ← `--vscode-focusBorder`；`--input` ← `--vscode-input-background`；
> `--background` ← `--vscode-editor-background`；`--foreground` ← `--vscode-editor-foreground`；
> `--muted-foreground` ← `hsl(220 8% 58%)`；`--primary` ← `--vscode-button-background`。

### 5.4 插件自动继承约定（冻结）

> **约定 C-1（继承）**：所有 `--vscode-*` 定义在 `:root` / `html.dark`，**任何插件包无需 import 该 CSS** 即可在 `var(--vscode-editor-background)` 中拿到值。
> **约定 C-2（禁止硬编码）**：`apps/plugins/**` 中**不得**出现新的十六进制 / `rgb()` / `hsl()` 字面色值，除以下白名单：
> ① 已有第三方组件硬编码（`@xyflow/react` 的 handle 颜色等），② 蒙版/阴影的 `transparent` 与黑色半透明，③ 与颜色无关的尺寸值。
> 验收：t10 用 `git grep -nE "#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(" -- apps/plugins` 与基线 diff，只允许减少。
> **约定 C-3（失败降级）**：消费时**不允许**写 `var(--vscode-x, #fff)` 这类自带兜底 —— 兜底会让「token 缺失」退化为静默错色。要么直连 token，要么在 ui-kit 里补 token。
> **约定 C-4（Tailwind）**：`apps/web/tailwind.config.js` 的 `theme.extend.colors` 追加 `vscode: { editor: 'var(--vscode-editor-background)', … }` 子集（t2 决定子集大小），**同时删除 `CHROMATIC_PALETTES → INK_SCALE` 的彩色→灰阶重映射**（见 §6.3）。

### 5.5 dockview 主题接线（冻结，t3 消费）

dockview 自带 `--dv-*` 变量。**决策：不覆盖 `--dv-*`，改为在 `DockShell` 外层包一层 `.dv-theme-vscode` 类，把 `--dv-*` 映射到 `--vscode-*`：**

```css
/* apps/web/src/components/shell/dock/dock-theme.css （t3 创建） */
.dv-theme-vscode {
  --dv-background-color: var(--vscode-panel-background);
  --dv-paneview-active-outline-color: var(--vscode-focusBorder);
  --dv-tabs-and-actions-container-background-color: var(--vscode-sideBar-background);
  --dv-activegroup-visiblepanel-tab-background-color: var(--vscode-tab-activeBackground);
  --dv-activegroup-hiddenpanel-tab-background-color: var(--vscode-tab-inactiveBackground);
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--vscode-tab-unfocusedActiveBackground);
  --dv-activegroup-visiblepanel-tab-color: var(--vscode-tab-activeForeground);
  --dv-activegroup-hiddenpanel-tab-color: var(--vscode-tab-inactiveForeground);
  --dv-separator-border: var(--vscode-divider);
  --dv-paneview-header-border-color: var(--vscode-border);
  --dv-drag-over-background-color: var(--vscode-panel-dropBackground);
  --dv-drag-over-border-color: var(--vscode-focusBorder);
  --dv-icon-hover-background-color: var(--vscode-toolbar-hoverBackground);
  --dv-floating-box-shadow: 0 8px 24px var(--vscode-widget-shadow);
  --dv-tab-border-radius: 0px;   /* VS Code 标签是直角 */
}
```

> ⚠️ **t3 若发现某个 `--dv-*` 名称与实际 dockview 版本不符，以实际版本为准改名，并在 output 中列出实际使用的变量名** —— 本表是按 dockview 公开主题变量整理的，不保证 100% 命中所有版本。**唯一强约束是：所有值必须引用 `--vscode-*`，不得直接写字面色值。**

### 5.6 拖拽预览指示器（冻结，t3 验收项）

| 元素 | 取值 |
|---|---|
| 落区填充 | `--vscode-panel-dropBackground` |
| 落区边框 | `2px solid var(--vscode-focusBorder)` |
| 边框圆角 | `0`（VS Code 是直角） |
| 半透明 | 填充 ≤ 0.25 alpha，保证下层内容仍可辨认 |

---

## 6. §f · 水墨三档移除与默认主题决策

### 6.1 决策

> **默认主题 = `vscode-dark-modern`（唯一档），并且是 `:root` 本身。**
> `ThemeId` 从 `'ink' | 'shuimo' | 'soot'` 收缩为 **`'vscode-dark-modern'`**（单值字面量联合）。
> `THEMES` 数组保留**恰好一项**（设置页「外观」需要它渲染色卡，且保留未来加档的扩展位）。

### 6.2 老用户 localStorage 处理（冻结）

| 存储中的值 | 处理 |
|---|---|
| `{"theme":"vscode-dark-modern"}` | 原样使用 |
| `{"theme":"ink"}` / `"shuimo"` / `"soot"` | **静默回落到默认**（不抛错、不提示、不写迁移标记） |
| 任意其他 / 损坏 JSON / 隐私模式不可读 | 静默回落到默认 |
| `"novelmuse:theme:default-migrated-to-shuimo"`（`MIGRATION_KEY`） | **删除该常量**；已存在的旧键**不做清理**（清理属无收益的写操作）；**必须保证它的存在不再影响任何读取路径** |

**实现（冻结，t2 照做）**：`readStored()` 收缩为「读 → JSON.parse → 在 `THEMES` 里找 → 找到就用，找不到就 fallback」，**删除 MIGRATION_KEY 的整个分支**。

```ts
// 冻结后的 readStored 核心（伪码）
const fallback: StoredTheme = { theme: 'vscode-dark-modern', mode: 'dark' };
// ……
const meta = THEMES.find(x => x.id === p.theme);
return meta ? { theme: meta.id, mode: meta.lockedMode ?? normalizeMode(p.mode) } : fallback;
```

### 6.3 默认明暗（冻结）

| 项 | 决策 | 理由 |
|---|---|---|
| 默认 `mode` | **`'dark'`** | VS Code Dark Modern 是暗色主题；默认 light 会得到一个「看着像 VS Code 但字是黑的」的四不像 |
| `lockedMode` | **`'dark'`** | 该主题无浅色变体，锁定后「明暗切换」开关自动失效（复用既有 `lockedMode` 机制，`themeStore.setMode` 已有分支） |
| `applyTheme()` | **保留 `el.dataset.theme` 的写入**，值 = `'vscode-dark-modern'`；**必须**继续 `el.classList.toggle('dark', …)` 与 `el.style.colorScheme` | 新 token 同时定义在 `:root` 与 `html.dark`，二者任一生效；`colorScheme` 保证原生滚动条/表单控件跟随 |
| 主题态选择器 | 新 token **不用** `html[data-theme="vscode-dark-modern"]` 作为主入口（因为它是 `:root` 本身）；该选择器仅作显式覆盖层备用 | 见 §5.1：`:root` 保证零配置继承 |

### 6.4 移除清单（冻结，t2 + t7 分工）

| 资产 | 位置 | 归属任务 |
|---|---|---|
| `styles/shuimo.css`（127 处水墨引用） | `apps/web/src/styles/` | t2 删除；t7 复核零残留 |
| `components/shuimo/`（13 处） | `apps/web/src/components/shuimo/` | t2 删除；t7 复核 |
| `components/effects/` 下水墨特效（`BambooLeafFollow.tsx`、`AmbientBackdrop.tsx` 等 7 处） | `apps/web/src/components/effects/` | t2 删除；t7 复核 |
| `dev/shuimoPreview.tsx` | `apps/web/src/dev/` | t2 删除（`docs/design/ink-wash-migration.md` 由 t7 标注归档） |
| `dev/primitivesPreview.tsx` 中 `'soot'` 分支 | `apps/web/src/dev/` | t2 收敛为单主题 |
| `styles/themes.css` 中 `html[data-theme="soot"]` 块 | `apps/web/src/styles/` | t7（`styles/` 在 t7 inScope） |
| `styles/globals.css` 中 `--ink*` / `--cover-ink` / 水墨注释与 `nm-ink-*` 类 | `apps/web/src/styles/` | t7 |
| `tailwind.config.js` 的 `CHROMATIC_PALETTES → INK_SCALE` 重映射 | `apps/web/tailwind.config.js` | **t2**（在 t2 inScope）；改为真实 VS Code 语义色类 |
| `docs/design/ink-wash-migration.md` 等水墨文档 | `docs/` | t7 标注废弃/归档（**不删除**历史评审报告） |

> ⚠️ **t2 与 t7 的重叠区已在本表显式划清**，二者不得互相等待：
> **t2 先删**（含 import 与样式引用一并清理，保证 `type-check` 通过），**t7 后复核并清理残余选择器**。

#### 6.4-a 偏离记录：本行（`--ink*` / `--cover-ink` / `nm-ink-*`）的**删除前提经实测不成立**（t2 追加，2026-10-02）

> 上面第 718 行的表格是**冻结的历史契约**，原文保留不动。但它的删除前提是
> 「这些资产零引用」，该前提**经实测不成立**。t2 收尾时实测数据如下：

| 事实 | 实测值 | 证据 |
|---|---|---|
| `var(--ink)` 活跃消费点 | **72** 处 | 原样计数（`A_raw`）；剥离块注释后 69（`B_code`） |
| `var(--ink-light)` 活跃消费点 | **83** 处 | 原样计数；剥离注释后 82 |
| `var(--ink-pale)` 活跃消费点 | **32** 处 | 原样计数；剥离注释后 31 |
| 合计 | **187** 处（剥离注释 182） | 均为 `hsl(var(--ink…))` **三元组**写法（`hsl()` 需要裸分量，故不能直接换成 `--vscode-*` 的完整色值） |
| 真源是否定义 `--ink*` | **完全不定义** | `apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css` 无任何 `--ink*` |
| 消费点分布 | `apps/plugins/**`、`apps/web/src/pages/**`、`apps/web/src/components/settings/**`、`apps/web/src/styles/globals.css`、`landing.css` | 逐目录 grep |

> **口径可复现化（captain 追加，2026-10-02）**：以上三个口径已固化为可复现脚本
> `scripts/verify/measure-ink-consumers.mjs`（**测量工具，非门禁，退出码恒为 0**），一次输出三列：
> `A_raw`（原样计数，含块注释）/ `B_code`（剥离块注释的真实代码消费点）/ `C_bare`（裸 token 名，含注释说明行）。
> 现测：`A_raw` = 72 / 83 / **32** = **187**；`B_code` = 69 / 82 / 31 = **182**；`C_bare` = 73 / 84 / 33 = **190**。
> **本表采用的 187 即 `A_raw`，其拆分应为 72 / 83 / 32**（原记 73 / 83 / 31 是把 `C_bare` 的 `--ink` 列与 `B_code` 的
> `--ink-pale` 列混入了 `A_raw` 的拆分，已更正）。三个口径**结论方向完全一致**（百级活跃消费点 ≫ 零引用），
> 故下方「保留定义」的裁定在任一口径下都成立。`--ink-deep` 在三个口径下**一致为 13**（见 §6.4-a 同段的悬挂引用记录）。

**本次重构的实际处置（captain 裁定）：**

1. **保留** `--ink` / `--ink-light` / `--ink-pale` 三个定义 ——
   `apps/web/src/styles/globals.css` 的 `:root` 块 L161-163 与深色块 L374-376；
2. **保留** `--cover-ink`（同文件 L72）；
3. **保留** `.glass-ripple-ink`；
4. **只改写水墨语义注释**（把注释里的「水墨」措辞改为中性描述，并登记 187 处消费点与其 `--vscode-*` 等价映射）；
5. **零选择器删除** —— 本行原本暗示的 `nm-ink-*` 类删除同样不发生（理由见 §6.5-a）。

> **彻底移除的前置条件（不在本次范围）**：需**另开迁移任务**把上述 187 处消费点从
> `--ink*` 迁到 `--vscode-*`。该迁移跨 `apps/plugins/**`、`apps/web/src/pages/**`、
> `apps/web/src/components/settings/**`，且**会改变外观**（`hsl()` 三元组需改为
> 完整色值或引入 `--vscode-*-hsl` 分量变量），故必须独立评审、独立验收。

**完整推导与验收证据**见 `docs/architecture/dock-refactor-final.md` §6（与 ADR 的已知偏差）
与 §10（收尾独立复核记录）。

### 6.5 `nm-*` 语义类去向（冻结）

`globals.css` 中 60+ 个 `nm-*` 类（`.nm-btn-apple*`、`.nm-card`、`.nm-modal-*`、`.nm-glass*`、`.nm-input*`、`.nm-editor-*` 等）**是组件直接引用的公共 API**，跨 t2/t3/t4/t5/t7 四个任务。

> **决策：`nm-*` 类名保留，只把其内部值改为引用 `--vscode-*`。**
> **不重命名**（重命名会迫使 t3/t4/t5 同时改 tsx，制造四任务耦合）。
> 唯一例外：名字里直接带水墨语义且**无引用**的类（如 `.nm-ink-back`、`.nm-ink-lift`、`.nm-ink-divider`、`.nm-ink-title`、`.nm-no-brush`、`.nm-logo-seal`、`.nm-qbubble*`、`.nm-qp-*`）由 t7 复核引用后删除。
>
> **本 ADR 只冻结"保留类名 + 换值"，具体值映射由 t2 在 ui-kit 中落地。**

#### 6.5-a 偏离记录：上面「唯一例外」清单**逐条与事实矛盾**（t2 追加，2026-10-02）

> 上面 6.5 的决策段落是**冻结的历史契约**，原文保留不动。但其「唯一例外」一句的前提
> （「名字里带水墨语义且**无引用**」）经逐条实测**不成立**：

| 类 | `globals.css` 是否有定义 | 仓库是否有活跃引用 | 实测判定 |
|---|---|---|---|
| `.nm-no-brush` | 有 | **有** —— `apps/plugins/shared/ui-kit/src/aiBars.tsx:415,518` | ❌ 前提不成立，**不得删** |
| `.nm-logo-seal` | 有（L1430，含 `::before` L1451） | **有** —— `apps/web/src/pages/LoginPage.tsx:106`、`RegisterPage.tsx:216` | ❌ 前提不成立，**不得删** |
| `.nm-qbubble*` | 有（L1979-2031，含 `@keyframes`） | **有** —— `apps/plugins/shared/ui-kit/src/aiBars.tsx:138,154` | ❌ 前提不成立，**不得删** |
| `.nm-qp-*` | 有（L2041-2088，含 4 个 `@keyframes`） | **有** —— `apps/plugins/manual/workbench/web/editor/panels/QuickPhraseBubble.tsx:406,409` | ❌ 前提不成立，**不得删** |
| `.nm-ink-back` / `.nm-ink-lift` / `.nm-ink-divider` / `.nm-ink-title` | **无**（`globals.css` 内根本不存在这些选择器） | 无 | ⚠️ 引用确实为零，**但无定义可删** ⇒ 删除无对象 |
| `.nm-brush` | **无**（同上） | 无 | ⚠️ 同上 |

**结论：本次重构零选择器删除。** 8 个被点名的类中，4 个有活跃引用（删了会直接
破坏登录页 / AI 工具条 / 快捷短语气泡），另外 4 个及 `.nm-brush` 在 `globals.css` 里
**根本没有定义**（属清单笔误 —— 引用为零是因为它从未被实现，而不是因为它被废弃）。
⇒ **该例外清单不产生任何正当的删除动作**，t7 按此清单执行会造成可见的 UI 回归。

**本次处置（captain 裁定）：** 保留全部 `nm-*` 类名与定义，只按 6.5 正文把其内部值
改为引用 `--vscode-*`；不执行本例外清单的任何删除。

**完整推导与验收证据**见 `docs/architecture/dock-refactor-final.md` §6（与 ADR 的已知偏差）
与 §10（收尾独立复核记录）。

---

## 7. 下游任务施工单（速查表）

| 任务 | 必读章节 | 本 ADR 给它吃下的接口 |
|---|---|---|
| **t2** theme-eng | §5 全部、§6 全部 | `--vscode-*` 全量清单、定义位置/作用域、`ThemeId` 收缩、`readStored` 冻结伪码、移除清单、Tailwind 重映射 |
| **t3** dock-eng | §1.4–1.6、§2.4、§4.2、§5.5–5.6 | `FloatingPanelDockMeta` 全字段、`DockShellProps`、`DockShellApi`、缺省真源 `resolveDockMeta`、`--dv-*` 映射表、预览指示器取值 |
| **t4** host-eng | §1.1–1.3、§2.1–2.3、§3.4、§4.3 | 字段保留判定、`PanelNavigation` 签名、`'nm:open-panel'` 逐步迁移、候选池合成代码、`MAX_OPEN_PANELS` 删除清单 |
| **t5** plugin-eng | §1.1、§1.3、§3.3 | 「所有既有字段保留 ⇒ 12 面板 + 势力面板**零改动**」的判定；`registerBuiltinBubble → registerBuiltinPanel` 唯一改动点；`rail` 内部化 |
| **t6/t9/t10** reviewer | §1.1、§2、§3、§4、§5.4 | 逐条对照的验收口径 |
| **t7** cleanup-eng | §6.4、§6.5 | 删除清单分工、`nm-*` 保留/删除判定 |
| **t8** verifier | §0.2、§5、§6 | 无 C++/Qt 断言、token 覆盖清单、构建产物检查点 |

### 7.1 给 t5 的关键结论（可直接引用）

> **`FloatingPanelDef` 的 11 个既有字段全部保留，`dock` 为纯可选新增 ⇒ 现有插件注册代码 100% 向后兼容。**
> - `apps/plugins/manual/workbench/web/panels.tsx` 的 12 个 `BUILTIN_PANELS`：**零改动**
> - `apps/plugins/manual/worldbuilding/src/web/index.tsx:105` 的 `'factions'`：**零改动**
> - `apps/plugins/shared/typography/web/index.tsx:379` 的 `'typography'`：**零改动**
> - `apps/plugins/manual/workbench/web/index.tsx:35` 的 `registerBuiltinBubble`：**唯一必改点**（改名为 `registerBuiltinPanel`；若保留 deprecated 别名则连这里也可不改，但 t5 应主动改名以完成去气泡化）
> - 5 个 `nm:open-panel` 派发点：**全部零改动**

---

## 8. 决策摘要（一页速览）

| # | 决策 | 类型 |
|---|---|---|
| D1 | `FloatingPanelDef` 既有 11 字段**全部保留**；新增可选嵌套 `dock?: FloatingPanelDockMeta` | 冻结 |
| D2 | `width`/`height` 降级为 floating group 的「建议值」，停靠态忽略 | 冻结 |
| D3 | `dock.center: boolean` 与 `dock.slot` 分离（抢占中心 vs 初始落位） | 冻结 |
| D4 | 缺省真源 = `DockShell` 内 `resolveDockMeta()`，唯一 | 冻结 |
| D5 | 新增 `getPanelNavigation()` 命令式单例 + `usePanelOpenStore` hook 双入口 | 冻结 |
| D6 | `'nm:open-panel'` **删除不得** —— `apps/server` 会持续为 AI 生成插件吐这个字面量 | 冻结 |
| D7 | `'nm:open-settings'` **保留**，虽当前零派发（公开契约 + 历史文档记载） | 冻结 |
| D8 | `'chapters'`/`'ai-chat'` 从硬编码 key 查找改为**统一候选池**，顺带修复 `'ai-chat'` 从不渲染的缺陷 | 冻结 |
| D9 | `BuiltinBubbleDef → BuiltinPanelDef`，`registerBuiltinBubble → registerBuiltinPanel`（保留 deprecated 别名） | 冻结 |
| D10 | `MAX_OPEN_PANELS` **删除**；改为「无限打开，容量交给 dockview 布局」 | ~~冻结~~ **已被 §4.4 修订取代（2026-10-07）**：常量回归为 `= 3`，超限按 LRU 收起最久没用过的那个并抛 toast |
| D11 | 主题 token 前缀 `--vscode-`，值用**完整颜色**，定义在 `:root` + `html.dark` | 冻结 |
| D12 | `ThemeId` 收缩为 `'vscode-dark-modern'` 单值，默认 `mode='dark'`，`lockedMode='dark'` | 冻结 |
| D13 | `MIGRATION_KEY` 逻辑删除；老值静默回落，不抛错 | 冻结 |
| D14 | dockview `--dv-*` 通过 `.dv-theme-vscode` 映射到 `--vscode-*`，不新增字面色值 | 冻结 |
| D15 | `nm-*` 类名保留、只换值；仅删无引用的水墨语义类 | 冻结 |
| D16 | **不引入 C++/Qt/CMake/QGraphicsView**；关系图以现有 `@xyflow/react` 实现 | 冻结 |

### 8.1 自洽性声明

本 ADR 六节（§1–§6）逐条对照无冲突，重点交叉校验：

- §1.4 `dock.slot` 缺省 `'right'` ∩ §1.2 `scope:'editor'` → 同落点（右侧辅助侧栏），无冲突。
- §3.2 候选池合池 ∩ §1.1 `scope` 保留 → 合池后再按 `scope` 分流，顺序明确，无冲突。
- §4.2 `open()` 已存在「只聚焦」 ∩ §2.3.1 `open`/`focus` 两方法 → §2.3.1 已注明二者语义等同，无冲突。
- §5.1 定义在 `:root` ∩ §6.3 仍写 `data-theme` → §6.3 已说明 `data-theme` 仅作备用覆盖层，无冲突。
- §6.4 t2/t7 重叠区已用表格划清先后，无冲突。
