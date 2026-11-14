import { describe, expect, it } from 'vitest';
import { resolveEntityId } from '../services/base-service.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('resolveEntityId', () => {
  it('空字符串会生成新 id（AI 工具传 id: "" 的回归）', () => {
    expect(resolveEntityId('')).toMatch(UUID_V4);
  });

  it('纯空白同样视为未提供', () => {
    expect(resolveEntityId('   ')).toMatch(UUID_V4);
  });

  it('null / undefined 生成新 id', () => {
    expect(resolveEntityId(null)).toMatch(UUID_V4);
    expect(resolveEntityId(undefined)).toMatch(UUID_V4);
  });

  it('已有 id 原样保留（去掉首尾空白）', () => {
    expect(resolveEntityId('  char-001  ')).toBe('char-001');
    expect(resolveEntityId('char-001')).toBe('char-001');
  });

  it('连续两次生成不会撞 id（旧实现两次都是 ""）', () => {
    expect(resolveEntityId('')).not.toBe(resolveEntityId(''));
  });
});
