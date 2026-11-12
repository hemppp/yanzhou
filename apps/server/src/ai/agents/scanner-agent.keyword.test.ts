// ============================================================
// 关键词提取时间线事件 —— 流式解析回归
//
// 背景：旧实现按行 split + JSON.parse，且要求行首必须是 `{`。
// 实测模型经常输出代码围栏、多行美化 JSON、数组包裹或前后解释文字，
// 这些都会让整条事件被静默丢弃（用户看到「提取完成但 0 条」）。
// 本文件锁定新的容错解析与去重/quote 校验行为。
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  createKeywordEventParseState,
  drainKeywordEventChunk,
  extractCompleteJsonObjects,
  flushKeywordEventChunk,
  sanitizeKeywordQuote,
  streamEventsByKeyword,
  type KeywordEventParseState,
} from './scanner-agent.js';

const CHAPTER = `陈星推开藏经阁的木门，月光落在第三排书架上。
他伸手抽出那卷泛黄的残卷，指尖微微发抖。
守阁长老忽然出现在身后，喝道：“谁在那里？”
陈星转身就跑，却在门口被两名弟子拦住。`;

function collect(chunks: string[], state: KeywordEventParseState = createKeywordEventParseState()) {
  const events = [];
  for (const chunk of chunks) {
    events.push(...drainKeywordEventChunk(state, chunk, 3, CHAPTER));
  }
  events.push(...flushKeywordEventChunk(state, 3, CHAPTER));
  return events;
}

/** 按固定长度切块，模拟 SSE chunk 在任意位置断开 */
function chunkEvery(text: string, size: number): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
}

describe('extractCompleteJsonObjects', () => {
  it('保留未闭合的尾部，等下一个 chunk 续接', () => {
    const { values, rest } = extractCompleteJsonObjects('前言{"title":"陈星夜探');
    expect(values).toHaveLength(0);
    expect(rest).toBe('{"title":"陈星夜探');
  });

  it('能跳过代码围栏与前后说明文字', () => {
    const text = '结果如下：\n```json\n{"title":"A","description":"d"}\n```\n以上。';
    const { values } = extractCompleteJsonObjects(text);
    expect(values).toEqual([{ title: 'A', description: 'd' }]);
  });

  it('一行多个对象 / 数组包裹都能逐个抽出', () => {
    const text = '[{"title":"A","description":"d"},{"title":"B","description":"d"}]';
    const { values } = extractCompleteJsonObjects(text);
    expect(values).toHaveLength(2);
  });
});

describe('drainKeywordEventChunk', () => {
  it('跨 chunk 断开的行式 JSON 能全部解析且保序', () => {
    const text = [
      '{"title":"陈星夜探藏经阁","description":"陈星潜入藏经阁抽取残卷，被守阁长老发现。","type":"event","characterNames":["陈星"],"quote":"陈星推开藏经阁的木门"}',
      '{"title":"陈星夺门而逃","description":"陈星被发现后转身逃跑，在门口被两名弟子拦住。","type":"event","characterNames":["陈星"],"quote":"陈星转身就跑"}',
    ].join('\n');
    const events = collect(chunkEvery(text, 9));
    expect(events.map((e) => e.title)).toEqual(['陈星夜探藏经阁', '陈星夺门而逃']);
  });

  it('多行美化的 JSON 对象不再被丢弃', () => {
    const text = `\`\`\`json
{
  "title": "长老喝问",
  "description": "守阁长老发现陈星潜入藏经阁，出声喝问。",
  "type": "event",
  "characterNames": ["陈星", "守阁长老"],
  "quote": "守阁长老忽然出现在身后"
}
\`\`\`
以上是提取结果。`;
    const events = collect(chunkEvery(text, 13));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: '长老喝问',
      chapterOrder: 3,
      quote: '守阁长老忽然出现在身后',
    });
  });

  it('数组包裹的事件也能解析', () => {
    const text =
      '[{"title":"甲事件","description":"甲描述","type":"event","characterNames":[]},' +
      '{"title":"乙事件","description":"乙描述","type":"event","characterNames":[]}]';
    const events = collect(chunkEvery(text, 11));
    expect(events.map((e) => e.title)).toEqual(['甲事件', '乙事件']);
  });

  it('同一批提取内按标题去重（忽略标点/空白）', () => {
    const text = [
      '{"title":"陈星夜探藏经阁","description":"第一次输出","type":"event","characterNames":[]}',
      '{"title":"陈星夜探藏经阁。","description":"第二次输出（更长）","type":"event","characterNames":[]}',
    ].join('\n');
    const events = collect([text]);
    expect(events).toHaveLength(1);
    expect(events[0]?.description).toBe('第一次输出');
  });

  it('规范化非法 type / participants，并强制使用当前章节号', () => {
    const text =
      '{"title":"事件X","description":"d","type":"unknown","participants":["陈星",123,"  "],"chapterOrder":99}';
    const events = collect([text]);
    expect(events[0]).toMatchObject({
      type: 'event',
      characterNames: ['陈星'],
      chapterOrder: 3,
    });
  });

  it('忽略格式示例、空标题与纯文本噪声', () => {
    const text = [
      '好的，下面是提取结果：',
      '{"title":"事件标题","description":"格式示例","type":"event","characterNames":[]}',
      '{"title":"","description":"空标题","type":"event","characterNames":[]}',
      '{"description":"没有标题","type":"event","characterNames":[]}',
    ].join('\n');
    expect(collect([text])).toHaveLength(0);
  });

  it('流结束时残留的半条 JSON 不会抛出异常', () => {
    expect(() => collect(['{"title":"陈星夜探经阁","description":"写到一半'])).not.toThrow();
    expect(collect(['{"title":"陈星夜探经阁","description":"写到一半'])).toHaveLength(0);
  });

  it('流结束能从缺外层 } 的残留中恢复嵌套事件', () => {
    const events = collect(['{"bad": {"title":"可恢复事件","description":"d"}']);
    expect(events.map((e) => e.title)).toEqual(['可恢复事件']);
  });

  it('逐字符喂入也能解析含括号/转义的标题', () => {
    const raw = JSON.stringify({
      title: '括号}测试',
      description: 'd',
      type: 'event',
      characterNames: [],
    });
    const events = collect(chunkEvery(raw, 1));
    expect(events.map((e) => e.title)).toEqual(['括号}测试']);
  });

  it('quote 对不上原文的事件整条丢弃（防编造）', () => {
    const text =
      '{"title":"陈星偷走残卷","description":"陈星潜入藏经阁偷走残卷。","type":"event","characterNames":["陈星"],"quote":"陈星潜入藏经阁偷走残卷"}';
    expect(collect([text])).toHaveLength(0);
  });

  it('quote 逐字命中原文时保留并回填', () => {
    const text =
      '{"title":"陈星夜探藏经阁","description":"陈星推开木门进入藏经阁，抽出泛黄残卷。","type":"event","characterNames":["陈星"],"quote":"陈星推开藏经阁的木门"}';
    const events = collect([text]);
    expect(events).toHaveLength(1);
    expect(events[0]?.quote).toBe('陈星推开藏经阁的木门');
  });

  it('只保留章节原文中真实出现过的角色名（防挂错）', () => {
    const text =
      '{"title":"陈星夜探藏经阁","description":"陈星潜入藏经阁抽取残卷，被守阁长老发现。","type":"event","characterNames":["陈星","王五","守阁长老"],"quote":"陈星推开藏经阁的木门"}';
    const events = collect([text]);
    expect(events[0]?.characterNames).toEqual(['陈星', '守阁长老']);
  });
});

describe('streamEventsByKeyword', () => {
  it('解析结果按顺序回调，并与返回数组一致', async () => {
    async function* fakeStream() {
      yield {
        content:
          '{"title":"陈星夜探藏经阁","description":"陈星潜入藏经阁抽取残卷。","type":"event","characterNames":["陈星"]}\n',
      };
      yield {
        content:
          '{"title":"陈星夺门而逃","description":"陈星被发现后转身逃跑。","type":"event","characterNames":["陈星"]}',
      };
    }

    const seen: string[] = [];
    const events = await streamEventsByKeyword(
      fakeStream as never,
      {
        chapterContent: CHAPTER,
        chapterTitle: '夜探藏经阁',
        chapterOrder: 3,
        keyword: '陈星',
        keywordAliases: ['星儿'],
      },
      { onEvent: (event) => seen.push(event.title) },
    );

    expect(seen).toEqual(['陈星夜探藏经阁', '陈星夺门而逃']);
    expect(events.map((event) => event.title)).toEqual(seen);
    expect(events.every((event) => event.chapterOrder === 3)).toBe(true);
  });
});

describe('sanitizeKeywordQuote', () => {
  it('原文中真实存在的片段保留', () => {
    expect(sanitizeKeywordQuote('陈星推开藏经阁的木门', CHAPTER)).toBe('陈星推开藏经阁的木门');
  });

  it('容忍空白差异，但要求逐字连续命中', () => {
    expect(sanitizeKeywordQuote('陈星 推开 藏经阁的木门', CHAPTER)).toBe('陈星 推开 藏经阁的木门');
  });

  it('模型改写/拼接的片段丢弃', () => {
    expect(sanitizeKeywordQuote('陈星潜入藏经阁偷走残卷', CHAPTER)).toBeUndefined();
  });

  it('过短的片段丢弃（避免误命中）', () => {
    expect(sanitizeKeywordQuote('陈星', CHAPTER)).toBeUndefined();
  });
});
