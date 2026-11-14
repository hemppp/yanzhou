// ============================================================
// 力导向布局的纯计算部分（无 React / 无 d3 依赖）
//
// 从 useForceLayout 抽出来，目的有三：
//   1. 初始位置不再用 Math.random() —— 同一份数据每次得到同一张图；
//   2. 新增节点贴着它的邻居长出来，而不是随机丢到画布任意角落；
//   3. 这些规则可以被单测钉住（见 __tests__/forceLayout.test.ts）。
// ============================================================

import type { Edge, Node } from '@xyflow/react';

export interface LayoutPoint {
  x: number;
  y: number;
}

/** 黄金角：按它依次旋转，可以在不重叠的前提下把子节点铺开 */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** 默认画布中心（与三个关系图原有基准一致） */
export const DEFAULT_CENTER_X = 450;
export const DEFAULT_CENTER_Y = 320;

/** 连线两端节点之间的最小间隙（中心距 = 两半径 + 该值） */
export const LINK_GAP = 70;

/** 边端点可能是 id 字符串，也可能在 d3 初始化后被替换成节点对象 */
function endpointId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    return String((value as { id: unknown }).id);
  }
  return '';
}

/**
 * 结构签名：只包含「节点 id + 边端点」。
 *
 * 用它代替原来的 `trigger: characters.length`：
 *   - 增删一条关系（节点数不变）会重启布局；
 *   - 物品持有关系变化（角色数不变）会重启布局；
 *   - 选中/悬停导致 data 变化（结构没变）不会重启布局。
 */
export function layoutSignature(nodes: readonly Node[], edges: readonly Edge[]): string {
  const nodeIds = nodes.map((n) => n.id).sort();
  const edgeKeys = edges
    .map((e) => `${endpointId(e.source)}>${endpointId(e.target)}`)
    .sort();
  return `${nodeIds.join(',')}|${edgeKeys.join(',')}`;
}

/** 无向邻接表（忽略自环、未知端点与重复边） */
export function buildAdjacency(
  nodes: readonly Node[],
  edges: readonly Edge[],
): Map<string, Set<string>> {
  const ids = new Set(nodes.map((n) => n.id));
  const adjacency = new Map<string, Set<string>>();
  for (const id of ids) adjacency.set(id, new Set());

  for (const edge of edges) {
    const source = endpointId(edge.source);
    const target = endpointId(edge.target);
    if (source === target || !ids.has(source) || !ids.has(target)) continue;
    adjacency.get(source)!.add(target);
    adjacency.get(target)!.add(source);
  }
  return adjacency;
}

/** 每个节点的唯一邻居数（度） */
export function computeDegrees(
  nodes: readonly Node[],
  edges: readonly Edge[],
): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const [id, neighbors] of buildAdjacency(nodes, edges)) {
    degrees.set(id, neighbors.size);
  }
  return degrees;
}

function radiusOf(sizeMap: Map<string, number>, id: string): number {
  const radius = sizeMap.get(id);
  return Number.isFinite(radius) && (radius as number) > 0 ? (radius as number) : 30;
}

/**
 * 计算每个节点的初始位置。
 *
 * 规则：
 *   - `previous` 里已有的节点位置原样保留（用户拖过的节点不会被下一次重排拽走）；
 *   - 新节点若与已定位节点相连，就挂在邻居旁边（黄金角依次铺开）；
 *   - 完全孤立的分量按度优先选种子，放在外环上，避免和主图重叠；
 *   - 全程不使用随机数 ⇒ 同样的输入永远得到同样的初始布局。
 */
export function seedLayoutPositions(
  nodes: readonly Node[],
  edges: readonly Edge[],
  sizeMap: Map<string, number>,
  previous: ReadonlyMap<string, LayoutPoint>,
  centerX: number = DEFAULT_CENTER_X,
  centerY: number = DEFAULT_CENTER_Y,
): Map<string, LayoutPoint> {
  const ids = nodes.map((n) => n.id);
  const adjacency = buildAdjacency(nodes, edges);
  const positions = new Map<string, LayoutPoint>();

  for (const id of ids) {
    const point = previous.get(id);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      positions.set(id, { x: point.x, y: point.y });
    }
  }

  if (ids.length === 0) return positions;

  /** 每个锚点已铺开的子节点数 —— 决定黄金角上的第几个方向 */
  const childCount = new Map<string, number>();

  /** 从已定位节点向外 BFS：新节点贴着邻居长出来 */
  const growFromPlaced = () => {
    const queue = [...positions.keys()].sort();
    const queued = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentPos = positions.get(current)!;
      const neighbors = [...(adjacency.get(current) ?? [])]
        .filter((id) => !positions.has(id))
        .sort();

      for (const neighbor of neighbors) {
        const index = (childCount.get(current) ?? 0) + 1;
        childCount.set(current, index);
        const angle = GOLDEN_ANGLE * index;
        const distance = radiusOf(sizeMap, current) + radiusOf(sizeMap, neighbor) + LINK_GAP;
        positions.set(neighbor, {
          x: currentPos.x + Math.cos(angle) * distance,
          y: currentPos.y + Math.sin(angle) * distance,
        });
        if (!queued.has(neighbor)) {
          queue.push(neighbor);
          queued.add(neighbor);
        }
      }
    }
  };

  // 已有位置（例如用户拖拽后新增实体）：先把与它们相连的新节点铺开
  growFromPlaced();

  // 剩下的都是与已有图不连通的分量：按度优先选种子，放到外环
  const remaining = ids
    .filter((id) => !positions.has(id))
    .sort((a, b) => {
      const degreeDiff = (adjacency.get(b)?.size ?? 0) - (adjacency.get(a)?.size ?? 0);
      return degreeDiff !== 0 ? degreeDiff : a.localeCompare(b);
    });

  const outerBase = Math.max(220, 60 * Math.sqrt(ids.length));
  let component = 0;

  for (const seedId of remaining) {
    if (positions.has(seedId)) continue;

    const angle = GOLDEN_ANGLE * component;
    const ring = outerBase + Math.floor(component / 6) * 140;
    positions.set(seedId, {
      x: centerX + Math.cos(angle) * ring,
      y: centerY + Math.sin(angle) * ring,
    });

    // 该分量内部继续 BFS（共享 childCount，方向仍然确定）
    growFromPlaced();
    component += 1;
  }

  return positions;
}
