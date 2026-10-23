// ============================================================
// 对话占比单测 —— 缺陷 B 的代码级兜底
//
// 守的是「对话过少只写在提示词里、模型会漏」这个已实测的失败模式：
// 同一项目已交付的第 1–5 章对话占比 10.8% / 5.0% / 9.1% / 11.0% / 4.9%，
// 全部低于目标 20%。这里覆盖：中文四套引号、英文直引号、引号内标点不计入、
// 漏引号不崩、正常章（11%）仍被拦下、以及阈值本身不许被顺手调低。
// ============================================================

import { describe, expect, it } from 'vitest';
import { detectDialogue, renderDialogueHint, DIALOGUE_RATIO_MIN } from './dialogue.js';

/** 造一段「对话恰好占 ratio」的文本：前半对白、后半叙述，字数都给足 */
function makeMixed(ratio: number): string {
  const total = 100;
  const d = Math.round(total * ratio);
  return '“' + '对'.repeat(d) + '”' + '述'.repeat(total - d);
}

describe('对话占比 · 基本口径', () => {
  it('阈值是 0.15（标定自本仓真实产出的 5%–11% 区间）', () => {
    expect(DIALOGUE_RATIO_MIN).toBeCloseTo(0.15, 5);
  });

  it('对白占主导 → 不判偏低', () => {
    const rep = detectDialogue('“你来了。”他点点头，一句话也没有再说下去。');
    expect(rep.dialogueChars).toBe(3);
    expect(rep.ratio).toBeGreaterThan(DIALOGUE_RATIO_MIN);
    expect(rep.tooLow).toBe(false);
  });

  it('纯叙述（无引号）→ 0%，判偏低', () => {
    const rep = detectDialogue('旧城三巷的灯坏了一半，陈默蹲在租屋地板上，膝头摊着一份纸档。');
    expect(rep.ratio).toBe(0);
    expect(rep.tooLow).toBe(true);
  });

  it('占比按**内容字数**算：引号内的标点与换行不计入对话', () => {
    // 「……！」这类只有标点的对白不该给占比灌水
    const rep = detectDialogue('“……”' + '叙述文字'.repeat(20));
    expect(rep.dialogueChars).toBe(0);
    expect(rep.tooLow).toBe(true);
  });

  it('刚好过线 / 刚好不过线（比值语义与 toLow 一致）', () => {
    expect(detectDialogue(makeMixed(0.2)).tooLow).toBe(false);
    expect(detectDialogue(makeMixed(0.1)).tooLow).toBe(true);
  });

  it('空稿不算"对话偏低"（那是篇幅门的事，不该在这里重复打回）', () => {
    const rep = detectDialogue('');
    expect(rep.totalChars).toBe(0);
    expect(rep.ratio).toBe(0);
    expect(rep.tooLow).toBe(false);
  });
});

describe('对话占比 · 四套引号都要认', () => {
  const body = '述'.repeat(80);
  const quote = '对'.repeat(20);   // 20/100 = 20% > 15%

  it('中文双引号 “…”', () => {
    const r = detectDialogue(`“${quote}”${body}`);
    expect(r.dialogueChars).toBe(20);
    expect(r.tooLow).toBe(false);
  });

  it('日式/繁体引号 「…」', () => {
    const r = detectDialogue(`「${quote}」${body}`);
    expect(r.dialogueChars).toBe(20);
    expect(r.tooLow).toBe(false);
  });

  it('书名号式引号 『…』', () => {
    const r = detectDialogue(`『${quote}』${body}`);
    expect(r.dialogueChars).toBe(20);
    expect(r.tooLow).toBe(false);
  });

  it('英文直引号 "…"（同一个字符成对开关）', () => {
    const r = detectDialogue(`"${quote}"${body}`);
    expect(r.dialogueChars).toBe(20);
    expect(r.tooLow).toBe(false);
  });

  it('中文单引号 ‘…’（对白里再引用一层）', () => {
    const r = detectDialogue(`‘${quote}’${body}`);
    expect(r.dialogueChars).toBe(20);
    expect(r.tooLow).toBe(false);
  });

  it('同章混用多套引号，逐段累加', () => {
    const r = detectDialogue(`“${'甲'.repeat(10)}”${body}「${'乙'.repeat(10)}」`);
    expect(r.dialogueChars).toBe(20);
  });
});

describe('对话占比 · 实测真章', () => {
  // 第 1 章的一小段（真实交付文本，含中文双引号对白）
  const ch1 = [
    '门没锁。他起身，出了巷口。',
    '锐石塔的玻璃门映出他瘦长的影子。他刷了低岗权限卡，闸机绿光闪了一下，放行。',
    '中层把手按在终端侧，指节压着壳边。"陈默。"',
    '"我核一下姐姐的旧记录。"',
    '"你岗级不够看全库。"中层眼皮抬了抬，"局部够你看了。"',
  ].join('\n');

  it('对话够多的段落不判偏低', () => {
    const r = detectDialogue(ch1);
    expect(r.ratio).toBeGreaterThan(DIALOGUE_RATIO_MIN);
    expect(r.tooLow).toBe(false);
  });

  it('实测第 5 章那一大段（几乎全是动作流、只有 2 句对白）判偏低', () => {
    // 第 5 章真实文本的节选：动作/内心为主，对白只占极少数
    const ch5 = [
      '天亮了。旧城三巷的灯还是那半截坏的，垂着，不动。陈默从薄被里坐起来，光脚踩上地板。',
      '他先蹲下，手指探进床底板缝最里层，木板的凉蹭过指节，把腕屏从缝底推出来。',
      '他没开屏，把腕屏塞进外衣内袋，和纸档隔着一层布。出了巷口，冷风削脸。',
      '"今早塔口有人出来？"',
      '汉子头也没抬："早溜了，黑着脸。上头询完一宿，躲塔里头，天亮才钻出来。"',
      '陈默点头，退出门框。他捏着预警纸从内衣袋抽出来，纸面印着供调预警旧城先询，边角卷了。',
      '他把预警纸折成小方块，塞进缝里，只露一角红边在外头。手掌把砖面按了按，让纸角不显眼。',
      '转身时，他没往巷尾多看，只把那角红边在眼里留了位。风从岔巷穿出来，吹得巷口碎纸动了下。',
      '陈默走回屋，重新蹲下，手指探进床底板缝，把腕屏塞回最里层。木板凉，他指尖在缝沿蹭了一下。',
    ].join('\n');
    const r = detectDialogue(ch5);
    // 实测这一章整体只有 4.9% —— 节选里有 2 句对白，占比仍应远低于 15%
    expect(r.ratio).toBeLessThan(DIALOGUE_RATIO_MIN);
    expect(r.tooLow).toBe(true);
  });
});

describe('对话占比 · 健壮性', () => {
  it('漏写右引号（未闭合）按"到结尾都算对白"，不崩且不高估少', () => {
    const r = detectDialogue('“你来了。' + '述'.repeat(10));
    expect(r.dialogueChars).toBeGreaterThan(0);
  });

  it('html 标签里的引号不影响对白统计（归一化会剥掉尖括号内容之外不受影响）', () => {
    const r = detectDialogue('<p>“甲乙丙丁戊己庚辛壬癸”</p><p>' + '述'.repeat(50) + '</p>');
    expect(r.dialogueChars).toBe(10);
  });

  it('null / undefined 输入不炸', () => {
    // @ts-expect-error 故意传 null，模拟上游给空值
    expect(() => detectDialogue(null)).not.toThrow();
    expect(detectDialogue('').totalChars).toBe(0);
  });
});

describe('对话占比 · 重写指令', () => {
  it('写明本章占比、下限，并给"怎么补"的方向（不替它写台词）', () => {
    const rep = detectDialogue('“甲乙丙”' + '述'.repeat(100));
    const hint = renderDialogueHint(rep);
    expect(hint).toContain('对话占比');
    expect(hint).toMatch(/\d+\.\d%/);      // 具体百分比
    expect(hint).toContain('15%');          // 下限
    expect(hint).toContain('当面');          // 方向：把叙述改成对白
    expect(hint).toContain('不要');          // 反面：别灌水凑占比
  });
});
