/**
 * @fileoverview manuscriptData —— 正文章节的排序 / 统计 / 章号口径
 *
 * 这几处最容易写歪、且歪了在界面上**看不出**（例如数组下标当章号、
 * wordCount 为 0 的章被算成 0 字 ⇒ 总字数凭空少一整章）。所以抽出来单测钉死。
 */

import { describe, it, expect } from 'vitest';
import {
  sortChapters, computeStats, countChars, chapterLabel, extractChapterArray,
  type ManuscriptChapter,
} from '../services/manuscriptData';

function ch(over: Partial<ManuscriptChapter> = {}): ManuscriptChapter {
  return { id: 'x', order: 1, title: 'T', content: '正文', wordCount: 10, ...over };
}

describe('sortChapters', () => {
  it('按 order 升序（不拿数组下标当章号）', () => {
    const got = sortChapters([ch({ id: 'c', order: 3 }), ch({ id: 'a', order: 1 }), ch({ id: 'b', order: 5 })]);
    expect(got.map((c) => c.order)).toEqual([1, 3, 5]);
  });

  it('order 相等时用 id 兜底 —— 顺序必须确定，否则每次刷新目录都变', () => {
    const got = sortChapters([ch({ id: 'b', order: 2 }), ch({ id: 'a', order: 2 })]);
    expect(got.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('不改原数组（面板可能直接把 store 里的数组传进来）', () => {
    const src = [ch({ id: 'a', order: 2 }), ch({ id: 'b', order: 1 })];
    sortChapters(src);
    expect(src.map((c) => c.order)).toEqual([2, 1]);
  });
});

describe('computeStats', () => {
  it('总字数 / 章数 / 平均每章', () => {
    const s = computeStats([ch({ wordCount: 1000 }), ch({ wordCount: 2000 })]);
    expect(s).toEqual({ count: 2, totalWords: 3000, avgWords: 1500 });
  });

  it('★ wordCount 为 0 的章按正文实长补算（否则总字数凭空少一整章）', () => {
    const s = computeStats([ch({ wordCount: 0, content: '一二三四五' })]);
    expect(s.totalWords).toBe(5);
  });

  it('空书：全 0，不出现 NaN（除零）', () => {
    expect(computeStats([])).toEqual({ count: 0, totalWords: 0, avgWords: 0 });
  });

  it('【回归】中文标点也计字：掐掉正文会让字数缩水，这里只去空白', () => {
    // 正文实长 4 字（含一个逗号）—— 若只数汉字会得到 3，与后端口径不一致
    expect(computeStats([ch({ wordCount: 0, content: '你好，世界' })]).totalWords).toBe(5);
  });

  it('平均每章四舍五入', () => {
    expect(computeStats([ch({ wordCount: 1 }), ch({ wordCount: 2 })]).avgWords).toBe(2); // 1.5 → 2
  });
});

describe('countChars', () => {
  it('去空白后计数：换行/空格不算字', () => {
    expect(countChars('你好\n\n世界 ')).toBe(4);
  });
  it('空 / undefined 一律 0', () => {
    expect(countChars('')).toBe(0);
    expect(countChars(undefined)).toBe(0);
  });
});

describe('chapterLabel', () => {
  it('正常章号写成「第 N 章」', () => {
    expect(chapterLabel(7)).toBe('第 7 章');
  });
  it('order 缺省/为 0 时退化占位，不显示「第 0 章」', () => {
    expect(chapterLabel(0)).toBe('未编号');
  });
});

describe('extractChapterArray', () => {
  it('apiClient 已拆信封：裸数组直接过', () => {
    expect(extractChapterArray([{ id: 'a' }])).toHaveLength(1);
  });
  it('没拆信封时也能从 { data: [...] } 里取出来', () => {
    expect(extractChapterArray({ data: [{ id: 'a' }, { id: 'b' }] })).toHaveLength(2);
  });
  it('认不出的形状返回空数组，而不是抛错（面板照常显示空态）', () => {
    expect(extractChapterArray(null)).toEqual([]);
    expect(extractChapterArray({ nope: 1 })).toEqual([]);
  });
});
