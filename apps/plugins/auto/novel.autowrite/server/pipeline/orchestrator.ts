// ============================================================
// 阶段编排 —— 一轮「立设定」会话
//
// 事件流（SSE）：
//   { type:'stage_start' }      → { type:'stage_phase' } 正在做什么
//   → { type:'stage_turn' }     某个角色的完整发言（交流流）
//   → { type:'stage_summary' }  定稿官的契约文本（中栏卡片）
//   → { type:'awaiting_user' }  停下来等作者确认（G1/G2/G3）
//
// ★ 与 discuss/orchestrator 的分工：那个跑**一章**，这个跑**一段设定**。
//   共用 context-resolver（供数防幻觉）、entity-sink 的思路（保守落库）、相同的失败取向。
// ★ 闸门之前**不落库**：被作者否掉的东西不该进项目库（approveStage 才落）。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { getProjectDb } from '@novel/db';
import type { DesignRole } from '../discuss/roles.js';
import { formatBrief, resolveSettingsDigest, type SettingsDigest } from '../framework/context-resolver.js';
import { readDigestFor } from '../framework/memory/digest-gate.js';
import { createAgentSkillResolver } from '../framework/agent-skills.js';
import { createAgentMemory, createMemoryGate, experience, writeAudit, fingerprintOf } from '../framework/memory/index.js';
import {
  GATED_STAGES, REVISION_LIMIT, STAGE_LABEL, type PipelineEvent, type PipelineState, type SinkStats, type StageKey,
} from './types.js';
import {
  buildAssertions, mergeDriftReport, parseJudgments, renderAssertions, summarizeDrift,
  type DriftJudgment, type DriftReport,
} from './drift.js';
import { readProjectBriefRaw } from '../framework/context-resolver.js';
import { extractFirstJson } from '../framework/text.js';
import { pilotSinkNotes, runPilot } from './pilot.js';
import { productionSinkNotes, runProduction } from './production.js';
import { STAGE_SPEAK_MAX_TOKENS, specFor } from './roles-phase.js';
import { nextStage, PipelineStore, computeBriefHash } from './store.js';
import { sinkStageArtifact } from './sink.js';

/** 单个前置阶段产出物注入上限：三段都塞进上下文会贵到离谱，也要防被截断误导 */
const ARTIFACT_INJECT_MAX = 4000;
/** 全部前置产出物的总上限 */
const ARTIFACT_TOTAL_MAX = 9000;

/** 带工具的角色需要多转几轮查库（与单章链路同口径） */
function turnsFor(role: DesignRole): number {
  // ★ 2026-09-17 修：无工具角色原来只给 2 轮，实测**推理模型会被卡死** ——
  //   cast 阶段第一个发言人「角色设计师」（无工具）直接
  //   `Max turns (2) exceeded`，整条流水线在第 2 阶段就断。
  //   推理模型（如 glm-5.3-flash）一次响应里会先出 reasoning 再出正文，
  //   框架按"模型调用次数"计轮，2 轮对它是紧的。
  //   给到 4：仍然是有界预算（防跑飞），但留出了推理模型的余量。
  //   有工具的角色维持 6（要查库，本来就多轮）。
  return role.tools && role.tools.length > 0 ? 6 : 4;
}

function cut(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…（已截断）';
}

export interface StageRunOpts {
  stage: StageKey;
  projectId: string;
  userId: string;
  /** 作者为本轮补的话（可选） */
  extra?: string;
  /** 上一轮「带批注打回」的批注：重跑时必须进提示词，否则改了等于没改 */
  revisionNote?: string;
}

/**
 * 跑一个阶段：讨论 → 收敛 → 存契约 → 停下等作者。
 *
 * 所有阶段的产出物（artifact）都存进流水线状态，**不落项目库**。
 * 落库发生在 `approveStage()`（作者点头之后）。
 */
export async function runStage(
  ctx: ServerPluginContext,
  opts: StageRunOpts,
  emit: (e: PipelineEvent) => void,
): Promise<void> {
  const { stage, projectId, userId } = opts;
  const store = new PipelineStore(ctx.db.kv, projectId);

  // ---- 本次运行的留痕计数（迁移自旧 flow-store 的 audit: 台账）----
  const runStart = Date.now();
  let runTurns = 0;
  let runModel: string | undefined;
  /** 收尾时统一落一条运行留痕（绝不因留痕失败影响主流程） */
  const finishRun = async (outcome: 'awaiting_user' | 'approved' | 'failed', error?: string) => {
    await store.appendRun({
      stage, at: Date.now(), by: userId, turns: runTurns,
      ...(runModel ? { model: runModel } : {}),
      ms: Date.now() - runStart, outcome,
      ...(error ? { error: error.slice(0, 300) } : {}),
    });
  };

  // ★ 全项目第一个动作：确保项目库已打开（`ctx.db.project()` 是同步只读，新项目返回 null）
  try {
    await getProjectDb(projectId);
  } catch (e) {
    console.warn('[pipeline] 打开项目库失败（后续按空库处理）:', e);
  }

  let digest: SettingsDigest;
  try {
    digest = await resolveSettingsDigest(ctx, projectId);
  } catch (e) {
    console.warn('[pipeline] 读取项目设定失败（多为空项目库），按空库处理:', e);
    digest = {
      projectName: '', genre: '', characters: '（暂无角色设定）',
      foreshadows: '（暂无伏笔）', outline: '（暂无大纲）', chapters: '（暂无章节）',
    };
  }

  const briefText = digest.brief ?? '';
  if (!briefText) {
    emit({
      type: 'stage_failed',
      stage,
      message: '这本书还没有开书设定（书名/开局/世界观/笔风/主角/女主/流派）。'
        + '这条流水线的起点就是它 —— 请先在「编辑书籍」里补全，否则立出来的设定会凭空长出来。',
    });
    await finishRun('failed', '缺少开书设定');
    return;
  }

  // ---- Stage5 · 前三章试写：先分流，不走"讨论 → 收敛"那套 ----
  //   pilot 复用**单章闭环**跑三章（见 pilot.ts 顶部注释），产出物是跨章审阅报告。
  //   必须放在 specFor 之前 —— 后面的 headerFor/buildHeader 是"立设定"专用的组装，
  //   对 pilot 没意义（每章的上下文由单章闭环自己装配）。
  if (stage === 'pilot') {
    await runPilotStage(ctx, { projectId, userId, extra: opts.extra, revisionNote: opts.revisionNote, store }, emit);
    // pilot 的成败由它自己写进 stage 记录；这里据实落一条运行留痕
    const pilotRec = store.load()?.stages.pilot;
    await finishRun(pilotRec?.status === 'failed' ? 'failed' : 'awaiting_user', pilotRec?.error);
    return;
  }

  // ---- Stage6 · 长跑：与 pilot 同构，也是"真的写库"，只是批次更大、外加监工/轨迹确认 ----
  if (stage === 'production') {
    await runProductionStage(ctx, { projectId, userId, extra: opts.extra, revisionNote: opts.revisionNote, store }, emit);
    const prodRec = store.load()?.stages.production;
    await finishRun(prodRec?.status === 'failed' ? 'failed' : 'awaiting_user', prodRec?.error);
    return;
  }

  const spec = specFor(stage);
  if (!spec) {
    emit({ type: 'stage_failed', stage, message: `「${STAGE_LABEL[stage]}」阶段尚未实现` });
    await finishRun('failed', '阶段尚未实现');
    return;
  }

  // ---- 组装输入（作者设定 + 已定稿的前置阶段 + 本轮批注）----
  // ★ 记忆闸门（2026-09-13 接线）：**每个角色各拿一份被裁剪过的项目现状**，
  //   并在 memory_audit 留下「谁在讨论用途下读了什么」。复用已取到的 digest，
  //   所以裁剪本身不产生额外查询；宽度原则见 roles.ts 的 memory 声明注释。
  const gate = createMemoryGate(ctx);
  const headerCache = new Map<string, string>();
  const headerFor = async (agentId: string): Promise<string> => {
    const hit = headerCache.get(agentId);
    if (hit !== undefined) return hit;
    const { digest: allowed } = await readDigestFor(ctx, projectId, agentId, 'discuss-context', {
      narrative: false,          // 流水线是"立设定"阶段，不带章节正文
      load: async () => digest,
    });
    const text = buildHeader({
      digest: allowed as SettingsDigest,
      briefText: (allowed.brief as string | undefined) ?? '',
      state: store.load(), stage, extra: opts.extra, revisionNote: opts.revisionNote,
    });
    headerCache.set(agentId, text);

    // ★ A4：装配指纹（与写章链路同一口径）。此前只接在 discuss 侧，
    //   流水线这边漏了 → 面板上一条 assemble 都没有（GUI 走查发现）。
    try {
      await writeAudit(ctx, {
        projectId, agentId, action: 'assemble', keys: Object.keys(allowed),
        reason: 'discuss-context', allow: true,
        detail: `注入 ${text.length} 字（${stage}）`,
        fingerprint: fingerprintOf(text),
      });
    } catch (e) {
      console.warn('[pipeline] 装配指纹写入失败（不影响本段）:', e);
    }
    return text;
  };
  /** L2：记「这个角色这一轮说了什么」（失败不影响本段讨论） */
  const memoryOf = (agentId: string) => createAgentMemory({ ctx, projectId, agentId, gate });
  /** 已启用技能解析器（"智能体 Skills"的开关 → system prompt；本次运行内缓存） */
  const agentSkills = createAgentSkillResolver(ctx, userId);

  // ---- drift（偏离核查）专用：逐条断言 + 收集各角色的机器可读判定 ----
  //   ★ 断言来自 brief 的**字段**（确定性生成，零成本）：见 drift.ts buildAssertions 的注释
  const driftAssertions = stage === 'drift' ? buildAssertions(await readProjectBriefRaw(ctx, projectId)) : [];
  const driftJudgments: DriftJudgment[] = [];
  const parseSpeakerJudgments = (text: string): DriftJudgment[] => {
    try {
      const json = extractFirstJson(text);
      if (!json) return [];
      const parsed = JSON.parse(json) as { judgments?: unknown };
      return parseJudgments(parsed.judgments, driftAssertions);
    } catch (e) {
      console.warn('[drift] 该角色的判定无法解析（按未判定处理）:', e);
      return [];
    }
  };

  const transcript: Array<{ name: string; text: string }> = [];
  const buildInput = (header: string, role: DesignRole, extra?: string): string => {
    const parts: string[] = [header];
    if (transcript.length > 0) {
      parts.push('【本轮讨论记录】');
      for (const t of transcript) parts.push(`◆ ${t.name}：\n${t.text}\n`);
    }
    if (extra) parts.push(extra);
    parts.push(`现在轮到你（${role.name}）发言。`);
    return parts.join('\n');
  };

  const speak = async (role: DesignRole, extra?: string): Promise<string> => {
    emit({ type: 'stage_phase', stage, label: `${role.name}发言中` });
    const roleHeader = await headerFor(role.key);
    const result = await ctx.ai.agents.run({
      // ★ 已启用技能拼进 system（与写章链路同一口径，改一处必须改另一处）
      system: await agentSkills.systemFor(role.key, role.system),
      input: buildInput(roleHeader, role, extra),
      tools: role.tools,
      maxTurns: turnsFor(role),
      maxTokens: STAGE_SPEAK_MAX_TOKENS,
      context: { projectId, userId },
    });
    runTurns += 1;
    if (!runModel && result.model) runModel = result.model;
    const text = String(result.text ?? '').trim();
    if (!text) throw new Error(`${role.name}未产出内容（可能是模型调用失败）`);
    transcript.push({ name: role.name, text });
    // L2 经历流：记「它自己说了什么」（失败不影响本段讨论 —— 记忆是旁路）
    try {
      await memoryOf(role.key).writeOwn(experience(`exp.stage.${stage}.turn${transcript.length}`, {
        kind: 'said', text: text.slice(0, 2000), ref: `${stage}#turn${transcript.length}`,
      }));
    } catch (e) {
      console.warn('[pipeline] 写 L2 经历失败（不影响本段）:', e);
    }
    emit({
      type: 'stage_turn',
      stage,
      agent: role.key,
      name: role.name,
      color: role.color,
      short: role.short,
      text,
      meta: result.model ? `模型 ${result.model}` : undefined,
    });
    return text;
  };

  try {
    // ★ 跑之前先把状态落成 running：这是防「两个标签页/刷新后重复跑同一段」的唯一一道锁
    //   （界面上的按钮禁用只护得住当前这个标签页）。僵死 running 由 store.load() 自动收敛。
    const started = store.load();
    if (started) await store.beginStage(started, stage);

    emit({ type: 'stage_start', stage, revision: store.load()?.stages[stage]?.revision ?? 0 });

    // 主笔 → 其余角色依次回应（每个角色都能看到前面人的发言）
    for (const role of spec.speakers) {
      // drift：把断言清单 + 库事实对照物塞给它，并要求逐条回 JSON 判定
      const extra = stage === 'drift'
        ? [
            '【断言清单（逐条判定，id 必须原样回填）】',
            renderAssertions(driftAssertions),
            '',
            '【L3 对照物：项目库事实】',
            digest.characters || '（暂无角色）',
            digest.foreshadows || '（暂无伏笔）',
          ].join('\n')
        : undefined;
      const said = await speak(role, extra);
      if (stage === 'drift') driftJudgments.push(...parseSpeakerJudgments(said));
    }

    // 主笔针对质疑正面回应 —— 没有这一轮就只是各交一份报告，不构成讨论
    if (spec.rebuttal) {
      await speak(spec.rebuttal.role, spec.rebuttal.extra);
    }

    // 收敛成契约（drift 是"合并报告"，把机器可读的判定一并交给定稿官，避免它自己编）
    emit({ type: 'stage_phase', stage, label: '收敛本段结论' });
    const driftReport: DriftReport = stage === 'drift'
      ? mergeDriftReport(driftJudgments)
      : { hard: [], soft: [], backTo: null, counts: { total: 0, 符合: 0, 偏离: 0, 库中无依据: 0 } };
    const convenerExtra = stage === 'drift'
      ? [
          '【三位核查角色的逐条判定（机器合并后的结果，别改动它）】',
          `硬偏离：${driftReport.hard.length} 条 → ${driftReport.hard.map((j) => `${j.id}${j.backTo ? `(回修 ${j.backTo})` : ''}`).join('、') || '无'}`,
          `软偏离：${driftReport.soft.length} 条 → ${driftReport.soft.map((j) => j.id).join('、') || '无'}`,
          `统计：${summarizeDrift(driftReport)}`,
          '',
          '请据此写《偏离报告》：硬偏离逐条写清"断言 → 冲突在哪 → 建议回修哪一段"，软偏离进"待定"。',
        ].join('\n')
      : undefined;
    const artifact = await speak(spec.convener, convenerExtra);
    emit({ type: 'stage_summary', stage, text: artifact });

    const state = store.load();
    if (!state) throw new Error('流水线状态丢失，请重新启动');
    const rec = state.stages[stage];
    rec.artifact = artifact;
    rec.runningSince = undefined;
    rec.finishedAt = Date.now();
    rec.error = undefined;

    if (GATED_STAGES.includes(stage)) {
      // 有闸门：等作者确认（★ 此时不落库）
      rec.status = 'awaiting_user';
      await store.save(state);
      emit({ type: 'awaiting_user', stage, summary: artifact, revision: rec.revision, revisionLimit: REVISION_LIMIT });
      await finishRun('awaiting_user');
      return;
    }

    // ---- 无闸门阶段（当前只有 drift）：自动过；有硬偏离就把游标退回需要回修的那一段 ----
    if (stage === 'drift') {
      rec.driftCounts = {
        total: driftReport.counts.total,
        符合: driftReport.counts.符合,
        偏离: driftReport.counts.偏离,
        库中无依据: driftReport.counts.库中无依据,
        hard: driftReport.hard.length,
        soft: driftReport.soft.length,
      };
    }
    rec.status = 'approved';
    rec.sinked = true;                 // drift 的"落库"就是报告本身，已写进 artifact
    // ★ 游标要**自己推进**：闸门阶段的推进是作者 approve 时做的，非闸门阶段没人替它做 ——
    //   漏了这一步，drift 跑完游标还停在 drift，下一段永远跑不了（真机断言抓到过）。
    const advanced = nextStage(stage);
    if (advanced) state.stage = advanced;
    await store.save(state);

    emit({ type: 'stage_auto_approved', stage, summary: summarizeDrift(driftReport) });
    await finishRun('approved');

    if (driftReport.hard.length > 0 && driftReport.backTo) {
      const backTo = driftReport.backTo as StageKey;
      const back = state.stages[backTo];
      if (back) {
        // 那段要重修 → 游标退回 + 该段闸门作废（连着后面的批准一起失效）
        back.status = 'idle';
        back.sinked = false;
        back.artifact = undefined;
        back.error = undefined;
        state.stage = backTo;
        const invalidated = store.invalidateFrom(state, backTo);
        // ★ invalidateFrom 会把 backTo **之后**的所有段作废 —— 包括 drift 自己。
        //   但报告是这次核查的产物：作者回去重修时，正是靠它知道"为什么要修"。
        //   所以这里把 drift 自己的记录恢复回来（真机断言抓到过：报告被自己的回退抹掉了）。
        const self = state.stages[stage];
        self.status = 'approved';
        self.artifact = artifact;
        self.sinked = true;
        self.error = undefined;
        await store.save(state);
        emit({
          type: 'stage_drift_blocked',
          stage,
          backTo,
          message: `偏离核查发现 ${driftReport.hard.length} 处**硬偏离** → 已退回「${STAGE_LABEL[backTo]}」重修`
            + (invalidated.length > 0 ? `（作废了 ${invalidated.length} 段的批准）` : ''),
          hard: driftReport.hard.length,
          soft: driftReport.soft.length,
        });
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const state = store.load();
    if (state) {
      state.stages[stage].status = 'failed';
      state.stages[stage].runningSince = undefined;
      state.stages[stage].error = message;
      await store.save(state);
    }
    emit({ type: 'stage_failed', stage, message });
    await finishRun('failed', message);
  }
}

/**
 * Stage5 的编排壳：把 `runPilot`（三章串行 + 跨章审阅）接到阶段状态机上。
 *
 * 与讨论型阶段的差别只有三处：
 *   1. 产出物 = 跨章审阅报告（不是"定稿官的契约"）；
 *   2. **它真的会写库** —— 三章正文由单章闭环交付落库。这是唯一一个"闸门前就落库"的阶段，
 *      因为"试写"这件事本身就是产出正文；不落库就没法拿来看（也就失去了试写的意义）。
 *      代价是：作者若在 G4 否掉，已交的三章要人工删 —— 权衡下来仍比"看不见正文的试写"好。
 *   3. 没有"带批注重跑"的重跑语义差别：重跑本段会**接着已有的章号继续写 3 章**。
 */
async function runPilotStage(
  ctx: ServerPluginContext,
  o: { projectId: string; userId: string; extra?: string; revisionNote?: string; store: PipelineStore },
  emit: (e: PipelineEvent) => void,
): Promise<void> {
  const { projectId, userId, store } = o;
  const stage: StageKey = 'pilot';

  try {
    const started = store.load();
    if (started) await store.beginStage(started, stage);
    emit({ type: 'stage_start', stage, revision: store.load()?.stages[stage]?.revision ?? 0 });

    // 已批准的宪章/圣经/总纲：跨章审阅判断"漂没漂"的基准（正文里看不到这些）
    const st = store.load();
    const contracts: Array<{ label: string; text: string }> = [];
    for (const k of ['cast', 'bible', 'plot'] as StageKey[]) {
      const art = st?.stages[k]?.artifact;
      if (art && st?.stages[k]?.status === 'approved') contracts.push({ label: STAGE_LABEL[k], text: cut(art, ARTIFACT_INJECT_MAX) });
    }

    // 作者上一轮的批注：重跑本段时必须生效（否则"改了等于没改"）
    const extra = [o.extra, o.revisionNote ? `【作者上一轮批注】\n${o.revisionNote}` : '']
      .filter(Boolean).join('\n\n') || undefined;

    const outcome = await runPilot(ctx, {
      projectId, userId, extra,
      lastDelivered: st?.cursor.lastDelivered ?? 0,
      contracts,
    }, emit);

    const state = store.load();
    if (!state) throw new Error('流水线状态丢失，请重新启动');
    const rec = state.stages[stage];
    rec.artifact = outcome.artifact;
    rec.pilotChapters = outcome.chapters;
    if (outcome.premiere) {
      rec.premiereVerdict = {
        verdict: outcome.premiere.verdict,
        issues: outcome.premiere.issues.length,
        kinds: [...new Set(outcome.premiere.issues.map((i) => i.kind))],
      };
    }
    rec.runningSince = undefined;
    rec.finishedAt = Date.now();
    // ★ 已交付 ≠ 已落库：这里用"三章都交上了"作为 sinked 的判据（口径见 pilotSinkNotes）
    const notes = pilotSinkNotes(outcome.chapters);
    rec.sinked = notes.length === 0;
    rec.error = notes.length ? notes.join('；') : undefined;

    // 长跑游标：pilot 是长跑的起点，游标不写 M3 无从知道从第几章接
    const lastOrder = outcome.chapters.filter((c) => c.delivered).map((c) => c.order).pop();
    if (lastOrder) state.cursor.lastDelivered = Math.max(state.cursor.lastDelivered, lastOrder);

    rec.status = 'awaiting_user';
    await store.save(state);

    emit({
      type: 'awaiting_user',
      stage,
      summary: outcome.artifact,
      revision: rec.revision,
      revisionLimit: REVISION_LIMIT,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const state = store.load();
    if (state) {
      state.stages[stage].status = 'failed';
      state.stages[stage].runningSince = undefined;
      state.stages[stage].error = message;
      await store.save(state);
    }
    emit({ type: 'stage_failed', stage, message });
  }
}

/**
 * Stage6 长跑的编排壳：把 `runProduction`（一批章节 + 监工 + 轨迹确认）接到阶段状态机上。
 *
 * 与 pilot 壳的差别：
 *   1. **有断点续跑** —— 游标 `cursor.lastDelivered` 决定从第几章接，`sinceReview` 决定
 *      还差几章做轨迹确认。两者都在 KV 里，进程被杀也不丢。
 *   2. 监工 `halt` **不再打断**长跑（2026-10-16 改）：改为记台账（`supervisorHalted=true`）
 *      + 就地跑一次轨迹确认取修正补丁 + 补丁注入后续每一章。原因：严格监工几乎每章都给
 *      watch/halt，若 halt 就停，30 万字长跑结构上跑不完。
 *   3. 轨迹确认 `minor_drift` 的补丁写进 `pendingPatch`，下一批注入（halt 触发的那次则立即生效）。
 */
async function runProductionStage(
  ctx: ServerPluginContext,
  o: { projectId: string; userId: string; extra?: string; revisionNote?: string; store: PipelineStore },
  emit: (e: PipelineEvent) => void,
): Promise<void> {
  const { projectId, userId, store } = o;
  const stage: StageKey = 'production';

  try {
    const started = store.load();
    if (started) await store.beginStage(started, stage);
    emit({ type: 'stage_start', stage, revision: store.load()?.stages[stage]?.revision ?? 0 });

    const st = store.load();
    // 已批准的宪章/圣经/总纲：轨迹确认判断"偏没偏"的基准
    const contracts: Array<{ label: string; text: string }> = [];
    for (const k of ['cast', 'bible', 'plot'] as StageKey[]) {
      const art = st?.stages[k]?.artifact;
      if (art && st?.stages[k]?.status === 'approved') contracts.push({ label: STAGE_LABEL[k], text: cut(art, ARTIFACT_INJECT_MAX) });
    }

    // 上一轮轨迹确认留下的补丁（minor_drift）：本批必须遵守
    const pendingPatch = st ? lastTrackPatch(store) : undefined;

    const extra = [o.extra, o.revisionNote ? `【作者上一轮批注】\n${o.revisionNote}` : '']
      .filter(Boolean).join('\n\n') || undefined;

    const outcome = await runProduction(ctx, {
      projectId, userId, extra,
      lastDelivered: st?.cursor.lastDelivered ?? 0,
      sinceReview: st?.cursor.sinceReview ?? 0,
      reviewEvery: st?.cursor.reviewEvery ?? 3,
      contracts,
      ...(pendingPatch ? { pendingPatch } : {}),
    }, emit);

    const state = store.load();
    if (!state) throw new Error('流水线状态丢失，请重新启动');
    const rec = state.stages[stage];
    rec.artifact = outcome.artifact;
    rec.productionChapters = outcome.chapters;
    rec.supervisorVerdict = outcome.supervisor ?? undefined;
    rec.supervisorHalted = outcome.halted;
    rec.runningSince = undefined;
    rec.finishedAt = Date.now();

    // 断点续跑：把游标与轨迹计数写回（这是"进程被杀也不丢"的落点）
    state.cursor.lastDelivered = Math.max(state.cursor.lastDelivered, outcome.cursor);
    state.cursor.sinceReview = outcome.sinceReview;

    const notes = productionSinkNotes(outcome.chapters);
    rec.sinked = notes.length === 0;
    rec.error = notes.length ? notes.join('；') : undefined;

    // 轨迹确认记录进台账（append-only，回放用）
    if (outcome.track) await store.appendTrack(outcome.track);

    rec.status = 'awaiting_user';
    await store.save(state);

    emit({
      type: 'awaiting_user',
      stage,
      summary: outcome.artifact,
      revision: rec.revision,
      revisionLimit: REVISION_LIMIT,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const state = store.load();
    if (state) {
      state.stages[stage].status = 'failed';
      state.stages[stage].runningSince = undefined;
      state.stages[stage].error = message;
      await store.save(state);
    }
    emit({ type: 'stage_failed', stage, message });
  }
}

/** 最近一条 minor_drift 轨迹确认的补丁（供下一批注入）；没有就 undefined */
function lastTrackPatch(store: PipelineStore): string | undefined {
  const tracks = store.getTracks();
  const last = [...tracks].reverse().find((t) => t.verdict === 'minor_drift' && t.patch);
  return last?.patch;
}

/** 组装阶段输入：作者设定 + 已定稿的前置阶段产出 + 本轮批注 */
function buildHeader(o: {
  digest: SettingsDigest;
  briefText: string;
  state: PipelineState | undefined;
  stage: StageKey;
  extra?: string;
  revisionNote?: string;
}): string {
  const parts: string[] = [];

  parts.push('【作者的开书设定（这是定论：与之冲突的一律以它为准）】');
  parts.push(o.briefText);
  if (o.digest.projectName) parts.push(`书名：${o.digest.projectName}`);

  // 已定稿的前置阶段：让世界圣经建立在角色宪章之上、剧情总纲建立在两者之上
  const order: StageKey[] = ['cast', 'bible', 'plot'];
  const priorTexts: string[] = [];
  let budget = ARTIFACT_TOTAL_MAX;
  for (const k of order) {
    if (k === o.stage) break;
    const art = o.state?.stages[k]?.artifact;
    if (!art || o.state?.stages[k]?.status !== 'approved') continue;
    const piece = cut(art, Math.min(ARTIFACT_INJECT_MAX, budget));
    budget -= piece.length;
    if (budget <= 0) {
      priorTexts.push(`（已定稿的《${STAGE_LABEL[k]}》因篇幅过长被省略，需要时用工具查库）`);
      break;
    }
    priorTexts.push(`【已定稿的《${STAGE_LABEL[k]}》】\n${piece}`);
  }
  if (priorTexts.length > 0) {
    parts.push('', '【前置阶段已定稿的产出（必须与它们一致，不要另起炉灶）】');
    parts.push(priorTexts.join('\n\n'));
  } else if (o.stage !== 'cast') {
    parts.push('', '【前置阶段】无 —— 说明这是第一段设定，一切从这里立起来。');
  }

  // 项目库里已有什么（供设定管家核对，且明确告知"没有就是真没有"）
  parts.push(
    '',
    '【项目库现状（框架直接读取，不是你的记忆）】',
    `已有角色：\n${o.digest.characters}`,
    '',
    `已有大纲：\n${o.digest.outline}`,
    '',
    `已有伏笔：\n${o.digest.foreshadows}`,
  );

  if (o.revisionNote) {
    parts.push(
      '',
      '【作者上一轮的批注（本轮必须按它改，改了什么要能对上）】',
      o.revisionNote,
    );
  }
  if (o.extra) {
    parts.push('', '【作者本轮补充】', o.extra);
  }
  parts.push('', `【本轮任务】立《${STAGE_LABEL[o.stage]}》。`);
  return parts.join('\n');
}

/**
 * 作者点了「批准」：把本段产出物结构化落库。
 *
 * 抽取失败**不撤销批准** —— 批准是作者的意志，落库是技术步骤；
 * 失败信息随 stats.notes 交回，作者可重跑本段。宁可留着契约文本，也不要静默什么都没有。
 */
export async function approveStage(
  ctx: ServerPluginContext,
  opts: { projectId: string; userId: string; stage: StageKey; briefText: string },
  emit: (e: PipelineEvent) => void,
): Promise<SinkStats | null> {
  const store = new PipelineStore(ctx.db.kv, opts.projectId);
  const state = store.load();
  const artifact = state?.stages[opts.stage]?.artifact;
  if (!state || !artifact) return null;

  // ★ pilot 的"落库"在跑的时候就发生完了（三章正文由单章闭环交付进 chapters）。
  //   批准这一步不该再去"抽取审计报告"——那份报告是给人读的，没有结构化落库这回事。
  //   之前会走到通用分支，得到一条「结构化抽取失败…本次未落库」的误导性提示。
  if (opts.stage === 'pilot') {
    const chapters = state.stages.pilot.pilotChapters ?? [];
    const notes = chapters.filter((c) => !c.delivered).map((c) => `第 ${c.order} 章未落库`);
    const warned = chapters.filter((c) => c.warnings.length);
    if (warned.length) notes.push(`${warned.length} 章带警示交付，建议复核`);
    const stats: SinkStats = {
      characters: { created: 0, updated: 0 },
      outline: 0,
      foreshadows: 0,
      skipped: 0,
      notes: [
        `试写 ${chapters.length} 章，已入项目库 ${chapters.filter((c) => c.delivered).length} 章`,
        ...notes,
      ],
    };
    state.stages.pilot.sinked = chapters.length > 0 && chapters.every((c) => c.delivered);
    await store.save(state);
    emit({ type: 'stage_sinked', stage: opts.stage, stats });
    return stats;
  }

  // ★ production 的"落库"与 pilot 同理：正文由单章闭环在跑的时候就交付进 chapters，
  //   批准这一步不该去"抽取审计报告"（那份报告是给人读的，没有结构化落库这回事）。
  if (opts.stage === 'production') {
    const chapters = state.stages.production.productionChapters ?? [];
    const notes = chapters.filter((c) => !c.delivered).map((c) => `第 ${c.order} 章未落库`);
    const warned = chapters.filter((c) => c.warnings.length);
    if (warned.length) notes.push(`${warned.length} 章带警示交付，建议复核`);
    if (state.stages.production.supervisorHalted) notes.push('本轮有章节被监工判需修正：已记台账并就地取修正补丁，长跑未中断（建议复核监工明细）');
    const stats: SinkStats = {
      characters: { created: 0, updated: 0 },
      outline: 0,
      foreshadows: 0,
      skipped: 0,
      notes: [
        `本轮长跑 ${chapters.length} 章，已入项目库 ${chapters.filter((c) => c.delivered).length} 章`,
        ...notes,
      ],
    };
    state.stages.production.sinked = chapters.length > 0 && chapters.every((c) => c.delivered);
    await store.save(state);
    emit({ type: 'stage_sinked', stage: opts.stage, stats });
    return stats;
  }

  const stats = await sinkStageArtifact(ctx, {
    projectId: opts.projectId,
    stage: opts.stage,
    artifact,
    briefText: opts.briefText,
    userId: opts.userId,
  });

  state.stages[opts.stage].sinked = stats.notes.length === 0 || stats.notes.every((n) => !n.includes('未落库'));
  await store.save(state);
  emit({ type: 'stage_sinked', stage: opts.stage, stats });
  return stats;
}

/** 供路由复用：当前 baseline hash（brief 一变就不同） */
export { computeBriefHash };
