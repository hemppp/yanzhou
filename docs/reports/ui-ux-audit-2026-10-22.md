# AI 写作台 UI/UX 走查 · 2026-10-22

> 走查方式：真实拉起 server(3774) + web(5175)，用浏览器登录后**走完整链路**——
> 书架 → 新建 AI 项目（两步表单）→ 写作台 → 逐个打开 7 个看板 → 亮/暗两档。
> 所有结论都有实测数据或截图支撑，不做「看起来像」的推断。
>
> 环境：Chromium（ego lite），视口 1485×761，亮色默认档。
> 截图目录：`F:\ClaudeHome\dot-claude\projects\F--new1-2\scratch\ego\ui-audit-20261022\`

---

## 一、必须先修的确定性缺陷（真 bug，不是审美）

### U1 🔴 标签溢出下拉「已打开的看板」**完全不显示**（被父容器裁掉）

`apps/plugins/auto/workbench/web/shell/TabBar.tsx:101` 的标签栏根节点是
`overflow-hidden relative`，而下拉菜单（:252）用的是 `absolute` + `top: 34`。
菜单本身位于 30px 高的标签栏**之外**，被父级的 `overflow: hidden` 整块裁掉。

实测（菜单打开状态下）：

| 探针 | 结果 |
|---|---|
| 菜单 DOM / 项数 | 存在，7 项 |
| 菜单 rect | x=1265, y=82, w=220, h=192 |
| 祖先 overflow | 标签栏 `hidden` |
| 菜单中心点 `elementFromPoint` | 命中的是下方**字体排版面板**，不是菜单 |
| 截图 `13/15-overflow-open.png` | 画面上**看不到菜单** |

后果：标签多到溢出时，用户点右侧 `⌄` 没有任何反馈，那些被挤出去的看板**无法从下拉找回**
（只能靠 Ctrl+P 或横向滚动）。这是功能失效，不是样式瑕疵。

**修法**：菜单改为 `fixed`（与同文件右键菜单 :289 的既有做法一致 —— 它实测是好的），
或给菜单套 portal。

### U2 🔴 RGB 三元组被当成 HSL 使用 → **黄色**底色/描边

`--glass-tint` / `--glass-highlight` 在 `globals.css:176,379` 定义的是 **RGB 三元组**
（`250 250 250` / `255 255 255`），必须用 `rgb(...)`。但以下位置写成了 `hsl(...)`：

实测浏览器解析（不是猜）：

| 写法 | 计算值 |
|---|---|
| `hsl(var(--glass-tint) / 0.35)` | **rgba(255, 255, 0, 0.35)** ← 黄 |
| `rgb(var(--glass-tint) / 0.35)` | rgba(250, 250, 250, 0.35) ← 正确 |
| `hsl(var(--glass-highlight) / 0.5)` | **rgba(255, 255, 0, 0.5)** ← 黄 |
| `hsl(var(--glass-shadow) / 0.08)` | rgba(0, 0, 0, 0.08) ← 恰好正确（它是 HSL 三元组） |

受影响位置：

- `apps/plugins/shared/typography/web/index.tsx:277` —— 字体排版面板「实时预览」整块
  **渲染成亮黄色**（截图 `12-typography.png`、`17-dark.png` 均可见；暗色档下更刺眼）。
- `apps/plugins/shared/typography/web/index.tsx:207` —— 「跟随主题」色块的
  `repeating-linear-gradient` 变成**黄黑斜纹**（本该是极浅的纸纹）。
- `apps/web/src/styles/globals.css:932` —— `.nm-btn-apple-secondary:hover` 背景变黄。
- `hsl(var(--glass-highlight) / …)` 共 **14 处**（ContinueWriteModal、OutlineCheckModal、
  ui-kit 的 aiBars / ToastProvider / ErrorBoundary）—— 本该是「1px 白色内高光」，
  实际是 1px 黄线。亮色下不明显，暗色下会露黄边。

**修法**：`hsl(` → `rgb(`（只改这两个 token 的用法，`--glass-shadow` 保持 `hsl`）。

### U3 🟠 空态文案在 AI 模式下指向不存在的入口

`apps/plugins/auto/workbench/web/entities/EntityOverviewPanel.tsx:168`：

> 暂无实体数据，可在**手写台**的面板中维护

AI 模式下不挂手写台面板（模式分离的既定契约），这句话把用户指向一个不可达的地方
（截图 `08-entities.png`）。应改成「流水线跑到『角色与节奏 / 世界圣经』后，实体与设定会出现在这里」。

### U4 🟠 流水线面板出现**两处空态**，且第二处与第一处互相重复

`06-pipeline.png`：上方卡片是「开始立设定」CTA + 说明，下方「设定流水线 0/7 段已定稿」
区域又给了一个「暂无数据 / 流水线状态还没建立 —— 用上方的『开始立设定』从开书信息起步」。
同一块区域里，主动作已经在上方，下面再空一次属于噪声。建议：未启动时下方直接不渲染，
或把空态收成一行细提示。

---

## 二、可读性（实测对比度，亮/暗两档都测了）

只统计「可见文本叶子节点」共 34 个，低于 WCAG AA 4.5:1 的 4 个——**全部是 10–12px 的小字**：

| 文案 | 字号 | 亮色对比度 | 暗色对比度 | 位置 |
|---|---|---|---|---|
| `Enter 发送 · Shift+Enter 换行` | 11px | **2.86** | **3.28** | AutoWriteWorkbench.tsx:1026 |
| `实时应用到编辑器正文…` | 12px | **2.59** | 3.70 | typography/web/index.tsx:146 |
| `实时预览` | 12px | **2.36** | 3.33 | typography/web/index.tsx:281 |
| 空态第二段说明 | 11px | **3.46** | 3.87 | AutoWriteWorkbench.tsx:850 |

根因统一：`color: hsl(var(--muted-foreground) / 0.7~0.8)` 或 `hsl(var(--ink-light) / 0.55~0.6)`。
全仓同型写法共 **36 处**（0.3–0.75 共 8 档）。建议：

1. 先把这 4 处提到 ≥4.5:1（去掉 `/0.x` 或降到只对装饰性元素使用）；
2. 再定一条规则：**正文类小字不用透明度压暗**，只对分隔符/图标使用。

另：写作台内 10–12px 文本共 **315 处**（`text-[10.5px]` / `text-[11px]` / `text-xs`）。
这是既有的「信息密度优先」取向，本次不建议整体改字号；但**关键动作提示**（发送快捷键、
当前章节状态、角色阶段）应当至少 12px 且对比度达标。

---

## 三、可发现性 / 交互语义

### U5 🟠 气泡列只能双击「固定」，但界面没有任何提示

`BubbleRail.tsx:65-68`：单击=预览（220ms 延迟）、双击=固定。气泡 30×30、无文字标签，
唯一说明在**原生 title**（悬停 1s 后才出现），且 `title` 在触屏/键盘下不存在。
7 个面板图标全部是抽象 lucide 图标（Workflow / ClipboardList / Network / ShieldCheck /
Wand2 / BookOpenText / Type），首次使用基本靠试。

建议（低成本、不改架构）：气泡列顶部加一个 `?` 或首屏一次性提示条：
「单击预览 · 双击固定」；或气泡 hover 时**自绘**一个右侧浮层（需 portal 才能绕开
`overflow-y: auto` 的裁剪，注释里已说明当时放弃的原因）。

### U6 🟡 触控/点击目标偏小

实测：气泡 30×30、发送按钮 26×26、标签关闭 × 16×16、标签高 29。
对比手写台既有走查结论（`docs/reports/ui-audit-2026-09-16.md` D4）一致。
桌面鼠标场景可接受，但如果要上触屏/大屏一体机，建议气泡与发送按钮提到 32–34，
关闭按钮的可点区域（非图标）用 padding 扩到 20×20。

### U7 🟡 键盘焦点的视觉表现不统一

标签页 `[role=tab]` 没有自定义 `:focus-visible`，走浏览器默认（实测 `auto 1px rgb(16,16,16)`）；
暗色档下这条深色细线在深灰底上几乎不可见。`globals.css` 只给 input/textarea/select 做了聚焦态。
建议补一条全局：

```css
:where([role="tab"], button, [tabindex]):focus-visible {
  outline: 2px solid hsl(var(--ring) / 0.75);
  outline-offset: 1px;
}
```

（`--ring` 已是 `0 0% 40%` / 暗档 `0 0% 70%`，两档都能看清。）

### U8 🟡 分页区无主行动按钮（空态只能「去左边说话」）

正文区空态（`05-workbench.png`）只有两行说明，没有按钮。新用户从「新建 AI 项目」进来后，
下一步必须自己想到「在左下角输入框打一句话」。建议在正文与对话两侧的空态各放一个
「写第 1 章」主按钮，点击后**把预设指令填入对话输入框并聚焦**（不自动发送，避免误触额度）。

---

## 四、一致性 / 观感（低优先级）

- **U9** 空态标题层级不一致：对话区「智能体就位」12px 无衬线、正文区「还没有章节」14px 衬线、
  实体面板空态是图标+标题+说明三件套。建议统一一档「空态组件」。
- **U10** 图谱的 minimap：200×150 白底、节点渲染成 6 个灰块，旁边还带一排灰色比例尺
  （`07-chapter-plan.png`、`19-minimap.png`）。空图时它更像一块误入的白板。
  建议：`nodes.length === 0` 时不渲染 minimap；或给它 `opacity-60` + 与卡片同底的描边。
- **U11** 标签栏与正文区之间没有分隔的视觉问题已修（EDITOR_BG 统一），但**标签栏高度 30px**
  + 正文顶部 24px 头部 = 59px 固定占用，窄屏时更明显；目前可接受。
- **U12** 状态栏 5 个角色芯片 + 库中章数 + 分组 + 快捷键提示，字号 10.5px；
  快捷键提示属于「一次性知识」，可考虑移入帮助浮层，给状态栏减负。

---

## 五、建议的修复批次

| 批次 | 内容 | 风险 | 预计改动 |
|---|---|---|---|
| **A（确定性 bug）** | U1 溢出下拉、U2 黄底/黄高光、U3 空态文案、U4 重复空态 | 极低，纯局部 | 5 个文件左右 |
| **B（可读性）** | U2 之后的 4 处对比度 + 规则落地；U7 焦点环 | 低 | ~6 个文件 |
| **C（可发现性）** | U5 气泡操作提示、U8 空态主按钮 | 中（涉及交互） | 3–4 个文件 |
| **D（观感统一）** | U9 空态组件、U10 minimap、U12 状态栏减负 | 低 | 5–8 个文件 |

建议先做 **A**：其中 U1 是功能失效（用户明确点不到东西），U2 是肉眼可见的颜色错误
（字体排版面板整块发黄），两者都值得单独提交。

---

## 六、A 批修复记录（2026-10-22 已实施并复验）

| 编号 | 结论 | 改动 | 复验证据 |
|---|---|---|---|
| U1 | ✅ 已修 | `TabBar.tsx`：溢出下拉 `absolute` → `fixed` + 按钮实测坐标（含视口夹取），并补 `aria-expanded` / `aria-haspopup` | 菜单 `position: fixed`、rect (1692,79,220×192) 全在视口内；`elementFromPoint` 命中菜单项「流水线」；点菜单项成功切到 `chapterPlan` 且菜单关闭 |
| U2 | ✅ 已修 | `hsl(var(--glass-tint\|highlight)` → `rgb(...)`，共 15 处 / 7 个文件（typography、ContinueWriteModal、OutlineCheckModal、aiBars、ErrorBoundary、ToastProvider、globals.css） | 全仓已无 `hsl(var(--glass-tint\|highlight` 残留；字体排版预览块亮色 `rgba(250,250,250,.35)`、暗色 `rgba(255,255,255,.35)`，页面无任何 `rgba(255,255,0)` 元素 |
| U3 | ✅ 已修 | `EntityOverviewPanel.tsx` 空态文案改指本模式可达路径 | 实测文案已变为「流水线跑过『角色与节奏 / 世界圣经』后…」，不再出现「手写台」 |
| U4 | ✅ 已修 | `PipelineGraphPanel.tsx`：未启动时不渲染图谱（起始卡片即全部内容） | 未启动态：起始卡片在、`react-flow` 不存在、「开始立设定」仅出现 1 次、重复空态计数 0 |

类型检查：`pnpm exec tsc -p apps/plugins/auto/workbench/tsconfig.typecheck.json --noEmit` → exit 0。

**顺带记录**：`PipelinePanel.tsx`（列表式旧版）现仅被自己的单测引用，应用路径已全部走
`PipelineGraphPanel`。本次未动它，但它是下一轮「死代码清理」的候选。

---

## 七、B 批修复记录（2026-10-23，真机跑文中修）

跑真实写作时又量了一遍对比度，并顺手修掉亮出来的问题：

| 编号 | 结论 | 改动 | 复验证据 |
|---|---|---|---|
| B1 对比度·面板 | ✅ | typography 面板 3 处 `ink-light / 0.55~0.6` → 全值；workbench 各面板 `muted-foreground / 0.7~0.85` → 全值（9 个文件） | 整页可见文本复测：`<4.5:1` 只剩 2 处，且都是下面 B2/B3 的 |
| B2 对比度·标签副标题 | ✅ | `TabBar` 的「第 N 章 · N 字」由 `text-tone-3` 改 `text-tone-2`（50% → 41%） | 计算值 `rgb(105,105,105)`，5.6:1（原 3.88:1） |
| B3 对比度·气泡徽标 | ✅ | `BubbleRail` 徽标底色统一为墨色药丸（原「已打开」态用 `primary-foreground / 0.28`） | 原实测 **1.04:1**（白字压浅青底、数字几乎不可见）；改后 `rgba(23,23,23,.82)` + 白字 |
| U7 键盘焦点环 | ✅ | `globals.css` 补 `:where(a,button,[role=tab],…):focus-visible` 的 2px `--ring` 描边 | 仅作用于 `:focus-visible`，鼠标点击不受影响 |

留了 2 处不改（有意）：图标色 `muted-foreground / 0.5`、网格描边 `stroke: … / 0.35` —— 它们不是文字。

---

## 八、运行时缺陷（真机跑文发现，非 UI 类）

### R1 🔴 实体沉淀对推理模型**必然失败**（已修）

真机跑第 1 章时：`实体沉淀失败（不影响已交付章节）：Expected ',' or '}' after property
value in JSON at position 3847`，`characters/items/locations/foreshadows` 全 0，
**实体与设定面板永远空**。

对照实验（同一章正文 + 同一提示词，只改预算）：

| max_tokens | finish_reason | 思考 tokens | 正文 | 解析 |
|---|---|---|---|---|
| 4096（原值） | `length` | **4096（占满）** | **0 字符** | 必失败 |
| 8192 | `stop` | 1618 | 4508 | OK |

根因：**推理模型的思考 token 也计入 maxTokens**，4096 被思考吃光。这与
`apps/server/src/plugin/host.ts` 子代理那次「零正文」是同一根因。

修：`entity-sink.ts` 预算 4096 → 8192 + 截断时按 16384 重试一次；
`text.ts` 的 `parseJsonLoose` 报错改为**点名截断**（括号没配平 = 被砍）。
复验：第 2 章交付时「实体沉淀 新建 25 · 更新 0」，面板出节点。

### R2 🟠 伏笔 advance 因「抄不准」被整体丢弃（已修）

第 3–5 章各有一条 `advance` 落库失败：`伏笔「…」未在库中找到同条，advance 未落库`。
但被引用的条目**确实在库里** —— 模型改写/截断了描述（提示词要求原样抄，模型抄了个开头）。

修：`matchForeshadow` 增加「归一化（去标点）」与「单向包含」两级匹配，
**只接受唯一候选**，歧义时仍然拒绝；模糊命中会在 notes 里留痕。
单测 16 → 19 条（新增 3 条回归，含一条「歧义必须拒绝」）。

### R3 🟡 第 1 章的实体补不回来

R1 发生时第 1 章已交付但沉淀全废，且没有回填入口 —— 库里少了该章独有的实体
（如「老周」）。目前**未处理**，需要一次性回填脚本或接受这个缺口。


---

## 附录：本次走查顺手确认「没有问题」的点

- 标签溢出时横向滚动 + 右端下拉的结构本身是对的，坏在裁剪（U1）。
- 标签右键菜单（`fixed`）实测可见可点。
- 亮色档全局低对比文本只有 4 处，远好于 2026-09-16 那次手写台走查。
- 暗色档 token 体系（`light-dark()` + `color-scheme`）切换正常；无整块未换肤的面板。
- 新建 AI 项目的两步表单（开书设定 → 流派选择）校验、回退、标签选择均正常。
