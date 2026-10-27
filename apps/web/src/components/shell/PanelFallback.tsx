// ============================================================
// shell/PanelFallback.tsx — **面板级**内容加载态（Suspense fallback）
//
// ★ 2026-10-07「跳转加载转圈」全修复（②/③）：
//   原先是 `ProjectLayout.tsx` 里的一个局部函数（只服务 auto 工作台一处），
//   而停靠内核 `dock/DockPanelContent.tsx` **完全没有 Suspense 边界** ——
//   dockview 的面板内容经 portal 挂在 DockviewReact 之下，最近的边界是
//   `routes/Lazy.tsx` 的路由级 fallback，于是「打开一个还没下载完的面板」
//   会把**整页**（顶栏 + 停靠区 + 状态栏）换成 32px 大转圈。
//   提到共享模块后两处共用同一种小转圈：面板 chunk 只在**面板自己的框内**加载。
//
// 颜色一律取 `--vscode-*` token（约定 C-3：不写字面色值兜底）。
// ============================================================

import { Loader2 } from 'lucide-react';

/**
 * 面板内容加载态。VS Code 风格：无边框转圈 + 次级文字，撑满所在容器。
 *
 * 用 `.shell-panel-fallback` 类（定义在 `project-shell.css`）：
 *   `height/width:100%` ⇒ 停靠面板内正好铺满面板体；
 *   `min-height` 兜住「父级高度为 auto」的场合（auto 工作台那条整页分支）。
 */
export function PanelFallback() {
  return (
    <div className="shell-panel-fallback" role="status" aria-label="加载中">
      <Loader2 size={18} className="dock-spin" style={{ color: 'var(--vscode-descriptionForeground)' }} />
      <span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>加载中…</span>
    </div>
  );
}
