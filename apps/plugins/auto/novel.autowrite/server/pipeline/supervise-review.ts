// ============================================================
// 监工复核（落库前）+ 派发写作
//
// 用户口径（2026-10-23）：「监工使用技能审阅，然后派发写作，给监工两个帮手，用来审阅」。
//
// 与既有的「写作监工」（roles-phase.ts 的 SUPERVISE_REVIEW）的区别 —— **这是两件事，别混**：
//   · 既有监工：**交付后**逐章巡检，只读、只记台账，用来观察**跨章趋势**（越写越水）。
//     它的结论不拦交付（2026-10-16 起连 halt 都不打断长跑）。
//   · 本文件：**交付前**的最后一道闸。监工在这里是**调度者** ——
//     派两个帮手分头审（各带一门审阅技能），汇总后决定「放行」还是「打回重写」。
//
// 为什么要两个帮手而不是让监工一个人看全部：
//   实测这本书里最重的两类毛病**互相掩盖** ——
//   情节停滞（原地打转）会同时表现为"重复"和"注水"，一个审阅者看到一堆问题时
//   只会挑最显眼的那条报，另一类就漏了。拆成两维、各自只看一维，报告才不互相稀释。
//
// 分工（刻意不重叠）：
//   A 情节推进审阅（plot-advance-reviewer）：故事有没有往前走 / 有没有重讲
//   B 文风重复审阅（voice-dup-reviewer）：句式雷同、口头禅、章号泄漏、文风断层
// ============================================================

import type { DesignRole } from '../discuss/roles.js';
import { plotAdvanceReview } from '../skills/plot-advance-review.js';
import { voiceDupReview } from '../skills/voice-dup-review.js';
/**
 * ★ 2026-10-29：场景结局方法论（从 danjdewhurst/story-skills 的 try-fail.md 提取改写）。
 * 与 plotAdvanceReview 同样**内置默认生效** —— 它治的「平缓日常章」是本项目
 * 长跑后段的实测主症（有反应、有困境、**没有决定**，也没有真正的挫折）。
 */
import { sceneOutcome } from '../skills/scene-outcome.js';

const sceneOutcomeMethod = sceneOutcome.systemPrompt;

/**
 * 两个帮手的公共输出契约（JSON，便于代码判定）。
 * 为什么不各写一套：字段一致才能在监工那里**合并成一张表**，
 * 否则监工要先做格式归一，多一步就多一个出错点。
 */
const HELPER_OUTPUT = `只输出 JSON，不要任何其他文字：
{"verdict":"pass|warn|severe",
 "findings":[{"kind":"<见下>","detail":"具体问题（一句话）","evidence":"本章原句","count":出现次数}],
 "summary":"一句话结论"}

判定口径：
- pass：这一维没有问题
- warn：有问题但不致命（可在不重写全章的前提下局部改掉）
- severe：必须打回重写（这一维的硬伤）

规则：
- **每条 finding 必须带本章原句作为 evidence**，编不出原句就不要写这条
- 不要复述剧情、不要夸奖、不要给修改建议（那是写作官的事）
- 没有问题就输出 {"verdict":"pass","findings":[],"summary":"…"}，不要硬凑`;

/** 帮手 A：情节推进审阅 */
export const ROLE_PLOT_ADVANCE_REVIEW: DesignRole = {
  key: 'plot-advance-reviewer',
  name: '情节推进审阅',
  color: '#3F7C8C',
  short: '进',
  memory: {
    // 判"有没有往前走"必须看总纲（计划里这一章该发生什么）与最近章节（上一章到哪了）
    readL1: ['settings.brief', 'settings.genre', 'outline.*', 'foreshadow.*', 'chapter.*', 'entity.characters.*'],
    readNarrative: true,
  },
  // 技能正文直接并进 system：**内置审阅技能默认生效**。
  // （不能只依赖作者在「智能体 Skills」里勾选 —— 没勾就等于这个帮手没有方法，退回泛泛而谈）
  system: `你是「情节推进审阅」，写作监工的帮手之一。你只审**一件事**：这一章有没有让故事往前走。

${plotAdvanceReview.systemPrompt}

${sceneOutcomeMethod}

${HELPER_OUTPUT}`,
};

/** 帮手 B：文风与重复审阅 */
export const ROLE_VOICE_DUP_REVIEW: DesignRole = {
  key: 'voice-dup-reviewer',
  name: '文风重复审阅',
  color: '#6B5B8C',
  short: '风',
  memory: {
    // 判"文风有没有断层"要看作者定的笔风基调与人物语言风格；重复判定要看前情
    readL1: ['settings.brief', 'settings.genre', 'entity.characters.*', 'chapter.*'],
    readNarrative: true,
  },
  system: `你是「文风重复审阅」，写作监工的帮手之一。你只审**文字层**，不评价情节。

${voiceDupReview.systemPrompt}

${HELPER_OUTPUT}`,
};

export const SUPERVISE_HELPERS: DesignRole[] = [ROLE_PLOT_ADVANCE_REVIEW, ROLE_VOICE_DUP_REVIEW];

/**
 * 落库前的「监工闸」—— **与交付后的写作监工是两个角色，别复用同一个 system**。
 *
 * ★ 2026-10-22 踩过的坑（轨迹确认）：把一个角色的讨论人格 system 拿去做 JSON 输出，
 *   契约写着"不要 JSON"、要求却是"只输出 JSON"，结果每一条都解析失败、功能静默失效。
 *   这里同理：`ROLE_SUPERVISOR.system` 是**交付后巡检**的契约（order/verdict/issues/trend），
 *   而这里要的是**汇总决定**（dispatch/instruction）。硬混用必然格式打架。
 */
export const ROLE_SUPERVISOR_GATE: DesignRole = {
  key: 'supervisor-gate',
  name: '写作监工（终审）',
  color: '#2F5F55',
  short: '终',
  memory: {
    readL1: ['settings.brief', 'settings.genre', 'outline.*', 'constraint.*', 'foreshadow.*', 'chapter.*', 'entity.characters.*'],
    readNarrative: true,
  },
  system: `你是「写作监工（终审）」，负责**落库前**的最后一道质量闸。你不写稿，只做决定。

你的两位帮手已经分头审完：
· 帮手 A「情节推进审阅」—— 只看故事有没有往前走（新的决定/信息/处境变化、有没有重讲）
· 帮手 B「文风重复审阅」—— 只看文字层（口头禅、句式雷同、重复景物、章号泄漏、提纲语言、文风断层）

你的职责是**汇总并决策**：放行，还是打回让写作官重写。

决策原则：
- 任一帮手判 **severe** → 必须打回（dispatch 写 "rewrite"），并把要改的东西写具体
- 只有 warn → 放行，warn 项写进 notes 供作者复核
- 你的决定要**可执行**：instruction 里写"改成什么"，不要写"注意质量"

只输出 JSON，不要任何其他文字：
{"verdict":"ok|watch|halt","dispatch":"deliver|rewrite","instruction":"…","notes":"…"}`,
};

/** 监工给帮手派活时说的话（把正文显式塞进去：讨论记录的预算可能把它裁掉） */
export function renderHelperTask(role: DesignRole, draft: string, chapterOrder: number): string {
  const focus = role.key === ROLE_PLOT_ADVANCE_REVIEW.key
    ? '只判**情节推进**（有没有新的决定/信息/处境变化、有没有把演过的事换个说法再讲一遍）。'
    : '只判**文风与重复**（口头禅、句式雷同、重复景物、章号泄漏、提纲语言、文风断层）。';
  return [
    `【本轮任务】审阅第 ${chapterOrder} 章正文（写作官最新一稿）。`,
    focus,
    '',
    '【本章正文（完整，未截断）】',
    draft,
    '',
    /**
     * ★ 2026-10-25 修（与 10-22 轨迹确认那个 bug 同源）：**输出契约必须出现在任务末尾**。
     *
     * 症状：两个帮手的报告大面积解析失败 —— 49 次调用里 11 次输出不足 200 字，
     *   全是散文（"这一章整体推进尚可，但……"），`parseHelperReport` 拿不到 JSON
     *   ⇒ 静默降级成 `verdict:'warn', parsed:false` ⇒ 监工只能"保守处理"。
     *
     * 根因：`HELPER_OUTPUT` 只写在 **system** 里，而 system 里还有几百字的审阅方法论
     *   （`plotAdvanceReview.systemPrompt` 等）。模型读完方法论，顺着"给结论"的语感写散文，
     *   把末尾的 JSON 要求丢了。**离生成最近的指令权重最高** —— 契约要放在正文之后。
     */
    HELPER_OUTPUT,
    '',
    `（本章正文结束。请按上面的 JSON 契约输出，只输出 JSON。）`,
  ].join('\n');
}

// ---- 解析与判定（纯函数，可直接单测）----

export type HelperVerdict = 'pass' | 'warn' | 'severe';

export interface HelperFinding {
  kind: string;
  detail: string;
  evidence: string;
  count?: number;
}

export interface HelperReport {
  verdict: HelperVerdict;
  findings: HelperFinding[];
  summary: string;
  /** 是否成功解析（解析失败按 warn 保守处理，且**不**据此打回） */
  parsed: boolean;
}

/**
 * 解析一个帮手的报告。
 *
 * ★ 与监工那条一样：解析不出来**不当作 pass**，但也**不据此打回** ——
 *   模型偶尔吐错 JSON 就把整章重写一遍太贵。解析失败记 warn + parsed:false，
 *   由监工（它会看到原文）决定要不要管。
 */
export function parseHelperReport(text: string): HelperReport {
  const raw = (() => {
    try {
      // 复用宽容解析（正文里的裸引号不会让整份报告作废）
      const m = /[{[]/.exec(text ?? '');
      if (!m) return null;
      const first = text.slice(m.index);
      const end = first.lastIndexOf('}');
      const slice = end >= 0 ? first.slice(0, end + 1) : first;
      return JSON.parse(slice) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

  if (!raw) {
    return { verdict: 'warn', findings: [], summary: '审阅报告未能解析成 JSON（已按保守处理）', parsed: false };
  }

  const v = typeof raw.verdict === 'string' ? raw.verdict.toLowerCase() : '';
  const verdict: HelperVerdict = v === 'severe' ? 'severe' : v === 'pass' ? 'pass' : 'warn';
  const findings: HelperFinding[] = Array.isArray(raw.findings)
    ? (raw.findings as unknown[]).map((it) => {
        const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
        return {
          kind: typeof o.kind === 'string' ? o.kind : 'other',
          detail: typeof o.detail === 'string' ? o.detail.trim() : '',
          evidence: typeof o.evidence === 'string' ? o.evidence.trim() : '',
          count: typeof o.count === 'number' ? o.count : undefined,
        };
      }).filter((f) => f.detail)
    : [];
  return {
    verdict: verdict === 'pass' && findings.length > 0 ? 'warn' : verdict,
    findings,
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    parsed: true,
  };
}

/** 监工拿到的汇总输入（两个帮手的结论 + 原文节选） */
export function renderSuperviseMergeTask(o: {
  chapterOrder: number;
  plotAdvance: HelperReport;
  voiceDup: HelperReport;
  draftExcerpt: string;
}): string {
  const fmt = (label: string, r: HelperReport) => {
    const lines = [`【${label}】判定：${r.verdict}${r.parsed ? '' : '（解析失败）'}`];
    if (r.summary) lines.push(`结论：${r.summary}`);
    for (const f of r.findings.slice(0, 6)) {
      lines.push(`· [${f.kind}] ${f.detail}${f.count ? `（${f.count} 次）` : ''}${f.evidence ? ` —— 证据：「${f.evidence.slice(0, 60)}」` : ''}`);
    }
    return lines.join('\n');
  };
  return [
    `【本轮任务】你是写作监工，两位帮手的审阅已完成。请汇总并**做出决定**。`,
    '',
    fmt('帮手 A · 情节推进审阅', o.plotAdvance),
    '',
    fmt('帮手 B · 文风重复审阅', o.voiceDup),
    '',
    '【本章正文节选（首尾各一段，用于你自己抽查）】',
    o.draftExcerpt,
    '',
    '决定口径：',
    '- 任一帮手判 **severe** → `dispatch` 必须是 `"rewrite"`，并在 `instruction` 里写清**要改什么**（具体、可执行、按优先级排序）',
    '- 两边都是 pass/warn → `dispatch` 写 `"deliver"`',
    '- **不要**因为帮手写了 warn 就要求重写全章；warn 的项写进 `notes` 即可',
    '',
    '只输出 JSON，不要任何其他文字：',
    '{"verdict":"ok|watch|halt","dispatch":"deliver|rewrite","instruction":"dispatch=rewrite 时给写作官的修改要求（分条、具体）；否则留空","notes":"给作者看的一句话"}',
  ].join('\n');
}

export interface SupervisorDecision {
  verdict: 'ok' | 'watch' | 'halt';
  dispatch: 'deliver' | 'rewrite';
  instruction: string;
  notes: string;
  parsed: boolean;
}

/** 解析监工的决定 */
export function parseSupervisorDecision(text: string): SupervisorDecision {
  const raw = (() => {
    try {
      const m = /[{[]/.exec(text ?? '');
      if (!m) return null;
      const first = text.slice(m.index);
      const end = first.lastIndexOf('}');
      return JSON.parse(end >= 0 ? first.slice(0, end + 1) : first) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!raw) {
    // 解析失败 → 放行（不因格式问题卡住交付），但记 watch 让作者知道
    return { verdict: 'watch', dispatch: 'deliver', instruction: '', notes: '监工汇总未能解析成 JSON（按放行处理）', parsed: false };
  }
  const v = typeof raw.verdict === 'string' ? raw.verdict.toLowerCase() : '';
  const verdict: SupervisorDecision['verdict'] = v === 'halt' ? 'halt' : v === 'ok' ? 'ok' : 'watch';
  const d = typeof raw.dispatch === 'string' ? raw.dispatch.toLowerCase() : '';
  return {
    verdict,
    dispatch: d === 'rewrite' ? 'rewrite' : 'deliver',
    instruction: typeof raw.instruction === 'string' ? raw.instruction.trim() : '',
    notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    parsed: true,
  };
}

/**
 * 汇总两个帮手的判定 —— 防「监工漏看」。
 *
 * 为什么不能只信监工的 dispatch：监工是第三个模型，它可能把 severe 看漏。
 * 帮手明确报了 severe 时**强制**重写（除非这一轮已经改过、见调用方的轮数上限）。
 * 这是"代码兜底模型判断"这条一贯做法的延续。
 */
export function decideSupervision(
  decision: SupervisorDecision,
  helpers: readonly HelperReport[],
): { dispatch: 'deliver' | 'rewrite'; reason: string } {
  const severe = helpers.filter((h) => h.verdict === 'severe');
  if (severe.length > 0 && decision.dispatch !== 'rewrite') {
    return { dispatch: 'rewrite', reason: `帮手判 severe（${severe.length} 位），覆盖监工的放行` };
  }
  if (decision.dispatch === 'rewrite') return { dispatch: 'rewrite', reason: '监工决定打回重写' };
  return { dispatch: 'deliver', reason: decision.notes || '监工放行' };
}

/** 派发给写作官的修改要求（监工没写 instruction 时的兜底：直接用帮手找到的问题） */
export function renderDispatchInstruction(
  decision: SupervisorDecision,
  helpers: readonly HelperReport[],
): string {
  if (decision.instruction.trim()) return decision.instruction.trim();
  const items: string[] = [];
  for (const h of helpers) {
    for (const f of h.findings) {
      items.push(`· ${f.detail}${f.evidence ? `（原句：「${f.evidence.slice(0, 50)}」）` : ''}`);
    }
  }
  return items.length
    ? `【监工派发重写】下列问题必须逐条改掉：\n${items.slice(0, 10).join('\n')}`
    : '【监工派发重写】本章被判需要重写，请按上文审阅意见逐条修正。';
}
