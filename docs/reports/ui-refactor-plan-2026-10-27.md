# 前端 UI 改造计划（只动 UI 层，业务逻辑零改动）· 2026-10-27

> 用户口径：**「不碰业务层逻辑，只动 UI 前端」** —— 把前端外观整体换成现代中性风
> （shadcn/ui 那套），范围含**外壳 + 全部业务面板的外观**；业务逻辑（store / API /
> 插件契约 / 数据流）**一行不改**。
>
> 本文只写"怎么做、动哪些文件、怎么验收"。**对照页已可看**：
> 启动 dev 后访问 `/dev/ui-preview`（仅开发环境注册）。

---

## 一、基线事实（先量再改）

| 维度 | 数量 | 含义 |
|---|---:|---|
| 前端 ts/tsx | 343 文件 / **79,102 行** | 改造面总量 |
| 自写 CSS | 5,104 行 | globals 2499 + project-shell 788 + dock-theme 875 + landing 584 |
| `className` 使用点 | 2,639 处 | 视觉改造的落点密度 |
| 业务面板 UI | 约 **24,000 行**（手写台 12 + AI 写作台 6） | 第三阶段的主战场 |
| 自研 CSS 前缀 | `.nm-*` `.mc-*` `.shell-*` `.dock-*` `.dv-*` | **全部保留**（见 §4 死代码判据） |

### 关键发现（决定方案形状）

1. **Tailwind 配置已经是 shadcn 形态**：`apps/web/tailwind.config.js:26-56` 早已把
   `border/input/ring/background/foreground/primary/secondary/destructive/muted/accent/card`
   映射成 HSL 三元组；`darkMode:'class'`（:19）、`borderRadius`（:241-250）也都在。
   ⇒ **不需要 init shadcn、不需要改构建**。
2. **实测缺口三处**（本次已补，是后续所有工作的前置）：
   - `content` 不含 `apps/plugins/shared/ui-kit/src` ⇒ 放那里的组件工具类**不会被编译**
     （实测证据：`ui-kit/ToastProvider` 的 `min-w-[280px]`/`z-[9999]` 在产物 CSS 里一直缺失）。
   - 全仓**没有** `--popover` 令牌、tailwind 也没有 `popover` 颜色键
     ⇒ shadcn 的 Dialog/Dropdown/Popover/Command 会「有形无皮」。
   - 没有 `tailwindcss-animate`（v3 路线的动画插件；v4 的 `tw-animate-css` 不适用）。
3. **令牌层有个层叠陷阱**：`ui-kit/src/styles/vscode-dark-modern.css` 把
   `--background/--border/--primary/--card/--muted…` 以 **`:root` 无层**重声明过一次
   （成因见该文件头注：无层恒胜有层）。⇒ 任何候选令牌**必须用 `:root.类名` 提特异性**
   才能压过它（裸类无效 —— 实测：`--radius` 生效、`--border` 不生效）。

---

## 二、分层边界（"只动 UI"的准确含义）

**判据**：文件是否 import `services/**` / 写 store action / 调 API / 跑编排。
是 ⇒ 业务层（不动）；否 ⇒ UI 层（可改）。

| 层 | 可动 | 代表路径 |
|---|---|---|
| **外壳（纯 UI）** | ✅ 随便改 | `apps/web/src/components/shell/**`（DockShell / ProjectLayout / DocTabs / PanelMenu / issues / statusBar） |
| **共享 UI 原子** | ✅ | `apps/plugins/shared/ui-kit/**`（新增 `src/ui/**`）、`components/ui/{BookCard,BookCover}` |
| **面板的展示部分** | ✅ 只改 JSX / 类名 | 各 `workbench/web/*.tsx` 的渲染段；`editor/{PageLayer,FindReplaceBar,PluginEditorToolbar}` 等 |
| **面板的业务胶水** | ❌ 不改 | `workbench/web/*/services/**`、`stores/**`、`server/**` |
| **kernel 业务/IO** | ❌ 不改 | `apps/web/src/{pages,services,stores,plugin}/**`（`themeStore` 除外） |

⚠️ **面板文件多是"混合体"**（同一文件里既有渲染又有 `apiClient` 调用）——改造时的纪律是
**只动 return 里的 JSX 与 className，不碰任何 handler 的函数体**。

---

## 三、四阶段执行计划

每阶段都可独立验收、可单独回滚。

### 阶段 0 · 基建（✅ 本次已完成）

| 项 | 落点 | 状态 |
|---|---|---|
| 依赖 | 根 `package.json`：`clsx`/`tailwind-merge`/`class-variance-authority`/`tailwindcss-animate` + 13 个 `@radix-ui/*` + `cmdk` | ✅ |
| Tailwind content 补 ui-kit / ui-graph | `apps/web/tailwind.config.js` | ✅ |
| `popover` 令牌 | `globals.css` 的 `:root` + `.dark`；`tailwind.config.js` 的 colors | ✅ |
| `tailwindcss-animate` 进 plugins | `apps/web/tailwind.config.js` | ✅ |
| shadcn 落点 | **`apps/plugins/shared/ui-kit/src/ui/**`**（唯一能同时被 kernel + 两个模块合法 import 的地方） | ✅ |
| `components.json`（供日后 `shadcn add`） | 仓库根，aliases 指向 `@novel-plugins/ui-kit/ui` | ✅ |
| 对照页 | `apps/web/src/dev/UiPreviewPage.tsx` + `ui-preview.css`，路由 `/dev/ui-preview`（`import.meta.env.DEV` 守卫） | ✅ |

> 为什么组件放 ui-kit 而不是 `apps/web/src/components/ui`：
> manual/auto 两个模块**禁止** import kernel 内部路径（隔离门禁的 K2A/A2M 边）；
> 放 shared 才能"一份组件三侧共用"。方向性是 kernel→shared，**不构成循环**。

### 阶段 1 · 令牌换肤（观感变化最大、风险最低）· ✅ **已完成**

**做法**：把对照页里 `.ui-preview-theme--modern` 的候选值原样搬到正式令牌真源。
**实际改动面**：3 个文件 —— `apps/web/src/styles/globals.css`、`apps/plugins/shared/ui-kit/src/styles/vscode-dark-modern.css`、
`apps/web/tailwind.config.js`（无需改 tsx，一个组件都没动）。

**候选差异（就四处）**：

| 令牌 | 现状 | 现代中性 | 影响 |
|---|---|---|---|
| `--radius` | `1rem`(16px) | **`0.5rem`(8px)** | UI 显老的根因；`rounded-md` 由 14px→6px |
| `--foreground` / `--ink` | `13%` / `9%` | `4%` / `4%` | 白底上字更"实"（`--ink` 187 处消费，必须与 foreground 同档） |
| `--primary` | `22%` | `9%` | 主按钮/强调更深 |
| `--border` | `220 13% 86%`（冷灰） | `0 0% 90%`（中性） | 去蓝偏 |
| `--muted` / `--secondary` / `--accent` | `220 20% 94%` / `220 13% 92%` / `220 13% 90%` | 均 `0 0% 96%` | 次级面更浅、界面更"平" |
| `--input` | `100%`（纯白） | `90%` | shadcn 口径是**输入框描边色**；纯白时 `border-input` 恒不可见 |
| 内联圆角档位 `--r-*` | 20/14/12/10/8/4 | 12/10/8/6/6/4 | 50 处内联消费跟着收档，避免"新壳配旧圆角" |

**`--vscode-*` 真源同批调整（关键，否则外壳与面板两套令牌割裂）**：
- **色相归零**：128 处 `hsl(220 …)` → `hsl(0 0% …)`（保留语义色相 36/207/145 不动）。
  ⚠️ 必须同时把 S 归零 —— `hsl(0, 13%, 13%)` 是"去饱和的暗红"而不是中性灰。
- **暗档明度**：31 处表面压深一档（`editor-background` 13%→9% 等）、22 处文字提亮（85%→91%）。
- **亮档明度**：22 处文字压深（13%→5%）、23 处描边提亮（85%→90%）。

**验收**：`verify:spacing` ✅ 基线 5 处 / `verify-theme-single-source` ✅ / `verify-workbench-isolation` ✅ /
`vitest` ✅ 32 文件 385 用例 / 目视（亮暗各一次，含书架、工作台、设置）✅
**回滚**：还原 3 个文件即可，零业务影响。

### 阶段 2 · 外壳换皮（不动行为）· ✅ **已完成**

**2a 浮层**：浮层菜单统一成"圆角 + 双层投影 + 内缩圆角高亮"（`.panel-menu-popover` 8px/`.panel-menu-item` 6px/
`.shell-doctab-menu` 8px/`.shell-doctab-menu-item` 6px），以及 `.shell-doctab-add/close/unsplit/split` 收档到 `--r-xs`。

**2b VS Code 2026 对齐（2026-10-27 追加，作者拍板"用 VS Code 的蓝 + 只收紧不做开关"）**：

色值**取自 VS Code 官方主题源文件**（`extensions/theme-defaults/themes/2026-light.json` /
`2026-dark.json`，MIT），不是凭印象：

| 语义位 | 值（亮/暗） | 来源 |
|---|---|---|
| `--primary` / `--ring` / `focusBorder` | `#0069CC` / `#3994BC` | 2026 主题 focusBorder |
| `button.background` | `#0069CC` / `#297AA0` | 2026 主题 button |
| 标签顶边 / 活动栏左边条 | 同 focusBorder 蓝 | 2026 `tab.activeBorderTop` |
| 列表选中底 | 蓝 12%/26% 透明 | 2026 `list.activeSelectionBackground` 手法 |
| 暗档三层表面 | 底 7% / 工具 10% / 浮层 13% / 描边 17% | 2026 `editor/sideBar/menu/border` |

⚠️ 引入彩色只有这四处（primary/ring/按钮/选中），其余保持中性灰 —— 与 VS Code 2026
"Reduced Palette + Strategic Accents"的口径一致。
⚠️ 社区背景：VS Code 2026 主题发布后争议很大（大量用户回退 Dark Modern），主要抱怨
**对比度**与**语法色**；我们只借它的**外壳层次与强调色**，正文排版不受影响。

**2c 密度收紧（Layout Density，做进默认、不配开关）**：

| 条 | 原 | 新 |
|---|---|---|
| 顶栏 | 31px | **29px** |
| 文档标签栏 | 35px | **33px**（与隐藏的原生组头等高） |
| 活动栏列宽 / 条目 | 47 / 44×36 | **42 / 40×32** |
| 状态栏 / 状态项 | 21 / 20 | **20 / 18** |

实测渲染值与目标一致（topbar 29 / docbar 33 / rail 42、item 40×32 / statusbar 20）。
e2e 只断言相对宽度与选择器存在、单测只锁面板 minSize ⇒ 高度改动不触碰任何验证契约。

**验收**：`verify-theme-single-source` ✅ / `verify:spacing` ✅ 基线 5 / `vitest` ✅ 385 /
`web+manual tsc` ✅ 0 / 目视亮暗两档 ✅（活动标签顶边实测 `rgb(0,105,204)` = #0069CC）

**做法（关键）**：**保留全部 `.shell-*` / `.dock-*` / `.dv-*` 类名，只改其定义值**，
并在需要时叠加 Tailwind 原子类（双写过渡）。

> 为什么不直接换成原子类：这些类名被 **3 组单测 + 1 个 e2e 脚本**当选择器用
> （`DocTabs.test.tsx` 14 处、`ProjectLayout.shell-tabs.test.tsx`、`DockShell.smoke.test.tsx`、
> `scripts/e2e/e2e-ui-integration.mjs` 的 `S` 常量表）。改类名 = 同时打红 4 处验证契约，
> 成本远高于收益。

**唯一该动逻辑的地方**：`DocTabs.tsx:555,605` 那两处**手算弹层坐标** —— 换 Radix
`DropdownMenu` 后整段删除（这也是"少写逻辑"而非"改业务"）。

**必须原样保留的行为块**（逐条核对，不许顺手重排）：
`DockviewReact` 实例与 `onReady`、受控 `openKeys` 同步、隐藏组头 effect、分屏 scope 重算、
`DockShellApi` 全部方法、`ProjectLayout` 的 URL→store 恢复与三类 register 接线。

### 阶段 3 · 组件替换（按 ROI 排序，逐个独立验收）

| 顺序 | 组件 | 现有实现 | 风险 |
|---:|---|---|---|
| 1 | **Command（cmdk）** | `components/ui/CommandPalette.tsx`（195 行，消费点仅 App.tsx） | 中 |
| 2 | **DropdownMenu** | `shell/PanelMenu.tsx`（129 行） | 低-中 |
| 3 | **Switch** | `skills/SkillSwitch.tsx`（86 行）+ `AddBookModal:760` | **低** |
| 4 | **Dialog 外壳** | `EarmarkDialog`/`TrashDialog`/`ContinueWriteModal`/`OutlineCheckModal`/`OutlineFillDialog` 五个同构弹窗先收敛成一个共享壳 | 低-中 |
| 5 | **Combobox（Popover+Command）** | `settings/AIConfigPanel.tsx` 的模型下拉 | 中（**必须保留**"拉取后自动展开"与"打字才过滤"两条行为） |
| 6 | **Dialog 全量** | `components/ui/AddBookModal.tsx`（**1143 行**，无 portal/无 role=dialog，含 gsap 进出场） | **高** |
| 7 | **Popover** | `editor/SelectionMenu.tsx`（562 行，必须 portal + 自算翻转） | **最高，放最后** |
| — | ~~Toast~~ | `ui-kit/ToastProvider.tsx`（358 行，gsap + **单测 mock 了 gsap**） | **暂不做**（会打断测试契约） |

### 阶段 4 · 面板逐个换皮

**做法**：按 `阶段 1`+`阶段 3` 定下的规范，逐个面板改**外层结构**（标题条 / 工具条 /
列表行 / 空态 / 表格 / 表单），业务 handler 一行不动。18 个面板可并行、可分批交付。

---

## 四、CSS 死代码判据

`.shell-*` / `.dock-*` / `.dv-*` / `.nm-*` / `.mc-*` 的每条规则，**退场前必须过三关**：

1. `grep -rn "<类名>" apps/web/src apps/plugins` 无引用；
2. 单测无引用（见阶段 2 的清单）；
3. e2e 脚本无引用（`scripts/e2e/e2e-ui-integration.mjs` 的 `S` 表）。

**只改值不改名 ⇒ 永远不会变死代码。** 这是本方案刻意选择的约束。

---

## 五、验收矩阵

| 手段 | 命令 | 覆盖 |
|---|---|---|
| 类型检查 | `tsc --noEmit -p apps/web/tsconfig.json` + 两个 `tsconfig.typecheck.json` | kernel + 两个模块（**插件侧要单跑**，`pnpm -r type-check` 不含） |
| 单测 | `node node_modules/vitest/vitest.mjs run`（在 apps/web） | 32 文件 / 385 用例（含外壳类选择器断言） |
| 主题真源门禁 | `node scripts/verify/verify-theme-single-source.mjs` | `--vscode-*` 定义唯一性 |
| 隔离门禁 | `node scripts/verify/verify-workbench-isolation.mjs` | 内核→模块 import 规则 |
| 间距审计 | `node scripts/tools/spacing-audit.mjs .` | 野值基线（当前 5 处） |
| e2e（需真栈） | `node scripts/e2e/e2e-ui-integration.mjs` | 外壳布局断言（需后端 3774 + 前端 + CDP） |
| 目视 | `/dev/ui-preview` 的「现状 / 现代中性」开关 + 亮/暗切换 | 本方案的主要验收手段 |

> **CI 不含 e2e 与 verify:\***（`.github/workflows/ci.yml` 只跑 type-check / lint / test），
> 所以"换 UI 不回归"目前只能靠**提交前手动跑**上面这几条。
> 仓库**没有**像素级视觉回归基线。

---

## 六、已知遗留（本次不处理，供决策）

1. `verify-theme-single-source` 报真源 token **118 > 基线 117** —— **改动前就存在**的漂移
   （真源文件本次未修改），需同步 ADR §5.3 与脚本基线常量。
2. `globals.css` 里 `--radius-md` / `--radius-sm` **无定义**却被 `border-radius: var(--radius-md)`
   使用（:1481/1587/1600），当前是退化值。
3. daisyUI 已基本不用（`themes:false/base:false`），与 shadcn 不冲突，可作"顺手退场"目标。
4. 无像素级视觉回归 —— 若长期守住换肤，建议引入 playwright 截图基线（净新增能力）。
