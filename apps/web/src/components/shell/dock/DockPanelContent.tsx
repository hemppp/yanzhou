// ============================================================
// dock/DockPanelContent.tsx — dockview 面板内容渲染器（P2 · t3）
//
// dockview 通过 `components: Record<string, React.FC<IDockviewPanelProps>>`
// 按 `component` 字符串取渲染器。本内核只注册**一个**通用渲染器，
// 由 `params.defKey` 去外部传入的面板定义池里查组件 ——
// 这是「面板来源为外部传入的数组、不硬编码业务面板」的落点（ADR §1.6）。
//
// 颜色全部取 `--vscode-*`（ADR §5.3 / 约定 C-3：不写 `var(--x, #fff)` 兜底）。
// ============================================================

import React, { Suspense } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { IDockviewPanelProps } from 'dockview';
import { PanelFallback } from '../PanelFallback';
import type { DockPanelDef } from './types';

/** 传给业务面板的 params（dockview 会原样塞进 `props.params`）。 */
export interface DockPanelParams {
  /** 面板定义 key：渲染器据此查 `def` */
  defKey: string;
  def: DockPanelDef;
}

/**
 * 面板级渲染边界（沿用 ProjectLayout 的 PanelGuard 语义）：
 * 单个面板组件抛错只隔离在本面板内，不冒泡到根 ErrorBoundary。
 */
class PanelErrorBoundary extends React.Component<
  { label: string; children: React.ReactNode },
  { error: Error | null; attempt: number }
> {
  constructor(props: { label: string; children: React.ReactNode }) {
    super(props);
    this.state = { error: null, attempt: 0 };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="dock-panel-error"
          role="alert"
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            textAlign: 'center',
            overflow: 'auto',
            color: 'var(--vscode-panel-foreground)',
          }}
        >
          <AlertTriangle size={20} style={{ color: 'var(--vscode-semantic-warning)' }} />
          <div style={{ fontSize: 11 }}>
            「{this.props.label}」面板组件运行出错，已隔离在本面板内
          </div>
          <div
            style={{
              fontSize: 10,
              fontFamily: 'var(--vscode-font-family-mono)',
              wordBreak: 'break-all',
              maxWidth: '100%',
              color: 'var(--vscode-semantic-error)',
            }}
          >
            {String(this.state.error.message || this.state.error)}
          </div>
          <button
            type="button"
            className="dock-panel-retry"
            onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}
          >
            重试
          </button>
        </div>
      );
    }
    // attempt 变化 → 换 key 重挂子树
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}

/** 悬浮 / 停靠通用的内容外壳：撑满 + 用主题变量定底色。 */
export function DockPanelContent(props: IDockviewPanelProps<DockPanelParams>) {
  const params = props.params;
  const def = params?.def;

  if (!def) {
    return (
      <div className="dock-panel-missing" role="status">
        <Loader2 size={16} className="dock-spin" />
        <span>面板已卸载（候选池中找不到 key）</span>
      </div>
    );
  }

  const Component = def.Component;
  return (
    <PanelErrorBoundary label={def.label}>
      <div className="dock-panel-body" data-panel-key={def.key}>
        {/*
          ★ 2026-10-07「跳转加载转圈」全修复（根治项）：
          面板组件可能是 `React.lazy`（模块内的 12 个停靠面板 / 章节左栏 / AI 对话）。
          dockview 把面板内容经 `ReactDOM.createPortal` 挂在 `DockviewReact` 所在的
          div 下，**它自己不提供任何 Suspense 边界** —— 面板挂起会一路上溯到
          `routes/Lazy.tsx` 的路由级 fallback，把整页换成 32px「加载中...」大转圈
          （实测：探针面板挂起时外层 RouteFallback 确实出现过）。
          这里补一个面板级边界，让 chunk 加载只在本面板框内转圈（PanelFallback）。
        */}
        <Suspense fallback={<PanelFallback />}>
          <Component />
        </Suspense>
      </div>
    </PanelErrorBoundary>
  );
}

/** 水面图（空布局时显示），VS Code 的「无编辑器」风格。 */
export function DockWatermark() {
  return (
    <div className="dock-watermark">
      <div className="dock-watermark-title">无活动面板</div>
      <div className="dock-watermark-hint">
        从左侧活动栏或面板菜单中打开一个面板；面板标题栏可拖出为悬浮窗口。
      </div>
    </div>
  );
}

/** 关系图 / 图谱等重画布面板的**可替换插槽**实现（ADR §1.6 / D16）。 */
export function DockCenterSlot({ children }: { children: React.ReactNode }) {
  return (
    <div className="dock-center-slot" data-dock-slot="center">
      {children}
    </div>
  );
}
