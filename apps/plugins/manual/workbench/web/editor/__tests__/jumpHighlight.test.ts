import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  bigramSet,
  collectEditorBlocks,
  parseJumpAnchor,
  pickBestParagraph,
  planJumpHighlight,
  segmentToDocRange,
} from '../jumpHighlight';

// 真实章节（「寒梅」第二章）的前 10 段，用来锁住模糊匹配的排序行为。
// 这些段落与时间线事件的 title/description 是**概括 vs 原文**的关系，
// 没有任何一段能整段 `includes` 事件描述 —— 这正是旧实现得 0 分的原因。
const CHAPTER = [
  '回到出租屋，我把那张照片翻来覆去地看。白色的车，尾号是我母亲的生日——八月十四日，814。可母亲生前不会开车，父亲的车牌里也没有这个组合。',
  '我打开手机相册，翻到母亲生前唯一的驾照复印件。发证日期是1994年，照片里她笑得很拘谨。我把右下角放大——证件编号最后一串，尾数也是814。',
  '我愣住了。',
  '我试着把那个空白发信人的号码输进搜索框。没有结果。我又翻到聊天记录，最后一条还是那句"你去了，但来晚了"。',
  '发送键按下去的瞬间，对话框上方跳出一个已读。最后发来的是：',
  '"你妹妹叫什么名字？"',
  '第二天一早，我去了交警大队，借口说想查一辆套牌车。窗口的小伙子敲了半天键盘，抬头看我："你报的这串尾号，系统里登记的车主姓沈，女性，登记地址在城东老街。"',
  '我的脚步停在台阶上。母亲婚前的姓，我从没听任何人提起过。连我自己，都是今天才第一次在母亲旧证件背面的备注里，模模糊糊看见那个字。',
  '我走出大厅，阳光白得刺眼。手机又亮了。还是那个空白发信人：',
  '"你妹妹不叫沈什么。她姓你母亲婚前的姓。"',
];

const PHOTO_ANCHOR = {
  title: '看照片与车牌尾号',
  description: '我回到出租屋翻看照片，发现白色车尾号814与母亲生日相同',
  characters: [],
  timestamp: '',
  chapter: 2,
};

describe('parseJumpAnchor', () => {
  it('解析结构化锚点', () => {
    expect(
      parseJumpAnchor(
        JSON.stringify({
          title: '标题',
          desc: '描述',
          chars: ['沈砚'],
          time: '第二天一早',
          chapter: 2,
        }),
      ),
    ).toEqual({
      title: '标题',
      description: '描述',
      characters: ['沈砚'],
      timestamp: '第二天一早',
      chapter: 2,
    });
  });

  it('兼容旧的纯标题字符串', () => {
    expect(parseJumpAnchor('看照片')).toMatchObject({
      title: '看照片',
      description: '',
      chapter: null,
    });
  });

  it('空值与坏 JSON 不抛错', () => {
    expect(parseJumpAnchor(null).title).toBe('');
    expect(parseJumpAnchor('{坏 JSON').title).toBe('{坏 JSON');
  });
});

describe('bigramSet', () => {
  it('不跨标点拼出假二元组', () => {
    const grams = bigramSet('车，尾号');
    expect(grams.has('车尾')).toBe(false);
    expect(grams.has('尾号')).toBe(true);
  });
});

describe('pickBestParagraph', () => {
  it('概括句也能命中原文对应段落（不再依赖整段 includes）', () => {
    expect(pickBestParagraph(CHAPTER, PHOTO_ANCHOR)).toBe(0);
  });

  it('对话引子后面的短段落能被选中', () => {
    const anchor = {
      title: '空白发信人问妹妹名',
      description: "空白发信人发来'你妹妹叫什么名字？'，我因无妹妹无法回复",
      characters: [],
      timestamp: '',
      chapter: 2,
    };
    expect(pickBestParagraph(CHAPTER, anchor)).toBe(5);
  });

  it('完全无关的事件返回 -1（宁可不亮也不乱亮）', () => {
    expect(
      pickBestParagraph(CHAPTER, {
        title: '外星飞船降临',
        description: '主角登上飞船离开地球前往火星',
        characters: [],
        timestamp: '',
        chapter: 2,
      }),
    ).toBe(-1);
  });
});

describe('planJumpHighlight', () => {
  it('把高亮落在命中的句子片段，而不是整段', () => {
    const plan = planJumpHighlight(CHAPTER, PHOTO_ANCHOR);
    expect(plan).toHaveLength(1);
    const segment = plan[0]!;
    expect(segment.paragraphIndex).toBe(0);
    const snippet = CHAPTER[0]!.slice(segment.start, segment.end);
    // 该段有 4 句，片段必须是其中一句（不是整段）
    expect(snippet.length).toBeLessThan(CHAPTER[0]!.length);
    expect(snippet).toMatch(/照片|尾号/);
  });

  it('以冒号结尾的引子句延伸到下一段（对话的典型形态）', () => {
    const anchor = {
      title: '发信人指妹妹姓氏',
      description: '走出大厅手机亮，空白发信人称妹妹姓母亲婚前姓',
      characters: [],
      timestamp: '',
      chapter: 2,
    };
    const plan = planJumpHighlight(CHAPTER, anchor);
    expect(plan).toHaveLength(1);
    const segment = plan[0]!;
    expect(segment.paragraphIndex).toBe(9);
    expect(CHAPTER[9]!.slice(segment.start, segment.end)).toContain('她姓你母亲婚前的姓');
  });
});

describe('编辑器文档位置换算', () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function makeEditor(content: string): Editor {
    editor = new Editor({ extensions: [StarterKit], content });
    return editor;
  }

  it('收集非空文本块，并把片段偏移换算成文档位置', () => {
    const ed = makeEditor('<p>第一段文字</p><p></p><p>第二段</p>');
    const blocks = collectEditorBlocks(ed.state.doc);
    expect(blocks.map((b) => b.text)).toEqual(['第一段文字', '第二段']);

    const range = segmentToDocRange(blocks[1]!, { start: 0, end: 3 })!;
    expect(range).not.toBeNull();
    expect(ed.state.doc.textBetween(range.from, range.to, '', () => '')).toBe('第二段');
  });

  it('段落里有 hardBreak 时，后续字符的位置不偏移', () => {
    const ed = makeEditor('<p>甲<br>乙丙</p>');
    const blocks = collectEditorBlocks(ed.state.doc);
    expect(blocks[0]!.text).toBe('甲乙丙');

    const range = segmentToDocRange(blocks[0]!, { start: 1, end: 3 })!;
    expect(ed.state.doc.textBetween(range.from, range.to, '', () => '')).toBe('乙丙');
  });

  it('越界片段返回 null', () => {
    const ed = makeEditor('<p>短</p>');
    const blocks = collectEditorBlocks(ed.state.doc);
    expect(segmentToDocRange(blocks[0]!, { start: 0, end: 99 })).toBeNull();
  });
});
