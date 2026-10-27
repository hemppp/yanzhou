// ============================================================
// ⚠️ 已停用（2026-09-15）—— 不要再往这里加功能
//
// AI 写作工作台的「流水线」看板已换成图谱版：`PipelineGraphPanel.tsx`
// （作者要求把工作台的详细内容全面图谱化）。本文件的列表式 UI 不再被任何组件挂载，
// 只有 `__tests__/PipelinePanel.test.tsx` 还在跑它。
//
// 是否物理删除**待拍板**（与批次流水线死代码同一处理原则：先标注、不擅自删）。
// 若将来要恢复列表版，注意 `PipelineGraphPanel` 是它的**功能超集**，
// 且那份 SSE 事件处理逻辑是从这里整段沿用的 —— 改一处务必两处对齐。
// ============================================================
//
// PipelinePanel —— 多智能体协作流水线的进度与闸门
//
// 位置：AI 写作工作台的中栏（正文方块上方）。设计见
// docs/architecture/ai-writing-multiagent-pipeline.md。
//
// 它只做三件事：
//   1. 显示 7 个阶段走到哪了（含"已批准但基线已变"的过期提醒）
//   2. 跑当前那一段（SSE，发言会转发到左栏交流流）
//   3. 到闸门时给出三态决策：通过 / 带批注打回 / 退回上一段
//
// ★ 拿不到开书设定就不让启动（后端也会拦，这里提前告诉作者去哪儿补）——
//   没有它立出来的设定会凭空长出来。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, Play, Loader2, Check, X } from 'lucide-react';
import {
  fetchPipeline, startPipeline, decidePipeline, runPipelineStage,
  type DecisionAction, type PipelineStageView, type PipelineStatus, type PipelineView, type StageKey,
} from './services/pipelineSession';
import { dispatchToastEvent } from '@novel-plugins/ui-kit/errors';

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

interface PipelinePanelProps {
  projectId: string | null;
  /** 阶段落库后刷新宿主 store（与 entity-sink 的刷新同一条规矩：用宿主已有的实例） */
  onProjectDataChanged?: () => void;
  /** 把发言推进工作台的交流流 */
  onTurn?: (t: PipelineTurn) => void;
  /** 有没有已交付章节：有则默认收起（那时作者的注意力在正文上） */
  hasChapters?: boolean;
  /**
   * 状态变更上报（宿主用它算气泡徽标「n/7」）。
   * 为什么要回调而不是让气泡自己再拉一次：两个地方各请求一次 = 双倍请求 + 状态可能不一致。
   */
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

const STATUS_DOT: Record<PipelineStageView['status'], string> = {
  approved: 'hsl(var(--state-done))',

  awaiting_user: 'hsl(var(--primary))',
  running: 'hsl(var(--state-running))',
  failed: 'hsl(var(--destructive))',
  idle: 'hsl(var(--muted-foreground) / 0.45)',
};

const STATUS_TEXT: Record<PipelineStageView['status'], string> = {
  approved: '已定稿',
  awaiting_user: '等确认',
  running: '进行中',
  failed: '失败',
  idle: '未开始',
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

export function PipelinePanel({ projectId, onProjectDataChanged, onTurn, hasChapters, onStatus }: PipelinePanelProps) {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(!hasChapters);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      setStatus(await fetchPipeline());
    } catch (e) {
      // 未启动/无项目都会走到这里，不弹 toast（避免每次挂载都吵一次）
      console.warn('[PipelinePanel] 读取流水线状态失败:', e);
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

  // 有章节了默认收起（只在首次拿到数据时决定，之后尊重用户的手动展开/收起）
  const decidedRef = useRef(false);
  useEffect(() => {
    if (decidedRef.current || !status) return;
    decidedRef.current = true;
    setExpanded(!hasChapters);
  }, [status, hasChapters]);

  const view = status?.view ?? null;
  const current: PipelineStageView | null = view?.stages.find((s) => s.key === view.stage) ?? null;

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
   * ★ 2026-10-16 新增：**界面上的长跑**。
   *
   * 此前面板只有「跑这一段」一个按钮，长跑（production）点一次只写一批（5 章），
   * 想写 100 章就得点 20 次、还要每次过闸门 —— 界面等于跑不完一部长篇（实测踩到：
   * 用 GUI 走流程只能走到"前三章试写"，长跑那截必须切到接口脚本）。
   *
   * 这里补一个「长跑写到 N 章」：按批循环推进，直到全书已交付章数 ≥ N；每批结束
   * 自动 approve（这是"授权长跑"的意思，作者点一次就不用一直盯）；到目标或遇错就停。
   * 进度实时显示（当前第几章 / 目标 / 本批新增）。
   */
  const [longRunTarget, setLongRunTarget] = useState(20);
  const [longRunMsg, setLongRunMsg] = useState('');
  const [longRunning, setLongRunning] = useState(false);

  const handleLongRun = useCallback(async () => {
    if (!projectId || longRunning) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setLongRunning(true);
    setExpanded(true);
    try {
      let guard = 0;
      for (;;) {
        guard++;
        if (guard > 400) { setLongRunMsg('已达安全上限（400 批），停下'); break; }
        // 先读一次：全书写到第几章了？到目标就停。
        const st = await fetchPipeline();
        const delivered = st.view?.lastDelivered ?? 0;
        setStatus(st);
        setLongRunMsg(`已写 ${delivered} 章 / 目标 ${longRunTarget} 章 …`);
        if (delivered >= longRunTarget) { setLongRunMsg(`✅ 已达目标：${delivered} 章`); break; }

        // 停在闸门？先批（长跑闸门是"每批一停"，授权后自动过；监工判需修正不再打断）
        const prod = st.view?.stages.find((s) => s.key === 'production');
        if (prod?.status === 'awaiting_user') {
          await decidePipeline('production', 'approve');
          continue;
        }

        // 推一批
        setPhase('长跑写一批（5 章）…');
        await runPipelineStage('production', { signal: ac.signal }, (e) => {
          if (e.type === 'stage_phase') setPhase(e.label);
          else if (e.type === 'production_chapter' && e.phase === 'done') {
            setLongRunMsg(`第 ${e.order} 章 ${e.delivered ? `已交付（${e.wordCount ?? 0} 字）` : '未交付'} …`);
          } else if (e.type === 'supervise_report') {
            setLongRunMsg(`监工第 ${e.order} 章：${e.verdict}（问题 ${e.issues?.length ?? 0}）`);
          } else if (e.type === 'track_review') {
            onTurn?.({
              from: 'system', name: '《轨迹确认》', color: 'hsl(var(--primary))', short: '轨',
              text: `轨迹确认：${e.verdict}${e.note ? `\n${e.note}` : ''}`, tone: e.verdict === 'major_drift' ? 'warn' : 'ok',
            });
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
  }, [projectId, longRunTarget, longRunning, onTurn, refresh]);

  const handleRun = useCallback(async (stage: StageKey) => {
    if (!projectId || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setPhase('正在召集智能体…');
    setExpanded(true);
    try {
      await runPipelineStage(stage, { signal: ac.signal }, (e) => {
        if (e.type === 'stage_phase') setPhase(e.label);
        else if (e.type === 'stage_turn') {
          onTurn?.({
            from: e.agent, name: e.name, color: e.color, short: e.short, text: e.text, meta: e.meta,
          });
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
        } else if (e.type === 'stage_auto_approved') {
          // 无闸门阶段（drift）：报告已出、自动过 —— 要说明"不用你点确认"，否则作者会等
          onTurn?.({
            from: 'system', name: '偏离核查', color: 'hsl(var(--primary))', short: '查',
            text: `核查完成（无需确认，自动进入下一段）：${e.summary}`, tone: 'ok',
          });
        } else if (e.type === 'stage_drift_blocked') {
          // ★ 硬偏离：这是偏离核查唯一会拦人的地方，必须显眼
          dispatchToastEvent({ type: 'error', message: e.message, duration: 10000 });
          onTurn?.({
            from: 'system', name: '偏离核查', color: 'hsl(var(--state-blocked))', short: '!',
            text: `⚠️ ${e.message}
硬偏离 ${e.hard} 条 · 软偏离 ${e.soft} 条（详见《偏离报告》）`,
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

  if (!projectId) return null;

  const started = status?.started ?? false;
  const hasBrief = status?.hasBrief ?? true;
  const staleSet = new Set(view?.staleStages ?? []);

  // ---- 收起态：一条窄条，别占正文的地方 ----
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="shrink-0 flex items-center gap-2 w-full text-left rounded-xl px-3"
        style={{
          height: 30,
          background: 'rgb(var(--glass-tint) / 0.3)',
          borderWidth: '0.5px',
          borderStyle: 'solid',
          borderColor: 'hsl(var(--border) / 0.5)',
          color: 'hsl(var(--muted-foreground))',
        }}
      >
        <ChevronRight size={13} />
        <span className="text-[10px]">设定流水线</span>
        {current && (
          <span className="text-[10px]" style={{ color: 'hsl(var(--foreground))' }}>
            {current.label}
            <span style={{ color: STATUS_DOT[current.status] }}> · {STATUS_TEXT[current.status]}</span>
          </span>
        )}
        {!started && <span className="text-[10px]">未启动</span>}
        {(view?.staleStages.length ?? 0) > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[10px]" style={{ color: 'hsl(var(--state-blocked))' }}>
            <AlertTriangle size={11} />
            设定已改，建议重跑
          </span>
        )}
      </button>
    );
  }

  return (
    <section
      className="shrink-0 flex flex-col overflow-hidden rounded-xl"
      style={{
        // 中栏已经挤了正文 + 数据面板，这里封顶并内部滚动，别把下面挤没
        maxHeight: 240,
        background: 'rgb(var(--glass-tint) / 0.34)',
        border: '0.5px solid hsl(var(--border) / 0.5)',
      }}
      aria-label="设定流水线"
    >
      <div
        className="shrink-0 flex items-center gap-2"
        style={{ height: 30, padding: '0 var(--space-4)', borderBottom: '0.5px solid hsl(var(--border) / 0.45)' }}
      >
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="收起流水线"
          style={{ color: 'hsl(var(--muted-foreground))', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
        >
          <ChevronDown size={13} />
        </button>
        <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))', letterSpacing: '0.06em' }}>
          设定流水线
        </span>
        {loading && <Loader2 size={11} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />}
        {view && (
          <span className="text-[10px] ml-auto" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {view.stages.filter((s) => s.status === 'approved').length} / {view.stages.length} 段已定稿
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* 没开书设定：先把话说清楚，别让作者点半天 */}
        {!hasBrief && (
          <div
            className="rounded-lg px-2.5 py-2 text-[10px] leading-[1.7]"
            style={{ background: 'hsl(var(--destructive) / 0.08)', border: '0.5px solid hsl(var(--destructive) / 0.3)', color: 'hsl(var(--destructive))' }}
          >
            这本书还没有开书设定（书名 / 开局 / 世界观 / 笔风 / 主角 / 女主 / 流派）。
            去书架的「编辑书籍」里补全后，这里才立得起来 —— 流水线的起点就是它。
          </div>
        )}

        {/* 未启动 */}
        {!started && hasBrief && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] leading-[1.7]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              从开书设定出发，依次立起：角色与节奏 → 世界观与势力 → 剧情总纲。
              每段都会停下等你确认，确认后才落库、才进下一段。
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>（{COST_TOTAL}）</span>
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="有什么要额外交代的？（可留空）例如：不要太慢热；女主别写成工具人"
              className="w-full resize-none rounded-lg px-2.5 py-2 text-[10px] leading-[1.6] outline-none"
              style={{ background: 'rgb(var(--glass-tint) / 0.5)', border: '0.5px solid hsl(var(--border) / 0.7)', color: 'hsl(var(--foreground))' }}
            />
            <button
              type="button"
              onClick={handleStart}
              disabled={busy}
              className="self-start inline-flex items-center gap-1 rounded-full disabled:opacity-40"
              style={{ padding: 'var(--space-1) var(--space-5)', fontSize: 11, background: 'hsl(var(--primary) / 0.92)', color: '#fff', border: 'none', cursor: 'pointer' }}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              开始立设定
            </button>
          </div>
        )}

        {/* 阶段步进条 */}
        {view && (
          <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1">
            {view.stages.map((s) => {
              const isCurrent = s.key === view.stage;
              return (
                <span key={s.key} className="flex items-center gap-1" title={`${s.label} · ${STATUS_TEXT[s.status]}${s.gated ? '（有确认闸门）' : ''}`}>
                  <span
                    className="rounded-full"
                    style={{
                      width: isCurrent ? 9 : 7,
                      height: isCurrent ? 9 : 7,
                      background: STATUS_DOT[s.status],
                      boxShadow: isCurrent ? `0 0 0 3px ${STATUS_DOT[s.status].replace(')', ' / 0.18)')}` : undefined,
                    }}
                    aria-hidden="true"
                  />
                  <span
                    className="text-[10px]"
                    style={{
                      color: isCurrent ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                      fontWeight: isCurrent ? 500 : 400,
                    }}
                  >
                    {s.label}
                    {staleSet.has(s.key) && (
                      <span style={{ color: 'hsl(var(--state-blocked))' }}> ·过期</span>
                    )}
                    {s.revision > 0 && (
                      <span style={{ color: 'hsl(var(--muted-foreground))' }}> ×{s.revision}</span>
                    )}
                  </span>
                </span>
              );
            })}
          </div>
        )}

        {/* 当前段的产出 + 闸门 */}
        {view && current && (
          <>
            {current.artifact && (
              <div
                className="rounded-lg px-2.5 py-2 text-[10px] leading-[1.75] whitespace-pre-wrap"
                style={{
                  background: 'hsl(var(--card) / 0.55)',
                  border: '0.5px solid hsl(var(--border) / 0.5)',
                  color: 'hsl(var(--ink-light))',
                  maxHeight: 150,
                  overflowY: 'auto',
                }}
              >
                {current.artifact}
              </div>
            )}

            {current.status === 'failed' && current.error && (
              <div className="text-[10px] leading-[1.7]" style={{ color: 'hsl(var(--destructive))' }}>
                {current.error}
              </div>
            )}

            {current.status === 'awaiting_user' ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="要打回就写清楚哪里不对（打回必须写）；通过可以不填"
                  className="w-full resize-none rounded-lg px-2.5 py-2 text-[10px] leading-[1.6] outline-none"
                  style={{ background: 'rgb(var(--glass-tint) / 0.5)', border: '0.5px solid hsl(var(--border) / 0.7)', color: 'hsl(var(--foreground))' }}
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => void handleDecide(current.key, 'approve')}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-full disabled:opacity-40"
                    style={{ padding: 'var(--space-1) var(--space-5)', fontSize: 11, background: 'hsl(var(--state-done))', color: '#fff', border: 'none', cursor: 'pointer' }}
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    通过并落库
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecide(current.key, 'revise')}
                    disabled={busy || !note.trim()}
                    title={note.trim() ? '带着批注重跑这一段' : '先写批注'}
                    className="inline-flex items-center gap-1 rounded-full disabled:opacity-40"
                    style={{ padding: 'var(--space-1) var(--space-5)', fontSize: 11, background: 'hsl(var(--primary) / 0.14)', color: 'hsl(var(--primary))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--primary) / 0.4)', cursor: 'pointer' }}
                  >
                    <X size={12} />
                    打回重跑
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecide(current.key, 'reject')}
                    disabled={busy}
                    title="方向就错了：退回上一段重立（本段与更晚的产出作废）"
                    className="rounded-full disabled:opacity-40"
                    style={{ padding: 'var(--space-1) var(--space-5)', fontSize: 11, background: 'transparent', color: 'hsl(var(--destructive))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--destructive) / 0.4)', cursor: 'pointer' }}
                  >
                    退回上一段
                  </button>
                  {current.revision > 0 && (
                    <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      已打回 {current.revision} 次
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleRun(current.key)}
                  disabled={busy || !current.implemented}
                  title={current.implemented ? `跑这一段（${COST_PER_STAGE}）` : '这一段在 M2/M3 才实现'}
                  className="inline-flex items-center gap-1 rounded-full disabled:opacity-40"
                  style={{ padding: 'var(--space-1) var(--space-5)', fontSize: 11, background: 'hsl(var(--primary) / 0.92)', color: '#fff', border: 'none', cursor: 'pointer' }}
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  {current.status === 'failed' ? '重试这一段' : `跑「${current.label}」`}
                </button>
                {!current.implemented && (
                  <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    这一段（{current.label}）尚未实现
                  </span>
                )}
                {busy && phase && (
                  <span className="text-[10px]" style={{ color: 'hsl(var(--primary))' }}>{phase}</span>
                )}
                {!busy && current.implemented && (
                  <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {COST_PER_STAGE}
                  </span>
                )}
              </div>
            )}

            {busy && (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="self-start rounded-md text-[10px] px-2 py-0.5"
                style={{ color: 'hsl(var(--destructive))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--destructive) / 0.4)', background: 'transparent', cursor: 'pointer' }}
              >
                停止
              </button>
            )}

            {/* ★ 长跑控件：只在 production 段出现。
                没有它，界面点一次只写一批（5 章），写一部长篇要点几十次 —— 等于界面跑不完。 */}
            {current.key === 'production' && (
              <div
                className="flex flex-col gap-1.5 rounded-lg px-2.5 py-2"
                style={{ background: 'hsl(var(--primary) / 0.06)', border: '0.5px solid hsl(var(--primary) / 0.25)' }}
              >
                <span className="text-[10px] font-medium" style={{ color: 'hsl(var(--primary))' }}>
                  长跑：一次授权，一直往下写
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>写到第</span>
                  <input
                    type="number"
                    min={1}
                    value={longRunTarget}
                    onChange={(e) => setLongRunTarget(Math.max(1, Number(e.target.value) || 1))}
                    disabled={longRunning}
                    className="rounded-md text-[10px] outline-none"
                    style={{ width: 68, padding: 'var(--space-0) var(--space-2)', background: 'rgb(var(--glass-tint) / 0.5)', border: '0.5px solid hsl(var(--border) / 0.7)', color: 'hsl(var(--foreground))' }}
                  />
                  <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>章（当前已写 {view?.lastDelivered ?? 0} 章）</span>
                  <button
                    type="button"
                    onClick={() => void handleLongRun()}
                    disabled={longRunning || busy}
                    className="inline-flex items-center gap-1 rounded-full disabled:opacity-40"
                    style={{ padding: 'var(--space-1) var(--space-5)', fontSize: 11, background: 'hsl(var(--primary) / 0.92)', color: '#fff', border: 'none', cursor: 'pointer' }}
                  >
                    {longRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    {longRunning ? '长跑中…' : '开始长跑'}
                  </button>
                  {longRunning && (
                    <button
                      type="button"
                      onClick={() => abortRef.current?.abort()}
                      className="rounded-full text-[10px] px-2.5 py-0.5"
                      style={{ color: 'hsl(var(--destructive))', borderWidth: '0.5px', borderStyle: 'solid', borderColor: 'hsl(var(--destructive) / 0.4)', background: 'transparent', cursor: 'pointer' }}
                    >
                      停止
                    </button>
                  )}
                </div>
                {longRunMsg && (
                  <span className="text-[10px]" style={{ color: 'hsl(var(--primary))' }}>{longRunMsg}</span>
                )}
                <span className="text-[10px] leading-[1.6]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  每批 5 章，批间自动确认；监工判「需修正」时会取轨迹补丁继续写、不打断。可随时「停止」，进度会存下，再点接着跑。
                </span>
              </div>
            )}

            {/* 最近决策台账：谁在什么时候批了什么、批注是什么。
                数据来自 GET /pipeline/ledger（后端一直在写），这里只是把它显示出来 */}
            {view.decisions.length > 0 && (
              <div
                className="flex flex-col gap-1 pt-1.5"
                style={{ borderTop: '0.5px solid hsl(var(--border) / 0.4)' }}
              >
                <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))', letterSpacing: '0.08em' }}>
                  最近决策
                </span>
                {(view.decisions ?? []).slice(0, 4).map((d, i) => (
                  <div
                    key={`${d.at}-${i}`}
                    className="flex items-baseline gap-1.5 text-[10px] min-w-0"
                    style={{ color: 'hsl(var(--muted-foreground))' }}
                  >
                    <span className="shrink-0" style={{ color: ACTION_COLOR[d.action] }}>{ACTION_TEXT[d.action]}</span>
                    <span className="shrink-0" style={{ color: 'hsl(var(--foreground) / 0.78)' }}>
                      {view.stages.find((s) => s.key === d.stage)?.label ?? d.stage}
                    </span>
                    <span className="shrink-0" style={{ opacity: 0.7 }}>{fmtDecisionTime(d.at)}</span>
                    {d.note && (
                      <span className="truncate" title={d.note} style={{ opacity: 0.85 }}>· {d.note}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
