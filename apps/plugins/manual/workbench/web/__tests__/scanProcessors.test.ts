// ============================================================
// 扫描处理器的两条准确率护栏
//
// 背景：时间线「漏事件」和「角色挂错」的根因不在模型本身，而在落库前的两条启发式：
//   ① 事件去重阈值过松 —— 中文短标题只差两个字（进入/离开）就会被当成重复删掉；
//   ② 角色模糊匹配取「第一个包含项」—— 单字名会把事件挂到名单里第一个同姓角色上。
// 本文件锁定收紧后的判定，防止以后又被调回去。
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  buildCharNameToIdMap,
  findCharIdByName,
  isDuplicateEvent,
} from '../hooks/useScanProcessors';

describe('isDuplicateEvent', () => {
  it('进入/离开这类动词对立的事件不再被误判为重复', () => {
    expect(
      isDuplicateEvent(
        '陈星进入藏经阁',
        '陈星进入藏经阁寻找残卷。',
        '陈星离开藏经阁',
        '陈星离开藏经阁时被弟子拦住。',
      ),
    ).toBe(false);
  });

  it('标题几乎一致时仍判为重复（标点差异）', () => {
    expect(
      isDuplicateEvent(
        '陈星夜探藏经阁',
        '陈星潜入藏经阁抽取残卷。',
        '陈星夜探藏经阁。',
        '陈星潜入藏经阁抽取残卷。',
      ),
    ).toBe(true);
  });

  it('模型换说法重提同一件事（标题较像 + 描述高度重合）判为重复', () => {
    expect(
      isDuplicateEvent(
        '陈星夜探藏经阁',
        '陈星潜入藏经阁抽取泛黄残卷，被守阁长老发现。',
        '陈星夜探藏书阁',
        '陈星潜入藏经阁抽取泛黄残卷，被守阁长老发现。',
      ),
    ).toBe(true);
  });

  it('描述几乎一致、标题措辞不同时判为重复', () => {
    expect(
      isDuplicateEvent(
        '夜探藏经阁',
        '陈星潜入藏经阁抽取泛黄残卷，被守阁长老发现。',
        '陈星潜入藏经阁',
        '陈星潜入藏经阁抽取泛黄残卷，被守阁长老发现。',
      ),
    ).toBe(true);
  });
});

describe('findCharIdByName', () => {
  const characters = [
    { id: 'c1', name: '陈星', aliases: ['星儿'] },
    { id: 'c2', name: '陈默', aliases: [] },
    { id: 'c3', name: '王五', aliases: [] },
  ];
  const map = buildCharNameToIdMap(characters);

  it('精确名与别名优先', () => {
    expect(findCharIdByName('陈星', map, characters)).toBe('c1');
    expect(findCharIdByName('星儿', map, characters)).toBe('c1');
  });

  it('单字名不参与模糊匹配（避免串台）', () => {
    expect(findCharIdByName('陈', map, characters)).toBeNull();
  });

  it('模糊匹配取最长命中，而不是名单里的第一个', () => {
    expect(findCharIdByName('王五爷', map, characters)).toBe('c3');
  });

  it('多个角色同样匹配时视为歧义，返回 null', () => {
    const ambiguous = [
      { id: 'a', name: '陈星', aliases: [] },
      { id: 'b', name: '陈星', aliases: [] },
    ];
    expect(findCharIdByName('陈星星', buildCharNameToIdMap(ambiguous), ambiguous)).toBeNull();
  });
});
