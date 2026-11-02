// ============================================================
// 章节节拍卡（beat cards）—— 纯函数层
//
// ★ 为什么需要这一层（2026-10-23 诊断，对照专业写作流程）：
//   专业作家写每一章之前会做「节拍卡」：这一章分 3–5 个场景，每个场景
//   goal → conflict → outcome。模块的设计文档也写了收 `outline_nodes` 是
//   **act → chapter → beat 三层树**，但实测库里是 act 3 / chapter 24 / **beat 0** ——
//   第三层从来没生成过。
//
//   后果直接可测：写到第 25 章之后（总纲只到 24 章）**没有任何一层知道这一章该干什么**，
//   而写作指令还在说"按《剧情总纲》里第 47 章的节拍走"（总纲里没有第 47 章）。
//   模型只能抓最近三章的手感往下接 ⇒ 复读、原地打转、整章重讲同一件事。
//
// 真源放在**阶段契约文本**里（`stages.beats.artifact`），不另建表：
//   这一层与总纲同源（都由剧情设计师产出、都由作者在闸门审），
//   分开存会出现"文本说的"和"库里记的"两份真源。
// ============================================================

/**
 * 一拍 = Swain 的 **Scene**：目标 / 冲突 / **灾难**。
 *
 * ★ 2026-10-23 依权威原文修正（此前写成"目标/阻碍/**结果**"，语义偏了）：
 *   Randy Ingermanson 转述 Swain：`A Disaster is a failure to let your POV character reach his Goal.`
 *   并且明确警告 **`Don't give him the Goal!`** —— 每一拍主角**得不到**他想要的，
 *   得到的是"更糟的局面"。把结果写成"她成功确认了…"就是给了 Goal，故事张力立刻塌掉。
 *   所以字段名从 `result` 改为 `disaster`，提示词也改成"必须是一场失败"。
 */
export interface Beat {
  scene: string;
  goal: string;
  obstacle: string;
  /** 灾难：主角**没能**达成目标，反而陷入更糟的局面（Swain 的 Disaster） */
  disaster: string;
}

/**
 * 一拍 = Swain 的 **Sequel**：反应 / 困境 / 决定。
 *
 * 原文：`a unit of transition that links two scenes`，作用是
 * **`transition from the disaster to a new goal`** —— 把"灾难"转成下一个"目标"。
 * Ingermanson 特别强调：`A Scene ends on a Disaster, and you can't immediately follow that up
 * with a new Scene` —— **中间必须有 sequel**，否则读者跟不上情绪。
 *
 * ★ 这本书的"平缓日常章"正是缺这个：有反应、有困境、**没有决定** ⇒ 故事不往前走。
 */
export interface Sequel {
  /** 反应：对上一拍灾难的情绪余波 */
  reaction: string;
  /** 困境：没有好选项的处境 */
  dilemma: string;
  /** 决定：选了一条路，并且它成为下一拍的目标 */
  decision: string;
}

export interface BeatCard {
  order: number;
  /** 本章功能（一句话；相邻章不许相同） */
  purpose: string;
  beats: Beat[];
  /** 本章的 sequel（可 0–n 个；要求每章至少一个"决定"） */
  sequels: Sequel[];
  /** 章末钩子：一个未闭合的问题 */
  hook: string;
}

function clean(s: string): string {
  return s.replace(/\*\*/g, '').replace(/^[\s·•\-—－]+/, '').trim();
}

/**
 * 从「键：值」形式里取值；取不到返回空串。
 *
 * ★ 值必须**止于换行**（`[^｜|\n]*`）。第一版漏了 \n，于是
 *   `本章功能：回收…\n  beat1 场景：…` 被整段吞进「本章功能」，
 *   渲染出来就是"本章功能里又印了一遍 beat1"（实测抓包看到过）。
 */
function field(line: string, key: string): string {
  const m = new RegExp(`${key}\\s*[：:]\\s*([^｜|\\n]*)`).exec(line);
  return m ? clean(m[1] ?? '') : '';
}

/**
 * 从《章节大纲与节拍卡》契约文本里抽出某一章的卡。
 *
 * 解析形态（定稿官契约强制这个结构，见 roles-phase.ts 的 CONVENER_BEATS）：
 *   第25章｜本章功能：xxx
 *     beat1 场景：A｜目标：B｜阻碍：C｜结果：D
 *     beat2 …
 *     章末钩子：xxx
 *
 * ★ 容错优先：模型不会每次都写得规整。**只要拿到"本章功能 + 至少一个 beat"，就算拿到卡**；
 *   缺 beat 的结果字段就留空，由调用方在指令里点名"这一拍结果缺失"，
 *   而不是整张卡判无效（那会把好不容易生成的卡丢掉）。
 */
export function extractBeatCard(artifact: string | undefined | null, order: number): BeatCard | null {
  const text = String(artifact ?? '');
  if (!text.trim()) return null;

  /**
   * 找到这一章的段落：从**行首**的「第N章」到下一张卡的「第M章」之前。
   *
   * ★ 2026-10-31 修（与 `beatsCoverage` 同源）：旧实现用裸的 `第N章` 在**全文任意位置**找起点，
   *   于是裁决书正文里的**提及**（"不与**第7章**怕主显冲突"）也会被当成第 7 章卡的开头，
   *   切出一段根本没卡的散文喂给写作官。改成只认**行首**的卡标题（`第N章｜` / 独立一行的 `第N章`）。
   *   允许前面有 markdown 记号（`#`、`*`、`-`、空白），兼容手写/导出的变体。
   */
  const cardStart = new RegExp(`^[ \\t#*\\-]*第\\s*${order}\\s*章(?=[｜|：:\\s]|$)`, 'm').exec(text);
  if (!cardStart) return null;
  const rest = text.slice(cardStart.index + cardStart[0].length);
  const nextCh = /^[ \t#*\-]*第\s*\d+\s*章(?=[｜|：:\s]|$)/m.exec(rest);
  const block = nextCh ? rest.slice(0, nextCh.index) : rest;

  const purpose = field(block, '本章功能') || field(block, '功能');

  /**
   * 把连续的 beat 行**归组成同一拍**再取字段。
   *
   * ★ 2026-10-23 修的解析 bug：模型常把同一拍拆成两行写 ——
   *     `  beat1 场景：上城回水湾西网边`      ← 换行断开
   *     `beat1｜场景：上城回水湾西网边｜目标：…｜阻碍：…｜结果：…`
   *   逐行解析会把它当成**两个 beat**，渲染出来就多了一拍"只有场景、其余全缺"
   *   （实测抓包见 writing prompt：beat1 出现两次，其中一次挂着"⚠️ 缺阻碍、结果"）。
   *
   * 归组规则：遇到含 beat/节拍 的行开新组；随后的行只要**含四件套里的任一字段**就并进当前组
   * （它可能是同一拍被折断的后半截，也可能是模型的续写）。合并时每个字段取**第一个非空值**。
   */
  const beatIndex = (line: string): number | null => {
    const m = /(?:beat|节拍)\s*(\d+)/i.exec(line);
    return m ? Number(m[1]) : null;
  };
  const groups: string[][] = [];
  let curIdx: number | null = null;
  for (const line of block.split(/\n+/)) {
    const idx = beatIndex(line);
    const hasField = /场景|目标|阻碍|冲突|结果|结局/.test(line);
    if (idx !== null) {
      // 拍号相同 → 是同一拍被折断的后半截（模型会重复写一遍 beatN）；
      // 拍号不同 → 真正的新一拍
      if (groups.length === 0 || idx !== curIdx) { groups.push([line]); curIdx = idx; }
      else groups[groups.length - 1]!.push(line);
      continue;
    }
    if (groups.length > 0 && hasField) groups[groups.length - 1]!.push(line);
  }

  const beats: Beat[] = [];
  for (const g of groups) {
    const joined = g.join('｜');
    const scene = field(joined, '场景');
    const goal = field(joined, '目标');
    const obstacle = field(joined, '阻碍') || field(joined, '冲突');
    // 兼容旧卡：早期生成的卡把这一栏写成"结果"，语义上就是这场戏的结局（通常是失败）
    const disaster = field(joined, '灾难') || field(joined, '结果') || field(joined, '结局');
    if (!scene && !goal && !disaster) continue;
    beats.push({ scene, goal, obstacle, disaster });
  }

  /**
   * sequel（反应/困境/决定）。同样按"块"归组：
   * 一个 sequel 块以 `sequel` 开头，内部三行分别给 反应/困境/决定。
   */
  const sequels: Sequel[] = [];
  const seqBlocks = block.split(/\n(?=\s*(?:sequel|续拍))/i);
  for (const sb of seqBlocks) {
    if (!/^\s*(?:sequel|续拍)/i.test(sb)) continue;
    const reaction = field(sb.replace(/\n/g, '｜'), '反应');
    const dilemma = field(sb.replace(/\n/g, '｜'), '困境');
    const decision = field(sb.replace(/\n/g, '｜'), '决定');
    if (reaction || dilemma || decision) sequels.push({ reaction, dilemma, decision });
  }

  const hook = field(block, '章末钩子') || field(block, '钩子');

  if (!purpose && beats.length === 0) return null;
  return { order, purpose, beats, sequels, hook };
}

/** 渲染一张卡成给写作官看的可用指令（缺件的拍要点名，不许它蒙混） */
export function renderBeatCard(card: BeatCard): string {
  const lines: string[] = [`【第 ${card.order} 章节拍卡（施工图 · 逐拍落实）】`];
  if (card.purpose) lines.push(`本章功能：${card.purpose}`);
  card.beats.forEach((b, i) => {
    const miss: string[] = [];
    if (!b.scene) miss.push('场景');
    if (!b.goal) miss.push('目标');
    if (!b.obstacle) miss.push('阻碍');
    if (!b.disaster) miss.push('灾难');
    lines.push(
      `beat${i + 1}｜场景：${b.scene || '（卡里缺）'}｜目标：${b.goal || '（卡里缺）'}`
      + `｜阻碍：${b.obstacle || '（卡里缺）'}｜灾难：${b.disaster || '（卡里缺）'}`,
    );
    if (miss.length) lines.push(`  ⚠️ 这一拍卡里缺「${miss.join('、')}」—— 按本章功能自己补足，不要跳过这一拍`);
  });
  card.sequels.forEach((s, i) => {
    lines.push(
      `sequel${i + 1}｜反应：${s.reaction || '（卡里缺）'}｜困境：${s.dilemma || '（卡里缺）'}`
      + `｜决定：${s.decision || '（卡里缺）'}`,
    );
  });
  if (card.hook) lines.push(`章末钩子：${card.hook}`);
  lines.push(
    '',
    '★ 逐拍落实（Swain 的 Scene / Sequel 结构，见卡）：',
    '· **每一拍都必须真的发生**（目标 → 阻碍 → 灾难），不许合并、不许跳过、',
    '  不许用一句叙述带过（"她又去看了看""她没说话"都不是结果）。',
    '· **每拍的「灾难」是主角没能得手**：他想要的目标**没得到**，反而陷入更糟的局面。',
    '  **不许**把这一拍写成"她成功确认了…"—— 给了目标，张力就没了。',
    '· 灾难之后必须走 **sequel（反应 → 困境 → 决定）**，由**决定**把故事推向下一拍的目标。',
    '  **本章至少要有一次决定**：人物选了一条路并且真的走下去，否则这一章等于没推进。',
  );
  return lines.join('\n');
}

/**
 * 契约里已经规划到第几章（0 = 一张卡都没有）。
 *
 * ★ 2026-10-31 修一个**静默误判**（实测《铁壳里的声音》第 2、3 章重演同一场戏）。
 *
 * 旧实现只匹配裸的 `第N章`，于是把**裁决书正文里的提及**也当成了卡。实测该 artifact 里
 * 第一节是定稿官的裁决书，长这样：
 *   「2. 接受剧情设计师修订：**第3章**节拍2改为…」「3. 接受**第2章**“声像父亲”为耳感白描」
 *   「5. 接受**第4章**起卖走听循环…」「不与**第7章**怕主显冲突」
 * ⇒ `beatsCoverage` 返回 `1,2,3,4,7,8,…,22`，**看上去第 1–7 章都有卡**。
 * 但真正的卡只有 `第8章｜…` 起——**第 2、3、4 章一张卡都没有**。
 *
 * 后果链（这才是"第 2、3 章写同一场戏"的直接原因）：
 *   本章被判"已有卡" ⇒ `checkBeatCoverage` 返回 needed=false ⇒ **跳过在线补纲**
 *   ⇒ 写作官拿到 `card = null` ⇒ 只能接着上一章再演一遍（去同一地点、办同一件事）。
 *
 * 为什么用**行首锚点**就能分开：真正的卡是**独立成行**的（`第N章｜本章功能：…`），
 * 而提及总是**嵌在句子中间**（"接受第3章节拍2改为…"）。加 `^` + `m` 后，
 * 实测该 artifact 的 orders 从 `1,2,3,4,7…` 收敛为 `8…22`（与肉眼所见一致）。
 * 同时保留对旧格式的兼容：只写了 `第N章` 而没带 `｜` 的独立行也认。
 */
export function beatsCoverage(artifact: string | undefined | null): { orders: number[]; max: number } {
  const text = String(artifact ?? '');
  const orders: number[] = [];
  // 只认**行首**的章标题：`第N章｜…` 或单独一行的 `第N章`（可带前后空白）
  for (const m of text.matchAll(/^[ \t]*第\s*(\d+)\s*章(?=[｜|：:\s]|$)/gm)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && !orders.includes(n)) orders.push(n);
  }
  orders.sort((a, b) => a - b);
  return { orders, max: orders.length ? orders[orders.length - 1]! : 0 };
}

/**
 * 下一次该规划哪几章：从「已覆盖的下一章」与「已交付的下一章」里**取更靠后**的那个起，共 n 章。
 *
 * ★ 2026-10-23 修一个真 bug：第一版只看卡覆盖到哪，于是对一本**已经写了 89 章**的书
 *   会从第 1 章开始补卡 —— 补的全是早就写完的章，一张都用不上。
 *   节拍卡是**未来章节的施工图**，起点必须同时满足"没规划过"且"还没写"。
 */
export function nextBeatRange(
  artifact: string | undefined | null,
  n: number,
  lastDelivered = 0,
): number[] {
  const from = Math.max(beatsCoverage(artifact).max, Math.max(0, Math.floor(lastDelivered) || 0)) + 1;
  return Array.from({ length: Math.max(1, n) }, (_, i) => from + i);
}

/** 给节拍卡阶段的派活指令（把范围写死，别让它自由发挥规划哪几章） */
export function renderBeatsTask(orders: readonly number[]): string {
  if (orders.length === 0) return '';
  const from = orders[0]!, to = orders[orders.length - 1]!;
  return [
    `【本轮任务】为**第 ${from}–${to} 章**逐章写节拍卡（共 ${orders.length} 章）。`,
    `只写这 ${orders.length} 章，不要往前补、也不要往后多写。`,
    `已交付章节的实际内容见上文（「项目现状」里的章节清单）；节拍卡要与它**衔接**，`,
    '不要规划一件已经发生过的事。',
  ].join('\n');
}
