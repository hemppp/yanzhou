# 用户场景全量验证报告

**日期**：2026-09-14　**范围**：New砚舟 全部用户可走路径（11 个套件）　**结论**：全绿

---

## 一、总览

| 层 | 套件 | 结果 | 关键数字 |
|---|---|---|---|
| 静态 | `verify-all.mjs` → server 单测 | ✅ | 186 例 / 14 文件，16.4s |
| 静态 | 同上 → web 单测 | ✅ | 139 例 / 11 文件，5.8s |
| 静态 | 同上 → 记忆不变量抽查 | ✅ | 不变量全过 |
| 真机·零成本 | `verify-brief-api` | ✅ | 10/10 |
| 真机·零成本 | `verify-skill-library` | ✅ | 约 35 项 |
| 真机·零成本 | `verify-pipeline-api` | ✅ | 18/18 |
| 真机·模型 | `verify-pipeline-stage-lock` | ✅ | 5/5 |
| 真机·模型 | `verify-pipeline-drift` | ✅ | 10 项，逐条 6 断言 |
| 真机·模型 | `verify-pipeline-pilot` | ✅ | 762s，三章 |
| 真机·模型 | `verify-agent-skills-execution` | ✅ | 7/7 |
| 真机·模型 | `verify-autowrite-session` 2 章 | ✅ | 285s |

**前置动作**：旧 server 于 08:30:13 启动，而 `context-resolver.ts` 09:16 才修改 → 原进程跑的是**旧代码**。
按「端口 → PID → 只杀它」停掉（tsx 是父 `cli.mjs` + 子监听两层进程），用 Node 24 重启，新 PID 17524，health 200。

---

## 二、逐层证据

### 1. 开书设定（brief）
`verify-brief-api` 10/10：注册 → 建 auto 项目带 brief → 响应与 `GET /projects` 双向完整往返 →
流派展示名落进 `projects.genre`（`系统流 · 末日求生`）→ 主库列确为 JSON 文本、`mode=auto` →
**改名不带 brief 时已有设定不被冲掉** → 非法 `genreCategory` 被 zod 拦成 400。

### 2. 技能库与开关
`verify-skill-library` 全过：阴性对照（未鉴权 401）、库里有 10 条种子（界面不会是空的）、
归属**解析成智能体名**而不是裸 id、孤儿 0、开关**重新读取仍是开**（真持久化）、
批量开/关逐条生效、**把写作官的技能开给剧情设计师 → 400 并说明原因**、
装到不存在的智能体 → 400、删除后开关记录一起清（不留垃圾）、重复删除 → 404。

### 3. 流水线状态机
`verify-pipeline-api` 18/18：无设定 → 400 人话提示、7 阶段就位、游标停 brief、
**已实现 6 段（brief/cast/bible/plot/drift/pilot）、只剩 production**、闸门只标在 cast/bible/plot/pilot、
跳着跑 → 409、未实现的 production → 501、非游标阶段决策 → 409、brief 段不调模型直接过并推进游标、往回重跑允许且记台账。

### 4. running 锁
`verify-pipeline-stage-lock` 全过：第一次 advance → 200（SSE 建立）→ **状态落盘为 running** →
同段第二次 advance → **409「该阶段正在跑」** → 自然跑完 → `awaiting_user` + 契约 2268 字。

### 5. 偏离核查（drift）
`verify-pipeline-drift` 全过。先跑通 M1 前段（cast/bible/plot 各停在等确认并批准），再跑 drift：

- `driftCounts = {total:6, 符合:5, 偏离:1, 库中无依据:0, hard:1, soft:0}`
- 三类判定之和 === total（**没有"没判"的条目**）
- **真抓到埋进去的硬约束**：brief 说开局是「末日前三小时」，而已定稿的《剧情总纲》《世界圣经》与库中第 1 章条目都把开局钉在「末日第三年白昼」；
  报告指出这是**未决项而非定论**，并给出「建议回修 plot + 需同时改两处故事内时间与第 1 章条目，不能只改一处」
- **无闸门**：跑完即 `approved`；有硬偏离 → 游标**退回 plot**（不是继续往前）

### 6. 前三章试写（pilot）
762 秒，全过：

- `pilotChapters = [1,2,3]`，`delivered = [true,true,true]`
- 字数：第 1 章 3025、第 2 章 5004、第 3 章 3774（均 ≥2500），带警示交付 0 章
- 项目库里真有 3 章，正文长度 3189 / 5234 / 3882
- **第 2、3 章正文都出现主角名「陈默」**，且第 2 章没有重新开篇介绍主角 → 跨章串行注入确实生效
- `premiereVerdict = {verdict:"minor", issues:4, kinds:[arc, foreshadow, cohesion]}`（合法判定）
- 报告含《前三章跨章审阅》，停在 **G4 闸门**（`awaiting_user`），`lastDelivered === 3`

### 7. 技能开关是否真作用到模型
`verify-agent-skills-execution` 全过，三重证据：

1. 装探针技能并开启；**刚装完是关的**（要作者显式开）；**不出现在剧情设计师名下**
2. 跑一章后，**只有写作官**的 turn meta 带 `技能 probe-marker`，同一轮其他 6 次发言
   （剧情设计师 ×2 / 角色设计师 / 设定管家 / 定稿官 / 意图复核）**都没有** → 按智能体分配
3. **正文第一行真的出现 `##SKILL-PROBE-OK##`** —— 这串模型不可能自己编出来，
   出现即证明技能正文真的进了模型看到的 prompt

### 8. 讨论链路端到端写章
`verify-autowrite-session 2`，285s，交付 2 章：

- **第 1 章** 3314 字：篇幅自检补写（2200 → 3314）→ 意图复核 passed → 校对门 passed（未发现冲突）→ 润色门 7 分 → 交付 →
  实体沉淀 created=13 skipped=1
- **第 2 章** 4148 字：意图复核 passed → **校对门 passed=false（4 处冲突）→ 定向修订 → 仍有 4 处冲突 → 按设计「不拦交付，请人工确认」** →
  润色门 8 分 → 交付 → 实体沉淀 **created=11 updated=3 skipped=1，并报出「检测到 1 处同批次矛盾，已拦下并进冲突队列（待裁决）」**
- 落库统计：chapters 2 · characters 5 · items 2 · locations 4 · foreshadows 3 · story_events 10

---

## 三、本次修改

### 修掉两处「假失败」（脚本口径过时，不是产品缺陷）

`scripts/verify-pipeline-api.mjs` 写死于 M2 之前的口径，两项必挂：

1. **「只有 4 个阶段已实现」** → 现状是 6 段（M2 已加上 drift/pilot）。
   改为**跟着实现名单断言**（`brief/cast/bible/plot/drift/pilot`，只剩 `production` 未实现），**不再写死数字**，
   避免每上一个里程碑都要改一次脚本。
2. **「未实现的 drift → 501」** → drift 已上线，再用它当探针会先撞上游标守卫拿回 **409**（看起来像「不能跳着跑」的真 bug）。
   改用**真未实现**的 `production`，稳定得到 501。

顺带核实服务端口径正确：`routes.ts` 是**先判「这段实现没」（501）、再判游标（409）**，注释里也写明了原因（顺序反了会给误导性提示）。

---

## 四、需要作者知道的三件事

1. **第 2 章是「带冲突交付」的**。校对门给出 4 处冲突（涉及主角设定、伏笔回收时机），定向修订一轮后仍在，
   按既定口径不拦交付 —— 这是**设计行为**，但成稿需要人工确认这 4 处。
   （这与记忆里记的「校对门输出非严格 JSON 时 fail-open」是两回事：这次是真判出了冲突。）
2. **实体沉淀主动拦下 1 处同批次矛盾**并进了 `fact_conflicts` 队列等待裁决 —— 说明同批次矛盾筛除生效，
   但这批数据随探针项目一起清掉了。
3. **项目「111」（`8375f0b9-…`）是空库**（4KB，审计 0 / L2 0 / 水车 0），不是本次产生的。
   本次所有探针数据已清干净，它是历史残留，是否保留请作者定。

---

## 五、环境与清理

**本次新踩的两个环境坑**（已写入项目记忆）：

- **`netstat` 的 grep 模式不能写成 `LISTENING.*:3774`** —— 行格式是 `… :3774 … LISTENING <pid>`，
  该写法匹配不到，会得出「端口已释放」的**假结论**，随后启动就撞 `EADDRINUSE`。要用 `grep ":3774"`。
- **vite 只监听 `[::1]:5173`（IPv6）**：用 `127.0.0.1:5173` 探测会得到 **502 `upstream connect failed`**，
  用 `localhost` / `[::1]` 才 200。
- 又一次出现「后台任务壳退出、server 子进程仍占端口」：**判存活只看端口 + `/api/health`**，不看任务状态。

**清理结果**（9 个探针账号 + 10 个探针项目全部清除，走 API 删项目以级联删库文件）：

- 剩余账号：仅 `user`
- 剩余项目：「111」、「空山雨后」
- 技能库 10 条本体保留、`agent_skill_toggles` 0 行、`user_settings` 孤儿 0、项目孤儿行 0
- `data/projects/` 只剩 2 个 `.db`（+ 各自的 WAL 文件）

**运行中的服务**：server PID 17524（Node 24，health 200）· vite PID 2372（`localhost:5173` → 200，`/api` 代理正常）
