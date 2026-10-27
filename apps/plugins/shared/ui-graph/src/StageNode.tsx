import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

// ============================================================
// StageNode —— 「阶段」节点（流程 / 图谱里的长方形节点）
//
// 与 BubbleNode（圆形纯色球，用于实体关系）分工：
//   BubbleNode  实体（角色 / 物品 / 地点 / 记忆）—— 面积表达"分量"
//   StageNode   流程阶段（讨论 / 世界观 / 意图门…）—— 矩形表达"先后"
//
// 为什么单独一个节点类型：阶段有**状态**（待开始 / 进行中 / 等确认 / 已定稿 / 失败），
// 还有闸门、过期、打回次数三个徽标 —— 这些语义在圆球上表达不出来。
//
// 水墨化：配色一律走语义变量（`--state-*` / `--primary` / `--ink*`），
// 不写死色值 —— 否则换肤时这里不跟着变（当天在 BookCover 上踩过这个坑）。
// ============================================================

export type StageVisualStatus =
  | 'idle'
  | 'running'
  | 'awaiting_user'
  | 'approved'
  | 'failed'
  | 'done'
  | 'blocked';

export interface StageNodeData {
  /** 阶段名（图上显示的主文字） */
  label: string;
  /** 副文字：状态文案 / 产出物名 / 一句说明 */
  sub?: string;
  status: StageVisualStatus;
  /** 游标停在这一段（画墨圈强调） */
  isCurrent?: boolean;
  /** 有用户闸门（显 ◈ 徽标） */
  gated?: boolean;
  /** 基线变了、已定稿的阶段过期（显「过期」） */
  stale?: boolean;
  /** 被打回 / 退回次数 */
  revision?: number;
  /** 该段尚未实现（虚线描边 + 降透明度） */
  dimmed?: boolean;
  /** 节点宽（默认 152） */
  width?: number;
  /** 点击后是否可操作（只影响光标与 hover） */
  clickable?: boolean;
  isSelected?: boolean;
  isHovered?: boolean;
}

/** 状态 → 墨色。饱和度为 0 或走语义变量，保证黑白灰基调 */
const STATUS_INK: Record<StageVisualStatus, string> = {
  idle: 'hsl(var(--muted-foreground) / 0.55)',
  running: 'hsl(var(--state-running))',
  awaiting_user: 'hsl(var(--primary))',
  approved: 'hsl(var(--state-done))',
  done: 'hsl(var(--state-done))',
  failed: 'hsl(var(--destructive))',
  blocked: 'hsl(var(--state-blocked))',
};

const STATUS_TEXT: Record<StageVisualStatus, string> = {
  idle: '待开始',
  running: '进行中',
  awaiting_user: '等确认',
  approved: '已定稿',
  done: '已完成',
  failed: '失败',
  blocked: '被挡下',
};

export function statusInk(status: StageVisualStatus): string {
  return STATUS_INK[status] ?? STATUS_INK.idle;
}

export function statusText(status: StageVisualStatus): string {
  return STATUS_TEXT[status] ?? '';
}

/** 小徽标（闸门 / 过期 / 打回次数）—— 三者都可能同时出现 */
function Badge({ ink, children, title }: { ink: string; children: React.ReactNode; title: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center justify-center"
      style={{
        fontSize: 8.5,
        lineHeight: 1,
        padding: 'var(--space-0) var(--space-1)',
        borderRadius: 'var(--r-3xs)',
        color: ink,
        border: `0.5px solid ${ink}`,
        background: 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export const StageNode = memo(function StageNode({ data }: NodeProps) {
  const d = data as unknown as StageNodeData;
  const ink = statusInk(d.status);
  const width = d.width ?? 152;
  const raised = d.isCurrent || d.isSelected;

  // 强调手段：**墨圈 + 投影**，不用彩色高亮 —— 与水墨基调一致
  const boxShadow = raised
    ? `0 0 0 1.5px ${ink}, 0 6px 18px hsl(var(--ink) / 0.10)`
    : d.isHovered
      ? '0 4px 14px hsl(var(--ink) / 0.10)'
      : '0 1px 3px hsl(var(--ink) / 0.05)';

  return (
    <div
      className="select-none"
      style={{
        width,
        cursor: d.clickable ? 'pointer' : 'default',
        opacity: d.dimmed ? 0.55 : 1,
        transition: 'box-shadow 0.18s ease',
      }}
    >
      {/*
        四个手柄（上下 + 左右），都藏起来（见 globals.css 的 .stage-handle）。
        为什么要左右两个：阶段图有**两种读法** ——
          · 纵向流程（流水线的列内推进、本章闭环的交付→实体）→ 下→上
          · 横向链（一行排开的阶段）→ 右→左
        只用上下手柄画横向链时，连线要从节点底部绕到下一个节点的顶部，
        在同一 y 上打出两个半圆 —— 看着像打结。给出 handle id 让业务方自己选方向。
      */}
      <Handle id="t-top" type="target" position={Position.Top} className="stage-handle" />
      <Handle id="t-left" type="target" position={Position.Left} className="stage-handle" />

      <div
        className="flex items-stretch overflow-hidden"
        style={{
          background: 'hsl(var(--card))',
          border: `${raised ? 1.2 : 1}px ${d.dimmed ? 'dashed' : 'solid'} ${raised ? ink : 'hsl(var(--border) / 0.75)'}`,
          borderRadius: 'var(--r-xs)',
          boxShadow,
          minHeight: 58,
        }}
      >
        {/* 左侧墨条：状态的主要视觉载体（一眼扫过去就能看出走到哪了） */}
        <span
          aria-hidden="true"
          style={{
            width: 3,
            flex: '0 0 3px',
            background: ink,
            opacity: d.status === 'idle' ? 0.4 : 1,
          }}
        />

        <div className="flex-1 min-w-0" style={{ padding: 'var(--space-3) var(--space-4)' }}>
          <div className="flex items-center gap-1.5">
            <span
              className="rounded-full shrink-0"
              style={{ width: 5, height: 5, background: ink }}
              aria-hidden="true"
            />
            <span
              className="truncate"
              style={{
                fontFamily: "'Noto Serif SC', serif",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.02em',
                color: d.status === 'idle' ? 'hsl(var(--ink-light))' : 'hsl(var(--ink))',
              }}
              title={d.label}
            >
              {d.label}
            </span>
            {d.isCurrent && (
              <span
                className="ml-auto shrink-0"
                style={{ fontSize: 8.5, color: ink, letterSpacing: '0.08em' }}
                title="流水线游标停在这一段"
              >
                当前
              </span>
            )}
          </div>

          <div
            className="truncate mt-0.5"
            style={{ fontSize: 10, color: ink, opacity: d.status === 'idle' ? 0.75 : 0.95 }}
            title={d.sub ?? statusText(d.status)}
          >
            {d.sub ?? statusText(d.status)}
          </div>

          {(d.gated || d.stale || (d.revision ?? 0) > 0) && (
            <div className="flex items-center gap-1 mt-1.5">
              {d.gated && <Badge ink="hsl(var(--muted-foreground))" title="这一段跑完会停下等你确认">◈ 闸门</Badge>}
              {d.stale && <Badge ink="hsl(var(--state-blocked))" title="开书设定改过，这一段基于旧基线，建议重跑">过期</Badge>}
              {(d.revision ?? 0) > 0 && (
                <Badge ink="hsl(var(--muted-foreground))" title={`已打回 ${d.revision} 次`}>
                  ×{d.revision}
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>

      <Handle id="s-bottom" type="source" position={Position.Bottom} className="stage-handle" />
      <Handle id="s-right" type="source" position={Position.Right} className="stage-handle" />
    </div>
  );
});
