// ============================================================
// BubbleRail —— 功能看板的竖向气泡列（AI 写作模式）
//
// 设计见 docs/design/ui-tab-workspace-design.md §4。
// **位置：紧贴 AI 对话区右边**（2026-09-13 定；中途试过挪到最左当"活动栏"，作者要求放回 AI 右侧）。
//
// 与手写模式的「罗盘转轮」（FloatingBubbles）**不是一套东西**，两者互斥：
//   · 手写模式：罗盘 + 半圆扇，悬停开花，浮窗承载面板（保持原样，未改）
//   · AI 模式：竖直一列、点开即分页（本组件）
//
// 点击语义（IDE 语义）：
//   单击 = **预览**打开（斜体标签、单一预览槽、会被下一个预览顶掉；已是当前则收起组 2）
//   双击 = **固定**打开
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import type { WorkbenchPanel } from '../pipeline/workspaceDefs';

export interface PanelSignal {
  /** 右下角徽标：数字（≤99 直接显示，>99 显示 99+）／短文本（如流水线的「2/7」）／true（只显示一颗点） */
  badge?: number | string | true;
  /** 正在运转 → 外圈呼吸环 */
  running?: boolean;
}

interface BubbleRailProps {
  panels: WorkbenchPanel[];
  /** 已打开的看板 key（这些气泡高亮） */
  openKeys: string[];
  /** 当前激活的看板 key（与标签栏联动高亮） */
  activeKey: string | null;
  /** 预览标签 key（预览态的气泡描边更淡，提示"它会被下一个预览顶掉"） */
  previewKey?: string | null;
  signals?: Record<string, PanelSignal>;
  /** 单击：IDE 里等于在资源管理器里单击文件 —— 以**预览**方式打开 / 切过去 / 收起 */
  onToggle: (key: string) => void;
  /** 双击：**固定**打开（把预览标签晋级） */
  onPin: (key: string) => void;
}

const GROUP_LABEL: Record<WorkbenchPanel['group'], string> = {
  live: '写作中',
  data: '资料',
};

/**
 * 浮层避让标签栏。
 *
 * ★ 为什么需要它（2026-10-25 实测截图）：气泡列的顶边与编辑区标签栏齐平，
 *   第一颗气泡的中心只比标签栏底边高一点点 —— 按"垂直居中"算出来的浮层会
 *   **正好压在标签栏上**，把当前标签盖住（首屏最需要看清标签的时刻反而被挡住）。
 *
 * ★ 为什么不写死像素：气泡列可能被嵌在不同容器里，顶边位置不固定。
 *   改成运行时量「气泡列自己的顶边」+ 标签栏高度（30px，与 TabBar.tsx 一致）+ 半高 + 呼吸。
 */
const TABBAR_H = 30;
const TIP_GAP_X = 8;
const TIP_GAP_Y = 8;
const TIP_MAX_W = 208;
/** 浮层高度的估值（两行 11px / 1.6 行高 + 上下内边距 + 边框）。用于夹取，不求精确。 */
const TIP_EST_H = 52;

function fmtBadge(b: number | string | true): string {
  if (b === true) return '';
  if (typeof b === 'string') return b;
  return b > 99 ? '99+' : String(b);
}

/**
 * ★ 2026-10-26（用户口径「点开看板时闪一下加载，很影响体验」）：**意图预取**。
 *   悬停/聚焦气泡 = 用户意图已经出现、点击还没发生 —— 此刻就把该看板的 chunk 发出去，
 *   点开时命中模块缓存，不再先闪一下「加载中…」。每个 key 只发一次；失败一律静默。
 */
const warmedBubbles = new Set<string>();
function warmBubblePanel(panel: WorkbenchPanel): void {
  if (!panel.preload || warmedBubbles.has(panel.key)) return;
  warmedBubbles.add(panel.key);
  void panel.preload().catch(() => {});
}

function Bubble({
  panel, open, active, preview, signal, onClick, onDoubleClick, onHover,
}: {
  panel: WorkbenchPanel;
  open: boolean;
  active: boolean;
  preview: boolean;
  signal?: PanelSignal;
  onClick: () => void;
  onDoubleClick: () => void;
  /** 悬停/离开时把气泡自身的屏幕矩形交给外层（自绘浮层用；见文件头 NAV 注释） */
  onHover: (el: HTMLElement | null) => void;
}) {
  const Icon: LucideIcon = panel.icon;
  const title = `${panel.label} · ${GROUP_LABEL[panel.group]} —— `
    + (open
      ? (active ? '已打开并激活：单击收起侧编辑器组，双击固定' : '已打开：单击切换，双击固定')
      : '单击预览打开，双击固定打开');

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={(e) => { warmBubblePanel(panel); onHover(e.currentTarget); }}
      onMouseLeave={() => onHover(null)}
      onFocus={(e) => { warmBubblePanel(panel); onHover(e.currentTarget); }}
      onBlur={() => onHover(null)}
      aria-pressed={open}
      aria-label={`打开${panel.label}看板${open ? '（已打开）' : ''}`}
      // 原生 title 保留：屏幕阅读器与「悬停 1 秒」的用户仍能用。
      // 自绘浮层（下方 portal）只是把这两条语义提前到 0.15s，不替代它。
      title={title}
      data-bubble-key={panel.key}
      // ★ 2026-10-29 二轮（作者口径「要简洁一点，像 VS Code 这种」）：
      //   上一版把圆玻璃球改成了方钮，但**保留了这个「气泡列」结构本身** ——
      //   分组小标题、组分隔线、每颗的 1px 描边、运转时的呼吸环全都还在。
      //   作者要的不是"换成方的气泡"，是**别再有气泡这套**：
      //   VS Code 的活动栏就是一列图标，没有标题、没有分隔线、没有边框、没有动效。
      //   现在把三态收敛成：常规（无底）／悬停（浅底）／选中（浅底 + 左侧 2px 竖条），
      //   其余一律交给 CSS（见文件尾的 <style>）—— 因为 `:hover` 没法内联，
      //   只要底色还写在 style 里，hover 规则就永远压不过它。
      data-active={active ? 'true' : undefined}
      data-running={signal?.running ? 'true' : undefined}
      data-preview={preview ? 'true' : undefined}
      className="shrink-0 nm-panel-bubble"
    >
      <Icon size={14} aria-hidden="true" />

      {/* 实时徽标 */}
      {signal?.badge !== undefined && (
        <span
          className="absolute rounded-full text-[8px] leading-[13px] text-center"
          style={{
            right: -2,
            bottom: -2,
            minWidth: 13,
            height: 13,
            padding: signal.badge === true ? 0 : '0 var(--space-0)',
            width: signal.badge === true ? 13 : undefined,
            /**
             * ★ 2026-10-23（对比度修复）：原来「已打开」态用
             *   `hsl(var(--primary-foreground) / 0.28)` —— 那是**近白的 28% 半透明**，
             *   叠在同样偏亮的主色气泡上，白字压浅青底，实测对比度 **1.04:1**
             *   （数字基本看不见）。徽标本来就是要「一眼看到」的东西，底色必须压深。
             *   统一用深色药丸：两态都是深底浅字。
             * ★ 2026-10-29：底色从遗留别名 `--ink` 换成 `--foreground`；
             *   文字色不再写死 `#fff`（夜间档 `--foreground` 是**亮**色，
             *   配 `--card` 底才对；写死白在亮档下就是白字压深底、在夜间档
             *   仍是白字压浅底之外的另一种组合）——统一取 `--background`，
             *   它与 `--foreground` 恒为反色，两档都成立。
             */
            background: 'hsl(var(--foreground) / 0.86)',
            color: 'hsl(var(--background))',
            fontWeight: 500,
          }}
          aria-hidden="true"
        >
          {signal.badge === true ? '' : fmtBadge(signal.badge)}
        </span>
      )}

      {/* 悬停标签用原生 title（见下方 NAV 注释），这里不再自绘 */}
    </button>
  );
}

/** 自绘悬停浮层的定位结果（视口坐标）。放在 portal 里，故用 fixed。 */
interface TipState {
  panel: WorkbenchPanel;
  open: boolean;
  top: number;
  left: number;
}

export function BubbleRail({
  panels, openKeys, activeKey, previewKey, signals, onToggle, onPin,
}: BubbleRailProps) {
  // 单击 / 双击共存：单击延迟 220ms 执行，期间若来第二次点击就取消（交给双击 = 固定）
  const pendingRef = useRef<{ key: string; timer: number } | null>(null);

  /**
   * 悬停提示（U5）。
   *
   * ★ 为什么必须用 portal：这一列自己带 `overflow-y: auto`。CSS 里一个轴设成 auto，
   *   另一个轴的 visible 会被强制成 auto —— 绝对定位的浮层会被整列**裁掉**
   *   （2026-09-13 当时就是因此放弃自绘、退回原生 title，而原生 title 要悬停 ~1s，
   *   触屏与键盘下根本不存在）。所以浮层挂到 body，用 fixed + 自己算坐标。
   *
   * ★ 为什么还要保留原生 title：屏幕阅读器与"悬停 1 秒"的用户仍能用；
   *   自绘浮层只是把**第一次使用**需要的两条语义提前到 0 延迟。
   */
  const [tip, setTip] = useState<TipState | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const tipTimerRef = useRef<number | null>(null);
  const clearTipTimer = () => {
    if (tipTimerRef.current != null) { window.clearTimeout(tipTimerRef.current); tipTimerRef.current = null; }
  };
  useEffect(() => clearTipTimer, []);

  const showTip = useCallback((panel: WorkbenchPanel, open: boolean, el: HTMLElement | null) => {
    clearTipTimer();
    if (!el) { setTip(null); return; }
    // 150ms 延迟：横扫过整列时不会一路闪；停在某颗上则几乎立刻出现。
    tipTimerRef.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      // 默认贴气泡右侧；右边放不下就翻到左侧（窄屏 / AI 栏贴右时）
      const wantLeft = r.right + TIP_GAP_X;
      const left = wantLeft + TIP_MAX_W <= window.innerWidth - TIP_GAP_X
        ? wantLeft
        : Math.max(TIP_GAP_X, r.left - TIP_MAX_W - TIP_GAP_X);

      // 垂直：先按气泡中心，再夹进「不压标签栏 / 不出视口」的可用区间。
      // 可用区间 = [列顶 + 标签栏高 + 半高 + 呼吸, 视口底 - 半高 - 呼吸]
      const railTop = navRef.current ? navRef.current.getBoundingClientRect().top : 0;
      const minCenter = railTop + TABBAR_H + TIP_EST_H / 2 + TIP_GAP_Y;
      const maxCenter = window.innerHeight - TIP_EST_H / 2 - TIP_GAP_Y;
      const centerY = Math.round(Math.min(maxCenter, Math.max(minCenter, r.top + r.height / 2)));

      setTip({ panel, open, top: centerY, left: Math.round(left) });
    }, 150);
  }, []);

  const handleSingle = useCallback((key: string) => {
    // 上一颗气泡的单击还没落地就又点了别的：先把它执行掉，别丢点击
    if (pendingRef.current) {
      window.clearTimeout(pendingRef.current.timer);
      const prev = pendingRef.current.key;
      pendingRef.current = null;
      onToggle(prev);
    }
    const timer = window.setTimeout(() => {
      pendingRef.current = null;
      onToggle(key);
    }, 220);
    pendingRef.current = { key, timer };
  }, [onToggle]);

  const handleDouble = useCallback((key: string) => {
    if (pendingRef.current) {
      window.clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
    }
    onPin(key);
  }, [onPin]);

  // 卸载时清掉未落地的定时器
  useEffect(() => () => {
    if (pendingRef.current) window.clearTimeout(pendingRef.current.timer);
  }, []);

  if (panels.length === 0) return null;

  return (
    <nav
      ref={navRef}
      aria-label="功能看板气泡列"
      className="shrink-0 flex flex-col items-center overflow-y-auto relative z-20 nm-panel-rail"
      style={{
        // 48px：与手写台竖栏（52px）同一量级，装得下 34px 的图标钮 + 两侧 7px 呼吸。
        // 条目之间**不留 gap**（原来是 14px）—— VS Code 的图标是连续排下来的，
        // 留大空隙会把一列读成"散落的几颗"，这正是"气泡感"的来源之一。
        width: 48,
        // 底色与右缘发丝线保留：竖栏两侧分别是对话栏（`--card`）与正文
        //（`--background`），没有这条线就分不出"这是一条栏"。
        // ★ 2026-10-29 二轮：底色由 `--muted / 0.4` 改成**实底 `--muted`**。
        //   那个 0.4 透明度叠在近白正文上约等于 #fbfbfb，与两侧几乎同色 ——
        //   原来靠分组标题和描边还能看出"这是一条栏"，二轮把标题去掉之后，
        //   半透明底就彻底消失了，图标像浮在空气里。实底才立得住。
        background: 'hsl(var(--muted))',
        borderRight: '1px solid hsl(var(--border))',
        padding: 'var(--space-2) 0',
        gap: 2,
      }}
    >
      {/* ★ 2026-10-29 二轮：**去掉全部装饰**，只留图标。
          删掉的是：两个分组小标题（「写作中 / 资料」）、它们之间那条 1px 分隔线、
          以及按 group 分段的双层 map —— 现在就是一列平铺的图标，
          顺序 = 面板注册顺序。VS Code 的活动栏没有这些小标题，
          分组信息仍然保留在悬停浮层里（「流水线 · 写作中」），需要时看得到。 */}
      {panels.map((p) => (
        <Bubble
          key={p.key}
          panel={p}
          open={openKeys.includes(p.key)}
          active={activeKey === p.key}
          preview={previewKey === p.key}
          signal={signals?.[p.key]}
          onClick={() => handleSingle(p.key)}
          onDoubleClick={() => handleDouble(p.key)}
          onHover={(el) => showTip(p, openKeys.includes(p.key), el)}
        />
      ))}

      <style>{`
        /* ★ 类名一律用 nm-panel-* 前缀：项目 globals.css 里已经有 .nm-bubble / .nm-bubble-core
           那套**环境气泡效果**的全局样式（带 position:absolute），撞名会让气泡全部叠在一处
           （实测：三个气泡坐标完全一致、点不中）。 */

        /* ── 图标钮（2026-10-29 二轮：VS Code 活动栏式，只有三态） ──
           底色/颜色必须写在这里、而不是 JSX 的 inline style：
           inline style 优先级高于任何选择器（与特异性无关），
           只要默认色写在 style 里，hover 规则就永远盖不过它。
           ⚠ 本段在 JS 模板字符串里 —— 注释中**不能出现反引号**，
             否则会提前终止模板串（实测：写完这行就整段 TS 报 "}' expected"）。 */
        .nm-panel-bubble {
          position: relative;
          display: flex; align-items: center; justify-content: center;
          width: 34px; height: 30px;
          border: 0; border-radius: 6px;
          background-color: transparent;
          color: hsl(var(--muted-foreground));
          cursor: pointer;
          transition: background-color 0.12s ease, color 0.12s ease;
        }
        /* 悬停/选中的底色用**前景色的低透明度叠加**，而不是 muted：
           竖栏自己的底色就是 muted（见 nav 的 inline style），
           再拿 muted 当悬停底等于没有反馈（实测两者同色）。
           前景色叠加在任何底色上都成立，且深浅两档自动反向。
           ⚠ 同上：模板串内的注释不能出现反引号。 */
        .nm-panel-bubble:hover {
          background-color: hsl(var(--foreground) / 0.07);
          color: hsl(var(--foreground));
        }
        /* 运转中：**静**的主色图标（原来是外圈呼吸环 + 1.8s 无限动画）。
           作者要的是简洁 —— 一屏里一个永动的环是最扎眼的东西；
           状态仍然看得见（图标转主色），只是不再动。 */
        .nm-panel-bubble[data-running] {
          color: hsl(var(--primary));
        }
        /* 选中：底 + 左侧 2px 竖条（VS Code 活动栏的选中语言） */
        .nm-panel-bubble[data-active] {
          background-color: hsl(var(--foreground) / 0.09);
          color: hsl(var(--primary));
        }
        .nm-panel-bubble[data-active]::before {
          content: '';
          position: absolute;
          left: -7px; top: 5px; bottom: 5px; width: 2px;
          border-radius: 0 2px 2px 0;
          background-color: hsl(var(--primary));
        }
        /* 预览（单击打开、会被下一个顶掉）：图标压暗一档。
           原来靠"虚描边"表达，而 VS Code 式的图标钮已经不画边框了 ——
           压暗是唯一不引入新装饰的做法（悬停浮层里也写着"单击预览"）。 */
        .nm-panel-bubble[data-preview] {
          opacity: 0.72;
        }
        .nm-panel-bubble[data-preview]:hover {
          opacity: 1;
        }
        .nm-panel-bubble:focus-visible {
          outline: 2px solid hsl(var(--ring));
          outline-offset: 1px;
        }
        /* 悬停浮层：挂 body（portal），fixed 定位，故不受本列 overflow 裁剪。 */
        .nm-panel-tip {
          position: fixed; z-index: 60; pointer-events: none;
          min-width: 150px; max-width: 208px;
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control, 8px);
          background: var(--vscode-editorWidget-background, hsl(var(--card)));
          color: var(--vscode-editorWidget-foreground, hsl(var(--foreground)));
          border: 1px solid var(--vscode-editorWidget-border, hsl(var(--border)));
          box-shadow: 0 4px 16px hsl(var(--foreground) / 0.16);
          font-size: 11px; line-height: 1.6;
          transform: translateY(-50%);
        }
        .nm-panel-tip-title {
          display: flex; align-items: center; gap: var(--space-1);
          font-size: 12px; color: hsl(var(--foreground));
        }
        .nm-panel-tip-group {
          font-size: 10px; letter-spacing: 0.04em;
          color: hsl(var(--muted-foreground));
        }
        .nm-panel-tip-hint { color: hsl(var(--muted-foreground)); }
        .nm-panel-tip-hint b { font-weight: 500; color: hsl(var(--foreground)); }
      `}</style>

      {/* 悬停浮层：把「单击预览 / 双击固定」这两条一次性的知识，提前到首次使用。 */}
      {tip && createPortal(
        <div className="nm-panel-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
          <div className="nm-panel-tip-title">
            <tip.panel.icon size={12} aria-hidden="true" />
            {tip.panel.label}
            <span className="nm-panel-tip-group">{GROUP_LABEL[tip.panel.group]}</span>
          </div>
          <div className="nm-panel-tip-hint">
            {tip.open
              ? <>单击 <b>切换</b> · 双击 <b>固定</b></>
              : <>单击 <b>预览</b> · 双击 <b>固定</b></>}
          </div>
        </div>,
        document.body,
      )}
    </nav>
  );
}
