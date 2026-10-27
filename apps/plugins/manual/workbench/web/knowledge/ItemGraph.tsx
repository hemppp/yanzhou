import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type Connection,
  MarkerType,
} from '@xyflow/react';
import { useItemStore } from '@novel-plugins/data-core/stores';
import { useCharacterStore } from '@novel-plugins/data-core/stores';
import { deriveCurrentHolders, type ItemRelationType } from '@novel/shared';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';
import { BubbleNode } from '@novel-plugins/ui-graph/BubbleNode';
import { useForceLayout } from '@novel-plugins/ui-graph/useForceLayout';
import { GraphShell, RelationTypeDialog, type RelationTypeOption } from '@novel-plugins/ui-graph/GraphShell';

// ============================================================
// 物品关系图谱（标准图谱）
//
// 节点：圆形纯色球（BubbleNode）
//   - 物品节点：颜色取自 item.color 或 type 映射
//   - 角色节点：颜色取自 char.color 或默认蓝
// 边：straight，strokeOpacity 默认 0.4，hover/selected 时 0.9
// 关系 CRUD：拖拽物品→物品连线弹窗选关系类型，点击边弹确认删除
//   - 物品↔物品：写入 item.relations（双向互写以保持对称）
//   - 物品↔角色：currentHolders/holders 流转，本图不支持拖拽创建（业务复杂，请在物品面板管理）
// 同属/同类衍生边：保留现有逻辑，作为弱关系显示
// ============================================================

// 水墨化（2026-09-15）：按类型配色 → 按墨阶配色（饱和度恒 0）
const itemTypeColors: Record<string, string> = {
  weapon: 'hsl(0 0% 12%)',
  token: 'hsl(0 0% 34%)',
  artifact: 'hsl(0 0% 14%)',
  document: 'hsl(0 0% 52%)',
  key: 'hsl(0 0% 22%)',
  medicine: 'hsl(0 0% 44%)',
  other: 'hsl(0 0% 50%)',
  clothing: 'hsl(0 0% 40%)',
  vehicle: 'hsl(0 0% 42%)',
  treasure: 'hsl(0 0% 20%)',
  book: 'hsl(0 0% 30%)',
  food: 'hsl(0 0% 58%)',
  plant: 'hsl(0 0% 46%)',
  animal: 'hsl(0 0% 28%)',
  tool: 'hsl(0 0% 36%)',
  prop: 'hsl(0 0% 60%)',
  potion: 'hsl(0 0% 48%)',
  armor: 'hsl(0 0% 26%)',
  scroll: 'hsl(0 0% 38%)',
  gem: 'hsl(0 0% 16%)',
};

const itemRelationColors: Record<ItemRelationType, string> = {
  paired_with: 'hsl(0 0% 42%)',
  contains: 'hsl(0 0% 30%)',
  part_of: 'hsl(0 0% 50%)',
  opposite_of: 'hsl(0 0% 12%)',
  transforms_into: 'hsl(0 0% 24%)',
  related_to: 'hsl(0 0% 60%)',
};

const itemRelationLabels: Record<ItemRelationType, string> = {
  paired_with: '配对',
  contains: '包含',
  part_of: '部件',
  opposite_of: '对立',
  transforms_into: '变形',
  related_to: '关联',
};

function getItemColor(type?: string): string {
  return type ? (itemTypeColors[type.toLowerCase()] || 'hsl(0 0% 50%)') : 'hsl(0 0% 50%)';
}

function getItemSize(holderCount: number, relationCount: number): number {
  const score = holderCount * 2 + relationCount;
  if (score >= 6) return 56;
  if (score >= 4) return 46;
  if (score >= 2) return 36;
  return 30;
}

const CHARACTER_NODE_SIZE = 36;

const nodeTypes: NodeTypes = {
  bubble: BubbleNode,
};

export function ItemGraph() {
  const items = useItemStore((s) => s.items);
  const addItemRelation = useItemStore((s) => s.addItemRelation);
  const removeItemRelation = useItemStore((s) => s.removeItemRelation);
  const characters = useCharacterStore((s) => s.characters);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [relationDialogOpen, setRelationDialogOpen] = useState(false);

  const characterMap = useMemo(() => {
    const map = new Map<string, typeof characters[number]>();
    for (const c of characters) map.set(c.id, c);
    return map;
  }, [characters]);

  const itemMap = useMemo(() => {
    const map = new Map<string, typeof items[number]>();
    for (const it of items) map.set(it.id, it);
    return map;
  }, [items]);

  const getCurrentHolderNames = useCallback((item: typeof items[number]): string[] => {
    const list = (item.currentHolders && item.currentHolders.length > 0)
      ? item.currentHolders
      : deriveCurrentHolders(item.holders ?? []);
    if (list.length === 0) return [];
    return list
      .map((id) => characterMap.get(id)?.name)
      .filter((n): n is string => !!n);
  }, [characterMap]);

  // 生成节点 & 边
  const graphData = useMemo(() => {
    const validItemIds = new Set(items.map((i) => i.id));
    const validCharIds = new Set(characters.map((c) => c.id));

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const sizeMap = new Map<string, number>();

    // 物品节点
    items.forEach((item) => {
      const holderCount = getCurrentHolderNames(item).length;
      const relationCount = item.relations?.length ?? 0;
      const size = getItemSize(holderCount, relationCount);
      const color = item.color || getItemColor(item.type);
      sizeMap.set(item.id, size / 2);
      nodes.push({
        id: item.id,
        type: 'bubble',
        position: { x: Math.random() * 600 + 100, y: Math.random() * 500 + 50 },
        data: {
          label: item.name,
          color,
          size,
          subtitle: item.type || undefined,
          isSelected: false,
          isHovered: false,
        },
      });
    });

    // 角色节点（持有者）
    characters.forEach((char) => {
      sizeMap.set(char.id, CHARACTER_NODE_SIZE / 2);
      nodes.push({
        id: char.id,
        type: 'bubble',
        position: { x: Math.random() * 600 + 100, y: Math.random() * 500 + 50 },
        data: {
          label: char.name,
          color: char.color || 'hsl(var(--entity-character))',
          size: CHARACTER_NODE_SIZE,
          subtitle: '角色',
          isSelected: false,
          isHovered: false,
        },
      });
    });

    // 物品 → 持有者 边
    items.forEach((item) => {
      const holderIds = (item.currentHolders && item.currentHolders.length > 0)
        ? item.currentHolders
        : deriveCurrentHolders(item.holders ?? []);
      const validHolders = holderIds.filter((id) => validCharIds.has(id));
      const itemColor = item.color || getItemColor(item.type);
      const sourceR = sizeMap.get(item.id) ?? 23;

      validHolders.forEach((holderId) => {
        const targetR = sizeMap.get(holderId) ?? 18;
        edges.push({
          id: `hold-${item.id}-${holderId}`,
          source: item.id,
          target: holderId,
          label: '持有',
          type: 'bubble',
          style: { stroke: itemColor, strokeWidth: 1.5, strokeOpacity: 0.4 },
          labelStyle: { fill: itemColor, fontSize: 9.5, fontWeight: 600, opacity: 0 },
          labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd: { type: MarkerType.ArrowClosed, color: itemColor, width: 10, height: 10 },
          data: {
            kind: 'hold',
            sourceId: item.id,
            targetId: holderId,
            color: itemColor,
            sourceR,
            targetR,
          },
        });
      });
    });

    // 物品 → 物品 关系边
    const seenItemRel = new Set<string>();
    items.forEach((item) => {
      if (!item.relations || item.relations.length === 0) return;
      item.relations.forEach((rel) => {
        if (!validItemIds.has(rel.targetItemId)) return;
        if (rel.targetItemId === item.id) return;

        const key = [item.id, rel.targetItemId].sort().join('|') + '|' + rel.type;
        if (seenItemRel.has(key)) return;
        seenItemRel.add(key);

        const color = itemRelationColors[rel.type] ?? 'hsl(var(--muted-foreground))';
        const label = itemRelationLabels[rel.type] ?? rel.type;
        const sourceR = sizeMap.get(item.id) ?? 23;
        const targetR = sizeMap.get(rel.targetItemId) ?? 23;

        edges.push({
          id: `itemrel-${item.id}-${rel.targetItemId}-${rel.type}`,
          source: item.id,
          target: rel.targetItemId,
          label,
          type: 'bubble',
          animated: rel.type === 'opposite_of' || rel.type === 'transforms_into',
          style: {
            stroke: color,
            strokeWidth: 1.5,
            strokeOpacity: 0.4,
            strokeDasharray: rel.type === 'related_to' ? '4 2' : undefined,
          },
          labelStyle: { fill: color, fontSize: 9.5, fontWeight: 600, opacity: 0 },
          labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
          data: {
            kind: 'itemrel',
            sourceId: item.id,
            targetId: rel.targetItemId,
            relationType: rel.type,
            color,
            sourceR,
            targetR,
          },
        });
      });
    });

    // 同属（同一持有者的物品之间）
    const charItemsMap = new Map<string, string[]>();
    items.forEach((item) => {
      const holderIds = (item.currentHolders && item.currentHolders.length > 0)
        ? item.currentHolders
        : deriveCurrentHolders(item.holders ?? []);
      holderIds.forEach((charId) => {
        if (!validCharIds.has(charId)) return;
        if (!charItemsMap.has(charId)) charItemsMap.set(charId, []);
        charItemsMap.get(charId)!.push(item.id);
      });
    });

    const seenHolderPair = new Set<string>();
    charItemsMap.forEach((itemIds) => {
      const len = itemIds.length;
      for (let i = 0; i < len; i++) {
        for (let j = i + 1; j < len; j++) {
          const idA = itemIds[i]!;
          const idB = itemIds[j]!;
          const key = [idA, idB].sort().join('|');
          if (seenHolderPair.has(key)) continue;
          seenHolderPair.add(key);

          const itemA = items.find((it) => it.id === idA);
          const color = itemA ? (itemA.color || getItemColor(itemA.type)) : 'hsl(var(--muted-foreground))';
          const sourceR = sizeMap.get(idA) ?? 23;
          const targetR = sizeMap.get(idB) ?? 23;

          edges.push({
            id: `sameholder-${key}`,
            source: idA,
            target: idB,
            label: '同属',
            type: 'bubble',
            style: { stroke: color, strokeWidth: 1, strokeOpacity: 0.25 },
            labelStyle: { fill: color, fontSize: 8.5, fontWeight: 500, opacity: 0 },
            labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.7 },
            labelBgPadding: [3, 1] as [number, number],
            labelBgBorderRadius: 4,
            data: { kind: 'sameholder', sourceId: idA, targetId: idB, color, sourceR, targetR },
          });
        }
      }
    });

    return { nodes, edges };
  }, [items, characters, getCurrentHolderNames]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  // 数据变化合并位置
  useEffect(() => {
    setNodes((existing) => {
      const map = new Map(existing.map((n) => [n.id, n]));
      return graphData.nodes.map((newNode) => {
        const old = map.get(newNode.id);
        if (old) {
          return {
            ...newNode,
            position: old.position,
            data: { ...newNode.data, isSelected: old.data.isSelected, isHovered: old.data.isHovered },
          };
        }
        return newNode;
      });
    });
    setEdges(graphData.edges);
  }, [graphData.nodes, graphData.edges, setNodes, setEdges]);

  // 节点高亮
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => ({
        ...node,
        data: {
          ...node.data,
          isSelected: node.id === selectedNodeId,
          isHovered: node.id === hoveredNodeId,
        },
      }))
    );
  }, [selectedNodeId, hoveredNodeId, setNodes]);

  // 边高亮
  useEffect(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        const edgeData = edge.data as { sourceId?: string; targetId?: string; color?: string } | undefined;
        const sourceId = edgeData?.sourceId || edge.source;
        const targetId = edgeData?.targetId || edge.target;

        const isHovered = edge.id === hoveredEdgeId;
        const isSelected = !!selectedNodeId && (sourceId === selectedNodeId || targetId === selectedNodeId);
        const isDimmed = !!selectedNodeId && !isSelected;
        const isEdgeHovered = !!hoveredNodeId && (sourceId === hoveredNodeId || targetId === hoveredNodeId);

        const baseWidth = (edge.style?.strokeWidth as number) || 1.5;
        const strokeWidth = isHovered || isSelected || isEdgeHovered ? Math.max(2, baseWidth + 0.5) : baseWidth;
        const strokeOpacity = isDimmed ? 0.1 : isHovered || isSelected || isEdgeHovered ? 0.9 : (edge.style?.strokeOpacity as number) || 0.4;
        const showLabel = isHovered || isSelected || isEdgeHovered;

        return {
          ...edge,
          style: { ...edge.style, strokeWidth, strokeOpacity },
          labelStyle: { ...edge.labelStyle, opacity: showLabel ? 1 : 0 },
          labelBgStyle: { ...edge.labelBgStyle, opacity: showLabel ? 0.95 : 0 },
          zIndex: isHovered || isSelected || isEdgeHovered ? 10 : 1,
        };
      })
    );
  }, [selectedNodeId, hoveredNodeId, hoveredEdgeId, setEdges]);

  // 力导向
  const sizeMap = useMemo(() => {
    const map = new Map<string, number>();
    graphData.nodes.forEach((n) => {
      const size = (n.data.size as number) || 30;
      map.set(n.id, size / 2 + 20);
    });
    return map;
  }, [graphData.nodes]);

  useForceLayout({
    nodes: graphData.nodes,
    edges: graphData.edges,
    sizeMap,
    trigger: items.length + characters.length,
    onTick: useCallback((posMap: Map<string, { x: number; y: number }>) => {
      setNodes((nds) =>
        nds.map((node) => {
          const pos = posMap.get(node.id);
          if (!pos) return node;
          return { ...node, position: { x: pos.x, y: pos.y } };
        })
      );
    }, [setNodes]),
  });

  // 事件
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id === selectedNodeId ? null : node.id);
  }, [selectedNodeId]);

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    setHoveredNodeId(node.id);
  }, []);

  const onNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);

  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    const edgeData = edge.data as { kind?: string; sourceId?: string; targetId?: string; relationType?: string } | undefined;
    const kind = edgeData?.kind;
    const sourceId = edgeData?.sourceId || edge.source;
    const targetId = edgeData?.targetId || edge.target;
    const relType = edgeData?.relationType as ItemRelationType | undefined;

    // 仅物品↔物品关系支持删除
    if (kind !== 'itemrel') {
      return;
    }
    if (safeConfirm('确定删除这段物品关系吗？')) {
      removeItemRelation(sourceId, targetId, relType);
      // 双向清理（item.relations 是单向存储但显示是双向）
      removeItemRelation(targetId, sourceId, relType);
    }
  }, [removeItemRelation]);

  const onEdgeMouseEnter = useCallback((_: React.MouseEvent, edge: Edge) => {
    setHoveredEdgeId(edge.id);
  }, []);

  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), []);

  const onConnect = useCallback((params: Connection) => {
    if (!params.source || !params.target) return;
    // 仅允许 物品→物品 创建关系
    const isItemSource = itemMap.has(params.source);
    const isItemTarget = itemMap.has(params.target);
    if (!isItemSource || !isItemTarget) {
      alert('仅支持在两个物品之间创建关系；物品↔角色的持有关系请在「物品」面板中编辑 holders。');
      return;
    }
    if (params.source === params.target) return;
    setPendingConnection(params);
    setRelationDialogOpen(true);
  }, [itemMap]);

  const handleCreateRelation = (type: string) => {
    if (!pendingConnection) return;
    const { source, target } = pendingConnection;
    const relType = type as ItemRelationType;
    addItemRelation(source, { targetItemId: target, type: relType });
    // 对称关系双向写入，避免显示遗漏
    if (relType === 'paired_with' || relType === 'opposite_of' || relType === 'related_to') {
      addItemRelation(target, { targetItemId: source, type: relType });
    }
    setRelationDialogOpen(false);
    setPendingConnection(null);
  };

  const selectedItem = selectedNodeId ? itemMap.get(selectedNodeId) ?? undefined : undefined;
  const selectedChar = !selectedItem && selectedNodeId ? characterMap.get(selectedNodeId) : undefined;

  // 图例
  const legend = (
    <>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(var(--entity-character))' }} />
        <span className="text-[10px] text-muted-foreground">角色</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(var(--muted-foreground))' }} />
        <span className="text-[10px] text-muted-foreground">物品（按类型染色）</span>
      </div>
      {Object.entries(itemRelationColors).map(([type, color]) => (
        <div key={type} className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-[10px] text-muted-foreground">{itemRelationLabels[type as ItemRelationType]}</span>
        </div>
      ))}
    </>
  );

  // 关系类型选项
  const relationOptions: RelationTypeOption[] = (Object.keys(itemRelationColors) as ItemRelationType[]).map((type) => ({
    type,
    label: itemRelationLabels[type],
    color: itemRelationColors[type],
  }));

  // 侧栏
  const detail = selectedItem ? (
    <>
      <div className="flex items-center gap-2">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md"
          style={{ backgroundColor: selectedItem.color || getItemColor(selectedItem.type) }}
        >
          {selectedItem.name[0]}
        </div>
        <div>
          <h3 className="font-bold text-sm">{selectedItem.name}</h3>
          {selectedItem.type && <p className="text-xs text-muted-foreground">{selectedItem.type}</p>}
        </div>
      </div>

      {selectedItem.description && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1">描述</div>
          <div className="text-xs">{selectedItem.description}</div>
        </div>
      )}

      {(() => {
        const holderNames = getCurrentHolderNames(selectedItem);
        if (holderNames.length === 0) return null;
        return (
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">当前持有者</div>
            <div className="flex flex-wrap gap-1">
              {holderNames.map((name) => (
                <span key={name} className="text-xs bg-secondary px-2 py-0.5 rounded-full">{name}</span>
              ))}
            </div>
          </div>
        );
      })()}

      {Array.isArray(selectedItem.tags) && selectedItem.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {selectedItem.tags.map((tag) => (
            <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      )}
    </>
  ) : selectedChar ? (
    <>
      <div className="flex items-center gap-2">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md"
          style={{ backgroundColor: selectedChar.color || 'hsl(var(--entity-character))' }}
        >
          {selectedChar.name[0]}
        </div>
        <div>
          <h3 className="font-bold text-sm">{selectedChar.name}</h3>
          {selectedChar.aliases?.[0] && <p className="text-xs text-muted-foreground">{selectedChar.aliases[0]}</p>}
        </div>
      </div>

      {(() => {
        const heldItems = items.filter((item) => {
          const currentIds = (item.currentHolders && item.currentHolders.length > 0)
            ? item.currentHolders
            : deriveCurrentHolders(item.holders ?? []);
          return currentIds.includes(selectedChar.id);
        });
        if (heldItems.length === 0) return null;
        return (
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">持有物品</div>
            {heldItems.map((item) => (
              <div key={item.id} className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color || getItemColor(item.type) }} />
                <span className="font-medium">{item.name}</span>
              </div>
            ))}
          </div>
        );
      })()}
    </>
  ) : undefined;

  const getNodeColor = useCallback((node: Node) => {
    return (node.data as { color?: string }).color || 'hsl(var(--muted-foreground))';
  }, []);

  return (
    <>
      <GraphShell
        title="物品关系图谱"
        countText={`${items.length} 件物品 · ${edges.length} 条关系`}
        emptyHint="请先在「物品」面板中添加物品，或检查当前项目上下文是否正确。"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onEdgeClick={onEdgeClick}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onConnect={onConnect}
        connectionLineStyle={{ stroke: 'hsl(var(--border))', strokeWidth: 2 }}
        defaultEdgeOptions={{ type: 'bubble', style: { strokeWidth: 1.5 } }}
        getNodeColor={getNodeColor}
        legend={legend}
        detail={detail}
        exportFileNamePrefix="item-graph"
      />

      <RelationTypeDialog
        open={relationDialogOpen}
        options={relationOptions}
        onSelect={handleCreateRelation}
        onCancel={() => {
          setRelationDialogOpen(false);
          setPendingConnection(null);
        }}
      />
    </>
  );
}
