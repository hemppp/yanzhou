// ============================================================
// 增强边工具集 —— 多边曲率 + 自环边
//
// 灵感来源：MiroFish GraphPanel.vue 的 edgePairCount/edgePairIndex 算法。
// 本实现为原创 TypeScript / React Flow 版本，未复制任何源代码。
//
// 提供两个能力：
//   1. applyMultiEdgeCurvature(edges)
//      对同一对节点之间的多条边分配递增/递减曲率，避免重叠。
//      同时把自环边标记为 'selfloop' 类型，交由 SelfLoopEdge 渲染。
//
//   2. SelfLoopEdge
//      React Flow 自定义边组件，用顶部小圆弧绘制自环。
// ============================================================

import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
  useStore,
} from '@xyflow/react';
import { colorWithAlpha } from './BubbleNode';

/** 统一的边视觉：圆头、圆角、缩放时线宽不跟着变粗 */
function edgeStyleOf(style: React.CSSProperties | undefined): React.CSSProperties {
  return {
    ...style,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    vectorEffect: 'non-scaling-stroke',
  } as React.CSSProperties;
}

/** 关系标签：小胶囊 + 颜色圆点，保证在任意底色上都能读清 */
function EdgeLabelPill({
  x,
  y,
  label,
  color,
  opacity,
}: {
  x: number;
  y: number;
  label: string;
  color: string;
  opacity: number;
}) {
  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan"
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          pointerEvents: 'all',
          opacity,
          transition: 'opacity 120ms ease',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '2px 7px',
          borderRadius: 999,
          background: 'hsl(var(--card))',
          border: `1px solid ${colorWithAlpha(color, 0.38)}`,
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12)',
          fontSize: 10,
          fontWeight: 600,
          lineHeight: 1.5,
          color: 'hsl(var(--foreground))',
          whiteSpace: 'nowrap',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: color,
            flex: '0 0 auto',
          }}
        />
        {label}
      </div>
    </EdgeLabelRenderer>
  );
}

// ---------- 类型扩展 ----------

// React Flow 的基础 Edge 类型不带 pathOptions，只有 BezierEdge 等子类型才有。
// 这里本地扩展类型用于多边曲率分配，运行时 React Flow 会读取该字段。
type EdgeWithCurvature = Edge & {
  pathOptions?: { curvature?: number };
};

// ---------- 1. 多边曲率计算 ----------

/**
 * 为同一对节点之间的多条边分配曲率。
 *
 * 规则：
 *   - 单条边：使用默认曲率 0.25，保持视觉简洁
 *   - 多条边：以 0 为中心对称分布，步长 0.25，奇数边居中、偶数边对称
 *   - 自环边（source === target）：标记为 'selfloop' 类型，不参与曲率分配
 *
 * @example
 *   // A→B 有 3 条边，曲率分别为 -0.25, 0, 0.25（中间直、两侧弯）
 *   // A→B 有 2 条边，曲率分别为 -0.25, 0.25（对称弯曲）
 */
export function applyMultiEdgeCurvature(edges: Edge[]): Edge[] {
  // 1. 分离自环边与普通边
  const selfLoopEdges: Edge[] = [];
  const normalEdges: Edge[] = [];
  for (const e of edges) {
    if (e.source === e.target) {
      selfLoopEdges.push(e);
    } else {
      normalEdges.push(e);
    }
  }

  // 2. 按节点对（无向）分组统计
  //    key = sorted([source, target]).join('|')
  const pairGroups = new Map<string, Edge[]>();
  for (const e of normalEdges) {
    const key = [e.source, e.target].sort().join('|');
    const group = pairGroups.get(key);
    if (group) {
      group.push(e);
    } else {
      pairGroups.set(key, [e]);
    }
  }

  // 3. 为每组分配曲率
  const result: Edge[] = [];
  for (const group of pairGroups.values()) {
    if (group.length === 1) {
      const e = group[0];
      if (!e) continue;
      // bubble 类型保留原类型（直线贴边框）
      if (e.type === 'bubble') {
        result.push(e);
      } else {
        const enriched: EdgeWithCurvature = {
          ...e,
          type: e.type === 'straight' ? 'default' : e.type,
          pathOptions: { curvature: 0.25 },
        };
        result.push(enriched);
      }
      continue;
    }

    // 多条边：以 0 为中心对称分布
    const n = group.length;
    const step = 0.25;
    const startIndex = -(n - 1) / 2;
    group.forEach((e, i) => {
      const curvature = (startIndex + i) * step;
      // bubble 类型的多条边：保留 bubble 类型，但加上 curvature（由 BubbleEdge 弯曲处理）
      if (e.type === 'bubble') {
        const enriched: EdgeWithCurvature = {
          ...e,
          type: 'bubble',
          pathOptions: { curvature },
        };
        result.push(enriched);
      } else {
        const enriched: EdgeWithCurvature = {
          ...e,
          type: 'default',
          pathOptions: { curvature },
        };
        result.push(enriched);
      }
    });
  }

  // 4. 自环边使用专门的 SelfLoopEdge
  for (const e of selfLoopEdges) {
    result.push({
      ...e,
      type: 'selfloop',
    });
  }

  return result;
}

// ---------- 2. 气泡边：连线贴边框 ----------

/**
 * 气泡边：连线起点和终点都贴在圆形节点的边缘上。
 * 参考气泡知识图谱的视觉效果：线从圆的边缘出发，而不是圆心。
 *
 * 计算方式：
 *   - 已知 source(圆心)、target(圆心)、sourceR(源半径)、targetR(目标半径)
 *   - 方向向量 = target - source
 *   - 源边上的点 = source + normalize(dir) * sourceR
 *   - 目标边上的点 = target - normalize(dir) * targetR
 */
export const BubbleEdge = memo(function BubbleEdge({
  source,
  target,
  style,
  markerEnd,
  label,
  labelStyle,
  data,
  pathOptions,
}: EdgeProps & {
  data?: { sourceR?: number; targetR?: number; color?: string };
  pathOptions?: { curvature?: number };
}) {
  const curvature = pathOptions?.curvature ?? 0;

  // 从 store 中获取源节点和目标节点的实际位置与尺寸
  const sourceNode = useStore((store) => store.nodeLookup.get(source));
  const targetNode = useStore((store) => store.nodeLookup.get(target));

  if (!sourceNode || !targetNode) return null;

  const sourceSize = (sourceNode.data as any)?.size ?? 60;
  const targetSize = (targetNode.data as any)?.size ?? 60;
  const sourceR = data?.sourceR ?? sourceSize / 2;
  const targetR = data?.targetR ?? targetSize / 2;

  // 节点 position 是左上角，节点大小就是气泡大小
  const scx = sourceNode.position.x + sourceSize / 2;
  const scy = sourceNode.position.y + sourceSize / 2;
  const tcx = targetNode.position.x + targetSize / 2;
  const tcy = targetNode.position.y + targetSize / 2;

  const dx = tcx - scx;
  const dy = tcy - scy;
  const dist = Math.hypot(dx, dy);

  if (dist < 1) return null;

  const nx = dx / dist;
  const ny = dy / dist;

  // 连线起点：贴源节点边框
  const sx = scx + nx * sourceR;
  const sy = scy + ny * sourceR;
  // 连线终点：贴目标节点边框
  const ex = tcx - nx * targetR;
  const ey = tcy - ny * targetR;

  let path: string;
  let midX: number;
  let midY: number;

  if (Math.abs(curvature) < 0.001) {
    path = `M ${sx} ${sy} L ${ex} ${ey}`;
    midX = (sx + ex) / 2;
    midY = (sy + ey) / 2;
  } else {
    const midXRaw = (sx + ex) / 2;
    const midYRaw = (sy + ey) / 2;
    const perpX = -ny * curvature * dist * 0.5;
    const perpY = nx * curvature * dist * 0.5;
    const cpx = midXRaw + perpX;
    const cpy = midYRaw + perpY;
    path = `M ${sx} ${sy} Q ${cpx} ${cpy} ${ex} ${ey}`;

    const t = 0.5;
    const invT = 1 - t;
    midX = invT * invT * sx + 2 * invT * t * cpx + t * t * ex;
    midY = invT * invT * sy + 2 * invT * t * cpy + t * t * ey;
  }

  const color = data?.color ?? 'hsl(var(--muted-foreground))';

  return (
    <>
      <BaseEdge
        path={path}
        style={edgeStyleOf(style)}
        markerEnd={markerEnd}
        interactionWidth={18}
      />
      {label && (
        <EdgeLabelPill
          x={midX}
          y={midY}
          label={String(label)}
          color={color}
          opacity={Number((labelStyle as React.CSSProperties | undefined)?.opacity ?? 1)}
        />
      )}
    </>
  );
});

// ---------- 3. 自环边组件 ----------

/**
 * 自环边：在节点顶部画一个小圆弧，表示实体与自身的关系。
 *
 * 视觉：从节点顶部右侧出发，经过上方，回到顶部左侧，形成一个小拱门。
 * 适用场景：角色"自我反思"、物品"自我转化"等自反关系。
 */
export const SelfLoopEdge = memo(function SelfLoopEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  label,
  labelStyle,
  data,
}: EdgeProps) {
  // 自环：source 与 target 是同一个节点，坐标相近
  // 构造一个从顶部出发、向上拱起、回到顶部的小弧线
  const loopRadius = 40;
  const loopOffset = 30; // 水平偏移，避免起点终点重合

  // 起点：节点顶部右侧
  const sx = sourceX + loopOffset;
  const sy = sourceY;
  // 终点：节点顶部左侧
  const tx = targetX - loopOffset;
  const ty = targetY;

  // 用 SVG arc 命令绘制顶部小拱门（large-arc-flag=1, sweep-flag=1）
  const arcPath = `M ${sx} ${sy} A ${loopRadius} ${loopRadius} 0 1 1 ${tx} ${ty}`;

  const color = (data as { color?: string } | undefined)?.color
    ?? 'hsl(var(--muted-foreground))';

  return (
    <>
      <BaseEdge
        path={arcPath}
        style={edgeStyleOf(style)}
        markerEnd={markerEnd}
        interactionWidth={18}
      />
      {label && (
        <EdgeLabelPill
          x={(sx + tx) / 2}
          y={sy - loopRadius - 8}
          label={String(label)}
          color={color}
          opacity={Number((labelStyle as React.CSSProperties | undefined)?.opacity ?? 1)}
        />
      )}
    </>
  );
});

// ---------- 4. 自定义 edgeTypes 集合 ----------

export const enhancedEdgeTypes = {
  selfloop: SelfLoopEdge,
  bubble: BubbleEdge,
};

// ---------- 4. 工具：批量控制边标签显隐 ----------

/**
 * 根据全局开关批量设置 edges 的 labelStyle.opacity。
 *
 * @param edges 原始边数组
 * @param showLabel true=始终显示，false=隐藏（由 hover/selected 单独控制时另算）
 */
export function applyEdgeLabelVisibility(edges: Edge[], showLabel: boolean): Edge[] {
  if (showLabel) {
    return edges.map((e) => ({
      ...e,
      labelStyle: { ...e.labelStyle, opacity: e.labelStyle?.opacity ?? 1 },
      labelBgStyle: { ...e.labelBgStyle, opacity: e.labelBgStyle?.opacity ?? 0.9 },
    }));
  }
  return edges.map((e) => ({
    ...e,
    labelStyle: { ...e.labelStyle, opacity: 0 },
    labelBgStyle: { ...e.labelBgStyle, opacity: 0 },
  }));
}
