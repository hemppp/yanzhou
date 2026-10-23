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
//     chat 兜底读 `AUTOWRITE_DECISION_MODEL`。**都没配 = 决策器关闭**（不花任何模型钱）。
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
  verdict: DecisionVerdict;
  primaryIssue: DecisionIssue;
  /** 再重写一次是否真能变好（false ⇒ 别白烧，带警示放行） */
  worthIt: boolean;
  /** 是否在重复上一章情节、没有实质推进（确定性去重抓不到） */
  stalled: boolean;
  /** 网文连载标准打分 1–10（缺省/越界时按 0 处理） */
  quality: number;
  /** 决策器一句话理由（落库/日志用） */
  reason?: string;
  /** 决策器自报的把握度（choice/score 有；noul 没有）—— 供日志观察，不参与判断 */
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
 * 读 chat 兜底模型名。
 * - 未设置 / 空 → undefined（不启用 chat 模式）
 * - `off` / `none` → null
 */
export function resolveChatDecisionModel(env: Record<string, string | undefined> = process.env): string | null | undefined {
  const raw = (env.AUTOWRITE_DECISION_MODEL ?? '').trim();
  if (!raw) return undefined;
  if (raw.toLowerCase() === 'off' || raw.toLowerCase() === 'none') return null;
  return raw;
}

/** 决策器是否启用：配了原生 Jev 或配了 chat 兜底模型。**都没配 = 关闭**（不花钱）。 */
export function isDecisionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return resolveJevConfig(env) !== null || resolveJevFallback(env) !== null
    || typeof resolveChatDecisionModel(env) === 'string';
}

/** 决策器 system 提示词（仅 chat 兜底用）：要求**只输出一个 JSON** */
const CHAT_SYSTEM = [
  '你是长篇小说流水线的「意图门决策器」。作者已经写出一章正文，你要判断它该不该交付、还是值得再花一次重写。',
  '你会拿到一份**代码统计出的诊断**（重复句数、对话占比、字数、提纲泄漏）和一小段正文节选。',
  '确定性代码已经数得很准，**不要重复数**；你要做的是判断「该不该再改一次」「若改，最该改哪一条」。',
  '判断原则：',
  '· 若字数、重复、对话、泄漏**全部在带内** → accept。',
  '· 若只有**一条**明显出格 → rewrite，primaryIssue 填那一条。',
  '· 若已重写多次（rewritesSoFar 接近 maxRewrites）仍只差一点、或再改大概率只是换种方式犯同样的毛病 → accept_with_warning（别白烧）。',
  '· 若情节在原地打转、没有实质推进（stalled=true）→ 即使字数达标也倾向 rewrite。',
  '只输出**一个** JSON 对象，字段固定：verdict / primaryIssue / worthIt / stalled / quality / reason。不要解释、不要代码块。',
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
  };
}

/** chat 兜底用的用户消息 */
export function buildDecisionUserPrompt(s: DecisionState): string {
  return [
    '【诊断（代码统计）】',
    JSON.stringify(buildDecisionStatePayload(s), null, 0),
    '',
    '【正文节选】',
    s.excerpt,
    '',
    '请输出决策 JSON：',
    '{"verdict":"accept|rewrite|accept_with_warning","primaryIssue":"duplication|dialogue|length|plot_stall|voice|leak|none","worthIt":true|false,"stalled":true|false,"quality":1-10,"reason":"一句话"}',
  ].join('\n');
}

/** 原生 systemone 的 questions 定义（5 问，一次请求共享 state 输入成本） */
export function buildSystemOneQuestions(): Record<string, unknown> {
  return {
    verdict: {
      type: 'choice',
      instructions: '这一稿该放行、还是打回重写？accept=可以交付；rewrite=值得再花一次重写；accept_with_warning=带警示交付（再改也没用或只差一点）。',
      criteria: { accept: '可以交付', rewrite: '值得再花一次重写', accept_with_warning: '带警示交付' },
    },
    primaryIssue: {
      type: 'choice',
      instructions: '若重写，最该修哪一条？（只挑一条，避免多要求互相打架）',
      criteria: {
        duplication: '章内或跨章重复', dialogue: '对话太少', length: '篇幅超出/不足',
        plot_stall: '情节原地打转、没有推进', voice: '文风不对', leak: '正文混入提纲/元话语', none: '没有明显问题',
      },
    },
    worthIt: { type: 'noul', instructions: '再重写一次，真的能变好，还是只会换个方式犯同样的毛病？' },
    stalled: { type: 'noul', instructions: '本章是否在重复上一章的情节，没有实质推进？' },
    quality: {
      type: 'score',
      instructions: '按网文连载标准给本章打分（1 最差，10 最好）。',
      criteria: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    },
  };
}

/** 把模型返回的任意对象**归一化**成合法 GateDecision；任何字段缺失/越界都按保守默认填 */
export function normalizeDecision(raw: unknown): GateDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const verdict = String(o.verdict ?? '').trim().toLowerCase();
  if (!DECISION_VERDICTS.includes(verdict as DecisionVerdict)) return null;
  let issue = String(o.primaryIssue ?? 'none').trim().toLowerCase();
  if (!DECISION_ISSUES.includes(issue as DecisionIssue)) issue = 'none';
  const q = Number(o.quality);
  const c = Number(o.confidence);
  return {
    verdict: verdict as DecisionVerdict,
    primaryIssue: issue as DecisionIssue,
    worthIt: o.worthIt === true || o.worthIt === 'true' || o.worthIt === 1,
    stalled: o.stalled === true || o.stalled === 'true' || o.stalled === 1,
    quality: Number.isFinite(q) ? Math.max(0, Math.min(10, q)) : 0,
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
  const verdictRaw = a.verdict && typeof a.verdict === 'object' ? String(a.verdict.choice ?? '') : '';
  if (!DECISION_VERDICTS.includes(verdictRaw as DecisionVerdict)) return null;
  const issueRaw = a.primaryIssue && typeof a.primaryIssue === 'object' ? String(a.primaryIssue.choice ?? 'none') : 'none';
  const issue = (DECISION_ISSUES as readonly string[]).includes(issueRaw) ? (issueRaw as DecisionIssue) : 'none';
  const noul = (k: string): boolean => {
    const v = a[k] && typeof a[k] === 'object' ? Number(a[k].noul) : NaN;
    return Number.isFinite(v) && v >= NOUL_YES_THRESHOLD;
  };
  const scoreVal = a.quality && typeof a.quality === 'object' ? Number(a.quality.score) : NaN;
  const quality = Number.isFinite(scoreVal) ? Math.max(1, Math.min(10, Math.round(scoreVal + 1))) : 0;
  const conf = a.verdict && typeof a.verdict === 'object' ? Number(a.verdict.confidence) : NaN;
  const probs = a.verdict && typeof a.verdict === 'object' ? a.verdict.probabilities : undefined;
  const reason = probs && typeof probs === 'object'
    ? `choice=${verdictRaw}; P=${Object.entries(probs as Record<string, number>).map(([k, v]) => `${k}:${v}`).join(',')}`
    : undefined;
  return {
    verdict: verdictRaw as DecisionVerdict,
    primaryIssue: issue,
    worthIt: noul('worthIt'),
    stalled: noul('stalled'),
    quality,
    ...(Number.isFinite(conf) ? { confidence: Math.max(0, Math.min(1, conf)) } : {}),
    ...(reason ? { reason } : {}),
  };
}

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
 * @param d           决策器结论
 * @param attemptsDone 本章已重写次数（0 = 还没改过）
 */
export function decisionToGateAction(d: GateDecision, attemptsDone = 1): {
  pass: boolean;
  /** 打回时聚焦修的那一条（pass=true 时为 'none'） */
  focus: DecisionIssue;
  /** 是否因为"至少先改一次"的底线而强行打回（观测用） */
  forcedFirstRewrite?: boolean;
} {
  const focusOf = (): DecisionIssue => (d.primaryIssue === 'none' ? 'duplication' : d.primaryIssue);

  // 底线：一次都没改过时，硬规则既然判了不通过，就先改一次再说 —— 决策器不能跳过首次重写
  if (attemptsDone === 0) {
    return { pass: false, focus: focusOf(), forcedFirstRewrite: true };
  }
  if (d.verdict === 'accept') return { pass: true, focus: 'none' };
  if (d.verdict === 'accept_with_warning') return { pass: true, focus: 'none' };
  // rewrite：只有 worthIt 为 true 才真的打回；worthIt=false 说明再改也没用 → 带警示放行
  if (!d.worthIt) return { pass: true, focus: 'none' };
  return { pass: false, focus: focusOf() };
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
