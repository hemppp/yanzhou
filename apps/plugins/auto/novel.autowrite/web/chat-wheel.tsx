// ============================================================
// 转轮选择器 —— AI 对话浮窗功能气泡的转轮形态（chatRail 接管组件）
//
// ★ 待机 = 一颗主气泡；鼠标悬停 → 花开式旋转展开：卫星气泡整体沿弧线
//   旋入到位（层旋转 -100°→0° + 弹性缓动），移开 280ms 后自动收拢。
//   空间自适应：半径/弹层宽度按剩余空间伸缩，贴边时整轮翻到另一侧。
//   触屏/键盘兜底：中心按钮点击仍可切换展开。
// 与 AI 对话的交互契约同 AiChatBubbleRail：事件桥 nm-chat:skill / nm-chat:pick-prompt。
//
// ★ TODO（2026-10-14 清理批 E）：本文件已是**孤儿组件** —— chatRail 注册已随清理批
//   C3 删除（同一原因）。模块内保留以备 chatRail 定生死；若确认停产，本文件与
//   workbench 的 `web/discuss/AiChatBubbleRail.tsx` 一并删除。
// ============================================================

import React from 'react';
import { PenLine, Wrench, Bot, Zap, MessageCircle, Sparkles, X, type LucideIcon } from 'lucide-react';
// ★ D46：改经 **恒在的 shared 包** 引用（原 `@/components/ai/ChatPanel` 垫片已删；
//   其后一度改经 auto 模块公开入口 `@novel-plugins/auto-workbench/web`，但移走 auto 模块
//   即 `[vite:load-fallback] ENOENT` ⇒ 可分离性不成立）。
//   展示层：@novel-plugins/ui-kit（严格叶子，不依赖 kernel / auto）；
//   技能数据：@novel-plugins/data-core 连接层（与 auto 模块共用同一注册表实例）。
import { SkillsBar, QuickPromptsBar } from '@novel-plugins/ui-kit';
import { useSkillBarProps } from '@novel-plugins/data-core';
import type { ChatRailProps } from '@/plugin/types';

interface WheelItem {
  key: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}

/** 转轮气泡（视觉与 AiChatBubbleRail 的 RailBubble 同源；透明度随层动画错峰） */
function WheelBubble({
  icon: Icon, label, active, onClick, side, style, delay,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
  side: 'left' | 'right';
  style: React.CSSProperties;
  delay: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className="group absolute left-1/2 top-1/2 flex h-10 w-10 items-center justify-center rounded-full transition-opacity duration-300 ease-out hover:scale-110 active:scale-95"
      style={{
        ...style,
        transitionDelay: `${delay}ms`,
        background: active
          ? 'linear-gradient(160deg, hsl(var(--primary)), hsl(var(--primary) / 0.75))'
          : 'radial-gradient(circle at 30% 26%, rgb(255 255 255 / 0.9), rgb(var(--glass-tint) / 0.35) 55%)',
        border: `1px solid ${active ? 'hsl(var(--primary))' : 'rgb(255 255 255 / 0.6)'}`,
        boxShadow: active
          ? '0 4px 16px hsl(var(--primary) / 0.4), inset 0 1px 4px rgb(255 255 255 / 0.5)'
          : '0 3px 12px hsl(var(--foreground) / 0.14), inset 0 1px 4px rgb(255 255 255 / 0.7)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        color: active ? 'hsl(var(--primary-foreground))' : 'hsl(var(--ink) / 0.7)',
      }}
    >
      <Icon size={16} aria-hidden="true" />
      <span
        className={`absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] px-2 py-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none ${side === 'left' ? 'left-full ml-2' : 'right-full mr-2'}`}
        style={{
          color: 'hsl(var(--ink))',
          background: 'rgb(var(--glass-tint) / 0.85)',
          backdropFilter: 'blur(8px)',
        }}
      >
        {label}
      </span>
    </button>
  );
}

export function ChatWheelRail({
  syncInsert, enableTools, enableAgent, activeSkillId,
  onToggleSync, onToggleTools, onToggleAgent, onSkillChange,
}: ChatRailProps) {
  const [open, setOpen] = React.useState(false);
  const [flyout, setFlyout] = React.useState<null | 'skills' | 'prompts'>(null);
  const [side, setSide] = React.useState<'left' | 'right'>('left');
  const [radius, setRadius] = React.useState(92);
  const [flyoutWidth, setFlyoutWidth] = React.useState(320);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const closeTimer = React.useRef<number | null>(null);
  // ★ D46：纯展示层不碰 store —— 技能列表/激活技能/加载态由 data-core 连接层组装
  const skillBarProps = useSkillBarProps(activeSkillId);
  // ★ D46：本插件包**不依赖 react-router-dom** —— 「添加技能」经 kernel 事件桥导航
  //   （监听方：apps/web/src/components/shell/ProjectLayout.tsx）
  const openSettings = React.useCallback(() => {
    window.dispatchEvent(new Event('nm:open-settings'));
  }, []);

  // 空间感知：翻边方向 + 半径 + 弹层宽度（offsetParent = 浮窗根）
  const measure = React.useCallback(() => {
    const host = rootRef.current?.offsetParent as HTMLElement | null;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const leftRoom = rect.left;
    const rightRoom = window.innerWidth - rect.right;
    const next: 'left' | 'right' = rightRoom > leftRoom ? 'right' : 'left';
    setSide(next);
    const room = Math.max(next === 'left' ? leftRoom : rightRoom, 180);
    setRadius(Math.max(64, Math.min(96, room - 56)));
    setFlyoutWidth(Math.max(240, Math.min(320, Math.floor(room) - 72)));
  }, []);

  React.useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    // 拖拽浮窗结束（pointerup）时重算；悬停展开状态下不重算半径以免跳动
    const onUp = () => { if (!open) measure(); };
    window.addEventListener('resize', measure);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('pointerup', onUp);
    };
  }, [measure, open]);

  // 悬停开花：进入展开，离开延迟收拢（给跨缝隙移动留缓冲）；有弹层开着时不自动收
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  React.useEffect(() => {
    if (flyout !== null) cancelClose();
  }, [flyout]);
  React.useEffect(() => () => cancelClose(), []);

  const handleEnter = () => {
    cancelClose();
    setOpen(true);
  };
  const handleLeave = () => {
    if (flyout !== null) return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 280);
  };

  const toggleWheel = () => {
    setOpen((v) => {
      if (v) setFlyout(null);
      return !v;
    });
  };

  const emitSkill = (id: string | null) => {
    onSkillChange(id);
    window.dispatchEvent(new CustomEvent('nm-chat:skill', { detail: id }));
    setFlyout(null);
  };
  const emitPrompt = (text: string) => {
    window.dispatchEvent(new CustomEvent('nm-chat:pick-prompt', { detail: text }));
    setFlyout(null);
  };

  const items: WheelItem[] = [
    { key: 'sync', icon: PenLine, label: syncInsert ? '同步写入：开' : '同步写入：关', active: syncInsert, onClick: onToggleSync },
    {
      key: 'tools', icon: Wrench,
      label: enableTools ? '工具调用：开' : '工具调用：关', active: enableTools, onClick: onToggleTools,
    },
    {
      key: 'agent', icon: Bot,
      label: enableAgent ? 'Agent 模式：开' : 'Agent 模式：关', active: enableAgent, onClick: onToggleAgent,
    },
    {
      key: 'skills', icon: Zap,
      label: activeSkillId ? '技能（已激活）' : '选择技能',
      active: activeSkillId !== null || flyout === 'skills',
      onClick: () => setFlyout((f) => (f === 'skills' ? null : 'skills')),
    },
    {
      key: 'prompts', icon: MessageCircle, label: '快捷语', active: flyout === 'prompts',
      onClick: () => setFlyout((f) => (f === 'prompts' ? null : 'prompts')),
    },
  ];

  // 扇形排布：以「朝外方向」为 0°，±70° 均分；dir 把弧线镜像到朝外一侧
  const n = items.length;
  const spread = 140;
  const dir = side === 'left' ? -1 : 1;

  const flyoutAnchor = side === 'left' ? { right: 'calc(100% + 16px)' } : { left: 'calc(100% + 16px)' };

  return (
    <div
      ref={rootRef}
      className="absolute top-4 z-20 h-10 w-10"
      style={{ [side === 'left' ? 'left' : 'right']: '-56px' } as React.CSSProperties}
      role="toolbar"
      aria-label="AI 对话功能转轮"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {/* 悬停感应垫：展开时罩住整个轮盘区域，跨缝隙移动不掉线 */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: open ? (radius + 44) * 2 : 56,
          height: open ? (radius + 44) * 2 : 56,
          pointerEvents: 'auto',
        }}
        aria-hidden="true"
      />

      {/* 花开旋转层：关闭时整体旋 -100° 缩 0.25，展开旋正——卫星沿弧线旋入 */}
      <div
        className="absolute inset-0"
        style={{
          transform: open
            ? 'rotate(0deg) scale(1)'
            : `rotate(${side === 'left' ? -100 : 100}deg) scale(0.25)`,
          transformOrigin: '50% 50%',
          transition: 'transform 560ms cubic-bezier(0.34, 1.56, 0.64, 1)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {items.map((it, i) => {
          const deg = -spread / 2 + (spread * i) / (n - 1);
          const rad = (deg * Math.PI) / 180;
          const x = dir * Math.cos(rad) * radius;
          const y = Math.sin(rad) * radius;
          return (
            <WheelBubble
              key={it.key}
              icon={it.icon}
              label={it.label}
              active={it.active}
              onClick={it.onClick}
              side={side}
              delay={open ? i * 40 : 0}
              style={{
                transform: `translate(calc(-50% + ${Math.round(x)}px), calc(-50% + ${Math.round(y)}px))`,
                opacity: open ? 1 : 0,
              }}
            />
          );
        })}
      </div>

      {/* 中心主按钮（悬停开花 + 点击兜底切换） */}
      <button
        type="button"
        onClick={toggleWheel}
        aria-label={open ? '收起功能转轮' : '展开功能转轮'}
        aria-expanded={open}
        title={open ? '收起功能转轮' : '展开功能转轮'}
        className="absolute left-1/2 top-1/2 z-10 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-all duration-300 hover:scale-110 active:scale-95"
        style={{
          background: 'linear-gradient(160deg, hsl(var(--primary) / 0.92), hsl(var(--primary) / 0.6))',
          border: '1px solid hsl(var(--primary))',
          boxShadow: open
            ? '0 8px 28px hsl(var(--primary) / 0.55), inset 0 1px 4px rgb(255 255 255 / 0.5)'
            : '0 4px 16px hsl(var(--primary) / 0.35), inset 0 1px 4px rgb(255 255 255 / 0.5)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          color: 'hsl(var(--primary-foreground))',
          transform: open
            ? 'translate(-50%, -50%) rotate(90deg) scale(1.08)'
            : 'translate(-50%, -50%) rotate(0deg)',
        }}
      >
        <Sparkles size={17} aria-hidden="true" />
      </button>

      {/* 技能网格弹层 */}
      {flyout === 'skills' && (
        <div
          className="absolute top-0 max-h-[65vh] overflow-y-auto p-3 rounded-2xl space-y-2 nm-glass-frost"
          style={{ ...flyoutAnchor, width: flyoutWidth, border: '1px solid hsl(var(--border) / 0.5)' }}
          role="dialog"
          aria-label="选择技能"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">技能 · 选中后生效</span>
            <button
              type="button"
              onClick={() => setFlyout(null)}
              className="nm-btn-apple-icon-sm"
              aria-label="关闭技能选择"
              title="关闭"
            >
              <X size={12} />
            </button>
          </div>
          <SkillsBar
            {...skillBarProps}
            embedded
            onActivate={(id) => emitSkill(id)}
            onCancel={() => emitSkill(null)}
            disabled={false}
            onOpenSettings={openSettings}
          />
        </div>
      )}

      {/* 快捷语弹层（沿用居中气泡场形态） */}
      {flyout === 'prompts' && (
        <div
          className="fixed left-1/2 top-1/2 z-30 w-[380px] -translate-x-1/2 -translate-y-1/2 p-4 rounded-2xl nm-glass-frost"
          style={{ border: '1px solid hsl(var(--border) / 0.5)' }}
          role="dialog"
          aria-label="快捷语"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">快捷语 · 点击填入</span>
            <button
              type="button"
              onClick={() => setFlyout(null)}
              className="nm-btn-apple-icon-sm"
              aria-label="关闭快捷语"
              title="关闭"
            >
              <X size={12} />
            </button>
          </div>
          <QuickPromptsBar variant="bubbles" embedded onPick={emitPrompt} disabled={false} />
        </div>
      )}
    </div>
  );
}
