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
import { useCharacterStore, useItemStore } from '@novel-plugins/data-core/stores';
import { safeConfirm } from '@novel-plugins/ui-kit/safeConfirm';
import { ItemGraph } from './ItemGraph';
import { LocationGraph } from './LocationGraph';
import { BubbleNode } from '@novel-plugins/ui-graph/BubbleNode';
import { useForceLayout } from '@novel-plugins/ui-graph/useForceLayout';
import { GraphShell, RelationTypeDialog, type RelationTypeOption } from '@novel-plugins/ui-graph/GraphShell';

// ============================================================
// 角色关系图谱（标准图谱）
//
// 节点：圆形纯色球（BubbleNode），颜色按角色分类
// 边：straight，strokeOpacity 默认 0.35，hover/selected 时 0.9
// 关系 CRUD：拖拽连线弹窗选关系类型，点击边弹确认删除
// 互通关系（friend/family/ally/mutual）双向写入
// ============================================================

// 水墨化（2026-09-15）：原有「按类型配色」改为「按墨阶配色」——
// 区分手段由色相转为明度深浅（饱和度恒 0），与整体水墨风格一致。
const relationColors: Record<string, string> = {
  friend: 'hsl(0 0% 30%)',
  enemy: 'hsl(0 0% 12%)',
  lover: 'hsl(0 0% 24%)',
  family: 'hsl(0 0% 36%)',
  ally: 'hsl(0 0% 42%)',
  rival: 'hsl(0 0% 18%)',
  mentor: 'hsl(0 0% 50%)',
  mutual: 'hsl(0 0% 58%)',
};

const relationLabels: Record<string, string> = {
  friend: '朋友',
  enemy: '敌人',
  lover: '恋人',
  family: '家人',
  ally: '盟友',
  rival: '对手',
  mentor: '师徒',
  mutual: '互通',
};

// 角色分类颜色（用于节点填色）—— 水墨化：改用墨阶
const roleColors: Record<string, string> = {
  protagonist: 'hsl(0 0% 12%)',
  femaleLead: 'hsl(0 0% 20%)',
  supporting: 'hsl(0 0% 34%)',
  minor: 'hsl(0 0% 52%)',
  antagonist: 'hsl(0 0% 8%)',
  narrator: 'hsl(0 0% 62%)',
  other: 'hsl(0 0% 62%)',
};

const roleLabels: Record<string, string> = {
  protagonist: '主角',
  femaleLead: '女主',
  supporting: '配角',
  minor: '路人',
  antagonist: '反派',
  narrator: '旁白',
  other: '其他',
};

function getRoleColor(role?: string): string {
  return roleColors[role || 'other'] || 'hsl(0 0% 50%)';
}

function getCharSize(relationCount: number, role?: string): number {
  if (role === 'protagonist' || role === 'femaleLead') return 60;
  if (role === 'antagonist') return 50;
  if (relationCount >= 8) return 50;
  if (relationCount >= 5) return 42;
  if (relationCount >= 3) return 36;
  if (relationCount >= 1) return 30;
  return 26;
}

const nodeTypes: NodeTypes = {
  bubble: BubbleNode,
};

// 物品节点：类型标签与配色（与 ItemManager 保持一致）
const itemLabels: Record<string, string> = {
  weapon: '武器', armor: '防具', clothing: '衣物', treasure: '宝物', token: '信物',
  artifact: '法器', medicine: '药物', potion: '丹药', book: '书籍', scroll: '卷轴',
  document: '文书', key: '钥匙', gem: '宝石', vehicle: '载具', tool: '工具',
  food: '食物', plant: '植物', animal: '动物', prop: '道具', other: '物品',
};
const itemColors: Record<string, string> = {
  weapon: 'hsl(0 0% 12%)', armor: 'hsl(0 0% 26%)', clothing: 'hsl(0 0% 40%)', treasure: 'hsl(0 0% 20%)', token: 'hsl(0 0% 34%)',
  artifact: 'hsl(0 0% 14%)', medicine: 'hsl(0 0% 44%)', potion: 'hsl(0 0% 48%)', book: 'hsl(0 0% 30%)', scroll: 'hsl(0 0% 38%)',
  document: 'hsl(0 0% 52%)', key: 'hsl(0 0% 22%)', gem: 'hsl(0 0% 16%)', vehicle: 'hsl(0 0% 42%)', tool: 'hsl(0 0% 36%)',
  food: 'hsl(0 0% 58%)', plant: 'hsl(0 0% 46%)', animal: 'hsl(0 0% 28%)', prop: 'hsl(0 0% 60%)', other: 'hsl(0 0% 50%)',
};
const HOLD_EDGE_COLOR = 'hsl(0 0% 46%)';

export function CharacterGraph() {
  const characters = useCharacterStore((s) => s.characters);
  const items = useItemStore((s) => s.items);
  const addRelation = useCharacterStore((s) => s.addRelation);
  const removeRelation = useCharacterStore((s) => s.removeRelation);
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

  // 生成节点 & 边
  const graphData = useMemo(() => {
    const validCharIds = new Set(characters.map((c) => c.id));
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const sizeMap = new Map<string, number>();

    characters.forEach((char) => {
      const relationCount = char.relations?.length ?? 0;
      const size = getCharSize(relationCount, char.role);
      sizeMap.set(char.id, size / 2);
      nodes.push({
        id: char.id,
        type: 'bubble',
        position: { x: Math.random() * 600 + 100, y: Math.random() * 500 + 50 },
        data: {
          label: char.name,
          color: getRoleColor(char.role),
          size,
          subtitle: char.role ? roleLabels[char.role] || char.role : undefined,
          isSelected: false,
          isHovered: false,
        },
      });
    });

    const seenRel = new Set<string>();
    characters.forEach((char) => {
      if (!char.relations || char.relations.length === 0) return;
      char.relations.forEach((rel) => {
        if (!validCharIds.has(rel.targetId)) return;
        if (rel.targetId === char.id) return;

        const key = [char.id, rel.targetId].sort().join('|') + '|' + rel.type;
        if (seenRel.has(key)) return;
        seenRel.add(key);

        const label = relationLabels[rel.type] || rel.type;
        const isMutual = rel.type === 'friend' || rel.type === 'family' || rel.type === 'ally' || rel.type === 'mutual';
        const directed = !isMutual;
        const lineColor = relationColors[rel.type] || 'hsl(var(--muted-foreground))';

        const sourceR = sizeMap.get(char.id) ?? 15;
        const targetR = sizeMap.get(rel.targetId) ?? 15;

        edges.push({
          id: `rel-${char.id}-${rel.targetId}-${rel.type}`,
          source: char.id,
          target: rel.targetId,
          label,
          type: 'bubble',
          animated: false,
          style: {
            stroke: lineColor,
            strokeWidth: 1,
            strokeOpacity: 0.35,
          },
          labelStyle: {
            fill: lineColor,
            fontSize: 9.5,
            fontWeight: 500,
            opacity: 0,
          },
          labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd: directed
            ? { type: MarkerType.ArrowClosed, color: lineColor, width: 10, height: 10 }
            : undefined,
          data: {
            sourceId: char.id,
            targetId: rel.targetId,
            relationType: rel.type,
            isMutual,
            color: lineColor,
            sourceR,
            targetR,
          },
        });
      });
    });

    // ★ 人物-物品持有关系：当前持有者非空的物品作为节点入图，与持有者连「持有」边
    const heldItems = items.filter((item) => (item.currentHolders ?? []).length > 0);
    heldItems.forEach((item) => {
      const nodeColor = itemColors[item.type?.toLowerCase() || 'other'] || 'hsl(var(--muted-foreground))';
      nodes.push({
        id: `item-${item.id}`,
        type: 'bubble',
        position: { x: Math.random() * 600 + 100, y: Math.random() * 500 + 50 },
        data: {
          label: item.name,
          color: nodeColor,
          size: 22,
          subtitle: itemLabels[item.type?.toLowerCase() || 'other'] || '物品',
          isSelected: false,
          isHovered: false,
        },
      });
      item.currentHolders.forEach((cid) => {
        if (!validCharIds.has(cid)) return;
        edges.push({
          id: `hold-${item.id}-${cid}`,
          source: cid,
          target: `item-${item.id}`,
          label: '持有',
          type: 'bubble',
          animated: false,
          style: {
            stroke: HOLD_EDGE_COLOR,
            strokeWidth: 1,
            strokeDasharray: '5 3',
            strokeOpacity: 0.45,
          },
          labelStyle: {
            fill: HOLD_EDGE_COLOR,
            fontSize: 9.5,
            fontWeight: 500,
            opacity: 0,
          },
          labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd: undefined,
          data: {
            sourceId: cid,
            targetId: `item-${item.id}`,
            relationType: 'hold',
            isMutual: true,
            color: HOLD_EDGE_COLOR,
            sourceR: sizeMap.get(cid) ?? 15,
            targetR: 11,
          },
        });
      });
    });

    return { nodes, edges };
  }, [characters, items]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  // 数据变化时合并位置
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

  // 选中/悬停高亮：节点
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

  // 选中/悬停高亮：边
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

        const strokeWidth = isHovered || isSelected || isEdgeHovered ? 2 : 1;
        const strokeOpacity = isDimmed ? 0.1 : isHovered || isSelected || isEdgeHovered ? 0.9 : 0.35;
        const showLabel = isHovered || isSelected || isEdgeHovered;

        return {
          ...edge,
          style: { ...edge.style, strokeWidth, strokeOpacity },
          labelStyle: { ...edge.labelStyle, opacity: showLabel ? 1 : 0, fontSize: 9.5 },
          labelBgStyle: { ...edge.labelBgStyle, opacity: showLabel ? 0.95 : 0 },
          zIndex: isHovered || isSelected || isEdgeHovered ? 10 : 1,
        };
      })
    );
  }, [selectedNodeId, hoveredNodeId, hoveredEdgeId, setEdges]);

  // 力导向布局
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
    trigger: characters.length,
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

  // 事件回调
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id === selectedNodeId ? null : node.id);
  }, [selectedNodeId]);

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    setHoveredNodeId(node.id);
  }, []);

  const onNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);

  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    const edgeData = edge.data as { sourceId?: string; targetId?: string; relationType?: string } | undefined;
    const sourceId = edgeData?.sourceId || edge.source;
    const targetId = edgeData?.targetId || edge.target;
    const relType = edgeData?.relationType;

    // 持有边（人物-物品）来自扫描识别，不在这里删除
    if (relType === 'hold' || sourceId.startsWith('item-') || targetId.startsWith('item-')) return;

    if (safeConfirm('确定删除这段关系吗？')) {
      removeRelation(sourceId, targetId);
      // 互通关系双向删除
      if (relType && (relType === 'friend' || relType === 'family' || relType === 'mutual' || relType === 'ally')) {
        removeRelation(targetId, sourceId);
      }
    }
  }, [removeRelation]);

  const onEdgeMouseEnter = useCallback((_: React.MouseEvent, edge: Edge) => {
    setHoveredEdgeId(edge.id);
  }, []);

  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), []);

  const onConnect = useCallback((params: Connection) => {
    // 物品节点不接受手动连线（人物-物品关系来自扫描的持有数据）
    if (params.source?.startsWith('item-') || params.target?.startsWith('item-')) return;
    if (params.source && params.target) {
      setPendingConnection(params);
      setRelationDialogOpen(true);
    }
  }, []);

  const handleCreateRelation = (type: string) => {
    if (!pendingConnection) return;
    const { source, target } = pendingConnection;
    addRelation(source, { targetId: target, type, direction: 'to', chapter: 1 });
    if (type === 'mutual' || type === 'friend' || type === 'family' || type === 'ally') {
      addRelation(target, { targetId: source, type, direction: 'to', chapter: 1 });
    }
    setRelationDialogOpen(false);
    setPendingConnection(null);
  };

  const selectedChar = selectedNodeId ? characterMap.get(selectedNodeId) : undefined;
  const selectedItem = selectedNodeId?.startsWith('item-')
    ? items.find((it) => `item-${it.id}` === selectedNodeId)
    : undefined;

  // 图例
  const legend = (
    <>
      {Object.entries(roleColors).filter(([key]) => ['protagonist', 'femaleLead', 'supporting', 'minor', 'antagonist'].includes(key)).map(([key, color]) => (
        <div key={key} className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-[10px] text-muted-foreground">{roleLabels[key]}</span>
        </div>
      ))}
    </>
  );

  // 关系类型选项
  const relationOptions: RelationTypeOption[] = Object.entries(relationColors).map(([type, color]) => ({
    type,
    label: relationLabels[type] || type,
    color,
  }));

  // 侧栏详情（角色 / 物品）
  const detail = selectedChar ? (
    <>
      <div>
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-md"
            style={{ backgroundColor: getRoleColor(selectedChar.role) }}
          >
            {selectedChar.name[0]}
          </div>
          <div>
            <h3 className="font-bold">{selectedChar.name}</h3>
            {selectedChar.role && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-secondary">
                {roleLabels[selectedChar.role] || selectedChar.role}
              </span>
            )}
          </div>
        </div>
        {selectedChar.aliases && selectedChar.aliases.length > 0 && (
          <p className="text-xs text-muted-foreground">别名：{selectedChar.aliases.join(', ')}</p>
        )}
      </div>

      {selectedChar.desire && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground">欲望</div>
          <div className="text-sm">{selectedChar.desire}</div>
        </div>
      )}
      {selectedChar.fear && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground">恐惧</div>
          <div className="text-sm">{selectedChar.fear}</div>
        </div>
      )}
      {selectedChar.personality && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground">性格</div>
          <div className="text-sm">{selectedChar.personality}</div>
        </div>
      )}
      {selectedChar.backstory && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground">背景</div>
          <div className="text-sm">{selectedChar.backstory}</div>
        </div>
      )}

      {selectedChar.relations && selectedChar.relations.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1">关系</div>
          {selectedChar.relations.map((rel, i) => {
            const target = characterMap.get(rel.targetId);
            if (!target) return null;
            return (
              <div key={`${rel.targetId}-${rel.type}-${i}`} className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: relationColors[rel.type] || 'hsl(var(--muted-foreground))' }} />
                <span className="font-medium">{target.name}</span>
                <span className="text-muted-foreground">— {relationLabels[rel.type] || rel.type}</span>
              </div>
            );
          })}
        </div>
      )}

      {Array.isArray(selectedChar.tags) && selectedChar.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {selectedChar.tags.map((tag) => (
            <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded-xl">{tag}</span>
          ))}
        </div>
      )}
    </>
  ) : selectedItem ? (
    <>
      <div>
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm shadow-md"
            style={{ backgroundColor: itemColors[selectedItem.type?.toLowerCase() || 'other'] || 'hsl(var(--muted-foreground))' }}
          >
            {selectedItem.name[0]}
          </div>
          <div>
            <h3 className="font-bold">{selectedItem.name}</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-secondary">
              {itemLabels[selectedItem.type?.toLowerCase() || 'other'] || '物品'}
            </span>
          </div>
        </div>
        {selectedItem.description && (
          <p className="text-xs text-muted-foreground">{selectedItem.description}</p>
        )}
      </div>

      {(selectedItem.currentHolders ?? []).length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1">当前持有者</div>
          {selectedItem.currentHolders.map((cid) => {
            const c = characterMap.get(cid);
            if (!c) return null;
            return (
              <div key={cid} className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: getRoleColor(c.role) }} />
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground">— 持有</span>
              </div>
            );
          })}
        </div>
      )}

      {(selectedItem.holders ?? []).length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1">流转历史</div>
          {selectedItem.holders.map((h, i) => {
            const c = characterMap.get(h.characterId);
            const label = h.action === 'gained' ? '获得' : h.action === 'lost' ? '失去' : h.action === 'transferred' ? '转移' : '持有';
            return (
              <div key={`${h.characterId}-${h.chapter}-${i}`} className="flex items-center gap-1.5 text-xs py-1 border-b last:border-0">
                <span className="text-muted-foreground w-10 shrink-0">第{h.chapter}章</span>
                {c && <span className="font-medium">{c.name}</span>}
                <span className="text-muted-foreground">— {label}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  ) : undefined;

  const getNodeColor = useCallback((node: Node) => {
    return (node.data as { color?: string }).color || 'hsl(var(--muted-foreground))';
  }, []);

  return (
    <>
      <GraphShell
        title="角色关系图谱"
        countText={`${characters.length} 个角色 · ${items.filter((i) => (i.currentHolders ?? []).length > 0).length} 件持有物品 · ${edges.length} 条关系`}
        emptyHint="请先在「角色」面板中添加角色，或检查当前项目上下文是否正确。"
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
        exportFileNamePrefix="character-graph"
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

// ============================================================
// 关系图谱主组件（Tab 切换）
// ============================================================
export function RelationGraph() {
  const [activeTab, setActiveTab] = useState<'character' | 'item' | 'location'>('character');

  return (
    <div className="h-full flex flex-col">
      <div className="flex border-b items-center justify-between" role="tablist" aria-label="关系图谱类型">
        <div className="flex">
          <button
            className={`px-4 py-2 text-sm transition-colors rounded-t-xl ${
              activeTab === 'character' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
            onClick={() => setActiveTab('character')}
            role="tab"
            aria-selected={activeTab === 'character'}
            tabIndex={activeTab === 'character' ? 0 : -1}
            onKeyDown={(e) => { if (e.key === 'Enter') setActiveTab('character'); }}
          >
            角色关系
          </button>
          <button
            className={`px-4 py-2 text-sm transition-colors rounded-t-xl ${
              activeTab === 'item' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
            onClick={() => setActiveTab('item')}
            role="tab"
            aria-selected={activeTab === 'item'}
            tabIndex={activeTab === 'item' ? 0 : -1}
            onKeyDown={(e) => { if (e.key === 'Enter') setActiveTab('item'); }}
          >
            物品关系
          </button>
          <button
            className={`px-4 py-2 text-sm transition-colors rounded-t-xl ${
              activeTab === 'location' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
            onClick={() => setActiveTab('location')}
            role="tab"
            aria-selected={activeTab === 'location'}
            tabIndex={activeTab === 'location' ? 0 : -1}
            onKeyDown={(e) => { if (e.key === 'Enter') setActiveTab('location'); }}
          >
            地点关系
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden" role="tabpanel" key={activeTab}>
        {activeTab === 'character' && <CharacterGraph key="character" />}
        {activeTab === 'item' && <ItemGraph key="item" />}
        {activeTab === 'location' && <LocationGraph key="location" />}
      </div>
    </div>
  );
}
