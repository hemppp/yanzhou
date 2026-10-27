/** @type {import('tailwindcss').Config} */

// ============================================================
// 主题：VS Code Dark Modern（P1 / t2）
//
// 契约真源：docs/architecture/dock-protocol-adr.md §5.4 约定 C-4。
//
// ★ 已删除：`CHROMATIC_PALETTES → INK_SCALE` 的「彩色调色板整体重映射为灰阶」。
//   那是水墨化时期的手法（把 text-amber-500 / bg-green-100 这类彩色工具类
//   统一压成墨阶），与 VS Code 的语义色体系直接冲突 —— VS Code 恰恰需要
//   红/黄/蓝来表达 error/warning/info。删除后这些工具类恢复 Tailwind 原色，
//   而语义色一律走下面的 `vscode` 子集（= --vscode-* 变量）。
//
// ★ 色彩唯一真源：ui-kit 的 src/styles/vscode-dark-modern.css（:root / html.dark）。
//   本文件**只做映射**，不写死色值 —— 改一个 token 全站生效。
// ============================================================

export default {
  darkMode: 'class',
  // ★ 插件 Web 面也要扫描（novel.autowrite / worldbuilding 等）：
  //   否则插件独有的工具类（如 -right-14 / right-12）不会生成 CSS，
  //   表现为气泡栏/弹层类全部失效、叠在面板内部（2026-09-10 实测事故）。
  //
  // ★ 2026-10-27 补 shared 包（**实测缺口**，勿删）：
  //   `../plugins/**/web/**` 只覆盖带 `web/` 段的目录；`ui-kit/src`、`ui-graph/src`
  //   **没有** `web` 段 ⇒ 它们里的工具类一直没被编译。实测证据：ui-kit/ToastProvider
  //   的 `min-w-[280px]` / `z-[9999]` 在产物 CSS 里**不存在**（同名字串只来自 apps/web 的其它文件）。
  //   shadcn 组件落在 ui-kit 后，`bg-background/border-border/ring-ring` 这类类名
  //   若不在此范围内会**全部裸奔**（组件有形无皮）。
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../plugins/**/web/**/*.{js,ts,jsx,tsx}',
    '../plugins/shared/ui-kit/src/**/*.{js,ts,jsx,tsx}',
    '../plugins/shared/ui-graph/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // ★ 2026-10-27 补 popover：shadcn 的 Dialog/Dropdown/Popover/Command 默认用
        //   `bg-popover text-popover-foreground`，而全仓此前**没有**这两个 token 也没有
        //   这个 colors 键 ⇒ 那些组件会「有形无皮」（背景透明、文字继承）。
        //   值刻意别名到 card（弹层与卡片同面），不新增字面色值（ADR 约定 C-2）。
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },

        // ============================================================
        // VS Code Dark Modern 工具类子集（ADR §5.4 C-4，t2 决定子集大小）
        //
        // 用法：`bg-vscode-editor` / `text-vscode-fg` / `border-vscode-border` …
        // 值全部引用 ui-kit 定义的 --vscode-* 完整颜色（非三元组），
        // 故这里直接 `var(...)` 而不是 `hsl(var(...))`。
        //
        // 子集选取原则：只暴露**界面外壳与停靠系统实际会用的**那一部分
        // （t3/t4/t5 写布局时的高频位），其余需要时直接写
        // `style={{ background: 'var(--vscode-xxx)' }}` 或回 ui-kit 补。
        // ============================================================
        vscode: {
          // 表面
          editor: 'var(--vscode-editor-background)',
          editorFg: 'var(--vscode-editor-foreground)',
          sidebar: 'var(--vscode-sideBar-background)',
          sidebarSection: 'var(--vscode-sideBarSectionHeader-background)',
          activityBar: 'var(--vscode-activityBar-background)',
          panel: 'var(--vscode-panel-background)',
          panelFg: 'var(--vscode-panel-foreground)',
          statusBar: 'var(--vscode-statusBar-background)',
          statusBarFg: 'var(--vscode-statusBar-foreground)',
          titleBar: 'var(--vscode-titleBar-activeBackground)',
          topBar: 'var(--vscode-topBar-background)',
          // 标签
          tabActive: 'var(--vscode-tab-activeBackground)',
          tabActiveFg: 'var(--vscode-tab-activeForeground)',
          tabInactive: 'var(--vscode-tab-inactiveBackground)',
          tabInactiveFg: 'var(--vscode-tab-inactiveForeground)',
          tabHover: 'var(--vscode-tab-hoverBackground)',
          // 线与聚焦
          border: 'var(--vscode-border)',
          divider: 'var(--vscode-divider)',
          focusBorder: 'var(--vscode-focusBorder)',
          widgetBorder: 'var(--vscode-widget-border)',
          // 控件
          button: 'var(--vscode-button-background)',
          buttonFg: 'var(--vscode-button-foreground)',
          buttonHover: 'var(--vscode-button-hoverBackground)',
          buttonSecondary: 'var(--vscode-button-secondaryBackground)',
          buttonSecondaryFg: 'var(--vscode-button-secondaryForeground)',
          input: 'var(--vscode-input-background)',
          inputFg: 'var(--vscode-input-foreground)',
          inputBorder: 'var(--vscode-input-border)',
          placeholder: 'var(--vscode-input-placeholderForeground)',
          dropdown: 'var(--vscode-dropdown-background)',
          toolbarHover: 'var(--vscode-toolbar-hoverBackground)',
          // 列表
          listHover: 'var(--vscode-list-hoverBackground)',
          listActive: 'var(--vscode-list-activeSelectionBackground)',
          listActiveFg: 'var(--vscode-list-activeSelectionForeground)',
          listInactive: 'var(--vscode-list-inactiveSelectionBackground)',
          // 拖拽预览（ADR §5.6）
          dropBackground: 'var(--vscode-panel-dropBackground)',
          listDropBackground: 'var(--vscode-list-dropBackground)',
          // 语义色
          error: 'var(--vscode-semantic-error)',
          errorBg: 'var(--vscode-semantic-error-background)',
          warning: 'var(--vscode-semantic-warning)',
          warningBg: 'var(--vscode-semantic-warning-background)',
          info: 'var(--vscode-semantic-info)',
          infoBg: 'var(--vscode-semantic-info-background)',
          success: 'var(--vscode-semantic-success)',
          successBg: 'var(--vscode-semantic-success-background)',
        },

        // ============================================================
        // 旧「墨韵工艺层」工具类（paper / tone / sig）—— **保留，只换值**
        //
        // ADR §6.5：`nm-*` 类名保留只换值，同理这些工具类名也保留 ——
        // 它们散落在 manual/auto 两模块与 kernel 的 tsx 里（数百处），
        // 重命名会迫使 t3/t4/t5 同时改 tsx、制造四任务耦合。
        // 它们的**值**已在 globals.css / vscode-dark-modern.css 里换成
        // VS Code 语义（--paper-* 等 → 派生自 --vscode-*），类名不动。
        // ============================================================
        paper: {
          DEFAULT: 'hsl(var(--paper))',
          canvas: 'hsl(var(--paper-canvas))',
          inset: 'hsl(var(--paper-inset))',
          field: 'hsl(var(--paper-field))',
          hover: 'hsl(var(--paper-hover))',
          'hover-2': 'hsl(var(--paper-hover-2))',
          line: 'hsl(var(--paper-line))',
          'line-strong': 'hsl(var(--paper-line-strong))',
          'line-soft': 'hsl(var(--paper-line-soft))',
        },
        tone: {
          DEFAULT: 'hsl(var(--tone))',
          2: 'hsl(var(--tone-2))',
          3: 'hsl(var(--tone-3))',
        },
        sig: {
          run: 'hsl(var(--sig-run))',
          'run-tint': 'hsl(var(--sig-run-tint))',
          done: 'hsl(var(--sig-done))',
          'done-tint': 'hsl(var(--sig-done-tint))',
          warn: 'hsl(var(--sig-warn))',
          'warn-tint': 'hsl(var(--sig-warn-tint))',
          stop: 'hsl(var(--sig-stop))',
          'stop-tint': 'hsl(var(--sig-stop-tint))',
        },

        // —— 主题控制台项目专色：全部别名到 --vscode-*，类名保留（t3/t4/t5 零改动）——
        mountain: {
          DEFAULT: 'var(--vscode-semantic-info)',
          cyan: 'var(--vscode-semantic-info)',
          light: 'var(--vscode-list-highlightForeground)',
          deep: 'var(--vscode-button-background)',
          pale: 'var(--vscode-list-hoverBackground)',
        },
        mist: {
          DEFAULT: 'var(--vscode-list-hoverBackground)',
          blue: 'var(--vscode-list-hoverBackground)',
          pale: 'var(--vscode-panel-background)',
          deep: 'var(--vscode-border)',
        },
        ink: {
          DEFAULT: 'var(--vscode-editor-foreground)',
          light: 'var(--vscode-panel-foreground)',
          pale: 'var(--vscode-input-placeholderForeground)',
        },
        // 章节区分色（8 档）：改由 VS Code 语义色轮转，保留类名
        chapter: {
          1: 'var(--vscode-semantic-error)',
          2: 'var(--vscode-semantic-warning)',
          3: 'var(--vscode-semantic-info)',
          4: 'var(--vscode-semantic-success)',
          5: 'var(--vscode-list-highlightForeground)',
          6: 'var(--vscode-activityBarBadge-background)',
          7: 'var(--vscode-tab-activeBorderTop)',
          8: 'var(--vscode-statusBarItem-prominentBackground)',
        },
        cinnabar: {
          DEFAULT: 'var(--vscode-semantic-error)',
          pale: 'var(--vscode-semantic-error-background)',
        },
        willow: {
          DEFAULT: 'var(--vscode-semantic-success)',
          pale: 'var(--vscode-semantic-success-background)',
        },
        ochre: {
          DEFAULT: 'var(--vscode-semantic-warning)',
          pale: 'var(--vscode-semantic-warning-background)',
        },
        // —— 兼容旧命名 ——
        inspiration: {
          DEFAULT: 'var(--vscode-button-background)',
          light: 'var(--vscode-list-highlightForeground)',
        },
        focus: {
          DEFAULT: 'var(--vscode-focusBorder)',
          subtle: 'var(--vscode-inputOption-activeBackground)',
        },
        warm: {
          DEFAULT: 'var(--vscode-semantic-warning)',
          light: 'var(--vscode-semantic-warning-background)',
        },
        success: {
          DEFAULT: 'var(--vscode-semantic-success)',
        },
        // —— 语义扩展层（换肤契约 2026-09-11，值见 globals.css）——
        // 组件该类色一律用这里，不要写死 #xxxxxx —— 否则换肤不生效
        entity: {
          character: 'hsl(var(--entity-character))',
          location: 'hsl(var(--entity-location))',
          item: 'hsl(var(--entity-item))',
          foreshadow: 'hsl(var(--entity-foreshadow))',
          event: 'hsl(var(--entity-event))',
          outline: 'hsl(var(--entity-outline))',
        },
        agent: {
          plot: 'hsl(var(--agent-plot))',
          character: 'hsl(var(--agent-character))',
          continuity: 'hsl(var(--agent-continuity))',
          convener: 'hsl(var(--agent-convener))',
          writer: 'hsl(var(--agent-writer))',
        },
        state: {
          idle: 'hsl(var(--state-idle))',
          running: 'hsl(var(--state-running))',
          done: 'hsl(var(--state-done))',
          blocked: 'hsl(var(--state-blocked))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        // 墨韵工艺层：四级圆角档位（与上面的苹果大圆角并存，迁移可分批）
        chip: 'var(--radius-chip)',           // 6px  标签 / 徽章 / 极小控件
        control: 'var(--radius-control)',     // 8px  按钮 / 输入 / 图标按钮
        card: 'var(--radius-card)',           // 10px 卡片 / 面板
        window: 'var(--radius-window)',       // 14px 窗口 / 大容器 / 输入区
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'PingFang SC', 'HarmonyOS Sans SC', 'MiSans', 'Microsoft YaHei UI', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        serif: ['Noto Serif SC', 'Source Han Serif SC', 'serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      backdropBlur: {
        xs: '2px',
      },
      transitionDuration: {
        '400': '400ms',
        '600': '600ms',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'zoom-in-95': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-from-top-2': {
          '0%': { opacity: '0', transform: 'translateY(-0.5rem)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 5px currentColor' },
          '50%': { boxShadow: '0 0 20px currentColor' },
        },
        'card-enter': {
          '0%': { opacity: '0', transform: 'translateY(16px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'text-reveal': {
          '0%': { opacity: '0', transform: 'translateY(4px)', filter: 'blur(2px)' },
          '100%': { opacity: '1', transform: 'translateY(0)', filter: 'blur(0)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'gradient-flow': {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
        'pulse-glow-enhanced': {
          '0%, 100%': {
            boxShadow: '0 0 20px color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent), 0 0 40px color-mix(in srgb, var(--vscode-focusBorder) 5%, transparent)',
          },
          '50%': {
            boxShadow: '0 0 30px color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent), 0 0 60px color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent)',
          },
        },
        'spring-scale': {
          '0%': { transform: 'scale(0.8)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'smooth-fade': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'rotate-in': {
          '0%': { opacity: '0', transform: 'rotate(-5deg) scale(0.95)' },
          '100%': { opacity: '1', transform: 'rotate(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'zoom-in-95': 'zoom-in-95 200ms ease-out',
        'slide-in-from-top-2': 'slide-in-from-top-2 200ms ease-out',
        'float': 'float 3s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'card-enter': 'card-enter 0.5s ease-out both',
        'text-reveal': 'text-reveal 0.6s ease-out both',
        'shimmer': 'shimmer 2s infinite linear',
        'gradient-flow': 'gradient-flow 8s ease infinite',
        'pulse-glow-enhanced': 'pulse-glow-enhanced 2.5s ease-in-out infinite',
        'spring-scale': 'spring-scale 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        'smooth-fade': 'smooth-fade 0.4s ease-out',
        'rotate-in': 'rotate-in 0.5s ease-out',
      },
      boxShadow: {
        'glow': '0 0 15px -3px color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent)',
        'glow-lg': '0 0 30px -5px color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent)',
        'glass': '0 8px 32px -8px var(--vscode-widget-shadow)',
        'glow-blue': '0 0 30px -5px color-mix(in srgb, var(--vscode-focusBorder) 20%, transparent)',
        'deep': '0 20px 60px -15px var(--vscode-widget-shadow)',
        'ink': '0 8px 24px -8px var(--vscode-widget-shadow)',
        'mist': '0 12px 32px -10px var(--vscode-widget-shadow)',

        // —— 墨韵工艺层：分级投影，全部含 1px 墨线（令牌见 globals.css）——
        // hairline 勾线 → card 卡片 → raised 浮起 → overlay 弹层，四级递进
        hairline: 'var(--shadow-hairline)',
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
        btn: 'var(--shadow-btn)',
        field: 'var(--shadow-inset-field)',
      },
      // 墨韵工艺层：三档精修缓动（取 beautifului 的值）
      transitionTimingFunction: {
        link: 'var(--ease-link)',                       // 出场 / 展开：快起慢收
        'out-strong': 'var(--ease-out-strong)',         // 位移 / 放大：更脆
        'in-out-strong': 'var(--ease-in-out-strong)',   // 循环 / 往复
      },
      // 墨韵工艺层：命名字号档位
      // 为什么要这个：全站已在用 336 处 text-[11px]，但那是"魔法值"，
      // 后来人不知道 11 是地板还是随手写的。固化成 text-2xs 后语义自明，
      // 且将来要调档位只改这一处。
      //   2xs 11px = 面板内小字地板（眉标 / 元信息 / 表格 meta）
      //   xs  12px = Tailwind 内置，正文下限
      fontSize: {
        '2xs': ['11px', { lineHeight: '1.45' }],
      },

      /**
       * ★ 2026-10-27「字号小一点、留白大一点」——**只放大间距，不放大尺寸**。
       *
       * 关键取舍（勿改回 spacing）：
       *   直接覆盖 `theme.spacing` 会**连带**放大 `h-*` / `w-*` / `size-*`
       *   （实测 384 处），图标、按钮、色块会一起变胖 —— 与"整体缩小"相反。
       *   故这里只覆盖 `padding` / `margin` / `gap` 三族（它们各自继承 spacing 刻度，
       *   但可以被单独覆盖），实测 2359 处受益，而尺寸类完全不动。
       *
       * 口径（2026-10-27 作者二次反馈后定稿）：
       *   **小档不动、大档放大** —— 0.5~3 档（2/4/6/8/10/12px）承载控件内边距，
       *   放大会让按钮/输入框变胖（与"整体缩小"矛盾）；从 3.5 起逐档放大到 ~1.3×，
       *   这一档以上基本是**布局留白**（卡片间距、区块间距、面板内边距），放大才叫"透气"。
       * 与字号 ×0.93 配合 ⇒ 观感是"字更小、块更松"，而不是"整体缩水"。
       */
      padding: {
        0: '0px', 0.5: '2px', 1: '4px', 1.5: '6px', 2: '8px', 2.5: '10px',
        3: '12px', 3.5: '14px', 4: '18px', 5: '22px', 6: '26px', 7: '30px',
        8: '36px', 9: '44px', 10: '52px', 12: '64px', 16: '80px',
      },
      margin: {
        0: '0px', 0.5: '2px', 1: '4px', 1.5: '6px', 2: '8px', 2.5: '10px',
        3: '12px', 3.5: '14px', 4: '18px', 5: '22px', 6: '26px', 7: '30px',
        8: '36px', 9: '44px', 10: '52px', 12: '64px', 16: '80px',
      },
      gap: {
        0: '0px', 0.5: '2px', 1: '4px', 1.5: '6px', 2: '8px', 2.5: '10px',
        3: '12px', 3.5: '15px', 4: '20px', 5: '24px', 6: '28px', 7: '32px',
        8: '38px', 9: '46px', 10: '54px', 12: '66px', 16: '82px',
      },
    },
  },
  daisyui: {
    themes: false,
    darkTheme: 'vscode-dark-modern',
    base: false,
    styled: true,
    utils: true,
  },
  // ★ 2026-10-27：`tailwindcss-animate` 是 shadcn 组件（Dialog/Dropdown/Popover/Tooltip）
  //   进出场动画的依赖（`animate-in` / `fade-in-0` / `zoom-in-95` / `slide-in-from-*`）。
  //   本仓是 Tailwind **v3**，故用 `tailwindcss-animate`，**不要**换成 v4 的 `tw-animate-css`。
  //   daisyUI 与它在不同 layer（daisyui.l1/l2/l3 vs utilities），无同名冲突。
  plugins: [require('daisyui'), require('tailwindcss-animate')],
};
