// ============================================================
// 物品识别 · 多题材章节样本回归
//
// 用 6 段不同题材的章节正文 + 模拟 AI item 候选，
// 一次性覆盖：真物品接受、类型推断、原文接地、去重，
// 以及货币/系统 UI/声光/数量短语/描述性短语/角色地点撞名。
// ============================================================

import { describe, expect, it } from 'vitest';
import { normalizeItemName, validateItemCandidate } from '../knowledge/itemRecognition';
import {
  CHAPTER_ITEM_SAMPLES,
  type ChapterItemSample,
  type SampleCandidate,
} from './fixtures/itemRecognitionSamples';

function expectedLine(candidate: SampleCandidate): string {
  const { expect: e } = candidate;
  if (!e.accept) return `✗ ${normalizeItemName(candidate.name)}:${e.reason}`;
  const name = e.name ?? normalizeItemName(candidate.name);
  return `✓ ${name}:${e.type}${e.existing ? ':existing' : ''}`;
}

function validateSample(sample: ChapterItemSample): string[] {
  return sample.candidates.map((candidate) => {
    const result = validateItemCandidate(candidate, {
      chapterContent: sample.text,
      existingItems: sample.existingItems,
      existingCharacters: (sample.existingCharacters ?? []).map((name) => ({ name })),
      existingLocations: (sample.existingLocations ?? []).map((name) => ({ name })),
    });
    return result.accept
      ? `✓ ${result.name}:${result.type}${result.existingItem ? ':existing' : ''}`
      : `✗ ${normalizeItemName(candidate.name)}:${result.reason}`;
  });
}

describe.each(CHAPTER_ITEM_SAMPLES)('$genre｜$title', (sample) => {
  it('逐条给出预期的接受/拒绝结果', () => {
    expect(validateSample(sample)).toEqual(sample.candidates.map(expectedLine));
  });
});

describe('多题材样本汇总', () => {
  const all = CHAPTER_ITEM_SAMPLES.flatMap((sample) =>
    sample.candidates.map((candidate) => ({ sample, candidate })),
  );

  it('覆盖 24 个题材、不少于 280 条候选', () => {
    expect(new Set(CHAPTER_ITEM_SAMPLES.map((s) => s.genre)).size).toBe(24);
    expect(all.length).toBeGreaterThanOrEqual(280);
  });

  it('接受项的类型都落在标准类型码内', () => {
    const accepted = all.filter(({ candidate }) => candidate.expect.accept);
    expect(accepted.length).toBeGreaterThanOrEqual(150);
    for (const { candidate } of accepted) {
      expect(candidate.expect.type).toBeTruthy();
    }
  });

  it('每类误识别都至少有一条样本', () => {
    const reasons = new Set(
      all
        .filter(({ candidate }) => !candidate.expect.accept)
        .map(({ candidate }) => candidate.expect.reason),
    );
    for (const reason of [
      '数值/货币',
      '抽象概念',
      '系统界面元素',
      '系统玩法',
      '非实体',
      '时间短语',
      '功法招式',
      '组织/地点',
      '痕迹/证据',
      '数量短语',
      '描述性短语',
      '与角色/地点同名',
      '名称过短',
    ]) {
      expect(reasons).toContain(reason);
    }
  });
});
