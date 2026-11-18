import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  MarkerType,
} from '@xyflow/react';
import { useLocationStore } from '@novel-plugins/data-core/stores';
import { useCharacterStore } from '@novel-plugins/data-core/stores';
import type { LocationRelation } from '@novel/shared';
import { BubbleNode } from '@novel-plugins/ui-graph/BubbleNode';
import { useForceLayout } from '@novel-plugins/ui-graph/useForceLayout';
import { GraphShell } from '@novel-plugins/ui-graph/GraphShell';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';

// ============================================================
// 地点关系图谱（标准图谱）
//
// 节点：圆形纯色球（BubbleNode）
//   - 地点节点：颜色取自 location.color 或默认灰
//   - 角色节点：只在「地点 ↔ 角色」有显式关系时入图
// 边：straight，strokeOpacity 默认 0.4，hover/selected 时 0.9
//
// ★ 2026-11 关系来源改造：不再用「角色与地点 chapters 有交集 ⇒ 位于」推断。
//   主角几乎每章都换地点，旧推断会把每个主角连到几十个地点上，图上全是边、
//   却读不出一句「谁在哪」。现在只画 location.relations 里的显式关系
//   （来自扫描断言的确定性校验，或手工在「地点」面板里添加），
//   没写关系的地点就是孤立点 —— 这是对的，缺的关系应当补数据，不是编边。
//
// 地点↔地点：位于（contained）/ 邻近 / 通往 / 关联
// 地点↔角色：位于（角色在某地）
// ============================================================

const LOCATION_NODE_SIZE = 48;
const CHARACTER_NODE_SIZE = 36;

/** 关系类型 → 图上标签（与 relationRecognition 的标准码一致） */
const LOCATION_RELATION_LABELS: Record<LocationRelation['type'], string> = {
  located_in: '位于',
  nearby: '邻近',
  routes_to: '通往',
  related_to: '关联',
};

/** 地点关系墨阶：类型之间靠明度区分，与全站水墨风格一致 */
const LOCATION_RELATION_COLORS: Record<LocationRelation['type'], string> = {
  located_in: 'hsl(0 0% 18%)',
  nearby: 'hsl(0 0% 34%)',
  routes_to: 'hsl(0 0% 46%)',
  related_to: 'hsl(0 0% 58%)',
};

const nodeTypes: NodeTypes = {
  bubble: BubbleNode,
};

export function LocationGraph() {
  // ★ 按项目过滤：不过滤会把别的书的地点/角色画进来
  // ★ useMemo 缓存过滤结果（裸 .filter 每次渲染都是新数组，下游 useMemo 会无限重算）
  const projectId = useCurrentProjectId();
  const allLocations = useLocationStore((s) => s.locations);
  const allCharacters = useCharacterStore((s) => s.characters);
  const locations = useMemo(
    () => allLocations.filter((l) => !projectId || l.projectId === projectId),
    [allLocations, projectId],
  );
  const characters = useMemo(
    () => allCharacters.filter((c) => !projectId || c.projectId === projectId),
    [allCharacters, projectId],
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  const characterMap = useMemo(() => {
    const map = new Map<string, typeof characters[number]>();
    for (const c of characters) map.set(c.id, c);
    return map;
  }, [characters]);

  const locationMap = useMemo(() => {
    const map = new Map<string, typeof locations[number]>();
    for (const l of locations) map.set(l.id, l);
    return map;
  }, [locations]);

  /**
   * 显式关系索引：地点 id → 该地点写下的关系（地点↔地点 / 地点↔角色）。
   * 只认 location.relations —— 共现推断已经移除（见文件头注）。
   */
  const locationRelationMap = useMemo(() => {
    const map = new Map<string, LocationRelation[]>();
    for (const location of locations) {
      const relations = location.relations ?? [];
      if (relations.length > 0) map.set(location.id, relations);
    }
    return map;
  }, [locations]);

  const graphData = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const sizeMap = new Map<string, number>();
    const validLocationIds = new Set(locations.map((l) => l.id));
    const validCharIds = new Set(characters.map((c) => c.id));

    // 只把「有关系」的角色拉进图：没有角色关系的地点不该把全站角色都摊上来
    const relatedCharacterIds = new Set<string>();
    for (const location of locations) {
      for (const relation of location.relations ?? []) {
        if (relation.targetKind === 'character' && validCharIds.has(relation.targetId)) {
          relatedCharacterIds.add(relation.targetId);
        }
      }
    }

    locations.forEach((location) => {
      const relationCount = (location.relations ?? []).length;
      const size = relationCount >= 5 ? 56 : relationCount >= 3 ? 46 : LOCATION_NODE_SIZE;
      sizeMap.set(location.id, size / 2);
      nodes.push({
        id: location.id,
        type: 'bubble',
        position: { x: Math.random() * 600 + 100, y: Math.random() * 500 + 50 },
        data: {
          label: location.name,
          color: location.color || 'hsl(var(--muted-foreground))',
          size,
          subtitle: '地点',
          isSelected: false,
          isHovered: false,
        },
      });
    });

    characters
      .filter((char) => relatedCharacterIds.has(char.id))
      .forEach((char) => {
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

    // 边：只画显式关系；地点↔地点按无序对去重（双向存储会写两条）
    const seenEdge = new Set<string>();
    locations.forEach((location) => {
      const sourceR = sizeMap.get(location.id) ?? 24;
      for (const relation of location.relations ?? []) {
        const isLocationTarget = relation.targetKind === 'location';
        if (isLocationTarget && !validLocationIds.has(relation.targetId)) continue;
        if (!isLocationTarget && !validCharIds.has(relation.targetId)) continue;

        const pairKey = [location.id, relation.targetKind, relation.targetId].sort().join('|') + '|' + relation.type;
        if (seenEdge.has(pairKey)) continue;
        seenEdge.add(pairKey);

        const color = LOCATION_RELATION_COLORS[relation.type] ?? LOCATION_RELATION_COLORS.related_to;
        const label = LOCATION_RELATION_LABELS[relation.type] ?? '关联';
        const targetR = sizeMap.get(relation.targetId) ?? 18;

        edges.push({
          id: `loc-${location.id}-${relation.targetId}-${relation.type}`,
          source: location.id,
          target: relation.targetId,
          label,
          type: 'bubble',
          style: { stroke: color, strokeWidth: 0.9, strokeOpacity: 0.4 },
          labelStyle: { fill: color, fontSize: 9.5, fontWeight: 600, opacity: 0 },
          labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          // 「邻近」是对称的，不画箭头；位于/通往/关联是有向的
          markerEnd: relation.type === 'nearby'
            ? undefined
            : { type: MarkerType.ArrowClosed, color, width: 10, height: 10 },
          data: {
            sourceId: location.id,
            targetId: relation.targetId,
            relationType: relation.type,
            color,
            sourceR,
            targetR,
          },
        });
      }
    });

    return { nodes, edges };
  }, [locations, characters, locationRelationMap]);

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

        const baseWidth = (edge.style?.strokeWidth as number) || 0.9;
        const strokeWidth = isHovered || isSelected || isEdgeHovered ? Math.max(1.2, baseWidth + 0.3) : baseWidth;
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

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id === selectedNodeId ? null : node.id);
  }, [selectedNodeId]);

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    setHoveredNodeId(node.id);
  }, []);

  const onNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);

  const onEdgeMouseEnter = useCallback((_: React.MouseEvent, edge: Edge) => {
    setHoveredEdgeId(edge.id);
  }, []);

  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), []);

  /**
   * 点击边删除关系。
   *
   * 之前只能去「地点」面板详情里逐条删，图上看到一条错边却删不掉。
   * 删除时对称类型（邻近/关联）两侧一起删，避免图上删了、另一侧还留着。
   */
  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    const data = edge.data as
      | { sourceId?: string; targetId?: string; relationType?: LocationRelation['type'] }
      | undefined;
    const sourceId = data?.sourceId ?? edge.source;
    const targetId = data?.targetId ?? edge.target;
    const type = data?.relationType;
    if (!sourceId || !targetId || !type) return;
    if (!safeConfirm('删除这条地点关系吗？')) return;

    const state = useLocationStore.getState();
    const source = state.locations.find((l) => l.id === sourceId);
    if (source) {
      state.updateLocation(sourceId, {
        relations: (source.relations ?? []).filter(
          (r) => !(r.targetId === targetId && r.type === type),
        ),
        updatedAt: Date.now(),
      });
    }
    // 对称关系：反向也删（图上按无序对去重，只删一侧会让边“复活”）
    if (type === 'nearby' || type === 'related_to') {
      const target = state.locations.find((l) => l.id === targetId);
      if (target) {
        state.updateLocation(targetId, {
          relations: (target.relations ?? []).filter(
            (r) => !(r.targetId === sourceId && r.type === type),
          ),
          updatedAt: Date.now(),
        });
      }
    }
  }, []);

  const selectedLocation = selectedNodeId ? locationMap.get(selectedNodeId) : undefined;
  const selectedChar = !selectedLocation && selectedNodeId ? characterMap.get(selectedNodeId) : undefined;

  // 图例
  const legend = (
    <>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(var(--muted-foreground))' }} />
        <span className="text-[10px] text-muted-foreground">地点（按 color 字段染色）</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: 'hsl(var(--entity-character))' }} />
        <span className="text-[10px] text-muted-foreground">角色</span>
      </div>
      {(Object.keys(LOCATION_RELATION_LABELS) as LocationRelation['type'][]).map((type) => (
        <div key={type} className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: LOCATION_RELATION_COLORS[type] }} />
          <span className="text-[10px] text-muted-foreground">{LOCATION_RELATION_LABELS[type]}</span>
        </div>
      ))}
    </>
  );

  // 侧栏
  const detail = selectedLocation ? (
    <>
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md"
          style={{ backgroundColor: selectedLocation.color || 'hsl(var(--muted-foreground))' }}
        >
          {selectedLocation.name[0]}
        </div>
        <div>
          <h3 className="font-bold">{selectedLocation.name}</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-secondary">地点</span>
        </div>
      </div>

      {selectedLocation.description && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground">描述</div>
          <div className="text-sm">{selectedLocation.description}</div>
        </div>
      )}

      {selectedLocation.chapters && selectedLocation.chapters.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground">出现章节</div>
          <div className="text-sm">
            第 {selectedLocation.chapters.slice(0, 5).join(', ')}
            {selectedLocation.chapters.length > 5 && ` ...等${selectedLocation.chapters.length}章`}
          </div>
        </div>
      )}

      {(() => {
        const relations = locationRelationMap.get(selectedLocation.id) ?? [];
        if (relations.length === 0) return null;
        return (
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">关系</div>
            {relations.map((relation, idx) => {
              const target = relation.targetKind === 'location'
                ? locationMap.get(relation.targetId)
                : characterMap.get(relation.targetId);
              if (!target) return null;
              return (
                <div
                  key={`${relation.targetKind}-${relation.targetId}-${relation.type}-${idx}`}
                  className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0"
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: LOCATION_RELATION_COLORS[relation.type] }}
                  />
                  <span className="text-muted-foreground">
                    {LOCATION_RELATION_LABELS[relation.type]}
                  </span>
                  <span className="font-medium">{target.name}</span>
                  {relation.chapter !== undefined && relation.chapter !== null && (
                    <span className="text-[10px] text-muted-foreground">第 {relation.chapter} 章</span>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}

      {Array.isArray(selectedLocation.tags) && selectedLocation.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {selectedLocation.tags.map((tag) => (
            <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      )}
    </>
  ) : selectedChar ? (
    <>
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md"
          style={{ backgroundColor: selectedChar.color || 'hsl(var(--entity-character))' }}
        >
          {selectedChar.name[0]}
        </div>
        <div>
          <h3 className="font-bold">{selectedChar.name}</h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-secondary">角色</span>
        </div>
      </div>
      {selectedChar.aliases && selectedChar.aliases.length > 0 && (
        <p className="text-xs text-muted-foreground">别名：{selectedChar.aliases.join(', ')}</p>
      )}

      {(() => {
        const entries = locations
          .map((location) => ({
            location,
            relation: (location.relations ?? []).find(
              (r) => r.targetKind === 'character' && r.targetId === selectedChar.id,
            ),
          }))
          .filter((entry): entry is { location: (typeof locations)[number]; relation: LocationRelation } =>
            Boolean(entry.relation),
          );

        if (entries.length === 0) return null;

        return (
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">所在地点</div>
            {entries.map(({ location, relation }) => (
              <div key={location.id} className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: LOCATION_RELATION_COLORS[relation.type] }}
                />
                <span className="text-muted-foreground">
                  {LOCATION_RELATION_LABELS[relation.type]}
                </span>
                <span className="font-medium">{location.name}</span>
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
    <GraphShell
      title="地点关系图谱"
      countText={`${locations.length} 个地点 · ${edges.length} 条关系`}
      emptyHint="请先在「地点」面板中添加地点；地点之间的关系（位于/邻近/通往）由正文扫描识别，也可在地点详情里手动添加。"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onEdgeMouseEnter={onEdgeMouseEnter}
      onEdgeMouseLeave={onEdgeMouseLeave}
      onEdgeClick={onEdgeClick}
      defaultEdgeOptions={{ type: 'bubble', style: { strokeWidth: 0.9 } }}
      getNodeColor={getNodeColor}
      legend={legend}
      detail={detail}
      exportFileNamePrefix="location-graph"
    />
  );
}
