// ============================================================
// 章内重复检测单测 —— 长跑复读的代码级兜底
//
// 守的是「模型自报去重会漏」这个已经实测的失败模式：长跑段整句/整段在同一章里
// 反复出现，而意图门的『去重』红线只靠模型自报，漏报就直接交付了。
// 这里覆盖：整句复读、整段雷同、标点/空白差异下的同一句、短句豁免、正常稿不误伤。
// ============================================================

import { describe, expect, it } from 'vitest';
import {
  detectRepetition, renderRepetitionHint,
  REPETITION_MIN_SENTENCE_CHARS, REPETITION_MAX_EXCESS,
  NEAR_DUP_JACCARD_MIN, NEAR_DUP_EDIT_MIN, NEAR_DUP_MAX_EXCESS,
  detectCrossChapterRepetition, renderCrossRepetitionHint,
  CROSS_DUP_MIN_CHARS, CROSS_DUP_MAX, CROSS_NEAR_MAX,
} from './repetition.js';

describe('跨章重复检测（2026-10-16：长跑"新章复读旧章"）', () => {
  // 实测原文的加长版（归一化后必须 ≥ CROSS_DUP_MIN_CHARS=22 才进检测池）
  const shared = '他转身离开那台终端，走廊里的低鸣还是和刚才一样，一点都没有变。';
  const prev = [
    { order: 1, content: `${shared}\n他走出运输廊，鞋底碾过一粒碎屑。` },
    { order: 2, content: `风从闸口灌进来。\n${shared}` },
  ];

  it('本章原样抄旧章的句子 → 检出，并记下在哪些旧章出现过', () => {
    const rep = detectCrossChapterRepetition(`新的开场。\n${shared}`, prev);
    expect(rep.count).toBeGreaterThanOrEqual(1);
    expect(rep.findings[0]!.text).toContain('廊里的低鸣');
    expect(rep.findings[0]!.priorOrders).toEqual([1, 2]);
  });

  it(`跨章重复达 ${CROSS_DUP_MAX} 处 → 判过度（打回）`, () => {
    const many = Array.from({ length: CROSS_DUP_MAX }, (_v, i) => `这是旧章里写过的第${i}句完整的长句子，长度足够触发跨章检测。`);
    const rep = detectCrossChapterRepetition(many.join('\n'), [{ order: 1, content: many.join('\n') }]);
    expect(rep.excessive).toBe(true);
  });

  it('句子太短不计（低于阈值）—— 避免"他站起来"这类正常短句误伤', () => {
    const short = '他没说话。';
    expect(short.length).toBeLessThan(CROSS_DUP_MIN_CHARS);
    const rep = detectCrossChapterRepetition(`${short}\n${short}`, [{ order: 1, content: short }]);
    expect(rep.count).toBe(0);
  });

  it('全新写的章（与旧章无重合）→ 不误报', () => {
    const rep = detectCrossChapterRepetition(
      '他推开第三道门，看见桌上摊着一份没写完的名单，墨迹还湿。',
      [{ order: 1, content: '昨夜他在巷口等了一整晚，雨把鞋泡透了。' }],
    );
    expect(rep.excessive).toBe(false);
    expect(rep.count).toBe(0);
  });

  it('没有旧章（第 1 章）→ 不报', () => {
    expect(detectCrossChapterRepetition(shared, []).count).toBe(0);
  });

  it('重写指令列出旧章号，并要求换写法', () => {
    const hint = renderCrossRepetitionHint(detectCrossChapterRepetition(`新的开场。\n${shared}`, prev));
    expect(hint).toContain('跨章');
    expect(hint).toContain('第 1');
    expect(hint).toContain('新内容');
  });

  /* ——— 变体式跨章复写（2026-10-17 补的第二类）——— */
  // 用真实成稿里的「换词重写」实测对：Jaccard≈0.77 / 编辑≈0.90，两门槛都过
  const nearA = '楼下旅店老板在和谁说话，声音低，听不清字，只听见外头查夜的词。';
  const nearB = '楼下旅店老板在和谁说话，声音压得很低，听不清字，只听见外头查夜的词。';

  it('换词重写旧章句子（不是逐字）→ 记为变体跨章，不记逐字', () => {
    const rep = detectCrossChapterRepetition(nearA, [{ order: 6, content: nearB }]);
    expect(rep.exactCount).toBe(0);
    expect(rep.nearCount).toBe(1);
    expect(rep.nearFindings[0]!.priorOrders).toEqual([6]);
    expect(rep.nearFindings[0]!.priorText).toBe(nearB);
  });

  it(`变体跨章达 ${CROSS_NEAR_MAX} 处 → 判过度；差一处不判`, () => {
    // 长句（≥ 变体门槛）的 4 个不同改写，都≈base；逐字相同的会被 byKey 去重，故各写一遍。
    const base = '楼下旅店老板压着嗓子在和谁说话，声音低得听不清字，只听见外头查夜的几个词。';
    const all = [
      '楼下旅店老板压着嗓子和谁说话，声音低得听不清字，只听见外头查夜的几个词。',
      '楼下旅店老板压着嗓子在和谁说话，声音低得听不清话，只听见外头查夜的几个词。',
      '楼下旅店老板压着嗓子在和谁说话，声音低得听不清字，只听见外面查夜的几个词。',
      '楼下旅店老板压着嗓子在和谁说话，声音低得听不出字，只听见外头查夜的几个词。',
    ];
    const prior = [{ order: 1, content: base }];
    const under = detectCrossChapterRepetition(all.slice(0, CROSS_NEAR_MAX - 1).join('\n'), prior);
    expect(under.nearCount).toBe(CROSS_NEAR_MAX - 1);
    expect(under.nearExcessive).toBe(false);
    const over = detectCrossChapterRepetition(all.join('\n'), prior);
    expect(over.nearCount).toBeGreaterThanOrEqual(CROSS_NEAR_MAX);
    expect(over.nearExcessive).toBe(true);
  });

  it('逐字命中时不重复算变体（避免同一句双计）', () => {
    const rep = detectCrossChapterRepetition(nearB, [{ order: 1, content: nearB }]);
    expect(rep.exactCount).toBe(1);
    expect(rep.nearCount).toBe(0);
  });

  it('完全不同的话 → 变体不误报', () => {
    const rep = detectCrossChapterRepetition(
      '他推开第三道门，看见桌上摊着一份没写完的名单，墨迹还湿。',
      [{ order: 1, content: '昨夜他在巷口等了一整晚，雨把鞋泡透了。' }],
    );
    expect(rep.nearCount).toBe(0);
  });

  it('重写指令分别列出逐字与变体两类，并给出旧章原句', () => {
    const rep = detectCrossChapterRepetition(`${shared}\n${nearA}`, [
      { order: 1, content: shared },
      { order: 6, content: nearB },
    ]);
    const hint = renderCrossRepetitionHint(rep);
    expect(hint).toContain('原样写过');
    expect(hint).toContain('换了说法');
    expect(hint).toContain('第 6');
    expect(hint).toContain('声音压得很低'); // 旧章原句要被摆出来给写作官比对
  });
});

describe('章内重复检测 · 整句复读（实测第 4 章的那句）', () => {
  // 单句（只有句末一个「。」）—— 用来测句子规则。
  // ★ 长度必须 ≥ REPETITION_MIN_SENTENCE_CHARS（16），否则会被短句豁免筛掉。
  const one = '他沿着街走，风把灰吹起来，落在肩上，散进夜色里。';
  // 多句连成的一段（实测原文，整段被复读 4 次）—— 走段落规则
  const block = '世界没变。三十公里外，公司塔的屏面干干净净，内网滚过合规的字。旧城那边讯弱如常，纸本静在落灰的屋里，等他回去。';

  it('同一长句出现 4 次 → 判过度重复，次数数对', () => {
    const rep = detectRepetition([one, '他走了很远的夜路，鞋底沾满了泥。', one, '天边透出一点白光。', one, one].join('\n'));
    expect(rep.excessive).toBe(true);
    expect(rep.sentences[0]!.count).toBe(4);
    expect(rep.excessSentences).toBeGreaterThanOrEqual(REPETITION_MAX_EXCESS);
  });

  it('同一长句只出现 2 次（可能是有意的复沓）→ 不判过度', () => {
    const rep = detectRepetition([one, '中间有别的内容，且足够长写完一句。', one].join('\n'));
    expect(rep.excessive).toBe(false);
    expect(rep.excessSentences).toBe(1);
  });

  it('同一长句出现 3 次 → 达阈值，判过度（对齐复核红线"两处以上"）', () => {
    const rep = detectRepetition([one, one, one].join('\n'));
    expect(rep.excessive).toBe(true);
    expect(rep.excessSentences).toBeGreaterThanOrEqual(REPETITION_MAX_EXCESS);
  });

  it('实测那段多句连成的景（复读 4 次）被识别为重复', () => {
    const filler = '他只停了一下，就又往前走。';
    const rep = detectRepetition([block, filler, block, filler, block, block].join('\n'));
    expect(rep.excessive).toBe(true);
    expect(rep.paragraphs.some((f) => f.text.includes('三十公里外') && f.count >= 3)).toBe(true);
  });
});

describe('章内重复检测 · 整段雷同', () => {
  it('整段（多句）重复一次即判过度（段落是硬伤，阈值更低）', () => {
    const para = '他这双手的灰渍洗不掉，证明他碰过纸、蹭过墙。公司若查调阅痕，他这双手就是记录。';
    const rep = detectRepetition([para, '\n\n', '别的内容在这里，与前段不同。这行也是完整的一句。', '\n\n', para].join(''));
    expect(rep.paragraphs.length).toBe(1);
    expect(rep.paragraphs[0]!.count).toBe(2);
    expect(rep.excessive).toBe(true);
  });

  it('整段三连粘贴 → 次数为 3', () => {
    const para = '门外的廊灯亮了。他拎起包，没开顶灯，侧身出去，锁舌咬合一声。';
    const rep = detectRepetition([para, para, para].join('\n\n'));
    expect(rep.paragraphs[0]!.count).toBe(3);
    expect(rep.excessive).toBe(true);
  });

  it('单句独占一行的重复走句子规则，不双记成"整段"（避免误伤刻意复沓）', () => {
    const one = '他这双手的灰渍洗不掉，证明他碰过纸、蹭过墙，公司若查调阅痕。';
    const rep = detectRepetition([one, one].join('\n'));
    // 单句段落不计入 paragraphs（那是句子规则的地盘）
    expect(rep.paragraphs).toEqual([]);
    expect(rep.sentences.some((f) => f.count === 2)).toBe(true);
  });
});

describe('章内重复检测 · 归一化（防"改标点绕过"）', () => {
  it('句号改省略号 / 多打空格，仍认成同一句', () => {
    const a = '他沿着街走，风把灰吹起来，落在肩上，散进夜色里。';
    const b = '他沿着街走，风把灰吹起来，落在肩上，散进夜色里……';
    const c = '他沿着街走， 风把灰吹起来，落在肩上，散进夜色里！';
    const rep = detectRepetition([a, b, c].join('\n'));
    expect(rep.excessive).toBe(true);
    // 三条归一化后同一句，应为同一 finding
    expect(rep.sentences.some((f) => f.count === 3)).toBe(true);
  });
});

describe('章内重复检测 · 不误伤', () => {
  it('每句都不同的正常稿 → 不判过度', () => {
    const content = [
      '清晨的雾还没散，他推门出去，脚步压得很轻。',
      '街角的早点摊冒着白气，老板娘正弯腰收拾蒸笼。',
      '他心里盘算着昨天那件事，越想越觉得哪里不对。',
      '拐过两个路口，他忽然停下，回头看了一眼来路。',
    ].join('\n');
    const rep = detectRepetition(content);
    expect(rep.excessive).toBe(false);
    expect(rep.sentences).toEqual([]);
    expect(rep.paragraphs).toEqual([]);
  });

  it('短句复现（低于阈值长）不算重复 —— 避免误伤正常行文', () => {
    const short = '他没说话。';
    expect(short.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '').length).toBeLessThan(REPETITION_MIN_SENTENCE_CHARS);
    const rep = detectRepetition([short, short, short, short].join('\n'));
    expect(rep.excessive).toBe(false);
  });

  it('空稿 / 单句 → 无重复', () => {
    expect(detectRepetition('').excessive).toBe(false);
    expect(detectRepetition('只有一句话，别无其他。').excessive).toBe(false);
  });
});

describe('重写指令渲染', () => {
  it('列出重复的句子与次数，并写明不许复述凑字数', () => {
    const line = '世界没变。三十公里外，公司塔的屏面干干净净，内网滚过合规的字。';
    const hint = renderRepetitionHint(detectRepetition([line, line, line].join('\n')));
    expect(hint).toContain('世界没变');
    expect(hint).toContain('复述');
    expect(hint).toMatch(/出现 \d+ 次/);
  });

  it('整段重复也写进指令（过长时截断展示）', () => {
    const para = '甲'.repeat(100) + '。' + '乙'.repeat(100) + '。';
    const hint = renderRepetitionHint(detectRepetition([para, para].join('\n\n')));
    expect(hint).toContain('整段');
  });
});

// ============================================================
// 缺陷 A：变体式重复（精确匹配抓不到换词重写）
//
// 用例取自**本仓真实产出**（项目 5296fe70 已交付的第 4、5 章，实测文本）。
// 阈值就是拿这些真文标定的，所以下面直接拿真句当夹具 —— 防止将来有人
// 调阈值时"单测全绿但真文仍然漏"。
// ============================================================
describe('近似重复 · 阈值', () => {
  it('两个阈值都落在正常行文之上（防止被顺手调低）', () => {
    // 标定依据：正常章（第 1 章）非精确重复的最高 Jaccard 是 0.52，
    // 待抓章（第 5 章）是 0.73/0.83/0.95 —— 0.60 落在这道自然断档正中。
    expect(NEAR_DUP_JACCARD_MIN).toBeGreaterThan(0.52);
    expect(NEAR_DUP_JACCARD_MIN).toBeLessThanOrEqual(0.73);
    expect(NEAR_DUP_EDIT_MIN).toBeGreaterThanOrEqual(0.68);
    expect(NEAR_DUP_MAX_EXCESS).toBeGreaterThanOrEqual(2);
  });
});

describe('近似重复 · 实测变体（第 5 章）', () => {
  // 三句都来自第 5 章：同一句被"改几个字"重写的真实样本
  const a = '墙立着他不点屏不蹭口子，墙后二月残痕他记了位置。';
  const a2 = '墙立着他不点屏不蹭口子，墙后二月残痕他记了位。';
  const b = '墙立着，他刚起步，体系用墙拦，还没到人拦。';
  const b2 = '低岗的墙立着，他刚起步，体系用墙拦，还没到人拦。';
  const c = '旧城三巷静得能听见远处配给站卷帘门最后一声响。';
  const c2 = '旧城三巷静得能听见配给站卷帘门最后一声响。';

  it('只改句尾一个字（Jaccard 0.95）→ 认出是变体重复', () => {
    const rep = detectRepetition([a, '中间隔着一句完全无关的话，长度也够十六个字。', a2].join('\n'));
    expect(rep.nearDuplicates.length).toBe(1);
    expect(rep.nearDuplicates[0]!.count).toBe(2);
    // 组内**两种写法**都要列给写作官，否则它不知道该删哪句
    expect(rep.nearDuplicates[0]!.variants.some((v) => v.includes('记了位'))).toBe(true);
  });

  it('多加两个字头（Jaccard 0.83）→ 认出是变体重复', () => {
    const rep = detectRepetition([b, '中间隔着一句完全无关的话，长度也够十六个字。', b2].join('\n'));
    expect(rep.nearDuplicates.length).toBe(1);
    expect(rep.excessNearDuplicates).toBe(1);
  });

  it('删掉一个状语（Jaccard 0.73）→ 认出是变体重复', () => {
    const rep = detectRepetition([c, '中间隔着一句完全无关的话，长度也够十六个字。', c2].join('\n'));
    expect(rep.nearDuplicates.length).toBe(1);
  });

  it('达到 NEAR_DUP_MAX_EXCESS 组变体 → approximateExcessive 为真、并入 excessive', () => {
    // 三组变体各多 1 次 = excess 3 ≥ 2（正是第 5 章的实测形态）
    const content = [a, a2, b, b2, c, c2]
      .join('\n');
    const rep = detectRepetition(content);
    expect(rep.excessNearDuplicates).toBe(3);
    expect(rep.approximateExcessive).toBe(true);
    expect(rep.excessive).toBe(true);
    // 这三对都是"改字"，精确规则一条都抓不到 —— 这正是必须新增近似规则的原因
    expect(rep.exactExcessive).toBe(false);
  });

  it('孤立一组变体（excess=1）→ 放过，避免误伤正常呼应', () => {
    const rep = detectRepetition([a, '中间隔着一句完全无关的话，长度也够十六个字。', a2].join('\n'));
    expect(rep.approximateExcessive).toBe(false);
    expect(rep.excessive).toBe(false);
  });

  it('精确相同的句子走精确规则，不被近似规则重复计数', () => {
    const same = '他沿着街走，风把灰吹起来，落在肩上，散进夜色里。';
    const rep = detectRepetition([same, same].join('\n'));
    // 精确规则记 1 次多余；近似规则必须为 0（否则一句复现 2 次被算成 2 倍严重）
    expect(rep.excessSentences).toBe(1);
    expect(rep.excessNearDuplicates).toBe(0);
    expect(rep.approximateExcessive).toBe(false);
  });

  it('短句不参与近似比对（低于 16 字，与精确规则同一道门槛）', () => {
    const short = '墙立着他不点屏。';   // 归一化后 <16 字
    const rep = detectRepetition([short, short + '。', short].join('\n'));
    expect(rep.nearDuplicates).toEqual([]);
  });
});

describe('近似重复 · 不误伤（把实测正常章搬进来）', () => {
  it('第 1 章那对"同一件事的两种说法"仍然放过', () => {
    // 实测 Jaccard 0.52 —— 这是正常章的**最高分**，必须是放过的一侧
    const rep = detectRepetition([
      '"结论页的签名和底稿不一致，这不算事？"',
      '结论页的签名和底稿不一致，这不是局部能糊过去的事。',
    ].join('\n'));
    expect(rep.nearDuplicates).toEqual([]);
    expect(rep.excessive).toBe(false);
  });

  it('第 4 章那对"共同词多但结构不同"的句子放过', () => {
    // 实测 Jaccard 0.52 / 编辑相似度 0.78 —— 两条件必须同时达标才算，
    // 它 Jaccard 不达标，所以即便编辑相似度较高也不该被抓
    const rep = detectRepetition([
      '内衣袋里预警纸的折角硌了下肋，他用手掌把那角按平。',
      '内衣袋的硬角硌了下肋，他用手掌把那角按平。',
    ].join('\n'));
    expect(rep.nearDuplicates).toEqual([]);
  });

  it('正常行文（共用场景词、结构各异）不判近似重复', () => {
    const content = [
      '清晨的雾还没散，他推门出去，脚步压得很轻。',
      '街角的早点摊冒着白气，老板娘正弯腰收拾蒸笼。',
      '他心里盘算着昨天那件事，越想越觉得哪里不对。',
      '拐过两个路口，他忽然停下，回头看了一眼来路。',
      '风把晾在绳上的衣服吹得鼓起来，又慢慢垂下去。',
    ].join('\n');
    const rep = detectRepetition(content);
    expect(rep.nearDuplicates).toEqual([]);
    expect(rep.excessive).toBe(false);
  });

  it('空稿 / 单句不炸', () => {
    expect(detectRepetition('').nearDuplicates).toEqual([]);
    expect(detectRepetition('只有一句话，别无其他。').nearDuplicates).toEqual([]);
  });
});

describe('近似重复 · 重写指令', () => {
  it('列出代表句、出现次数与**变体**（写作官要看见几种写法才知道删哪句）', () => {
    // 三句是同一句的三种递进改写（只改一两个字）→ 并成一组
    const v1 = '旧城三巷的灯坏着不亮，塔里的灯亮着，他闭眼把这道形记下。';
    const v2 = '旧城三巷的灯坏着不亮，塔里的灯亮着，他闭眼把这道形记分明。';
    const v3 = '旧城三巷的灯坏着不亮，塔里的灯亮着，他闭眼把这道形记住。';
    const hint = renderRepetitionHint(detectRepetition([v1, v2, v3].join('\n')));
    expect(hint).toContain('换了说法');
    expect(hint).toContain('记下');        // 代表句（首次出现的那句）
    expect(hint).toContain('记分明');      // 变体一
    expect(hint).toContain('记住');        // 变体二
    expect(hint).toContain('共出现 3 次');
  });
});
