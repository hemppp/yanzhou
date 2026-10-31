/**
 * identity-p0.mjs — 把既有 token 层指向 --yz-* 真源
 *
 * 契约：docs/design/yanzhou-visual-identity.md §5
 *
 * 干什么：
 *   把文件里 `:root`(亮档) 与 `.dark` / `html.dark`(暗档) 顶层块内的**声明值**
 *   指向 ui-kit/styles/identity.css 的 --yz-*。消费点（1144 处 var(--x)）一行不动。
 *
 * 支持两种目标文件：
 *   ① globals.css            —— 只处理**第一个 `@layer base` 块**内的 :root/.dark
 *                               （该文件后面还有组件层，不能碰）
 *   ② vscode-dark-modern.css —— 处理全文件所有 :root / html.dark 块
 *
 *   ② 是必须的：vscode-dark-modern.css 的 `:root` 是**无层级**声明，而无层级恒胜
 *   `@layer base` ⇒ globals.css 里那份 shadcn 锚点其实是**死代码**。
 *   只改 ① 不改 ②，--background / --primary / --border 这些主视觉根本不会变。
 *
 * 怎么用：
 *   node scripts/migrations/identity-p0.mjs <file>          # 干跑（只报告）
 *   node scripts/migrations/identity-p0.mjs <file> --write  # 落盘
 *
 * 安全措施：
 *   · 只在 :root/.dark/html.dark 顶层块做替换，不进其它嵌套块
 *   · 跳过跨行值（行尾无 `;` 的，如 linear-gradient(...)）
 *   · 跳过块注释内的文本
 *   · 幂等：重跑应报 0 处
 */

import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const write = process.argv.includes('--write');
if (!file) {
  console.error('用法: node identity-p0.mjs <css 文件> [--write]');
  process.exit(1);
}

/** 映射表：旧 token 名 → 新值表达式。两档共用 —— 亮/暗差异由 identity.css 内部处理。 */
const MAP = {
  // —— shadcn 锚点 ——
  '--background': 'var(--yz-ground)',
  '--foreground': 'var(--yz-ink)',
  '--card': 'var(--yz-surface)',
  '--card-foreground': 'var(--yz-ink)',
  '--popover': 'var(--yz-surface)',
  '--popover-foreground': 'var(--yz-ink)',
  '--primary': 'var(--yz-azurite)',
  // ⚠️ 不能写死白：暗档石青是浅蓝（L62%），白字只有 ~2:1。见 identity.css 注释。
  '--primary-foreground': 'var(--yz-on-azurite)',
  '--secondary': 'var(--yz-hover)',
  '--secondary-foreground': 'var(--yz-ink)',
  '--muted': 'var(--yz-hover)',
  '--muted-foreground': 'var(--yz-ink-2)',
  '--accent': 'var(--yz-hover)',
  '--accent-foreground': 'var(--yz-ink)',
  '--destructive': 'var(--yz-cinnabar)',
  '--destructive-foreground': 'var(--yz-on-cinnabar)',
  '--border': 'var(--yz-line)',
  '--input': 'var(--yz-line)',
  '--ring': 'var(--yz-azurite)',

  // —— 遗留别名：远山 / 雾 ——
  '--mountain-cyan': 'var(--yz-azurite)',
  '--mountain-light': 'var(--yz-azurite-hover)',
  '--mountain-deep': 'var(--yz-azurite-700)',
  '--mountain-pale': 'var(--yz-azurite-tint)',
  '--mist-blue': 'var(--yz-azurite-hover)',
  '--mist-pale': 'var(--yz-hover)',
  '--mist-deep': 'var(--yz-ink-2)',

  // —— 遗留别名：墨 / 朱砂 / 柳 / 赭 ——
  '--ink': 'var(--yz-ink)',
  '--ink-light': 'var(--yz-ink-2)',
  '--ink-pale': 'var(--yz-ink-3)',
  '--cinnabar': 'var(--yz-cinnabar)',
  '--cinnabar-pale': 'var(--yz-cinnabar-tint)',
  '--willow': 'var(--yz-malachite)',
  '--willow-pale': 'var(--yz-malachite-tint)',
  '--ochre': 'var(--yz-ochre)',
  '--ochre-pale': 'var(--yz-ochre-tint)',

  // —— 语义层：实体分类（6）——
  '--entity-character': 'var(--yz-azurite)',
  '--entity-location': 'var(--yz-malachite)',
  '--entity-item': 'var(--yz-ochre)',
  '--entity-foreshadow': 'var(--yz-cinnabar)',
  '--entity-event': 'var(--yz-ink-2)',
  '--entity-outline': 'var(--yz-ink-3)',

  // —— 语义层：Agent（5）—— 同族石青阶梯 + 朱砂（落笔者）——
  '--agent-plot': 'var(--yz-azurite-700)',
  '--agent-character': 'var(--yz-azurite)',
  '--agent-continuity': 'var(--yz-azurite-500)',
  '--agent-convener': 'var(--yz-azurite-400)',
  '--agent-writer': 'var(--yz-cinnabar)',

  // —— 语义层：状态（4）——
  '--state-idle': 'var(--yz-ink-3)',
  '--state-running': 'var(--yz-azurite)',
  '--state-done': 'var(--yz-malachite)',
  '--state-blocked': 'var(--yz-cinnabar)',

  // —— 语义层：章节（8）——
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`--chapter-${i + 1}`, `var(--yz-chapter-${i + 1})`]),
  ),

  // —— 墨韵工艺层 ——
  '--paper-inset': 'var(--yz-sunken)',
  '--paper-hover': 'var(--yz-hover)',
  '--paper-hover-2': 'var(--yz-hover-2)',
  '--paper-line-strong': 'var(--yz-line-strong)',
  '--paper-line-soft': 'var(--yz-line)',
  '--tone': 'var(--yz-ink)',
  '--tone-2': 'var(--yz-ink-2)',
  '--tone-3': 'var(--yz-ink-3)',

  // —— 信号色（与 state 合并为同一套）——
  '--sig-run': 'var(--yz-azurite)',
  '--sig-done': 'var(--yz-malachite)',
  '--sig-warn': 'var(--yz-ochre)',
  '--sig-stop': 'var(--yz-cinnabar)',
  '--sig-run-tint': 'var(--yz-azurite-tint)',
  '--sig-done-tint': 'var(--yz-malachite-tint)',
  '--sig-warn-tint': 'var(--yz-ochre-tint)',
  '--sig-stop-tint': 'var(--yz-cinnabar-tint)',

  // —— 玻璃底 ——
  '--glass-tint': 'var(--yz-glass-tint)',

  // —— 书封 ——
  '--cover-ink': 'hsl(var(--yz-ink))',
  '--cover-paper': 'hsl(var(--yz-surface))',
  '--cover-line': 'hsl(var(--yz-ink))',
  '--cover-decor': 'hsl(var(--yz-ink))',
  '--cover-seal': 'hsl(var(--yz-cinnabar))',
  '--cover-fg': 'hsl(var(--yz-cover-fg))',
  '--glass-shadow': 'var(--yz-shadow-color)',

  // —— 书封底遮罩（P5）——
  // 用**半透明**的墨，不能用 `var()` 引用不透明令牌 —— 遮罩的真语义是「α 黑压暗」。
  // 所以走 identity.css 的 --yz-scrim 系列（它们本来就是 rgb(… / α) 三档）。
  // ★ 关键：遮罩是**同色相深墨**，不是纯黑 —— 纯黑会把封面色相一起洗掉（老问题的成因）。
  '--cover-scrim': 'var(--yz-scrim)',
  '--cover-scrim-strong': 'var(--yz-scrim-strong)',
  '--cover-scrim-opacity': '1',
};

/**
 * VS Code 外壳层（118 个 --vscode-*）→ --yz-*
 *
 * 为什么必须做（P1）：外壳占屏幕面积最大（活动栏/侧栏/标签条/状态栏/面板），
 * 是「土」的主要发生地。不做这一层，P0 只是把面板颜色换了，外壳仍是 VS Code 灰。
 *
 * 映射原则（surface → token）：
 *   · 画布 / 活动标签页  → ground   （这两个是「内容面」，与编辑器同底）
 *   · 一切外框           → surface  （活动栏/侧栏/状态栏/标题栏/面板/下拉/菜单）
 *   · 一切线             → line
 *   · 一切交互态         → hover / hover-2
 *   · 一切强调           → azurite（focus / splitter / 高亮 / info）
 *   · 徽标(badge)        → cinnabar（全站唯一强调色的合法用途之一）
 *
 * 注意：这些 token 原值是 `light-dark(hsl(亮), hsl(暗))`。改成 `var(--yz-*)` 后
 * 两档由 identity.css 承担，**语义不变但少一层机制** —— 这也是收敛的收益之一。
 */
const VMAP = {
  // 活动栏
  '--vscode-activityBar-background': 'hsl(var(--yz-surface))',
  '--vscode-activityBar-foreground': 'hsl(var(--yz-ink-2))',
  '--vscode-activityBar-inactiveForeground': 'hsl(var(--yz-ink-3))',
  '--vscode-activityBar-activeBorder': 'hsl(var(--yz-azurite))',
  '--vscode-activityBar-activeBackground': 'hsl(var(--yz-hover))',
  '--vscode-activityBar-border': 'hsl(var(--yz-line))',
  '--vscode-activityBarBadge-background': 'hsl(var(--yz-cinnabar))',
  '--vscode-activityBarBadge-foreground': 'hsl(var(--yz-on-cinnabar))',

  // 面板 / 侧栏
  '--vscode-panel-background': 'hsl(var(--yz-surface))',
  '--vscode-panel-foreground': 'hsl(var(--yz-ink-2))',
  '--vscode-panel-border': 'hsl(var(--yz-line))',
  '--vscode-panel-dropBackground': 'var(--yz-drop-bg)',
  '--vscode-panelTitle-activeBackground': 'hsl(var(--yz-ground))',
  '--vscode-panelTitle-activeForeground': 'hsl(var(--yz-ink))',
  '--vscode-panelTitle-inactiveForeground': 'hsl(var(--yz-ink-3))',
  '--vscode-panelTitle-border': 'hsl(var(--yz-line))',
  '--vscode-panelSectionHeader-background': 'hsl(var(--yz-hover))',
  '--vscode-sideBar-background': 'hsl(var(--yz-surface))',
  '--vscode-sideBar-foreground': 'hsl(var(--yz-ink-2))',
  '--vscode-sideBar-border': 'hsl(var(--yz-line))',
  '--vscode-sideBarSectionHeader-background': 'hsl(var(--yz-hover))',
  '--vscode-sideBarSectionHeader-foreground': 'hsl(var(--yz-ink-2))',
  '--vscode-sideBarSectionHeader-border': 'hsl(var(--yz-line))',

  // 状态栏 / 标题栏 / 顶栏
  '--vscode-statusBar-background': 'hsl(var(--yz-surface))',
  '--vscode-statusBar-foreground': 'hsl(var(--yz-ink-2))',
  '--vscode-statusBar-border': 'hsl(var(--yz-line))',
  '--vscode-statusBarItem-hoverBackground': 'hsl(var(--yz-hover))',
  '--vscode-statusBarItem-activeBackground': 'hsl(var(--yz-hover-2))',
  '--vscode-statusBarItem-prominentBackground': 'hsl(var(--yz-azurite))',
  '--vscode-statusBarItem-remoteBackground': 'hsl(var(--yz-malachite))',
  '--vscode-titleBar-activeBackground': 'hsl(var(--yz-surface))',
  '--vscode-titleBar-activeForeground': 'hsl(var(--yz-ink))',
  '--vscode-titleBar-inactiveBackground': 'hsl(var(--yz-surface))',
  '--vscode-titleBar-border': 'hsl(var(--yz-line))',
  '--vscode-topBar-background': 'hsl(var(--yz-surface))',

  // 标签
  '--vscode-tab-activeBackground': 'hsl(var(--yz-ground))',
  '--vscode-tab-activeForeground': 'hsl(var(--yz-ink))',
  '--vscode-tab-activeBorderTop': 'hsl(var(--yz-azurite))',
  '--vscode-tab-activeBorder': 'hsl(var(--yz-line))',
  '--vscode-tab-inactiveBackground': 'hsl(var(--yz-surface))',
  '--vscode-tab-inactiveForeground': 'hsl(var(--yz-ink-3))',
  '--vscode-tab-hoverBackground': 'hsl(var(--yz-hover))',
  '--vscode-tab-border': 'hsl(var(--yz-line))',
  '--vscode-tab-lastPinnedBorder': 'hsl(var(--yz-line-strong))',
  '--vscode-tab-unfocusedActiveBackground': 'hsl(var(--yz-ground))',
  '--vscode-tab-unfocusedActiveForeground': 'hsl(var(--yz-ink-2))',
  '--vscode-tab-unfocusedInactiveBackground': 'hsl(var(--yz-surface))',
  '--vscode-tab-unfocusedInactiveForeground': 'hsl(var(--yz-ink-3))',

  // 线与分隔
  '--vscode-border': 'hsl(var(--yz-line))',
  '--vscode-divider': 'hsl(var(--yz-line))',
  '--vscode-editorGroup-border': 'hsl(var(--yz-line))',
  '--vscode-widget-border': 'hsl(var(--yz-line))',
  '--vscode-splitter-background': 'hsl(var(--yz-line))',
  '--vscode-splitter-hoverBackground': 'hsl(var(--yz-azurite))',
  '--vscode-splitter-activeBackground': 'hsl(var(--yz-azurite))',
  '--vscode-sash-hoverBorder': 'hsl(var(--yz-azurite))',
  '--vscode-focusBorder': 'hsl(var(--yz-azurite))',

  // 控件
  '--vscode-button-background': 'hsl(var(--yz-azurite))',
  '--vscode-button-foreground': 'hsl(var(--yz-on-azurite))',
  '--vscode-button-hoverBackground': 'hsl(var(--yz-azurite-hover))',
  '--vscode-button-secondaryBackground': 'hsl(var(--yz-hover))',
  '--vscode-button-secondaryForeground': 'hsl(var(--yz-ink))',
  '--vscode-button-secondaryHoverBackground': 'hsl(var(--yz-hover-2))',
  '--vscode-button-border': 'hsl(var(--yz-line))',
  '--vscode-input-background': 'hsl(var(--yz-surface))',
  '--vscode-input-foreground': 'hsl(var(--yz-ink))',
  '--vscode-input-border': 'hsl(var(--yz-line))',
  '--vscode-input-placeholderForeground': 'hsl(var(--yz-ink-3))',
  '--vscode-inputOption-activeBorder': 'hsl(var(--yz-azurite))',
  '--vscode-inputOption-activeBackground': 'var(--yz-azurite-tint)',
  '--vscode-inputValidation-errorBackground': 'var(--yz-cinnabar-tint)',
  '--vscode-inputValidation-errorBorder': 'hsl(var(--yz-cinnabar))',
  '--vscode-dropdown-background': 'hsl(var(--yz-surface))',
  '--vscode-dropdown-border': 'hsl(var(--yz-line))',
  '--vscode-toolbar-hoverBackground': 'hsl(var(--yz-hover))',
  '--vscode-toolbar-activeBackground': 'hsl(var(--yz-hover-2))',

  // 列表
  '--vscode-list-hoverBackground': 'hsl(var(--yz-hover))',
  '--vscode-list-hoverForeground': 'hsl(var(--yz-ink))',
  '--vscode-list-activeSelectionBackground': 'var(--yz-azurite-tint)',
  '--vscode-list-activeSelectionForeground': 'hsl(var(--yz-ink))',
  '--vscode-list-inactiveSelectionBackground': 'hsl(var(--yz-hover))',
  '--vscode-list-inactiveSelectionForeground': 'hsl(var(--yz-ink-2))',
  '--vscode-list-focusOutline': 'hsl(var(--yz-azurite))',
  '--vscode-list-highlightForeground': 'hsl(var(--yz-azurite))',
  '--vscode-list-dropBackground': 'var(--yz-drop-bg)',

  // 编辑器面
  '--vscode-editor-background': 'hsl(var(--yz-ground))',
  '--vscode-editor-foreground': 'hsl(var(--yz-ink))',
  '--vscode-editorSurface-background': 'hsl(var(--yz-surface))',
  '--vscode-editor-lineHighlight': 'hsl(var(--yz-hover))',
  '--vscode-editor-selection': 'var(--yz-sel-bg)',
  '--vscode-editor-inactiveSelection': 'var(--yz-sel-bg-inactive)',
  '--vscode-editorCursor-foreground': 'hsl(var(--yz-ink))',
  '--vscode-editorWidget-background': 'hsl(var(--yz-surface))',
  '--vscode-editorWidget-border': 'hsl(var(--yz-line))',
  '--vscode-editorWidget-foreground': 'hsl(var(--yz-ink))',
  '--vscode-widget-shadow': 'var(--yz-widget-shadow)',
  '--vscode-menu-background': 'hsl(var(--yz-surface))',
  '--vscode-menu-foreground': 'hsl(var(--yz-ink))',
  '--vscode-descriptionForeground': 'hsl(var(--yz-ink-3))',

  // 滚动条（保持中性）
  '--vscode-scrollbar-shadow': 'var(--yz-widget-shadow)',
  '--vscode-scrollbarSlider-background': 'var(--yz-scrollbar)',
  '--vscode-scrollbarSlider-hoverBackground': 'var(--yz-scrollbar-hover)',
  '--vscode-scrollbarSlider-activeBackground': 'var(--yz-scrollbar-active)',

  // 语义色 → 与 --state-* / --sig-* 收敛到同一套锚点
  '--vscode-semantic-error': 'hsl(var(--yz-cinnabar))',
  '--vscode-semantic-error-background': 'var(--yz-cinnabar-tint)',
  '--vscode-semantic-error-border': 'hsl(var(--yz-cinnabar))',
  '--vscode-semantic-warning': 'hsl(var(--yz-ochre))',
  '--vscode-semantic-warning-background': 'var(--yz-ochre-tint)',
  '--vscode-semantic-warning-border': 'hsl(var(--yz-ochre))',
  '--vscode-semantic-info': 'hsl(var(--yz-azurite))',
  '--vscode-semantic-info-background': 'var(--yz-azurite-tint)',
  '--vscode-semantic-info-border': 'hsl(var(--yz-azurite))',
  '--vscode-semantic-success': 'hsl(var(--yz-malachite))',
  '--vscode-semantic-success-background': 'var(--yz-malachite-tint)',
  '--vscode-semantic-success-border': 'hsl(var(--yz-malachite))',
};

Object.assign(MAP, VMAP);

/** 注释修正表：换值后原行尾注释会变成假话，逐条改正。 */
const COMMENT = {
  '--mountain-cyan': '主强调 · 石青',
  '--mountain-light': '石青 · 悬停',
  '--mountain-deep': '石青 · 最深档',
  '--mountain-pale': '石青淡底（color-mix 推导）',
  '--mist-blue': '石青 · 悬停',
  '--mist-pale': '交互态·悬停',
  '--mist-deep': '前景·次',
  '--cinnabar': '朱砂 · 全站唯一强调（印 / 危险）',
  '--cinnabar-pale': '朱砂淡底（color-mix 推导）',
  '--willow': '石绿 · 成功 / 完成',
  '--willow-pale': '石绿淡底（color-mix 推导）',
  '--ochre': '赭石 · 警示 / 待审批',
  '--ochre-pale': '赭石淡底（color-mix 推导）',
  '--entity-character': '角色 · 石青',
  '--entity-location': '地点 · 石绿',
  '--entity-item': '物品 · 赭石',
  '--entity-foreshadow': '伏笔 · 朱砂',
  '--entity-event': '事件 · 次要前景',
  '--entity-outline': '大纲 · 弱前景',
  '--agent-writer': '写作官 · 落笔者（朱砂）',
  '--state-idle': '待开始',
  '--state-running': '进行中 · 石青',
  '--state-done': '已完成 · 石绿',
  '--state-blocked': '被挡下 · 朱砂',
};

const src = readFileSync(file, 'utf8');
const lines = src.split('\n');

// globals.css 走「只碰第一个 @layer base」的保守模式；其余文件全文件扫描。
const restricted = /@layer\s+base\s*\{/.test(src);
const BLOCK_SEL = /^\s*(?::root|\.dark|html\.dark)\s*(?:,\s*(?::root|\.dark|html\.dark)\s*)*\{/;

let depth = 0;
let block = null;
let blockDepth = 0;
let inComment = false;
let layerDepth = -1; // 进入第一个 @layer base 时的 depth
let layerClosed = false;

const changes = [];
const commentChanges = [];
const unmapped = [];

const DECL = /^(\s*)(--[A-Za-z0-9-]+)\s*:\s*([^;]+);(\s*(?:\/\*.*)?)$/;

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const opensComment = stripped.includes('/*');
  const closesComment = stripped.includes('*/');

  const prevDepth = depth;
  depth += (raw.match(/\{/g) ?? []).length;
  depth -= (raw.match(/\}/g) ?? []).length;

  if (restricted) {
    if (layerDepth < 0 && /^\s*@layer\s+base\s*\{/.test(raw)) {
      layerDepth = depth;
      continue;
    }
    if (layerDepth >= 0 && !layerClosed && depth < layerDepth) {
      layerClosed = true;
      block = null;
      continue;
    }
    // 只接受 @layer base 的直接子块
    if (!layerClosed && depth > prevDepth && BLOCK_SEL.test(raw) && depth === layerDepth + 1) {
      block = raw;
      blockDepth = depth;
      continue;
    }
  } else if (!inComment && depth > prevDepth && BLOCK_SEL.test(raw)) {
    block = raw;
    blockDepth = depth;
    continue;
  }

  if (block && depth < blockDepth) {
    block = null;
    continue;
  }

  if (inComment) {
    if (closesComment) inComment = false;
    continue;
  }

  if (!block) {
    if (opensComment) inComment = true;
    continue;
  }

  const m = raw.match(DECL);
  if (m) {
    const [, indent, name, value, tail] = m;
    let newLine = raw;
    let touched = false;

    // ① 换值
    if (MAP[name] && value.trim() !== MAP[name]) {
      changes.push({ line: i + 1, name, from: value.trim(), to: MAP[name] });
      newLine = `${indent}${name}: ${MAP[name]};${tail}`;
      touched = true;
    }

    // ② 修正已成假话的注释（与换值独立判定 ⇒ 可重跑）
    if (COMMENT[name] != null) {
      const want = `/* ${COMMENT[name]} */`;
      const cur = tail.replace(/\s+$/, '').trim();
      if (cur !== want) {
        commentChanges.push({ line: i + 1, name, from: cur || '(无)', to: want });
        newLine = `${indent}${name}: ${MAP[name] ?? value.trim()}; ${want}`;
        touched = true;
      }
    }

    if (touched) lines[i] = newLine;

    // ③ 报告块内仍未映射的字面色值
    if (!MAP[name] && !COMMENT[name] && /(^|\s)(hsl|rgb|#|0 0%|\d+\s+\d+%)/.test(value)) {
      unmapped.push({ line: i + 1, name, value: value.trim() });
    }
  }

  if (opensComment) inComment = true;
}

console.log(`\n=== identity-p0 迁移报告：${file} （${restricted ? '受限模式：仅第一个 @layer base' : '全文件扫描'}）===`);
console.log(`\n① 换值 ${changes.length} 处：`);
for (const c of changes) console.log(`  L${c.line}  ${c.name.padEnd(24)} ${c.from}  →  ${c.to}`);

if (commentChanges.length) {
  console.log(`\n② 注释修正 ${commentChanges.length} 处（换值后原注释已成假话）：`);
  for (const c of commentChanges) console.log(`  L${c.line}  ${c.name.padEnd(24)} ${c.from}  →  ${c.to}`);
}

if (unmapped.length) {
  console.log(`\n⚠️  块内仍有 ${unmapped.length} 处未映射色值（人工判断是否收进 identity.css）：`);
  for (const u of unmapped) console.log(`  L${u.line}  ${u.name}: ${u.value}`);
} else {
  console.log('\n✅ 块内无未映射色值');
}

if (write) {
  writeFileSync(file, lines.join('\n'));
  console.log(`\n✅ 已写入 ${file}`);
} else {
  console.log('\n（干跑，未写入。加 --write 落盘）');
}
