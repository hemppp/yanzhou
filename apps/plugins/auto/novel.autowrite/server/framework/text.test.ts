/**
 * @fileoverview `extractFirstJson` / `parseJsonLoose` —— 模型输出取 JSON 的健壮性
 *
 * 为什么单独盯这个：它是**所有**「让模型输出 JSON」的调用共用的入口
 * （校对门、润色门、实体沉淀、各抽取 agent）。它一错，上层全表现为
 * "这一步没执行"，而且多数是**静默跳过**。
 *
 * 真实事故（2026-09-13 抽查）：校对门连续两次报
 * `Unexpected non-whitespace character after JSON at position 479` —— 根因就是旧实现
 * 取「第一个 { 到最后一个 }」，模型输出两个 JSON 时切片跨过了两个对象。
 *
 * ★ 2026-09-28：本用例随被测函数从 `autowrite/helpers.json.test.ts` 迁到此处
 *   （旧批次流水线已删除，函数迁至 `framework/text.ts`）。
 */

import { describe, expect, it } from 'vitest';
import { extractFirstJson, parseJsonLoose } from './text.js';

describe('extractFirstJson', () => {
  it('★ 两个 JSON 连在一起：只取第一个（校对门那次报错的根因）', () => {
    const raw = '{"pass":true,"conflicts":[]}{"pass":false,"conflicts":["x"]}';
    expect(JSON.parse(extractFirstJson(raw)!)).toEqual({ pass: true, conflicts: [] });
  });

  it('JSON 后面跟一句带 } 的解释', () => {
    const raw = '{"pass":false,"conflicts":["陈默在第5章已失去左手"]}\n\n以上就是我的判断 {希望有帮助}';
    const got = parseJsonLoose<{ pass: boolean; conflicts: string[] }>(raw);
    expect(got.pass).toBe(false);
    expect(got.conflicts).toHaveLength(1);
  });

  it('字符串内部的花括号不算层级', () => {
    const raw = '{"note":"他说 {别动}","ok":true}';
    expect(parseJsonLoose<{ ok: boolean }>(raw).ok).toBe(true);
  });

  it('字符串内的转义引号不会提前结束扫描', () => {
    const raw = '{"note":"她说\\"别动\\"，然后转身","ok":true}';
    expect(parseJsonLoose<{ note: string; ok: boolean }>(raw).ok).toBe(true);
  });

  it('也支持数组开头', () => {
    const raw = '[{"a":1},{"b":2}] 后面还有话';
    expect(extractFirstJson(raw)).toBe('[{"a":1},{"b":2}]');
  });

  it('代码块包裹（```json … ```）照样能取到', () => {
    const raw = '```json\n{"score":8,"comments":"稳"}\n```';
    expect(parseJsonLoose<{ score: number }>(raw).score).toBe(8);
  });

  it('被 maxTokens 截断（括号不配平）→ null，并由 parseJsonLoose 抛出可读错误', () => {
    const raw = '{"pass":false,"conflicts":["很长的冲突描述…';
    expect(extractFirstJson(raw)).toBeNull();
    expect(() => parseJsonLoose(raw)).toThrow(/未找到 JSON 对象/);
  });

  it('完全没有 JSON → null / 抛错', () => {
    expect(extractFirstJson('这次我不输出 JSON 了')).toBeNull();
    expect(() => parseJsonLoose('这次我不输出 JSON 了')).toThrow();
  });
});
