import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  LINK_GAP,
  computeDegrees,
  layoutSignature,
  seedLayoutPositions,
} from '../forceLayout';

function node(id: string, data: Record<string, unknown> = {}): Node {
  return { id, position: { x: 0, y: 0 }, data };
}

function edge(source: string, target: string): Edge {
  return { id: `${source}-${target}`, source, target };
}

const sizes = (ids: string[], radius = 30) =>
  new Map(ids.map((id) => [id, radius]));

describe('layoutSignature', () => {
  it('与节点顺序、data 变化无关', () => {
    const a = layoutSignature([node('a'), node('b')], [edge('a', 'b')]);
    const b = layoutSignature(
      [node('b', { selected: true }), node('a', { hovered: true })],
      [edge('a', 'b')],
    );
    expect(a).toBe(b);
  });

  it('增删关系会改变签名（即使节点数不变）', () => {
    const before = layoutSignature([node('a'), node('b')], []);
    const after = layoutSignature([node('a'), node('b')], [edge('a', 'b')]);
    expect(after).not.toBe(before);
  });
});

describe('computeDegrees', () => {
  it('按唯一邻居计数，忽略自环与未知端点', () => {
    const degrees = computeDegrees(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('a', 'b'), edge('b', 'b'), edge('a', 'ghost'), edge('a', 'c')],
    );
    expect(degrees.get('a')).toBe(2);
    expect(degrees.get('b')).toBe(1);
    expect(degrees.get('c')).toBe(1);
  });
});

describe('seedLayoutPositions', () => {
  it('同一份输入得到完全相同的布局', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [edge('a', 'b'), edge('b', 'c')];

    const first = seedLayoutPositions(nodes, edges, sizes(['a', 'b', 'c', 'd']), new Map());
    const second = seedLayoutPositions(nodes, edges, sizes(['a', 'b', 'c', 'd']), new Map());

    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('保留已有位置（用户拖拽结果不被重排拽走）', () => {
    const previous = new Map([['a', { x: 12, y: 34 }]]);
    const positions = seedLayoutPositions([node('a'), node('b')], [edge('a', 'b')], sizes(['a', 'b']), previous);
    expect(positions.get('a')).toEqual({ x: 12, y: 34 });
  });

  it('新节点贴着已定位的邻居长出来', () => {
    const previous = new Map([['a', { x: 100, y: 100 }]]);
    const positions = seedLayoutPositions([node('a'), node('b')], [edge('a', 'b')], sizes(['a', 'b']), previous);
    const a = positions.get('a')!;
    const b = positions.get('b')!;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    expect(distance).toBeCloseTo(30 + 30 + LINK_GAP, 5);
  });

  it('孤立节点也会被放到有限坐标上，且不与主图重叠', () => {
    const positions = seedLayoutPositions([node('solo')], [], sizes(['solo']), new Map(), 450, 320);
    const solo = positions.get('solo')!;
    expect(Number.isFinite(solo.x)).toBe(true);
    expect(Number.isFinite(solo.y)).toBe(true);
    expect(Math.hypot(solo.x - 450, solo.y - 320)).toBeGreaterThan(200);
  });

  it('多个子节点不会落在同一位置', () => {
    const positions = seedLayoutPositions(
      [node('hub'), node('a'), node('b'), node('c')],
      [edge('hub', 'a'), edge('hub', 'b'), edge('hub', 'c')],
      sizes(['hub', 'a', 'b', 'c']),
      new Map(),
    );
    const points = ['a', 'b', 'c'].map((id) => positions.get(id)!);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThan(1);
      }
    }
  });
});
