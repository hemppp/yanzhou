// ============================================================
// DocTabs.preview.test.tsx —— 预览标签（VS Code 单击预览 / 双击固定）
//
// 背景（作者口径：「标签需要改成 vs code 那种多个同时打开」的 P1）：
//   VS Code 浏览文件时，单击 = **预览**（斜体、占同一个位，再点别的就替换），
//   双击 = **固定**（转正、不再被替换）。这样"随便看看"不会把 5 个名额耗尽。
//
// 本文件锁三条契约：
//   1. 预览标签带 `is-preview` 类（CSS 据它画斜体）
//   2. 全局**只有一个**预览位：预览 A 再预览 B ⇒ A 被替换，keys 不增长
//   3. 双击 / 点已打开的标签 ⇒ 转正（previewKey 清空）
//
// ⚠️ 与 store 的分工：这里只测 store 的语义（纯状态机），
//   UI 层的斜体类由 DocTabs 渲染——它读 `previewKey` 后加类，见第 1 条的实现。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { usePanelOpenStore, _resetPanelOpenStore } from '@/stores/panelOpenStore';

const store = () => usePanelOpenStore.getState();
const keys = () => store().keys;
const preview = () => store().previewKey;

beforeEach(() => {
  _resetPanelOpenStore();
  usePanelOpenStore.getState().closeBase();
});
afterEach(() => _resetPanelOpenStore());

describe('预览标签 · 单一预览位（VS Code open preview）', () => {
  it('openPreview 打开的面板记为预览位', () => {
    store().openPreview('notes');
    expect(keys()).toEqual(['notes']);
    expect(preview()).toBe('notes');
  });

  it('★ 预览另一个面板 ⇒ 旧的被**替换**，keys 不增长（这是预览的全部意义）', () => {
    store().openPreview('notes');
    store().openPreview('outline');
    expect(keys()).toEqual(['outline']); // notes 已被替换掉
    expect(preview()).toBe('outline');
  });

  it('预览不影响**已固定**的标签（固定标签不会被预览替换）', () => {
    store().open('stats');          // 显式 open = 固定
    store().openPreview('notes');
    expect(keys()).toEqual(['stats', 'notes']);
    store().openPreview('outline');
    // stats 固定着不动，只有预览位被换
    expect(keys()).toEqual(['stats', 'outline']);
    expect(preview()).toBe('outline');
  });

  it('pinPreview 把预览转正（previewKey 清空，面板仍在 keys 里）', () => {
    store().openPreview('notes');
    store().pinPreview('notes');
    expect(preview()).toBeNull();
    expect(keys()).toEqual(['notes']);
  });

  it('★ 再次点已打开的预览标签 ⇒ 自动转正（VS Code 同款）', () => {
    store().openPreview('notes');
    store().openPreview('notes'); // 再点一次
    expect(preview()).toBeNull();
    expect(keys()).toEqual(['notes']);
  });

  it('显式 open（活动栏双击 / 命令）⇒ 不留预览位', () => {
    store().openPreview('notes');
    store().open('outline');
    expect(preview()).toBeNull();
  });

  it('关掉预览标签 ⇒ 预览位清空（不留悬空 key）', () => {
    store().openPreview('notes');
    store().close('notes');
    expect(preview()).toBeNull();
    expect(keys()).toEqual([]);
  });

  it('预览标签也计入上限：预览第 6 个时同样按 LRU 淘汰', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) store().open(k);
    store().openPreview('f');
    expect(keys()).toHaveLength(5);
    expect(keys()).toContain('f');
    // a 最久未用 ⇒ 被淘汰
    expect(keys()).not.toContain('a');
    expect(preview()).toBe('f');
  });
});
