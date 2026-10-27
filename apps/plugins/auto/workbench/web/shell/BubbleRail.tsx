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
      data-preview={preview ? 'true' : undefined}
      className="group relative shrink-0 flex items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 active:scale-95 nm-panel-bubble"
      style={{
        width: 30,
        height: 30,
        // 与既有气泡一致：玻璃底 + 细高光边（不写死色值，换肤跟着变）
        background: open
          ? 'linear-gradient(160deg, hsl(var(--primary)), hsl(var(--primary) / 0.8))'
          : 'radial-gradient(circle at 30% 26%, rgb(255 255 255 / 0.92), rgb(var(--glass-tint) / 0.35) 60%)',
        // ★ 用长写属性（borderWidth/Style/Color），不要和 `border` 简写混用 ——
        //   React 会警告 "mixing shorthand and non-shorthand properties"，且样式可能被覆盖
        borderWidth: 1,
        // 预览态：虚线描边（IDE 里预览标签是斜体，这里再加一层"临时"的视觉）
        borderStyle: open && preview ? 'dashed' : 'solid',
        borderColor: open ? 'hsl(var(--primary))' : 'rgb(255 255 255 / 0.6)',
        boxShadow: '0 2px 10px hsl(var(--foreground) / 0.12), inset 0 1px 3px rgb(255 255 255 / 0.6)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        color: open ? 'hsl(var(--primary-foreground))' : 'hsl(var(--ink) / 0.7)',
        cursor: 'pointer',
      }}
    >
      <Icon size={13} aria-hidden="true" />

      {/* 运转中：呼吸环（prefers-reduced-motion 时动画在 CSS 里被关掉） */}
      {signal?.running && (
        <span className="nm-panel-bubble-running" aria-hidden="true" />
      )}

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
             *   叠在同样偏亮的主色渐变气泡上，白字压浅青底，实测对比度 **1.04:1**
             *   （数字基本看不见）。徽标本来就是要「一眼看到」的东西，底色必须压深。
             *   统一用墨色药丸：关闭态（白玻璃气泡）与打开态（主色气泡）都是深底白字，
             *   实测两态都在 9:1 以上。
             */
            background: 'hsl(var(--ink) / 0.82)',
            color: '#fff',
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
  const groups: Array<WorkbenchPanel['group']> = ['live', 'data'];

  return (
    <nav
      ref={navRef}
      aria-label="功能看板气泡列"
      className="shrink-0 flex flex-col items-center overflow-y-auto relative z-20 nm-panel-rail"
      style={{ width: 44, padding: 'var(--space-4) 0', gap: 'var(--space-4)' }}
    >
      {groups.map((g, gi) => {
        const list = panels.filter((p) => p.group === g);
        if (list.length === 0) return null;
        return (
          <div key={g} className="contents">
            {gi > 0 && (
              <span
                aria-hidden="true"
                className="shrink-0"
                style={{ width: 16, height: 1, background: 'hsl(var(--border))', margin: 'var(--space-0) 0' }}
              />
            )}
            {list.map((p) => (
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
          </div>
        );
      })}

      <style>{`
        /* ★ 类名一律用 nm-panel-* 前缀：项目 globals.css 里已经有 .nm-bubble / .nm-bubble-core
           那套**环境气泡效果**的全局样式（带 position:absolute），撞名会让气泡全部叠在一处
           （实测：三个气泡坐标完全一致、点不中）。 */
        .nm-panel-bubble-running {
          position: absolute; inset: -2.5px; border-radius: 50%;
          border: 1.5px solid hsl(var(--state-running, 40 70% 40%));
          animation: nm-panel-bubble-breathe 1.8s ease-in-out infinite;
          pointer-events: none;
        }
        @keyframes nm-panel-bubble-breathe {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.16); opacity: 0.12; }
        }
        @media (prefers-reduced-motion: reduce) {
          .nm-panel-bubble-running { animation: none; opacity: 0.45; }
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
