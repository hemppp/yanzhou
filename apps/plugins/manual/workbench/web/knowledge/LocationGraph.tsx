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
import { BubbleNode } from '@novel-plugins/ui-graph/BubbleNode';
import { useForceLayout } from '@novel-plugins/ui-graph/useForceLayout';
import { GraphShell } from '@novel-plugins/ui-graph/GraphShell';

// ============================================================
// 地点关系图谱（标准图谱）
//
// 节点：圆形纯色球（BubbleNode）
//   - 地点节点：颜色取自 location.color 或默认灰
//   - 角色节点：颜色取自 char.color 或默认蓝
// 边：straight，strokeOpacity 默认 0.4，hover/selected 时 0.9
// 关系来源：location.chapters 与 character.chapters 的交集推断（"位于"）
//
// 注意：Location schema 暂无 relations 字段，因此本图不支持
// 拖拽创建/点击删除关系。如需调整"位于"关系，请在「地点」或
// 「角色」面板中修改 chapters 数组。
// ============================================================

const LOCATION_NODE_SIZE = 48;
const CHARACTER_NODE_SIZE = 36;

const nodeTypes: NodeTypes = {
  bubble: BubbleNode,
};

export function LocationGraph() {
  const locations = useLocationStore((s) => s.locations);
  const characters = useCharacterStore((s) => s.characters);
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

  // 章节交集推断
  const locationCharacterMap = useMemo(() => {
    const map = new Map<string, string[]>();
    locations.forEach((location) => {
      const characterIds: string[] = [];
      characters.forEach((char) => {
        if (char.chapters && location.chapters) {
          const hasOverlap = char.chapters.some((ch) => location.chapters.includes(ch));
          if (hasOverlap) characterIds.push(char.id);
        }
      });
      map.set(location.id, characterIds);
    });
    return map;
  }, [locations, characters]);

  const graphData = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const sizeMap = new Map<string, number>();

    locations.forEach((location) => {
      const connectionCount = locationCharacterMap.get(location.id)?.length ?? 0;
      const size = connectionCount >= 5 ? 56 : connectionCount >= 3 ? 46 : LOCATION_NODE_SIZE;
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

    locations.forEach((location) => {
      const characterIds = locationCharacterMap.get(location.id) || [];
      const locationColor = location.color || 'hsl(var(--muted-foreground))';
      const sourceR = sizeMap.get(location.id) ?? 24;
      characterIds.forEach((charId) => {
        const targetR = sizeMap.get(charId) ?? 18;
        edges.push({
          id: `loc-${location.id}-${charId}`,
          source: location.id,
          target: charId,
          label: '位于',
          type: 'bubble',
          style: { stroke: locationColor, strokeWidth: 1.5, strokeOpacity: 0.4 },
          labelStyle: { fill: locationColor, fontSize: 9.5, fontWeight: 600, opacity: 0 },
          labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd: { type: MarkerType.ArrowClosed, color: locationColor, width: 10, height: 10 },
          data: { sourceId: location.id, targetId: charId, color: locationColor, sourceR, targetR },
        });
      });
    });

    return { nodes, edges };
  }, [locations, characters, locationCharacterMap]);

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
    trigger: locations.length + characters.length,
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
      <div className="flex items-center gap-1.5">
        <div className="w-6 h-0.5" style={{ backgroundColor: 'hsl(var(--muted-foreground))' }} />
        <span className="text-[10px] text-muted-foreground">"位于"关系（按章节共现推断）</span>
      </div>
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
        const charIds = locationCharacterMap.get(selectedLocation.id) || [];
        if (charIds.length === 0) return null;
        return (
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">出现的角色</div>
            {charIds.map((charId) => {
              const char = characterMap.get(charId);
              if (!char) return null;
              return (
                <div key={charId} className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: char.color || 'hsl(var(--entity-character))' }} />
                  <span className="font-medium">{char.name}</span>
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
        const locationIds = locations
          .filter((loc) => {
            const charIds = locationCharacterMap.get(loc.id) || [];
            return charIds.includes(selectedChar.id);
          })
          .map((loc) => loc.id);

        if (locationIds.length === 0) return null;

        return (
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">出现地点</div>
            {locationIds.map((locId) => {
              const location = locationMap.get(locId);
              if (!location) return null;
              return (
                <div key={locId} className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: location.color || 'hsl(var(--muted-foreground))' }} />
                  <span className="font-medium">{location.name}</span>
                </div>
              );
            })}
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
      countText={`${locations.length} 个地点 · ${edges.length} 条位于关系`}
      emptyHint="请先在「地点」面板中添加地点，或在「角色」面板中给角色标记出场章节。"
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
      defaultEdgeOptions={{ type: 'bubble', style: { strokeWidth: 1.5 } }}
      getNodeColor={getNodeColor}
      legend={legend}
      detail={detail}
      exportFileNamePrefix="location-graph"
    />
  );
}
