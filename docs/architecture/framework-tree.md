# 砚舟 框架展示树

> 目的：一屏看清「有哪些模块、各自负责什么」，而不是逐个文件罗列。
> 粒度：到模块 / 关键目录层级；只有作为**装配点或契约**的文件才单列。
> 维护：手工维护。新增顶层模块或改变模块职责时同步更新本文件。

图例：`[M]` = 应用 / 服务，`[P]` = 插件，`[L]` = 共享库，`[T]` = 工具链。

```text
new1.2/                                  # 砚舟 monorepo（pnpm workspace，14 个 workspace 包）
│
├─ apps/                                 # 可运行单元
│  │
│  ├─ web/                        [M]     # 前端 SPA（React 18 + Vite + TypeScript + Tailwind）
│  │  ├─ index.html                       # Vite HTML 入口
│  │  ├─ vite.config.ts                   # 构建：alias / 手写分包 / dev proxy / CSP 注入
│  │  ├─ vitest.config.ts                 # 单测：jsdom + 覆盖率阈值 + 跨插件 include
│  │  └─ src/
│  │     ├─ main.tsx / App.tsx            # 应用入口与顶层装配（路由表 + 全站并行预热）
│  │     ├─ plugin/               [L]     # ★ 前端插件宿主内核（框架核心之一）
│  │     │  ├─ host.ts                    #   宿主上下文：槽位注册 / 能力通道 / 模块装载
│  │     │  ├─ registry.ts                #   插件注册表：面板 / 槽位 / 贡献点
│  │     │  ├─ moduleEntries.ts           #   模块入口解析 + loadModulePreload（预取）
│  │     │  └─ types.ts                   #   宿主对外契约类型
│  │     ├─ components/
│  │     │  ├─ shell/                     # ★ 停靠式工作台外壳（Dock 框架）
│  │     │  │  ├─ DockShell.tsx           #   停靠编排：开合 / 聚焦 / 上限 / 活动栏
│  │     │  │  ├─ ProjectLayout.tsx       #   项目级布局与 URL↔面板状态同步
│  │     │  │  └─ dock/                   #   停靠协议实现：布局解算、类型、主题令牌
│  │     │  ├─ ui/                        #   通用组件（书卡 / 命令面板 / Toast / 错误边界）
│  │     │  ├─ ai/primitives/             #   AI 交互原语（流式文本 / 工具条 / 思考轨迹）
│  │     │  └─ settings/                  #   设置面板（外观 / 插件管理 / 更新）
│  │     ├─ pages/                        #   路由级页面（书架 / 项目 / 管理 / 登录 / 注册…）
│  │     ├─ routes/                       #   路由基建（懒加载 / 转场 / 路径常量）
│  │     ├─ stores/                       #   全局状态（auth / panelOpen / reference / theme）
│  │     ├─ services/
│  │     │  ├─ api/                       #   ★ 后端访问层：apiClient + queryClient + queryKeys
│  │     │  ├─ auth/ · data/ · editor/ · security/   # 认证 / 本地数据 / 编辑器 / 安全
│  │     ├─ hooks/                        #   通用 hooks（useCachedQuery / useGlassRipple）
│  │     ├─ utils/ · types/ · styles/ · test/ · dev/   # 工具 / 类型 / 样式 / 测试装配 / 开发预览
│  │
│  ├─ server/                     [M]     # 后端服务（Hono + better-sqlite3）
│  │  └─ src/
│  │     ├─ index.ts                      # 服务入口
│  │     ├─ modules/                      # ★ HTTP 路由模块（20 个：auth/projects/chapters/ai/…）
│  │     ├─ services/                     # ★ 领域服务（章节 / 角色 / 伏笔 / 大纲 / 快照 / 检索…）
│  │     ├─ ai/                           # ★ AI 子系统
│  │     │  ├─ pipeline.ts                #   多智能体流水线编排
│  │     │  ├─ context-builder.ts         #   上下文构建（注入作品/角色/设定）
│  │     │  ├─ agents/                    #   智能体（对话 / 情节 / 一致性 / 节奏 / 扫描 / 风格…）
│  │     │  ├─ providers/                 #   LLM 供应商工厂
│  │     │  └─ tools/                     #   工具调用（角色 / 伏笔 / 大纲 / 地点 / 插件工具）
│  │     ├─ plugin/                       # ★ 服务端插件宿主（装载 / 迁移 / 守卫 / KV / 静态托管）
│  │     ├─ lib/                          #   基础设施（JWT / Cookie / SSRF 防护 / 熔断 / 代理…）
│  │     └─ middleware/                   #   中间件（鉴权 / 错误处理 / 限流 / 请求日志）
│  │
│  ├─ desktop/                    [M]     # 桌面壳（Electron）
│  │  ├─ src/
│  │  │  ├─ main.ts                       #   主进程入口
│  │  │  ├─ preload.ts                    #   预加载桥（window.desktop API）
│  │  │  ├─ server-process.ts             #   内嵌后端进程的拉起 / 探针 / 退出
│  │  │  ├─ paths.ts                      #   运行时布局 + 载荷指纹（build-stamp）与重播种
│  │  │  ├─ window.ts · env.ts · ipc-channels.ts · logger.ts   # 窗口 / 环境 / IPC 通道 / 日志
│  │  │  └─ updater/                      # ★ 自动更新（备份 / 下载 / 校验 / 插件随包）
│  │  ├─ scripts/build-server-payload.mjs #   载荷打包 + 生成 build-stamp.json 指纹
│  │  └─ electron-builder.yml             #   打包配置（NSIS + 绿色 zip）
│  │
│  └─ agents/                     [M]     # Python 智能体服务（novelmuse_agents，独立进程）
│     └─ src/novelmuse_agents/            #   配置 / 供应商 / 工具注册 / agents 子包
│
├─ apps/plugins/                          # 插件（三种归属：手写模式 / 自动模式 / 共享库）
│  ├─ manual/                             # —— 手写模式插件 ——
│  │  ├─ workbench/               [P]     # @novel-plugins/manual-workbench（手写台，模式：manual）
│  │  │  ├─ web/                          # ★ 前端面：面板与页面
│  │  │  │  ├─ index.tsx                  #   模块入口（注册 12 面板 + chapters + ai-chat 槽）
│  │  │  │  ├─ panels.tsx                 #   12 个停靠面板的懒加载登记表
│  │  │  │  ├─ layout/                    #   左侧栏 / 回收站
│  │  │  │  ├─ editor/                    #   章节编辑器（扩展 / 面板 / hooks / 导出）
│  │  │  │  ├─ knowledge/ · outline/ · foreshadow/ · timeline/ · notes/ · stats/ · export/
│  │  │  │  ├─ ai/                        #   AI 对话面板（自 auto 模块移交而来）
│  │  │  │  ├─ hooks/ · services/ · utils/ · stores/   # 检测 / 数据 / 工具 / 模块内状态
│  │  │  ├─ stores/                       #   模块级 store 公开入口
│  │  │  └─ server/                       #   模块级服务端入口
│  │  ├─ novel.bookscan/          [P]     # 书稿扫描插件（web 面 + server 面）
│  │  └─ worldbuilding/           [P]     # 世界观插件（src/web + src/server）
│  │
│  ├─ auto/                               # —— 自动写作模式插件 ——
│  │  ├─ workbench/               [P]     # @novel-plugins/auto-workbench（web 面为有意空实现）
│  │  │  ├─ web/                          #   入口 + 留档的 ai/（AI 面板已移交手写台）
│  │  │  └─ server/                       #   模块级服务端入口
│  │  └─ novel.autowrite/         [P]     # AI 自动写作引擎（server 面）
│  │
│  └─ shared/                             # —— 共享库插件（被两个模式复用）——
│     ├─ ui-kit/                  [L]     # @novel-plugins/ui-kit（基础件 + AI 原语 + 主题）
│     ├─ ui-graph/                [L]     # @novel-plugins/ui-graph（关系图 / 3D 力导向图）
│     ├─ data-core/               [L]     # @novel-plugins/data-core（数据层：api/data/editor/stores/skills）
│     └─ typography/              [P]     # 排版插件（web + server）
│
├─ packages/                              # 框架核心库（非插件）
│  ├─ core/                       [L]     # @novel/core：插件框架核心（manifest/registry/loader/mode/context）
│  ├─ db/                         [L]     # @novel/db：数据访问（drizzle schema / sqlite 适配 / 项目库）
│  └─ shared/                     [L]     # @novel/shared：跨端共享工具
│
├─ scripts/                       [T]     # 工具链（均以 node 直跑，不参与打包）
│  ├─ verify/                             # ★ 门禁脚本（18 个：隔离 / 模式分离 / manifest / 模块移除…）
│  ├─ e2e/                                #   端到端脚本（核心流 / AI 链 / 模式分离 / UI 集成）
│  ├─ tools/                              #   维护工具（孤儿库清理 / 记忆抽查 / 测试数据）
│  ├─ desktop/                            #   桌面自动化（控制端 + MCP 服务）
│  └─ docker/                             #   Docker 构建 / 停止脚本
│
├─ docs/                                  # 文档
│  ├─ architecture/                       #   架构与 ADR（本文件所在目录）
│  ├─ design/ · mockups/                  #   设计规范 / 原型
│  ├─ handover/ · reports/                #   交接 / 验收报告
│  └─ skills/                             #   技能说明
│
├─ .github/workflows/ci.yml       [T]     # CI：pnpm + Node 24，逐包 type-check / lint / test
├─ docker-compose.yml · Dockerfile        # 容器化编排与镜像
├─ pnpm-workspace.yaml                    # workspace 与包解析边界
├─ package.json                           # 根脚本（dev / build / verify:all / e2e:ui …）
├─ start-dev.cmd · start-novelmuse.cmd    # Windows 一键启动
└─ README.md · CHANGELOG.md · LICENSE     # 说明 / 变更日志 / 许可
```

## 三条主线

| 主线 | 组成 | 说明 |
| --- | --- | --- |
| **插件框架** | `packages/core` → `apps/web/src/plugin` → `apps/server/src/plugin` | 前端宿主 + 服务端宿主 + 核心契约；插件按 `modes` 声明归属手写 / 自动 |
| **停靠式工作台** | `apps/web/src/components/shell/**` + `apps/plugins/*/workbench/web` | 面板由插件注册，外壳负责开合、聚焦、上限与布局解算 |
| **桌面交付** | `apps/desktop/**` + `scripts/desktop` + `electron-builder.yml` | 内嵌后端 + 载荷指纹（build-stamp）+ 重播种 + 自动更新 |

## 模块归属速查

- **手写模式**：`manual/workbench`（手写台）、`manual/novel.bookscan`、`manual/worldbuilding`
- **自动模式**：`auto/workbench`、`auto/novel.autowrite`
- **两模式共用**：`shared/ui-kit`、`shared/ui-graph`、`shared/data-core`、`shared/typography`
- **内核（不属任何插件）**：`apps/web/src/**` 中除插件模块外的部分、`apps/server/src/**`、`packages/**`
