/**
 * @fileoverview panelOpenStore —— 打开数量上限（ADR §4.4 / 用户口径 m01407）
 *
 * 契约：最多同时打开 `MAX_OPEN_PANELS`（3）个面板；打开第 4 个时淘汰
 * **最久没用过**的那一个（LRU：被打开或被聚焦都算「用过」），并且淘汰**可见**
 * （抛一条 `novelmuse:toast-notify`），不是静默挤掉。
 *
 * 背景：旧 `MAX_OPEN_PANELS = 3` 在 ADR §4.2（D10）因「静默挤掉第一个」被删除，
 * 改为「无限打开」；2026-10-07 用户口径要求上限回归、淘汰依据改为最近使用。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  MAX_OPEN_PANELS,
  _resetPanelOpenStore,
  getPanelNavigation,
  seedPanelOpenKeys,
  usePanelOpenStore,
} from '../panelOpenStore';

const keys = (): string[] => usePanelOpenStore.getState().keys;
const open = (key: string): void => getPanelNavigation().open(key);
const setActive = (key: string): void => usePanelOpenStore.getState()._setActive(key);
const syncFromView = (k: string[]): void => usePanelOpenStore.getState()._syncFromView(k);

describe('panelOpenStore · 打开数量上限（ADR §4.4）', () => {
  // ★ 2026-10-11：基础标签（章节正文）计入**总**上限 ⇒ 它开着时功能面板只能 2 个。
  //   本组测的是**功能面板**的经典 LRU 上限（3 个），故先把基础标签关掉。
  //   基础标签开/关对名额的影响另见下方「基础标签也当动态标签」一组。
  beforeEach(() => {
    _resetPanelOpenStore();
    usePanelOpenStore.getState().closeBase();
  });
  afterEach(() => _resetPanelOpenStore());

  it('上限常量 = 5，且首屏种子（2 个）不触发淘汰', () => {
    // ★ 2026-10-27：作者口径改为「5 个功能面板 + 正文」，故常量从 3 变 5。
    expect(MAX_OPEN_PANELS).toBe(5);
    expect(seedPanelOpenKeys(['chapters', 'ai-chat'])).toBe(true);
    expect(keys()).toEqual(['chapters', 'ai-chat']);
  });

  it('打开第 6 个 ⇒ 裁到 5 个，淘汰最久没用过的那个', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    setActive('e'); // 刚看过 e
    open('f'); // 第 6 个
    expect(keys()).toHaveLength(MAX_OPEN_PANELS);
    expect(keys()).toEqual(['b', 'c', 'd', 'e', 'f']); // 最久没用过的是 a ⇒ 被淘汰
  });

  it('淘汰依据是「最近使用」而不是「最早打开」', () => {
    open('a');
    open('b');
    open('c');
    open('d');
    open('e');
    setActive('a'); // 回头看了 a ⇒ a 变成最近使用
    open('f');
    expect(keys()).toEqual(['a', 'c', 'd', 'e', 'f']); // 被淘汰的是 b，不是最早打开的 a
  });

  it('重复打开已存在的面板只聚焦，不新增也不淘汰', () => {
    for (const k of ['a', 'b', 'c']) open(k);
    open('a');
    expect(keys()).toEqual(['a', 'b', 'c']);
    // 没有淘汰发生 ⇒ 没有提示
    const seen = collectToasts(() => open('a'));
    expect(seen).toHaveLength(0);
  });

  it('toggle 打开第 6 个时同样受上限约束', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    getPanelNavigation().toggle('f');
    expect(keys()).toEqual(['b', 'c', 'd', 'e', 'f']); // a 最久未用 ⇒ 淘汰
  });

  it('视图回写超过上限时裁剪，且不会误杀刚打开的那个', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    // 模拟活动栏：走 DockShellApi.openPanel 直接 addPanel（绕过 store 的 open），
    // DockShell 随后整集合回写 = [a..f] —— f 是刚开的，绝不能被裁掉。
    syncFromView(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(keys()).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  /**
   * ★ 2026-10-19 回归：上面那条只覆盖「d 从未被 touch 过」（`ageRank` 兜底成最新）。
   *   真实路径里 d 往往**本会话早先打开过** —— `recency` 是模块级、跨整页生命周期，
   *   关掉面板并不清它的位次。于是 d 带着一条**陈旧**位次重新被打开时，
   *   裁剪会把它自己判成最久没用过的当场淘汰 ⇒ 用户「点一次没反应、再点一次才开」。
   */
  it('刚打开的面板位次已陈旧时也不会自淘汰（活动栏路径的吞点击）', () => {
    open('f'); // ① 先开过 ⇒ 在 recency 里留下记录
    getPanelNavigation().close('f'); // 关掉不清 recency（视图层减少操作不动使用序）
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    expect(keys()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // ② 活动栏路径：直接 addPanel + 整集合回写。f 是刚被加进视图的那个。
    syncFromView(['a', 'b', 'c', 'd', 'e', 'f']);
    // 被淘汰的必须是**别的**面板（此处是位次最旧的 a），绝不能是刚点的 f。
    expect(keys()).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('淘汰时抛出可见提示（不是静默挤掉）', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    const seen = collectToasts(() => open('f'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message ?? '').toContain(`最多同时打开 ${MAX_OPEN_PANELS} 个`);
  });

  it('close / closeAll 语义不受上限影响', () => {
    for (const k of ['a', 'b', 'c']) open(k);
    getPanelNavigation().close('b');
    expect(keys()).toEqual(['a', 'c']);
    // 关掉的不是当前激活者 ⇒ 激活态不动（关掉激活者才清空）
    expect(usePanelOpenStore.getState().activeKey).toBe('c');
    getPanelNavigation().close('c');
    expect(usePanelOpenStore.getState().activeKey).toBeNull();
    getPanelNavigation().closeAll();
    expect(keys()).toEqual([]);
    expect(usePanelOpenStore.getState().activeKey).toBeNull();
  });

  it('同一批淘汰只提示一次（收敛过程去抖）', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    const seen = collectToasts(() => {
      open('f');
      syncFromView(['a', 'b', 'c', 'd', 'e', 'f']); // 收敛过程中的重复上报
      syncFromView(['a', 'b', 'c', 'd', 'e', 'f']);
    });
    expect(seen).toHaveLength(1);
  });
});

/**
 * ★ 2026-10-11 持久化（用户口径「AI 对话的窗口还是固定的……让他和其他的功能一样
 * 可以动态关闭」）：打开集合跨刷新保留 —— 关掉的面板刷新后**不再自动回来**。
 */
describe('panelOpenStore · 打开集合持久化（刷新保留）', () => {
  beforeEach(() => _resetPanelOpenStore());
  afterEach(() => _resetPanelOpenStore());

  const STORAGE_KEY = 'novelmuse.panelOpen.v1';
  // ★ 2026-10-11：持久化结构升级为 `{ keys, baseOpen }`（基础标签也当动态标签，
  //   它的开/关同样要跨刷新保留）。这里读回整个对象。
  const persisted = (): { keys: string[]; baseOpen: boolean } | null => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as { keys: string[]; baseOpen: boolean });
  };
  const persistedKeys = (): string[] | null => persisted()?.keys ?? null;
  /** 模拟一次「刷新」：清内存状态（含播种开关）但保留持久化记录。 */
  const reload = (): void => _resetPanelOpenStore({ keepStorage: true });

  it('首次使用（无记录）⇒ 播默认种子并落盘为基线', () => {
    expect(persisted()).toBeNull();
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    expect(keys()).toEqual(['chapters', 'ai-chat']);
    expect(persisted()).toEqual({ keys: ['chapters', 'ai-chat'], baseOpen: true });
  });

  it('关掉面板后刷新 ⇒ 保持关闭（不再被默认种子拉回）', () => {
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    getPanelNavigation().close('ai-chat');
    expect(persistedKeys()).toEqual(['chapters']);

    reload(); // 刷新：内存清空，localStorage 保留
    seedPanelOpenKeys(['chapters', 'ai-chat']); // 再次进项目
    expect(keys()).toEqual(['chapters']); // ai-chat 未被拉回 —— 这就是「可以动态关闭」
  });

  it('关光后刷新 ⇒ 保持为空（不播默认种子）', () => {
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    getPanelNavigation().closeAll();
    expect(persistedKeys()).toEqual([]);

    reload();
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    expect(keys()).toEqual([]);
  });

  it('刷新恢复的是用户上次打开的面板（含非默认项）', () => {
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    getPanelNavigation().close('ai-chat');
    open('timeline');
    expect(persistedKeys()).toEqual(['chapters', 'timeline']);

    reload();
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    expect(keys()).toEqual(['chapters', 'timeline']); // 恢复 timeline，且不夹带 ai-chat
  });

  it('播种前的早期空集合回写不落盘（闸门），播种仍能生效', () => {
    // 模拟 DockShell onReady 早于播种 effect 的 _syncFromView([])
    syncFromView([]);
    expect(persisted()).toBeNull(); // 未落盘 ⇒ 不会被误判成「用户关光了」
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    expect(keys()).toEqual(['chapters', 'ai-chat']);
    expect(persisted()).toEqual({ keys: ['chapters', 'ai-chat'], baseOpen: true });
  });

  it('基础标签的开/关也跨刷新保留', () => {
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    usePanelOpenStore.getState().closeBase();
    expect(persisted()).toEqual({ keys: ['chapters', 'ai-chat'], baseOpen: false });

    reload();
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    expect(usePanelOpenStore.getState().baseOpen).toBe(false); // 关掉后刷新不自己回来
  });

  it('旧版裸数组记录（无 baseOpen 字段）⇒ 兼容为 baseOpen=true', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['chapters', 'timeline']));
    seedPanelOpenKeys(['chapters', 'ai-chat']);
    expect(keys()).toEqual(['chapters', 'timeline']);
    expect(usePanelOpenStore.getState().baseOpen).toBe(true);
  });
});

/**
 * ★ 2026-10-27 口径（作者：「5 个功能面板 + 正文」）：
 *   基础标签（章节正文）**不占**功能面板名额 —— 正文开着时屏幕上一共 6 个标签
 *   （1 正文 + 5 面板）；关掉正文则 5 个面板。打开/关闭正文都不触发任何淘汰。
 *
 *   上一版口径是「总标签数 ≤ 3（含正文）」，本次一并推翻（见 panelOpenStore.ts 注释）。
 */
describe('panelOpenStore · 基础标签不占功能面板名额（上限 5）', () => {
  beforeEach(() => _resetPanelOpenStore());
  afterEach(() => _resetPanelOpenStore());

  const baseOpen = (): boolean => usePanelOpenStore.getState().baseOpen;

  it('基础标签默认打开', () => {
    expect(baseOpen()).toBe(true);
  });

  it('基础标签开着 ⇒ 仍可开满 5 个功能面板（不因正文而少一个名额）', () => {
    expect(baseOpen()).toBe(true);
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    expect(keys()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(keys()).toHaveLength(MAX_OPEN_PANELS);
  });

  it('基础标签开着时开第 6 个 ⇒ 淘汰最久未用者（与正文无关）', () => {
    expect(baseOpen()).toBe(true);
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    setActive('e');
    const seen = collectToasts(() => open('f'));
    expect(keys()).toEqual(['b', 'c', 'd', 'e', 'f']); // a 最久未用 ⇒ 淘汰
    expect(seen).toHaveLength(1);
  });

  it('关掉 / 重开基础标签不影响功能面板集合，也不触发淘汰', () => {
    for (const k of ['a', 'b', 'c', 'd', 'e']) open(k);
    const before = keys().slice();
    const seen = collectToasts(() => usePanelOpenStore.getState().closeBase());
    expect(baseOpen()).toBe(false);
    expect(keys()).toEqual(before); // 一个都没被踢
    expect(seen).toHaveLength(0);
    usePanelOpenStore.getState().openBase();
    expect(baseOpen()).toBe(true);
    expect(keys()).toEqual(before);
  });

  it('closeBase / openBase 幂等', () => {
    usePanelOpenStore.getState().closeBase();
    usePanelOpenStore.getState().closeBase();
    expect(baseOpen()).toBe(false);
    usePanelOpenStore.getState().openBase();
    usePanelOpenStore.getState().openBase();
    expect(baseOpen()).toBe(true);
  });
});

/** 收集一次操作期间派发的 toast 事件（`ToastProvider` 监听的同一通道）。 */
function collectToasts(run: () => void): Array<{ message?: string }> {
  const seen: Array<{ message?: string }> = [];
  const onToast = (e: Event) => seen.push((e as CustomEvent<{ message?: string }>).detail);
  window.addEventListener('novelmuse:toast-notify', onToast);
  try {
    run();
  } finally {
    window.removeEventListener('novelmuse:toast-notify', onToast);
  }
  return seen;
}
