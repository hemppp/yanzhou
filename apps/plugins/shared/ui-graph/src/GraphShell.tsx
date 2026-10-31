import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Network } from 'lucide-react';
import { BubbleNode } from './BubbleNode';
// ★ Graph3D 走**惰性**：它拖着 three.js（打包后 1.18 MB）。原来静态 import 的后果是
//   「只要挂上 GraphShell 就把 three 拉下来」—— 而 GraphShell 又被三个关系图共用，
//   于是**打开关系图谱、甚至只是进 AI 工作台**（工作台静态引 GraphShell）都会白付这 1.18 MB。
//   实测（生产产物）：GraphShell chunk 的静态 import 里明确列着 vendor-three。
//   改成惰性后，three 只在用户真的点「3D」时才下载。
//   Graph3D 用 React 19 的 ref-as-prop（props 里有 `ref?`），所以 lazy 不需要 forwardRef 包一层。
import type { Graph3DHandle } from './Graph3D';
const Graph3D = lazy(() => import('./Graph3D').then((m) => ({ default: m.Graph3D })));
import {
  applyMultiEdgeCurvature,
  applyEdgeLabelVisibility,
  enhancedEdgeTypes,
} from './enhancedEdges';

// 标准图谱框架 —— 三个关系图共用的布局骨架
//
// 提供：
//   - 统一顶栏（标题 + 计数 + 导出 PNG/SVG + 边标签开关 + 可选图例）
//   - 统一画布（圆形纯色球节点 + 力导向 + MiniMap + Controls）
//     · 多边曲率自动分配（同对节点多条边对称弯曲）
//     · 自环边专用渲染（顶部小拱门）
//   - 统一侧栏（w-64，传入 detail 内容）
//   - 统一空状态（Network icon + 提示文案）
//   - 统一 hover/selected 视觉反馈（由 BubbleNode 内部处理）
//
// 业务方只需传入：
//   nodes / edges / nodeTypes / 事件回调 / detail / legend / 计数文案

export interface GraphShellProps {
  title: string;
  countText: string;
  emptyHint: string;
  nodes: Node[];
  edges: Edge[];
  nodeTypes?: NodeTypes;
  edgeTypes?: EdgeTypes;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onNodeClick?: (event: React.MouseEvent, node: Node) => void;
  onNodeMouseEnter?: (event: React.MouseEvent, node: Node) => void;
  onNodeMouseLeave?: (event: React.MouseEvent) => void;
  onEdgeClick?: (event: React.MouseEvent, edge: Edge) => void;
  onEdgeMouseEnter?: (event: React.MouseEvent, edge: Edge) => void;
  onEdgeMouseLeave?: (event: React.MouseEvent) => void;
  onConnect?: OnConnect;
  connectionLineStyle?: React.CSSProperties;
  defaultEdgeOptions?: Partial<Edge>;
  getNodeColor?: (node: Node) => string;
  legend?: ReactNode;
  detail?: ReactNode;
  exportFileNamePrefix?: string;
}

const defaultNodeTypes: NodeTypes = {
  bubble: BubbleNode,
};

// 合并业务方传入的 edgeTypes 与内置的 selfloop 类型
// 业务方优先：若业务方也定义了 selfloop，以业务方为准
function mergeEdgeTypes(custom?: EdgeTypes): EdgeTypes {
  return { ...enhancedEdgeTypes, ...(custom || {}) };
}

export function GraphShell({
  title,
  countText,
  emptyHint,
  nodes,
  edges,
  nodeTypes = defaultNodeTypes,
  edgeTypes,
  onNodesChange,
  onEdgesChange,
  onNodeClick,
  onNodeMouseEnter,
  onNodeMouseLeave,
  onEdgeClick,
  onEdgeMouseEnter,
  onEdgeMouseLeave,
  onConnect,
  connectionLineStyle,
  defaultEdgeOptions,
  getNodeColor,
  legend,
  detail,
  exportFileNamePrefix = 'graph',
}: GraphShellProps) {
  const flowRef = useRef<HTMLDivElement>(null);
  const graph3dRef = useRef<Graph3DHandle>(null);
  // 边标签全局开关：默认关闭，避免边密集时视觉混乱
  // hover/selected 时业务方可单独覆盖 opacity 显示
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  // 视图模式：2D（React Flow 精确编辑）| 3D（three.js 沉浸浏览）
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');

  const isEmpty = nodes.length === 0;

  // 应用增强：多边曲率 + 自环边类型 + 标签显隐
  const enhancedEdges = useMemo(() => {
    const curved = applyMultiEdgeCurvature(edges);
    return applyEdgeLabelVisibility(curved, showEdgeLabels);
  }, [edges, showEdgeLabels]);

  const mergedEdgeTypes = useMemo(() => mergeEdgeTypes(edgeTypes), [edgeTypes]);

  const onExport = async (format: 'png' | 'svg') => {
    // 3D 模式：仅支持 PNG（WebGL canvas 快照）
    if (viewMode === '3d') {
      if (format !== 'png') return;
      const dataUrl = graph3dRef.current?.exportPNG();
      if (!dataUrl) return;
      const link = document.createElement('a');
      link.download = `${exportFileNamePrefix}-3d-${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
      return;
    }
    const flowElement = flowRef.current?.querySelector('.react-flow') as HTMLElement;
    if (!flowElement) return;
    try {
      // ★ html-to-image（打包 94 KB）按需加载：它只在**点导出**时用得上，
      //   静态 import 会让每个挂 GraphShell 的页面都先付这 94 KB。
      const { toPng, toSvg } = await import('html-to-image');
      const dataUrl = format === 'png'
        ? await toPng(flowElement, { backgroundColor: '#ffffff' })
        : await toSvg(flowElement, { backgroundColor: '#ffffff' });
      const link = document.createElement('a');
      link.download = `${exportFileNamePrefix}-${Date.now()}.${format}`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error('[GraphShell] 导出失败:', error);
      alert('导出失败，请重试');
    }
  };

  if (isEmpty) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-sm">{title}</h2>
            <span className="text-xs text-muted-foreground">{countText}</span>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center bg-background">
          <div className="text-center max-w-sm px-6">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
              <Network size={28} className="text-muted-foreground" />
            </div>
            <p className="text-sm text-foreground/85 font-medium mb-1">暂无数据</p>
            <p className="text-xs text-muted-foreground">{emptyHint}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <div className="p-3 border-b">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-sm">{title}</h2>
            <span className="text-xs text-muted-foreground">{countText}</span>
          </div>
          <div className="flex gap-2 items-center">
            {/* 视图模式切换 */}
            <div className="flex items-center gap-0.5 border rounded-xl p-0.5" role="tablist" aria-label="图谱视图模式">
              <button
                onClick={() => setViewMode('2d')}
                role="tab"
                aria-selected={viewMode === '2d'}
                className={`px-2.5 py-1 text-xs rounded-[10px] transition-colors ${
                  viewMode === '2d' ? 'bg-primary text-white' : 'hover:bg-accent text-muted-foreground'
                }`}
              >
                2D
              </button>
              <button
                onClick={() => setViewMode('3d')}
                role="tab"
                aria-selected={viewMode === '3d'}
                className={`px-2.5 py-1 text-xs rounded-[10px] transition-colors ${
                  viewMode === '3d' ? 'bg-primary text-white' : 'hover:bg-accent text-muted-foreground'
                }`}
              >
                3D
              </button>
            </div>
            {/* 边标签开关（仅 2D） */}
            {viewMode === '2d' && (
              <label
                className="flex items-center gap-1.5 px-2 py-1 text-xs border rounded-xl hover:bg-accent transition-colors cursor-pointer"
                title="切换关系标签显隐"
              >
                <input
                  type="checkbox"
                  checked={showEdgeLabels}
                  onChange={(e) => setShowEdgeLabels(e.target.checked)}
                  className="w-3 h-3 cursor-pointer"
                  aria-label="切换关系标签显隐"
                />
                <span>边标签</span>
              </label>
            )}
            <button
              onClick={() => onExport('png')}
              className="px-3 py-1 text-xs border rounded-xl hover:bg-accent transition-colors"
              aria-label="导出为 PNG 图片"
            >
              导出 PNG
            </button>
            <button
              onClick={() => onExport('svg')}
              disabled={viewMode === '3d'}
              className={`px-3 py-1 text-xs border rounded-xl transition-colors ${
                viewMode === '3d'
                  ? 'opacity-40 cursor-not-allowed text-muted-foreground'
                  : 'hover:bg-accent'
              }`}
              aria-label="导出为 SVG 图片"
              title={viewMode === '3d' ? '3D 模式仅支持 PNG 导出' : undefined}
            >
              导出 SVG
            </button>
          </div>
        </div>
        {legend && <div className="flex gap-4 flex-wrap">{legend}</div>}
      </div>

      {/* 画布 + 侧栏 */}
      <div className="flex-1 flex" ref={flowRef}>
        <div className="flex-1">
          {viewMode === '3d' ? (
            <Suspense
              fallback={(
                <div className="h-full w-full flex items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  正在载入 3D 视图…
                </div>
              )}
            >
              <Graph3D
                ref={graph3dRef}
                nodes={nodes}
                edges={edges}
                getNodeColor={getNodeColor}
                onNodeClick={(node) => onNodeClick?.(null as unknown as React.MouseEvent, node)}
                onNodeHover={(node) => {
                  if (node) {
                    onNodeMouseEnter?.(null as unknown as React.MouseEvent, node);
                  } else {
                    onNodeMouseLeave?.(null as unknown as React.MouseEvent);
                  }
                }}
                onBackgroundClick={() => onNodeMouseLeave?.(null as unknown as React.MouseEvent)}
              />
            </Suspense>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={enhancedEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              onNodeMouseEnter={onNodeMouseEnter}
              onNodeMouseLeave={onNodeMouseLeave}
              onEdgeClick={onEdgeClick}
              onEdgeMouseEnter={onEdgeMouseEnter}
              onEdgeMouseLeave={onEdgeMouseLeave}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              edgeTypes={mergedEdgeTypes}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              className="bg-background"
              connectionLineStyle={connectionLineStyle}
              defaultEdgeOptions={{ type: 'bubble', ...defaultEdgeOptions }}
            >
              <Background color="hsl(var(--border))" gap={20} />
              <Controls className="!bg-card !border-border !shadow-lg" />
              {getNodeColor && (
                <MiniMap
                  nodeColor={getNodeColor}
                  className="!bg-card !border-border"
                  // ★ 必须包 `hsl()`：`--background` 存的是**裸三元组**（`0 0% 98%`），
                  //   直接当颜色用是非法值 → SVG fill 回退成黑色，整个 MiniMap 变成一块黑板
                  //   （2026-09-15 真机截图发现）。同理 nodeColor 返回的也必须是完整颜色。
                  maskColor="hsl(var(--background))"
                />
              )}
            </ReactFlow>
          )}
        </div>

        {detail && (
          <div className="w-64 border-l p-3 overflow-y-auto space-y-3">
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

// 关系类型选择弹窗 —— 三个图谱创建关系时共用
export interface RelationTypeOption {
  type: string;
  label: string;
  color: string;
}

export function RelationTypeDialog({
  open,
  options,
  onSelect,
  onCancel,
}: {
  open: boolean;
  options: RelationTypeOption[];
  onSelect: (type: string) => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      role="dialog"
      aria-label="选择关系类型"
    >
      <div className="bg-background border rounded-2xl p-4 w-80 shadow-xl">
        <h3 className="font-bold mb-3">选择关系类型</h3>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {options.map(({ type, label, color }) => (
            <button
              key={type}
              onClick={() => onSelect(type)}
              className="p-2 rounded-xl border hover:bg-accent text-left"
              style={{ borderColor: color }}
              aria-label={`创建${label}关系`}
            >
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-sm">{label}</span>
              </div>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-sm text-muted-foreground"
            aria-label="取消选择关系类型"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

// 工具：构造 onConnect 的 pending 状态
// （未使用，保留以备未来扩展；当前业务方各自管理 pending 状态）
