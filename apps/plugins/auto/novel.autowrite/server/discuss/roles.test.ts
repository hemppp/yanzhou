// ============================================================
// 写作篇幅契约单测 —— P2（三次产出 2115/2145/2179，全部低于下限）的回归关卡
//
// 这道关守的是**同源**：提示词里承诺的字数，与编排器做字数自检用的阈值，
// 必须来自同一组常量。此前的 bug 正是两者各写各的 ——
// 提示词写「2500–4000」，运行时却没有任何检查，写短了照样交付。
// ============================================================

import { describe, expect, it } from 'vitest';
import { ROLE_WRITER, WRITER_TARGET_CHARS, WRITER_MIN_CHARS } from './roles.js';

describe('写作官篇幅契约', () => {
  it('目标值必须大于下限', () => {
    expect(WRITER_TARGET_CHARS).toBeGreaterThan(WRITER_MIN_CHARS);
  });

  it('提示词里的字数由常量插值而来（改常量即改提示词，不会漂移）', () => {
    expect(ROLE_WRITER.system).toContain(String(WRITER_TARGET_CHARS));
    expect(ROLE_WRITER.system).toContain(String(WRITER_MIN_CHARS));
  });

  it('提示词不再使用区间写法（给区间模型会朝下限写）', () => {
    expect(ROLE_WRITER.system).not.toMatch(/2500\s*[–—-]\s*4000/);
  });

  it('写作官被明确要求自己数一遍字数', () => {
    expect(ROLE_WRITER.system).toContain('数一遍');
  });
});
