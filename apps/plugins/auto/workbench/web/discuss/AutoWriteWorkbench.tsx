// ============================================================
// AutoWriteWorkbench — AI 写作模式（project.mode === 'auto'）的固定工作台
//
// 与手写框架**完全互斥**：不渲染罗盘气泡，也不挂载任何手写面板
// （角色/地点/物品/伏笔/地图/关系图/统计/笔记都不出现）。
//
// 布局（三栏常驻，正文不再用 tab 切换）：
//   ┌────────────┬──────────────────────┬─────────────┐
//   │ 左：对话     │  中：世界状态仪表盘    │  右：正文    │
//   │  交流流      │   计划 / 变动 / 伏笔   │  宣纸信笺    │
//   │  输入框      │   物品 / 角色 / 地点   │             │
//   ├────────────┴──────────────────────┴─────────────┤
//   │ 底：花名册 + 会话状态                            │
//   └──────────────────────────────────────────────────┘
//   左右两栏均可拖分隔条调宽窄，也可各自整栏收起。
//
// 「运行过程时间线」不再单独做 —— 交流流本身按时间有序，它就是时间线。
//
// 当前交付：三栏布局 + 双分隔条 + **编排器已接入** ——
//   左栏发送即走 `auto-write` 技能 + 工具调用（novelChatStream），
//   SSE 流被翻译成交流流：文本 chunk 落进「当前发言者」的气泡；
//   工具调用按 TOOL_AGENT 切换发言者，并把动作与结果挂在该气泡的 meta 上。
// 待接入：正文流式落点（右栏）、按台账回放历史运行过程。
// ============================================================

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Send, Sparkles,
  ChevronDown, BookOpen, BrainCircuit, ChevronUp, ArrowLeft,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import type { Project } from '@novel/shared';
import { useChapterStore, useCharacterStore, useItemStore, useLocationStore, useForeshadowStore } from '@novel-plugins/data-core/stores';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { StageKey, StageState } from '../pipeline/WorkbenchPlan';
// 只留类型：面板本体一律惰性加载（见 plugin/autoBuiltin.ts 的 lazy 块）
import type { PipelineTurn } from '../pipeline/PipelineGraphPanel';
import { BubbleRail, type PanelSignal } from '../shell/BubbleRail';
import { ErrorBoundary } from '@novel-plugins/ui-kit';
import { TabBar } from '../shell/TabBar';
import { QuickOpen } from '../shell/QuickOpen';
import { fetchMemoryView, type MemoryView } from '../memory/services/memorySession';
import {
  BODY_MIN_WIDTH, BODY_PAD_X, EDITOR_BG, RAIL_WIDTH,
  type WorkbenchPanel,
} from '../pipeline/workspaceDefs';
import { runSession, type SessionEvent } from '../pipeline/services/autowriteSession';
import type { PipelineView } from '../pipeline/services/pipelineSession';
import { usePluginRegistry, useProjectMode, filterByProjectMode } from '@/plugin/registry';

/**
 * ★ 工作台面板（流水线 / 本章计划 / 实体与设定 / 记忆审计 / 技能库）已插件化：
 *   定义与惰性加载都在 `plugin/autoBuiltin.ts`（modes: ['auto']），
 *   apply 时注册进插件注册表；本组件只按 project.mode 过滤后消费。
 *
 *   仍然保持「四个图谱面板全部惰性加载」这条硬约束 —— 它们都直接或间接 import
 *   `GraphShell`，而 `GraphShell` 的静态 import 里列着 `vendor-three`（1,181 kB）
 *   与 `vendor-export`（94 kB，html-to-image）。只要有一个是静态 import，
 *   **进 AI 工作台就会白拉 1.18 MB 的 three.js**。所以面板本体一律 React.lazy，
 *   本组件（连同注册表条目）只持有 lazy 包装。
 */

/**
 * 底部花名册 —— 设计讨论层阵容，与后端 `discuss/roles.ts` 一一对应。
 * 配色走语义变量（`--agent-*`），不要写死色值 —— 否则换肤时这里不会跟着变。
 * 注意：交流流里每条发言的配色与头像字由后端 turn 事件自带（后端用的是同一套语义值）。
 */
const AGENTS: ReadonlyArray<{ key: string; name: string; short: string; desc: string; color: string }> = [
  { key: 'plot-designer', name: '剧情设计师', short: '剧', desc: '冲突 · 转折 · 钩子', color: 'hsl(var(--agent-plot))' },
  { key: 'character-designer', name: '角色设计师', short: '角', desc: '动机 · 状态 · 关系', color: 'hsl(var(--agent-character))' },
  { key: 'continuity-keeper', name: '设定管家', short: '设', desc: '查库 · 拦冲突 · 伏笔时机', color: 'hsl(var(--agent-continuity))' },
  { key: 'convener', name: '定稿官', short: '定', desc: '收敛本章结论', color: 'hsl(var(--agent-convener))' },
  { key: 'writer', name: '写作官', short: '写', desc: '只读结论写正文', color: 'hsl(var(--agent-writer))' },
];

// 注：早期版本在前端用一张「工具名 → 角色」映射表把单代理的 SSE 流切成四个角色。
// 现在角色由后端 discuss/orchestrator 真实扮演，turn 事件自带身份，那张表已删除。

/**
 * 智能体配色 —— 后端 turn 事件会带一个 hex 兜底色，但**优先走语义变量**，
 * 这样换肤时交流流里的角色配色能跟着主题变（否则又变成"半张皮"）。
 */
const AGENT_COLOR: Record<string, string> = {
  'plot-designer': 'hsl(var(--agent-plot))',
  'character-designer': 'hsl(var(--agent-character))',
  'continuity-keeper': 'hsl(var(--agent-continuity))',
  'convener': 'hsl(var(--agent-convener))',
  'writer': 'hsl(var(--agent-writer))',
  'conclusion': 'hsl(var(--agent-convener))',
  'reviewer': 'hsl(var(--primary))',
  'delivered': 'hsl(var(--state-done))',
  'deliver-blocked': 'hsl(var(--state-blocked))',
  'entities': 'hsl(var(--state-done))',
  'system': 'hsl(var(--state-blocked))',
  'user': 'hsl(var(--ink))',
};

function colorOf(agent: string, fallback: string): string {
  return AGENT_COLOR[agent] ?? fallback;
}

/** 交流流里的一条发言 */
interface ChatTurn {
  id: string;
  /** 'user' = 作者本人；其余为后端下发的角色 key；'system' = 报错 */
  from: string;
  name: string;
  color: string;
  short: string;
  text: string;
  time: string;
  /** 次要元信息，如「模型 xxx」 */
  meta?: string;
  /** 需要引起注意的状态，决定左侧色条 */
  tone?: 'warn' | 'ok';
  /** 'conclusion' 用卡片形式呈现（本章结论） */
  kind?: 'say' | 'conclusion';
  /**
   * 该次发言的思维链原文（推理型模型的 reasoning_content）。
   * 没有 = 模型没吐推理内容（非推理模型 / 中转站剥了字段），此时不渲染入口。
   */
  thinking?: string;
}

/** 正在流式产出的思维链（还没结算到某条发言上） */
interface LiveThinking {
  agent: string;
  name: string;
  short: string;
  color: string;
  text: string;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 思维链折叠块。
 *
 * 刻意做成「次要证据」的观感：小字号、次要色、左侧细墨线 ——
 * 它是给人核对「它为什么这么说」用的，**不该抢发言正文的注意力**，所以默认收起。
 */
function ThinkingTrace({ text, defaultOpen }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? '收起思维链' : '展开思维链（模型推理过程原文）'}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
        style={{
          color: 'hsl(var(--muted-foreground))',
          borderWidth: '0.5px',
          borderStyle: 'solid',
          borderColor: 'hsl(var(--border) / 0.8)',
          background: open ? 'hsl(var(--muted) / 0.5)' : 'transparent',
        }}
        title="模型的推理过程原文（思维链），不是发言内容"
      >
        <BrainCircuit size={11} aria-hidden="true" />
        思维链
        <span style={{ opacity: 0.7 }}>{text.length} 字</span>
        {open ? <ChevronUp size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
      </button>
      {open && (
        <pre
          className="mt-1 whitespace-pre-wrap rounded-lg px-2.5 py-2 text-[11px] leading-[1.7]"
          style={{
            color: 'hsl(var(--muted-foreground))',
            background: 'hsl(var(--muted) / 0.45)',
            borderLeft: '2px solid hsl(var(--border))',
            margin: 0,
            fontFamily: 'inherit',
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

interface AutoWriteWorkbenchProps {
  project: Project | null;
  /** 顶栏返回：由宿主决定目标（层级兜底 / 历史后退） */
  onBack: () => void;
  /**
   * 项目数据在服务端变了（本章交付后实体沉淀）时调用，由宿主刷新 store。
   * 必须用**宿主已有的那个 syncService 实例** —— 工作台自己再挂一个 useSyncService
   * 会让每次 store 变更被两个订阅各写一遍，实体重复创建。
   */
  onProjectDataChanged?: () => void;
}

const RAIL_MIN = 260;
const RAIL_MAX = 520;
const RAIL_DEFAULT = 320;
// 右侧实体栏并入分页区后，原来的 SIDE_* 三个常量与右分隔条一并删除

export function AutoWriteWorkbench({ project, onBack, onProjectDataChanged }: AutoWriteWorkbenchProps) {
  const chapters = useChapterStore((s) => s.chapters);

  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT);
  // 右侧实体栏已并入分页区（作为「实体与设定」面板），原来的 sideOpen/sideWidth 与右分隔条一并删掉
  const [hotSplitter, setHotSplitter] = useState<null | 'left'>(null);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  /**
   * 正在流式产出的思维链。
   * 讨论是**串行**的（同一时刻只有一个角色在发言），所以只需要留一个实时区。
   */
  const [liveThinking, setLiveThinking] = useState<LiveThinking | null>(null);
  const [draft, setDraft] = useState('');
  /** 正在等智能体回应（此时可打断） */
  const [busy, setBusy] = useState(false);
  /** 当前阶段（来自后端 phase 事件），显示在输入框上方 */
  const [phase, setPhase] = useState('');
  /**
   * 输入栏上方的技能面板（2026-09-13）：
   *   'writer' = 写作 Skills（这个 agent 的 skills，面板本身与写作无关，换 agentId 即可复用）
   *   'agents' = 智能体 Skills（全部智能体 + 每个的左关右开开关 + 技能库的安装/删除）
   * 与浮窗气泡里的"技能徽章"是两件事：徽章管「本轮用哪条」，这里管「这个智能体启用哪些」。
   */
  // 技能面板状态已移除（2026-09-17）：输入栏上方那个「技能」按钮撤了，
  // 写作官的开关 + 全部智能体 + 技能库统一收进「技能库」分页面板（见 aiPanels）。
  /** 讨论收敛出的本章结论 —— 同时落进交流流卡片与中栏「本章计划」卡 */
  const [conclusion, setConclusion] = useState<string | null>(null);
  /** 写作官产出的正文 —— 落在中上方的正文方块里（命名避开输入框的 `draft`） */
  const [prose, setProse] = useState<string | null>(null);
  /**
   * 阶段推进（讨论 / 写作 / 意图门 / 校对门 / 润色门 / 交付）——
   * 按**收到的事件累积**，不解析 phase 文案（文案会改，事件契约不会）。
   */
  const [stages, setStages] = useState<Partial<Record<StageKey, StageState>>>({});
  /**
   * 连写章数（1 = 单章）。>1 时后端逐章跑完整闭环（讨论→结论→落笔→三道门→交付→沉淀），
   * 后一章自动「接着上一章往下写」，不重复作者这句指令（它是指向第 1 章的）。
   */
  const [chapterCount, setChapterCount] = useState(1);
  /** 连写进度（仅 total > 1 时显示） */
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  /** 当前正文是第几稿：0 = 初稿，≥1 = 被意图门打回后的第 N 次重写 */
  const [revision, setRevision] = useState(0);

  const leftSplitRef = useRef<null | { sx: number; ow: number }>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /**
   * 思维链增量缓冲。
   * 分片**极多**（一次发言几十到上千条，实测一个小问题就有 104 片），
   * 所以不在每个分片上 setState —— 那会打出上百次渲染。攒进 ref，每 120ms 刷一次。
   */
  const thinkingBufRef = useRef('');
  const thinkingFlushRef = useRef<number | null>(null);
  /** 交流流发言推送（定义在下方，这里留 ref 供分页区的面板回调） */
  const onTurnRef = useRef<(t: PipelineTurn) => void>(() => {});

  // ============================================================
  // 分页工作区（AI 写作模式专用，设计见 docs/design/ui-tab-workspace-design.md）
  //
  //   结构：AI 交流栏 │ 气泡列 │ 正文（常驻，永不卸载）│ 辅助分页区
  //
  // 三条不变量：
  //   ① **正文不进 tabs** —— 它不在分页区里，所以切标签永远不会"替换"它
  //   ② **气泡是显示/隐藏开关** —— 二次点击只收起分页区，不销毁面板（面板里的筛选/滚动都留着）
  //   ③ **任何档位都不覆盖正文** —— 宽度不够时按「收 AI 栏 → 压分页区 → 挪到下方」逐级让位
  // ============================================================
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activePane = useWorkspaceStore((s) => s.active);
  const paneOpen = useWorkspaceStore((s) => s.paneOpen);
  const paneWidth = useWorkspaceStore((s) => s.paneWidth);
  const toggleBubble = useWorkspaceStore((s) => s.toggleBubble);
  const activatePane = useWorkspaceStore((s) => s.activate);
  const openPanel = useWorkspaceStore((s) => s.openPanel);
  /** 双击气泡 = 固定打开（把预览标签晋级；IDE 里双击文件就是这个语义） */
  const openPanelPinned = useCallback((key: string) => openPanel(key, { preview: false }), [openPanel]);
  const closePane = useWorkspaceStore((s) => s.closePanel);
  const closeOthers = useWorkspaceStore((s) => s.closeOthers);
  const closeToRight = useWorkspaceStore((s) => s.closeToRight);
  const promotePane = useWorkspaceStore((s) => s.promote);
  const movePaneTab = useWorkspaceStore((s) => s.moveTab);
  const setPaneOpen = useWorkspaceStore((s) => s.setPaneOpen);
  const previewKey = useWorkspaceStore((s) => s.previewKey);

  /**
   * 正文（主文档）是否打开。
   * ★ 2026-09-15：正文标签改为可关闭（作者要求「正文做可以关闭的页面」）。
   *   关掉后由占位接管，占位里给出「重新打开正文」入口，避免关了就找不回来。
   *   刻意**不做持久化** —— 刷新后回到打开状态，符合「正文是主文档」的默认预期。
   */
  const [bodyOpen, setBodyOpen] = useState(true);

  const [quickOpen, setQuickOpen] = useState(false);

  const [pipelineView, setPipelineView] = useState<PipelineView | null>(null);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1600 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * 让位阶梯（**绝不覆盖正文**，且**优先让看板留在正文旁边**）。
   *   ① 放得下就并排（用户设的宽度）
   *   ② 放不下 → 自动收 AI 交流栏（空间回来后自动恢复，不改写作者的 railOpen 偏好）
   *   ③ 还放不下 → **先把侧组压窄**（最低 PANE_W_MIN_SOFT）——作者的诉求是"在正文旁边打开"，
   *      所以压窄侧组比把它甩到下方角落更符合预期
   *   ④ 压到最窄仍放不下（窗口极窄）→ 才把侧组挪到正文下方（正文宽度完整，仍**不覆盖**）
   *
   * ★ 预算要含正文外框的内边距（BODY_PAD_X）：漏算的话判定"放得下"、正文实测却比最小宽还窄。
   */
  const bodyBudget = BODY_MIN_WIDTH + BODY_PAD_X;
  /**
   * AI 栏是否显示。
   * ★ 2026-09-15「页面切换」改造后**不再需要为看板留宽** —— 正文与看板互斥、各自占满，
   *   所以预算里只剩「气泡列 + AI 栏 + 正文」三项。
   *   原先那条四级让位阶梯（收 AI 栏 → 压窄侧组 → 落下方）整体作废，
   *   `paneMode` / `effectivePaneWidth` / `effectivePaneHeight` / `paneHeight` 均已移除。
   */
  const aiVisible = railOpen && viewport.w - RAIL_WIDTH - railWidth >= bodyBudget;

  // ---- AI 模式的看板清单：来自插件注册表（auto 插件），不再硬编码 ----
  //
  // ★ 2026-09-15 全面图谱化（作者决定）：四个看板的内容全部换成**图谱**。
  //   「实体与设定」用的就是手写模式的关系图谱组件（RelationGraph，三 Tab：
  //   角色 / 物品 / 地点），另外三栏是本工作台自己的图谱版面板。
  // ★ 2026-09-28：面板定义已迁到 plugin/autoBuiltin.ts（modes: ['auto']）注册，
  //   本组件按当前项目模式（auto）过滤注册表，再映射成工作台面板（带 group）。
  //   保留原有的 { key,label,icon,group,Component } 形态 —— 三栏布局、气泡列、
  //   标签栏、QuickOpen 与实时 props 绑定机制一个字节都不改。
  const mode = useProjectMode();
  const autoPanels = filterByProjectMode(usePluginRegistry((s) => s.projectPanels), mode);
  const aiPanels = useMemo<WorkbenchPanel[]>(() => (
    autoPanels.map((p) => ({
      key: p.key,
      label: p.label,
      icon: p.icon,
      group: p.group ?? 'data',
      Component: p.Component as WorkbenchPanel['Component'],
    }))
  ), [autoPanels]);

  /** 面板实时 props：宿主把工作台的状态绑进去（面板本身不接 props 的那套是插件浮窗，不是这里） */
  // ★ onTurn 走 ref 转发：`pushTurn` 在本文件里定义得更靠后（它依赖交流流的滚动收尾），
  //   直接写进依赖数组会撞 TDZ。用 ref 让它在调用时取最新值，既避免时序问题又不丢依赖。
  const hasChaptersInProject = project ? chapters.some((c) => c.projectId === project.id) : false;
  const panelProps = useMemo(() => ({
    projectId: project?.id ?? null,
    hasChapters: hasChaptersInProject,
    conclusion,
    running: busy,
    stages,
    onProjectDataChanged,
    onTurn: (t: PipelineTurn) => onTurnRef.current(t),
    onStatus: (v: PipelineView | null) => setPipelineView(v),
  }), [project?.id, hasChaptersInProject, conclusion, busy, stages, onProjectDataChanged]);

  // 记忆视图（只为徽标服务：有未裁决冲突时提醒）。触发点：项目变化 / 流水线阶段状态变化。
  // ★ 不轮询：审计不是实时指标，每次都要读三张表，为徽标常驻开销不值得。
  const [memoryView, setMemoryView] = useState<MemoryView | null>(null);
  const pipelineSig = pipelineView?.stages.map((st) => st.status).join(',') ?? '';
  useEffect(() => {
    let cancelled = false;
    void fetchMemoryView()
      .then((v) => { if (!cancelled) setMemoryView(v); })
      .catch(() => { /* 徽标失败就算了，不影响工作台 */ });
    return () => { cancelled = true; };
  }, [project?.id, pipelineSig]);

  const entityCount = useCharacterStore((s) => s.characters.length)
    + useLocationStore((s) => s.locations.length)
    + useItemStore((s) => s.items.length)
    + useForeshadowStore((s) => s.foreshadows.length);

  const bubbleSignals = useMemo<Record<string, PanelSignal>>(() => {
    const done = pipelineView?.stages.filter((s) => s.status === 'approved').length ?? 0;
    const total = pipelineView?.stages.length ?? 0;
    return {
      pipeline: {
        ...(total > 0 ? { badge: `${done}/${total}` } : {}),
        ...(pipelineView?.stages.some((s) => s.status === 'running') || busy ? { running: true } : {}),
      },
      chapterPlan: { ...(busy ? { running: true } : {}) },
      // 0 不显示徽标（空项目上挂个「0」是纯噪音）
      entities: { ...(entityCount > 0 ? { badge: entityCount } : {}) },
      // 记忆审计：只在**有未裁决冲突**时挂徽标（这是真正的"记忆污染预警"）
      memory: {
        ...((memoryView?.conflicts.length ?? 0) > 0 ? { badge: memoryView!.conflicts.length } : {}),
      },
    };
  }, [pipelineView, busy, entityCount]);

  // ---- 快捷键（IDE 习惯）：Ctrl+P 快速打开 / Ctrl+B 收起侧组 / Ctrl+\ 分栏 / Ctrl+W 关标签 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      const inSide = !!target?.closest('[data-pane-mode]');
      const k = e.key.toLowerCase();

      if (k === 'p') {
        // Ctrl+P 快速打开（IDE 的 Quick Open）
        e.preventDefault();
        setQuickOpen(true);
      } else if (k === 'b') {
        e.preventDefault();
        setPaneOpen(!paneOpen);
      } else if (e.key === '\\') {
        // Ctrl+\ 分栏：有看板就收起/展开侧编辑器组（IDE 里是 split editor）
        e.preventDefault();
        setPaneOpen(!paneOpen);
      } else if (k === 'w' && activePane && paneOpen) {
        // ★ 只在焦点位于侧编辑器组时拦截：否则会和浏览器「关闭标签页」抢
        if (inSide) {
          e.preventDefault();
          closePane(activePane);
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx === 0) activatePane(null);
        else if (tabs[idx - 1]) activatePane(tabs[idx - 1]!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paneOpen, activePane, tabs, closePane, activatePane, setPaneOpen]);

  const projChapters = useMemo(
    () => (project
      ? chapters.filter((c) => c.projectId === project.id).slice().sort((a, b) => a.order - b.order)
      : []),
    [chapters, project],
  );

  // 输入框随内容长高（上限 96px，超过就内部滚动）
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(96, el.scrollHeight)}px`;
  }, [draft]);

  // 窗口变窄时收钳 AI 栏宽度，保证正文不被挤没（分页区的高度/宽度各自有自己的钳制）
  useEffect(() => {
    const onResize = () => {
      const avail = window.innerWidth - BODY_MIN_WIDTH;
      setRailWidth((cur) => Math.min(cur, Math.max(RAIL_MIN, avail)));
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, []);

  // ---- 左侧分隔条（对话栏 | 气泡列+正文）：向右拖 = 对话栏变宽 ----
  const onLeftDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    leftSplitRef.current = { sx: e.clientX, ow: railWidth };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [railWidth]);

  const onLeftMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = leftSplitRef.current;
    if (!d) return;
    // 上限同时受「正文最小宽」与「分页区当前宽度」约束：别把正文挤没
    const room = window.innerWidth - BODY_MIN_WIDTH - (paneOpen ? paneWidth : 0);
    const next = Math.min(RAIL_MAX, Math.max(RAIL_MIN, d.ow + (e.clientX - d.sx)), Math.max(RAIL_MIN, room));
    setRailWidth(next);
  }, [paneOpen, paneWidth]);

  const onLeftUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    leftSplitRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  const scrollStreamToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  /**
   * 往交流流里推一条发言。
   * 提到组件作用域（原先只在 runAgent 内部）是因为**设定流水线也要往里推** ——
   * 它的 stage_turn 事件与单章讨论的 turn 是同一种东西，都该出现在同一交流流里。
   */
  const pushTurn = useCallback((turn: Omit<ChatTurn, 'id' | 'time'>) => {
    setTurns((prev) => [...prev, { ...turn, id: nanoid(), time: nowHHMM() }]);
    scrollStreamToEnd();
  }, [scrollStreamToEnd]);
  onTurnRef.current = pushTurn;

  /**
   * 思维链增量（实时）。
   * 攒进 ref，每 120ms 刷一次 state —— 见 thinkingBufRef 上的说明。
   * **不做自动滚动**：它每 120ms 长一次，自动滚会把正在往回翻的作者一直拽到底部。
   */
  const handleThinkingDelta = useCallback((e: Omit<LiveThinking, 'text'> & { delta: string }) => {
    thinkingBufRef.current += e.delta;
    if (thinkingFlushRef.current !== null) return;
    thinkingFlushRef.current = window.setTimeout(() => {
      thinkingFlushRef.current = null;
      setLiveThinking({ agent: e.agent, name: e.name, short: e.short, color: e.color, text: thinkingBufRef.current });
    }, 120);
  }, []);

  /** 发言到达：把攒着的思维链结算出来，并清空实时区（返回的即「本次发言的思维链」） */
  const settleThinking = useCallback((): string | undefined => {
    if (thinkingFlushRef.current !== null) {
      clearTimeout(thinkingFlushRef.current);
      thinkingFlushRef.current = null;
    }
    const t = thinkingBufRef.current;
    thinkingBufRef.current = '';
    setLiveThinking(null);
    return t.trim() ? t : undefined;
  }, []);
  // 卸载时别把定时器留下
  useEffect(() => () => {
    if (thinkingFlushRef.current !== null) clearTimeout(thinkingFlushRef.current);
  }, []);

  /** 一轮设计讨论：后端逐个扮演角色把发言推回来，事件自带身份（不再靠前端猜） */
  const runAgent = useCallback(async (text: string) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setPhase('正在召集智能体…');
    // 新一轮会话：阶段推进从「讨论」重来
    setStages({ discuss: 'running' });
    setProgress(chapterCount > 1 ? { index: 1, total: chapterCount } : null);

    const push = pushTurn;

    try {
      await runSession(text, { signal: ac.signal, chapterCount }, (e: SessionEvent) => {
        if (e.type === 'chapter_start') {
          // 连写：每章开跑前把上一章的结论/正文/阶段状态清干净，否则会串台
          setProgress({ index: e.index, total: e.total });
          if (e.total > 1) {
            setConclusion(null);
            setProse(null);
            setStages({ discuss: 'running' });
            push({
              from: 'system', name: `第 ${e.order} 章`, color: 'hsl(var(--primary))', short: '章',
              text: `开始第 ${e.index} / ${e.total} 章`,
            });
          }
        } else if (e.type === 'chapter_done') {
          // 一章收尾（不论是否交付成功都会发）—— 让作者知道 30 章跑到第几章了
          push({
            from: e.delivered ? 'delivered' : 'system',
            name: `第 ${e.order} 章`,
            color: e.delivered ? 'hsl(var(--state-done))' : 'hsl(var(--state-blocked))',
            short: e.delivered ? '✓' : '!',
            text: e.delivered
              ? `第 ${e.order} 章完成（${e.index}/${e.total}）`
              : `第 ${e.order} 章未完成（${e.index}/${e.total}），已继续下一章`,
            tone: e.delivered ? 'ok' : 'warn',
          });
          if (e.index >= e.total) setProgress(null);
        } else if (e.type === 'phase') {
          setPhase(e.label);
        } else if (e.type === 'thinking') {
          handleThinkingDelta(e);
        } else if (e.type === 'turn') {
          // 思维链结算到这条发言上：后端 turn 事件带的整段优先（权威），
          // 本地攒的只是「边跑边看」的副本，两者同源。
          const local = settleThinking();
          push({
            from: e.agent, name: e.name, color: e.color, short: e.short,
            text: e.text, meta: e.meta, thinking: e.thinking ?? local,
          });
        } else if (e.type === 'conclusion') {
          // 结论是契约：既进交流流（留痕），也进中栏计划卡（供后续写作/复核对照）
          setConclusion(e.text);
          setStages((s) => ({ ...s, discuss: 'done', write: 'running' }));
          push({
            from: 'conclusion', name: '本章结论', color: 'hsl(var(--agent-convener))', short: '结',
            text: e.text, kind: 'conclusion',
          });
        } else if (e.type === 'draft') {
          // 正文落点：同一份文本既作为写作官的发言进交流流，也进中上正文方块
          setProse(e.text);
          setRevision(e.revision);
          setStages((s) => ({ ...s, write: 'done', review: 'running' }));
        } else if (e.type === 'review') {
          // 复核结论进交流流留痕；tone 让打回一眼能认出来
          push({
            from: 'reviewer', name: '意图复核', color: '#534AB7', short: '核',
            text: e.text,
            meta: e.passed ? '通过' : `第 ${e.attempt} 次打回`,
            tone: e.passed ? 'ok' : 'warn',
          });
          // 通过 → 意图门完成、进入校对门；打回 → 停在意图门（写作官正在重写）
          setStages((s) => (e.passed ? { ...s, review: 'done', check: 'running' } : { ...s, review: 'running' }));
        } else if (e.type === 'gate') {
          // 校对门 / 润色门（三道门里的后两道）—— 与意图门一样，结论进交流流留痕。
          // 注意：校对门 passed=false **不代表没交付**（它只做一次定向修订，之后照样交付），
          // 所以 meta 里写明「不拦交付」，别让作者误以为整章废了。
          const isCheck = e.name === 'check';
          push({
            from: 'gate',
            name: isCheck ? '校对门' : '润色门',
            color: isCheck ? 'hsl(var(--state-blocked))' : 'hsl(var(--entity-foreshadow))',
            short: isCheck ? '校' : '润',
            text: !isCheck && typeof e.score === 'number' ? `${e.score}/10 · ${e.detail}` : e.detail,
            meta: e.passed ? '通过' : (isCheck ? '有冲突（不拦交付）' : '低于通过线'),
            tone: e.passed ? 'ok' : 'warn',
          });
          // 校对门做完 → 进润色门；润色门做完 → 进交付。两道门都不阻塞流程，
          // 所以状态只区分「完成 / 有冲突」，不表示流程中断。
          setStages((s) => (isCheck
            ? { ...s, check: e.passed ? 'done' : 'blocked', polish: 'running' }
            : { ...s, polish: e.passed ? 'done' : 'blocked', deliver: 'running' }));
        } else if (e.type === 'delivered') {
          // warnings：交付了但需要人工复核（例如意图门打回上限用尽仍交付）——
          // 连写时不丢章，但必须让作者知道哪一章要回头看
          const warn = e.warnings?.length ? `\n⚠ ${e.warnings.join('；')}` : '';
          push({
            from: 'delivered', name: '交付', color: '#0F6E56', short: '✓',
            text: `${e.created ? '已新建并写入' : '已写入'} ${e.title}（${e.wordCount} 字）${warn}`,
            tone: e.warnings?.length ? 'warn' : 'ok',
          });
          setStages((s) => ({ ...s, deliver: 'done' }));
        } else if (e.type === 'deliver_blocked') {
          push({
            from: 'deliver-blocked', name: '交付', color: '#A32D2D', short: '!',
            text: e.title ? `${e.title}：${e.reason}` : e.reason,
            tone: 'warn',
          });
          setStages((s) => ({ ...s, deliver: 'blocked' }));
        } else if (e.type === 'entities') {
          // 实体已写进项目库 —— 回流一行让作者看得见「本章世界变了什么」
          push({
            from: 'entities', name: '实体沉淀', color: 'hsl(var(--state-done))', short: '沉',
            text: `新建 ${e.created} · 更新 ${e.updated}${e.skipped > 0 ? ` · 跳过 ${e.skipped}` : ''}`
              + (e.notes.length > 0 ? `\n${e.notes.join('；')}` : ''),
            tone: 'ok',
          });
          // 仪表盘读的是项目 store（Item.states / Foreshadow.payoffChapter），
          // 服务端已落库、store 还是旧的 —— 不刷新则「最近变动」仍然空白。
          onProjectDataChanged?.();
        } else if (e.type === 'error') {
          push({
            from: 'system', name: '系统', color: 'hsl(var(--state-blocked))', short: '!',
            text: `会话失败：${e.message}`, tone: 'warn',
          });
        }
      });
    } catch (err) {
      // 用户主动打断：静默收尾，不当成错误
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        push({
          from: 'system', name: '系统', color: 'hsl(var(--state-blocked))', short: '!',
          text: `会话失败：${err instanceof Error ? err.message : String(err)}`,
          tone: 'warn',
        });
      }
    } finally {
      abortRef.current = null;
      // 收尾时清掉没结算完的思维链：中断/报错会让最后一段留在实时区里不走
      settleThinking();
      setBusy(false);
      setPhase('');
      scrollStreamToEnd();
    }
  }, [pushTurn, scrollStreamToEnd, onProjectDataChanged, chapterCount, handleThinkingDelta, settleThinking]);

  /** 作者发言：先落到流里，再交给编排器 */
  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setTurns((prev) => [...prev, {
      id: nanoid(),
      from: 'user', name: '你', color: 'hsl(var(--ink))', short: '我',
      text, time: nowHHMM(),
    }]);
    setDraft('');
    scrollStreamToEnd();
    void runAgent(text);
  }, [draft, busy, runAgent, scrollStreamToEnd]);

  /** 打断：中止当前流式请求（编排器会收到 abort） */
  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  const onDraftKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }, [send]);

  /**
   * 正在查看的章号（库里的）。
   *
   * ★ 为什么需要它：正文区原先只显示 `prose` —— 那是**本次会话**流出来的稿子，
   *   页面一刷新就没了，于是「30 章都在库里」和「界面上什么都看不到」同时成立。
   *   AI 写作模式又没有章节编辑器的入口，等于写完了却没法读。
   */
  const [viewOrder, setViewOrder] = useState<number | null>(null);
  /** 默认落在最新一章；只有用户没手动切、或那一章被删了才重设 */
  useEffect(() => {
    if (projChapters.length === 0) return;
    setViewOrder((cur) =>
      cur != null && projChapters.some((c) => c.order === cur)
        ? cur
        : (projChapters[projChapters.length - 1]?.order ?? null),
    );
  }, [projChapters]);
  const viewChapter = useMemo(
    () => (viewOrder != null ? projChapters.find((c) => c.order === viewOrder) ?? null : null),
    [projChapters, viewOrder],
  );
  /** 正文区显示什么：**本次会话刚产出的稿优先**（那是刚发生的事），否则读库里那一章 */
  const shownText = prose ?? viewChapter?.content ?? null;

  return (
    // ★ 必须是 h-screen 而不是 h-full：本组件经 ProjectLayout 的 early return 挂载，
    //   外层（PageFade → min-h-screen）是 min-height 撑出的内容高、并非确定高度，
    //   h-full 的百分比高度会退化成 auto → 工作台只占内容高，下方塌出整片空白。
    <div className="h-screen flex flex-col overflow-hidden">

      {/* ── 顶栏 ── */}
      <header
        className="shrink-0 flex items-center gap-2.5 relative z-40"
        style={{ height: 48, padding: '0 12px' }}
      >
        {/* ★ 2026-10-13 装回适配：原 `InkBackButton`（水墨体系）随 `3e3754e` 与 shuimo 主题
            一并退役，ui-kit 不再导出（其 index.ts 导出已同步删除）。按 kernel 同款改用
            lucide `ArrowLeft`（ProjectLayout.tsx:439-449），按钮壳沿用本顶栏其余图标键的
            `nm-btn-apple-icon-sm`，保留原有 onClick 与中文无障碍标签。 */}
        <button
          type="button"
          onClick={onBack}
          className="nm-btn-apple-icon-sm"
          title="返回"
          aria-label="返回"
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <span
          className="text-[13px] font-semibold truncate max-w-[140px] sm:max-w-[220px]"
          style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.2px' }}
        >
          {project ? project.name : '听风细雨'}
        </span>
        <span
          className="hidden sm:flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full"
          style={{ color: 'hsl(var(--muted-foreground))', background: 'rgb(var(--glass-tint) / 0.45)' }}
        >
          <span
            className="rounded-full"
            style={{ width: 5, height: 5, background: 'hsl(var(--primary) / 0.8)' }}
            aria-hidden="true"
          />
          AI 写作
        </span>

        <div className="ml-auto flex items-center gap-1">
          <span className="text-[11px] hidden md:inline mr-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
            {projChapters.length > 0 ? `共 ${projChapters.length} 章` : '尚未建章'}
          </span>
          <button
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            className="nm-btn-apple-icon-sm"
            title={railOpen ? '收起对话栏' : '展开对话栏'}
            aria-label={railOpen ? '收起对话栏' : '展开对话栏'}
            aria-pressed={railOpen}
          >
            {railOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button
            type="button"
            onClick={() => setPaneOpen(!paneOpen)}
            className="nm-btn-apple-icon-sm"
            title={paneOpen ? '收起分页区（Ctrl+B）' : '展开分页区（Ctrl+B）'}
            aria-label={paneOpen ? '收起分页区' : '展开分页区'}
            aria-pressed={paneOpen}
          >
            {paneOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative z-10">

        {/* ── 侧栏：智能体对话（aiVisible = 作者的偏好 且 让位阶梯允许） ── */}
        {aiVisible && (
          <>
            <section
              className="shrink-0 flex flex-col overflow-hidden"
              style={{
                width: railWidth,
                background: 'rgb(var(--glass-tint) / 0.34)',
                backdropFilter: 'blur(10px) saturate(130%)',
                WebkitBackdropFilter: 'blur(10px) saturate(130%)',
              }}
              aria-label="智能体对话"
            >
              <div
                className="shrink-0 flex items-center gap-2"
                style={{ height: 34, padding: '0 12px', borderBottom: '0.5px solid hsl(var(--border) / 0.5)' }}
              >
                <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))', letterSpacing: '0.06em' }}>
                  智能体对话
                </span>
                <span className="ml-auto flex items-center gap-1" aria-hidden="true">
                  {AGENTS.map((a) => (
                    <span
                      key={a.key}
                      className="rounded-full"
                      title={a.name}
                      style={{ width: 5, height: 5, background: `${a.color}66` }}
                    />
                  ))}
                </span>
              </div>

              <div ref={streamRef} className="flex-1 overflow-y-auto px-3 py-3.5">
                {turns.length === 0 && !liveThinking ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center px-2" style={{ maxWidth: 250 }}>
                      <Sparkles size={20} className="mx-auto mb-2.5" style={{ color: 'hsl(var(--primary) / 0.65)' }} />
                      <div className="text-[12px] mb-2" style={{ color: 'hsl(var(--ink))' }}>
                        智能体就位
                      </div>
                      <p className="text-[11px] leading-[1.75]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        说清这一章要写什么，写明章号（例如「写第 2 章：陈默去公司查姐姐的行踪」）。
                        <br />
                        <span style={{ color: 'hsl(var(--muted-foreground))' }}>
                          剧情设计师 / 角色设计师 / 设定管家会先来回讨论，定稿官收敛成本章结论，
                          写作官据此落笔并过三道门 —— 发言按时间展开，随时可在下方插话。
                          <br />
                          想连着写就在输入框右下角设「连写 N 章」：从章号起逐章写下去，每章都会完整走完复核与沉淀。
                        </span>
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {turns.map((t) => (
                      t.kind === 'conclusion' ? (
                        // 本章结论用卡片：它是契约，视觉上要能一眼认出来
                        <div
                          key={t.id}
                          className="rounded-xl px-3.5 py-3"
                          style={{ background: 'hsl(var(--card) / 0.7)', border: '0.5px solid hsl(var(--agent-convener) / 0.5)' }}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span
                              className="inline-flex items-center justify-center rounded-full text-white"
                              style={{ width: 18, height: 18, background: colorOf(t.from, t.color), fontSize: 9 }}
                              aria-hidden="true"
                            >
                              {t.short}
                            </span>
                            <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--ink))' }}>
                              {t.name}
                            </span>
                            <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                              {t.time}
                            </span>
                          </div>
                          <pre
                            className="text-[11px] leading-[1.75] whitespace-pre-wrap"
                            style={{ color: 'hsl(var(--ink-light))', margin: 0, fontFamily: 'inherit' }}
                          >
                            {t.text}
                          </pre>
                        </div>
                      ) : (
                        <div key={t.id} className="flex gap-2.5">
                          <span
                            className="shrink-0 inline-flex items-center justify-center rounded-full text-white"
                            style={{ width: 24, height: 24, background: colorOf(t.from, t.color), fontSize: 10, marginTop: 1 }}
                            aria-hidden="true"
                          >
                            {t.short}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="flex items-baseline gap-2">
                              <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--ink))' }}>
                                {t.name}
                              </span>
                              <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {t.time}
                              </span>
                            </div>

                            <div
                              className="text-[12px] leading-[1.7] mt-1"
                              style={{
                                color: 'hsl(var(--ink-light))',
                                whiteSpace: 'pre-wrap',
                                paddingLeft: t.tone ? 8 : 0,
                                borderLeft: t.tone
                                  ? `2px solid ${t.tone === 'warn' ? 'hsl(var(--state-blocked))' : 'hsl(var(--primary) / 0.5)'}`
                                  : undefined,
                              }}
                            >
                              {t.text}
                            </div>

                            {t.meta && (
                              <div className="text-[11px] mt-1.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {t.meta}
                              </div>
                            )}

                            {/* 思维链：默认收起，作为「它为什么这么说」的核对材料 */}
                            {t.thinking && <ThinkingTrace text={t.thinking} />}
                          </div>
                        </div>
                      )
                    ))}

                    {/*
                      实时思维链：正在想的时候直接铺开（这一块的价值就在"看见它怎么想"，
                      藏起来等于没有），发言一到达就结算进上方那条发言并消失。
                    */}
                    {liveThinking && (
                      <div className="flex gap-2.5">
                        <span
                          className="shrink-0 inline-flex items-center justify-center rounded-full text-white"
                          style={{ width: 24, height: 24, background: colorOf(liveThinking.agent, liveThinking.color), fontSize: 10, marginTop: 1, opacity: 0.85 }}
                          aria-hidden="true"
                        >
                          {liveThinking.short}
                        </span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="flex items-baseline gap-2">
                            <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                              {liveThinking.name}
                            </span>
                            <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                              思考中…
                            </span>
                          </div>
                          <pre
                            className="mt-1 whitespace-pre-wrap rounded-lg px-2.5 py-2 text-[11px] leading-[1.7]"
                            style={{
                              color: 'hsl(var(--muted-foreground))',
                              background: 'hsl(var(--muted) / 0.4)',
                              borderLeft: '2px solid hsl(var(--border))',
                              margin: 0,
                              fontFamily: 'inherit',
                              maxHeight: 300,
                              overflowY: 'auto',
                            }}
                          >
                            {liveThinking.text}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>


              <div
                className="shrink-0 px-2.5 py-2.5"
                style={{ borderTop: '0.5px solid hsl(var(--border) / 0.5)' }}
              >
                <div
                  className="flex items-end gap-1.5 rounded-xl px-2.5 py-2"
                  style={{
                    background: 'rgb(var(--glass-tint) / 0.55)',
                    border: '0.5px solid hsl(var(--border) / 0.7)',
                  }}
                >
                  <textarea
                    ref={taRef}
                    // 进工作台就把焦点给输入框：作者来这里就是要说话的。
                    // （顺带让「无人值守驱动界面」这条链路能用键盘走完，不必依赖点击坐标 —— 实测坐标点击在
                    //   满屏/窗口位移时并不可靠）
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onDraftKeyDown}
                    rows={1}
                    placeholder="插一句话打断，或补充指令…"
                    aria-label="对智能体说话"
                    className="flex-1 resize-none bg-transparent outline-none text-[12px] leading-[1.65] py-0.5"
                    style={{ color: 'hsl(var(--foreground))', maxHeight: 96, overflowY: 'auto' }}
                  />
                  <button
                    type="button"
                    onClick={send}
                    disabled={!draft.trim() || busy}
                    className="shrink-0 inline-flex items-center justify-center rounded-lg transition-opacity disabled:opacity-30"
                    title={busy ? '智能体处理中' : '发送（Enter）'}
                    aria-label="发送"
                    style={{
                      width: 26,
                      height: 26,
                      background: 'hsl(var(--primary))',
                      color: 'hsl(var(--primary-foreground))',
                      cursor: draft.trim() && !busy ? 'pointer' : 'default',
                    }}
                  >
                    <Send size={13} />
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-1.5 px-1">
                  <span className="text-[11px] truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {busy ? (phase || '智能体处理中…') : 'Enter 发送 · Shift+Enter 换行'}
                  </span>

                  {/* 连写章数：>1 时后端逐章跑完整闭环（讨论 → 结论 → 三道门 → 交付 → 沉淀），
                      后续章自动「接着上一章往下写」。每章约一分钟，别在忙的时候改它 */}
                  {!busy && (
                    <label
                      className="ml-auto flex items-center gap-1 text-[11px] shrink-0"
                      style={{ color: 'hsl(var(--muted-foreground))' }}
                      title="连写章数：从指令里的章号开始逐章写，每章约一分钟"
                    >
                      连写
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={chapterCount}
                        onChange={(ev) => {
                          const n = Math.floor(Number(ev.target.value) || 1);
                          setChapterCount(Math.max(1, Math.min(50, n)));
                        }}
                        className="rounded-md text-center"
                        style={{
                          width: 40,
                          height: 20,
                          background: 'rgb(var(--glass-tint) / 0.5)',
                          border: '0.5px solid hsl(var(--border) / 0.8)',
                          color: 'hsl(var(--ink))',
                        }}
                      />
                      章
                    </label>
                  )}

                  {progress && (
                    <span className="text-[11px] shrink-0 ml-auto" style={{ color: 'hsl(var(--primary))' }}>
                      第 {progress.index} / {progress.total} 章
                    </span>
                  )}

                  {busy && (
                    <button
                      type="button"
                      onClick={interrupt}
                      className="ml-auto text-[11px] px-2 py-0.5 rounded-md"
                      style={{
                        color: 'hsl(var(--destructive))',
                        borderWidth: '0.5px',
                        borderStyle: 'solid',
                        borderColor: 'hsl(var(--destructive) / 0.4)',
                        background: 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      停止
                    </button>
                  )}
                </div>
              </div>
            </section>
          </>
        )}

        {/* ── 功能看板气泡列：紧贴 AI 对话区**右边**，竖直漂浮 ──
            单击 = 预览打开（会被下一个预览顶掉）；双击 = 固定打开 */}
        <BubbleRail
          panels={aiPanels}
          openKeys={tabs}
          activeKey={activePane}
          previewKey={previewKey}
          signals={bubbleSignals}
          onToggle={toggleBubble}
          onPin={(key) => openPanelPinned(key)}
        />

        {/* AI 栏与（气泡列 + 编辑器区）之间的分隔条：向右拖 = 对话栏变宽 */}
        {aiVisible && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整对话栏宽度"
            onPointerDown={onLeftDown}
            onPointerMove={onLeftMove}
            onPointerUp={onLeftUp}
            onPointerCancel={onLeftUp}
            onMouseEnter={() => setHotSplitter('left')}
            onMouseLeave={() => setHotSplitter(null)}
            className="shrink-0"
            style={{
              width: 5,
              cursor: 'col-resize',
              touchAction: 'none',
              background: hotSplitter === 'left' ? 'hsl(var(--primary) / 0.35)' : 'transparent',
              borderLeft: '0.5px solid hsl(var(--border) / 0.6)',
              transition: 'background 0.15s',
            }}
          />
        )}

        {/* ── 主区：编辑器组 1（正文，常驻）+ 下方的编辑器组 2（宽度不够时才落下来）── */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* ★ 编辑器组 1 的标签栏：只有一个固定的「正文」项，不可关闭。
                它是"主编辑器里打开的那份稿子" —— 组 2 怎么切都动不到这里 */}
            {/* ★ 2026-09-15 改为「页面切换」：正文与看板**互斥**，共用一条标签栏。
                点哪个标签哪个占满 —— 像浏览器切标签页（作者在「看板占满全屏」的选项里选的这一档）。
                这**推翻了 2026-09-13「正文永不被挡」的分栏约定**，是作者本人的决定，别再改回去。 */}
            <TabBar
              panels={aiPanels}
              tabs={tabs}
              active={activePane}
              variant="unified"
              previewKey={previewKey}
              onActivate={activatePane}
              onClose={closePane}
              onCloseOthers={closeOthers}
              onCloseRight={closeToRight}
              onPromote={promotePane}
              onMove={movePaneTab}
              onBackToBody={() => activatePane(null)}
              bodyFocused={activePane === null}
              bodySubtitle={viewChapter ? `第 ${viewChapter.order} 章 · ${viewChapter.wordCount ?? 0} 字` : undefined}
              onCloseBody={() => setBodyOpen(false)}
            />
            {/* 正文区域：占据剩余全部高度。★ **永不参与分页、永不卸载** ——
                切标签只影响侧编辑器组，这里的 DOM 与滚动位置一个字节都不动 */}
            {/* ★ 2026-09-15 页面切换：正文与看板互斥。
                这里用 **display 切换**而不是条件卸载 —— 正文里有编辑器实例与滚动位置，
                「永不卸载」是既有硬约定；卸载再挂载会丢滚动位置并重建编辑器。 */}
            <section
              className="flex-1 min-h-0 flex flex-col overflow-hidden"
              style={{ background: EDITOR_BG, display: activePane === null ? undefined : 'none' }}
              aria-label="正文"
            >
            {bodyOpen ? (
              <>
            <div
              className="shrink-0 flex items-center gap-2"
              // ★ 2026-09-15「让标题贴紧」：原为 height 30 + 0.5px 底边框。
              //   它与上方 35px 的标签栏叠在一起，正文顶部堆了 65px 浅色区，
              //   连成一片看着就像「标签下面挂了一条空白带」。压到 24px 并去掉底边框。
              style={{ height: 24, padding: '0 14px' }}
            >
              {/* 编辑器头部：章节切换 + 稿件状态（IDE 这里放的是面包屑，我们放章号） */}
              <span className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))', letterSpacing: '0.06em' }}>
                {viewChapter ? `第 ${viewChapter.order} 章` : '未建章'}
              </span>
              {/* 章节切换：AI 模式没有章节编辑器，这里就是唯一的「读已写章节」入口 */}
              {projChapters.length > 0 && (
                <select
                  value={viewOrder ?? ''}
                  onChange={(ev) => {
                    setViewOrder(Number(ev.target.value));
                    setProse(null); // 切章看库内容，不再占着本次会话的稿
                  }}
                  className="text-[11px] bg-transparent outline-none cursor-pointer truncate"
                  style={{ color: 'hsl(var(--muted-foreground))', maxWidth: 170, border: 'none' }}
                  title="切换查看已交付的章节"
                >
                  {projChapters.map((c) => (
                    <option key={c.id} value={c.order}>
                      第 {c.order} 章 · {c.wordCount ?? 0} 字
                    </option>
                  ))}
                </select>
              )}
              {prose ? (
                <span className="ml-auto text-[11px]" style={{ color: 'hsl(var(--state-running))' }}>
                  {revision > 0 ? `第 ${revision} 次重写` : '本次生成'}
                </span>
              ) : viewChapter ? (
                <span className="ml-auto text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  已入库 · {viewChapter.wordCount ?? 0} 字
                </span>
              ) : null}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
              {shownText ? (
                <div
                  className="font-serif whitespace-pre-wrap"
                  style={{ fontSize: 13.5, lineHeight: 1.9, color: 'hsl(var(--foreground))' }}
                >
                  {shownText}
                </div>
              ) : (
                <div className="min-h-full flex items-center justify-center">
                  {projChapters.length === 0 ? (
                    <div className="text-center px-4">
                      <div className="font-serif mb-2" style={{ fontSize: 14, color: 'hsl(var(--ink))' }}>
                        还没有章节
                      </div>
                      <p className="text-[11px] leading-[1.8]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        在左侧对智能体说明要写什么，讨论收敛后写作官会在这里落笔。
                      </p>
                    </div>
                  ) : (
                    <div className="text-center px-4">
                      <div className="font-serif mb-2" style={{ fontSize: 14, color: 'hsl(var(--ink))' }}>
                        这一章还没有正文
                      </div>
                      <p className="text-[11px] leading-[1.8]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        用上方下拉切到别的章节看看，或在左侧让智能体写这一章。
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
              </>
            ) : (
              /* 正文已被关闭（× 关掉的）：给一个安静的占位 + 明确的重新打开入口，
                 避免「关了就找不回来」。刻意不做持久化，刷新即恢复打开。 */
              <div className="flex-1 flex items-center justify-center" style={{ background: EDITOR_BG }}>
                <div className="text-center">
                  <BookOpen size={26} className="mx-auto mb-3" style={{ color: 'hsl(var(--ink-pale))', opacity: 0.6 }} />
                  <div className="font-serif mb-1.5" style={{ fontSize: 14, color: 'hsl(var(--ink-light))' }}>
                    正文已关闭
                  </div>
                  <p className="text-[11px] mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    稿子还在库里，随时可以重新打开
                  </p>
                  <button
                    type="button"
                    onClick={() => setBodyOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md transition-all"
                    style={{
                      fontFamily: "'Noto Serif SC', serif",
                      fontSize: 12.5,
                      color: 'hsl(var(--card))',
                      background: 'hsl(var(--mountain-deep))',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <BookOpen size={13} />
                    重新打开正文
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* ★ 2026-09-15 页面切换：看板不再有独立容器（右侧栏 / 下方横栏都没了），
              而是与正文**互斥地占满同一块区域**。原先这里的两处 WorkspacePane
              连同四级让位阶梯（收 AI 栏 → 压窄侧组 → 落下方）一并移除。
              标签栏已由上面的 unified TabBar 统一渲染。 */}
          {activePane !== null && (() => {
            const p = aiPanels.find((x) => x.key === activePane);
            const C = p?.Component;
            return (
              <section
                className="flex-1 min-h-0 flex flex-col overflow-hidden"
                style={{ background: EDITOR_BG }}
                aria-label="看板"
              >
                {/* ★ 给所有看板一份统一内边距 —— 原来面板直接贴着容器边缘，
                    看板改成「占满整屏」后那块区域变宽变大，贴边就显不出结构。
                    ★ 2026-09-15 全面图谱化后由 `overflow-y-auto` 改为 **overflow-hidden**：
                      四个面板现在都是 `h-full` 的图谱（内部各自滚自己的侧栏 / 画布），
                      外层再开一层滚动会出现"滚动条套滚动条"，而且 ReactFlow 需要一个
                      **确定高度**的容器 —— 放进可变高度的滚动盒里画布会被压成 0。 */}
                <div className="flex-1 min-h-0 overflow-hidden p-3" data-pane-content={activePane}>
                  {C ? (
                    <Suspense
                      fallback={(
                        <div className="h-full flex items-center justify-center text-[12px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          正在载入「{p?.label}」图谱…
                        </div>
                      )}
                    >
                      <ErrorBoundary
                        fallback={(
                          <div className="p-4 text-[12px]" style={{ color: 'hsl(var(--destructive))' }}>
                            「{p?.label}」面板出错了 —— 正文与其它标签不受影响，可关闭此标签后重开。
                          </div>
                        )}
                      >
                        <C {...(panelProps ?? {})} />
                      </ErrorBoundary>
                    </Suspense>
                  ) : (
                    <div className="p-6 text-center text-[12px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      这个看板已经下线了 —— 换个标签或关掉它。
                    </div>
                  )}
                </div>
              </section>
            );
          })()}
          </div>
        </div>

      </div>

      {/* ── 状态栏（IDE 的底条）：左＝花名册，右＝当前状态 ── */}
      <footer
        className="shrink-0 flex items-center gap-4 flex-wrap"
        style={{
          height: 26,
          padding: '0 14px',
          borderTop: '0.5px solid hsl(var(--border) / 0.6)',
          background: 'rgb(var(--glass-tint) / 0.42)',
        }}
        aria-label="状态栏"
      >
        {AGENTS.map((a) => (
          <span key={a.key} className="flex items-center gap-1.5" title={a.desc}>
            <span
              className="inline-flex items-center justify-center rounded-full text-white"
              style={{ width: 14, height: 14, background: a.color, fontSize: 8 }}
            >
              {a.short}
            </span>
            <span className="text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {a.name}
            </span>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3 text-[10.5px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {pipelineView && (
            <span title="设定流水线进度">
              流水线 <span style={{ color: 'hsl(var(--foreground))' }}>
                {pipelineView.stages.filter((s) => s.status === 'approved').length}/{pipelineView.stages.length}
              </span>
            </span>
          )}
          <span title="库中章节数">
            库中 <span style={{ color: 'hsl(var(--foreground))' }}>{chapters.length}</span> 章
          </span>
          <span title="侧编辑器组当前看板">
            组 2：<span style={{ color: 'hsl(var(--foreground))' }}>
              {activePane ? (aiPanels.find((p) => p.key === activePane)?.label ?? activePane) : '未打开'}
            </span>
          </span>
          <span style={{ opacity: 0.75 }}>Ctrl+P 快速打开 · Ctrl+\ 分栏 · Ctrl+W 关标签</span>
        </span>
      </footer>

      {/* Ctrl+P 快速打开（IDE 的 Quick Open） */}
      <QuickOpen
        open={quickOpen}
        panels={aiPanels}
        openKeys={tabs}
        onPick={(key) => openPanelPinned(key)}
        onClose={() => setQuickOpen(false)}
      />
    </div>
  );
}
