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

// ============================================================
// 颜色工具
//
// ★ 2026-11-14 修复：业务侧传进来的是 `hsl(0 0% 12%)` 这类 CSS 颜色，
//   而旧实现只有 hexToRgba() —— parseInt('hsl(...)', 16) = NaN，
//   全部退化成黑色。于是不同角色/物品的颜色根本没生效，整张图只剩黑球。
//   这里同时支持 hex / rgb() / hsl()，并优先用 color-mix 让任意 CSS 颜色都能带透明度。
// ============================================================

function parseCssColorToRgb(color: string): [number, number, number] | null {
  const value = color.trim();

  // #rgb / #rrggbb
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (!/^[0-9a-f]{6}$/i.test(full)) return null;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // rgb(r g b) / rgba(r, g, b, a)
  const rgbMatch = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgbMatch) {
    return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  }

  // hsl(h s% l%)
  const hslMatch = value.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
  if (hslMatch) {
    const h = Number(hslMatch[1]) / 360;
    const s = Number(hslMatch[2]) / 100;
    const l = Number(hslMatch[3]) / 100;
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    if (s === 0) {
      const gray = Math.round(l * 255);
      return [gray, gray, gray];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  return null;
}

/** 给任意 CSS 颜色附加透明度（hex / rgb / hsl 都支持） */
export function colorWithAlpha(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const rgb = parseCssColorToRgb(color);
  if (rgb) return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamped})`;
  // 兜底：color-mix 能处理 var()/颜色关键字等无法静态解析的值（Chromium 111+）
  return `color-mix(in srgb, ${color} ${Math.round(clamped * 100)}%, transparent)`;
}

/**
 * 文字颜色跟随主题前景色，而不是跟随气泡颜色。
 *
 * 气泡填充是「角色色 × 0.4 透明度」叠在画布上：浅色主题下最深也就中灰，
 * 深色主题下则会落到近黑。用固定白字/黑字都会在某个主题里失去对比度，
 * 而 `--foreground` 本身就是与背景成对定义的，交给它最稳。
 */
const INK_TEXT = 'hsl(var(--foreground))';
const INK_SUBTLE = 'hsl(var(--muted-foreground))';

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

  // 边框改用 0.5px 的 inset 阴影：CSS border 会被浏览器向上取整到 1px，
  // 而 box-shadow 的 0.5px 能保留亚像素，在 1x 屏上也不会显得"描了一圈粗边"。
  const ring = `inset 0 0 0 0.5px ${colorWithAlpha(d.color, 0.35)}`;
  const bgTop = colorWithAlpha(d.color, 0.38);
  const bgMid = colorWithAlpha(d.color, 0.16);
  const bgBottom = colorWithAlpha(d.color, 0.09);

  const scale = d.isSelected ? 1.03 : d.isHovered ? 1.015 : 1;

  const boxShadow = d.isSelected
    ? `${ring}, 0 0 0 1px ${colorWithAlpha(d.color, 0.42)}, 0 5px 14px ${colorWithAlpha(d.color, 0.12)}`
    : d.isHovered
      ? `${ring}, 0 0 0 0.75px ${colorWithAlpha(d.color, 0.3)}, 0 3px 10px ${colorWithAlpha(d.color, 0.1)}`
      : `${ring}, 0 1px 2px ${colorWithAlpha(d.color, 0.08)}`;

  return (
    <div
      className="cursor-pointer select-none bubble-node"
      style={{
        width: size,
        height: size,
        transform: `scale(${scale})`,
        // 只对交互做过渡；不再让每个节点永久上下浮动（既晃眼又持续触发重绘）
        transition: 'transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        position: 'relative',
        zIndex: d.isSelected ? 20 : d.isHovered ? 10 : 1,
        willChange: d.isSelected || d.isHovered ? 'transform' : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} className="bubble-handle-target" />
      <div
        className="w-full h-full rounded-full flex items-center justify-center"
        style={{
          background: `radial-gradient(circle at 32% 26%, ${bgTop} 0%, ${bgMid} 58%, ${bgBottom} 100%)`,
          border: 'none',
          fontSize,
          color: INK_TEXT,
          boxShadow,
          backdropFilter: 'blur(3px)',
          WebkitBackdropFilter: 'blur(3px)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* 左上高光 */}
        <div
          style={{
            position: 'absolute',
            top: '12%',
            left: '18%',
            width: '38%',
            height: '26%',
            borderRadius: '50%',
            background:
              'radial-gradient(ellipse at center, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 70%)',
            pointerEvents: 'none',
          }}
        />
        {/* 底部内阴影，增加球体体积感 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            background:
              'radial-gradient(circle at 50% 120%, rgba(0,0,0,0.16) 0%, rgba(0,0,0,0) 55%)',
            pointerEvents: 'none',
          }}
        />
        <span
          className="px-1 text-center leading-tight relative z-10"
          style={{
            textShadow: '0 1px 2px rgba(0,0,0,0.18)',
            overflowWrap: 'anywhere',
            wordBreak: 'normal',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            fontWeight: 600,
            letterSpacing: '0.01em',
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
            marginTop: 4,
            color: INK_SUBTLE,
          }}
        >
          {d.subtitle}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="bubble-handle-source" />
    </div>
  );
});
