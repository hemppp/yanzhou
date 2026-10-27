import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

// ============================================================
// EntityNode —— 「实体 / 章号 / 记忆」通用节点
//
// 用途（AI 写作工作台的两张新图谱）：
//   · 章节 × 实体 变动图谱：章号（round）+ 实体（rect）
//   · 记忆图谱：智能体（rect）+ 记忆条目（rect）
//
// 与 BubbleNode 的区别：BubbleNode 用**圆球面积**表达"分量"（关系图里度数越高越大），
// 这里是用**文字标签**表达"是什么" —— 节点名字长（「陈默」「第 12 章」「exp.ch3.turn2」），
// 圆球装不下。所以用矩形 + 截断 + title 悬浮。
//
// 水墨化：`kind` 只决定**墨阶**（走 `--entity-*` 语义变量），不用色相区分。
// ============================================================

export type EntityKind =
  | 'chapter'
  | 'character'
  | 'location'
  | 'item'
  | 'foreshadow'
  | 'event'
  | 'agent'
  | 'memory';

/** kind → 墨阶变量名。刻意全为灰度：区分靠深浅，不靠色相 */
const KIND_INK: Record<EntityKind, string> = {
  chapter: 'hsl(0 0% 20%)',
  character: 'hsl(var(--entity-character))',
  location: 'hsl(var(--entity-location))',
  item: 'hsl(var(--entity-item))',
  foreshadow: 'hsl(var(--entity-foreshadow))',
  event: 'hsl(var(--entity-event))',
  agent: 'hsl(var(--primary))',
  memory: 'hsl(0 0% 46%)',
};

/** dark 主题下 `--entity-*` 会整体反相（焦墨 → 最亮），
 *  所以**不要**在这里按亮暗做二次判断 —— 直接吃变量即可。 */
export function kindInk(kind: EntityKind): string {
  return KIND_INK[kind] ?? KIND_INK.memory;
}

export interface EntityNodeData {
  label: string;
  sub?: string;
  kind: EntityKind;
  /** 圆节点：章号这类"锚点"，直径；矩形忽略此值 */
  variant?: 'rect' | 'round';
  size?: number;
  /** 矩形宽（默认 150） */
  width?: number;
  /** 强调（当前章 / 选中的实体 / 冲突记忆） */
  isSelected?: boolean;
  isHovered?: boolean;
  /** 告警（记忆冲突、伏笔未回收…）—— 描边转为警示墨 */
  alert?: boolean;
  /** 角标数字（例如"3 条变动"），0 / undefined 不显示 */
  badge?: number;
}

const ALERT_INK = 'hsl(var(--destructive))';

export const EntityNode = memo(function EntityNode({ data }: NodeProps) {
  const d = data as unknown as EntityNodeData;
  const ink = d.alert ? ALERT_INK : kindInk(d.kind);
  const raised = !!(d.isSelected || d.isHovered);

  const boxShadow = raised
    ? `0 0 0 1.5px ${ink}, 0 6px 18px hsl(var(--ink) / 0.10)`
    : '0 1px 3px hsl(var(--ink) / 0.05)';

  // ---- 圆节点：章号锚点 ----
  if (d.variant === 'round') {
    const size = d.size ?? 42;
    return (
      <div className="select-none" style={{ width: size, height: size }}>
        <Handle type="target" position={Position.Top} className="stage-handle" />
        <div
          className="w-full h-full flex flex-col items-center justify-center"
          style={{
            borderRadius: '50%',
            background: 'hsl(var(--card))',
            border: `${raised ? 1.5 : 1}px solid ${ink}`,
            boxShadow,
          }}
          title={d.label}
        >
          <span
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontSize: d.label.length > 4 ? 10 : 12,
              fontWeight: 600,
              color: ink,
              lineHeight: 1.1,
            }}
          >
            {d.label}
          </span>
          {d.sub && (
            <span style={{ fontSize: 8, color: 'hsl(var(--muted-foreground))', lineHeight: 1.2 }}>
              {d.sub}
            </span>
          )}
        </div>
        <Handle type="source" position={Position.Bottom} className="stage-handle" />
      </div>
    );
  }

  // ---- 矩形节点：实体 / 记忆 ----
  const width = d.width ?? 150;
  return (
    <div className="select-none" style={{ width }}>
      <Handle type="target" position={Position.Top} className="stage-handle" />
      <div
        className="flex items-stretch overflow-hidden"
        style={{
          minHeight: 42,
          background: 'hsl(var(--card))',
          border: `${raised ? 1.2 : 1}px solid ${raised ? ink : 'hsl(var(--border) / 0.75)'}`,
          borderRadius: 'var(--r-2xs)',
          boxShadow,
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 3, flex: '0 0 3px', background: ink, opacity: 0.9 }}
        />
        <div className="flex-1 min-w-0 flex items-center gap-2" style={{ padding: 'var(--space-3)' }}>
          <div className="min-w-0 flex-1">
            <div
              className="truncate"
              style={{
                fontFamily: "'Noto Serif SC', serif",
                fontSize: 11,
                fontWeight: 600,
                color: 'hsl(var(--ink))',
              }}
              title={d.label}
            >
              {d.label}
            </div>
            {d.sub && (
              <div
                className="truncate"
                style={{ fontSize: 9.5, color: 'hsl(var(--muted-foreground))', marginTop: 'var(--space-0)' }}
                title={d.sub}
              >
                {d.sub}
              </div>
            )}
          </div>
          {typeof d.badge === 'number' && d.badge > 0 && (
            <span
              className="shrink-0 tabular-nums"
              style={{
                fontSize: 9,
                padding: 'var(--space-0) var(--space-1)',
                borderRadius: 'var(--r-pill)',
                color: ink,
                border: `0.5px solid ${ink}`,
              }}
            >
              {d.badge}
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="stage-handle" />
    </div>
  );
});
