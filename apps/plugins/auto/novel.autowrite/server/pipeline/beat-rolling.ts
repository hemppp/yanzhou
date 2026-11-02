// ============================================================
// 在线补纲（rolling beats）—— 长跑途中自动补节拍卡
//
// ★ 为什么必须有它（2026-10-29 实测，本项目最大的结构性缺口）：
//
//   节拍卡（beats）机制本来设计得很完整：首次铺 10 章、之后**每跑一次 beats 段**滚动补 5 章。
//   但 **production 段从不回头跑 beats**。于是：
//     · 节拍卡覆盖：第 1–10 章
//     · 实际写到：第 85 章
//     · **75 章（88%）是在没有施工图的情况下写的**
//
//   没有卡时 `production.ts` 只发一句警告「按"至少一个不可逆结果"的兜底要求写」，
//   那是个极弱的约束 —— 等于告诉模型"随便写点什么，只要有点变化"。
//
//   这解释了长跑的全部症状：
//     · **开头重复**（7/10 章）—— 不是起手式问题，是**没有新事件可写**，
//       角色只能反复做同一个动作（掏拓片 → 对灯看 → 塞回去）
//     · **平缓日常章** —— 没有规划过的情节推进
//     · **跨章重复 188 句** —— 素材耗尽，只能复用旧段
//
//   ★ 关键教训：我之前装的两门写作技能（enter late / yes-but）**治不了这个** ——
//     它们优化「怎么写」，而问题是「没东西可写」。**补错了洞。**
//
// 本模块只做一件事：**写某章之前，确保它（及后面几章）有节拍卡**。
// 补卡失败一律 fail-open（按无卡继续写），绝不能因为补纲挂了就不写书。
// ============================================================

import type { ServerPluginContext } from '@novel/core';
import type { DesignRole } from '../discuss/roles.js';
import { beatsCoverage, renderBeatsTask } from './beats.js';
import { specFor } from './roles-phase.js';
import type { PipelineEvent } from './types.js';

/** 每次补几张卡（与 beats 段的滚动批量一致） */
export const ROLLING_BEATS_BATCH = 5;

export interface BeatCoverageCheck {
  /** 是否需要补卡 */
  needed: boolean;
  /** 节拍卡当前覆盖到第几章（0 = 一张都没有） */
  coveredMax: number;
  /** 要补哪几章 */
  range: number[];
}

/**
 * 纯函数：判断写 `order` 章之前要不要补卡。
 *
 * 判据：**本章有没有卡**。没有就补一批（从 `max(已覆盖, 已交付) + 1` 起）。
 * 这样既不会重复补已规划的章，也不会补已经写完的章。
 */
export function checkBeatCoverage(
  artifact: string | undefined | null,
  order: number,
  lastDelivered: number,
): BeatCoverageCheck {
  const { orders, max } = beatsCoverage(artifact);
  const hasCard = orders.includes(order);
  if (hasCard) return { needed: false, coveredMax: max, range: [] };

  /**
   * ★ 2026-10-31 修**填不了空洞**的结构性缺陷（实测第 2、3 章重演同一场戏）。
   *
   * 旧实现：`nextBeatRange(artifact, BATCH, max(lastDelivered, order - 1))`。
   * 而 `nextBeatRange` 的起点是 `max(已覆盖最大章, lastDelivered) + 1` —— **只会往后延**。
   * 于是当卡覆盖到第 22 章、而真正要写的是第 4 章时：
   *   起点 = max(22, 3) + 1 = **23** ⇒ 补的是 23–27，**第 4 章永远补不到**。
   * 实测后果（《铁壳里的声音》）：第 2、3、4 章全程无卡，写作官只能接着上一章
   * 再演一遍同样的场景（去城北废品站找梅某、递发夹、踩碎干羊粪），
   * 而"重演"的词面重合度很低，重复闸门抓不到 ⇒ 一路绿灯交付。
   *
   * 正确语义：**本次要写的那一章缺卡，就先补它**。
   *   · 本章（`order`）**未交付**（order > lastDelivered）→ 就从本章起补一批；
   *   · 本章已交付（回头看、或补的是旧章）→ 退回原口径，从未来那一段往后补。
   * 用 `Math.max(order, …)` 而不是 `order - 1` 是关键：
   * 原来传 `order - 1` 等于把本章排除在候选之外，这也是漏补的直接原因。
   */
  const from = order > lastDelivered
    ? Math.max(order, 1)
    : Math.max(max, lastDelivered) + 1;
  return {
    needed: true,
    coveredMax: max,
    range: Array.from({ length: ROLLING_BEATS_BATCH }, (_, i) => from + i),
  };
}

/** 把新生成的卡**追加**到已有 artifact 末尾（不覆盖旧卡 —— 旧卡是已写章节的记录） */
export function appendBeatCards(existing: string | undefined | null, fresh: string): string {
  const base = String(existing ?? '').trim();
  const add = String(fresh ?? '').trim();
  if (!add) return base;
  if (!base) return add;
  return `${base}\n\n---\n\n${add}`;
}

export interface RollingBeatsDeps {
  ctx: ServerPluginContext;
  projectId: string;
  userId: string;
  /** 跑一个角色（由调用方注入 —— production 有自己的 speak 实现） */
  speak: (role: DesignRole, extra?: string) => Promise<string>;
  emit: (e: PipelineEvent) => void;
}

/**
 * 补一批节拍卡，返回**新增的那段文本**（调用方负责 append 到 artifact）。
 *
 * 角色阵容与 beats 段一致（剧情设计师主笔 → 设定管家 → 角色设计师 → 反驳 → 定稿官收敛），
 * 但**不走 `runStage`** —— 那会把 beats 段置为 running 并 invalidate 下游已批准状态。
 * 长跑途中补纲是**增补**，不该影响流水线游标。
 *
 * 失败一律返回空串（fail-open）：补不出卡就按无卡继续写，不能卡住长跑。
 */
export async function generateBeatCards(
  deps: RollingBeatsDeps,
  range: readonly number[],
): Promise<string> {
  if (!range.length) return '';
  const spec = specFor('beats');
  if (!spec) return '';
  const { speak, emit } = deps;
  const task = renderBeatsTask(range);

  emit({
    type: 'stage_phase', stage: 'production',
    label: `在线补纲：第 ${range[0]}–${range[range.length - 1]} 章没有节拍卡，先补 ${range.length} 张…`,
  });

  /**
   * ★ 2026-10-29 修（第一版实测失败）：**必须维护共享讨论记录**。
   *
   * 第一版只把 task 传给每个角色、没有 transcript —— 于是每个角色都是"孤岛"：
   * 定稿官看不到剧情设计师规划了哪些拍，只能自己另起炉灶，
   * 产出的是「签署定稿」的确认书而不是卡本身 ⇒ 覆盖检查失败、补纲作废。
   *
   * `runStage` 里由 `buildInput` 负责拼 transcript（后者能看到前者说了什么），
   * 这里必须同样做，否则"讨论"退化成一堆并行独白。
   */
  const transcript: Array<{ name: string; text: string }> = [];
  const speakWithHistory = async (role: Parameters<typeof speak>[0], extra?: string): Promise<string> => {
    const history = transcript.length
      ? `【本轮讨论记录】\n${transcript.map((t) => `◆ ${t.name}：\n${t.text}`).join('\n\n')}`
      : '';
    const text = await speak(role, [history, extra].filter(Boolean).join('\n\n'));
    if (text.trim()) transcript.push({ name: role.name, text });
    return text;
  };

  try {
    // 与 beats 段同构：主笔 → 依次回应 → 主笔反驳 → 定稿官收敛
    for (const role of spec.speakers) await speakWithHistory(role, task);
    if (spec.rebuttal) await speakWithHistory(spec.rebuttal.role, spec.rebuttal.extra);
    /**
     * ★ 定稿官那一轮**也要给任务**（第一版漏了）：它要收敛成《章节大纲与节拍卡》，
     * 必须知道范围是哪几章、以及格式要求。
     */
    const artifact = await speakWithHistory(
      spec.convener,
      [
        task,
        '',
        '【收敛要求】把上面的讨论收敛成《章节大纲与节拍卡》，**严格按你 system 里的逐章格式**：',
        `每章一行「第N章｜本章功能：…」，下面 3–5 个 beat（场景·目标·阻碍·灾难）+ 至少一个 sequel（反应·困境·决定）+ 章末钩子。`,
        `只输出这 ${range.length} 章的卡，不要写"签署定稿"之类的确认书，不要写散文。`,
      ].join('\n'),
    );
    if (!artifact.trim()) return '';
    /**
     * 防御：定稿官可能跑偏去规划别的章 —— 只接受确实覆盖了目标范围的结果。
     *
     * ★ 2026-10-29 修（审计确认）：**部分覆盖也要如实报缺哪几章**。
     *   原实现只要 `covered.length > 0` 就说"完成"，而 `checkBeatCoverage` 的起点是
     *   `max(已覆盖, 已交付) + 1` —— 中间出现空洞时，**空洞那几章仍然没卡照写**，
     *   而且空洞下方每一章都会再烧一次完整讨论去生成更靠后、用不上的卡。
     */
    const got = beatsCoverage(artifact).orders;
    const covered = range.filter((o) => got.includes(o));
    const missing = range.filter((o) => !got.includes(o));
    if (!covered.length) {
      emit({
        type: 'stage_phase', stage: 'production',
        label: `在线补纲失败：定稿官没有产出目标章节（第 ${range.join('、')} 章）的卡，按无卡继续写`,
      });
      return '';
    }
    emit({
      type: 'stage_phase', stage: 'production',
      label: `在线补纲完成：新增第 ${covered[0]}–${covered[covered.length - 1]} 章的节拍卡（${covered.length}/${range.length}）`
        + (missing.length ? ` · **缺第 ${missing.join('、')} 章**，那几章将按无卡继续写` : ''),
    });
    return artifact;
  } catch (e) {
    console.warn('[beats] 在线补纲失败（按无卡继续写）:', e);
    emit({
      type: 'stage_phase', stage: 'production',
      label: `在线补纲失败（${e instanceof Error ? e.message : String(e)}），按无卡继续写`,
    });
    return '';
  }
}

