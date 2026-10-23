// ============================================================
// MemoryGraphPanel —— 记忆审计的**图谱版**
//
// 分层记忆架构里需要"看得见"的三件事（设计见 docs/architecture/multi-agent-memory-architecture.md）：
//   ① 谁在什么用途下读了全局记忆 / 被拒了什么 —— **隔离只有看得见才可信**
//   ② 同批次同槽位的事实冲突（两条都没写，等人裁）
//   ③ 各角色私记条数 + 它自己的水车（证明 L2 真按 agentId 分开落）
//
// 原 MemoryAuditPanel 是三段文字。作者要求全面图谱化，于是改成**一张关系图**：
//
//   L1 全局记忆（中心）
//     ├── 智能体 × N：矩形节点，边＝「读 N · 拒 M」
//     │     被拒 > 0 的边画成警示虚线 —— 这是全图最该被一眼看见的东西
//     └── 事实冲突 × N：警示节点，点开在侧栏做三条裁决（保留原功能）
//
// 为什么用图谱：记忆架构的核心是**归属与隔离**（谁记得什么、谁读了什么），
// 这个关系在文字列表里恰恰是最难读出来的。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  type Node, type Edge, type NodeTypes, useNodesState, useEdgesState, MarkerType,
} from '@xyflow/react';
import {
  fetchMemoryView, resolveConflict, ACTION_LABEL, REASON_LABEL,
  type MemoryView,
} from './services/memorySession';
import { GraphShell } from '@novel-plugins/ui-graph/GraphShell';
import { EntityNode, kindInk, type EntityNodeData } from '@novel-plugins/ui-graph/EntityNode';

const ROLE_LABEL: Record<string, string> = {
  'plot-designer': '剧情设计师',
  'character-designer': '角色设计师',
  'continuity-keeper': '设定管家',
  convener: '定稿官',
  writer: '写作官',
  reviewer: '意图复核',
  proofreader: '校对门',
  orchestrator: '编排层',
};

const ALERT_INK = 'hsl(var(--destructive))';
const MUTED_INK = 'hsl(var(--muted-foreground))';

function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const nodeTypes: NodeTypes = { entity: EntityNode };

/** 布局常量 */
const Y_L1 = 0;
const Y_AGENT = 170;
const NODE_W_AGENT = 168;
const GAP_AGENT = 196;
const NODE_W_CONFLICT = 210;
const GAP_CONFLICT = 236;
const L1_WIDTH = 260;
/**
 * 智能体一行最多放几个。
 *
 * ★ 为什么要折行：真实项目里"读过记忆"的智能体有 7–8 个（三个设计角色 + 定稿官 +
 *   写作官 + 意图复核 + 校对门 + 编排层）。一行 8 个 × 196 = 1548px，而画布只有
 *   ~1030px —— GraphShell 的 fitView 会把整图缩到 0.6，节点里 12px 的字变成 7px，
 *   整张图直接读不了（2026-09-15 真机截图确认：补上"只在审计里出现"的智能体后
 *   图一下子糊了）。折成两行后宽度降到 ~756，zoom 回到 1.0 以上。
 */
const AGENT_PER_ROW = 4;
/** 智能体网格的行距（节点高约 50 + 留白） */
const AGENT_ROW_STEP = 104;

export function MemoryGraphPanel({ projectId }: { projectId?: string | null }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 裁决后的后端提示（尤其"需要重跑该章沉淀才会真正改库"这句要说给作者看） */
  const [hint, setHint] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      setView(await fetchMemoryView());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  /** 每个智能体的审计统计：装配 / 读全局 / 被拒 / 写私记 各多少次 */
  const auditByAgent = useMemo(() => {
    const map = new Map<string, { read: number; denied: number; wrote: number }>();
    for (const a of view?.audit ?? []) {
      const cur = map.get(a.agentId) ?? { read: 0, denied: 0, wrote: 0 };
      if (a.action === 'read_l1') cur.read += 1;
      if (!a.allow || a.action === 'deny_l1') cur.denied += 1;
      if (a.action === 'write_l2') cur.wrote += 1;
      map.set(a.agentId, cur);
    }
    return map;
  }, [view]);

  const graphData = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    if (!view) return { nodes, edges, agentCount: 0, deniedTotal: 0 };

    /**
     * 智能体集合 = 「有 L2 私记的」 ∪ 「出现在审计流水里的」。
     *
     * ★ 为什么必须取并集：`view.agents` 是按 `agent_memory` 聚合出来的，于是
     *   "读了全局记忆但还没写过私记"的智能体（剧情设计师 / 角色设计师就是这样）
     *   在图上**根本不存在** —— 而"谁读过全局记忆"正是这张图要回答的首要问题
     *   （2026-09-15 真机截图确认了这个缺口）。
     */
    const agentIds: string[] = [];
    const seenAgent = new Set<string>();
    for (const a of view.agents) {
      if (!seenAgent.has(a.agentId)) { seenAgent.add(a.agentId); agentIds.push(a.agentId); }
    }
    for (const row of view.audit) {
      if (!seenAgent.has(row.agentId)) { seenAgent.add(row.agentId); agentIds.push(row.agentId); }
    }
    const statOf = (id: string) => view.agents.find((x) => x.agentId === id);
    const agents = agentIds;
    const conflicts = view.conflicts;

    // 智能体折行（见 AGENT_PER_ROW 的说明）；每行宽度取实际的最宽一行
    const agentRows = Math.max(1, Math.ceil(agents.length / AGENT_PER_ROW));
    const perRow = Math.min(AGENT_PER_ROW, Math.max(1, agents.length));
    const agentSpan = (perRow - 1) * GAP_AGENT + NODE_W_AGENT;
    const conflictSpan = conflicts.length > 0 ? (conflicts.length - 1) * GAP_CONFLICT + NODE_W_CONFLICT : L1_WIDTH;
    const totalSpan = Math.max(agentSpan, conflictSpan, L1_WIDTH);
    // 冲突层放在智能体网格**下方**（网格有几行就让几行的位置）
    const yConflict = Y_AGENT + agentRows * AGENT_ROW_STEP + 56;

    // ---- L1 中心节点（居顶） ----
    const l1X = (totalSpan - L1_WIDTH) / 2;

    const l1Data: EntityNodeData = {
      label: 'L1 全局记忆',
      sub: '权威事实 · 唯一写通道 ingest',
      kind: 'memory',
      width: L1_WIDTH,
      // ★ 选中态一律不在这里写 —— 见下方「选中高亮」effect
      //   （把 selectedId 塞进 graphData 的依赖，点一下节点就重算整份图）
    };
    nodes.push({
      id: 'l1',
      type: 'entity',
      position: { x: l1X, y: Y_L1 },
      data: l1Data as unknown as Record<string, unknown>,
    });

    // ---- 智能体节点：agent → L1（读 / 被拒）----
    let deniedTotal = 0;
    const agentOffset = Math.max(0, (totalSpan - agentSpan) / 2);
    agents.forEach((agentId, i) => {
      const stat = auditByAgent.get(agentId) ?? { read: 0, denied: 0, wrote: 0 };
      const l2 = statOf(agentId);
      deniedTotal += stat.denied;
      const wheelText = l2 && l2.wheel.length > 0 ? ` · 记 Ch${l2.wheel.join(',')}` : '';
      const l2Text = l2 && (l2.said > 0 || l2.factRef > 0)
        ? `经历 ${l2.said}${l2.factRef > 0 ? ` · 引用 ${l2.factRef}` : ''}`
        : '暂无私记';
      const sub = `${l2Text}${wheelText}`;
      const nodeId = `agent-${agentId}`;
      const data: EntityNodeData = {
        label: ROLE_LABEL[agentId] ?? agentId,
        sub,
        kind: 'agent',
        width: NODE_W_AGENT,
        alert: stat.denied > 0,
        badge: stat.denied > 0 ? stat.denied : undefined,
        // 选中态交给下方的 effect，不放进 graphData
      };
      nodes.push({
        id: nodeId,
        type: 'entity',
        position: {
          x: agentOffset + (i % AGENT_PER_ROW) * GAP_AGENT,
          y: Y_AGENT + Math.floor(i / AGENT_PER_ROW) * AGENT_ROW_STEP,
        },
        data: data as unknown as Record<string, unknown>,
      });

      const parts = [
        stat.read > 0 ? `读 ${stat.read}` : '',
        stat.denied > 0 ? `拒 ${stat.denied}` : '',
        stat.wrote > 0 ? `写 ${stat.wrote}` : '',
      ].filter(Boolean).join(' · ');
      // 方向：L1 → 智能体（**从上往下**）。语义上是"记忆流向这个智能体"，
      // 几何上则是为了连线干净 —— 反过来画（agent→L1）会从下方节点往上穿，
      // 而手柄只有「上(target) / 下(source)」一对，那条线会横穿两个节点。
      edges.push({
        id: `edge-${agentId}`,
        source: 'l1',
        target: nodeId,
        type: 'default',
        label: parts || '无往来',
        labelStyle: { fill: stat.denied > 0 ? ALERT_INK : MUTED_INK, fontSize: 9.5, opacity: 0 },
        labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.92 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        // 被拒过：警示虚线 —— 记忆隔离里唯一需要人立刻看出来的事
        style: {
          stroke: stat.denied > 0 ? ALERT_INK : MUTED_INK,
          strokeWidth: stat.denied > 0 ? 1.5 : 1,
          strokeOpacity: stat.denied > 0 ? 0.75 : 0.4,
          strokeDasharray: stat.denied > 0 ? '5 3' : undefined,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: stat.denied > 0 ? ALERT_INK : MUTED_INK,
          width: 12,
          height: 12,
        },
      });
    });

    // ---- 冲突节点：L1 → 冲突（同批同槽位两个值，两条都没写）----
    const conflictOffset = Math.max(0, (totalSpan - conflictSpan) / 2);
    conflicts.forEach((c, i) => {
      const nodeId = `cf-${c.id}`;
      const data: EntityNodeData = {
        label: c.slot,
        sub: `${c.existing ?? '—'} ✗ ${c.incoming ?? '—'}`,
        kind: 'memory',
        width: NODE_W_CONFLICT,
        alert: true,
        // 同上
      };
      nodes.push({
        id: nodeId,
        type: 'entity',
        position: { x: conflictOffset + i * GAP_CONFLICT, y: yConflict },
        data: data as unknown as Record<string, unknown>,
      });
      edges.push({
        id: `cfedge-${c.id}`,
        source: 'l1',
        target: nodeId,
        type: 'default',
        label: '同批冲突',
        labelStyle: { fill: ALERT_INK, fontSize: 9.5, opacity: 0 },
        labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.92 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        style: { stroke: ALERT_INK, strokeWidth: 1.3, strokeOpacity: 0.6, strokeDasharray: '5 3' },
        markerEnd: { type: MarkerType.ArrowClosed, color: ALERT_INK, width: 12, height: 12 },
      });
    });

    return { nodes, edges, agentCount: agents.length, deniedTotal };
  }, [view, auditByAgent]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  /** 数据变化时合并：保留用户拖出来的位置（审计图每次刷新都重排会很难用） */
  useEffect(() => {
    setNodes((existing) => {
      const map = new Map(existing.map((n) => [n.id, n]));
      return graphData.nodes.map((next) => {
        const old = map.get(next.id);
        return old ? { ...next, position: old.position } : next;
      });
    });
    setEdges(graphData.edges);
  }, [graphData.nodes, graphData.edges, setNodes, setEdges]);

  useEffect(() => {
    // 节点没了（冲突被裁掉）就把选中态清掉，否则侧栏会对着一件不存在的东西
    if (selectedId && !graphData.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [graphData.nodes, selectedId]);

  /**
   * 选中高亮：**只改 data，不重建图**。
   * ★ 原先 `isSelected` 算在 graphData 里 → selectedId 进了 useMemo 依赖，
   *   点一下节点就要把整份 nodes/edges 重算一遍（含按 agent 聚合、排序、布局计算）。
   *   现在数据归数据、选中归选中，与 RelationGraph / ChapterPlanGraphPanel 一致。
   *   无变化时返回原引用，省掉一次全量重渲染。
   */
  useEffect(() => {
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        const want = n.id === selectedId;
        const cur = !!(n.data as { isSelected?: boolean }).isSelected;
        if (want === cur) return n;
        changed = true;
        return { ...n, data: { ...n.data, isSelected: want } };
      });
      return changed ? next : nds;
    });
  }, [selectedId, setNodes]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId((cur) => (cur === node.id ? null : node.id));
  }, []);

  const getNodeColor = useCallback((node: Node) => {
    const d = node.data as unknown as EntityNodeData;
    if (d.alert) return ALERT_INK;
    return kindInk(d.kind);
  }, []);

  const denied = view?.audit.filter((a) => !a.allow) ?? [];
  const selectedConflict = selectedId?.startsWith('cf-')
    ? view?.conflicts.find((c) => `cf-${c.id}` === selectedId)
    : undefined;
  const selectedAgentId = selectedId?.startsWith('agent-') ? selectedId.slice(6) : null;
  const selectedAgentAudit = selectedAgentId
    ? (view?.audit ?? []).filter((a) => a.agentId === selectedAgentId)
    : [];

  const detail = (
    <>
      {/* 冲突裁决（与原面板同一套三态决策）—— 选中冲突节点时出现在侧栏 */}
      {selectedConflict && (
        <div
          className="rounded-lg px-3 py-2"
          style={{ border: `0.5px solid ${ALERT_INK}` }}
        >
          <div className="text-[11.5px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>
            {selectedConflict.slot}
          </div>
          <div className="text-[11px] mt-1 leading-[1.7]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            已在库：<span style={{ color: 'hsl(var(--foreground))' }}>{selectedConflict.existing ?? '—'}</span>
            <span className="mx-1.5">✗</span>
            本批：<span style={{ color: 'hsl(var(--foreground))' }}>{selectedConflict.incoming ?? '—'}</span>
            {selectedConflict.source && <span className="ml-1.5 opacity-70">（{selectedConflict.source}）</span>}
          </div>
          {/* 裁决要"有内容"：只打标记等于没裁（记下决策、采用哪个值、要不要重跑沉淀） */}
          <div className="mt-2 flex flex-col gap-1.5">
            {([
              ['keep', '用库里那个'],
              ['accept', '用本批那个'],
              ['drop', '都不算'],
            ] as const).map(([decision, label]) => (
              <button
                key={decision}
                type="button"
                onClick={() => void resolveConflict(selectedConflict.id, decision)
                  .then((r) => { setHint(r?.hint ?? null); return load(); })}
                className="text-[10.5px] px-2 py-1 rounded"
                style={{ background: 'transparent', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {hint && (
        <div className="text-[11px] rounded-lg px-3 py-2" style={{ background: 'hsl(var(--primary) / 0.08)', color: 'hsl(var(--primary))' }}>
          {hint}
        </div>
      )}

      {selectedAgentId ? (
        <section>
          <div className="text-[11.5px] font-medium mb-1.5" style={{ color: 'hsl(var(--foreground))' }}>
            {ROLE_LABEL[selectedAgentId] ?? selectedAgentId} · 审计 {selectedAgentAudit.length} 条
          </div>
          <div className="flex flex-col">
            {selectedAgentAudit.slice(0, 20).map((a) => (
              <div
                key={a.id}
                className="flex items-start gap-1.5 py-1 text-[10.5px]"
                style={{ borderBottom: '0.5px dashed hsl(var(--border) / 0.6)' }}
              >
                <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {hhmmss(a.at)}
                </span>
                <span className="shrink-0" style={{ color: a.allow ? MUTED_INK : ALERT_INK, minWidth: 34 }}>
                  {ACTION_LABEL[a.action] ?? a.action}
                </span>
                <span className="min-w-0 flex-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {a.reason ? (REASON_LABEL[a.reason] ?? a.reason) : ''}
                  {a.detail ? ` · ${a.detail}` : ''}
                </span>
              </div>
            ))}
            {selectedAgentAudit.length === 0 && (
              <div className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                这个智能体还没有审计记录。
              </div>
            )}
          </div>
        </section>
      ) : (
        <section>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[11.5px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>
              审计流水
            </span>
            <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              近 {view?.audit.length ?? 0} 条
              {denied.length > 0 && ` · 其中被拒 ${denied.length}`}
            </span>
          </div>
          <div className="flex flex-col">
            {(view?.audit ?? []).slice(0, 16).map((a) => (
              <div
                key={a.id}
                className="flex items-start gap-1.5 py-1 text-[10.5px]"
                style={{ borderBottom: '0.5px dashed hsl(var(--border) / 0.6)' }}
              >
                <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {hhmmss(a.at)}
                </span>
                <span className="shrink-0" style={{ color: a.allow ? MUTED_INK : ALERT_INK, minWidth: 34 }}>
                  {ACTION_LABEL[a.action] ?? a.action}
                </span>
                <span className="shrink-0" style={{ color: 'hsl(var(--foreground))', minWidth: 56 }}>
                  {ROLE_LABEL[a.agentId] ?? a.agentId}
                </span>
                <span className="min-w-0 flex-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {a.reason ? (REASON_LABEL[a.reason] ?? a.reason) : ''}
                  {a.detail ? ` · ${a.detail}` : ''}
                </span>
              </div>
            ))}
            {view && view.audit.length === 0 && (
              <div className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                还没有审计记录 —— 跑一段讨论或流水线就会出现。
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );

  const legend = (
    <>
      <span className="flex items-center gap-1.5">
        <span className="rounded-full" style={{ width: 7, height: 7, background: kindInk('agent') }} aria-hidden="true" />
        <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>智能体</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="rounded-full" style={{ width: 7, height: 7, background: kindInk('memory') }} aria-hidden="true" />
        <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>记忆</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span style={{ width: 14, height: 0, borderTop: `1.5px dashed ${ALERT_INK}` }} aria-hidden="true" />
        <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>被拒 / 冲突</span>
      </span>
      <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
        点节点看明细 · 冲突节点可裁决 · 打开「边标签」看读写次数
      </span>
    </>
  );

  if (!projectId) {
    return (
      <div className="p-6 text-[12px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
        未加载项目 —— 记忆审计需要一个项目上下文。
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-3">
      {/* 顶部条：说明 + 刷新 + 错误。刻意**不轮询** —— 读三张表，不是实时指标 */}
      <div
        className="shrink-0 rounded-lg px-3 py-2 flex items-center gap-2"
        style={{ background: 'hsl(var(--card) / 0.6)', border: '0.5px solid hsl(var(--border) / 0.6)' }}
      >
        <ShieldCheck size={14} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />
        <span className="text-[11.5px]" style={{ color: 'hsl(var(--foreground))' }}>记忆审计</span>
        <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          谁在什么用途下读了全局记忆 · 谁的私记最多 · 哪条事实冲突还没裁
        </span>
        {view && !view.available && (
          <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            项目库还没建（先跑一次讨论或立设定，审计才会有内容）
          </span>
        )}
        {error && (
          <span className="text-[11px]" style={{ color: ALERT_INK }}>读取失败：{error}</span>
        )}
        <button
          type="button"
          onClick={() => void load()}
          aria-label="刷新"
          className="ml-auto flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded"
          style={{ background: 'transparent', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          刷新
        </button>
      </div>

      {view && view.conflicts.length > 0 && (
        <div
          className="shrink-0 rounded-lg px-3 py-2 flex items-center gap-2 text-[11px]"
          style={{ background: 'hsl(var(--destructive) / 0.07)', border: `0.5px solid ${ALERT_INK}` }}
        >
          <AlertTriangle size={12} style={{ color: ALERT_INK }} aria-hidden="true" />
          <span style={{ color: ALERT_INK }}>
            事实冲突 {view.conflicts.length} 条 —— 同批次同槽位两个值，两条都没写，等人裁。
          </span>
          <span style={{ color: 'hsl(var(--muted-foreground))' }}>点图上的警示节点去裁决。</span>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <GraphShell
          title="记忆图谱"
          countText={
            `L1 全局记忆 · ${graphData.agentCount} 个智能体`
            + (graphData.deniedTotal > 0 ? ` · 被拒 ${graphData.deniedTotal} 次` : '')
            + (view ? ` · 冲突 ${view.conflicts.length}` : '')
          }
          emptyHint="还没有记忆数据 —— 跑一段讨论或流水线，智能体的读写与私记就会长出来。"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          defaultEdgeOptions={{ type: 'default' }}
          getNodeColor={getNodeColor}
          legend={legend}
          detail={detail}
          exportFileNamePrefix="memory-graph"
        />
      </div>
    </div>
  );
}
