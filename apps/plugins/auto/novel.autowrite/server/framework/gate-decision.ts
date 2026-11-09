// ============================================================
// 意图门 · 「打回决策器」—— 用 Jev 决策模型替代互相打架的硬规则
//
// 为什么需要它（2026-10-17，用户提出引入 Jev 决策模型）：
//   意图门现在是 5 条**硬编码 OR 规则**：
//     `重复≥阈值` / `对话<下限` / `超字数` / `提纲泄漏` / `模型说打回` —— 任一命中就打回。
//   实测它们会**互相打架**：补对话 → 字数超上限 → 又打回；删重复 → 字数不足 → 又补 →
//   又重复。而且重写上限（3 次）到了仍不达标，只能**带瑕疵交付**，白烧三次调用。
//
//   真正需要「判断」的，不是"有没有重复"（确定性代码已经数得很准），而是：
//     · 这一稿到底**该不该再花一次重写**？（worthIt）
//     · 若重写，**最该修哪一条**？（primaryIssue —— 只修一条，避免打架）
//     · 本章是不是**情节原地打转**？（stalled —— 确定性去重抓不到，只有模型能判）
//
// Jev 是什么：不是聊天模型，而是「给一个 state + 一组类型化问题，返回可分支的结构化判定」。
//   端点 POST {base}/v1/systemone，body = { model, state, questions }。
//   问题类型三种（见官方文档）：
//     · choice  —— 从给定 criteria（2–20 个键）里选一个，返回 choice + probabilities + confidence
//     · noul    —— **P(yes)**，0–1（yes/no 概率，调用方自己定阈值）
//     · score   —— criteria 是**有序档位数组**（2–10 档），返回小数索引 + confidence
//
// ★ 2026-10-18 关键事实（实测）：Jev 只有 /v1/systemone 这个**决策端点**，
//   **不能**用 /v1/chat/completions 问（会报 "is a decisions model and cannot be used
//   with the chat/completions endpoint"）。所以本模块有两条路径：
//     ① **原生 systemone**（首选）：直连 magpie 的 /v1/systemone（或 jevmodel.org），
//        模型 `typesafe/jev-1.13`。实测 magpie 已暴露该端点、用 magpie token 即可。
//     ② **chat JSON 兜底**：若没配 Jev，则用宿主 ctx.ai.complete（任意 chat 模型）问同样
//        的问题、要 JSON。适合没有 Jev 通道时用普通模型当替身。
//
// 设计原则（为什么不做成"必须 Jev 才能用"）：
//   · **可配置**：原生模式读 `AUTOWRITE_JEV_URL` / `AUTOWRITE_JEV_TOKEN` / `AUTOWRITE_JEV_MODEL`；
//     chat 兜底读 `AUTOWRITE_DECISION_MODEL`。
//     ★ 2026-11-09 更正（原注释写「都没配 = 决策器关闭」，与 10-27 的实现相反）：
//       **默认是开的** —— chat 兜底未配置时取 `hy3`（见 resolveChatDecisionModel 的选型表）。
//       原因是 Jev 被地域门挡死，而内容质量三判定是每章必跑的常规体检，不能默认关掉。
//       要关请显式设 `AUTOWRITE_DECISION_MODEL=off`（或 `none`）。
//   · **失败即回退**：调用失败 / 超时 / 解析不出 → 返回 null，调用方退回原来的 5 条硬规则
//     （fail-open，绝不因为决策器挂了就不写书）。
//   · **不生成文本**：决策器只回答"放行/重写/带警示放行"，正文仍由写作官写。
//
// 本文件是**纯函数 + 一次网络调用**，无 DB 副作用，单测覆盖解析与兜底逻辑。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import { parseJsonLoose } from './text.js';

/** 决策器允许返回的三种总判定 */
export type DecisionVerdict = 'accept' | 'rewrite' | 'accept_with_warning';
/** 若重写，最该修的一条（只修一条，避免补对话→超字数→再打回的循环） */
export type DecisionIssue = 'duplication' | 'dialogue' | 'length' | 'plot_stall' | 'voice' | 'leak' | 'none';

export interface GateDecision {
  // ——— 内容质量三判定（2026-10-27 新定位：文本体检仪）———
  /** **AI 味**严重度 1–10（1=很自然，10=明显机器味）。0 = 未能判定 */
  aiFlavor: number;
  /** AI 味的具体剖面：句式模板化（P(yes)） */
  aiFlavorTemplateSyntax: boolean;
  /** AI 味的具体剖面：解释性旁白代替动作（P(yes)） */
  aiFlavorExplainingNarrator: boolean;
  /** **开头重复**：与前两章开头功能位雷同（P(yes)） */
  openingRepeat: boolean;
  /** **内容重复**：换句重讲已演过的事件（P(yes)） */
  contentRepeat: boolean;
  /** 可读性总分 1–10（独立于上面三项；0 = 未能判定） */
  quality: number;


  // ——— 兼容字段（旧的"放不放行"裁决）———
  /**
   * @deprecated 2026-10-27 起决策器**不再做总判决**（那是硬规则与调用方策略的事）。
   * 保留此字段只为兼容旧调用点与既有测试；新代码应读 `contentProblems` 自行决定。
   */
  verdict: DecisionVerdict;
  /** @deprecated 同上，由 `contentProblems` 取代 */
  primaryIssue: DecisionIssue;
  /** @deprecated 同上 */
  worthIt: boolean;
  /** @deprecated 由 `contentRepeat` 取代（语义更明确） */
  stalled: boolean;

  /** 决策器一句话理由（chat 兜底通道有；原生 systemone 不给理由，只有概率） */
  reason?: string;
  /** 决策器自报的把握度（choice/score 有；noul 没有） */
  confidence?: number;
}

/** 决策器所需的「结构化诊断」—— 全部来自确定性代码，不含模型判断 */
export interface DecisionState {
  chapter: string;
  chars: number;
  charMin: number;
  charMax: number;
  intraDup: number;
  crossDup: number;
  /** 0–1 */
  dialogueRatio: number;
  dialogueMin: number;
  leak: number;
  /** 已重写几次 / 上限 */
  rewritesSoFar: number;
  maxRewrites: number;
  /** 正文节选（首尾各一段，避免把整章外发） */
  excerpt: string;
  /**
   * ★ 2026-10-27 新增（**开头重复判定必需**）：
   * 本章开头（前 ~260 字，含第一段完整走向）与**前两章的开头**。
   *
   * 为什么必须给：开头重复是"每章都用同一套起手"——「天亮/雾起/他坐起来」这类
   * 词面各章不同，但**功能位完全相同**（都是"环境起手 + 主角醒来/到某处"）。
   * 词频统计对此零命中（我记忆里四轮标定都失败），只有把三段开头并排放给决策模型才判得出。
   */
  openingExcerpt?: string;
  priorOpenings?: Array<{ chapter: string; opening: string }>;
}

export const DECISION_VERDICTS: readonly DecisionVerdict[] = ['accept', 'rewrite', 'accept_with_warning'];
export const DECISION_ISSUES: readonly DecisionIssue[] = ['duplication', 'dialogue', 'length', 'plot_stall', 'voice', 'leak', 'none'];

/** noul 概率转布尔的阈值：P(yes) ≥ 0.5 视为 yes */
export const NOUL_YES_THRESHOLD = 0.5;

export interface JevConfig {
  /** 完整 systemone 地址，如 http://127.0.0.1:3425/v1/systemone */
  url: string;
  token: string;
  model: string;
}

const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';

/**
 * 读原生 Jev 配置（主端点）。
 * - `AUTOWRITE_JEV_URL` 未设置 / 空 / `off` → null（不启用原生模式）
 * - `AUTOWRITE_JEV_TOKEN` 缺省空串
 * - `AUTOWRITE_JEV_MODEL` 缺省 `typesafe/jev-1.13`
 *
 * ★ 2026-10-18 实测：经 magpie 走 Jev **会被地域限制挡住**（OpenRouter 回
 *   `403 This model is not available in your region`），而**本机直连 OpenRouter 是通的**。
 *   所以主端点建议直接配 `https://openrouter.ai/api/alpha/decisions` + OpenRouter key；
 *   备用端点用 `AUTOWRITE_JEV_FALLBACK_*`（见下）。
 */
export function resolveJevConfig(env: Record<string, string | undefined> = process.env): JevConfig | null {
  return readJevEndpoint(env, 'AUTOWRITE_JEV_URL', 'AUTOWRITE_JEV_TOKEN', 'AUTOWRITE_JEV_MODEL');
}

/**
 * 备用端点（可选）。
 *
 * 为什么需要：实测长跑中途主端点**静默失效**（11 次连续 403）——决策层整段落回硬规则，
 * 而作者在界面上看不出来。多配一个端点，主端点失败时自动改走它（同样是 fail-open：
 * 两个都失败才回退硬规则）。
 *   `AUTOWRITE_JEV_FALLBACK_URL` / `_TOKEN` / `_MODEL`
 */
export function resolveJevFallback(env: Record<string, string | undefined> = process.env): JevConfig | null {
  return readJevEndpoint(env, 'AUTOWRITE_JEV_FALLBACK_URL', 'AUTOWRITE_JEV_FALLBACK_TOKEN', 'AUTOWRITE_JEV_FALLBACK_MODEL');
}

/** 共用的端点读取（主/备同形） */
function readJevEndpoint(
  env: Record<string, string | undefined>,
  urlKey: string,
  tokenKey: string,
  modelKey: string,
): JevConfig | null {
  const url = (env[urlKey] ?? '').trim();
  if (!url || url.toLowerCase() === 'off' || url.toLowerCase() === 'none') return null;
  const model = (env[modelKey] ?? '').trim() || DEFAULT_JEV_MODEL;
  return { url, token: (env[tokenKey] ?? '').trim(), model };
}

/**
 * chat 兜底模型名（**Jev 的替身**）。
 *
 * ★ 2026-10-27 改：**默认值从"未配置"改成 `hy3`**。
 *
 * 背景：Jev 在所有可用通道上都被地域门挡住（`403 This model is not available in your region`），
 * 而"内容质量三判定"是每章都要跑的**常规体检**，不能因为 Jev 不可用就整个关掉
 * （关掉 = 又退回只有词面统计的年代，那正是这三项测不出来的原因）。
 *
 * 替身选型（本机实测，同一套问题 + 真实文本）：
 * | 模型 | JSON 稳定 | 判别力(坏/好) | 延迟 | 结论 |
 * |---|---|---|---|---|
 * | **hy3** | 3/3 | 8 vs 2（差6） | **4.0s** | ✅ 默认 |
 * | glm-5.3-flash | 3/3 | 8 vs 2 | 6.7s | 可换 |
 * | Qwen3.8-Flash | 3/3（偶有失败） | 8 vs 2 | 15.1s | ❌ 每章多等十几秒 |
 * | deepseek-v4.1-flash | **0/3** | — | 超时 | ❌ 不可用 |
 *
 * **判别力三家打平** —— 说明这个判断不需要最强模型；分水岭是**稳定性与延迟**
 * （决策器每章调 1–3 次）。选 hy3 还因为它本就是写作模型，不会引入陌生的文风偏好。
 *
 * 配置口径：
 *   - 未设置 → **默认 `hy3`**（开箱即用；想关掉请显式设 `off`）
 *   - `off` / `none` → null（决策器关闭）
 *   - 其他值 → 原样使用（可写裸名，代理会自动映射成网关真实 id）
 *   - 配了原生 Jev 时**优先走 Jev**，这里的值只是兜底
 */
export function resolveChatDecisionModel(env: Record<string, string | undefined> = process.env): string | null | undefined {
  const raw = (env.AUTOWRITE_DECISION_MODEL ?? '').trim();
  if (raw.toLowerCase() === 'off' || raw.toLowerCase() === 'none') return null;
  return raw || 'hy3';
}

/**
 * 决策器是否启用：配了原生 Jev / 备用端点，或 chat 兜底**未被显式关闭**。
 *
 * ★ 2026-11-09 更正：原注释写「都没配 = 关闭」，与 2026-10-27 起的实现相反。
 *   现在 `resolveChatDecisionModel` 在未配置时返回默认模型 `hy3`（不再返回 undefined），
 *   所以「什么都不配」= **开启**；只有 `AUTOWRITE_DECISION_MODEL=off|none` 且两个
 *   Jev 端点都为空时才关闭。判断依据见 resolveChatDecisionModel 的选型表：
 *   Jev 被地域门挡死，而这三项内容体检是每章必跑，默认关掉等于退回词面统计。
 */
export function isDecisionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return resolveJevConfig(env) !== null || resolveJevFallback(env) !== null
    || typeof resolveChatDecisionModel(env) === 'string';
}

/** 决策器 system 提示词（仅 chat 兜底用）：要求**只输出一个 JSON** */
const CHAT_SYSTEM = [
  '你是小说流水线的「**内容质量体检员**」（chat 兜底通道 —— 有 Jev 时走原生 systemone）。',
  '',
  '你的职责**只有三项**，都是词面统计测不出来的：',
  '  ① **AI 味**（aiFlavor 1–10 + 两个剖面）：句式模板化、过度对仗排比、',
  '     解释性旁白代替动作、环境描写无信息量、每段结构雷同。**只看文字质感**。',
  '  ② **开头重复**（openingRepeat）：本章开头与前两章开头**功能位雷同**',
  '     （都是"环境起手 → 主角醒来/抵达 → 开始做事"）。词面不同也要判。',
  '  ③ **内容重复**（contentRepeat）：换套句子重讲已经演过的事件，',
  '     读者获得的信息与之前相同、处境没有实质变化。',
  '',
  '**不要判断"该不该交付/该不该重写"** —— 那是调用方的事。你只如实报告症状。',
  '**不要重复数**重复句数、字数、对话占比 —— 那些确定性代码已精确算好，state 里给了。',
  '',
  '只输出**一个** JSON 对象，字段固定：',
  '{"aiFlavor":1-10,"aiFlavorHasTemplateSyntax":true|false,"aiFlavorHasExplainingNarrator":true|false,' +
    '"openingRepeat":true|false,"contentRepeat":true|false,"quality":1-10,"reason":"一句话"}',
  'state 里没有 priorOpenings 时，openingRepeat 一律填 false。不要解释、不要代码块。',
].join('\n');

/** 把结构化诊断拍成一段纯文本 state（原生 systemone 的 state 可以是 string/object/array） */
export function buildDecisionStatePayload(s: DecisionState): Record<string, unknown> {
  return {
    chapter: s.chapter,
    chars: s.chars,
    charBand: [s.charMin, s.charMax],
    intraDup: s.intraDup,
    crossDup: s.crossDup,
    dialogueRatio: Number(s.dialogueRatio.toFixed(3)),
    dialogueMin: s.dialogueMin,
    leak: s.leak,
    rewritesSoFar: s.rewritesSoFar,
    maxRewrites: s.maxRewrites,
    excerpt: s.excerpt,
    /**
     * ★ 2026-10-27：**开头重复判定的输入**。
     * 把本章开头和前两章开头并排放进 state —— 模型要做的是"结构对比"，
     * 而不是"读完全文回忆"，这样判断才稳定、也省输入。
     */
    ...(s.openingExcerpt ? { openingExcerpt: s.openingExcerpt } : {}),
    ...(s.priorOpenings?.length
      ? { priorOpenings: s.priorOpenings.slice(0, 2).map((p) => ({ chapter: p.chapter, opening: p.opening })) }
      : {}),
  };
}

/** chat 兜底用的用户消息 */
export function buildDecisionUserPrompt(s: DecisionState): string {
  /**
   * ★ 2026-10-27：**任务必须写在最前**（同一根因的第五次复现）。
   *
   * 实测（chat 兜底验证时）：user 消息只有【诊断】【正文】和一句"请输出 JSON"，
   * 模型的原话是：
   *   「这段内容里…你是想让我：1. 对比三章开头的写作风格/节奏变化？2. 续写本章正文？…」
   * —— 它不知道要干什么，于是反问；反问不是 JSON，解析失败。
   *
   * 这个坑已经在 gates.ts（校对门/润色门）、supervise-review.ts（监工帮手）各踩过一次。
   * 规律：**任务在最前、素材在中、契约在最后**。此处按同一结构重写。
   */
  return [
    `【本轮任务】对${s.chapter}做**内容质量体检**：判 AI 味（1–10 + 两个剖面）、`
      + '开头是否与前两章功能位雷同、内容是否在重讲已演过的事件。'
      + '**不要判断该不该交付**，也不要评价剧情好坏——只如实报告这三项症状。',
    '',
    '【诊断（代码已精确统计，不要重复数）】',
    JSON.stringify(buildDecisionStatePayload(s), null, 0),
    '',
    '【正文节选】',
    s.excerpt,
    '',
    '【输出格式】只输出一个 JSON 对象，不要解释、不要代码块：',
    '{"aiFlavor":1-10,"aiFlavorHasTemplateSyntax":true|false,"aiFlavorHasExplainingNarrator":true|false,'
      + '"openingRepeat":true|false,"contentRepeat":true|false,"quality":1-10,"reason":"一句话"}',
    '（若 state 里没有 priorOpenings，openingRepeat 一律填 false。）',
  ].join('\n');
}

/**
 * 原生 systemone 的 questions 定义 —— **内容质量三判定**（2026-10-27 改版）
 *
 * ★ 定位变化（按用户要求）：决策器从「意图门裁判（放不放行）」改成「**文本体检仪**」。
 *
 * 为什么这么改：`verdict/primaryIssue/worthIt` 那套问的是"该不该再改一次"，
 * 而这些**确定性代码已经答得更好**（重复句数、篇幅、对话占比都是精确计数的）。
 * 决策模型真正不可替代的是**词面统计测不出的三件事**：
 *
 *   ① AI 味（aiFlavor）—— 句法模板化、过度对仗排比、解释性旁白、无信息量的环境铺陈。
 *      没有任何词频能测"这段读起来像机器写的"。
 *   ② 开头重复（openingRepeat）—— 每章用同一套起手（天亮/雾起/他坐起来）。
 *      词面各章不同，但**功能位相同**，必须把前两章开头并排给它看才判得出。
 *   ③ 内容重复（contentRepeat）—— 换套句子重讲同一批事件。
 *      我此前四轮标定（段落 Jaccard / 章内 LCS / 锚点顺序 / 两轮切点）全部失败，
 *      唯一能判的就是语义层面 —— 这正是 System One 模型擅长的有界判断。
 *
 * 输出全是 `noul`（P(yes)）与 `score`（严重度档位），**不做"放不放行"的总判决** ——
 * 放行与否交给硬规则 + 调用方策略，决策器只如实报告症状。
 */
export function buildSystemOneQuestions(): Record<string, unknown> {
  return {
    aiFlavor: {
      type: 'score',
      instructions: '这一章读起来有多像"AI 写的"？（1=完全像人写的自然叙事；10=明显机器味：'
        + '句式高度模板化、大量对仗排比、解释性旁白代替action、环境描写无信息量、'
        + '每段结构雷同。只看文字质感，不看情节。）',
      criteria: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    },
    /** 硬判据：AI 味的典型剖面，逐条给概率（比单个分数更能指导写作官改哪里） */
    aiFlavorHasTemplateSyntax: {
      type: 'noul',
      instructions: '本章是否大量使用**同一句式反复套用**（如"X。Y。Z。"式三连短句、'
        + '连续四字对仗、"不…不…不…"排比）？看句式重复，不是看词重复。',
    },
    aiFlavorHasExplainingNarrator: {
      type: 'noul',
      instructions: '本章是否用**解释性旁白代替动作/对话**？（如"他心里明白这意味着什么"'
        + '这类替读者总结的句子，而不是让人物用行为表现）',
    },
    openingRepeat: {
      type: 'noul',
      instructions: '本章开头是否与前两章开头**功能位雷同**？（比如都在写"天候/环境起手 → '
        + '主角醒来或抵达某处 → 开始做事"。词面可以不同，看的是**起手结构**是否一成不变。）'
        + '若 state 里没给 priorOpenings，忽略此题。',
    },
    contentRepeat: {
      type: 'noul',
      instructions: '本章是否在**重讲前面已经演过的事件**？（换了一套句子、换了地点或视角，'
        + '但读者获得的信息与之前相同、处境没有实质变化。注意：连续的同一场景是正常的，'
        + '要判的是"整块内容重复讲一遍"。）',
    },
    /** 严重度分档：给闸门一个可比较的量，而不是只有"是/否" */
    quality: {
      type: 'score',
      instructions: '按网文连载标准给本章的**可读性**打分（1 最差，10 最好）。'
        + '这是独立于上面三项的总体判断（三项都干净也可能平淡）。',
      criteria: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    },
  };
}

/** 把模型返回的任意对象**归一化**成合法 GateDecision；任何字段缺失/越界都按保守默认填 */
export function normalizeDecision(raw: unknown): GateDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const bool = (k: string): boolean => o[k] === true || o[k] === 'true' || o[k] === 1;
  const clamp10 = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0;
  };

  const aiFlavor = clamp10(o.aiFlavor);
  const quality = clamp10(o.quality);
  /**
   * ★ 2026-10-27：**有效性判据改了**。旧实现要求 `verdict` 合法，否则返回 null ——
   * 那是"裁决模型"年代的前置条件。新问题集里没有 verdict（决策器不再做总判决），
   * 再用它当门槛会让**每次 chat 兜底调用都判无效**。
   * 现在的判据：至少有一项内容质量判定拿到了值。
   */
  const hasAnySignal = aiFlavor > 0 || quality > 0
    || o.openingRepeat !== undefined || o.contentRepeat !== undefined;
  if (!hasAnySignal) return null;

  const openingRepeat = bool('openingRepeat');
  const contentRepeat = bool('contentRepeat');

  /** 兼容字段：由内容问题反推旧语义（未迁移的调用点仍可用） */
  const verdict: DecisionVerdict = contentRepeat || openingRepeat ? 'rewrite' : 'accept';
  const primaryIssue: DecisionIssue = contentRepeat ? 'duplication' : openingRepeat ? 'voice' : 'none';
  const c = Number(o.confidence);

  return {
    aiFlavor,
    aiFlavorTemplateSyntax: bool('aiFlavorHasTemplateSyntax'),
    aiFlavorExplainingNarrator: bool('aiFlavorHasExplainingNarrator'),
    openingRepeat,
    contentRepeat,
    quality,
    verdict,
    primaryIssue,
    worthIt: true,
    stalled: contentRepeat,
    ...(Number.isFinite(c) ? { confidence: Math.max(0, Math.min(1, c)) } : {}),
    ...(typeof o.reason === 'string' && o.reason.trim() ? { reason: o.reason.trim().slice(0, 200) } : {}),
  };
}

/**
 * 把 systemone 的 answers 转成 GateDecision。
 *
 * answers 形状（实测）：
 *   verdict:   { type:'choice', choice:'rewrite', probabilities:{...}, confidence:0.13 }
 *   primaryIssue: { type:'choice', choice:'duplication', ... }
 *   worthIt:   { type:'noul', noul:0.49 }        // P(yes)
 *   stalled:   { type:'noul', noul:0.32 }
 *   quality:   { type:'score', score:0.7, ... }  // 0 起的小数索引（criteria 共 10 档 → 1..10）
 *
 * 关键换算：score 是**档位索引**（0 = 第一档），所以 quality = score + 1（10 档时即 1..10）。
 * 注意：这不是"模型给的分"，是它在档位上的位置；用档位索引即可。
 */
export function decisionFromSystemOneAnswers(answers: unknown): GateDecision | null {
  if (!answers || typeof answers !== 'object') return null;
  const a = answers as Record<string, Record<string, unknown>>;

  /** noul：P(yes) ≥ 阈值即判 true */
  const noul = (k: string): boolean => {
    const v = a[k] && typeof a[k] === 'object' ? Number(a[k].noul) : NaN;
    return Number.isFinite(v) && v >= NOUL_YES_THRESHOLD;
  };
  /** noul 的原始概率（0–1），拿不到时 undefined */
  const noulProb = (k: string): number | undefined => {
    const v = a[k] && typeof a[k] === 'object' ? Number(a[k].noul) : NaN;
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : undefined;
  };
  /** score：档位索引（0 起）→ 1..N 的整数 */
  const score1to10 = (k: string): number => {
    const v = a[k] && typeof a[k] === 'object' ? Number(a[k].score) : NaN;
    return Number.isFinite(v) ? Math.max(1, Math.min(10, Math.round(v + 1))) : 0;
  };

  /**
   * ★ 2026-10-27：**不再要求 verdict 存在**。
   * 旧实现 `if (!DECISION_VERDICTS.includes(verdictRaw)) return null;` —— 那是"裁决模型"年代的
   * 前置条件。新问题集里根本没有 verdict，再用它当门槛会让**每次调用都判为无效**。
   * 现在的有效性判据变成：至少有一项内容质量判定拿到了值。
   */
  const aiFlavor = score1to10('aiFlavor');
  const quality = score1to10('quality');
  const hasAnySignal = aiFlavor > 0 || quality > 0
    || noulProb('openingRepeat') !== undefined
    || noulProb('contentRepeat') !== undefined
    || noulProb('aiFlavorHasTemplateSyntax') !== undefined;
  if (!hasAnySignal) return null;

  const openingRepeat = noul('openingRepeat');
  const contentRepeat = noul('contentRepeat');

  /** 兼容字段：由内容问题反推一个"旧语义"的裁决，供尚未迁移的调用点使用 */
  const verdict: DecisionVerdict = contentRepeat || openingRepeat ? 'rewrite' : 'accept';
  const primaryIssue: DecisionIssue = contentRepeat ? 'duplication' : openingRepeat ? 'voice' : 'none';

  const conf = a.aiFlavor && typeof a.aiFlavor === 'object' ? Number(a.aiFlavor.confidence) : NaN;
  /** 原生 systemone 不给自然语言理由 —— 用概率串代替，便于事后回查 */
  const p = [
    ['openingRepeat', noulProb('openingRepeat')],
    ['contentRepeat', noulProb('contentRepeat')],
    ['template', noulProb('aiFlavorHasTemplateSyntax')],
    ['narrator', noulProb('aiFlavorHasExplainingNarrator')],
  ].filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
  const reason = p.length ? p.map(([k, v]) => `${k}:${v.toFixed(2)}`).join(',') : undefined;

  return {
    aiFlavor,
    aiFlavorTemplateSyntax: noul('aiFlavorHasTemplateSyntax'),
    aiFlavorExplainingNarrator: noul('aiFlavorHasExplainingNarrator'),
    openingRepeat,
    contentRepeat,
    quality,
    verdict,
    primaryIssue,
    worthIt: true,
    stalled: contentRepeat,
    ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(1, conf)) } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * 内容质量三判定的**严重度汇总**（给闸门/界面用的可比较分）。
 *
 * 为什么需要一个汇总：调用方要决定"要不要打回、只修哪一条"，
 * 而三项是不同量纲（AI 味 1–10、两个布尔）。
 * 这里把它们折算成同一把尺子上的"问题分"，**只用于排序与阈值判断**，
 * 原始值仍在 GateDecision 上一一保留（不要让汇总值掩盖细节）。
 */
export interface ContentProblemScore {
  /** 问题总分（0 = 干净；越大越该改） */
  total: number;
  /** 最该修的那一条（按权重取最大） */
  top: 'aiFlavor' | 'openingRepeat' | 'contentRepeat' | 'none';
  /** 逐项贡献（观测用） */
  breakdown: { aiFlavor: number; openingRepeat: number; contentRepeat: number };
}

/** 各项权重：内容重复最伤（读者立刻察觉"这段讲过"），其次开头重复（翻页即见），AI 味再次 */
export const CONTENT_WEIGHTS = { contentRepeat: 45, openingRepeat: 30, aiFlavor: 5 } as const;
/** AI 味从第几档开始计入问题（1–4 属正常范围，不必改） */
export const AI_FLAVOR_BASELINE = 4;

export function scoreContentProblems(d: GateDecision): ContentProblemScore {
  const aiFlavor = Math.max(0, (d.aiFlavor - AI_FLAVOR_BASELINE) * CONTENT_WEIGHTS.aiFlavor);
  const openingRepeat = d.openingRepeat ? CONTENT_WEIGHTS.openingRepeat : 0;
  const contentRepeat = d.contentRepeat ? CONTENT_WEIGHTS.contentRepeat : 0;
  const total = aiFlavor + openingRepeat + contentRepeat;
  const top = contentRepeat >= openingRepeat && contentRepeat >= aiFlavor && contentRepeat > 0
    ? 'contentRepeat' as const
    : openingRepeat >= aiFlavor && openingRepeat > 0
      ? 'openingRepeat' as const
      : aiFlavor > 0 ? 'aiFlavor' as const : 'none' as const;
  return { total, top, breakdown: { aiFlavor, openingRepeat, contentRepeat } };
}

/** 问题分达到多少就值得打回重写（标定：内容重复单项 45 已超线；AI 味需 ≥9 档才够） */
export const CONTENT_PROBLEM_REWRITE_THRESHOLD = 40;

/**
 * 把决策结果翻成「是否打回」以及「重写指令聚焦哪一条」。
 *
 * 单独抽出来的原因：这是**唯一**把决策器输出接到流水线行为的地方，
 * 逻辑要能被单测钉死（尤其 accept_with_warning 绝不能变成 rewrite）。
 *
 * ★ 2026-10-18 实测教训（第 29 章）：决策器在**首次尝试**就判 `rewrite + worthIt=false`
 *   → 按原逻辑"带警示放行"，结果一次都没重写就交付了，而该章实际有 13–22 句逐字
 *   跨章重复。**决策器可以缩短循环，但不能把循环整个跳掉**。
 *   因此加一条硬底线：`attemptsDone === 0`（还没重写过）时，只要硬规则判不通过，
 *   就必须先重写一次（聚焦决策器给的 primaryIssue）；从第 2 次起才允许
 *   `worthIt=false` / `accept_with_warning` 带警示放行。
 *
 * ★ 2026-10-18 第二条底线（GUI 跑 10 章时抓到）：**篇幅是硬约束，决策器不许放行**。
 *   实测第 10 章 5869 字（上限 3500，超 68%）、第 11 章 5064 字、第 15 章 2017 字
 *   （下限 2500）都被交付了 —— 因为 worthIt=false 一票就能带警示放行。可是"篇幅"
 *   不是审美取舍，是**可判定的物理事实**：超限几乎总等于"靠复述凑字数"（第 10 章同时
 *   带 11 处章内重复），欠限则是没写完。这类事实**不进"值不值得改"的权衡**。
 *   由 `nonNegotiable` 传入（调用方按确定性检查算出来），命中即打回，不再看 worthIt。
 *   仍守住既有兜底：改满 MAX_REVISIONS 次还不达标，照样带警示交付（缺章更糟）。
 *
 * @param d              决策器结论
 * @param attemptsDone   本章已重写次数（0 = 还没改过）
 * @param opts.nonNegotiable 确定性硬伤（不可被 worthIt/accept 放行）；按顺序取第一条作为聚焦项
 */
export function decisionToGateAction(
  d: GateDecision,
  attemptsDone = 1,
  opts: { nonNegotiable?: readonly DecisionIssue[] } = {},
): {
  pass: boolean;
  /** 打回时聚焦修的那一条（pass=true 时为 'none'） */
  focus: DecisionIssue;
  /** 是否因为"至少先改一次"的底线而强行打回（观测用） */
  forcedFirstRewrite?: boolean;
  /** 是否因为确定性硬伤而强行打回（篇幅等在带外；观测用） */
  forcedByHardFact?: boolean;
  /** 内容体检的问题分与首要问题（观测用；pass 时也可能 >0，表示"带瑕疵放行"） */
  content?: ContentProblemScore;
} {
  /**
   * ★ 2026-10-27：**从"读 verdict"改成"读内容体检结果"**。
   *
   * 旧逻辑读 `d.verdict`（accept/rewrite/accept_with_warning）—— 那是决策器做总判决的年代。
   * 现在决策器只报告三项症状（AI 味 / 开头重复 / 内容重复），由**这里**决定怎么处理：
   * 问题分 ≥ 阈值 → 打回，并聚焦最重的那一项。
   */
  const content = scoreContentProblems(d);
  const focusOfContent = (): DecisionIssue => (
    content.top === 'contentRepeat' ? 'duplication'
      : content.top === 'openingRepeat' ? 'voice'
        : content.top === 'aiFlavor' ? 'voice'
          : 'none'
  );

  // 底线一：一次都没改过时，硬规则既然判了不通过，就先改一次再说 —— 决策器不能跳过首次重写
  /**
   * ★ 2026-10-29 修（审计确认）：**"至少改一次"只该在"确实有问题"时触发**。
   *
   * 原实现无条件 `attemptsDone === 0 → 打回`，但体检改成**每章必跑**之后
   * （原先只在硬规则不过时跑），这条底线变成了灾难：
   * **每一章的第一轮都要被无理由打回一次** —— 哪怕体检三项全绿。
   * 实测后果：每章 +1 次重写（多烧一次写作官），而且 focus 被填成 `duplication`，
   * `renderFocusedHint` 在无重复时返回空串 ⇒ 写作官收到"本轮只改这一条：重复"
   * 却没有任何具体内容，只能瞎改。
   *
   * 正确语义：这条底线的初衷是防「决策器在首次就判 worthIt=false ⇒ 一次都不改就交付」。
   * 现在决策器**不再做放行判决**（只报告症状），所以：
   *   · 有问题（content.total > 0 或单项成立）→ 仍要求先改一次（保留原意）
   *   · 完全没问题 → **直接放行**，不白烧一次重写
   */
  if (attemptsDone === 0) {
    const hasProblem = content.total > 0 || d.contentRepeat || d.openingRepeat || d.aiFlavor >= 9;
    if (!hasProblem) return { pass: true, focus: 'none', content };
    const f = focusOfContent();
    return { pass: false, focus: f === 'none' ? 'duplication' : f, forcedFirstRewrite: true, content };
  }
  // 底线二：确定性硬伤（如篇幅出带）—— 不看内容体检、不看别的，一律打回并聚焦该条
  const hard = (opts.nonNegotiable ?? [])[0];
  if (hard) {
    return { pass: false, focus: hard, forcedByHardFact: true, content };
  }
  /**
   * 内容问题够重 → 打回，只修最重的那一条（避免多要求互相打架）。
   *
   * ★ 2026-10-27 阈值口径修正（测试当场抓到）：**单看总分会让单项硬伤漏网**。
   *   原实现只判 `total >= 40`，而「开头重复」单项 = 30、「AI 味 10 档」单项 = 30 ——
   *   两者都够严重（读者一眼就看出来），却都低于 40 而不打回。
   *
   *   所以改成**两条都要**判：
   *     · 总分达阈值（多项叠加）；**或**
   *     · 单项本身就够重（内容重复 45 / 开头重复 30 / AI 味 ≥9 档折算 25+）
   *   这三项是**性质不同的病**，不该让它们互相"凑分"才够格 —— 一项成立就该修。
   */
  const singleSerious = d.contentRepeat
    || d.openingRepeat
    || d.aiFlavor >= 9;
  if (content.total >= CONTENT_PROBLEM_REWRITE_THRESHOLD || singleSerious) {
    return { pass: false, focus: focusOfContent(), content };
  }
  // 问题不重 → 放行（content.total 可能 >0：那是"带瑕疵交付"，调用方可据此落一条警示）
  return { pass: true, focus: 'none', content };
}

/** 决策器调用结果（失败时 decision=null，调用方回退旧规则） */
export interface DecisionResult {
  decision: GateDecision | null;
  /** 失败原因（供日志/交付警示） */
  error?: string;
  /** 实际使用的模型名 / 通道 */
  model?: string;
  /** 走的哪条通道：native=Jev systemone；chat=普通 chat 模型 */
  via?: 'native' | 'chat';
}

/**
 * 调一次决策器。**永不抛错**：任何失败都返回 decision=null，让调用方回退旧规则。
 *
 * 优先原生 Jev（systemone），没有配置则退 chat JSON。
 *
 * @param ctx      插件上下文（chat 兜底用 ctx.ai.complete）
 * @param state    结构化诊断
 * @param opts.model 覆盖 chat 模型；opts.jev 覆盖原生配置（便于测试）
 */
export async function runGateDecision(
  ctx: ServerPluginContext,
  state: DecisionState,
  opts: { model?: string | null; jev?: JevConfig | null; jevFallback?: JevConfig | null; userId?: string; timeoutMs?: number } = {},
): Promise<DecisionResult> {
  const jev = opts.jev !== undefined ? opts.jev : resolveJevConfig();
  const fallback = opts.jevFallback !== undefined ? opts.jevFallback : resolveJevFallback();
  const chatModel = opts.model !== undefined ? opts.model : resolveChatDecisionModel();
  const timeoutMs = opts.timeoutMs ?? 45_000;

  // ① 原生 Jev systemone（主端点 → 备用端点）
  const endpoints = [jev, fallback].filter((x): x is JevConfig => !!x);
  if (endpoints.length) {
    let lastError = '';
    let lastModel = '';
    for (let i = 0; i < endpoints.length; i += 1) {
      const ep = endpoints[i]!;
      lastModel = ep.model;
      try {
        const body = {
          model: ep.model,
          state: buildDecisionStatePayload(state),
          questions: buildSystemOneQuestions(),
        };
        const res = await withTimeout(fetch(ep.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(ep.token ? { authorization: `Bearer ${ep.token}` } : {}),
          },
          body: JSON.stringify(body),
        }), timeoutMs);
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          lastError = `Jev HTTP ${res.status}: ${t.slice(0, 160)}`;
          console.warn(`[gate-decision] 端点 ${i === 0 ? '主' : '备用'} 失败（${lastError}）${i + 1 < endpoints.length ? '，改走备用端点' : ''}`);
          continue;
        }
        const json = await res.json();
        const decision = decisionFromSystemOneAnswers((json as { answers?: unknown }).answers);
        if (!decision) {
          lastError = `Jev 返回无有效 answers：${JSON.stringify(json).slice(0, 160)}`;
          console.warn(`[gate-decision] 端点 ${i === 0 ? '主' : '备用'} 返回无效（${lastError}）${i + 1 < endpoints.length ? '，改走备用端点' : ''}`);
          continue;
        }
        return { decision, model: ep.model, via: 'native' };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.warn(`[gate-decision] 端点 ${i === 0 ? '主' : '备用'} 异常（${lastError}）${i + 1 < endpoints.length ? '，改走备用端点' : ''}`);
      }
    }
    return { decision: null, error: lastError || 'jev 端点全部失败', model: lastModel, via: 'native' };
  }

  // ② chat JSON 兜底（普通模型当替身）
  if (chatModel === null) return { decision: null, error: 'decision-disabled' };
  if (chatModel === undefined) return { decision: null, error: 'decision-not-configured' };
  try {
    const raw = await withTimeout(
      ctx.ai.complete({
        messages: [
          { role: 'system', content: CHAT_SYSTEM },
          { role: 'user', content: buildDecisionUserPrompt(state) },
        ],
        json: true,
        temperature: 0,
        maxTokens: 400,
        model: chatModel,
        ...(opts.userId ? { userId: opts.userId } : {}),
      }),
      timeoutMs,
    );
    const decision = normalizeDecision(parseJsonLoose<unknown>(raw));
    if (!decision) return { decision: null, error: `决策器输出无法解析：${String(raw).slice(0, 120)}`, model: chatModel, via: 'chat' };
    return { decision, model: chatModel, via: 'chat' };
  } catch (e) {
    return { decision: null, error: e instanceof Error ? e.message : String(e), model: chatModel, via: 'chat' };
  }
}

/** 超时包裹：决策器慢不该拖垮整章 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`决策器超时（${ms}ms）`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
