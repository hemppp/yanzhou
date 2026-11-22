# 多智能体协作写作流水线 · 设计

> 面向需求：「作者填完开书信息 → 角色分析（定节拍节奏）→ 用户确认 → 策划设定世界观/人物/势力 → 用户拍板 →
> 剧情设计（走向/节奏/节拍/张力）→ 总结 → 用户确认 → 各智能体核查偏离 → 写作智能体派子代理写前三章 →
> 团队审阅 → 用户确认 → 写作监工 + 每三章回剧情智能体确认」。
>
> 本文是**设计**（现状 + 目标 + 施工拆分），不是已完成实现的说明。落笔日期 2026-09-13。

---

## 0. 实施状态（M1 已完成并真机验证，2026-09-13）

**能用了**：`brief → cast → bible → plot` 四段可跑，前三段有用户闸门（G1/G2/G3），
批准后才落库，落库进 `characters` / `outline_nodes` / `foreshadows`。

已落地的文件：

```
apps/plugins/local/novel.autowrite/server/pipeline/
├── types.ts          阶段/事件/闸门三态/上限常量
├── store.ts          KV 状态机 + briefHash + 闸门台账 + canRun 守卫
├── roles-phase.ts    阶段档位（PHASE_SPEC + roleFor）+ 3 段定稿官契约 + 新增「策划官」
├── orchestrator.ts   runStage（讨论→收敛→等确认）/ approveStage（抽取→落库）
├── sink.ts           契约文本 → 结构化抽取 → 保守 upsert（只增/只补空/精确名称去重）
└── store.test.ts     19 例状态机单测（零模型成本）
apps/web/src/services/ai/pipelineSession.ts     前端客户端（REST + SSE）
apps/web/src/components/layout/PipelinePanel.tsx 进度步进条 + 闸门审批卡
```

验证方式与结果（都能复跑）：

| 验证 | 命令 | 结果 |
|---|---|---|
| 状态机纯逻辑 | `vitest run server/pipeline` | 19 例通过 |
| HTTP 集成（零模型成本） | `node scripts/verify-pipeline-api.mjs` | 16 项通过 |
| **真机全链路**（走真模型） | `node .workbuddy/ui-checks/reset-and-plan.mjs` + `chrome.mjs` | 2m35s 跑完 cast 段：角色宪章产出 → 闸门 → 批准 → 落库 3 个角色（陈默/主角、苏晚+陆离/女主，与 brief 的多女主名单一致），零控制台报错 |

**M1 期间踩到并已修的坑**（都已写进代码注释/单测）：

1. `canRun` 最初只判断「该阶段 idle」→ **跳着跑也放行**，一次误操作真跑掉一整段讨论（花了额度）。
   正确口径是「不能超过游标」。
2. 主按钮/拒绝态之类的 UI 假象不在此列，但**状态机里 reject 没重置本段状态** →
   出现「游标已回到上一段、这一段还挂着等确认」的鬼状态。
3. 错误体写成裸字符串 `{error:'人话'}` → 前端 `apiClient` 只读 `body.error.message`，
   界面上会退化成「请求失败(400)」。已统一成信封 `{error:{code,message}}`。
4. 前端 `apiClient` **自带 `/api` 前缀**：路径里再写一遍就成了 `/api/api/...`（实测 404）；
   而 SSE 走裸 fetch 必须写全路径 —— 两个 base 常量不能混用。
5. `brief` 段没有闸门（作者刚填完，再让他确认自己填的东西是多余的）→ 只发 `stage_skipped`，
   不发 `awaiting_user`。**闸门只挂在 cast/bible/plot/pilot。**

**M2 进度（2026-09-13 晚）**：
- ✅ **Stage4 偏离核查（drift）已实现并真机验证** —— 见 §4 Stage4 与本文末「drift 实现记录」
- ✅ **Stage5 前三章试写 + 跨章审阅已实现并真机验证** —— 见 §4 Stage5 与本文末「pilot 实现记录」

**M3 进度（2026-09-29）**：
- ✅ **Stage6 长跑（production）已实现** —— `pipeline/production.ts`：逐章跑单章闭环 +
  **写作监工**（每章只读巡检，`halt` 或连续两次 `watch` 才打断）+ **每 3 章轨迹确认**
  （`on_track` / `minor_drift` 带补丁 / `major_drift` 暂停整条流水线）+ **断点续跑**
  （游标 `cursor.lastDelivered` 与 `sinceReview` 落 KV，进程被杀从游标 +1 接）。
  一段一批（`PRODUCTION_BATCH=5` 章），作者再点一次接着写。
- ✅ **台账回放 UI 已补** —— `GET /pipeline/tracks` + `GET /pipeline/ledger`（含 `tracks`），
  前端 `PipelineGraphPanel` 展示「轨迹确认」台账。
- 守卫：`production` 已进 `IMPLEMENTED_STAGES`，`advance` 到它不再返回 501；
  `canRun` 仍挡"跳着跑"。纯函数层单测 34 例（`production.test.ts`）。
- ⚠️ 真机验证的**模型调用**受中转站网络所限（域名 `new-api.dadfafwada.dpdns.org` 解析失败，
  `Connection error.`）未能跑出正文；状态机已用 SSE 端到端验证（见本文末「production 实现记录」）。

### M1 收尾修复（2026-09-13 二轮）

首轮交付后有 4 处粗糙，已全部补掉：

1. **`running` 锁（重要）**：`StageStatus` 里有 `running`、`canRun` 也拦它，但**没有任何地方写入它** ——
   界面上的按钮禁用只护得住当前标签页，开两个标签页或跑的中途刷新，能对同一段发起第二次（重复烧额度）。
   现在 `runStage` 开头 `store.beginStage()` 先落盘 `running` + `runningSince`。
   ★ 同时补了**僵死兜底**：进程被杀会让某段永久停在 `running`（界面显示"进行中"、`canRun` 又拦着重跑，
   作者彻底卡死）。`store.load()` 里做一次收敛 —— 超过 `RUNNING_STALE_MS`(20 分钟) 的 `running`
   就地改成「失败：上一次运行没有跑完（服务重启或进程被杀）—— 可以重试这一段」。
   只在内存里收敛、靠下一次 save 带下去，所以**所有消费者看到的状态都一致且诚实**。
2. **决策台账界面**：`GET /pipeline/ledger` 一直在写数据，但前端没渲染。面板底部现在列出最近 4 条
   （动作 / 阶段 / 时间 / 批注）。
3. **web 侧单测**：`PipelinePanel.test.tsx` 12 例（状态→界面映射、打回必须带批注、通过要报落库统计并触发刷新、
   未实现段禁用、基线变更标过期、收起态、台账渲染、失败不静默）。
4. **成本提示**：实测一段 ≈ 5 次模型调用 / 1–3 分钟，三段约 15–20 次。启动前与运行按钮上都写出来。

验证：`vitest run server/pipeline` 22 例；**真机** `node scripts/verify-pipeline-stage-lock.mjs`
（★ 会调模型）8 项通过 —— 第二次 advance 被 409「该阶段正在跑」拦住、状态确实落了盘、阶段照样跑完出契约文本。
基线：server 71 例 / web 95 例 / 三处 tsc 全绿。

> 口径提醒：`/pipeline/*` 是**新增**入口，`/session`（单章闭环）完全没动 ——
> 两条路各管一段：「先立设定」走 pipeline，「已有设定、开始写章」走 session。

---

## 0. 先对齐几个词（避免后面歧义）

| 你的说法 | 本文用的名字 | 说明 |
|---|---|---|
| 第二用户填写信息 | **开书信息（Brief Pack）** | ★ 见下方假设 |
| 角色智能体 | `character-designer` | 已有角色，需扩「全书档」 |
| 策划智能体 | `world-architect`（**新增**） | 世界观 / 人物 / 势力 |
| 剧情分析智能体 | `plot-designer` | 已有角色，需扩「全书档」 |
| 总结智能体 | `convener`（定稿官） | 已有，直接复用 |
| 各智能体核查偏离 | **drift check（三层）** | 设定管家为主，全员参与 |
| 写作智能体 / 子代理 | `writer` + **章子代理** | 子代理 = 每章一次独立上下文的调用 |
| 审阅团队 | `reviewer` + 两道门 + **premiere-reviewer** | 前三章要额外做跨章连贯审阅 |
| 写作监工 | `supervisor`（**新增**） | 逐章巡检 + 质量台账 |
| 每三章回剧情智能体 | **track review（轨迹确认）** | 有产出物，不是"我看过了" |

> ★ **假设写明**：需求里的"**第二**用户填写完信息后"，我按「作者在同一处（新书向导 / 编辑书籍）把开书信息填完」
> 理解并设计 —— 因为前一轮刚把这块做成了新书向导（`projects.brief`）。
> 若它实际指的是**第二个人**（协作者 / 责编来填），本设计只需要在一处扩展：所有闸门的「决策人」
> 从 `user.id` 换成 `approvers[]`（见 §7 未决问题 1），流程本身不变。

---

## 1. 一句话目标

把现在「**作者说一句 → 讨论一章 → 交付**」的单章闭环，升级成「**先立设定、再定结构、试写三章、然后长跑**」的
**带闸门流水线**：每一步都有明确产出物、都要作者点头、都要能对照最初意图核查有没有跑偏。

---

## 2. 端到端流程（7 段 · 4 道用户闸门）

```
Stage0 打包     Brief Pack（projects.brief + genre + 作者补充）→ 冻结 briefHash  ← 全局基线
   ↓
Stage1 角色     character-designer 主导：全书角色分析 + 节拍/节奏基线
                → convener 收敛成《角色与节奏宪章》          → G1 用户确认 ★
   ↓
Stage2 世界     world-architect 主导：世界观 / 势力 / 力量体系 / 人物志
                → convener 收敛成《世界圣经》                 → G2 用户拍板 ★
   ↓
Stage3 剧情     plot-designer 主导：走向 / 节奏 / 节拍 / 张力曲线 → 大纲树（act→chapter→beat）
                → convener 汇总《剧情总纲》                   → G3 用户确认 ★
   ↓
Stage4 核查     全员交叉核查：产出物 × brief × 项目库事实 → 偏离报告（硬/软两类）
                → 硬偏离回 Stage 对应段重修；软偏离进《待定》
   ↓
Stage5 试写     写作智能体派 3 个子代理，**串行**写前三章 → 审阅团队（意图门/校对门/润色门 + 跨章连贯）
                →                                            → G4 用户确认 ★
   ↓
Stage6 长跑    逐章写作 + 写作监工逐章巡检；**每 3 章**回 plot-designer 做轨迹确认
```

**闸门三态**（每一道都是这三选一，不是只能"通过"）：

| 动作 | 语义 | 系统行为 |
|---|---|---|
| `approve` | 定稿，进入下一段 | 把该段产出物写进 `baseline` + 落库 |
| `revise` | 带批注打回本段 | 本段重跑（批注进提示词），`revision[stage]++`，**上限 3 次** |
| `reject` | 退回上一段 | 上段重开（作者通常用于"方向就错了"） |

★ **上限 3 次之后怎么办**：不硬撑也不丢弃 —— 把当前产出物 + 未采纳的批注一起交给作者，
明确标注「已达修订上限，按现状继续 / 还是放弃这段」。这条来自实测教训：门类机制一旦"卡死就作废"，
长跑场景会**丢章**（2026-09-12 三章连写丢了 2/7 章），代价远大于带瑕疵继续。

---

## 3. 智能体阵容：**一个角色，多套档位**

这是本设计最关键的取舍：**不新增十几个智能体，而是给已有角色分「档位」（phase-scoped system prompt）**。

理由（都来自现有链路）：五角色的提示词是「说给同伴听的话」的风格，天然适合跨段复用；
而每段真正变化的只是**职责与输出契约**。若给每段都造新角色，会出现十几个近义角色、提示词互相抄、
交流流里 20 个彩色头像 —— 而且同一个"剧情"人格被拆成 3 个后，它记不住自己上一段说过什么。

```ts
// 形态（M1 实际实现：不改动 discussion/roles.ts，另起一张档位表组合）
// server/pipeline/roles-phase.ts
export const PHASE_SPEC: Partial<Record<StageKey, StageSpec>> = {
  cast:  { lead: '角色设计师', speakers: [...], convener: ..., rebuttal: {...} },
  bible: { lead: '策划官',     speakers: [...], convener: ..., rebuttal: {...} },
  plot:  { lead: '剧情设计师', speakers: [...], convener: ..., rebuttal: {...} },
};
/** 同一角色在不同阶段取不同 system（不在档位表里就回退默认 system） */
export function roleFor(role: DesignRole, stage: StageKey): string;
```

> 与最初写的 `DesignRole.phases` 字段略有出入：实现成了一张独立的档位表 + `roleFor()`，
> 好处是**不用碰 `discuss/roles.ts`** —— 那是现役单章链路的热路径，能不动就不动。效果等价。

| 角色 | brief | cast（角色分析） | bible（世界） | plot（剧情） | drift（核查） | pilot/production（写作） |
|---|---|---|---|---|---|---|
| `character-designer` | 读 | **主笔**：全书角色分析 + 节拍节奏基线 | 补人物志 | 评角色动机 | **查角色偏离** | — |
| `world-architect` ★新 | 读 | 提世界约束 | **主笔**：世界观/势力/力量体系 | 查"这个世界能不能发生这件事" | **查设定偏离** | — |
| `plot-designer` | 读 | 提节奏意见 | 提势力冲突面 | **主笔**：走向/节奏/节拍/张力 + 大纲树 | **查剧情偏离** | 三章 / N 章轨迹确认 |
| `continuity-keeper` 设定管家 | 读 | 查空库声明 | 查既有设定 | 查伏笔时机 | **唯一必须查库** | 每章校对门 |
| `convener` 定稿官 | — | 收敛《角色与节奏宪章》 | 收敛《世界圣经》 | 汇总《剧情总纲》 | 合并《偏离报告》 | 收敛《本章结论》（现状） |
| `writer` 写作官 | — | — | — | — | — | **主笔**（子代理池） |
| `premiere-reviewer` ★新 | — | — | — | — | — | 前三章**跨章连贯**审阅 |
| `supervisor` 写作监工 ★新 | — | — | — | — | — | 逐章巡检 + 质量台账 |

**新增 3 个角色**：`world-architect`（策划）、`premiere-reviewer`（前三章审阅）、`supervisor`（监工）。
其余全是给现有角色加档位。

★ `world-architect` 为什么必须是独立角色而不是让 `plot-designer` 兼：扮演约束不同 —— 剧情设计师的职责是"制造冲突"，
策划的职责是"定规则、且规则要能自洽地支撑冲突"。同一个人格同时干这两件事，实测那种写法会**为了爽点随手改设定**
（现有链路能防住这点，靠的是设定管家查库；但"库"里当时根本没有世界规则可查）。

---

## 4. 各段数据契约（输入 / 产出 / 落库 / 事件）

约定：**产出物一律三段式** —— 讨论原文（进交流流留痕）→ 总结官的「契约文本」（人可读、可对照）→ 结构化落库。

### Stage0 · Brief Pack

- 输入：`projects.brief`（开局/世界观/笔风/主角/女主/流派，2026-09-13 已做）+ `projects.genre` + 作者在本步补的话
- 产出：`BriefPack { opening, worldview, style, protagonist, heroines[], genre, freeform }` + **`briefHash`**（`sha256(稳定序列化)`）
- 落库：主库 `projects.brief`（已存在）
- ★ `briefHash` 是**全局基线指纹**：后面所有偏离核查都拿它当锚。作者改了 brief → hash 变 → 已通过的闸门**标记为过期**，
  提示"设定变了，建议重跑 Stage1–3"。这条不做的话，改完设定后旧宪法还在生效，会静默写歪。

### Stage1 · 角色与节奏宪章（cast）

- 主笔 `character-designer`（全书档）+ `plot-designer` 提节奏意见 + `continuity-keeper` 声明"库里确实是空的"
- 总结 `convener` → 《角色与节奏宪章》，固定字段：

```
主角弧光：<起点 → 转折 → 终点，以及每一段"为什么必须这样变">
核心配角：<名字：欲望 / 恐惧 / 与主角的关系演变 / 退场点>
女主（按 brief）：<名字：定位 / 与主角关系的推进节奏 / 是否多线>
对手与压力源：<谁在挡路，力量对比如何变化>
节拍基线：<全书按 N 幕切，每幕的功能与字数占比>
节奏基线：<张—弛—张的呼吸节奏，高潮点落在哪些章>
禁项：<明确不写的东西（含 brief 里的）>
待定：<没谈拢的，写清分歧>
```

- 落库：`characters`（保守 upsert，角色 `role` 字段要正确填 `protagonist|femaleLead|supporting|minor`）
- 事件：`stage_turn`（每次发言）→ `stage_summary` → `awaiting_user{stage:'cast'}`

### Stage2 · 世界圣经（bible）

- 主笔 `world-architect`；产出：
  `世界观`（时代/舞台/规则）、`势力`（≥3 个，各自的诉求与资源）、`力量体系`（代价与上限，**必须写代价**）、
  `地理与资源`、`历史关键点`、`日常质感`（吃什么、怎么通讯、钱怎么算 —— 写不出这个的世界会飘）
- 落库（**零新增表**，全部塞进现有 `outline_nodes`，见下）

| 内容 | 落表 | type | tags |
|---|---|---|---|
| 世界观总条 | `outline_nodes` | `note` | `bible:world` |
| 势力 | `outline_nodes` | `note` | `bible:faction` |
| 力量体系 | `outline_nodes` | `note` | `bible:power` |
| 地理/地点 | `locations` | — | 走现有表（地图面板能画） |

★ 为什么用 `outline_nodes` 的 `note` 型而不是新建 `world_bible` 表：现有 `OutlineNodeType` 已有 `note`，
`outline_nodes` 自带 `title/description/order/tags/parent_id`，语义够用、UI 已有渲染路径、
**且不用碰项目库迁移**（新增项目级字段要同时改 `db/index.ts` 与 `better-sqlite3-adapter.ts` 两处补列，能免则免）。
代价：`tags` 里带 `bible:*` 前缀做区分，查询时按 tag 过滤。若日后要独立的"圣经"面板，再升表不迟。

- 事件：`stage_summary{stage:'bible'}` → `awaiting_user{stage:'bible'}`

### Stage3 · 剧情总纲（plot）

- 主笔 `plot-designer`；产出结构：`幕(act) → 章节段(chapter) → 节拍(beat)`，每级带「张力值 1–10」
- 张力曲线：全书一张 `beat.tension` 序列，约束是"不能连续 4 拍上扬、高潮前后必须有落点"
- 落库：`outline_nodes`（`act` / `chapter` / `beat`）+ 伏笔规划进 `foreshadows`
- 事件：`stage_summary{stage:'plot'}` → `awaiting_user{stage:'plot'}`

### Stage4 · 偏离核查（drift）

三层，从硬到软：

| 层 | 对照物 | 判定 | 处置 |
|---|---|---|---|
| L1 | `brief`（作者原话，hash 锁定） | 硬：违背开局/世界观/笔风/女主设定 | 必报，回对应段重修 |
| L2 | `baseline.cast/bible/plot`（已批准的宪法/圣经/总纲） | 硬：与已拍板内容冲突 | 必报 |
| L3 | 项目库事实（角色状态/伏笔/物品归属） | 软：设定空白或自相矛盾 | 写《待定》交作者 |

★ 核查**不是让一个 agent"看看有没有跑偏"** —— 那种问法必然得到"整体符合"。
做法：**逐条对照清单**（把 brief 拆成 N 条断言，逐条判 `符合/偏离/库中无依据`），
再让 `convener` 合并成报告。这样才有可比对的输出，也才拦得住东西。

### Stage5 · 前三章试写（pilot）

- 写作智能体派 **3 个子代理**，**串行**：

| 子代理 | 输入 | 输出 |
|---|---|---|
| pilot#1 | Brief Pack + 世界圣经 + 第 1 章节拍 | 第 1 章正文 |
| pilot#2 | 上面 + **第 1 章全文** + 第 2 章节拍 | 第 2 章正文 |
| pilot#3 | 上面 + **第 2 章全文** + 第 3 章节拍 | 第 3 章正文 |

★ 必须串行，不能并发：实测"上一章全文强制注入"是跨章连续性最吃紧的一块（`resolvePreviousChapter`），
并发写就等于三章各自开天辟地。

- 团队审阅：每章走现有**意图门 → 校对门 → 润色门**；三章都出稿后加一道 **`premiere-reviewer` 跨章审阅**
  （查：文风是否漂、主角弧光是否按宪章走、伏笔是否只埋不收、三章读下来是否像一本书）
- 落库：`chapters` + 实体沉淀（`entity-sink`，只在真交付后跑）
- 事件：`pilot_chapter{i}/3` → `premiere_review` → `awaiting_user{stage:'pilot'}`

**实现口径（2026-09-13，`pipeline/pilot.ts`）**：

1. **复用单章闭环，不另写写作器**：`runPilot` 逐章调 `discuss/orchestrator.runDiscussion`
   （`chapterOrder` + `finalDone:false`），它带来强制注入上一章全文、三道门、带警示交付、实体沉淀。
   另写一套只会得到两个行为不一致的写作器（改一处漏一处的老问题）。
2. **`pilot` 在 `specFor` 之前分流**：它不是"讨论 → 收敛"型阶段（`PHASE_SPEC` 里没有它），
   走 `runPilotStage` 这个编排壳。
3. **它是唯一"闸门前就落库"的阶段**：试写的产出物就是正文；不落库就没法拿来看，
   也就失去了试写的意义。代价是作者在 G4 否掉时要人工删这三章（权衡后仍值得）。因此：
   - `approveStage('pilot')` **不再去"抽取报告"**（报告是给人读的），只回报试写与落库情况；
   - 之前会走到通用分支，得到一条「结构化抽取失败…本次未落库」的误导性提示（已修）。
4. **验收一律只看库**：`StageRecord.pilotChapters`（三章的 order/delivered/wordCount/warnings）
   与 `premiereVerdict`（pass|minor|major + 问题条数 + 类目）。
   报告可以写得很漂亮，但"交了几章、各多少字、有没有带警示"才是可判定的事实。
5. **跨章审阅的解析不许当 pass**：`parsePremiereReview` 解析不出来 → 兜底 `minor` + 一条 issue，
   把"这次审阅没能解析"显式写进报告。（"没审出问题"与"压根没审"混成一个结果是最糟的失败模式）
6. **harness 级的顺手修补**：`ROLE_WORLD`（策划官）此前**没有 `memory` 字段** → 闸门 fail-closed
   → 它拿到的是**空的项目现状**（连【创作设定】都是空字符串），而立世界规则恰恰最不能凭空造。
   已补策略并登记进 `ALL_MEMORY_ROLES`（不变量测试从 6 例扩到 8 例，新增角色漏登记会被逮住）。
7. `PipelineView` 暴露 `lastDelivered`：长跑从第几章接靠它，验收也靠它（否则只能正则在报告里找 = 假验证）。

### Stage6 · 长跑 + 监工 + 每三章轨迹确认

- 逐章：现有单章闭环（讨论 → 结论 → 落笔 → 篇幅自检 → 三道门 → 交付 → 沉淀）
- **写作监工 `supervisor`**（每章交付后跑一次，只读）：
  输入 = 本章正文 + 本章结论 + 最近 3 章摘要 + 质量台账；输出 = `supervise_report`
  ```json
  { "order": 12, "verdict": "ok|watch|halt",
    "issues": [{ "kind": "rhythm|voice|continuity|filler", "detail": "…", "evidence": "正文片段" }],
    "trend": "本章节奏比前两章更拖（连续 3 章下滑）" }
  ```
  `halt` 才打断（记账：连续两次 `watch` 也算 `halt`）—— 否则长篇跑到第 40 章才发现"越写越水"，重写成本是灾难。
- **轨迹确认（每 3 章）**：回到 `plot-designer`，输入 = 大纲 + 已交付 3 章的正文/摘要 + 伏笔状态 + 监工台账；
  输出三选一，**必须有产出物**：
  - `on_track` → 记一条台账，继续
  - `minor_drift` → 生成"补丁"（接下来 2–3 章的修正点），自动应用并留痕
  - `major_drift` → 暂停整条流水线，出《轨迹偏离报告》请作者决策（这是唯一会打扰用户的地方）
- 事件：`supervise_report` / `track_review{window:"10-12", verdict}`

---

## 5. 状态机与持久化

### 5.1 流水线状态（KV，不碰项目库表）

`plugin_kv`，NS `novel.autowrite`（与现有 `flow-store` 同款约定），key：

```
pipeline:<projectId>        流水线主状态（下面这个对象）
stage_art:<projectId>:<stage>   各阶段产出物全文（宪法/圣经/总纲），供 drift 与重跑对照
supervise:<projectId>:<order>   单章监工报告
track:<projectId>:<order>       轨迹确认记录（每 3 章一条）
decision:<projectId>:<n>        闸门决策台账（谁、何时、批注），append-only
```

```ts
type StageKey = 'brief' | 'cast' | 'bible' | 'plot' | 'drift' | 'pilot' | 'production';
type StageStatus = 'idle' | 'running' | 'awaiting_user' | 'approved' | 'failed';

interface PipelineState {
  projectId: string;
  stage: StageKey;
  status: StageStatus;
  /** 每段的修订计数（撞上限 3 次就交人工，见 §2） */
  revision: Record<StageKey, number>;
  /** Stage0 的基线指纹：brief 一变，已通过的闸门标记过期 */
  briefHash: string;
  /** 已批准的各段契约文本（drift 的 L2 对照物） */
  baseline: { cast?: string; bible?: string; plot?: string };
  /** 长跑游标：sinceReview 到 3 就触发轨迹确认 */
  cursor: { lastDelivered: number; sinceReview: number };
  updatedAt: number;
}
```

★ 为什么状态放 KV 而不是像旧批次流水线那样再搞一套 `FlowStore`：`FlowStore` 是**批次语义**
（`batch:` / `flow:`），而这条流水线是**项目生命周期语义**（一段一次，贯穿全书）。
硬套会得到一堆"批次 1/1"的假概念。所以另起一份精简状态，**且明确不复活 `server/autowrite/*` 那套死代码**
（现状见 handover §2）。

### 5.2 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/plugins/autowrite/pipeline/start` | 启动（或从断点续跑）流水线 |
| `GET` | `/api/plugins/autowrite/pipeline` | 读当前状态 + 各段产出物（工作台挂载时拉一次） |
| `POST` | `/api/plugins/autowrite/pipeline/advance` | 执行当前段（SSE 流式返回） |
| `POST` | `/api/plugins/autowrite/pipeline/decision` | 闸门决策 `{stage, action, note}` |
| `GET` | `/api/plugins/autowrite/pipeline/ledger` | 决策 + 监工 + 轨迹确认台账（回放用） |

★ **推进走 SSE、决策走 POST**：需要用户输入的东西绝不放长连接里等 —— 连接断了状态就悬空，
而且浏览器刷新后无法知道"我到底批没批"。SSE 只负责推事件，决策是一次独立的、可重放的 HTTP 调用。

### 5.3 SSE 事件契约（在现有 `SessionEvent` 上扩）

```ts
| { type: 'stage_start'; stage: StageKey; revision: number }
| { type: 'stage_turn'; stage: StageKey; agent: string; name: string; color: string; short: string; text: string }
| { type: 'stage_summary'; stage: StageKey; text: string }      // 契约文本，进中栏卡片
| { type: 'awaiting_user'; stage: StageKey; summary: string }   // 前端的审批卡就靠它
| { type: 'drift_report'; hard: string[]; soft: string[] }
| { type: 'supervise_report'; order: number; verdict: 'ok'|'watch'|'halt'; issues: string[] }
| { type: 'track_review'; from: number; to: number; verdict: 'on_track'|'minor_drift'|'major_drift'; note: string }
```

前端沿用 `AutoWriteWorkbench` 三栏：左交流流（`stage_turn` 就是发言）、中栏在现有阶段卡上
**加一段「设定/大纲进度」**（7 段 + 4 闸门），右栏 `EntityRail` 不动。
闸门到点 → 中栏弹审批卡（通过 / 带批注打回 / 退回上一段），**带批注打回**要能直接输入文字。

---

## 6. 施工拆分（按"能不能独立验收"切）

### M1 · 骨架 + 前三道闸门（P0）

1. `pipeline/types.ts` — `StageKey` / `PipelineState` / 事件类型
2. `pipeline/store.ts` — KV 读写 + `briefHash` 计算 + 闸门台账 append
3. `pipeline/roles-phase.ts` — 给现有 5 角色加档位（`roleFor()`），新增 `world-architect`
4. `pipeline/orchestrator.ts` — `runStage(ctx, {stage}, emit)`，四个段各自一个函数
5. `server/routes.ts` — 加 5 条 `/pipeline` 路由（SSE 复用现有 `ReadableStream` 骨架）
6. 前端：`pipelineSession.ts`（SSE 客户端）+ 中栏进度条 + 审批卡

**验收**：新建 auto 项目 → 填向导 → 启动流水线 → 三段依次跑完 → 三个闸门都能批/打回 →
`characters` 有角色、`outline_nodes` 有 `bible:*` 与 `act/chapter/beat`。

### M2 · 核查 + 试写（P1）

7. `pipeline/drift.ts` — 三层核查（**逐条断言**式，非"你看有没有跑偏"）
8. 前三章试写（串行）+ `premiere-reviewer` 跨章审阅
9. 第四道闸门

**验收**：三个闸门通过后，前三章入库、字数达标、`premiere_review` 有具体结论；
故意在 brief 里埋一条硬约束，核查能报出来（**这条必测** —— 核查机制不测就等于没有）。

### M3 · 长跑治理（P2）—— ✅ 已完成（2026-09-29）

10. ✅ `supervisor` 逐章巡检 + 台账（`pipeline/production.ts` 的 `runSupervisor`，写 `pipeline_tracks` 之外的逐章台账进报告；监工结论存 `StageRecord.supervisorVerdict`）
11. ✅ 每 3 章轨迹确认（`runTrackReview`，`minor_drift` 生成补丁并注入下一批第一章；`major_drift` 置 `supervisorHalted` 暂停）
12. ✅ **断点续跑**：游标 `cursor.lastDelivered` / `sinceReview` 落 KV，进程被杀从游标 +1 接（`runProductionStage` 读写）
13. ✅ 台账回放 UI（`GET /pipeline/tracks` + `PipelineGraphPanel` 的「轨迹确认」区块）

---

## 7. 风险与未决问题（需要拍板）

| # | 问题 | 选项 / 我的倾向 |
|---|---|---|
| 1 | **"第二用户"是不是第二个人** | 若需要第二个审批人：`decision` 上加 `approvers[]` + 双签；倾向先按单人做，字段留口 |
| 2 | 闸门能不能跳 | 倾向 G1/G2/G3 允许"合并成一次确认"（老作者嫌烦），**G4 不可跳**（它是成本止损线） |
| 3 | 状态放 KV 还是落表 | 倾向 KV（M1 快）；若要台账回放做得深，M3 再迁 `pipeline_runs` 表 —— 那时正好把旧 `FlowStore` 的台账能力一起收编 |
| 4 | "每 3 章"是否可配 | 倾向可配（默认 3，作者可设 5/10） |
| 5 | 子代理并发度 | 倾向**串行**（跨章衔接 > 速度）。实测每章 ~75 秒 / 10–12 次调用，三章约 4 分钟，可接受 |
| 6 | 成本上限 | 一次 Stage0–5 约 25–35 次调用（三段讨论 + 三章 + 审阅）；应在 UI 上先告知量级，别让作者以为按一下就好 |
| 7 | 设定改了怎么办 | `briefHash` 变化 → 标记闸门过期 + 建议重跑；是否**自动**重跑倾向否（作者的钱）|

---

## 8. 复用与不改的东西（防误伤）

**直接复用**：`/session` 的 SSE 骨架与心跳、`resolveSettingsDigest` / `resolvePreviousChapter`（供数防幻觉）、
`entity-sink`（保守 upsert）、三道门 `frameworks/gates.ts`、`runChapters` 的串行循环与"一章失败不拖垮后面"、
前端交流流与 `WorldStateBoard` 的阶段卡累积机制（**按事件累积，不解析文案** —— 这条必须保持）。

**明确不动**：`server/autowrite/*`（旧批次流水线，死代码）本设计不复活；
手写模式（`mode==='manual'`）完全不受影响 —— 新流程只在 `mode==='auto'` 下可见。

**继承的铁律**（写代码前先读 handover §6）：
- 新增任何门都要先想清「它失败时怎么落地」—— 现在的取向是**带警示照常交付**，不丢章
- `ctx.db.project()` 是同步只读、全新项目返回 `null` → 开头必须 `await getProjectDb()`
- 实体匹配只用精确名称；枚举全英文；`maxTokens` 不传等于不设上限（长文必须给足）
- 插件注册资源必须走 `ctx.effect`；Web 面插件是**构建期**收集，改了要重启 vite
- 产出物进 KV/DB 之前**别只信模型的话** —— 结构化落库要过解析校验，解析失败要报错而不是静默跳过
  （校对门曾因 JSON 截断静默变成摆设）


---

## drift 实现记录（M2 · 2026-09-13）

**文件**：`pipeline/drift.ts`（判定与合并**全是纯函数**，可单测）+ `roles-phase.ts` 的 `drift` 档位 + `orchestrator.ts` 的 drift 分支。

**与"假核查"的区别**（这是本段唯一的设计要点）：
- ❌ 不这么问：「你看有没有跑偏」→ 模型必答「整体符合」，等于没查
- ✅ 这么问：把 **brief 按字段拆成断言**（L1-1…L1-6，**确定性生成、零模型调用**），
  再给每个核查角色一张清单，要求**逐条**回 `{verdict: 符合|偏离|库中无依据, evidence, backTo}`

**分层与处置**：
| 层 | 对照物 | 处置 |
|---|---|---|
| L1 | brief 字段（作者原话） | 偏离 = **硬**：回修对应段 |
| L2 | 已批准的 cast/bible/plot（在 header 里） | 偏离 = **硬** |
| L3 | 项目库事实（digest） | 偏离 / 任何层的「库中无依据」= **软**：进《待定》 |

**三处关键取舍（别改乱）**：
1. **合并规则**：同一断言有人判"符合"有人判"偏离" → **按偏离**（核查是"谁发现谁说了算"，不是投票）
2. **认不出的判定词 → 记为「库中无依据」而不是「符合」**：把没查出来的东西显示成"查过了"，
   代价比"进待定被人看见"大一个数量级
3. **drift 无用户闸门**：跑完自动 `approved` 并推进游标；**只有硬偏离**才拦人 ——
   把游标退回建议回修的最早那段（cast→bible→plot 顺序），那段闸门作废，并发 `stage_drift_blocked`

**可验证性**：`StageRecord.driftCounts` 记下「核了几条、几条符合/偏离/无依据、硬/软各几条」——
没有它，没人能验证"核查真的逐条做了"。前端事件 `stage_auto_approved` / `stage_drift_blocked` 已接。

**验证**：
- 单测 `pipeline/drift.test.ts` 11 例（含设计点名的必测项：**埋一条硬约束能被报出来**、
  认不出的词不算符合、编造的 id 被丢弃、回修段取最靠前）
- 真机 `scripts/verify-pipeline-drift.mjs`：brief 里埋「白天绝无电 + 严禁枪支」两条硬约束，
  跑完 cast/bible/plot 审批后再跑 drift，断言逐条统计与游标行为

---

## pilot 实现记录（M2 · 2026-09-13）

**文件**：`pipeline/pilot.ts`（纯函数层可单测 + `runPilot` 编排）+ `roles-phase.ts` 的 `ROLE_PREMIERE`
+ `orchestrator.ts` 的 `runPilotStage` 壳。

**为什么值得单独一道**：三道门**只看一章**。三章各自合格，合起来仍可能不是一个故事的开头。
真机这一跑就把这句话坐实了 —— 跨章审阅报出的 4 处问题里，最具体的一条是：

> 第 2 章与第 3 章在苏晚段落上出现几乎逐句重复的「归档」描写（『她没进任何一家店，也没找水、找吃的』），
> 连读时像回放，削弱推进感。

这条**任何单章门都不可能发现**（每章自己看完全正常），只有"横着读"才看得见。

**真机结果（`scripts/verify-pipeline-pilot.mjs`，全过，用时 291s）**：

| 项 | 结果 |
|---|---|
| 三章落库 | `pilotChapters` = [1,2,3]，`delivered` 全 true、0 章带警示 |
| 字数 | 2935 / 2555 / 3736（`chapters.content` 实测 3091 / 2673 / 3906 字符，口径差 = 标点与空白） |
| 跨章审阅 | `premiereVerdict` = `minor`，4 处问题，类目 `cohesion/foreshadow/arc` |
| G4 闸门 | 停在 `awaiting_user`（试写必须作者看过） |
| 长跑游标 | `lastDelivered === 3` → M3 从第 4 章接 |
| 跨章连续性 | 第 2/3 章正文都出现主角名，且第 2 章没有"重新开篇介绍主角" |

**坑与取舍（都已修）**：
1. `ROLE_WORLD` 没有 `memory` → 闸门 fail-closed → 策划官拿到**空的项目现状**。
   已补并登记（`ALL_MEMORY_ROLES` 6 → 8，测试同步扩）。
2. `approveStage('pilot')` 原本会走通用抽取分支，得到「结构化抽取失败…本次未落库」的误导提示 ——
   pilot 的落库在跑的时候就完成了，批准不该再抽报告的 JSON。
3. `PipelineView` 补 `lastDelivered`：不给这个数，"从第几章接"只能靠正则在报告里找（= 假验证）。
