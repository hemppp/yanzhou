import { useEffect, useMemo, useRef } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { Node, Edge } from '@xyflow/react';
import {
  DEFAULT_CENTER_X,
  DEFAULT_CENTER_Y,
  LINK_GAP,
  computeDegrees,
  layoutSignature,
  seedLayoutPositions,
  type LayoutPoint,
} from './forceLayout';

// 标准力导向布局 hook —— 三个关系图共用同一套参数
//
// 2026-11-13 优化（结构图算法）：
//   1. **确定性初始布局**：不再用 Math.random() 撒点；新节点贴着邻居长出来，
//      同一份数据每次得到同一张图（见 forceLayout.ts）。
//   2. **重启条件改为结构签名**：增删一条关系、物品持有变化都会重排；
//      选中/悬停导致的 data 变化不会。旧实现只看节点数，关系变化时布局不动。
//   3. **力参数按节点尺寸/度数自适应**：连线距离 = 两半径 + 间隙；
//      度数越高斥力越强；碰撞检测迭代 2 次，大节点不再互相压住。
//   4. **大图离线计算**：节点 > 180 时同步跑完再一次性提交，避免每帧
//      setNodes 造成几百次 React 渲染；小图仍逐帧动画，但每 2 帧才提交一次。
//   5. **保留用户拖拽结果**：位置缓存跨重排复用，不会把用户摆好的节点拽回原位。
//
// 参数基准：
//   linkDistance     两节点半径 + 70
//   chargeStrength   -300 ~ -780（按度数递增）
//   centerStrength   0.05（均值居中）+ forceX/Y 0.015（防漂移）
//   collideStrength  0.9，iterations 2
//   alphaDecay       0.035
//   velocityDecay    0.4

interface SimNode extends SimulationNodeDatum {
  id: string;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}

interface UseForceLayoutOptions {
  nodes: Node[];
  edges: Edge[];
  sizeMap: Map<string, number>; // 节点 id -> 碰撞半径
  centerX?: number;
  centerY?: number;
  onTick: (positions: Map<string, { x: number; y: number }>) => void;
}

/** 超过这个节点数就不再逐帧动画，改为同步算完一次性提交 */
const LARGE_GRAPH_THRESHOLD = 180;
/** 大图同步迭代次数：足够让力场收敛，又不会阻塞太久 */
const SYNC_TICKS = 260;

function endpointId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    return String((value as { id: unknown }).id);
  }
  return '';
}

export function useForceLayout({
  nodes,
  edges,
  sizeMap,
  centerX = DEFAULT_CENTER_X,
  centerY = DEFAULT_CENTER_Y,
  onTick,
}: UseForceLayoutOptions) {
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  /** 上一次布局结果（含用户拖拽后的位置），跨重排复用 */
  const positionsRef = useRef<Map<string, LayoutPoint>>(new Map());

  /** 结构签名：只有节点/边的拓扑变化才重排 */
  const signature = useMemo(() => layoutSignature(nodes, edges), [nodes, edges]);

  /** 用 ref 取最新数据，避免把 nodes/edges 的每次新引用写进 effect 依赖 */
  const dataRef = useRef({ nodes, edges, sizeMap });
  dataRef.current = { nodes, edges, sizeMap };

  useEffect(() => {
    const { nodes: graphNodes, edges: graphEdges, sizeMap: sizes } = dataRef.current;

    // 删掉已经不存在的节点，避免缓存无限增长
    const alive = new Set(graphNodes.map((n) => n.id));
    for (const id of positionsRef.current.keys()) {
      if (!alive.has(id)) positionsRef.current.delete(id);
    }

    const seeded = seedLayoutPositions(
      graphNodes,
      graphEdges,
      sizes,
      positionsRef.current,
      centerX,
      centerY,
    );
    positionsRef.current = seeded;

    const emit = (simNodes: SimNode[]) => {
      const positions = new Map<string, { x: number; y: number }>();
      for (const node of simNodes) {
        if (typeof node.x === 'number' && typeof node.y === 'number') {
          positions.set(node.id, { x: node.x, y: node.y });
        }
      }
      positionsRef.current = positions;
      onTickRef.current(positions);
    };

    const simNodes: SimNode[] = graphNodes.map((node) => {
      const point = seeded.get(node.id)!;
      return { id: node.id, x: point.x, y: point.y };
    });

    // 先把种子位置画出来，避免首帧停留在调用方给的随机坐标上
    emit(simNodes);

    if (simNodes.length < 2) return;

    const nodeIds = new Set(simNodes.map((n) => n.id));
    const simLinks: SimLink[] = graphEdges
      .map((edge) => ({
        source: endpointId(edge.source),
        target: endpointId(edge.target),
      }))
      .filter(
        (link) =>
          link.source !== link.target &&
          nodeIds.has(link.source) &&
          nodeIds.has(link.target),
      );

    const degrees = computeDegrees(graphNodes, graphEdges);
    const radiusOf = (id: string) => {
      const radius = sizes.get(id);
      return Number.isFinite(radius) && (radius as number) > 0 ? (radius as number) : 30;
    };

    const simulation: Simulation<SimNode, SimLink> = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d: SimNode) => d.id)
          .distance((link) => {
            const source = endpointId(link.source);
            const target = endpointId(link.target);
            return radiusOf(source) + radiusOf(target) + LINK_GAP;
          })
          .strength((link) => {
            const source = endpointId(link.source);
            const target = endpointId(link.target);
            const sourceDegree = degrees.get(source) ?? 1;
            const targetDegree = degrees.get(target) ?? 1;
            // 叶子-叶子拉得紧，枢纽-叶子放松，避免枢纽把一圈节点压成一团
            return Math.max(0.08, Math.min(1, 1 / Math.min(sourceDegree, targetDegree)));
          }),
      )
      .force(
        'charge',
        forceManyBody<SimNode>()
          .strength((d) => -(300 + Math.min(degrees.get(d.id) ?? 0, 12) * 40))
          .distanceMax(900)
          .theta(0.9),
      )
      .force('center', forceCenter<SimNode>(centerX, centerY).strength(0.05))
      .force('x', forceX<SimNode>(centerX).strength(0.015))
      .force('y', forceY<SimNode>(centerY).strength(0.015))
      .force(
        'collide',
        forceCollide<SimNode>()
          .radius((d) => radiusOf(d.id) + 6)
          .strength(0.9)
          .iterations(2),
      )
      .alphaDecay(0.035)
      .velocityDecay(0.4);

    // 大图：同步跑完再提交一次，避免几百次 React 渲染
    if (simNodes.length > LARGE_GRAPH_THRESHOLD) {
      simulation.stop();
      for (let i = 0; i < SYNC_TICKS; i += 1) simulation.tick();
      emit(simNodes);
      return;
    }

    // 小图：逐帧动画，但每 2 帧才提交一次（约 30fps，肉眼仍然连续）
    let ticks = 0;
    simulation
      .on('tick', () => {
        ticks += 1;
        if (ticks % 2 === 0) emit(simNodes);
      })
      .on('end', () => emit(simNodes));

    return () => {
      simulation.stop();
    };
  }, [signature, centerX, centerY]);
}
