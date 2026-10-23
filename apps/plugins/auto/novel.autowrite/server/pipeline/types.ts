// ============================================================
// 多智能体协作流水线 —— 类型与常量
//
// 设计见 docs/architecture/ai-writing-multiagent-pipeline.md。这里是它的可执行部分：
//   7 个阶段（StageKey）+ 4 道用户闸门（G1–G4）+ 闸门三态。
//
// ★ 与 `discuss/orchestrator.ts`（单章闭环）的关系：
//   本流水线负责**开书前的立设定**（角色宪章 / 世界圣经 / 剧情总纲），
//   单章闭环负责**立完之后的每一章**。两者共用 context-resolver / entity-sink / 三道门。
// ============================================================

/**
 * 阶段序。
 * - brief        打包开书信息（不出模型，只冻结基线）
 * - cast         角色分析与节奏基线         → G1
 * - bible        世界观 / 人物 / 势力        → G2
 * - plot         剧情走向 / 节拍 / 张力      → G3
 * - drift        三层偏离核查（M2）
 * - pilot        前三章试写 + 团队审阅      → G4（M2）
 * - production   长跑 + 监工 + 三章轨迹确认（M3）
 */
export type StageKey = 'brief' | 'cast' | 'bible' | 'plot' | 'drift' | 'pilot' | 'production';

export const STAGES: readonly StageKey[] = ['brief', 'cast', 'bible', 'plot', 'drift', 'pilot', 'production'];

/** 阶段中文名（事件与 UI 共用，别在 UI 里再写一份） */
export const STAGE_LABEL: Record<StageKey, string> = {
  brief: '开书信息',
  cast: '角色与节奏宪章',
  bible: '世界圣经',
  plot: '剧情总纲',
  drift: '偏离核查',
  pilot: '前三章试写',
  production: '长跑与监工',
};

/** 有用户闸门的阶段（决定 UI 何时弹审批卡） */
export const GATED_STAGES: readonly StageKey[] = ['cast', 'bible', 'plot', 'pilot'];

/** 已实现、可真正跑的阶段；其余阶段 advance 时明确告知未实现，不假装能跑 */
export const IMPLEMENTED_STAGES: readonly StageKey[] = ['brief', 'cast', 'bible', 'plot', 'drift', 'pilot', 'production'];

/** pilot 试写几章（设计 §Stage5：前三章先试水，好看清文风与弧光再长跑） */
export const PILOT_CHAPTERS = 3;

/**
 * production 长跑一次最多写几章（**断点续跑**的安全阀）。
 *
 * 为什么要这个数：长跑是「跑到作者喊停」的语义，但一次 SSE 请求不能真跑到 30 章
 * （连接会断、额度会失控）。所以 production 段**一段一次跑一批**，跑完把游标留在
 * `cursor.lastDelivered`，作者再点一次就接着往下写 —— 这就是"断点续跑"的落地形式。
 * 进程中途被杀也不怕：已交付的章在项目库里，游标在 KV 里，下一次从游标 +1 接。
 */
export const PRODUCTION_BATCH = 5;

/** production 每写几章回剧情设计师做一次轨迹确认（设计 §Stage6：默认 3） */
export const PRODUCTION_REVIEW_EVERY = 3;

export type StageStatus = 'idle' | 'running' | 'awaiting_user' | 'approved' | 'failed';

/** 闸门三态：批准 / 带批注打回（重跑本段）/ 退回上一段（方向就错了） */
export type DecisionAction = 'approve' | 'revise' | 'reject';

/** 单个阶段被作者打回的上限 —— 撞上限不丢弃，按现状继续并标注（见设计 §2） */
export const REVISION_LIMIT = 3;

export interface StageRecord {
  status: StageStatus;
  /** 已被作者打回/退回的次数 */
  revision: number;
  /** status==='running' 的开始时刻 —— 用于识别「进程被杀之后留下的僵死 running」 */
  runningSince?: number;
  /** 契约文本（人可读、可对照）—— drift 的 L2 对照物就是它 */
  artifact?: string;
  /** 本段是否已把产出物落库（approve 后才做） */
  sinked?: boolean;
  /**
   * drift 段专有：**逐条核查**的统计。为什么要单独存：
   * 报告是给人看的散文，而"到底核了几条、几条符合"才是可判定的事实 ——
   * 没有它就没人能验证"核查真的逐条做了"（设计里那条必测项就卡在这里）。
   */
  driftCounts?: { total: number; 符合: number; 偏离: number; 库中无依据: number; hard: number; soft: number };
  /**
   * pilot 段专有：**试写的三章**到底交上去没有。
   * 与 driftCounts 同理 —— 报告会写得很漂亮（"三章都达标、文风统一"），
   * 但"交了几章、各多少字、有没有带警示"才是可判定的事实。承诺的 3 章交了 2 章，
   * 报告却写得像全交了，是这类流水线最典型的失真。
   */
  pilotChapters?: Array<{ order: number; delivered: boolean; wordCount: number; warnings: string[] }>;
  /** pilot 段专有：跨章审阅的判定（pass/minor/major）与问题条数 */
  premiereVerdict?: { verdict: 'pass' | 'minor' | 'major'; issues: number; kinds: string[] };
  /**
   * production 段专有：本轮**长跑批次**写掉的章（含未交付的）。
   * 与 pilotChapters 同理 —— 报告会写得很漂亮，但"交了几章、各多少字"才是可判定的事实。
   */
  productionChapters?: Array<{ order: number; delivered: boolean; wordCount: number; warnings: string[] }>;
  /**
   * production 段专有：本轮的监工结论。
   * `halt` 是**唯一会打断长跑**的判定（连续两次 watch 也折算成 halt，见 production.ts）。
   */
  supervisorVerdict?: {
    order: number; verdict: 'ok' | 'watch' | 'halt'; issues: number;
    /** 问题明细（2026-10-16 加）—— 只留计数则事后回查不到具体是哪几条 */
    detail?: Array<{ kind: string; detail: string; evidence: string }>;
  };
  /**
   * production 段专有：本轮是否因监工 `halt` 而停下（停下后不自动续写，等作者处理）。
   * 显式存 —— 否则「为什么长跑停在半路」只能靠读报告散文猜。
   */
  supervisorHalted?: boolean;
  startedAt?: number;
  finishedAt?: number;
  /** status==='failed' 时的原因 */
  error?: string;
}

export interface DecisionEntry {
  stage: StageKey;
  at: number;
  /** 决策人（M1 单作者；若日后要双签，这里换成 approvers[]） */
  by: string;
  action: DecisionAction;
  note?: string;
}

/**
 * 轨迹确认记录（production 每 N 章一条，设计 §Stage6）。
 *
 * ★ 它是**有产出物**的确认，不是"我看过了"：`on_track` 记一条；`minor_drift` 带
 *   接下来 2–3 章的修正补丁（`patch`），后续章节的写作提示里会注入它；`major_drift`
 *   暂停整条流水线并把 `note` 作为《轨迹偏离报告》交给作者。
 */
export interface TrackEntry {
  from: number;
  to: number;
  at: number;
  by: string;
  verdict: 'on_track' | 'minor_drift' | 'major_drift';
  note: string;
  /** minor_drift 的修正补丁（接下来几章要按它走）；on_track/major_drift 为空 */
  patch?: string;
}

/**
 * 单次**阶段运行**的留痕（每次 advance 跑一段都追加一条）。
 *
 * ★ 2026-09-28 迁移自旧批次流水线的 `AuditEntry`（flow-store.ts 的 `audit:` 台账）：
 *   旧台账记的是「每一步用了哪个模型、跑了多久、为什么放行」，
 *   而新的 `DecisionEntry` 只记**闸门决策**（approve/revise/reject），
 *   非闸门阶段的自动运行（drift 自动过）与任何一次运行的耗时/模型都无处可查。
 *   删旧流水线前先把这块可观测性补回来 —— 否则「谁在什么时候跑了什么、用了什么模型」
 *   就成了黑盒。
 */
export interface RunEntry {
  stage: StageKey;
  at: number;
  /** 跑这次的人（单作者；日后双签再换） */
  by: string;
  /** 本次运行内的模型调用次数（每个发言人 + 收敛官各算一次） */
  turns: number;
  /** 实际用到的模型（取首次调用的 result.model，缺省为空） */
  model?: string;
  /** 本次运行耗时（毫秒） */
  ms: number;
  /** 终态：awaiting_user（有闸门，等作者）/ approved（无闸门自动过）/ failed */
  outcome: 'awaiting_user' | 'approved' | 'failed';
  /** 失败原因或补充说明（失败时必填） */
  error?: string;
}

export interface PipelineState {
  projectId: string;
  /** 当前停在/正在跑的阶段 */
  stage: StageKey;
  /**
   * 基线指纹：`projects.brief` + genre + 作者开跑时补的话 的 sha256。
   * 作者改了开书设定 → hash 变 → 已通过的闸门标记过期（否则旧宪法会静默继续生效）。
   */
  briefHash: string;
  stages: Record<StageKey, StageRecord>;
  /** 作者在开跑时补的话（可以留空） */
  note?: string;
  /** 长跑游标（M3 用） */
  cursor: {
    lastDelivered: number;
    sinceReview: number;
    /** 每几章做一次轨迹确认（可配，默认 3） */
    reviewEvery: number;
  };
  updatedAt: number;
}

/** 各阶段落库的统计（approve 后） */
export interface SinkStats {
  characters: { created: number; updated: number };
  outline: number;
  foreshadows: number;
  skipped: number;
  notes: string[];
}

// ---- SSE 事件 ----

export type PipelineEvent =
  | { type: 'stage_start'; stage: StageKey; revision: number }
  | { type: 'stage_phase'; stage: StageKey; label: string }
  | {
      type: 'stage_turn';
      stage: StageKey;
      agent: string;
      name: string;
      color: string;
      short: string;
      text: string;
      meta?: string;
    }
  | { type: 'stage_summary'; stage: StageKey; text: string }
  /** 无闸门阶段跑完自动过（当前是 drift）：报告已出，不需要作者确认 */
  | { type: 'stage_auto_approved'; stage: StageKey; summary: string }
  /**
   * pilot：第 i/3 章开写 / 写完。`phase` 区分两个时点 —— 前端据此插分段、
   * 并在 done 时把"已交付 N 字"落到那一章上。`delivered=false` 表示这章没进库（要显眼）。
   */
  | {
      type: 'pilot_chapter';
      index: number;
      total: number;
      order: number;
      phase: 'start' | 'done';
      delivered?: boolean;
      wordCount?: number;
      warnings?: string[];
    }
  /** pilot：三章之后的跨章审阅结论（原样给作者看，不加工） */
  | { type: 'premiere_review'; text: string; verdict: 'pass' | 'minor' | 'major'; issues: number }
  /**
   * production：第 i/N 章开写 / 写完（与 pilot_chapter 同构）。
   * `batchTotal` 是本轮批次的章数；`cursor` 是**全书已交付到第几章** ——
   * 两者分开，作者才知道"这一批还剩几章、整本书写到哪了"。
   */
  | {
      type: 'production_chapter';
      index: number;
      total: number;
      order: number;
      phase: 'start' | 'done';
      delivered?: boolean;
      wordCount?: number;
      warnings?: string[];
      /** 全书已交付的最后一章（游标），done 时带上 */
      cursor?: number;
    }
  /** production：单章监工报告（逐章巡检，只读） */
  | {
      type: 'supervise_report';
      order: number;
      verdict: 'ok' | 'watch' | 'halt';
      issues: string[];
      trend: string;
    }
  /**
   * production：每 N 章一次轨迹确认（回到剧情设计师）。
   * `major_drift` 会**暂停整条流水线**（唯一会打扰作者的地方）。
   */
  | {
      type: 'track_review';
      from: number;
      to: number;
      verdict: 'on_track' | 'minor_drift' | 'major_drift';
      note: string;
    }
  /** 偏离核查发现**硬偏离**：游标已退回到需要回修的那一段，那段闸门作废 */
  | { type: 'stage_drift_blocked'; stage: StageKey; backTo: StageKey; message: string; hard: number; soft: number }
  | {
      type: 'awaiting_user';
      stage: StageKey;
      summary: string;
      revision: number;
      revisionLimit: number;
    }
  /** 落库结果：approve 之后才发生 */
  | { type: 'stage_sinked'; stage: StageKey; stats: SinkStats }
  /** 阶段被跳过（例如 brief 无需模型调用） */
  | { type: 'stage_skipped'; stage: StageKey; reason: string }
  | { type: 'stage_failed'; stage: StageKey; message: string }
  /** 基线变更：已通过的闸门过期 */
  | { type: 'baseline_changed'; from: string; to: string; stale: StageKey[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

// ---- 对外视图（GET /pipeline）----

export interface PipelineView {
  projectId: string;
  stage: StageKey;
  stageLabel: string;
  briefHash: string;
  /** 基线是否已变（changed=true 时已通过的阶段全标过期） */
  staleStages: StageKey[];
  stages: Array<{
    key: StageKey;
    label: string;
    status: StageStatus;
    revision: number;
    gated: boolean;
    implemented: boolean;
    /** 契约文本（供 UI 展示 / 复制） */
    artifact?: string;
    /** drift：逐条核查统计（UI 上把"核了几条"显出来） */
    driftCounts?: StageRecord['driftCounts'];
    /** pilot：试写的三章交付情况 */
    pilotChapters?: StageRecord['pilotChapters'];
    /** pilot：跨章审阅判定 */
    premiereVerdict?: StageRecord['premiereVerdict'];
    /** production：本轮长跑的章节交付情况 */
    productionChapters?: StageRecord['productionChapters'];
    /** production：本轮监工结论 */
    supervisorVerdict?: StageRecord['supervisorVerdict'];
    /** production：是否因监工 halt 停下（停下后等作者处理再续跑） */
    supervisorHalted?: boolean;
    error?: string;
  }>;
  /** 最近若干条闸门决策（倒序） */
  decisions: DecisionEntry[];
  /** 最近若干条阶段运行留痕（倒序）—— 谁在何时跑了什么、用了什么模型、耗时多少 */
  runs: RunEntry[];
  /** 轨迹确认台账（倒序）—— production 每 N 章一条，回放用 */
  tracks: TrackEntry[];
  reviewEvery: number;
  /**
   * 长跑游标：**已交付的最后一章**。
   * 必须暴露出来 —— 它是"试写到哪了/长跑从第几章接"的唯一权威数字，
   * 不暴露的话 M3 只能靠猜，验收脚本也只能靠正则在报告里找（那就是假验证）。
   */
  lastDelivered: number;
  updatedAt: number;
}
