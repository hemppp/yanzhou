// ============================================================
// auto 子插件 · entities —— 实体与设定（只读总览图谱）
//
// 设计 §2.2「entities 新写薄封装，不复制 RelationGraph」：
//   · 手写台的 `RelationGraph`（665 行，含角色/物品/地点 CRUD）属 **manual**，
//     auto 模块**不得**静态 import 它（否则 A2M 违规）。
//   · 本文件是 auto 自带的**轻量只读**实现：只用 shared `ui-graph` 的图元
//     （GraphShell / BubbleNode / useForceLayout）+ data-core 的实体 store，
//     把「角色—关系」「物品—当前持有人」「地点—出场角色」渲染成一张总览图。
//   · 编辑仍在手写台完成；此处定位是 AI 写作时的**速览**。
// ============================================================

import { useMemo, useState } from 'react';
import type { Node, Edge, NodeTypes, OnNodesChange, OnEdgesChange } from '@xyflow/react';
import { useNodesState, useEdgesState } from '@xyflow/react';
import { useCharacterStore, useItemStore, useLocationStore } from '@novel-plugins/data-core/stores';
import { GraphShell, BubbleNode, useForceLayout } from '@novel-plugins/ui-graph';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';

/** 墨阶配色（与手写台一致：区分靠深浅，不靠色相） */
const ROLE_INK: Record<string, string> = {
  protagonist: 'hsl(0 0% 12%)',
  femaleLead: 'hsl(0 0% 20%)',
  supporting: 'hsl(0 0% 34%)',
  minor: 'hsl(0 0% 52%)',
};
const ROLE_LABEL: Record<string, string> = {
  protagonist: '主角', femaleLead: '女主', supporting: '配角', minor: '路人',
};
const KIND_INK = { character: 'hsl(0 0% 18%)', item: 'hsl(0 0% 40%)', location: 'hsl(0 0% 58%)' };

const nodeTypes: NodeTypes = { bubble: BubbleNode };

function bubble(id: string, label: string, kind: keyof typeof KIND_INK, size: number, sub?: string, color?: string): Node {
  return {
    id,
    type: 'bubble',
    position: { x: 0, y: 0 },
    data: { label, sub, kind, variant: 'round', size, color: color ?? KIND_INK[kind] },
  };
}

export function EntityOverviewPanel() {
  const projectId = useCurrentProjectId();
  const characters = useCharacterStore((s) => s.characters);
  const items = useItemStore((s) => s.items);
  const locations = useLocationStore((s) => s.locations);
  const [tab, setTab] = useState<'characters' | 'items' | 'locations'>('characters');

  // 项目内实体（与手写台口径一致：按 projectId 过滤）
  const chars = useMemo(
    () => characters.filter((c) => !projectId || c.projectId === projectId),
    [characters, projectId],
  );
  const projItems = useMemo(
    () => items.filter((i) => !projectId || i.projectId === projectId),
    [items, projectId],
  );
  const projLocs = useMemo(
    () => locations.filter((l) => !projectId || l.projectId === projectId),
    [locations, projectId],
  );

  const { nodes: initNodes, edges: initEdges } = useMemo(() => {
    const ns: Node[] = [];
    const es: Edge[] = [];
    const seen = new Set<string>();
    const push = (n: Node) => { if (!seen.has(n.id)) { seen.add(n.id); ns.push(n); } };

    if (tab === 'characters') {
      for (const c of chars) {
        push(bubble(
          `c:${c.id}`, c.name, 'character',
          c.role === 'protagonist' || c.role === 'femaleLead' ? 56 : 38,
          c.role ? ROLE_LABEL[c.role] ?? c.role : undefined,
          ROLE_INK[c.role ?? ''] ?? 'hsl(0 0% 50%)',
        ));
      }
      const ids = new Set(chars.map((c) => c.id));
      for (const c of chars) {
        for (const r of c.relations ?? []) {
          if (!ids.has(r.targetId)) continue;   // 关系目标不在本项目内则跳过
          es.push({
            id: `r:${c.id}:${r.targetId}:${r.type}`,
            source: `c:${c.id}`,
            target: `c:${r.targetId}`,
            type: 'straight',
            label: r.type,
            style: { strokeOpacity: 0.35 },
          });
        }
      }
    } else if (tab === 'items') {
      for (const i of projItems) {
        push(bubble(`i:${i.id}`, i.name, 'item', 34, i.type));
        // 物品 → 当前持有人（currentHolders: string[] 即角色 id）
        for (const hid of i.currentHolders ?? []) {
          const holder = chars.find((c) => c.id === hid);
          if (!holder) continue;
          push(bubble(`c:${holder.id}`, holder.name, 'character', 30));
          es.push({ id: `h:${i.id}:${holder.id}`, source: `i:${i.id}`, target: `c:${holder.id}`, type: 'straight' });
        }
      }
    } else {
      for (const l of projLocs) {
        const n = (l.chapters ?? []).length;
        push(bubble(`l:${l.id}`, l.name, 'location', 34, n ? `出场 ${n} 章` : undefined));
        // 地点 ↔ 角色：以「地点出场章节」与「角色出场章节」的交集建立弱关联
        const locChapters = new Set(l.chapters ?? []);
        if (!locChapters.size) continue;
        for (const c of chars) {
          const shared = (c.chapters ?? []).filter((x) => locChapters.has(x));
          if (!shared.length) continue;
          push(bubble(`c:${c.id}`, c.name, 'character', 28));
          es.push({ id: `lc:${l.id}:${c.id}`, source: `l:${l.id}`, target: `c:${c.id}`, type: 'straight' });
        }
      }
    }

    return { nodes: ns, edges: es };
  }, [tab, chars, projItems, projLocs]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initNodes);
  const [edges, , onEdgesChange] = useEdgesState(initEdges);

  const sizeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.id, ((n.data?.size as number) ?? 34) / 2);
    return m;
  }, [nodes]);

  useForceLayout({
    nodes,
    edges,
    sizeMap,
    trigger: nodes.length,
    onTick: (positions) => {
      setNodes((prev) =>
        prev.map((n) => {
          const p = positions.get(n.id);
          return p ? { ...n, position: { x: p.x, y: p.y } } : n;
        }),
      );
    },
  });

  const counts = { characters: chars.length, items: projItems.length, locations: projLocs.length };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-3 pt-3 pb-1">
        {([['characters', '角色'], ['items', '物品'], ['locations', '地点']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-2.5 py-1 rounded-full text-[11px] transition-colors ${
              tab === k ? 'bg-secondary font-medium' : 'opacity-60 hover:opacity-100'
            }`}
          >
            {label} {counts[k]}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        <GraphShell
          title={tab === 'characters' ? '角色关系' : tab === 'items' ? '物品持有' : '地点分布'}
          countText={`${nodes.length} 个节点 · ${edges.length} 条关系`}
          /* ★ 2026-10-22（U3 修复）：原文案是「可在手写台的面板中维护」，但本面板
             只出现在 AI 模式，而手写台面板在 AI 模式下**不挂载**（模式分离的既定契约）
             —— 等于把用户指向一个不可达的入口。改成指向本模式真实存在的路径。 */
          emptyHint="暂无实体数据 —— 流水线跑过「角色与节奏 / 世界圣经」后，角色、地点、物品会出现在这里"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange as OnNodesChange}
          onEdgesChange={onEdgesChange as OnEdgesChange}
          exportFileNamePrefix="entity-overview"
        />
      </div>
    </div>
  );
}

export default EntityOverviewPanel;