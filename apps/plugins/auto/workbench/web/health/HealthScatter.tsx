// ============================================================
// health · 验收图（Acceptance Map）
//
// 一句话：把「篇幅合格」与「对话合格」**合成一个矩形**，而不是画两条独立的参考线。
//
//   横轴 = 字数，纵轴 = 对话占比。
//   那个浅色方块（2500–3500 × ≥15%）就是"可以定稿"的区域。
//   点落在方块里 = 过关；落在外面，**从哪个方向出去**就说明了该修什么：
//     左边出去 → 太短    右边出去 → 太长
//     下边出去 → 对话太少
//
// ★ 这比"画一条带 + 一条虚线"更好的地方：读者不用在大脑里做交集运算。
//   两个约束的联合条件，本来就该画成一个区域。
//
// ★ 坐标只从 x() / y() 一处推导：设计第一版手算过像素，
//   结果点与参考线用了两套比例，第 9 章（10%）视觉上贴着 15% 虚线。
// ============================================================

import type { HealthRow } from './services/healthData';

/* 绘图区 */
const L = 58, R = 872, T = 26, B = 286;
/* 定义域 */
const X_MIN = 2000, X_MAX = 3600;
const Y_MAX = 0.40;

interface Props {
  chapters: readonly HealthRow[];
  band: { min: number; max: number; target: number };
  dialogueFloor: number;
  dialogueCeiling: number;
  bad: string;
  good: string;
}

type Kind = 'ok' | 'short' | 'long' | 'dlg';

export function HealthScatter({ chapters, band, dialogueFloor, dialogueCeiling, bad, good }: Props) {
  const x = (v: number) => L + (v - X_MIN) / (X_MAX - X_MIN) * (R - L);
  const y = (v: number) => B - (Math.min(v, Y_MAX) / Y_MAX) * (B - T);

  const kindOf = (c: HealthRow): Kind =>
    c.length === 'low' ? 'short'
      : c.length === 'high' ? 'long'
        : (c.dialogueLow || c.dialogueHigh || c.dialogueFragmented) ? 'dlg'
          : 'ok';

  const zoneX = x(band.min);
  const zoneW = x(band.max) - x(band.min);
  const zoneY = y(Y_MAX);
  const zoneH = y(dialogueFloor) - zoneY;

  return (
    <svg
      viewBox="0 0 900 330"
      role="img"
      aria-label={`章节验收图：${chapters.length} 章，横轴字数、纵轴对话占比`}
      style={{ display: 'block', width: '100%', height: 'auto', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="hz-zone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={good} stopOpacity="0.10" />
          <stop offset="100%" stopColor={good} stopOpacity="0.04" />
        </linearGradient>
      </defs>

      {/* ── 背景网格 ── */}
      {[0.10, 0.20, 0.30, 0.40].map((r) => (
        <g key={r}>
          <line x1={L} y1={y(r)} x2={R} y2={y(r)} stroke="currentColor" strokeOpacity="0.07" strokeWidth="1" />
          <text x={L - 12} y={y(r) + 4} textAnchor="end" fontSize="11"
            fill="currentColor" fillOpacity="0.35">{Math.round(r * 100)}%</text>
        </g>
      ))}
      {[2400, 2800, 3200].map((v) => (
        <line key={v} x1={x(v)} y1={T} x2={x(v)} y2={B} stroke="currentColor" strokeOpacity="0.05" strokeWidth="1" />
      ))}

      {/* ── 可定稿区 ── */}
      <rect x={zoneX} y={zoneY} width={zoneW} height={zoneH} fill="url(#hz-zone)" />
      <rect x={zoneX} y={zoneY} width={zoneW} height={zoneH} fill="none"
        stroke={good} strokeOpacity="0.28" strokeWidth="1.5" strokeDasharray="6 5" rx="2" />
      <text x={zoneX + 12} y={zoneY + 20} fontSize="11" fill={good} fillOpacity="0.75" letterSpacing="0.06em">
        可定稿区
      </text>

      {/* ── 轴 ── */}
      <line x1={L} y1={B} x2={R} y2={B} stroke="currentColor" strokeOpacity="0.18" />
      <line x1={L} y1={T} x2={L} y2={B} stroke="currentColor" strokeOpacity="0.18" />
      {[2000, 2400, 2800, 3200, 3600].map((v) => (
        <text key={v} x={v === 3600 ? x(3600) - 14 : x(v)} y={B + 20} textAnchor="middle"
          fontSize="11" fill="currentColor" fillOpacity="0.35">{v}</text>
      ))}
      <text x={(L + R) / 2} y={B + 38} textAnchor="middle" fontSize="10"
        fill="currentColor" fillOpacity="0.3" letterSpacing="0.12em">字数</text>

      {/* ── 点 ── */}
      {chapters.map((c) => {
        const k = kindOf(c);
        const cx = x(c.chars);
        const cy = y(c.dialogueRatio);
        const fill = k === 'ok' ? good : bad;
        return (
          <g key={c.order}>
            <circle cx={cx} cy={cy} r={6.5} fill={fill} fillOpacity={k === 'ok' ? 0.9 : 1}
              stroke="#fff" strokeWidth="2">
              <title>{`第 ${c.order} 章 · ${c.chars} 字 · 对话 ${(c.dialogueRatio * 100).toFixed(2)}%`}</title>
            </circle>
            <text x={cx + 11} y={cy + 4} fontSize="10" fill="currentColor" fillOpacity="0.42">
              {c.order}
            </text>
          </g>
        );
      })}

      {/* 纵轴说明（旋转太挤，放右上角） */}
      <text x={R} y={T - 12} textAnchor="end" fontSize="10"
        fill="currentColor" fillOpacity="0.3" letterSpacing="0.12em">对话占比</text>

      {/* 对话上限参考：只在接近时才有意义，用极淡的线提示 */}
      <line x1={L} y1={y(dialogueCeiling)} x2={R} y2={y(dialogueCeiling)}
        stroke="currentColor" strokeOpacity="0.10" strokeDasharray="2 6" />
    </svg>
  );
}
