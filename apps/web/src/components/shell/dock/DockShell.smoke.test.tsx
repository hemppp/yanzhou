// ============================================================
// DockShell.smoke.test.tsx — P2 停靠内核的运行时冒烟（t3 自证）
//
// 目的：不只靠静态字符串断言（契约 verify: node -e ... includes('DockviewReact')），
//       而是在 jsdom 里**真的挂载 DockShell**，证明：
//         · 外壳骨架都渲染（活动栏 / 编辑区 / 底部面板细条）
//         · ★ 2026-10-11 单列布局（用户口径「点击那些功能需要显示在正页」）：
//           所有面板都作为**中心组标签**堆叠（`nm-panel:<key>`），无左右/底部停靠列，
//           所有 dockview 原生组头一律隐藏；文档标签栏是 `.dock-docbar` 里的一条。
//         · dockview 宿主被挂载
//         · 面板来源为**外部传入数组**，切换数组 → 活动栏条目同步变化
//         · resolveDockMeta / planDockAreas 的缺省行为与 ADR §1.4/§1.5/§1.6 一致
// ============================================================

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { useState, type Ref } from 'react';
import { Layers } from 'lucide-react';

// dockview 依赖 ResizeObserver / matchMedia —— jsdom 未内建，测试环境补齐。
// （这是**测试环境**能力补齐，不是产品代码的降级；产品运行在真实浏览器里。）
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class RO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  }
});

import { DockShell } from '@/components/shell/DockShell';
import {
  DockPanelDef,
  resolveDockMeta,
  DOCK_META_DEFAULTS,
  type DockShellApi,
} from '@/components/shell/dock/types';
import { planDockAreas, slotToDockDirection } from '@/components/shell/dock/layout';

function makeDef(over: Partial<DockPanelDef> & { key: string; label: string }): DockPanelDef {
  return {
    icon: Layers,
    Component: () => null,
    ...over,
  } as DockPanelDef;
}

const PANELS: DockPanelDef[] = [
  makeDef({ key: 'chapters', label: '章节' }),
  makeDef({ key: 'factions', label: '势力' }),
];

describe('DockShell 外壳骨架', () => {
  it('骨架（活动栏 / 编辑区 / 底部细条）与 dockview 宿主都在 DOM 里', () => {
    const { container } = render(
      <DockShell panels={PANELS} centerDefault={<div>editor</div>} />,
    );
    expect(container.querySelector('.dock-activity-bar')).toBeTruthy();
    expect(container.querySelector('.dock-main')).toBeTruthy();
    expect(container.querySelector('.dock-bottom-area')).toBeTruthy();
    // ★ 2026-11-06：右端「N 条问题 / Ctrl+J」提示已移除，细条只剩开合开关
    expect(container.querySelector('.dock-bottom-toggle')).toBeTruthy();
    expect(container.querySelector('.dock-bottom-issues')).toBeNull();
    expect(container.querySelector('.dock-bottom-kbd')).toBeNull();
    // ★ t1：内核自带的第二根状态栏与两个占位侧栏已删除（截图只有一根通栏状态栏）
    expect(container.querySelector('.dock-status-bar')).toBeNull();
    expect(container.querySelector('.dock-side-bar')).toBeNull();
    expect(container.querySelector('.dock-aux-bar')).toBeNull();
    // dockview 宿主（能力 1/3/4/7 的载体）
    expect(container.querySelector('.dockview-host')).toBeTruthy();
    // §5.5 冻结的主题映射层类
    expect(container.querySelector('.dv-theme-vscode')).toBeTruthy();
    // ★ 2026-10-11 单列布局：文档标签栏是 .dock-main 顶部的一条（.dock-docbar）
    expect(container.querySelector('.dock-docbar')).toBeTruthy();
  });

  it('活动栏条目由外部 panels 派生（不硬编码业务面板）', () => {
    const { container, rerender } = render(
      <DockShell panels={PANELS} centerDefault={<div />} />,
    );
    expect(container.querySelectorAll('.dock-activity-item').length).toBe(2);

    // 换成 3 个 → 活动栏同步
    rerender(
      <DockShell
        panels={[
          makeDef({ key: 'a', label: 'A' }),
          makeDef({ key: 'b', label: 'B' }),
          makeDef({ key: 'c', label: 'C' }),
        ]}
        centerDefault={<div />}
      />,
    );
    expect(container.querySelectorAll('.dock-activity-item').length).toBe(3);
  });

  it('候选池为空也不崩（骨架常驻）+ centerDefault 传得进去', () => {
    const { container } = render(
      <DockShell panels={[]} centerDefault={<div data-testid="ed">E</div>} />,
    );
    expect(container.querySelector('.dock-activity-bar')).toBeTruthy();
    expect(container.querySelector('.dock-bottom-area')).toBeTruthy();
    expect(container.querySelector('.dock-bottom-toggle')).toBeTruthy();
  });

  // ★ t1：底部细条只负责机制 —— Ctrl+J 展开/收起由内核处理；展开区渲染调用方给的 children。
  it('底部细条：Ctrl+J 展开/收起、展开区渲染 children', () => {
    const { container } = render(
      <DockShell
        panels={PANELS}
        centerDefault={<div />}
        bottomPanel={{ children: <div data-testid="bl">problems</div> }}
      />,
    );
    const area = container.querySelector('.dock-bottom-area') as HTMLElement;
    expect(area).toBeTruthy();
    // 折叠态：细条常驻、展开区不渲染
    expect(area.getAttribute('data-open')).toBe('false');
    expect(container.querySelector('[data-testid="bl"]')).toBeNull();

    // Ctrl+J → 展开
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(area.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('[data-testid="bl"]')).toBeTruthy();

    // 再按一次 → 收起
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    expect(area.getAttribute('data-open')).toBe('false');

    // 点「底部面板」开关 → 也能展开
    const toggle = container.querySelector('.dock-bottom-toggle') as HTMLElement;
    expect(toggle.textContent).toContain('底部面板');
    fireEvent.click(toggle);
    expect(area.getAttribute('data-open')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('apiRef 暴露 §2.4 DockShellApi 方法（含单列布局新增 focusBase）', () => {
    const ref = { current: null as null | Record<string, unknown> };
    render(<DockShell panels={PANELS} centerDefault={<div />} apiRef={ref as never} />);
    expect(ref.current).toBeTruthy();
    for (const m of [
      'openPanel',
      'closePanel',
      'focusPanel',
      'focusBase',
      'listPanels',
      'activePanel',
      'floatPanel',
      'dockPanel',
    ]) {
      expect(typeof ref.current?.[m]).toBe('function');
    }
  });
});

describe('resolveDockMeta —— ADR §1.4/§1.5 缺省真源', () => {
  it('未声明 dock → 全部取冻结缺省', () => {
    const m = resolveDockMeta(makeDef({ key: 'x', label: 'X' }));
    expect(m.slot).toBe('right');
    expect(m.defaultOpen).toBe(false);
    expect(m.allowMultiple).toBe(false);
    expect(m.closable).toBe(true);
    expect(m.floatable).toBe(true);
    expect(m.minSize).toEqual({ width: 240, height: 160 });
    expect(m.center).toBe(false);
    // floatingSize 回落链：顶层 width/height → 1024×720
    expect(m.floatingSize).toEqual({ width: 1024, height: 720 });
  });

  it('floatingSize 回落链：dock.floatingSize → 顶层 width/height', () => {
    const a = resolveDockMeta(makeDef({ key: 'a', label: 'A', width: 800, height: 600 }));
    expect(a.floatingSize).toEqual({ width: 800, height: 600 });

    const b = resolveDockMeta(
      makeDef({ key: 'b', label: 'B', width: 800, dock: { floatingSize: { width: 1, height: 2 } } }),
    );
    expect(b.floatingSize).toEqual({ width: 1, height: 2 });
  });

  it('显式声明覆盖缺省', () => {
    const m = resolveDockMeta(
      makeDef({ key: 'g', label: 'G', dock: { slot: 'bottom', floatable: false, closable: false } }),
    );
    expect(m.slot).toBe('bottom');
    expect(m.floatable).toBe(false);
    expect(m.closable).toBe(false);
  });

  it('DOCK_META_DEFAULTS 与 ADR §1.5 冻结表逐字段一致', () => {
    expect(DOCK_META_DEFAULTS.slot).toBe('right');
    expect(DOCK_META_DEFAULTS.minSize).toEqual({ width: 240, height: 160 });
    expect(DOCK_META_DEFAULTS.fallbackFloatingSize).toEqual({ width: 1024, height: 720 });
  });
});

describe('planDockAreas / slot 映射 —— ★ 2026-10-11 单列布局', () => {
  // ★ 用户口径「点击那些功能需要显示在正页」：布局收敛为单列 —— 全部面板进中心组，
  //   不再按 `slot` 分到左右/底部停靠列。`dock.slot` 字段仍保留在类型上，但布局层忽略它。
  it('全部面板都进 center 桶（left/right/bottom 恒空）', () => {
    const plan = planDockAreas([
      makeDef({ key: 'a', label: 'A' }),
      makeDef({ key: 'b', label: 'B', dock: { slot: 'left' } }),
      makeDef({ key: 'c', label: 'C', dock: { slot: 'bottom' } }),
      makeDef({ key: 'd', label: 'D', dock: { slot: 'right' } }),
    ]);
    expect(plan.center.map((d) => d.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(plan.left).toHaveLength(0);
    expect(plan.right).toHaveLength(0);
    expect(plan.bottom).toHaveLength(0);
  });

  it('order 升序且稳定（同 order 保持原序）', () => {
    const plan = planDockAreas([
      makeDef({ key: 'a', label: 'A', order: 2 }),
      makeDef({ key: 'b', label: 'B', order: 1 }),
      makeDef({ key: 'c', label: 'C', order: 1 }),
    ]);
    expect(plan.center.map((d) => d.key)).toEqual(['b', 'c', 'a']);
  });

  it('槽位 → dockview Direction：bottom 映射为 below（字段仍保留）', () => {
    expect(slotToDockDirection('left')).toBe('left');
    expect(slotToDockDirection('right')).toBe('right');
    expect(slotToDockDirection('bottom')).toBe('below');
  });
});

// ============================================================
// ★ 2026-10-11 单列布局：所有面板同组标签堆叠（原「中心槽抢占单一所有者」的替代）
//
//   旧模型有两个实例 id：中心槽 `nm-center:<key>`（被 center 面板抢占）与普通
//   `nm-panel:<key>`。单列化后**只剩 `nm-panel:<key>`** —— 每个业务 key 恰好 1 个实例，
//   且都落在中心组（承载 CENTER_DEFAULT_PANEL_ID 的组）里。
//
//   实例 id 的可观测性：dockview 把每个面板的真实 id 渲染为 `[data-tab-panel-id]`，
//   故可在 DOM 上直接数实例个数（不依赖内核私有状态）。
// ============================================================

/** DOM 里出现的全部 dockview 面板实例 id（含中心默认面板）。 */
function panelIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-tab-panel-id]')).map(
    (n) => n.getAttribute('data-tab-panel-id') ?? '',
  );
}

const countId = (container: HTMLElement, id: string): number =>
  panelIds(container).filter((x) => x === id).length;

/** 等 dockview 的 effect 链落定（addPanel / removePanel 是异步提交的）。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

describe('单列布局 · 全部面板作为中心组标签', () => {
  it('已打开面板都是 nm-panel:<key>，且各恰好 1 个实例', async () => {
    const ref = { current: null as DockShellApi | null };
    const { container } = render(
      <DockShell panels={PANELS} centerDefault={<div />} openKeys={['chapters', 'factions']} apiRef={ref as never} />,
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    await settle();

    expect(countId(container, 'nm-panel:chapters')).toBe(1);
    expect(countId(container, 'nm-panel:factions')).toBe(1);
    // 中心默认面板常驻
    expect(countId(container, 'nm-center-default')).toBe(1);
    // 不再有 nm-center:<key> 实例（旧中心替换槽）
    expect(panelIds(container).some((id) => id.startsWith('nm-center:'))).toBe(false);
    // 列表无重复
    const listed = ref.current!.listPanels();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(expect.arrayContaining(['chapters', 'factions']));
  });

  it('openPanel 幂等（重复调用不新增实例）', async () => {
    const ref = { current: null as DockShellApi | null };
    const { container } = render(
      <DockShell panels={PANELS} centerDefault={<div />} openKeys={[]} apiRef={ref as never} />,
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    await settle();

    ref.current!.openPanel('chapters');
    await settle();
    ref.current!.openPanel('chapters');
    await settle();

    expect(countId(container, 'nm-panel:chapters')).toBe(1);
  });

  it('onOpenChange 只上报唯一 key（保留首次出现顺序）', async () => {
    const ref = { current: null as DockShellApi | null };
    const payloads: string[][] = [];
    const onOpenChange = (keys: string[]) => payloads.push([...keys]);
    const { rerender } = render(
      <DockShell
        panels={PANELS}
        centerDefault={<div />}
        openKeys={[]}
        apiRef={ref as never}
        onOpenChange={onOpenChange}
      />,
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    await settle();

    // 受控集合变化（= 用户打开面板）⇒ 视图 addPanel ⇒ onDidAddPanel 上报
    rerender(
      <DockShell
        panels={PANELS}
        centerDefault={<div />}
        openKeys={['chapters', 'factions']}
        apiRef={ref as never}
        onOpenChange={onOpenChange}
      />,
    );
    await settle();

    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(new Set(p).size).toBe(p.length);
    }
    expect(payloads[payloads.length - 1]).toEqual(
      expect.arrayContaining(['chapters', 'factions']),
    );
  });
});

// ============================================================
// ★ 2026-10-11 单列布局：**所有** dockview 原生组头隐藏
//
//   文档标签栏改为 `.dock-docbar`（.dock-main 顶部整宽一条），dockview 原生组头/标签
//   一律隐藏 —— 顶部只保留「顶栏 + 文档标签栏」两条带。
//
// jsdom 断言的是**组头元素的 display**（不依赖真实布局）。
// ============================================================

/** 每组的组头容器（`.dv-tabs-and-actions-container` 由 dockview 生成）。 */
function groupHeaders(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '.dv-groupview > .dv-tabs-and-actions-container',
    ),
  );
}

describe('单列布局 · 隐藏所有组头', () => {
  it('所有组头都被隐藏（visible = 0）', async () => {
    const { container } = render(
      <DockShell panels={PANELS} centerDefault={<div />} openKeys={['chapters']} />,
    );
    await settle();

    const headers = groupHeaders(container);
    expect(headers.length).toBeGreaterThanOrEqual(1);
    expect(headers.filter((h) => h.style.display !== 'none').length).toBe(0);
  });

  it('开→关一个面板后，组头仍全隐藏（不因增删组而回退）', async () => {
    const ref = { current: null as DockShellApi | null };
    const { container, rerender } = render(
      <DockShell panels={PANELS} centerDefault={<div />} openKeys={[]} apiRef={ref as never} />,
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    await settle();
    expect(groupHeaders(container).filter((h) => h.style.display !== 'none').length).toBe(0);

    rerender(
      <DockShell panels={PANELS} centerDefault={<div />} openKeys={['chapters']} apiRef={ref as never} />,
    );
    await settle();
    expect(groupHeaders(container).filter((h) => h.style.display !== 'none').length).toBe(0);

    rerender(
      <DockShell panels={PANELS} centerDefault={<div />} openKeys={[]} apiRef={ref as never} />,
    );
    await settle();
    expect(groupHeaders(container).filter((h) => h.style.display !== 'none').length).toBe(0);
  });
});

// ============================================================
// ★ 2026-10-07 用户口径（m01200「让他点击对应的按钮可以收起来」）：
//   最左侧活动栏的图标按钮 = 该面板的**开/关开关**。
//   下面用**受控宿主**（复刻 ProjectLayout 的 `openKeys` + `onOpenChange`
//   回写，即 store `_syncFromView` 所在的位置）把开关语义钉死在冒烟层。
// ============================================================
describe('活动栏按钮 = 面板开/关开关（2026-10-07 用户口径）', () => {
  /** 取活动栏里指定 aria-label 的图标按钮 */
  const activityItem = (container: HTMLElement, label: string): HTMLElement => {
    const item = Array.from(
      container.querySelectorAll<HTMLElement>('.dock-activity-item'),
    ).find((el) => el.getAttribute('aria-label') === label);
    if (!item) throw new Error(`活动栏里找不到「${label}」按钮`);
    return item;
  };

  /** 复刻 ProjectLayout：受控 `openKeys` + `onOpenChange` 回写（= store 的 `_syncFromView` 位置） */
  function ControlledShell({
    onOpenChange,
    apiRef,
  }: {
    onOpenChange?: (keys: string[]) => void;
    apiRef?: Ref<DockShellApi>;
  }) {
    const [keys, setKeys] = useState<string[]>(['chapters']);
    return (
      <DockShell
        panels={PANELS}
        centerDefault={<div />}
        openKeys={keys}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setKeys(next);
        }}
        apiRef={apiRef}
      />
    );
  }

  it('点已打开的按钮 ⇒ 收起（视图移除 + 回写集合移除 + 按钮翻成「点击打开」）', async () => {
    const onOpenChange = vi.fn();
    const ref = { current: null as DockShellApi | null };
    const { container } = render(
      <ControlledShell onOpenChange={onOpenChange} apiRef={ref as never} />,
    );
    await waitFor(() => expect(ref.current).toBeTruthy());
    await settle();

    expect(ref.current!.listPanels()).toContain('chapters');
    expect(activityItem(container, '章节').getAttribute('aria-pressed')).toBe('true');
    expect(activityItem(container, '章节').getAttribute('title')).toBe('章节（点击收起）');

    fireEvent.click(activityItem(container, '章节'));
    await settle();

    // ① 视图层：dockview 里真的没了
    expect(ref.current!.listPanels()).not.toContain('chapters');
    // ② 宿主层：回写集合里也没了（store 才有机会把这次收起持久化）
    expect(onOpenChange).toHaveBeenCalled();
    const calls = onOpenChange.mock.calls;
    const last = calls[calls.length - 1]?.[0] as string[] | undefined;
    expect(last).toBeDefined();
    expect(last).not.toContain('chapters');
    // ③ 按钮回到「点击打开」
    expect(activityItem(container, '章节').getAttribute('aria-pressed')).toBe('false');
    expect(activityItem(container, '章节').getAttribute('title')).toBe('章节（点击打开）');
  });

  it('再点一次同一个按钮 ⇒ 重新打开（开关可来回拨）', async () => {
    const ref = { current: null as DockShellApi | null };
    const { container } = render(<ControlledShell apiRef={ref as never} />);
    await waitFor(() => expect(ref.current).toBeTruthy());
    await settle();
    expect(ref.current!.listPanels()).toContain('chapters');

    fireEvent.click(activityItem(container, '章节'));
    await settle();
    expect(ref.current!.listPanels()).not.toContain('chapters');
    expect(activityItem(container, '章节').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(activityItem(container, '章节'));
    await settle();
    expect(ref.current!.listPanels()).toContain('chapters');
    expect(activityItem(container, '章节').getAttribute('aria-pressed')).toBe('true');
  });

  it('未打开过的面板按钮点击 ⇒ 打开（不是「只聚焦」）', async () => {
    const ref = { current: null as DockShellApi | null };
    const { container } = render(<ControlledShell apiRef={ref as never} />);
    await waitFor(() => expect(ref.current).toBeTruthy());
    await settle();
    // 「势力」初始未打开
    expect(ref.current!.listPanels()).not.toContain('factions');
    expect(activityItem(container, '势力').getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(activityItem(container, '势力'));
    await settle();
    expect(ref.current!.listPanels()).toContain('factions');
    expect(activityItem(container, '势力').getAttribute('aria-pressed')).toBe('true');
  });
});
