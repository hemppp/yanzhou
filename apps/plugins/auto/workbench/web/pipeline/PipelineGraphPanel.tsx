// ============================================================
// PipelineGraphPanel —— 设定流水线的**图谱版**（替代 PipelinePanel 的列表式呈现）
//
// 为什么改成图谱：7 个阶段本质是**有向链**（brief → cast → bible → plot → drift →
// pilot → production），列表只能表达"有哪些"，图谱能同时表达"走到哪、下一步是谁、
// 哪一段被打回、哪一段因基线变更过期"。作者的要求是把 AI 工作台的详细内容全面图谱化。
//
// 布局：蛇形（boustrophedon）—— 上排左→右 4 段，下排右→左 3 段，
// 唯一的竖直边是 plot → drift（两节点同 x），读起来不会打结。
//
// ★ 与 PipelinePanel 的**功能对等**是硬要求：开始立设定 / 跑这一段 / 闸门三态决策
//   （通过 / 打回 / 退回上一段）/ 停止 / 决策台账 —— 一个都不能少，
//   否则就是"换了张皮，功能少了"。
//   所以 SSE 事件处理整段沿用原实现（那份逻辑是真机调出来的，不能重写）。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, Play, RefreshCw, X } from 'lucide-react';
import {
  type Node, type Edge, type NodeTypes,
  useNodesState, useEdgesState, MarkerType,
} from '@xyflow/react';
import {
  fetchPipeline, startPipeline, decidePipeline, runPipelineStage,
  type DecisionAction, type PipelineStageView, type PipelineStatus, type PipelineView, type StageKey,
} from './services/pipelineSession';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';
import { GraphShell } from '@novel-plugins/ui-graph/GraphShell';
import { StageNode, statusInk, type StageNodeData, type StageVisualStatus } from '@novel-plugins/ui-graph/StageNode';

/** 转发到左栏交流流的一条发言（与工作台的 ChatTurn 结构兼容） */
export interface PipelineTurn {
  from: string;
  name: string;
  color: string;
  short: string;
  text: string;
  meta?: string;
  tone?: 'warn' | 'ok';
}

interface PipelineGraphPanelProps {
  projectId: string | null;
  onProjectDataChanged?: () => void;
  onTurn?: (t: PipelineTurn) => void;
  hasChapters?: boolean;
  onStatus?: (view: PipelineView | null, status: PipelineStatus | null) => void;
}

/** 阶段产出物的名字（收敛成一句话念出来时用；别在下标里写三元链） */
const STAGE_ARTIFACT: Partial<Record<string, string>> = {
  cast: '角色与节奏宪章',
  bible: '世界圣经',
  plot: '剧情总纲',
  drift: '偏离报告',
  pilot: '前三章审阅报告',
};
const STAGE_LABEL_UI: Partial<Record<string, string>> = {
  brief: '开书信息',
  production: '长跑与监工',
};

const ACTION_TEXT: Record<DecisionAction, string> = { approve: '通过', revise: '打回', reject: '退回' };
const ACTION_COLOR: Record<DecisionAction, string> = {
  approve: 'hsl(var(--state-done))',
  revise: 'hsl(var(--primary))',
  reject: 'hsl(var(--destructive))',
};

/**
 * 实测成本（2026-09-13 真机）：一段 = 三个角色发言 + 主笔回应 + 定稿官收敛 ≈ 5 次模型调用，
 * 1–3 分钟；三段设定跑完约 15–20 次。**必须提前说**，别让作者以为点一下就完事。
 */
const COST_PER_STAGE = '约 5 次模型调用 · 1–3 分钟';
const COST_TOTAL = '三段设定跑完约 15–20 次模型调用';

/** 台账时间：今天只显示时:分，跨天带上月-日 */
function fmtDecisionTime(ts: number): string {
  const d = new Date(ts);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hhmm : `${d.getMonth() + 1}-${d.getDate()} ${hhmm}`;
}

const nodeTypes: NodeTypes = { stage: StageNode };

/**
 * 布局：**3 列 × 3 行**，列内自上而下、列间左→右。
 *
 * brief cast bible  │  plot drift pilot  │  production
 *      ↓            │      ↓            │
 *     ↓             │     ↓             │
 *    ↓              │    ↓              │
 *
 * 为什么不是一行 7 个：一行排开要 1600px 宽，画布只有 ~900px，fitView 缩到 0.57
 * 后节点里 13px 的字会变成 7px —— 读不了。3×3 只要 632×278，能原尺寸放下。
 * 为什么是"列内纵向 + 列间斜向"：纵向用「下→上」手柄、列间用「右→左」手柄，
 * 两种方向各走各的手柄，连线不会互相绕。
 */
const COL_STEP = 250;
const ROW_STEP = 118;
const COL_ROWS = 3;
function slotOf(index: number): { col: number; row: number } {
  return { col: Math.floor(index / COL_ROWS), row: index % COL_ROWS };
}

export function PipelineGraphPanel({
  projectId, onProjectDataChanged, onTurn, onStatus,
}: PipelineGraphPanelProps) {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  /**
   * ★ 2026-10-18：**界面上的长跑**（从 PipelinePanel 移植过来）。
   *
   * 为什么必须在这里也有一份：宿主注册的「流水线」面板是**本组件**
   * （`workbench/web/index.tsx` 的 `pipeline: PipelineGraphPanel`），而长跑控件当初
   * 只加在了 `PipelinePanel`（列表版）上 —— 那个组件现在**只有测试在引用**，
   * 界面上根本点不到。后果就是「GUI 写不完一部长篇」：界面点一次只出一批（5 章），
   * 写 100 章要点 20 次、每次还要过闸门。
   *
   * 这里补「长跑写到 N 章」：按批循环推进，直到全书已交付章数 ≥ N；每批结束
   * 自动 approve（"授权长跑"）；到目标或遇错就停。进度实时显示。
   */
  const [longRunTarget, setLongRunTarget] = useState(20);
  const [longRunMsg, setLongRunMsg] = useState('');
  const [longRunning, setLongRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [note, setNote] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      setStatus(await fetchPipeline());
    } catch (e) {
      // 未启动/无项目都会走到这里，不弹 toast（避免每次挂载都吵一次）
      console.warn('[PipelineGraphPanel] 读取流水线状态失败:', e);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** 状态变更上报（气泡徽标用）—— 收在一处，避免每个 setStatus 都补一遍 */
  useEffect(() => {
    onStatus?.(status?.view ?? null, status);
  }, [status, onStatus]);

  const view = status?.view ?? null;
  const started = status?.started ?? false;
  const hasBrief = status?.hasBrief ?? true;
  const current: PipelineStageView | null = view?.stages.find((s) => s.key === view.stage) ?? null;

  // ---- 图谱数据 ----
  const graphData = useMemo(() => {
    const stages: PipelineStageView[] = view?.stages ?? [];
    const staleSet = new Set(view?.staleStages ?? []);
    const nodes: Node[] = stages.map((s, i) => {
      const { col, row } = slotOf(i);
      // 每列实际有几段（最后一列常常不满）→ 把该列垂直居中，见下方注释
      const inCol = stages.filter((_, k) => slotOf(k).col === col).length;
      const yPad = ((COL_ROWS - inCol) * ROW_STEP) / 2;
      const isCurrent = s.key === view?.stage;
      const data: StageNodeData = {
        label: s.label || STAGE_LABEL_UI[s.key] || s.key,
        sub: s.status === 'approved' && STAGE_ARTIFACT[s.key] ? STAGE_ARTIFACT[s.key] : undefined,
        status: s.status as StageVisualStatus,
        isCurrent,
        gated: s.gated,
        stale: staleSet.has(s.key),
        revision: s.revision,
        dimmed: !s.implemented,
        clickable: true,
        // 阶段名最长的是「角色与节奏宪章」（7 字），152 宽会截成「角色与节奏…」——
        // 真机截图确认过，加宽到 184 才完整
        width: 184,
      };
      return {
        id: s.key,
        type: 'stage',
        position: { x: col * COL_STEP, y: yPad + row * ROW_STEP },
        data: data as unknown as Record<string, unknown>,
      };
    });

    const edges: Edge[] = [];
    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i]!;
      const to = stages[i + 1]!;
      const ink = statusInk(to.status as StageVisualStatus);
      // 同一列 → 走竖向手柄（下→上）；跨列 → 走横向手柄（右→左）。
      // 混用会让连线绕节点打结，见 slotOf 上方的说明。
      const sameCol = slotOf(i).col === slotOf(i + 1).col;
      edges.push({
        id: `stage-${from.key}-${to.key}`,
        source: from.key,
        target: to.key,
        sourceHandle: sameCol ? 's-bottom' : 's-right',
        targetHandle: sameCol ? 't-top' : 't-left',
        type: 'default',
        animated: to.status === 'running',
        // 已完成的推进用实墨，未到的用淡墨 —— 一眼看出"走到哪"
        style: {
          stroke: to.status === 'idle' ? 'hsl(var(--muted-foreground) / 0.35)' : ink,
          strokeWidth: from.status === 'approved' ? 1.6 : 1.2,
          strokeDasharray: to.status === 'idle' ? '4 4' : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: ink, width: 14, height: 14 },
      });
    }
    return { nodes, edges };
  }, [view]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  /** 数据变化时合并：**保留用户拖出来的位置**（否则每刷新一次就跳回原处） */
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

  // ---- 操作（与原 PipelinePanel 一致）----
  const handleStart = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const r = await startPipeline(note.trim() || undefined);
      setNote('');
      setStatus({ started: true, hasBrief: true, view: r.view });
      dispatchToastEvent({ type: 'success', message: '流水线已启动，从「开书信息」开始' });
      if (r.baselineMismatch) {
        dispatchToastEvent({ type: 'info', message: '开书设定改过了，已定稿的阶段可能过期', duration: 5000 });
      }
    } catch (e) {
      dispatchToastEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [projectId, note]);

  /**
   * 长跑：一次授权，按批推进到目标章数。
   * 与 `handleRun` 的区别：这个是**循环 + 自动过闸门**，人点一次就不用盯；
   * 每批之间回到 `awaiting_user` 时自动 approve（长跑闸门本就是"每批一停"）。
   */
  const handleLongRun = useCallback(async () => {
    if (!projectId || longRunning || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setLongRunning(true);
    try {
      let guard = 0;
      for (;;) {
        guard += 1;
        if (guard > 400) { setLongRunMsg('已达安全上限（400 批），停下'); break; }
        // 先读一次：全书写到第几章了？到目标就停。
        const st = await fetchPipeline();
        const delivered = st.view?.lastDelivered ?? 0;
        setStatus(st);
        setLongRunMsg(`已写 ${delivered} 章 / 目标 ${longRunTarget} 章 …`);
        if (delivered >= longRunTarget) { setLongRunMsg(`✅ 已达目标：${delivered} 章`); break; }

        // 停在闸门？先批（长跑闸门是"每批一停"，授权后自动过）
        const prod = st.view?.stages.find((s) => s.key === 'production');
        if (prod?.status === 'awaiting_user') {
          const r = await decidePipeline('production', 'approve');
          setStatus((s) => (s ? { ...s, view: r.view } : s));
          continue;
        }

        const before = delivered;
        setPhase('长跑写一批（5 章）…');
        await runPipelineStage('production', { signal: ac.signal }, (e) => {
          if (e.type === 'stage_phase') setPhase(e.label);
          else if (e.type === 'production_chapter') {
            if (e.phase === 'start') {
              setPhase(`长跑：写第 ${e.order} 章（本批 ${e.index}/${e.total}）…`);
              onTurn?.({
                from: 'production', name: `第 ${e.order} 章`, color: 'hsl(var(--primary))', short: String(e.order),
                text: `开始写第 ${e.order} 章（本批 ${e.index}/${e.total}）。`,
              });
            } else {
              const warn = e.delivered === false || (e.warnings?.length ?? 0) > 0;
              setLongRunMsg(`第 ${e.order} 章${e.delivered ? `已交付（${e.wordCount ?? 0} 字）` : '未交付'} · 全书 ${e.cursor ?? before} 章`);
              onTurn?.({
                from: 'production', name: `第 ${e.order} 章`, color: warn ? 'hsl(var(--state-blocked))' : 'hsl(var(--state-done))',
                short: String(e.order),
                text: e.delivered
                  ? `第 ${e.order} 章已入项目库（${e.wordCount ?? 0} 字）${e.cursor ? `　全书已写到第 ${e.cursor} 章` : ''}${e.warnings?.length ? `\n⚠️ ${e.warnings.join('；')}` : ''}`
                  : `⚠️ 第 ${e.order} 章**未入项目库**${e.warnings?.length ? `：${e.warnings.join('；')}` : ''}`,
                tone: warn ? 'warn' : 'ok',
              });
            }
          } else if (e.type === 'supervise_report') {
            const label = e.verdict === 'halt' ? '需停下处理' : e.verdict === 'watch' ? '留意' : '正常';
            if (e.verdict !== 'ok' || e.issues.length > 0) {
              setLongRunMsg(`监工第 ${e.order} 章：${label}（问题 ${e.issues.length}）`);
              onTurn?.({
                from: 'supervisor', name: `第 ${e.order} 章监工`,
                color: e.verdict === 'halt' ? 'hsl(var(--state-blocked))' : 'hsl(var(--primary))',
                short: '监', tone: e.verdict === 'halt' ? 'warn' : undefined,
                text: `【监工】${label}${e.issues.length ? `\n${e.issues.map((s) => `· ${s}`).join('\n')}` : ''}`,
              });
            }
            if (e.verdict === 'halt') {
              throw new Error(`第 ${e.order} 章监工判定需停下（长跑已停，可处理后接着跑）`);
            }
          } else if (e.type === 'track_review') {
            const label = e.verdict === 'on_track' ? '在轨' : e.verdict === 'major_drift' ? '明显跑偏' : '小幅偏离';
            onTurn?.({
              from: 'plot-designer', name: `轨迹确认（第 ${e.from}–${e.to} 章）`,
              color: e.verdict === 'major_drift' ? 'hsl(var(--state-blocked))' : 'hsl(var(--primary))',
              short: '轨', tone: e.verdict === 'major_drift' ? 'warn' : 'ok',
              text: `【轨迹确认】${label}${e.note ? `：${e.note}` : ''}`,
            });
            if (e.verdict === 'major_drift') {
              throw new Error(`第 ${e.from}–${e.to} 章明显跑偏（长跑已停，请读报告后决策）`);
            }
          } else if (e.type === 'stage_failed') {
            throw new Error(e.message);
          }
        });
      }
    } catch (e) {
      // AbortError（点了"停止"）不算错误
      const msg = e instanceof Error ? e.message : String(e);
      if (!/abort/i.test(msg)) {
        setLongRunMsg(`长跑中断：${msg}（可再点一次接着跑）`);
        dispatchToastEvent({ type: 'error', message: `长跑中断：${msg}` });
      } else {
        setLongRunMsg('已停止（可再点一次接着跑）');
      }
    } finally {
      setLongRunning(false);
      setPhase('');
      void refresh();
    }
  }, [projectId, longRunTarget, longRunning, busy, onTurn, refresh]);

  const handleRun = useCallback(async (stage: StageKey) => {
    if (!projectId || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setPhase('正在召集智能体…');
    try {
      await runPipelineStage(stage, { signal: ac.signal }, (e) => {
        if (e.type === 'stage_phase') setPhase(e.label);
        else if (e.type === 'stage_turn') {
          onTurn?.({ from: e.agent, name: e.name, color: e.color, short: e.short, text: e.text, meta: e.meta });
        } else if (e.type === 'stage_summary') {
          onTurn?.({
            from: 'conclusion', name: `《${STAGE_ARTIFACT[e.stage] ?? STAGE_LABEL_UI[e.stage] ?? '本段结论'}》`,
            color: 'hsl(var(--agent-convener))', short: '稿', text: e.text, tone: 'ok',
          });
        } else if (e.type === 'pilot_chapter') {
          // 试写三章：每章插一条分段卡 —— 一章一次"开写/交稿"，作者能看清交到第几章了
          if (e.phase === 'start') {
            setPhase(`试写第 ${e.order} 章（${e.index}/${e.total}）…`);
            onTurn?.({
              from: 'pilot', name: `第 ${e.order} 章`, color: 'hsl(var(--primary))', short: String(e.order),
              text: `开始试写第 ${e.order} 章（${e.index}/${e.total}）。`,
            });
          } else {
            // ★ 没落库的章要显眼 —— 报告会写得像三章都交了
            const warn = e.delivered === false || (e.warnings?.length ?? 0) > 0;
            onTurn?.({
              from: 'pilot', name: `第 ${e.order} 章`, color: warn ? 'hsl(var(--state-blocked))' : 'hsl(var(--state-done))',
              short: String(e.order),
              text: e.delivered
                ? `第 ${e.order} 章已入项目库（${e.wordCount ?? 0} 字）${e.warnings?.length ? `\n⚠️ ${e.warnings.join('；')}` : ''}`
                : `⚠️ 第 ${e.order} 章**未入项目库**${e.warnings?.length ? `：${e.warnings.join('；')}` : ''}`,
              tone: warn ? 'warn' : 'ok',
            });
          }
        } else if (e.type === 'premiere_review') {
          const label = e.verdict === 'pass' ? '跨章审阅：通过' : e.verdict === 'major' ? '跨章审阅：建议停下重写' : '跨章审阅：可继续（按报告修正）';
          onTurn?.({
            from: 'premiere-reviewer', name: '《前三章审阅报告》',
            color: e.verdict === 'major' ? 'hsl(var(--state-blocked))' : 'hsl(var(--primary))',
            short: '阅', text: e.text, tone: e.verdict === 'major' ? 'warn' : 'ok',
          });
          dispatchToastEvent({
            type: e.verdict === 'major' ? 'error' : 'info',
            message: `${label}（${e.issues} 处问题）`,
            duration: e.verdict === 'major' ? 10000 : 5000,
          });
        } else if (e.type === 'production_chapter') {
          // 长跑：每章插一条分段卡，并实时报"全书已写到第几章"（游标）
          if (e.phase === 'start') {
            setPhase(`长跑：写第 ${e.order} 章（本批 ${e.index}/${e.total}）…`);
            onTurn?.({
              from: 'production', name: `第 ${e.order} 章`, color: 'hsl(var(--primary))', short: String(e.order),
              text: `开始写第 ${e.order} 章（本批 ${e.index}/${e.total}）。`,
            });
          } else {
            const warn = e.delivered === false || (e.warnings?.length ?? 0) > 0;
            onTurn?.({
              from: 'production', name: `第 ${e.order} 章`, color: warn ? 'hsl(var(--state-blocked))' : 'hsl(var(--state-done))',
              short: String(e.order),
              text: e.delivered
                ? `第 ${e.order} 章已入项目库（${e.wordCount ?? 0} 字）${e.cursor ? `　全书已写到第 ${e.cursor} 章` : ''}${e.warnings?.length ? `\n⚠️ ${e.warnings.join('；')}` : ''}`
                : `⚠️ 第 ${e.order} 章**未入项目库**${e.warnings?.length ? `：${e.warnings.join('；')}` : ''}`,
              tone: warn ? 'warn' : 'ok',
            });
          }
        } else if (e.type === 'supervise_report') {
          // 监工只读巡检：ok/watch 都是提醒，halt 才是"停下"
          const label = e.verdict === 'halt' ? '需停下处理' : e.verdict === 'watch' ? '留意' : '正常';
          if (e.verdict !== 'ok' || e.issues.length > 0) {
            onTurn?.({
              from: 'supervisor', name: `第 ${e.order} 章监工`,
              color: e.verdict === 'halt' ? 'hsl(var(--state-blocked))' : 'hsl(var(--primary))',
              short: '监', tone: e.verdict === 'halt' ? 'warn' : undefined,
              text: `【监工】${label}${e.trend ? ` · ${e.trend}` : ''}${e.issues.length ? `\n${e.issues.map((s) => `· ${s}`).join('\n')}` : ''}`,
            });
          }
          if (e.verdict === 'halt') {
            dispatchToastEvent({ type: 'error', message: `第 ${e.order} 章监工判定需停下：长跑已暂停，请处理后再继续`, duration: 10000 });
          }
        } else if (e.type === 'track_review') {
          const label = e.verdict === 'on_track' ? '在轨' : e.verdict === 'major_drift' ? '明显跑偏' : '小幅偏离';
          onTurn?.({
            from: 'plot-designer', name: `轨迹确认（第 ${e.from}–${e.to} 章）`,
            color: e.verdict === 'major_drift' ? 'hsl(var(--state-blocked))' : 'hsl(var(--primary))',
            short: '轨', tone: e.verdict === 'major_drift' ? 'warn' : 'ok',
            text: `【轨迹确认】${label}${e.note ? `：${e.note}` : ''}`,
          });
          dispatchToastEvent({
            type: e.verdict === 'major_drift' ? 'error' : 'info',
            message: e.verdict === 'major_drift'
              ? `第 ${e.from}–${e.to} 章明显跑偏：流水线已暂停，请阅读报告后决策`
              : `轨迹确认（第 ${e.from}–${e.to} 章）：${label}`,
            duration: e.verdict === 'major_drift' ? 12000 : 5000,
          });
        } else if (e.type === 'stage_auto_approved') {
          onTurn?.({
            from: 'system', name: '偏离核查', color: 'hsl(var(--primary))', short: '查',
            text: `核查完成（无需确认，自动进入下一段）：${e.summary}`, tone: 'ok',
          });
        } else if (e.type === 'stage_drift_blocked') {
          // ★ 硬偏离：这是偏离核查唯一会拦人的地方，必须显眼
          dispatchToastEvent({ type: 'error', message: e.message, duration: 10000 });
          onTurn?.({
            from: 'system', name: '偏离核查', color: 'hsl(var(--state-blocked))', short: '!',
            text: `⚠️ ${e.message}\n硬偏离 ${e.hard} 条 · 软偏离 ${e.soft} 条（详见《偏离报告》）`,
            tone: 'warn',
          });
        } else if (e.type === 'awaiting_user') {
          setPhase('');
          dispatchToastEvent({ type: 'info', message: '这一段写完了，等你确认', duration: 4000 });
        } else if (e.type === 'stage_skipped') {
          onTurn?.({ from: 'system', name: '流水线', color: 'hsl(var(--primary))', short: '·', text: e.reason });
        } else if (e.type === 'baseline_changed') {
          dispatchToastEvent({
            type: 'info',
            message: `开书设定变了：${e.stale.length} 个已定稿阶段被标记为过期（从这一段起重跑）`,
            duration: 6000,
          });
        } else if (e.type === 'stage_failed') {
          dispatchToastEvent({ type: 'error', message: e.message, duration: 8000 });
          onTurn?.({ from: 'system', name: '流水线', color: 'hsl(var(--state-blocked))', short: '!', text: e.message, tone: 'warn' });
        } else if (e.type === 'error') {
          dispatchToastEvent({ type: 'error', message: e.message, duration: 8000 });
        }
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatchToastEvent({ type: 'error', message: msg, duration: 8000 });
        onTurn?.({ from: 'system', name: '流水线', color: 'hsl(var(--state-blocked))', short: '!', text: msg, tone: 'warn' });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setPhase('');
      await refresh();
    }
  }, [projectId, busy, onTurn, refresh]);

  const handleDecide = useCallback(async (stage: StageKey, action: DecisionAction) => {
    if (!projectId || busy) return;
    if (action === 'revise' && !note.trim()) {
      dispatchToastEvent({ type: 'error', message: '打回要写批注：告诉它哪里不对，否则重跑只是原样再来一遍' });
      return;
    }
    setBusy(true);
    try {
      const r = await decidePipeline(stage, action, note.trim() || undefined);
      setNote('');
      setStatus((s) => (s ? { ...s, view: r.view } : s));
      if (action === 'approve') {
        const st = r.stats;
        if (st) {
          const parts = [
            st.characters.created ? `角色 +${st.characters.created}` : '',
            st.characters.updated ? `角色补全 ${st.characters.updated}` : '',
            st.outline ? `大纲/设定 +${st.outline}` : '',
            st.foreshadows ? `伏笔 +${st.foreshadows}` : '',
            st.skipped ? `跳过 ${st.skipped}` : '',
          ].filter(Boolean).join(' · ');
          dispatchToastEvent({ type: 'success', message: parts ? `已定稿并落库：${parts}` : '已定稿', duration: 5000 });
          for (const n of st.notes) {
            dispatchToastEvent({ type: 'warning', message: n, duration: 8000 });
          }
          onProjectDataChanged?.();
        } else {
          dispatchToastEvent({ type: 'success', message: '已通过' });
        }
      } else if (action === 'reject') {
        dispatchToastEvent({ type: 'info', message: `已退回上一段${r.invalidated.length ? `，作废 ${r.invalidated.length} 段产出` : ''}` });
      } else {
        dispatchToastEvent({ type: 'info', message: '已打回，本段会带着你的批注重跑' });
        if (r.hitRevisionLimit) {
          dispatchToastEvent({
            type: 'warning',
            message: `这一段已经打回 ${r.revisionLimit} 次了 —— 要么按现在这版通过，要么从更早的阶段重开`,
            duration: 9000,
          });
        }
      }
    } catch (e) {
      dispatchToastEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      /**
       * ★ 失败也要刷新状态。
       *
       * 实测（GUI 全流程）：批准动作在服务端是**同步跑一次模型抽取**（把契约落库），
       * 超过客户端 8 秒超时后前端报「请求超时」，而**服务端其实已经批准完了** ——
       * 界面却停在上一步，"跑世界圣经"的按钮永远不出现，看起来像卡死。
       * 只调大超时还不够：真超时/断线时同样会留下"服务端已前进、界面没动"的鬼状态，
       * 所以这里无条件回读一次服务端真相。
       */
      void refresh();
    }
  }, [projectId, busy, note, onProjectDataChanged, refresh]);

  const getNodeColor = useCallback((node: Node) => {
    const d = node.data as unknown as StageNodeData;
    return statusInk(d.status);
  }, []);

  if (!projectId) {
    return (
      <div className="p-6 text-[12px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
        未加载项目 —— 设定流水线需要一个项目上下文。
      </div>
    );
  }

  const approvedCount = view?.stages.filter((s) => s.status === 'approved').length ?? 0;
  const staleCount = view?.staleStages.length ?? 0;

  // 图例：阶段状态五态 + 三个徽标含义
  const legend = (
    <>
      {([
        ['approved', '已定稿'],
        ['awaiting_user', '等确认'],
        ['running', '进行中'],
        ['idle', '未开始'],
        ['failed', '失败'],
      ] as Array<[StageVisualStatus, string]>).map(([st, label]) => (
        <span key={st} className="flex items-center gap-1.5">
          <span className="rounded-full" style={{ width: 7, height: 7, background: statusInk(st) }} aria-hidden="true" />
          <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</span>
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>◈ 闸门</span>
        <span className="text-[11px]" style={{ color: 'hsl(var(--state-blocked))' }}>过期</span>
        <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>×N 打回</span>
      </span>
    </>
  );

  // ---- 侧栏：当前段的产出 + 闸门决策 + 台账 ----
  const detail = (
    <>
      {loading && (
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Loader2 size={11} className="animate-spin" /> 读取状态…
        </div>
      )}

      {view && current && (
        <>
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-full" style={{ width: 7, height: 7, background: statusInk(current.status as StageVisualStatus) }} aria-hidden="true" />
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 13, fontWeight: 600, color: 'hsl(var(--ink))' }}>
                {current.label || STAGE_LABEL_UI[current.key] || current.key}
              </span>
              {current.gated && (
                <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }} title="这一段跑完会停下等你确认">
                  ◈ 闸门
                </span>
              )}
            </div>
            {STAGE_ARTIFACT[current.key] && (
              <div className="text-[10.5px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                产出《{STAGE_ARTIFACT[current.key]}》
              </div>
            )}
          </div>

          {current.artifact && (
            <div
              className="rounded-lg px-2.5 py-2 text-[11px] leading-[1.75] whitespace-pre-wrap"
              style={{
                background: 'hsl(var(--card) / 0.6)',
                border: '0.5px solid hsl(var(--border) / 0.6)',
                color: 'hsl(var(--ink-light))',
                maxHeight: 200,
                overflowY: 'auto',
              }}
            >
              {current.artifact}
            </div>
          )}

          {current.status === 'failed' && current.error && (
            <div className="text-[11px] leading-[1.7]" style={{ color: 'hsl(var(--destructive))' }}>
              {current.error}
            </div>
          )}

          {current.status === 'awaiting_user' ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="要打回就写清楚哪里不对（打回必须写）；通过可以不填"
                className="w-full resize-none rounded-lg px-2.5 py-2 text-[11px] leading-[1.6] outline-none"
                style={{ background: 'hsl(var(--card) / 0.6)', border: '0.5px solid hsl(var(--border) / 0.8)', color: 'hsl(var(--foreground))' }}
              />
              <button
                type="button"
                onClick={() => void handleDecide(current.key, 'approve')}
                disabled={busy}
                className="inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-40"
                style={{ padding: '6px 12px', fontSize: 12, background: 'hsl(var(--state-done))', color: 'hsl(var(--card))', border: 'none', cursor: 'pointer' }}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                通过并落库
              </button>
              <button
                type="button"
                onClick={() => void handleDecide(current.key, 'revise')}
                disabled={busy || !note.trim()}
                title={note.trim() ? '带着批注重跑这一段' : '先写批注'}
                className="inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-40"
                style={{ padding: '6px 12px', fontSize: 12, background: 'transparent', color: 'hsl(var(--primary))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--primary) / 0.5)', cursor: 'pointer' }}
              >
                <X size={12} />
                打回重跑
              </button>
              <button
                type="button"
                onClick={() => void handleDecide(current.key, 'reject')}
                disabled={busy}
                title="方向就错了：退回上一段重立（本段与更晚的产出作废）"
                className="rounded-md disabled:opacity-40"
                style={{ padding: '6px 12px', fontSize: 12, background: 'transparent', color: 'hsl(var(--destructive))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--destructive) / 0.5)', cursor: 'pointer' }}
              >
                退回上一段
              </button>
              {current.revision > 0 && (
                <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  已打回 {current.revision} 次
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => void handleRun(current.key)}
                disabled={busy || !current.implemented}
                title={current.implemented ? `跑这一段（${COST_PER_STAGE}）` : '这一段尚未实现'}
                className="inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-40"
                style={{ padding: '6px 12px', fontSize: 12, background: 'hsl(var(--primary) / 0.92)', color: 'hsl(var(--card))', border: 'none', cursor: 'pointer' }}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                {current.status === 'failed' ? '重试这一段' : `跑「${current.label}」`}
              </button>
              {!current.implemented && (
                <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  这一段（{current.label}）尚未实现
                </span>
              )}
              {busy && phase && (
                <span className="text-[11px]" style={{ color: 'hsl(var(--primary))' }}>{phase}</span>
              )}
              {!busy && current.implemented && (
                <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{COST_PER_STAGE}</span>
              )}
            </div>
          )}

          {busy && !longRunning && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="self-start rounded-md text-[11px] px-2 py-0.5"
              style={{ color: 'hsl(var(--destructive))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--destructive) / 0.4)', background: 'transparent', cursor: 'pointer' }}
            >
              停止
            </button>
          )}

          {/* ★ 长跑控件：只在 production 段出现（见 handleLongRun 顶部注释） */}
          {current.key === 'production' && (
            <div
              className="flex flex-col gap-1.5 rounded-lg px-2.5 py-2"
              style={{ background: 'hsl(var(--primary) / 0.06)', border: '0.5px solid hsl(var(--primary) / 0.25)' }}
            >
              <span className="text-[11px] font-medium" style={{ color: 'hsl(var(--primary))' }}>
                长跑：一次授权，一直往下写
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>写到第</span>
                <input
                  type="number"
                  min={1}
                  value={longRunTarget}
                  onChange={(e) => setLongRunTarget(Math.max(1, Number(e.target.value) || 1))}
                  disabled={longRunning}
                  className="rounded-md text-[11px] outline-none"
                  style={{ width: 68, padding: '3px 6px', background: 'rgb(var(--glass-tint) / 0.5)', border: '0.5px solid hsl(var(--border) / 0.7)', color: 'hsl(var(--foreground))' }}
                />
                <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>章（当前已写 {view?.lastDelivered ?? 0} 章）</span>
                <button
                  type="button"
                  onClick={() => void handleLongRun()}
                  disabled={longRunning || busy}
                  className="inline-flex items-center gap-1 rounded-full disabled:opacity-40"
                  style={{ padding: '5px 14px', fontSize: 12, background: 'hsl(var(--primary) / 0.92)', color: '#fff', border: 'none', cursor: 'pointer' }}
                >
                  {longRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  {longRunning ? '长跑中…' : '开始长跑'}
                </button>
                {longRunning && (
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="rounded-full text-[11px] px-2.5 py-0.5"
                    style={{ color: 'hsl(var(--destructive))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--destructive) / 0.4)', background: 'transparent', cursor: 'pointer' }}
                  >
                    停止
                  </button>
                )}
              </div>
              {longRunMsg && (
                <span className="text-[11px]" style={{ color: 'hsl(var(--primary))' }}>{longRunMsg}</span>
              )}
              <span className="text-[10.5px] leading-[1.6]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                每批 5 章，批间自动确认；监工判「需停下」或轨迹明显跑偏时会停（避免带病往下写）。可随时「停止」，进度会存下，再点接着跑。
              </span>
            </div>
          )}
        </>
      )}

      {/* 最近决策台账：谁在什么时候批了什么、批注是什么 */}
      {view && view.decisions.length > 0 && (
        <div className="flex flex-col gap-1 pt-2" style={{ borderTop: '0.5px solid hsl(var(--border) / 0.5)' }}>
          <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))', letterSpacing: '0.08em' }}>
            最近决策
          </span>
          {(view.decisions ?? []).slice(0, 6).map((d, i) => (
            <div
              key={`${d.at}-${i}`}
              className="flex items-baseline gap-1.5 text-[11px] min-w-0"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              <span className="shrink-0" style={{ color: ACTION_COLOR[d.action] }}>{ACTION_TEXT[d.action]}</span>
              <span className="shrink-0" style={{ color: 'hsl(var(--foreground) / 0.78)' }}>
                {view.stages.find((s) => s.key === d.stage)?.label ?? d.stage}
              </span>
              <span className="shrink-0" style={{ opacity: 0.7 }}>{fmtDecisionTime(d.at)}</span>
              {d.note && <span className="truncate" title={d.note} style={{ opacity: 0.85 }}>· {d.note}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 轨迹确认台账（长跑每 N 章一条）—— 回放用：哪几章确认过、判定是什么、补丁是什么 */}
      {view && (view.tracks?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-1 pt-2" style={{ borderTop: '0.5px solid hsl(var(--border) / 0.5)' }}>
          <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))', letterSpacing: '0.08em' }}>
            轨迹确认
          </span>
          {(view.tracks ?? []).slice(0, 4).map((t, i) => {
            const color = t.verdict === 'major_drift' ? 'hsl(var(--state-blocked))'
              : t.verdict === 'minor_drift' ? 'hsl(var(--primary))' : 'hsl(var(--state-done))';
            const label = t.verdict === 'on_track' ? '在轨' : t.verdict === 'minor_drift' ? '小幅偏离' : '明显跑偏';
            return (
              <div key={`${t.at}-${i}`} className="flex items-baseline gap-1.5 text-[11px] min-w-0" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <span className="shrink-0" style={{ color }}>{label}</span>
                <span className="shrink-0" style={{ color: 'hsl(var(--foreground) / 0.78)' }}>第 {t.from}–{t.to} 章</span>
                <span className="shrink-0" style={{ opacity: 0.7 }}>{fmtDecisionTime(t.at)}</span>
                {t.note && <span className="truncate" title={t.note} style={{ opacity: 0.85 }}>· {t.note}</span>}
              </div>
            );
          })}
        </div>
      )}

      {!view && !loading && (
        <div className="text-[11px] leading-[1.7]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          还没有流水线状态 —— 先「开始立设定」。
        </div>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col gap-3">
      {/* 顶部条：没有开书设定 / 未启动 时才出现（有状态时让位给图谱） */}
      {!hasBrief && (
        <div
          className="rounded-lg px-3 py-2 text-[11px] leading-[1.7] shrink-0"
          style={{ background: 'hsl(var(--destructive) / 0.08)', border: '0.5px solid hsl(var(--destructive) / 0.3)', color: 'hsl(var(--destructive))' }}
        >
          <AlertTriangle size={11} className="inline mr-1" aria-hidden="true" />
          这本书还没有开书设定（书名 / 开局 / 世界观 / 笔风 / 主角 / 女主 / 流派）。
          去书架的「编辑书籍」里补全后，这里才立得起来 —— 流水线的起点就是它。
        </div>
      )}

      {!started && hasBrief && (
        <div
          className="rounded-lg px-3 py-2.5 shrink-0 flex items-end gap-2"
          style={{ background: 'hsl(var(--card) / 0.6)', border: '0.5px solid hsl(var(--border) / 0.6)' }}
        >
          <div className="flex-1 min-w-0">
            <p className="text-[11px] leading-[1.7] mb-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
              从开书设定出发，依次立起：角色与节奏 → 世界观与势力 → 剧情总纲。
              每段都会停下等你确认，确认后才落库、才进下一段。
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>（{COST_TOTAL}）</span>
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="有什么要额外交代的？（可留空）例如：不要太慢热；女主别写成工具人"
              className="w-full resize-none rounded-lg px-2.5 py-2 text-[11px] leading-[1.6] outline-none"
              style={{ background: 'hsl(var(--card) / 0.7)', border: '0.5px solid hsl(var(--border) / 0.8)', color: 'hsl(var(--foreground))' }}
            />
          </div>
          <button
            type="button"
            onClick={handleStart}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1 rounded-md disabled:opacity-40"
            style={{ padding: '6px 14px', fontSize: 12, background: 'hsl(var(--primary) / 0.92)', color: 'hsl(var(--card))', border: 'none', cursor: 'pointer' }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            开始立设定
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 inline-flex items-center gap-1 rounded-md text-[11px]"
            style={{ padding: '6px 10px', background: 'transparent', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--border) / 0.8)', color: 'hsl(var(--muted-foreground))', cursor: 'pointer' }}
            aria-label="重新读取流水线状态"
          >
            <RefreshCw size={11} /> 重新读取
          </button>
        </div>
      )}

      {/* ★ 2026-10-22（U4 修复）：未启动时**不再渲染图谱**。
          原先上方的「开始立设定」卡片已经把「怎么开始」说清楚了，
          图谱区又给一次「暂无数据 / 流水线状态还没建立 —— 用上方的『开始立设定』……」，
          同一屏里同一个动作被说两遍，观感上是重复噪声。
          起始卡片本身就是这一屏的全部内容，图谱等有了流水线状态再出现。 */}
      {(started || view !== null) && (
        <div className="flex-1 min-h-0">
          <GraphShell
            title="设定流水线"
            countText={
              `${approvedCount} / ${view?.stages.length ?? 7} 段已定稿`
              + (staleCount > 0 ? ` · ${staleCount} 段过期` : '')
            }
            emptyHint="流水线状态还没建立 —— 用上方的「开始立设定」从开书信息起步。"
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            defaultEdgeOptions={{ type: 'default' }}
            getNodeColor={getNodeColor}
            legend={legend}
            detail={detail}
            exportFileNamePrefix="pipeline-graph"
          />
        </div>
      )}
    </div>
  );
}
