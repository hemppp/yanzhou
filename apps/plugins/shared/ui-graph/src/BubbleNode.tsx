import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface BubbleNodeData {
  label: string;
  color: string;
  size: number;
  subtitle?: string;
  isSelected?: boolean;
  isHovered?: boolean;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3
    ? h.split('').map(c => c + c).join('')
    : h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getFontSize(size: number, labelLength: number): number {
  if (labelLength <= 2) {
    if (size >= 50) return 18;
    if (size >= 40) return 15;
    if (size >= 32) return 13;
    return 11;
  }
  if (labelLength <= 4) {
    if (size >= 50) return 13;
    if (size >= 40) return 11;
    if (size >= 32) return 10;
    return 9;
  }
  if (size >= 50) return 10;
  if (size >= 40) return 9;
  return 8;
}

// ★ memo：关系图节点数量可能数十至上百，未选中/未悬停的节点应跳过重渲染。
// xyflow 在交互时只更新受影响节点的 data 引用，memo 后其余节点直接复用上一次渲染结果。
export const BubbleNode = memo(function BubbleNode({ data }: NodeProps) {
  const d = data as unknown as BubbleNodeData;
  const size = d.size;
  const label = d.label || '';
  const fontSize = getFontSize(size, label.length);

  const bgColor = hexToRgba(d.color, 0.22);
  const borderColor = hexToRgba(d.color, 0.45);
  const glowColor = hexToRgba(d.color, 0.35);
  const glowColorStrong = hexToRgba(d.color, 0.55);
  const textColor = hexToRgba(d.color, 0.9);

  const scale = d.isSelected ? 1.12 : d.isHovered ? 1.06 : 1;
  const boxShadow = d.isSelected
    ? `0 0 0 3px ${glowColor}, 0 0 30px ${glowColorStrong}, 0 4px 16px ${glowColor}`
    : d.isHovered
    ? `0 0 20px ${glowColor}, 0 2px 10px ${glowColor}`
    : `0 0 12px ${hexToRgba(d.color, 0.2)}, 0 2px 8px ${hexToRgba(d.color, 0.12)}`;

  return (
    <div
      className="cursor-pointer select-none bubble-node"
      style={{
        width: size,
        height: size,
        transform: `scale(${scale})`,
        transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        animation: `bubble-float ${3 + (size % 5) * 0.4}s ease-in-out infinite alternate`,
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Top} className="bubble-handle-target" />
      <div
        className="w-full h-full rounded-full flex items-center justify-center font-bold"
        style={{
          background: `radial-gradient(circle at 30% 25%, ${hexToRgba(d.color, 0.45)} 0%, ${bgColor} 60%, ${hexToRgba(d.color, 0.18)} 100%)`,
          border: `1px solid ${borderColor}`,
          fontSize,
          color: textColor,
          boxShadow,
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '15%',
            left: '20%',
            width: '35%',
            height: '25%',
            borderRadius: '50%',
            background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0) 70%)',
            pointerEvents: 'none',
          }}
        />
        <span
          className="px-1 text-center leading-tight break-all relative z-10"
          style={{
            textShadow: '0 1px 2px rgba(255,255,255,0.3), 0 -1px 1px rgba(0,0,0,0.1)',
            wordBreak: 'break-word',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            fontWeight: 600,
          }}
        >
          {label}
        </span>
      </div>
      {d.subtitle && (
        <span
          className="text-[10px] font-medium whitespace-nowrap"
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: 'var(--space-1)',
            color: d.color,
            textShadow: '0 1px 2px rgba(255,255,255,0.7)',
          }}
        >
          {d.subtitle}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="bubble-handle-source" />
    </div>
  );
});
