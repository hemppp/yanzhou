// ============================================================
// DockShell.tsx — 停靠系统内核（P2 · t3；★ 2026-10-11 单列化）
//
// ★ 2026-10-11 用户口径「点击那些功能需要显示在正页」：
//   布局收敛为**单列** —— 所有功能面板都在**中心组**里以标签堆叠，与「章节正文」
//   同处正页；不再有左/右/底部停靠列。文档标签栏（`.shell-doctabs`）是 `.dock-main`
//   顶部整宽的一条（不再是 dockview 组头里的 tabComponent），dockview 原生组头/标签
//   一律隐藏。详见 layout.ts `planDockAreas` 与下方「隐藏所有组头」effect。
//
// 用 dockview 实现的能力（验收逐条对应）：
//   1. 面板来源为**外部传入**的 `panels` 数组，不硬编码业务面板
//   2. 标题栏可拖拽 → 拖出为 dockview **floating group**（悬浮窗口），可再拖回
//   3. **中心编辑区**（单列：全部面板同组标签堆叠）
//   4. 同一 group 内**多面板标签堆叠**（Tabbed Dock Group）
//   5. 拖拽时**落点预览指示器**（Dock Preview Indicator），样式对齐 VS Code
//   6. 关系图/图谱以既有 `@xyflow/react` 承载（D16：无 C++/Qt）
//   7. 面板间**可拖动 Splitter** 调整大小（dockview sash；--dv-active-sash-color 接主题）
//   8. VS Code 式**外壳骨架**：活动栏 + 编辑区 + 底部面板区 + 状态栏
//
// 颜色：一律 `--vscode-*`（ADR §5.3）与 `--dv-*`（§5.5 经 .dv-theme-vscode 映射）。
//       本文件**不含任何字面色值**（约定 C-3：不写 `var(--x, #fff)` 兜底）。
//
// 依赖：dockview / dockview-react（t3 已在 apps/web/package.json 声明）。
// ============================================================

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  type DockviewReadyEvent,
  type DockviewApi,
  type DockviewTheme,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type TabDragEvent,
} from 'dockview';
import { DockviewReact } from 'dockview-react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import 'dockview/dist/styles/dockview.css';
import './dock/dock-tokens.css';
import './dock/dock-theme.css';

import {
  DockPanelContent,
  DockWatermark,
  DockCenterSlot,
  type DockPanelParams,
} from './dock/DockPanelContent';
import { CenterGraphPanel } from './dock/CenterGraphPanel';
// ★ t6 去层：中心组头渲染「文档标签行」（原先顶栏之下的独立 30px 横条）
import { DocTabsHeader } from './DocTabs';
import {
  CENTER_DEFAULT_PANEL_ID,
  DOCK_PANEL_COMPONENT_ID,
  buildLayoutSteps,
  panelInstanceId,
  panelKeyFromInstanceId,
  planDockAreas,
  type DockPanelSpec,
} from './dock/layout';
import {
  resolveDockMeta,
  type DockAreaSlot,
  type DockPanelDef,
  type DockShellApi,
  type DockShellProps,
} from './dock/types';
// ★ 底部面板分区（插件扩展点）：细条右侧入口 + 展开区栏目，见 bottomSections.tsx
import { useBottomPanelSections } from './bottomSections';

// ---- 内部渲染器：中心区默认占用者（章节编辑器出口） ----------------------

interface CenterDefaultParams {
  centerDefault: ReactNode;
}

/**
 * 中心编辑区的**根面板**内容。它承载 `centerDefault`（章节编辑器路由出口），
 * 当被 center panel 抢占时，改由该 center panel 的 Component 渲染（见下方 useEffect）。
 */
function CenterDefaultContent(props: IDockviewPanelProps<CenterDefaultParams>) {
  return (
    <DockCenterSlot>
      <div className="dock-editor-surface">{props.params.centerDefault}</div>
    </DockCenterSlot>
  );
}

/**
 * dockview 的 components 注册表。只注册 3 个**通用**渲染器，
 * 没有任何业务面板 key —— 满足「不硬编码具体业务面板」。
 */
const DOCK_COMPONENTS: Record<string, React.ComponentType<IDockviewPanelProps<never>>> = {
  [DOCK_PANEL_COMPONENT_ID]: DockPanelContent as unknown as React.ComponentType<
    IDockviewPanelProps<never>
  >,
};

const CENTER_DEFAULT_COMPONENT_ID = 'dock:center-default';

/**
 * 关系图 / 图谱中心面板的渲染器（D16：以既有 `@xyflow/react` 承载，**无 C++/Qt/QGraphicsView**）。
 * 它是「中心区为可替换插槽」的**演示实现**：任何声明 `dock:{center:true}` 的插件面板
 * 都可经同一 `DOCK_PANEL_COMPONENT_ID` 通道抢占中心区，此处不硬编码业务 key。
 */
function CenterGraphContent() {
  return (
    <DockCenterSlot>
      <CenterGraphPanel />
    </DockCenterSlot>
  );
}

const CENTER_GRAPH_COMPONENT_ID = 'dock:center-graph';

/**
 * §5.5 冻结的 dockview 主题：`className` 指向 dock-theme.css 的 `.dv-theme-vscode`，
 * 由该 CSS 把 dockview 的 `--dv-*` 映射到 `--vscode-*`（不新增字面色值）。
 *
 * 能力 5（拖拽预览指示器）经由主题选项对齐 VS Code：
 *   - `dndPanelOverlay: 'group'`  → 预览覆盖整个 group（VS Code 拖拽预览的落区感）
 *   - `dndTabIndicator: 'line'`   → 标签插入指示为细线（VS Code 标签位）
 *   - `dndOverlayBorder`          → 2px 焦点边框（§5.6 冻结）
 */
export const VSCODE_DOCK_THEME: DockviewTheme = {
  name: 'vscode-dark-modern',
  className: 'dv-theme-vscode',
  colorScheme: 'dark',
  dndPanelOverlay: 'group',
  dndTabIndicator: 'line',
  dndOverlayBorder: '2px solid var(--vscode-focusBorder)',
  tabGroupIndicator: 'none',
};

const DOCK_TAB_COMPONENT_ID = 'dock:tab';

/**
 * 自定义标签渲染器：
 *   1. 读取 `params.def` 的 `resolveDockMeta().closable` —— 能力 4 的标签堆叠里，
 *      只有 `closable !== false` 的面板才显示 × （dockview 无内建 per-panel closable）。
 *   2. 前置显示插件提供的 `icon`（ADR §1.1 字段 3）。
 *   3. 视觉沿用 `--vscode-tab-*`（D15：类名保留、只换值）。
 */
function DockTab(props: IDockviewPanelHeaderProps<DockPanelParams>) {
  const def = props.params?.def;
  const meta = def ? resolveDockMeta(def) : null;
  const Icon = def?.icon;
  return (
    <div className="dock-tab">
      {Icon ? (
        <span className="dock-tab-icon">
          <Icon size={13} />
        </span>
      ) : null}
      <span className="dock-tab-label">{typeof props.api.title === 'string' ? props.api.title : ''}</span>
      {meta?.closable !== false ? (
        <button
          type="button"
          className="dock-tab-close"
          aria-label={`关闭 ${def?.label ?? (typeof props.api.title === 'string' ? props.api.title : '')}`}
          onClick={(e) => {
            e.stopPropagation();
            props.api.close();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

const ALL_COMPONENTS = {
  ...DOCK_COMPONENTS,
  [CENTER_DEFAULT_COMPONENT_ID]: CenterDefaultContent as unknown as React.ComponentType<
    IDockviewPanelProps<never>
  >,
  [CENTER_GRAPH_COMPONENT_ID]: CenterGraphContent as unknown as React.ComponentType<
    IDockviewPanelProps<never>
  >,
};

/**
 * 标签渲染器注册表（能力 4：堆叠标签的 × 受 `dock.closable` 控制）。
 * ★ 单列布局下组头已由 CSS 隐藏（见「隐藏所有组头」effect），故这里实际不会再渲染；
 *   保留注册以满足 dockview 的 `tabComponents` 契约。
 */
const ALL_TAB_COMPONENTS = {
  [DOCK_TAB_COMPONENT_ID]: DockTab as unknown as React.ComponentType<
    IDockviewPanelHeaderProps<never>
  >,
};

// ---- 外壳骨架的小组件（VS Code 结构，颜色全取变量） ----------------------

/**
 * 活动栏（Activity Bar）：最左侧窄条，图标入口。
 *
 * ★ 2026-10-07 用户口径（m01200「让他点击对应的按钮可以收起来」）：
 *   每个图标是该面板的**开/关开关** —— 已打开再点 = 收起，未打开点击 = 打开。
 *   因此这里有两个独立视觉维度，**不能**像改造前那样用 `activeKey` 兼任两者：
 *     · `is-active`   = 当前**聚焦**的面板（VS Code 活动栏的左缘高亮条语义，沿用）
 *     · `aria-pressed` = 该面板当前**是否已打开**（开关语义，供读屏与测试判定）
 *   改造前两者都取 `activeKey`，于是「已打开但未聚焦」的面板按钮显示为未按下，
 *   点它只会聚焦、永远不会收起 —— 这正是用户反馈的现象。
 */
function ActivityBar({
  items,
  activeKey,
  openKeys,
  onSelect,
}: {
  items: { key: string; label: string; icon: React.ComponentType<{ size?: number }> }[];
  activeKey: string | null;
  /** 当前已打开的面板 key（受控集合；用于开关态的 aria-pressed 与提示文案） */
  openKeys: readonly string[];
  onSelect: (key: string) => void;
}) {
  return (
    <nav className="dock-activity-bar" aria-label="活动栏">
      {items.map((it) => {
        const Icon = it.icon;
        const active = it.key === activeKey;
        const open = openKeys.includes(it.key);
        return (
          <button
            key={it.key}
            type="button"
            className={active ? 'dock-activity-item is-active' : 'dock-activity-item'}
            title={open ? `${it.label}（点击收起）` : `${it.label}（点击打开）`}
            aria-label={it.label}
            aria-pressed={open}
            onClick={() => onSelect(it.key)}
          >
            {/* ★ t6 尺寸对齐参考图：参考图条目内图标墨迹实测 ~15×10（≈18px lucide），原 22px 偏大。 */}
            <Icon size={18} />
          </button>
        );
      })}
    </nav>
  );
}

// ★ t1（外壳改造）已删除两个**纯占位**骨架与内核自带的第二根状态栏：
//   · `SectionHeader`（侧栏 / 辅助侧栏 / 底部面板区的分区标题条）
//   · `StatusBar`（`.dock-status-bar`，与 ProjectLayout 的通栏状态栏重复）
//   真实面板由 dockview 在中心区内左右停靠渲染，占位骨架（`.dock-side-bar` /
//   `.dock-aux-bar`）只会白占 260px + 240px，使截图里的 240/340 侧栏无法成立。
//   截图只有**一根通栏状态栏**，由 ProjectLayout 的 `footer.shell-statusbar` 承担。

// ---- 主体 -----------------------------------------------------------------

/**
 * DockShell —— 停靠系统内核。
 *
 * 「上/下/左/右四个 dock area」由 dockview 的 `addPanel({ position: { direction } })`
 * 动态建立（left/right/above/below），每个 area 天然是一个可继续吸附的 drop target；
 * 中心编辑区由根面板（CENTER_DEFAULT_PANEL_ID）承载。
 */
export const DockShell = forwardRef<DockShellApi, DockShellProps>(function DockShell(
  props,
  ref,
) {
  const {
    panels,
    centerDefault,
    openKeys,
    baseOpen,
    onOpenChange,
    onActiveChange,
    bottomPanel,
  } = props;

  const apiRef = useRef<DockviewApi | null>(null);
  const [ready, setReady] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** ★ t1：底部面板细条的展开态（Ctrl+J / 点击左端标题切换）。 */
  const [bottomOpen, setBottomOpen] = useState(false);
  /**
   * ★ 底部面板分区（插件注册的栏目）。
   *   细条右侧渲染各分区的 `ThinEntry`（入口 / 计数），展开区先渲染各分区
   *   的 `Component`（一栏），再渲染调用方给的 `bottomPanel.children`（问题清单）。
   */
  const bottomSections = useBottomPanelSections();

  // ★ t1：Ctrl+J 展开/收起底部面板。监听挂 window（与编辑器快捷键解耦），
  //   并 preventDefault 掉浏览器把 Ctrl+J 当「下载」的默认行为。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'j' && e.key !== 'J') return;
      e.preventDefault();
      setBottomOpen((v) => !v);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 候选池：key → def。外部数组变化时整体重建（t4 会按 project.mode 过滤后传入）。
  const defByKey = useMemo(() => {
    const map = new Map<string, DockPanelDef>();
    for (const def of panels) map.set(def.key, def);
    return map;
  }, [panels]);

  const defByKeyRef = useRef(defByKey);
  defByKeyRef.current = defByKey;

  const propsRef = useRef({ openKeys, baseOpen, onOpenChange, onActiveChange, centerDefault });
  propsRef.current = { openKeys, baseOpen, onOpenChange, onActiveChange, centerDefault };

  /** 受控优先：外部给了 openKeys 就用它，否则用 defaultOpen 推导的内部状态。 */
  const initialOpenKeys = useMemo(() => {
    if (openKeys) return openKeys;
    return panels.filter((d) => resolveDockMeta(d).defaultOpen).map((d) => d.key);
    // 仅在首次挂载 / panels 身份变化时重算（外部受控时以 openKeys 为准）
  }, [panels, openKeys]);

  /** 把当前 dockview 面板集合回写成业务 key 数组（中心默认面板不算业务面板）。 */
  const emitOpenChange = useCallback((dock: DockviewApi) => {
    // ★ 防御性去重（保留**首次出现**顺序）：`keyOfPanel` 把 `nm-center:<key>` 与
    //   `nm-panel:<key>` 映射成**同一个**业务 key，故实例一旦重复，同一个 key 会被
    //   写进宿主 store 两次，污染「打开顺序」与状态栏计数。
    //   单一所有者修好之后重复本不该发生，但 store 不该被内核的瞬时状态污染。
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const p of dock.panels) {
      const k = keyOfPanel(p);
      if (k === null || seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
    propsRef.current.onOpenChange?.(keys);
  }, []);

  // ---- 能力 1/3/4/7：初始布局（多面板 + 四区 + 标签堆叠在运行时由拖拽达成） ----
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const dock = event.api;
    apiRef.current = dock;

    const all = defByKeyRef.current;
    // ★ t4（集成接线）：`onReady` 是 `useCallback(…, [])`，`initialOpenKeys` 是**首帧**
    //   闭包值；受控模式下首帧往往还是空集合（宿主播种 / 插件面板注册都发生在其后的
    //   effect 里）。故优先取 propsRef 里的**最新**受控集合；非受控时仍回落
    //   first-render 的 `defaultOpen` 推导，语义不变。
    const wanted = new Set(propsRef.current.openKeys ?? initialOpenKeys);
    // ★ 2026-10-11 单列布局（用户口径「点击那些功能需要显示在正页」）：
    //   所有面板都进**中心组**、以文档标签形式堆叠，不再有左右/底部停靠列。
    //   `planDockAreas` 已把全部面板收进 center 桶（其余桶恒空），故这里不再过滤 center。
    const opened = [...all.values()].filter((d) => wanted.has(d.key));
    const plan = planDockAreas(opened);

    // 根面板 = 中心编辑区（章节编辑器出口），它是 grid 的锚点。
    // ★ 2026-10-11：不再挂 `tabComponent`（文档标签栏已移出组头、成为 .dock-main 的同级），
    //   且组头由 CSS 隐藏（单列布局下组头无意义）。面板仍作为**标签**堆在中心组里。
    dock.addPanel({
      id: CENTER_DEFAULT_PANEL_ID,
      component: CENTER_DEFAULT_COMPONENT_ID,
      title: '编辑区',
      params: { centerDefault: propsRef.current.centerDefault },
      // 不传 position：它建立 grid 根
      minimumWidth: 320,
      minimumHeight: 200,
    });

    // 其余面板按 resolveDockMeta 分桶，逐条 addPanel（串行是 dockview 的硬约束）
    // ★ 2026-10-17：这里加的是**恢复出来的**打开集合（受控 openKeys），是「补齐到视图」
    //   而非用户此刻的打开意图 ⇒ 一律 `inactive`，让根面板（章节正文）保持焦点。
    //   否则冷启动会落在最后加入的功能面板上（e2e-core-flows 第 5 节连红即此事）。
    //   （`wanted` 只含业务 key，恒不等于中心面板 id，故根面板不在其中、焦点归它。）
    for (const step of buildLayoutSteps(plan, CENTER_DEFAULT_PANEL_ID)) {
      const { spec, isRoot } = step;
      // planDockAreas 里已剔除 center 默认面板，但保险起见仍跳过根 id
      if (spec.id === CENTER_DEFAULT_PANEL_ID) continue;
      dock.addPanel({
        ...(isRoot ? { ...spec, position: undefined } : spec),
        inactive: true,
      });
    }

    // 聚焦事件 → 上报 activeKey（§2.4 activePanel）
    dock.onDidActivePanelChange((e) => {
      const panel = e.panel;
      const key = panel ? keyOfPanel(panel) : null;
      setActiveKey(key);
      propsRef.current.onActiveChange?.(key);
    });

    // 能力 2/4：拖拽守卫 —— `floatable:false` 的面板不允许被拖出为悬浮 / 拖走
    dock.onWillDragPanel((e: TabDragEvent) => {
      const key = keyOfPanel(e.panel);
      const def = key ? defByKeyRef.current.get(key) : undefined;
      if (def && !resolveDockMeta(def).floatable) e.nativeEvent.preventDefault();
    });

    // 打开/关闭集合变化 → 上报（§2.4 listPanels）
    dock.onDidRemovePanel(() => emitOpenChange(dock));
    dock.onDidAddPanel(() => emitOpenChange(dock));

    setReady(true);
  }, []);

  // ---- 路由切换：程序化更新根面板承载的 centerDefault ----
  // ★ 2026-10-11 单列布局：不再有「center 面板抢占中心替换槽」——所有面板都以标签
  //   形式堆在中心组里，根面板恒为章节编辑器出口。故此处只剩「更新参数」。
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    const centerPanel = api.getPanel(CENTER_DEFAULT_PANEL_ID);
    if (!centerPanel) return;
    centerPanel.api.updateParameters({ centerDefault });
  }, [centerDefault, ready]);

  // ---- 能力 1：外部受控打开集合 → 同步到 dockview（单列：全部面板进中心组） ----
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    if (!openKeys) return; // 非受控模式：由 api 自管

    // ★ 2026-10-11：基础标签（中心默认面板）也受控 —— baseOpen=false 时把它隐藏
    //   （用户关掉了「章节正文」标签），true 时恢复显示。用 dockview 面板的
    //   `api.setVisible()`：面板仍留在中心组（**不拆组**），只是不可见。
    //   （实测：`removePanel` + 重新 `addPanel` 会把多面板的组拆成两个 —— 即用户说的
    //    「叠加」；`setVisible` 不触碰网格结构，全程 groups 恒为 1。）
    //
    //   ⚠️ 类型：`DockviewPanelApi` 接口**故意** `Omit<GridviewPanelApi, 'setVisible'>`
    //      （panelApi.d.ts:24），但运行时 `DockviewPanelApiImpl` 继承自 `GridviewPanelApiImpl`
    //      且 `PanelApiImpl` 暴露 `isVisible`（panelApi.d.ts:23-24/97-98）—— `setVisible`
    //      经 `onWillVisibilityChange` 事件驱动 accessor，是 dockview 的**受支持行为**
    //      （内部多处 `api.setVisible(...)`）。故这里用最小断言访问它。
    //   缺省（undefined）视为开启，兼容旧调用方。
    const baseShouldOpen = baseOpen !== false;
    const centerPanel = api.getPanel(CENTER_DEFAULT_PANEL_ID);
    if (centerPanel && centerPanel.api.isVisible !== baseShouldOpen) {
      (centerPanel.api as unknown as { setVisible(isVisible: boolean): void }).setVisible(baseShouldOpen);
    }

    const wanted = new Set(openKeys);

    // 关闭：已存在但不在 wanted 里的面板（中心默认面板恒在，`keyOfPanel` 返回 null 会跳过）。
    for (const p of [...api.panels]) {
      const key = keyOfPanel(p);
      if (key === null) continue;
      if (!wanted.has(key)) api.removePanel(p);
    }

    // 打开：wanted 里缺失的，一律作为**中心组**的标签堆叠（`buildAddSpec(def, 'center')`
    // ⇒ direction 'within'，落进 CENTER_DEFAULT_PANEL_ID 所在的组）。
    // ★ t4（集成接线）：deps 必须包含 `defByKey` —— 插件面板是**异步注册**的。首屏播种
    //   时 `openKeys` 里可能已有某 key，但它的 def 还没进候选池（模块仍在加载），
    //   上面的循环 `if (!def) continue` 会跳过；若 deps 只有 `[openKeys, ready]`，
    //   def 到达后 openKeys 未变化 ⇒ 该面板**永久不会被打开**（冷启动实测左栏缺席）。
    //
    // ★ 2026-10-17：本路径一律 `inactive` —— 它只承担「把 store 的打开集合**补齐到视图**」
    //   （恢复上次集合 / 播默认种子 / def 迟到补加），**不是用户此刻的打开意图**。
    //   若照缺省「新加面板即激活」，开项目时最后被补齐的功能面板会顶掉基础标签
    //   「章节正文」的焦点 ⇒ 冷启动首屏落在 AI 对话、空态建章输入框不可达
    //   （e2e-core-flows 第 5 节 9 项连红即此事）。用户主动打开走 `openPanel()`（不传）。
    for (const key of openKeys) {
      const def = defByKeyRef.current.get(key);
      if (!def) continue;
      if (api.getPanel(panelInstanceId(key))) continue;
      api.addPanel(buildAddSpec(def, true));
    }
    // ★ 2026-10-11：deps 必须含 `baseOpen` —— 关/开基础标签（章节正文）时本 effect
    //   要把中心默认面板 `setVisible()` 同步过去；只依赖 openKeys 则它不会重跑。
  }, [openKeys, baseOpen, ready, defByKey]);

  // ---- ★ 单列布局：隐藏**所有** dockview 组头 ---------------------------------
  //
  // ★ 2026-10-11（用户口径「点击那些功能需要显示在正页」）：布局收敛为单列后，所有
  //   面板都在**同一个中心组**里以标签堆叠，dockview 原生组头（含原生标签）已无意义 ——
  //   文档标签栏改为 `.dock-main` 顶部的整宽一条（`.dock-docbar`，见上方 JSX）。
  //   故这里把所有组的组头隐藏；隐藏后 `.dv-groupview` 的 flex 布局会把空间还给内容：
  //   `dockview.css:885-891 .dv-groupview{display:flex;flex-direction:column}`
  //   `dockview.css:895-899 .dv-groupview > .dv-content-container{flex-grow:1;min-height:0}`
  // 另需 `relayout()` 让组的 `_cachedHeaderSize` 失效并按新头高重排内容
  //   （`dockview-core.js:9989 set hidden` → `display:none`；
  //    `:11297-11299 relayout()` → `invalidateHeaderSize()` → `contentDimensions()` 读到 0）。
  //
  // 为什么不用 `hideHeader`：它只存在于 `CoreGroupOptions`
  // （`dockviewGroupPanelModel.d.ts:27-35`），**不在** `AddPanelOptions` 里
  // （`options.d.ts:741-775`，grep `hideHeader` = 0 命中），无法经 `addPanel` 传入。
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;

    const apply = () => {
      for (const group of api.groups) {
        const header = group.model.header;
        if (!header.hidden) {
          header.hidden = true;
          group.relayout();
        }
      }
    };

    // 订阅回调可能在 dockview 自身的一次布局过程中触发；延到微任务再改，避免重入。
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        apply();
      });
    };

    apply();
    const disposables = [
      api.onDidAddGroup(schedule),
      api.onDidRemoveGroup(schedule),
      api.onDidAddPanel(schedule),
      api.onDidRemovePanel(schedule),
    ];
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [ready, openKeys]);

  // ---- §2.4 DockShellApi：命令式控制句柄（t4 消费） ----
  const api: DockShellApi = useMemo(
    () => ({
      openPanel(key: string) {
        const a = apiRef.current;
        const def = defByKeyRef.current.get(key);
        if (!a || !def) return;
        // ★ §1.4 allowMultiple=false（缺省）⇒ 已存在只聚焦。
        const existing = a.getPanel(panelInstanceId(key));
        if (existing) {
          existing.api.setActive();
          return;
        }
        // ★ 2026-10-11 单列布局：一律作为**中心组**标签堆叠（不再有左右/底部槽）。
        a.addPanel(buildAddSpec(def));
      },
      closePanel(key: string) {
        const a = apiRef.current;
        if (!a) return;
        const p = a.getPanel(panelInstanceId(key));
        if (p) a.removePanel(p);
      },
      focusPanel(key: string) {
        const a = apiRef.current;
        if (!a) return;
        a.getPanel(panelInstanceId(key))?.api.setActive();
      },
      focusBase() {
        // 基础标签（章节正文）= 中心编辑区面板本身（不在 openKeys 里）。
        apiRef.current?.getPanel(CENTER_DEFAULT_PANEL_ID)?.api.setActive();
      },
      listPanels() {
        const a = apiRef.current;
        if (!a) return [];
        return a.panels.map((p) => keyOfPanel(p)).filter((k): k is string => k !== null);
      },
      activePanel() {
        return activeKey;
      },
      floatPanel(key: string) {
        const a = apiRef.current;
        if (!a) return;
        const p = a.getPanel(panelInstanceId(key));
        if (!p) return;
        const def = defByKeyRef.current.get(key);
        const meta = def ? resolveDockMeta(def) : null;
        // 能力 2：拖出为 floating group 的程序化等价物
        a.addFloatingGroup(p, {
          width: meta?.floatingSize.width,
          height: meta?.floatingSize.height,
        });
      },
      dockPanel(key: string, slot: DockAreaSlot) {
        const a = apiRef.current;
        if (!a) return;
        const p = a.getPanel(panelInstanceId(key));
        if (!p) return;
        // 能力 3：恢复停靠 = 用面板公开 API 把标签移到目标 dock area。
        // `position` 用 dockview 的 Position 字面量（'bottom' 而非 'below'）。
        p.api.moveTo({ position: slotToPosition(slot) });
      },
    }),
    [activeKey],
  );

  // §2.4：同时支持 `ref`（惯用）与 `apiRef`（ADR 冻结的 prop 名），两者都可拿到 DockShellApi。
  useImperativeHandle(ref, () => api, [api]);
  useImperativeHandle(props.apiRef ?? null, () => api, [api]);

  // ---- 外壳骨架：活动栏条目由**候选池**派生（不硬编码业务面板） ----
  const activityItems = useMemo(
    () =>
      panels.map((d) => ({
        key: d.key,
        label: d.label,
        icon: d.icon as unknown as React.ComponentType<{ size?: number }>,
      })),
    [panels],
  );

  /**
   * ★ 2026-10-07 用户口径（m01200）：活动栏按钮 = 该面板的开/关开关。
   *   已打开 ⇒ **收起**（不再只 `setActive()`）；未打开 ⇒ 打开。
   *
   *   面板实例 id 恒为 `nm-panel:<key>`（单列布局下不再有 `nm-center:<key>`）。
   *
   *   双向都会经 dockview 的 `onDidAddPanel` / `onDidRemovePanel` → `emitOpenChange`
   *   → 宿主 `onOpenChange`（= `_syncFromView`）回写 store，故 store 的 `keys`
   *   与视图始终一致，`aria-pressed` 与提示文案随之更新。
   *
   *   注：字段名沿用既有 `onActivitySelect`，仅语义从「打开或聚焦」收窄为「开关」。
   *   若日后要回到 VS Code 原生的「点未聚焦的已打开项 = 先聚焦、点当前聚焦项 = 收起」，
   *   把下面的分支改成 `if (p && key === activeKey) closePanel else if (p) setActive else openPanel` 即可。
   */
  const onActivitySelect = useCallback(
    (key: string) => {
      const a = apiRef.current;
      if (!a) return;
      const p = a.getPanel(panelInstanceId(key));
      if (p) {
        api.closePanel(key);
      } else {
        api.openPanel(key);
      }
    },
    [api],
  );

  return (
    // 能力 8：VS Code 式外壳骨架；.dv-theme-vscode 是 §5.5 冻结的 --dv-* → --vscode-* 映射层
    <div className="dock-shell dv-theme-vscode">
      {/* 活动栏（最左窄条）：条目由**候选池**派生，故图标集合 = 当前模式真实面板集合。
          `openKeys` 只用于按钮的开关态（aria-pressed / 提示文案）；受控缺席时为空集合。 */}
      <ActivityBar
        items={activityItems}
        activeKey={activeKey}
        openKeys={openKeys ?? []}
        onSelect={onActivitySelect}
      />

      {/* ★ 2026-10-11 单列布局：文档标签栏是 .dock-main 顶部**整宽**的一条（不再是
          dockview 组头里的 tabComponent —— 那样宽度会被标签挤窄）。它表达「打开了什么」：
          基础标签「章节正文」+ 每个已打开面板一张标签，× 关闭、+ 打开。 */}
      <div className="dock-docbar">
        <DocTabsHeader />
      </div>

      {/* 中心：dockview（单列 —— 全部面板以标签形式堆叠在中心组；组头由 CSS 隐藏） */}
      <main className="dock-main" aria-label="编辑区">
        {ready ? null : <div className="dock-booting">正在初始化停靠系统…</div>}
        <DockviewReact
          className="dockview-host"
          components={ALL_COMPONENTS as never}
          tabComponents={ALL_TAB_COMPONENTS as never}
          defaultTabComponent={DockTab as never}
          onReady={onReady}
          // 能力 5：主题层给出落点预览指示器（dndPanelOverlay/dndTabIndicator/边框）
          theme={VSCODE_DOCK_THEME}
          // 能力 2：悬浮组用 titlebar 作为拖动手柄，可再拖回停靠区
          disableFloatingGroups={false}
          floatingGroupDragHandle="titlebar"
          singleTabMode="fullwidth"
          noPanelsOverlay="watermark"
          watermarkComponent={DockWatermark}
        />
      </main>

      {/* 底部面板细条（t1 截图）：左端「底部面板」、右端「N 条问题 Ctrl+J」。
          常驻 DOM（原骨架即常驻，测试按该契约断言），展开高度由 CSS 控制，
          条数与展开内容由调用方注入（见 DockShellProps.bottomPanel）。 */}
      <section
        className="dock-bottom-area"
        data-open={bottomOpen ? 'true' : 'false'}
        aria-label="底部面板"
      >
        <div className="dock-bottom-bar">
          <button
            type="button"
            className="dock-bottom-toggle"
            onClick={() => setBottomOpen((v) => !v)}
            aria-expanded={bottomOpen}
            title={bottomOpen ? '收起底部面板（Ctrl+J）' : '展开底部面板（Ctrl+J）'}
          >
            {bottomOpen ? (
              <ChevronDown size={12} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} aria-hidden="true" />
            )}
            <span className="dock-bottom-title">底部面板</span>
          </button>
          <div className="dock-bottom-right">
            {/* ★ 插件注册的细条入口（如「快捷短语」）：计数 / 图标由注册者决定，
                点击即请求展开底部面板（收起仍走左端开关 / Ctrl+J）。 */}
            {bottomSections.map((section) => (
              <section.ThinEntry
                key={section.key}
                open={bottomOpen}
                onOpen={() => setBottomOpen(true)}
              />
            ))}
            <span className="dock-bottom-issues" title="当前章节未解决批注（问题清单）条数">
              {bottomPanel?.issueCount ?? 0} 条问题
            </span>
            <kbd className="dock-bottom-kbd">Ctrl+J</kbd>
          </div>
        </div>
        {bottomOpen ? (
          <div className="dock-bottom-body">
            {/* ★ 展开区多栏：先渲染插件注册的分区（各占一栏），再渲染调用方内容
                （问题清单）。注册者的组件必须同步可渲染 —— 见 bottomSections.tsx 头注。 */}
            {bottomSections.map((section) => (
              <div className="dock-bottom-section" data-section-key={section.key} key={section.key}>
                <div className="dock-bottom-section-title">
                  {section.icon ? <section.icon size={12} aria-hidden="true" /> : null}
                  <span>{section.label}</span>
                </div>
                <div className="dock-bottom-section-body">
                  <section.Component />
                </div>
              </div>
            ))}
            <div className="dock-bottom-section dock-bottom-section--main">
              {bottomPanel?.children}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
});

// ---- 工具 ---------------------------------------------------------------

/** 从 dockview 面板对象反解业务 key（中心默认面板返回 null）。 */
function keyOfPanel(p: IDockviewPanel): string | null {
  if (p.id === CENTER_DEFAULT_PANEL_ID) return null;
  return panelKeyFromInstanceId(p.id);
}

/** 构造作为**中心组标签**堆叠的 addPanel 规格（单列布局，见 layout.ts `planDockAreas`）。 */
/**
 * @param inactive 加入但**不抢焦点**（见 `DockPanelSpec.inactive`）。
 *   「恢复上次集合 / 播默认种子 / 补加迟到 def」这些非用户意图的加入一律传 `true`，
 *   以免把焦点从基础标签（章节正文）抢走；用户在视图层主动打开时传缺省 `false`。
 */
function buildAddSpec(def: DockPanelDef, inactive = false) {
  const meta = resolveDockMeta(def);
  const spec: DockPanelSpec = {
    id: panelInstanceId(def.key),
    component: DOCK_PANEL_COMPONENT_ID,
    title: def.label,
    params: { defKey: def.key, def },
    // 'within' ⇒ 与 CENTER_DEFAULT_PANEL_ID 同组（中心组），成为它的标签。
    position: { direction: 'within', referencePanel: CENTER_DEFAULT_PANEL_ID },
    minimumWidth: meta.minSize.width,
    minimumHeight: meta.minSize.height,
  };
  if (inactive) spec.inactive = true;
  return spec;
}

/** ADR 槽位名 → dockview `Position`（用于 `panel.api.moveTo`）。 */
function slotToPosition(slot: DockAreaSlot): 'left' | 'right' | 'bottom' {
  return slot;
}
