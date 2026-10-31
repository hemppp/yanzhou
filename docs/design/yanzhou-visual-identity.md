# 砚舟 · 视觉身份规范（Visual Identity）

> **状态**：提案（Proposal，待评审）。
> **这份文档是什么**：砚舟「界面长什么样」的**单一真相**，替代 `design-system.md`（那份写的是已废弃的
> 「空山雨后」彩色值，与代码不符，见 §0.2）。
> **这份文档不是什么**：不是组件 API 文档（那是 ui-kit）；不是 ADR（那是
> `docs/architecture/dock-protocol-adr.md`）。
>
> **怎么用**：§3 色板与 §7 反模式是硬约束；§5 迁移表是施工图；§8 是施工顺序。
>
> 关联：[桌面对接协议 ADR](../architecture/dock-protocol-adr.md) ·
> [标签工作区设计](ui-tab-workspace-design.md) · [墨韵工艺层迁移](ink-wash-migration.md)

---

## 0. 先立规矩

### 0.1 这份文档要解决的问题

界面被评价为「土」。经代码走查与实机截图，**根因不是配色不够好看，而是三个结构性缺陷**：

1. **语义色被系统性抽成灰阶**，界面失去信息密度与情绪。
2. **视觉语言照搬 VS Code**，写作产品套了代码编辑器的皮。
3. **设计系统是四代叠加的考古层**，同一概念有多个名字与值，导致全站质感不一致。

### 0.2 与旧文档的替代关系

| 文档 | 处置 | 理由 |
|---|---|---|
| `design-system.md` | **作废**，本文件替代 | 内容为「空山雨后」彩色值（`#EFE9DD` / `#4F918C` / `#C25B3A`），代码早已灰阶化——文档与代码互相矛盾 |
| `ink-wash-migration.md` | 保留为历史 | 记录「水墨→灰阶」的迁移过程，有考古价值，但**不是现行规范** |
| `ui-remodel-t6-adversarial-review.md` | 保留 | 尺寸对齐参考图的实测记录，仍有效 |
| `dock-protocol-adr.md` §5 | **降级** | `--vscode-*` 从「主题真源」降为「别名层 + dockview 映射」，见 §5.3 |

> ⚠️ `design-system.md` 里描述的 `card-mist` / `input-mist` / `BambooMistBackground` /
> `animate-mist-drift` / `animate-tree-sway` / `themes.css` / `html[data-theme="soot"]`
> **在仓库里已全部不存在**（实测）。照那份文档写代码会得到不存在的类名。

---

## 1. 诊断：为什么现在像模板

### 1.1 证据

| 画面 | 观感 |
|---|---|
| 登录页 | 居中卡片 + 一个蓝按钮（`--primary: 209 100% 40%`，即 VS Code 默认蓝） |
| 书架 | 书封是**灰渐变 + 灰 SVG 山/水**，题材胶囊也是灰的 |
| 工作台 | 左侧约 14 个同款线性图标的活动栏、33px 标签条、底部状态栏 |
| 落地页 | monospace 眉标「— 砚舟 —」+ 居中大标题 + 副标题 + 双按钮 + 产品截图 |

### 1.2 量化

```text
globals.css              2580 行 / 104 KB
其中 --var 定义            246 个
其中纯灰阶（0 0% N）        111 个   ← 45%
```

- `--cinnabar: 0 0% 18%` —— **朱砂被定义成了灰色**。
- `--mountain-*` `--mist-*` `--entity-*` `--agent-*` `--chapter-*` —— 全部 `0 0% N`，
  靠「深浅」而非「色相」区分。
- `text-[10px]` 全仓 **379 处** —— 真正的字号地板是 10px，而 `globals.css` 注释里写的是 11px。
- `.mc-eyebrow` 官方组件 = **monospace + 10px + 字距展开**，正是生成式页面的典型指纹。

### 1.3 四个根因

**根因 1 · 灰阶化。** 无彩色 = 无信息密度、无情绪。写作产品卖的是情绪——用户打开它是为了
进入一种心境。实体分类、Agent 分类、章节区分全部靠灰度深浅，肉眼几乎无法区分。

**根因 2 · Cosplay VS Code。** `--dv-border-radius: 0px`、33px 标签条、同款线性图标活动栏、
状态栏——这套皮是微软为**读代码**设计的语言。搬进小说写作工具后，
**工作台里没有一个元素在说「这是写小说的」**。像穿了别人的制服。

**根因 3 · 四代叠加。** 同一概念有 5 个名字、5 套值：

```text
第 1 代  shadcn        --background / --primary / --card / --radius
第 2 代  墨韵工艺层     --paper-* / --tone-* / --r-* / --shadow-* / --sig-* / --space-*
第 3 代  VS Code       --vscode-*  (118 个)
第 4 代  遗留别名       --ink* / --mountain-* / --mist-* / --cinnabar / --chapter-* / --entity-*
```

后果：改一处不生效。注释自己记着事故——popover 一度「有形无皮」（缺 token）、
`--ink*` 有 187 处消费点删不掉。

**根因 4 · 落地页是生成式模板的标准脸。** 眉标 + 居中大标题 + 副标题 + 双按钮 + 产品截图；
功能卡用 `01/02/03`（但内容**不是序列**）；GSAP 给**每个 section** 都做 fade-and-slide-up。

---

## 2. 身份：绢本设色

不从「该抄哪个设计系统」出发。从**文房**出发——**绢、墨、石青、石绿、赭石、朱砂**，
这是中国绘画真实存在的材料语言，也是别人抄不走的色彩词汇。

**一句话身份**：*一块冷调的绢，一支墨，一枚朱砂印。*

| 要素 | 立场 |
|---|---|
| 底 | **冷调绢白**，非暖奶油。刻意避开 `#F4F1EA` 类暖底 |
| 墨 | **偏绿的墨黑**（`#1c211e`），非 `#0B0B0B` 类中性近黑 |
| 结构色 | **石青**——链接、选中、结构线、AI 相关 |
| 强调色 | **朱砂，且只有一个时刻**——「印」：保存完成 / 当前焦点 / 危险 |
| 唯一记得住的东西 | **朱砂印**。章节保存/定稿时落一枚印。全场安静，只此一处出声 |

> **克制原则**：把大胆花在一个地方。到处都在用强调色 = 没有强调色。

---

## 3. 色板

> 存储形态沿用现有约定：**HSL 三元组**（`h s% l%`），消费点写 `hsl(var(--x))`。
> 下方 hex 供设计工具与文档参考，**不得直接写进代码**。

### 3.1 锚点（亮档）

底 = `--yz-ground` `#f2f4f1`

| 令牌 | HSL | hex | 对比度 | 用途 |
|---|---|---|---|---|
| `--yz-ground` | `96 10% 95%` | `#f2f4f1` | — | 页面底（绢） |
| `--yz-surface` | `96 14% 97.5%` | `#f8faf8` | 1.05 | 卡片 / 面板面 |
| `--yz-sunken` | `96 9% 91%` | `#e8eae6` | 1.09 | 内嵌块 / 行 hover |
| `--yz-ink` | `140 9% 12%` | `#1c211e` | **14.77** | 前景·主（墨） |
| `--yz-ink-2` | `140 7% 33%` | `#4e5a52` | 6.53 | 前景·次 |
| `--yz-ink-3` | `140 5% 50%` | `#79867d` | 3.44 | 前景·弱 / 占位 ⚠️ |
| `--yz-line` | `96 9% 85%` | `#d8dcd5` | 1.26 | 常规勾线 |
| `--yz-line-strong` | `96 11% 68%` | `#acb6a4` | 1.90 | 强勾线（聚焦/选中） |
| `--yz-azurite` | `196 46% 33%` | `#2d667b` | **5.76** | 结构色：链接 / 选中 / AI |
| `--yz-azurite-hover` | `196 44% 42%` | `#3c819a` | 3.96 | 结构色·悬停 |
| `--yz-cinnabar` | `9 66% 45%` | `#be3e27` | **4.86** | **唯一强调**：印 / 危险 |
| `--yz-malachite` | `152 32% 33%` | `#396f56` | **5.30** | 成功 / 完成 |
| `--yz-ochre` | `32 50% 38%` | `#916430` | **4.67** | 警示 / 待审批 |

### 3.2 锚点（暗档）

底 = `--yz-ground` `#181b1a`

| 令牌 | HSL | hex | 对比度 |
|---|---|---|---|
| `--yz-ground` | `150 7% 10%` | `#181b1a` | — |
| `--yz-surface` | `150 6% 13%` | `#1f2321` | 1.09 |
| `--yz-sunken` | `150 8% 8%` | `#131614` | 1.05 |
| `--yz-ink` | `96 12% 90%` | `#e5e9e2` | **14.11** |
| `--yz-ink-2` | `96 8% 68%` | `#acb4a7` | 8.13 |
| `--yz-ink-3` | `96 6% 52%` | `#838c7d` | 4.97 |
| `--yz-line` | `150 7% 22%` | `#343c38` | 1.53 |
| `--yz-line-strong` | `150 8% 34%` | `#505e57` | 2.54 |
| `--yz-azurite` | `196 45% 62%` | `#72b2ca` | **7.38** |
| `--yz-cinnabar` | `9 62% 62%` | `#da7462` | **5.50** |
| `--yz-malachite` | `152 32% 60%` | `#78ba9b` | **7.68** |
| `--yz-ochre` | `32 45% 64%` | `#cda67a` | **7.71** |

### 3.3 推导规则（不要为每个场景写死值）

一个语义变量 + `color-mix()` 推导，优于为每个场景硬编码。**只有锚点可以写字面色值**，
其余一律推导：

```css
/* 淡底：任何锚点 → 10% 浓度铺在纸面上 */
--yz-azurite-tint:  color-mix(in srgb, hsl(var(--yz-azurite)) 10%, var(--yz-ground));

/* 悬停边：锚点 35% 混纸面 */
--yz-line-hover:    color-mix(in srgb, hsl(var(--yz-ink)) 35%, var(--yz-ground));

/* 封面墨浓度：已有先例，沿用 --cover-wash-scale 的思路 */
/* ⚠️ calc 里 % × % 非法，倍率必须无单位 */
```

> 现有代码已经在 `--cover-fg` 系列用这套手法（一个变量推全部透明度），保持。

### 3.4 对比度门槛

| 场景 | 门槛 | 说明 |
|---|---|---|
| 正文 | ≥ 4.5:1 | AA |
| 大字号（≥18px 或 ≥14px 粗体） | ≥ 3:1 | AA Large |
| 非文字（边框、图标轮廓） | ≥ 3:1 | 1.4.11 |
| `--yz-ink-3` | **不得单独承载信息** | 亮档 3.44，不过 AA。仅限辅助/占位 |

> `--yz-ink-3` 亮档 3.44:1 —— 这是**刻意的**，与现有 `--tone-3` 的规则一致
> （原文：凡是唯一承载信息的文字，不得使用 `--tone-3`）。保留这条纪律。

---

## 4. 字体与字号阶梯

### 4.1 字体角色

| 角色 | 字体 | 用在哪 | 禁止用在哪 |
|---|---|---|---|
| **界面 sans** | 现有系统栈（`-apple-system` → `PingFang SC` → `MiSans` → `HarmonyOS Sans SC`） | 一切 UI 骨架 | — |
| **文学 serif** | `Noto Serif SC` / `Source Han Serif SC` | 书名、章标题、卷首、封面文字、**编辑器正文** | UI 骨架、按钮、表格 |
| **等宽 mono** | `JetBrains Mono` | 数据对齐、代码 | ⚠️ **禁止用于眉标/标签**（见 §7） |

> 系统栈是**优点**，保留：零 webfont 请求、原生渲染、中文在各平台都是本机最优字形。
> 不必为了「设计感」引 web font。

### 4.2 字号阶梯（废止 `text-[10px]`）

现状：`text-[10px]` 379 处、`text-[11px]` 73 处、`text-[12px]` 19 处。
**10px 在当代高 DPI 屏上不可读**，且是「廉价感」的直接来源。

| 档位 | 值 | 用途 | 现状对应 |
|---|---|---|---|
| `2xs` | **11px** | 元信息 / 表格数字 / 密排区标签（**新地板**） | 原 `text-[10px]` |
| `xs` | **12px** | 标签 / 辅助文字 | 原 `text-[11px]` |
| `sm` | **13px** | 界面正文（= `--vscode-font-size`，保持一致） | 原 `text-[12px]` |
| `base` | **14px** | 面板正文 / 列表主文本 | 新 |
| `lg` | **16px** | 面板标题 | 新 |
| `xl` | **20px** | 章节标题 / 分区标题 | 零星硬编码 |
| `2xl` | **26px** | 页面标题 | 新 |
| `3xl` | **34px** | 书名 / Hero | 落地页大标题 |

**编辑器正文单独一档**（阅读散文需要比 UI 更大）：

```css
--yz-manuscript-size: 17px;
--yz-manuscript-leading: 1.9;   /* 中文正文行高 ≥ 1.75 */
--yz-manuscript-measure: 42em;  /* 限宽，约 40–45 汉字/行 */
```

### 4.3 硬规则

1. **正文行高 ≥ 1.6**，中文 ≥ 1.75。
2. **单行长度 < 80 字符**（中文约 40 字）。界面左对齐，不居中（Hero 除外）。
3. **字距只在 ≥ 20px 的标题上展开**（`letter-spacing`）。正文与 UI 一律默认。
4. **禁止全大写**（中文无此概念，故只在英文标签上禁止）。
5. **`tabular-nums` 用于一切计数**（已有 `.mc-num`，保留）。

---

## 5. token 层 4→1 迁移表

### 5.1 目标形态

```text
                    ┌──────────────────────────────┐
   唯一真源          │  --yz-*  (本文 §3 / §4)       │   ← 只有这里写字面值
                    └──────────────┬───────────────┘
                                   │ 全部别名
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
   shadcn 层                  --vscode-* 层              遗留别名层
   (组件消费)                  (含 dockview 映射)          (--ink* 等)
```

**核心原则：消费者零改动。** 不重命名任何消费点，只把既有名字的**值**指向 `--yz-*`。
仓库已经在用这个手法（`--paper: var(--card)`、`--mountain-*: var(--vscode-*)`），
本规范只是把它推到彻底。

### 5.2 为什么要这样做（而不是删掉旧名）

实测消费点分布：

| token 族 | 消费点 | 处置 |
|---|---|---|
| `--glass-*` | **267** | 保留名字，值重定 |
| `--vscode-*` | **254** | 保留（dockview 依赖），值 → 别名 `--yz-*` |
| `--ink*` | **196** | 保留名字，值 → 别名 |
| `--state-*` | 101 | 保留名字，值重映射（§5.4） |
| `--r-*` | 87 | 保留名字 |
| `--mountain-*` | 60 | 保留名字，值 → `--yz-azurite` 家族 |
| `--paper-*` | 46 | 保留名字，值 → `--yz-*` |
| `--ink-pale` | 34 | 保留 |
| `--entity-*` | 29 | 保留名字，值重映射（§5.4） |
| `--tone*` | 23 | 保留名字，值 → `--yz-ink-*` |
| `--mist-*` | 23 | 保留名字，值 → `--yz-azurite` 家族 |
| `--cinnabar` | 21 | 保留名字，值 → `--yz-cinnabar` |
| `--chapter-*` | 19 | 保留名字，值重映射（§5.4） |
| `--agent-*` | 15 | 保留名字，值重映射（§5.4） |
| `--ochre` | 12 | 保留名字，值 → `--yz-ochre` |
| `--sig-*` | 10 | 保留名字，值 → `--yz-*`（§5.4） |
| `--willow` | 5 | 保留名字，值 → `--yz-malachite` |

> 重命名 1000+ 处消费点是**高风险低收益**的动作，且会与 ADR §6.5 的「类名保留换值」
> 约定冲突。别名化是同一目的下成本最低的路径。

### 5.3 真源落位

```
新增  apps/plugins/shared/ui-kit/src/styles/identity.css   ← --yz-* 唯一真源
改     vscode-dark-modern.css                              ← 118 个 --vscode-* 全部改指 --yz-*
改     apps/web/src/styles/globals.css                     ← 四层旧值全部改指 --yz-*
```

`identity.css` 在 `main.tsx` 里**最先**引入（早于 `vscode-dark-modern.css` 与 `globals.css`）。

`--vscode-*` **保留全部 118 个名字**，理由：`dock-theme.css`（1016 行）与 dockview
主题接线依赖它们，且 ADR §5.5 已冻结 `.dv-theme-vscode` 映射。**只改值，不删名**。

### 5.4 语义层重映射（这是「回魂」的核心）

> 原则：**不做彩虹，也不做全灰。** 3 个强调色 + 墨阶，类别靠「墨阶 + 单一色相倾向」区分。

**实体分类（6 类）**

| 令牌 | 现（灰） | 新 | 理由 |
|---|---|---|---|
| `--entity-character` | `0 0% 12%` | **azurite** | 最常用，给结构色 |
| `--entity-location` | `0 0% 26%` | **malachite** | 地理 = 绿，符合直觉 |
| `--entity-item` | `0 0% 36%` | **ochre** | 器物 = 土色 |
| `--entity-foreshadow` | `0 0% 46%` | **cinnabar** | 伏笔 = 需要记住的记号 |
| `--entity-event` | `0 0% 58%` | ink-2 | 时间轴事件，退到次要 |
| `--entity-outline` | `0 0% 68%` | ink-3 | 骨架信息，最轻 |

**Agent（5 类）** —— 同一族，读作「同类事物」

| 令牌 | 现（灰） | 新 |
|---|---|---|
| `--agent-plot` | `0 0% 20%` | azurite L26% |
| `--agent-character` | `0 0% 30%` | azurite L33% |
| `--agent-continuity` | `0 0% 40%` | azurite L40% |
| `--agent-convener` | `0 0% 50%` | azurite L47% |
| `--agent-writer` | `0 0% 8%` | **cinnabar**（落笔者 = 印） |

**状态（4 类）** —— 与既有 `--sig-*` 合并，**收敛为一套**

| 令牌 | 现 | 新 | `--sig-*` 合并到 |
|---|---|---|---|
| `--state-idle` | `0 0% 72%` | ink-3 | — |
| `--state-running` | `0 0% 40%` | **azurite** | `--sig-run` |
| `--state-done` | `0 0% 14%` | **malachite** | `--sig-done` |
| `--state-blocked` | `0 0% 8%` | **cinnabar** | `--sig-stop` |
| （无对应 state） | `36 32% 38%` | **ochre** | `--sig-warn`（待审批/存疑） |

> `--sig-*` 与 `--state-*` 是**同一件事的两套名字**（前者用于流式/信号，后者用于阶段推进）。
> 合并为一套：`--sig-*` 保留名字、值改指 §3 锚点；`--state-*` 成为它的语义别名。
> 这是「四层收敛为一层」里收益最直接的一处 —— 状态色是用户最常看到的颜色。

**章节（8 档）** —— 全色轮是反模式。改走**石青→石绿单弧段**的 8 档明度渐变：

```css
--chapter-1: 196 46% 30%;   /* 石青最重 */
--chapter-2: 196 44% 36%;
--chapter-3: 190 40% 42%;
--chapter-4: 178 38% 46%;
--chapter-5: 166 36% 49%;
--chapter-6: 160 34% 54%;
--chapter-7: 154 32% 60%;
--chapter-8: 150 30% 66%;   /* 石绿最淡 */
```

> ⚠️ 章节色是**分类色块 / 圆点**，不是文字色。第 8 档（L66%）在纸面上对比度约 2.0:1
> —— 作为色标够用，**若其上要压文字，必须换成 `--yz-ink`**。
> 分类色的门槛是「彼此可区分」，不是「对底 4.5:1」。

### 5.5 shadcn 层映射（组件唯一入口）

```css
--background:      var(--yz-ground);      --foreground:       var(--yz-ink);
--card:            var(--yz-surface);     --card-foreground:  var(--yz-ink);
--popover:         var(--yz-surface);     --popover-foreground: var(--yz-ink);
--primary:         var(--yz-azurite);     --primary-foreground: 0 0% 100%;
--secondary:       var(--yz-sunken);      --muted:            var(--yz-sunken);
--muted-foreground: var(--yz-ink-2);      --accent:           var(--yz-sunken);
--destructive:     var(--yz-cinnabar);    --destructive-foreground: 0 0% 98%;
--border:          var(--yz-line);        --input:            var(--yz-line);
--ring:            var(--yz-azurite);
```

---

## 6. 动效预算

### 6.1 现状：超支

`tailwind.config.js` 注册了 **13 个动画**，另有 GSAP（落地页 **7 个** `ScrollTrigger.batch`）
+ framer-motion + three.js。

多数是**装饰性**的：`float` / `pulse-glow` / `gradient-flow` / `rotate-in` /
`spring-scale` —— 与内容无关的循环动效。

> 原则：**非用户触发的动效要少而准。** 一个编排好的入场序列，胜过散落各处的淡入上移。
> 「每个 section 都 fade-and-slide-up」正是生成式页面的默认动作。

### 6.2 三档时长

| 档 | 时长 | 用途 |
|---|---|---|
| 微 | **120ms** | 悬停 / 按压 / 焦点（`ease-out`） |
| 中 | **200ms** | 浮层 / 面板 / 展开收起（`--ease-link`，已有） |
| 大 | **320ms** | 页面转场（上限，不得更长） |

### 6.3 保留 / 废止

**保留**（都在表达「什么变了」）

- 微交互反馈：hover / active / focus-visible
- 结构变化：展开收起（`.mc-collapse` 的 `0fr→1fr` 手法很好，保留）、标签切换
- 状态反馈：**朱砂印落下的那一刻**（唯一允许的强调动效）
- 骨架屏 `shimmer`

**废止**

| 动画 | 理由 |
|---|---|
| `float` / `pulse-glow` / `pulse-glow-enhanced` / `gradient-flow` | 纯装饰循环 |
| 落地页每个 section 的 `fade-and-slide-up` | 收敛为**一次**入场编排 |
| `rotate-in` / `spring-scale` | 与「克制」立场冲突 |
| `text-reveal`（模糊清除） | 文案不应被延迟阅读 |

**保留上限**：落地页 ≤ 1 个 GSAP 编排序列。

### 6.4 `prefers-reduced-motion`

现状**已部分处理**（`globals.css` 5 处、`landing.css`、`BookshelfPage.tsx`、`Graph3D.tsx`）。
**补齐**：任何新增动效必须同时写 `@media (prefers-reduced-motion: reduce)` 降级。

---

## 7. 反模式清单（禁止项）

> 评审时可直接拿这张表打勾。违反即为返工。

| # | 禁止 | 为什么 |
|---|---|---|
| 1 | **用灰色顶替语义色**（如 `--cinnabar: 0 0% 18%`） | 本规范要修的核心问题。语义色必须有相位 |
| 2 | **`text-[10px]` 及以下的正文** | 高 DPI 屏不可读；地板为 11px |
| 3 | **`.mc-eyebrow` 式眉标**（monospace + 全大写 + 展开字距） | 生成式页面头号指纹 |
| 4 | **非序列内容上的 `01 / 02 / 03`** | 编号是**结构信息**，只用于真正的序列 |
| 5 | **一页内多于一个朱砂** | 强调色只有一个。多了就没有强调 |
| 6 | **`#0B0B0B` / `#111` 类中性近黑** | 用 `--yz-ink`（偏绿墨黑） |
| 7 | **暖奶油底 + 衬线 + 赤陶色** | 生成式设计最集中聚集的组合 |
| 8 | **6 类实体配 6 种色相** | 走向彩虹，与「全灰」是同一个病的两面 |
| 9 | **新增字面色值**（`#xxxxxx` / `rgb()`） | 违反 ADR §5.4 C-2。锚点除外，且只在 `identity.css` |
| 10 | **装饰性循环动画**（float / pulse-glow / gradient-flow） | 见 §6.3 |
| 11 | **在 `tsx` 里写 `style={{ borderRadius: 20 }}`** | 内联样式优先级最高，主题改不动。用 `--r-*` |
| 12 | **`var(--x, #fff)` 兜底** | ADR §5.4 C-3：兜底把「token 缺失」退化成静默错色 |
| 13 | **编号/计数不用 `tabular-nums`** | 数字会跳动 |
| 14 | **正文行长远超 80 字符** | 阅读疲劳 |
| 15 | **只保留 `:hover`、不写 `:focus-visible`** | 键盘可达性 |

---

## 8. 落地顺序与验收

| 阶段 | 内容 | 影响面 | 风险 |
|---|---|---|---|
| **P0** ✅ | 建 `identity.css`；`globals.css` 锚点与语义层换值 | 2 个 CSS 文件，**0 个组件** | 低 |
| **P1** ✅ | `vscode-dark-modern.css` 全量别名化（含 shadcn 变量位） | 1 个 CSS 文件 | 低 |
| **P2** | 字号阶梯落地：`text-[10px]` → `text-2xs`(11px)；删 `text-[11px]`→`xs` | 379 + 73 处（可脚本化） | 中 |
| **P3** ✅ | 落地页去模板脸（删眉标 / 斜体染色 / 卡片改纵列 / 动效 7→2） | 1 页 | 中 |
| **P4** | 工作台外壳：活动栏 14 图标 → 3 组收纳；圆角统一 | 外壳组件 | 中 |
| **P5** ✅ | 书封：灰渐变 → 绢本设色（8 套重新分布色相 + 拉开深度） | `BookCover.tsx` + `BookCard.tsx` + 遮罩 token | 中 |
| **P6** | 朱砂印（保存/定稿落印） | 编辑器状态区 | 低 |

### 验收口径

1. **没有灰顶语义**：`grep -cE "^\s*--(cinnabar|willow|ochre|entity-|agent-|chapter-|state-):\s*0 0%"` = 0
2. **没有 10px 正文**：`grep -rho "text-\[10px\]" | wc -l` = 0
3. **只有一层真源**：字面色值只出现在 `identity.css`
4. **对比度**：§3.4 全部达标（正文 ≥ 4.5:1）
5. **动效**：`prefers-reduced-motion` 覆盖所有新增动效
6. **视觉验收**：登录 / 书架 / 工作台 / 落地页 四屏截图对比

---

## 附录 A · 现状全量 token 清单（2026-10-30 实测）

```text
shadcn 层 (22)     --background --foreground --card --card-foreground --popover
                   --popover-foreground --primary --primary-foreground --secondary
                   --secondary-foreground --muted --muted-foreground --accent
                   --accent-foreground --destructive --destructive-foreground
                   --border --input --ring --radius --radius-lg --radius-xl

墨韵工艺层         --paper --paper-canvas --paper-inset --paper-field --paper-hover
                   --paper-hover-2 --paper-line --paper-line-strong --paper-line-soft
                   --tone --tone-2 --tone-3
                   --r-pill --r-lg --r-md --r-sm --r-xs --r-2xs --r-3xs
                   --radius-chip --radius-control --radius-card --radius-window
                   --shadow-hairline --shadow-card --shadow-raised --shadow-overlay
                   --shadow-btn --shadow-inset-field
                   --ease-link --ease-out-strong --ease-in-out-strong
                   --sig-run --sig-done --sig-warn --sig-stop (+ -tint ×4)
                   --space-0 … --space-10 (11 档)

遗留别名           --mountain-cyan --mountain-light --mountain-deep --mountain-pale
                   --mist-blue --mist-pale --mist-deep
                   --ink --ink-light --ink-pale
                   --cinnabar --cinnabar-pale --willow --willow-pale
                   --ochre --ochre-pale
                   --entity-{character,location,item,foreshadow,event,outline}
                   --agent-{plot,character,continuity,convener,writer}
                   --state-{idle,running,done,blocked}
                   --chapter-1 … --chapter-8

封面               --cover-{ink,paper,line,decor,seal,wash-scale,fg,decor-alpha,scrim,scrim-opacity}
                   --cover-{title,meta,chip-fg,chip-bg,chip-border,stats-fg,stats-bg,stats-border}-alpha
                   --cover-title-shadow

玻璃               --glass-{blur,saturate,tint,highlight,shadow}
                   --glass-{surface,panel,frost,strong,modal}-{bg,border,highlight}
                   --glass-light-x --glass-light-y

VS Code (118)      --vscode-*  （见 vscode-dark-modern.css）

打印               --nm-page-w --nm-page-h --nm-page-margin --nm-page-gap --nm-page-fit
                   --nm-page-content-w --nm-page-content-h --nm-page-col-gap
```

**组件类前缀现状（三代混淆，长期需收敛）**：`.nm-*`（NovelMuse 期）/ `.mc-*`（墨韵期）/
`.glass-*`（玻璃期）。
