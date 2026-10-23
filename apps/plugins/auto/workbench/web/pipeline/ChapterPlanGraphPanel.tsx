// ============================================================
// ChapterPlanGraphPanel —— 「本章计划」的**图谱版**
//
// 原 WorldStateBoard 是一张卡片 + 一个流水列表（阶段推进 / 本章结论 / 最近变动）。
// 作者要求把 AI 工作台的详细内容全面图谱化，于是这里把三件事画成**一张图**：
//
//   第一层（横排）：单章闭环的六个阶段 —— 讨论 → 写作 → 意图门 → 校对门 → 润色门 → 交付
//   第二层：本次会话之后**世界变了的那几章**（圆节点，章号）
//   第三层：被这些章节改变过的实体（角色 / 物品 / 伏笔）
//   边：阶段推进链 · 交付→章（"这一章交出来了"）· 章→实体（"ChN 把它改成了什么样"）
//
// 为什么合并成一张图而不是三张：这三件事本就是**一条因果链**
// （阶段跑完 → 交付 → 章节改变了世界）。拆开画反而看不出联系。
//
// 本章结论不进图 —— 它是**长文本契约**（定稿官按固定字段输出），
// 塞进节点里只会变成一坨小黑块。放进 GraphShell 的侧栏，结构化字段直读。
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Node, type Edge, type NodeTypes, useNodesState, useEdgesState, MarkerType } from '@xyflow/react';
import type { Character, Foreshadow, Item } from '@novel/shared';
import { useCharacterStore, useForeshadowStore, useItemStore } from '@novel-plugins/data-core/stores';
import { GraphShell } from '@novel-plugins/ui-graph/GraphShell';
import { StageNode, statusInk, type StageNodeData, type StageVisualStatus } from '@novel-plugins/ui-graph/StageNode';
import { EntityNode, kindInk, type EntityKind, type EntityNodeData } from '@novel-plugins/ui-graph/EntityNode';
import { STAGES, type StageKey, type StageState } from './WorkbenchPlan';

interface ChapterPlanGraphPanelProps {
  projectId: string | null;
  /** 讨论收敛出的本章结论（结构化展示在侧栏） */
  conclusion?: string | null;
  /** 是否正在跑一轮会话（把「讨论」标成进行中） */
  running?: boolean;
  /** 各阶段状态（由工作台按收到的事件累积） */
  stages?: Partial<Record<StageKey, StageState>>;
}

const nodeTypes: NodeTypes = { stage: StageNode, entity: EntityNode };

/** 定稿官约定的字段名 —— 只有认得出的字段才做结构化（与 WorkbenchPlan 同一份口径） */
const CONCERN_FIELDS = ['节拍', '角色', '关键物', '伏笔', '禁项', '结束状态', '待定'];

/** 把定稿官的固定格式解析成字段；解析不出来就返回空数组（调用方原样兜底） */
function parseConclusion(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  let cur: { key: string; value: string } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^：:]{1,8})[：:]\s*(.*)$/);
    if (m && CONCERN_FIELDS.includes((m[1] ?? '').trim())) {
      if (cur) out.push(cur);
      cur = { key: (m[1] ?? '').trim(), value: m[2] ?? '' };
    } else if (cur) {
      cur.value += '\n' + line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 一条实体变动 */
interface ChangeRow {
  key: string;
  chapter: number;
  entityId: string;
  entity: string;
  kind: EntityKind;
  /** 变动描述（如「状态」「伏笔回收」） */
  label: string;
  from?: string;
  to?: string;
}

/** 布局常量：三层各自一条横带，层内等距 */
const NODE_W_STAGE = 120;
const GAP_STAGE = 170;
const CH_SIZE = 40;
const GAP_CH = 96;
const NODE_W_ENTITY = 150;
const GAP_ENTITY = 196;
const ENTITY_PER_ROW = 6;
const Y_STAGE = 0;
const Y_CH = 250;
const Y_ENTITY = 380;
const Y_ENTITY_STEP = 112;
/** 图上最多画多少个实体节点 —— 再多就成毛线团了，剩下的在侧栏文字里看 */
const MAX_ENTITY_NODES = 12;

export function ChapterPlanGraphPanel({
  projectId, conclusion, running, stages,
}: ChapterPlanGraphPanelProps) {
  const characters = useCharacterStore((s) => s.characters);
  const items = useItemStore((s) => s.items);
  const foreshadows = useForeshadowStore((s) => s.foreshadows);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pItems = useMemo(() => items.filter((i) => i.projectId === projectId) as Item[], [items, projectId]);
  const pFsh = useMemo(() => foreshadows.filter((f) => f.projectId === projectId) as Foreshadow[], [foreshadows, projectId]);
  const pChars = useMemo(() => characters.filter((c) => c.projectId === projectId) as Character[], [characters, projectId]);

  /** 变动流水：所有 EntityState 拉平后按章号倒序 —— 与 WorldStateBoard 同一份口径 */
  const changes = useMemo(() => {
    const rows: ChangeRow[] = [];
    for (const ch of pChars) {
      for (const st of ch.states ?? []) {
        rows.push({
          key: `${ch.id}:${st.chapter}:${st.field}:${st.newValue}`,
          chapter: st.chapter,
          entityId: ch.id,
          entity: ch.name,
          kind: 'character',
          label: st.field === '状态' ? '角色变化' : st.field,
          from: st.oldValue,
          to: st.newValue,
        });
      }
    }
    for (const it of pItems) {
      for (const st of it.states ?? []) {
        rows.push({
          key: `${it.id}:${st.chapter}:${st.field}:${st.newValue}`,
          chapter: st.chapter,
          entityId: it.id,
          entity: it.name,
          kind: 'item',
          label: st.description || st.field,
          from: st.oldValue,
          to: st.newValue,
        });
      }
    }
    for (const f of pFsh) {
      if (f.payoffChapter) {
        rows.push({
          key: `${f.id}:payoff`,
          chapter: f.payoffChapter,
          entityId: f.id,
          entity: f.description.slice(0, 10),
          kind: 'foreshadow',
          label: '伏笔回收',
          to: '已回收',
        });
      }
    }
    return rows.sort((a, b) => b.chapter - a.chapter);
  }, [pChars, pItems, pFsh]);

  const latestChapter = changes.length > 0 ? changes[0]!.chapter : 0;

  const graphData = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    /**
     * 三层横向对齐：实体层通常最宽，拿它当基准，把阶段层与章号层在它上面居中。
     * 不这么做的话（三层各自从 x=0 起排），阶段行会缩在左边、右边空一大片
     * —— 真机截图确认过这个观感问题。
     */
    const entityTotal = Math.min(new Set(changes.map((c) => c.entityId)).size, MAX_ENTITY_NODES);
    const entityPerRow = Math.min(Math.max(entityTotal, 1), ENTITY_PER_ROW);
    const entityRowWidth = (entityPerRow - 1) * GAP_ENTITY + NODE_W_ENTITY;
    const backboneWidth = (STAGES.length - 1) * GAP_STAGE + NODE_W_STAGE;
    const stageOffset = Math.max(0, (entityRowWidth - backboneWidth) / 2);

    // ---- 第一层：单章闭环六阶段 ----
    const stateOf = (key: StageKey): StageVisualStatus => {
      if (key === 'discuss') {
        if (conclusion) return 'done';
        return running ? 'running' : 'idle';
      }
      return (stages?.[key] ?? 'idle') as StageVisualStatus;
    };

    STAGES.forEach((s, i) => {
      const st = stateOf(s.key);
      const data: StageNodeData = {
        label: s.label,
        status: st,
        isCurrent: st === 'running',
        width: NODE_W_STAGE,
      };
      nodes.push({
        id: `stage-${s.key}`,
        type: 'stage',
        position: { x: stageOffset + i * GAP_STAGE, y: Y_STAGE },
        data: data as unknown as Record<string, unknown>,
      });
      if (i > 0) {
        const prev = STAGES[i - 1]!;
        const ink = statusInk(st);
        edges.push({
          id: `flow-${prev.key}-${s.key}`,
          source: `stage-${prev.key}`,
          target: `stage-${s.key}`,
          // 六个阶段**一行排开** → 走左右手柄。用上下手柄的连线要在同一 y 上
          // 从底部绕到下一个节点顶部，会打出两个半圆（打结观感）。
          sourceHandle: 's-right',
          targetHandle: 't-left',
          type: 'default',
          animated: st === 'running',
          style: {
            stroke: st === 'idle' ? 'hsl(var(--muted-foreground) / 0.35)' : ink,
            // 已走到的推进用实墨，还没到的细一些：一眼看出"走到哪"
            strokeWidth: st === 'idle' ? 1.2 : 1.6,
            strokeDasharray: st === 'idle' ? '4 4' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: ink, width: 14, height: 14 },
        });
      }
    });

    // ---- 第二层：有变动的章号（**升序排列：左老右新，顺着时间读**） ----
    // ★ 为什么必须升序：原先按降序排（最新在最左），而实体是按"最近变动"排序的 ——
    //   两者的横向次序正好相反，于是每一条变动边都要横跨整幅图，14 条就成了毛线团
    //   （2026-09-15 真机截图确认）。升序 + 实体按最早变动章升序，边基本是短斜线。
    const allOrders = Array.from(new Set(changes.map((c) => c.chapter))).sort((a, b) => a - b);
    const chapterOrders = allOrders.slice(-8);
    const chWidth = (chapterOrders.length - 1) * GAP_CH + CH_SIZE;
    // 章号层在**整幅图**上居中（基准是实体层宽度，不是阶段链路宽度）——
    // 三层共用同一个基准才对得齐
    const chOffset = Math.max(0, (entityRowWidth - chWidth) / 2);
    const chIndex = new Map<number, number>();
    chapterOrders.forEach((order, i) => {
      chIndex.set(order, i);
      const data: EntityNodeData = {
        label: `Ch${order}`,
        sub: order === latestChapter ? '最新' : undefined,
        kind: 'chapter',
        variant: 'round',
        size: CH_SIZE,
        // ★ 这里**不**写 isSelected —— 选中高亮由单独的 effect 处理。
        //   原因见下方「选中高亮」注释：把 selectedId 放进 graphData 的依赖里，
        //   每次点节点都要把整份 nodes/edges（22 节点 19 边）重算一遍。
      };
      nodes.push({
        id: `ch-${order}`,
        type: 'entity',
        position: { x: chOffset + i * GAP_CH, y: Y_CH },
        data: data as unknown as Record<string, unknown>,
      });
    });
    // 交付 → 最新一章：把"阶段链"与"世界变动"接起来（这是全图最关键的一条边）。
    // 显式给出上下手柄：交付在阶段行最右，最新章在章号行最右，这条边几乎是竖直的。
    if (latestChapter > 0 && chIndex.has(latestChapter)) {
      edges.push({
        id: `deliver-ch-${latestChapter}`,
        source: 'stage-deliver',
        target: `ch-${latestChapter}`,
        sourceHandle: 's-bottom',
        targetHandle: 't-top',
        type: 'default',
        style: { stroke: 'hsl(var(--state-done))', strokeWidth: 1.6, strokeDasharray: '6 3' },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'hsl(var(--state-done))', width: 14, height: 14 },
      });
    }

    // ---- 第三层：被改变过的实体 ----
    // 同批次的变动合并成**一条边**（一对节点只画一条），否则「同一章改了同一个角色的
    // 三个字段」会画成三条几乎重合的线 —— 视觉噪音，信息量却一样。
    const byEntity = new Map<string, { changes: ChangeRow[] }>();
    for (const c of changes) {
      const cur = byEntity.get(c.entityId);
      if (cur) cur.changes.push(c);
      else byEntity.set(c.entityId, { changes: [c] });
    }
    const entityList = Array.from(byEntity.entries())
      .map(([entityId, v]) => ({ entityId, rows: v.changes }))
      // 按"最早变动章"升序 —— 与章号锚点左右对齐，边才短
      .sort((a, b) => Math.min(...a.rows.map((r) => r.chapter)) - Math.min(...b.rows.map((r) => r.chapter)))
      .slice(0, MAX_ENTITY_NODES);

    entityList.forEach(({ entityId, rows }, i) => {
      const col = i % ENTITY_PER_ROW;
      const r = Math.floor(i / ENTITY_PER_ROW);
      const nodeId = `ent-${entityId}`;

      // 实体节点：副文字用**最新那条**变动（作者最关心"现在是什么样"）
      const latest = rows.reduce((a, b) => (b.chapter >= a.chapter ? b : a));
      const delta = latest.from ? `${latest.from}→${latest.to ?? ''}` : (latest.to ?? '');
      const kindLabel = latest.kind === 'character' ? '角色' : latest.kind === 'item' ? '物品' : '伏笔';
      const data: EntityNodeData = {
        label: latest.entity,
        sub: `${kindLabel} · Ch${latest.chapter} ${latest.label}${delta ? ` ${delta}` : ''}`,
        kind: latest.kind,
        width: NODE_W_ENTITY,
        badge: rows.length,
        // 同上：选中态不在这里写
      };
      nodes.push({
        id: nodeId,
        type: 'entity',
        position: { x: col * GAP_ENTITY, y: Y_ENTITY + r * Y_ENTITY_STEP },
        data: data as unknown as Record<string, unknown>,
      });

      // 章 → 实体：**每个（章, 实体）一对只画一条边**
      const byChapter = new Map<number, ChangeRow[]>();
      for (const c of rows) {
        const list = byChapter.get(c.chapter);
        if (list) list.push(c);
        else byChapter.set(c.chapter, [c]);
      }
      for (const [chapter, list] of byChapter) {
        if (!chIndex.has(chapter)) continue;
        const ink = kindInk(latest.kind);
        const text = list.length === 1
          ? `${list[0]!.label}${list[0]!.from ? ` ${list[0]!.from}→${list[0]!.to ?? ''}` : (list[0]!.to ? ` ${list[0]!.to}` : '')}`
          : `${list[0]!.label} 等 ${list.length} 处`;
        edges.push({
          id: `chg-${entityId}-${chapter}`,
          source: `ch-${chapter}`,
          target: nodeId,
          type: 'default',
          label: text.slice(0, 20),
          labelStyle: { fill: 'hsl(var(--muted-foreground))', fontSize: 9, opacity: 0 },
          labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          style: { stroke: ink, strokeWidth: 1, strokeOpacity: 0.45 },
          markerEnd: undefined,
        });
      }
    });

    return { nodes, edges, chapterCount: chapterOrders.length, entityCount: byEntity.size };
  }, [STAGES, conclusion, running, stages, changes, latestChapter]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  /** 数据变化时合并：保留用户拖出来的位置，只更新 data（否则每次刷新节点都跳回原处） */
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

  /**
   * 选中高亮：**只改 data，不重建图**。
   *
   * ★ 为什么单独一个 effect：原先 `isSelected` 是在 graphData 里算的，于是
   *   `selectedId` 进了 useMemo 的依赖 —— 点一下节点就要把整份 nodes/edges
   *   （22 节点 19 边，含 Map 分组与排序）重算一遍，还会连锁触发下面的合并 effect。
   *   RelationGraph 早就是"数据归数据、选中归选中"的做法，这里对齐。
   *
   * 没有变化时**返回原引用**（nds），避免一次无谓的全量重渲染。
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
    const d = node.data as unknown as { status?: StageVisualStatus; kind?: EntityKind };
    if (d.status) return statusInk(d.status);
    if (d.kind) return kindInk(d.kind);
    return 'hsl(var(--muted-foreground))';
  }, []);

  // ---- 侧栏 ----
  const fields = useMemo(() => (conclusion ? parseConclusion(conclusion) : []), [conclusion]);

  const selectedChangeRows = useMemo(() => {
    if (!selectedId) return [];
    if (selectedId.startsWith('ent-')) {
      const id = selectedId.slice(4);
      return changes.filter((c) => c.entityId === id);
    }
    if (selectedId.startsWith('ch-')) {
      const order = Number(selectedId.slice(3));
      return changes.filter((c) => c.chapter === order);
    }
    return [];
  }, [selectedId, changes]);

  const selectedStage = useMemo(() => {
    if (!selectedId?.startsWith('stage-')) return null;
    const key = selectedId.slice(6) as StageKey;
    return STAGES.find((s) => s.key === key) ?? null;
  }, [selectedId]);

  const detail = (
    <>
      {selectedStage ? (
        <div className="space-y-2">
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 13, fontWeight: 600, color: 'hsl(var(--ink))' }}>
            {selectedStage.label}
          </div>
          <p className="text-[11px] leading-[1.8]" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {selectedStage.hint}
          </p>
        </div>
      ) : selectedChangeRows.length > 0 ? (
        <div>
          <div className="text-[11.5px] font-medium mb-1.5" style={{ color: 'hsl(var(--ink))' }}>
            变动 {selectedChangeRows.length} 条
          </div>
          <ul className="space-y-1.5">
            {selectedChangeRows.map((c) => (
              <li key={c.key} className="flex items-baseline gap-1.5 text-[11px]">
                <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--muted-foreground))', minWidth: 30 }}>
                  Ch{c.chapter}
                </span>
                <span className="shrink-0 font-medium truncate max-w-[86px]" style={{ color: kindInk(c.kind) }}>
                  {c.entity}
                </span>
                <span className="min-w-0" style={{ color: 'hsl(var(--ink-light))' }}>
                  {c.label}
                  {c.from ? ` ${c.from} → ` : ' '}
                  {c.to ?? ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {/* 本章结论 —— 契约，结构化展示；格式跑偏就原样显示，绝不丢内容 */}
          <div>
            <div className="text-[11.5px] font-medium mb-1.5" style={{ color: 'hsl(var(--ink))' }}>
              本章结论
            </div>
            {!conclusion ? (
              <p className="text-[11px] leading-[1.8]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                还没有结论。在左侧对智能体说明这一章要写什么，讨论收敛出的「本章结论」会落在这里 ——
                它既是写作官的输入，也是复核时的对照物。
              </p>
            ) : fields.length === 0 ? (
              <pre
                className="text-[11px] leading-[1.75] whitespace-pre-wrap"
                style={{ color: 'hsl(var(--ink-light))', margin: 0, fontFamily: 'inherit' }}
              >
                {conclusion}
              </pre>
            ) : (
              <dl className="space-y-1.5">
                {fields.map((f) => (
                  <div key={f.key} className="flex gap-2">
                    <dt className="shrink-0 text-[11px] font-medium" style={{ color: 'hsl(var(--primary) / 0.9)', minWidth: 48 }}>
                      {f.key}
                    </dt>
                    <dd className="text-[11px] leading-[1.7] whitespace-pre-wrap" style={{ margin: 0, minWidth: 0, color: 'hsl(var(--ink-light))' }}>
                      {f.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          {selectedId && (
            <p className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              再点一下刚选中的节点可以取消选中。
            </p>
          )}
        </>
      )}

      {changes.length > 0 && (
        <div className="pt-2" style={{ borderTop: '0.5px solid hsl(var(--border) / 0.5)' }}>
          <div className="text-[11px] mb-1" style={{ color: 'hsl(var(--muted-foreground))', letterSpacing: '0.08em' }}>
            最近变动（全量 {changes.length} 条）
          </div>
          <ul className="space-y-1">
            {changes.slice(0, 12).map((c) => (
              <li key={c.key} className="flex items-baseline gap-1.5 text-[10.5px]">
                <span className="shrink-0 tabular-nums" style={{ color: 'hsl(var(--muted-foreground))', minWidth: 28 }}>
                  Ch{c.chapter}
                </span>
                <span className="shrink-0 font-medium truncate max-w-[80px]" style={{ color: kindInk(c.kind) }}>
                  {c.entity}
                </span>
                <span className="truncate" style={{ color: 'hsl(var(--ink-light))' }} title={c.label}>
                  {c.label}
                  {c.from ? ` ${c.from}→` : ' '}
                  {c.to ?? ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );

  const legend = (
    <>
      {([
        ['done', '已完成'],
        ['running', '进行中'],
        ['idle', '待开始'],
        ['blocked', '被挡下'],
      ] as Array<[StageVisualStatus, string]>).map(([st, label]) => (
        <span key={st} className="flex items-center gap-1.5">
          <span className="rounded-full" style={{ width: 7, height: 7, background: statusInk(st) }} aria-hidden="true" />
          <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>圆节点＝章号 · 方块＝被改动的实体 · 徽标数字＝变动条数</span>
      </span>
    </>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        <GraphShell
          title="本章计划"
          countText={
            `闭环第 ${STAGES.filter((s) => {
              if (s.key === 'discuss') return !!conclusion;
              return (stages?.[s.key] ?? 'idle') !== 'idle';
            }).length} / ${STAGES.length} 步`
            + ` · 变动 ${changes.length} 条 · 涉及 ${graphData.entityCount} 个实体`
          }
          emptyHint="还没有可画的东西 —— 先让智能体跑一章，阶段推进与实体变动会自动长出来。"
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
          exportFileNamePrefix="chapter-plan-graph"
        />
      </div>
    </div>
  );
}
