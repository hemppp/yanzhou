// ============================================================
// 三条硬阻塞（硬门禁）—— 方法论来自 Wooooooooood/ai-fiction-writer（MIT），
// 但**拦人的是代码，不是提示词**。
//
// 为什么必须落成代码（这是整个文件存在的理由）：
//   那三条在原包里写在 SKILL.md 的正文里，配一个 `hard_block: {require_scene_card…}` 的
//   声明。但在纯提示词系统里，那只是**模型自律** —— 模型可以无视，而且它越"配合"
//   越危险：它会假装填了卡。本模块的门禁一律**由代码判、代码拦**，与
//   `discuss/gate-rules.ts`（"不依赖模型自报"）同一口径。
//
// 三条门：
//   ① 不填场景逻辑卡（微逻辑卡）不许写正文 —— `checkSceneLogicCard`，写前拦。
//   ② 不过动作前四问不许动笔 —— 四问的答案就落在场景卡里（谁在场/在哪/什么时刻、
//      为什么这么做、信息从哪来），所以与①同一次检查，不另开门。
//   ③ 未过 85 不许定稿 —— `scoreChapterForFinalize`，交付时判；
//      **只决定"能不能标定稿"，不拦交付**（见下）。
//
// ★ 关于③为什么不拦交付（这条是刻意的，不是偷懒）：
//   `framework/gates.ts` 的治理口径写明「润色门是软门：只评分、给意见，**从不阻塞** ——
//   评分低不该拦下一章」，那是一条用真实事故换来的结论（2026-09-12：两次打回后
//   整章 3333 字全废，代价远大于残留一处小冲突）。
//   所以"未过 85 不许定稿"在这里的正确落法是：**正文照旧交付（status 保持 draft），
//   但不给"定稿"这个身份**（status 不提升到 final）。作者能在章节列表里一眼看出
//   哪些章是"交是交了、但没到定稿线"。
//
// 纯函数、零模型调用、零 DB —— 可直接单测。
// ============================================================

/** 一个章节字段在**本章结论**里的必填项 */
export interface SceneCardField {
  /** 契约里的标签（定稿官按这个格式输出） */
  key: string;
  /** 它回答的是哪个问题（报告缺项时写给作者看） */
  why: string;
}

/**
 * 场景逻辑卡的必填字段 = 定稿官现有契约 + 补上的三项逻辑字段。
 *
 * ★ 前三项（节拍/角色/故事内时间）与后六项里的 关键物/伏笔/禁项/结束状态
 *   本来就是 `ROLE_CONVENER` 的契约；`场景` 与 `动机` 是**本次为四问新加的**
 *   （见 `discuss/roles.ts` 的定稿官 system）。
 *   —— 这正是"不填卡不许写"的前提：不先把卡加进契约，检查就只会变成
 *   一个永远拦下所有章节的误报源。
 */
export const SCENE_CARD_FIELDS: readonly SceneCardField[] = [
  { key: '节拍', why: '这一章分几拍' },
  { key: '场景', why: '四问①②：每个场景里 谁在场、在哪、什么时刻' },
  { key: '角色', why: '四问①：谁在场，各自本章的状态变化' },
  { key: '动机', why: '四问③：他们为什么这么做' },
  { key: '关键物', why: '四问④：道具/信息从哪来' },
  { key: '伏笔', why: '本章伏笔怎么处理（埋 / 推进 / 不动）' },
  { key: '禁项', why: '明确不许出现的内容' },
  { key: '结束状态', why: '本章结束时谁知道了什么（四问④的下游）' },
  { key: '故事内时间', why: '判断「她说昨天」对不对的唯一依据' },
];

/**
 * 契约里会出现、但**不是必填**的标签。
 *
 * ★ 为什么必须把它们也算成标签：解析器"识别到标签就断开上一个字段"，
 *   不认识的行会**并进上一个字段的值**。而 `待定` 是契约里的最后一项，
 *   定稿官常在别的项后面顺手写它 —— 一旦不被识别，
 *   `场景：无` + 下一行 `待定：有分歧` 会拼成 `无\n待定：有分歧`，
 *   于是 `场景` 看起来"填了"，空项检查漏报，门就放行了。
 *   这正是本文件最不能出的错方向（漏报 = 退回模型自律），所以按标签处理。
 */
const OPTIONAL_LABELS: readonly string[] = ['待定'];

const LABELS: readonly string[] = [...SCENE_CARD_FIELDS.map((f) => f.key), ...OPTIONAL_LABELS];

/** 算「没填」的占位值 —— 模型被要求写「无」时不能算填了 */
const EMPTY_VALUES = new Set(['', '无', '（无）', '(无)', '暂无', '略', '—', '-', 'n/a', 'N/A']);

/**
 * 一个字段的值算不算「空」。
 *
 * 只看**第一个非空行**：契约要求占位写成「无」，而多行值的第一行才是它真正想说的话。
 * 这样即便有无法识别的杂行（如 `备注：…`）被并进值里，`无\n备注：随手记`
 * 仍然判为空 —— 宁可多拦一次（补内容很便宜），不可漏拦（整章带缺陷过关）。
 * 用「整行相等」而不是「前缀匹配」，避免把 `无人的栈桥` 这类真实内容误判成空。
 */
function isEmptyValue(raw: string): boolean {
  const first = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
  return EMPTY_VALUES.has(first.replace(/[。.；;，,]+$/, ''));
}

/**
 * 按「行首的 `标签：` + 后续行直到下一个标签」解析契约。
 *
 * 为什么不用一条大正则：定稿官的值是**多行**的（契约里 `角色` 一项自己就横跨两行），
 * 而正则里 `$` 在 `m` 模式下匹配**行尾**，会把多行值截断在第一个换行处。
 * 逐行状态机没有这个坑，也更好单测。
 */
export function parseContractFields(conclusion: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = String(conclusion ?? '').split(/\r?\n/);
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (cur !== null) out.set(cur, buf.join('\n').trim());
    buf = [];
  };
  for (const line of lines) {
    // 标签最多 5 字（故事内时间），且必须**恰好命中**契约里的标签 ——
    // 不做模糊匹配，避免正文里的冒号被当成字段。
    const m = /^[ \t]*([^\s：:]{1,8})[ \t]*[：:]/.exec(line);
    const label = m && m[1] && LABELS.includes(m[1]) ? m[1] : null;
    if (label) {
      flush();
      cur = label;
      buf.push(line.slice(m![0].length).trim());
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

export interface SceneCardVerdict {
  ok: boolean;
  /** 契约里**整项没有**的字段标签 */
  missing: string[];
  /** 有标签但内容为空/占位的字段标签 */
  empty: string[];
}

/**
 * 门① + 门②：场景逻辑卡（含四问）是否填齐。
 *
 * 缺项与空项分开报 —— 前者是"格式没照契约写"，后者是"写了但没内容"，
 * 给作者看的下一步动作不一样（前者重发契约，后者补内容）。
 */
export function checkSceneLogicCard(conclusion: string): SceneCardVerdict {
  const fields = parseContractFields(conclusion);
  const missing: string[] = [];
  const empty: string[] = [];
  for (const f of SCENE_CARD_FIELDS) {
    const v = fields.get(f.key);
    if (v === undefined) missing.push(f.key);
    else if (isEmptyValue(v)) empty.push(f.key);
  }
  return { ok: missing.length === 0 && empty.length === 0, missing, empty };
}

/** 把缺项渲染成给作者/定稿官看的一句话 */
export function renderSceneCardGap(v: SceneCardVerdict): string {
  const parts: string[] = [];
  if (v.missing.length) parts.push(`缺项：${v.missing.join('、')}`);
  if (v.empty.length) parts.push(`空白：${v.empty.join('、')}`);
  return parts.join('；');
}

/**
 * 四问的答案分别由哪些字段承载（报告用；也让"这张卡为什么长这样"可追溯）。
 * 四问本身不单独开门 —— 它的答案就是卡里的字段，见文件头。
 */
export const FOUR_QUESTIONS: ReadonlyArray<{ q: string; fields: string[] }> = [
  { q: '谁在场？', fields: ['场景', '角色'] },
  { q: '他们刚在哪？', fields: ['场景'] },
  { q: '他们为什么要这么做？', fields: ['动机'] },
  { q: '这个信息/道具/称呼从哪来的？', fields: ['关键物', '结束状态'] },
];

// ============================================================
// 门③：定稿分
// ============================================================

/**
 * 定稿线。
 *
 * ★ 口径：**任何一处硬伤都足以让这一章不能定稿** —— 所以下面每一项扣分都 ≥16，
 *   而线是 85。一条干净的章 = 100 分；踩到任意一条就掉到 85 以下。
 *   这不是"扣分制"的巧合，是刻意的：定稿意味着"可以发出去了"，
 *   而带硬伤的章不该有那个身份。
 *
 *   权重的相对大小按**对读者的伤害**排：意图门未通过（答应的没做到）最根本；
 *   提纲泄漏（成品被一眼看出是机器写的）次之；重复与篇幅再次；对话形态最轻。
 *   与 `gate-decision.ts` 的权重一样，这些数字是**代码定的口径**，写在注释里以便日后标定。
 */
export const FINALIZE_MIN_SCORE = 85;

/** 交付点能拿到的全部判据（**全部来自已有代码判定，本门不新增任何模型调用**） */
export interface FinalizeFacts {
  /** 意图门最终是否放行 */
  reviewPassed: boolean;
  /** 章内重复超限 */
  repExcessive: boolean;
  /** 跨章重复超限 */
  crossExcessive: boolean;
  /** 篇幅出带（超上限或欠下限） */
  outOfBand: boolean;
  /** 提纲/结构语言泄漏超限 */
  leakTooMany: boolean;
  dlgLow: boolean;
  dlgHigh: boolean;
  dlgFragmented: boolean;
  /** 校对门（硬门）是否通过 */
  consistencyPassed: boolean;
  /** 校对门**没能执行**（模型/解析失败）—— fail-open，不扣分 */
  consistencySkipped: boolean;
  /** 润色门评分 0–10 */
  polishScore: number;
  /** 润色门没能执行 —— fail-open，不扣分 */
  polishSkipped: boolean;
  /** 润色门通过线（默认取自 gates.ts 的 POLISH_PASS_SCORE） */
  polishPassScore?: number;
}

export interface FinalizeVerdict {
  /** 0–100 */
  score: number;
  /** 是否达到定稿线（= 可否把章节 status 提升为 final） */
  ok: boolean;
  deductions: Array<{ reason: string; points: number }>;
}

/**
 * 算定稿分。
 *
 * ★ **执行失败的门不扣分（fail-open）**：与 `gates.ts` 的口径一致 ——
 *   "绝不能因为基础设施抖动就让稿子被打回"。跳过一次检查不等于稿子有问题。
 *   代价是：模型调用挂了的那一章更容易拿到定稿身份。这是刻意的取舍，
 *   因为反向的代价（因为一次超时把好章判成不能定稿）会污染整个作者对这条线的信任。
 */
export function scoreChapterForFinalize(f: FinalizeFacts): FinalizeVerdict {
  const passScore = f.polishPassScore ?? 7;
  const deductions: Array<{ reason: string; points: number }> = [];
  const add = (on: boolean, reason: string, points: number): void => {
    if (on) deductions.push({ reason, points });
  };

  add(!f.reviewPassed, '意图门未通过（没写出约定的那一章）', 40);
  add(f.leakTooMany, '正文混入提纲/结构语言（成品被一眼看出是机器写的）', 30);
  add(f.repExcessive, '章内重复超限', 25);
  add(f.crossExcessive, '与前面章节重复超限', 25);
  add(f.outOfBand, '篇幅出带', 20);
  add(!f.consistencyPassed && !f.consistencySkipped, '校对门未消除设定冲突', 20);
  add(f.dlgLow, '对话占比过低', 16);
  add(f.dlgHigh, '对话占比过高（动作与环境被挤掉）', 16);
  add(f.dlgFragmented, '对话过碎（电报体应答）', 16);
  add(!f.polishSkipped && f.polishScore < passScore, `润色门评分 ${f.polishScore}/10 低于通过线 ${passScore}`, 16);

  const score = Math.max(0, 100 - deductions.reduce((a, d) => a + d.points, 0));
  return { score, ok: score >= FINALIZE_MIN_SCORE, deductions };
}

/** 定稿门的一句话结论（进 gate 事件的 detail） */
export function renderFinalizeDetail(v: FinalizeVerdict): string {
  if (v.deductions.length === 0) return `定稿分 ${v.score}/100 —— 无扣分项，符合定稿线 ${FINALIZE_MIN_SCORE}`;
  const list = v.deductions.map((d) => `${d.reason} −${d.points}`).join('；');
  return `定稿分 ${v.score}/100（线 ${FINALIZE_MIN_SCORE}）—— ${list}`;
}
