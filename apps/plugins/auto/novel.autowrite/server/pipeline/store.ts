// ============================================================
// 流水线状态存储（plugin_kv，项目隔离）
//
// key 约定（NS = novel.autowrite，与 flow-store 同款命名空间）：
//   pipeline            流水线主状态（PipelineState）
//   pipeline_decisions  闸门决策台账（append-only，倒序读）
//
// ★ 为什么不复用 FlowStore：那是**批次语义**（batch:/flow:/audit:），
//   本流水线是**项目生命周期语义**（一段一次，贯穿全书）。硬套会得到一堆
//   「批次 1/1」的假概念。所以另起一份精简状态，且不复活 server/autowrite/* 那套死代码。
// ============================================================

import { createHash } from 'node:crypto';
import type { KvService } from '@novel/core';
import {
  STAGES, STAGE_LABEL, GATED_STAGES, IMPLEMENTED_STAGES, REVISION_LIMIT,
  type DecisionAction, type DecisionEntry, type PipelineState, type PipelineView,
  type RunEntry, type StageKey, type StageRecord, type TrackEntry,
} from './types.js';

const NS = 'novel.autowrite';
const KEY_STATE = 'pipeline';
const KEY_DECISIONS = 'pipeline_decisions';
const KEY_RUNS = 'pipeline_runs';
const KEY_TRACKS = 'pipeline_tracks';
/** 台账上限：单项目生命周期内足够回溯，别让 KV 无限膨胀 */
const MAX_DECISIONS = 500;
/** 运行留痕上限（长跑章节多，比决策更密，给大一些） */
const MAX_RUNS = 1000;
/** 轨迹确认台账上限（每 3 章一条，几十条封顶） */
const MAX_TRACKS = 200;

/**
 * `running` 态超过这个时长就算僵死。
 *
 * 为什么需要它：进程被杀 / 断电时，那段状态会永久停在 `running` —— 界面显示「进行中」，
 * 而 `canRun` 又会以「正在跑」为由拦住重跑，作者就**彻底卡死在这一段**了（连重试按钮都不给）。
 * 实测一段约 2–3 分钟（cast 段 2m35s），20 分钟足够宽裕：真在跑的不会被误判，
 * 死掉的能自己收敛回「中断了，可重试」。
 */
export const RUNNING_STALE_MS = 20 * 60 * 1000;

/**
 * 稳定序列化：**键排序**后再 stringify。
 * 不这么做的话，同样的 brief 因为键序不同会得到不同的 hash —— 那会把「作者真的改了设定」
 * 和「对象的键顺序变了」混为一谈，闸门就会被无辜标成过期。
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 基线指纹。入参是**影响创作的原话**：开书设定 + 流派 + 作者开跑时补的话。
 * 任一变化 → 已通过的闸门应视为过期（见 PipelineState.briefHash 注释）。
 */
export function computeBriefHash(brief: unknown, genre: string, note: string): string {
  return createHash('sha256')
    .update(stableStringify({ brief: brief ?? null, genre: genre ?? '', note: note ?? '' }))
    .digest('hex')
    .slice(0, 16);
}

function emptyStage(): StageRecord {
  return { status: 'idle', revision: 0 };
}

export function emptyState(projectId: string, briefHash: string, note?: string): PipelineState {
  const stages = Object.fromEntries(STAGES.map((k) => [k, emptyStage()])) as Record<StageKey, StageRecord>;
  return {
    projectId,
    stage: 'brief',
    briefHash,
    stages,
    note,
    cursor: { lastDelivered: 0, sinceReview: 0, reviewEvery: 3 },
    updatedAt: Date.now(),
  };
}

export function nextStage(key: StageKey): StageKey | null {
  const i = STAGES.indexOf(key);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1]! : null;
}

export function prevStage(key: StageKey): StageKey | null {
  const i = STAGES.indexOf(key);
  return i > 0 ? STAGES[i - 1]! : null;
}

export class PipelineStore {
  constructor(
    private readonly kv: KvService,
    private readonly projectId: string,
  ) {}

  load(): PipelineState | undefined {
    const s = this.kv.get<PipelineState>(NS, KEY_STATE, { projectId: this.projectId });
    // 脏数据兜底：KV 里可能是旧版本写下的结构，缺字段会让后面全线崩
    if (!s || typeof s !== 'object' || !s.stages || typeof s.stages !== 'object') return undefined;
    for (const k of STAGES) if (!s.stages[k]) s.stages[k] = emptyStage();
    if (!s.cursor || typeof s.cursor.reviewEvery !== 'number') {
      s.cursor = { lastDelivered: 0, sinceReview: 0, reviewEvery: 3 };
    }
    this.sweepStaleRunning(s);
    return s;
  }

  /**
   * 僵死 running 收敛：超时的运行态就地改成「中断了，可重试」。
   *
   * 只在内存里改、不在这里落盘（load 是同步的）—— 每次读都会重新收敛一遍，
   * 下一次 save 自然把它带下去。好处是**所有消费者看到的状态都一致且诚实**：
   * 不会有人看到「进行中」却什么也没在跑。
   */
  private sweepStaleRunning(state: PipelineState): void {
    const now = Date.now();
    for (const k of STAGES) {
      const rec = state.stages[k];
      if (rec.status !== 'running') continue;
      if (now - (rec.runningSince ?? 0) <= RUNNING_STALE_MS) continue;
      rec.status = 'failed';
      rec.runningSince = undefined;
      rec.error = '上一次运行没有跑完（服务重启或进程被杀）—— 可以重试这一段';
    }
  }

  /**
   * 标记某段开始跑（**跑之前必须落盘**）。
   *
   * ★ 这是防重复烧额度的唯一一道锁：界面上的按钮禁用只防住当前这个标签页，
   *   开两个标签页、或者跑的中途刷新，都会再点一次「跑这一段」。
   */
  async beginStage(state: PipelineState, stage: StageKey): Promise<void> {
    const rec = state.stages[stage];
    rec.status = 'running';
    rec.runningSince = Date.now();
    rec.error = undefined;
    rec.startedAt = Date.now();
    state.stage = stage;
    await this.save(state);
  }

  async save(state: PipelineState): Promise<void> {
    state.updatedAt = Date.now();
    await this.kv.set(NS, KEY_STATE, state, { projectId: this.projectId });
  }

  /**
   * 取状态（没有就按当前基线新建）。
   *
   * 返回 `baselineMismatch`：当前 brief 的 hash 与流水线记录的不一致 ——
   * **不在这里自动重置**，只报告，让作者决定从哪段重跑（自动重置会静默丢掉已批准的内容）。
   */
  async ensure(briefHash: string, note?: string): Promise<{ state: PipelineState; baselineMismatch: boolean }> {
    let state = this.load();
    if (!state) {
      state = emptyState(this.projectId, briefHash, note);
      await this.save(state);
      return { state, baselineMismatch: false };
    }
    return { state, baselineMismatch: state.briefHash !== briefHash };
  }

  /**
   * 从某段开始作废已批准的产出（基线变了 + 作者从这段重跑 → 这段及之后的批准全部失效）。
   * 更早的阶段保留 approved：作者真想全重跑，从更早的段开始即可。
   */
  invalidateFrom(state: PipelineState, from: StageKey): StageKey[] {
    const idx = STAGES.indexOf(from);
    const stale: StageKey[] = [];
    for (const k of STAGES.slice(idx)) {
      const rec = state.stages[k];
      if (rec.status === 'approved') {
        rec.status = 'idle';
        rec.sinked = false;
        stale.push(k);
      }
    }
    return stale;
  }

  // ---- 闸门决策台账 ----

  getDecisions(): DecisionEntry[] {
    const rows = this.kv.get<DecisionEntry[]>(NS, KEY_DECISIONS, { projectId: this.projectId });
    return Array.isArray(rows) ? rows : [];
  }

  async appendDecision(entry: DecisionEntry): Promise<void> {
    const log = this.getDecisions();
    log.push(entry);
    const trimmed = log.length > MAX_DECISIONS ? log.slice(log.length - MAX_DECISIONS) : log;
    await this.kv.set(NS, KEY_DECISIONS, trimmed, { projectId: this.projectId });
  }

  // ---- 阶段运行留痕（迁移自旧 flow-store 的 audit: 台账）----

  getRuns(): RunEntry[] {
    const rows = this.kv.get<RunEntry[]>(NS, KEY_RUNS, { projectId: this.projectId });
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * 追加一条运行留痕。
   * ★ 绝不抛：留痕是旁路，记账失败不该反过来把一次成功的运行判成失败
   *   （与 memory gate 的审计同款取向）。
   */
  async appendRun(entry: RunEntry): Promise<void> {
    try {
      const log = this.getRuns();
      log.push(entry);
      const trimmed = log.length > MAX_RUNS ? log.slice(log.length - MAX_RUNS) : log;
      await this.kv.set(NS, KEY_RUNS, trimmed, { projectId: this.projectId });
    } catch {
      // 留痕失败不致命
    }
  }

  // ---- 轨迹确认台账（production 每 N 章一条）----

  getTracks(): TrackEntry[] {
    const rows = this.kv.get<TrackEntry[]>(NS, KEY_TRACKS, { projectId: this.projectId });
    return Array.isArray(rows) ? rows : [];
  }

  /** 追加一条轨迹确认。与 appendRun 同款取向：留痕失败不该把一次成功的确认判成失败。 */
  async appendTrack(entry: TrackEntry): Promise<void> {
    try {
      const log = this.getTracks();
      log.push(entry);
      const trimmed = log.length > MAX_TRACKS ? log.slice(log.length - MAX_TRACKS) : log;
      await this.kv.set(NS, KEY_TRACKS, trimmed, { projectId: this.projectId });
    } catch {
      // 留痕失败不致命
    }
  }

  /**
   * 应用一次闸门决策。
   *
   * 语义（设计 §2 的三态）：
   *   approve —— 本段定稿，游标推进到下一段
   *   revise  —— 带批注重跑本段（revision++，上限 REVISION_LIMIT）
   *   reject  —— 退回上一段（本段与更晚的产出作废）
   *
   * ★ 撞上修订上限不硬撑也不丢弃：把状态交回作者（返回 hitLimit），由调用方提示
   *   「按现状继续 / 放弃这段」—— 沿用「丢章比带瑕疵更糟」的取向。
   */
  applyDecision(
    state: PipelineState,
    stage: StageKey,
    action: DecisionAction,
  ): { movedTo?: StageKey; hitLimit?: boolean; invalidated: StageKey[] } {
    const rec = state.stages[stage];
    let movedTo: StageKey | undefined;
    let hitLimit = false;
    let invalidated: StageKey[] = [];

    if (action === 'approve') {
      rec.status = 'approved';
      rec.error = undefined;
      rec.finishedAt = Date.now();
      const nx = nextStage(stage);
      if (nx) {
        state.stage = nx;
        movedTo = nx;
      }
    } else if (action === 'revise') {
      rec.revision += 1;
      hitLimit = rec.revision >= REVISION_LIMIT;
      // 状态回到 idle：允许重跑；契约文本留着当参考，approved 标记撤销
      rec.status = 'idle';
      rec.runningSince = undefined;
      rec.sinked = false;
      state.stage = stage;
    } else {
      // 退回上一段：本段的产出作废（状态必须一起重置 —— 否则会出现
      // 「游标已经回到上一段，这一段却还挂着等确认」的鬼状态）
      rec.status = 'idle';
      rec.runningSince = undefined;
      rec.sinked = false;
      const pv = prevStage(stage);
      if (pv) {
        const prevWasApproved = state.stages[pv].status === 'approved';
        state.stages[pv].revision += 1;
        state.stages[pv].status = 'idle';
        state.stages[pv].runningSince = undefined;
        state.stages[pv].sinked = false;
        // 上一段的批准也算被撤销了（它确实从 approved 变成了 idle），要如实报出来
        invalidated = [...new Set<StageKey>([
          stage,
          ...(prevWasApproved ? [pv] : []),
          ...this.invalidateFrom(state, stage),
        ])];
        state.stage = pv;
        movedTo = pv;
      } else {
        // 已经是第一段：退无可退，等价于重跑本段
        rec.revision += 1;
        state.stage = stage;
      }
    }
    return { movedTo, hitLimit, invalidated };
  }

  /** 对外视图：把状态翻译成 UI 要的形状（含「哪些已批准但基线已变」） */
  view(state: PipelineState, currentBriefHash: string): PipelineView {
    const mismatch = state.briefHash !== currentBriefHash;
    const approved = STAGES.filter((k) => state.stages[k].status === 'approved');
    return {
      projectId: state.projectId,
      stage: state.stage,
      stageLabel: STAGE_LABEL[state.stage],
      briefHash: state.briefHash,
      staleStages: mismatch ? approved : [],
      stages: STAGES.map((k) => ({
        key: k,
        label: STAGE_LABEL[k],
        status: state.stages[k].status,
        revision: state.stages[k].revision,
        gated: GATED_STAGES.includes(k),
        implemented: IMPLEMENTED_STAGES.includes(k),
        artifact: state.stages[k].artifact,
        ...(state.stages[k].driftCounts ? { driftCounts: state.stages[k].driftCounts } : {}),
        ...(state.stages[k].pilotChapters ? { pilotChapters: state.stages[k].pilotChapters } : {}),
        ...(state.stages[k].premiereVerdict ? { premiereVerdict: state.stages[k].premiereVerdict } : {}),
        ...(state.stages[k].productionChapters ? { productionChapters: state.stages[k].productionChapters } : {}),
        ...(state.stages[k].supervisorVerdict ? { supervisorVerdict: state.stages[k].supervisorVerdict } : {}),
        ...(state.stages[k].supervisorHalted ? { supervisorHalted: true } : {}),
        error: state.stages[k].error,
      })),
      decisions: this.getDecisions().slice(-20).reverse(),
      runs: this.getRuns().slice(-20).reverse(),
      tracks: this.getTracks().slice(-20).reverse(),
      reviewEvery: state.cursor.reviewEvery,
      lastDelivered: state.cursor.lastDelivered ?? 0,
      updatedAt: state.updatedAt,
    };
  }
}

/**
 * 能否跑这个阶段。
 *
 * ★ 这里踩过一次：最初只判断「该阶段状态是 idle」，于是**跳着跑也放行了**
 *   （游标还在 brief，bible 是 idle → 认为可以跑），实测直接跑掉了一整段讨论。
 *   正确口径是「**不能超过游标**」：只允许跑游标所在的那一段，或**往回**重跑更早的段
 *   （重跑更早的段会作废它之后已批准的产出，语义见 invalidateFrom）。
 */
export function canRun(state: PipelineState, stage: StageKey): { ok: boolean; reason?: string } {
  const cur = STAGES.indexOf(state.stage);
  const target = STAGES.indexOf(stage);
  if (target < 0) return { ok: false, reason: `未知阶段 ${stage}` };
  if (target > cur) {
    return {
      ok: false,
      reason: `当前推进到「${STAGE_LABEL[state.stage]}」，不能跳着跑「${STAGE_LABEL[stage]}」`,
    };
  }
  const rec = state.stages[stage];
  if (rec.status === 'running') return { ok: false, reason: '该阶段正在跑' };
  if (rec.status === 'awaiting_user') return { ok: false, reason: '该阶段等待你的确认（先批准或打回）' };
  return { ok: true };
}
