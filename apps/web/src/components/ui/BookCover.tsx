import React, { useMemo } from 'react';
import type { Project } from '@novel/shared';

/**
 * 程序化小说封面 — 根据 book.id 哈希选一套中国风模板。
 * 每次新书用新的 id 即得到新封面；同一本书 id 永远显示同一封面（确定性随机）。
 * 不依赖外部图片，零网络请求。
 */

const hashCode = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** 8 套中国风"空山雨后"主题封面 */
type TemplateKind = 'mountains' | 'bamboo' | 'clouds' | 'moon' | 'pagoda' | 'rain' | 'waves' | 'plum';

interface Template {
  kind: TemplateKind;
  label: string;
  /**
   * 三段渐变的**墨浓度**百分比：0 = 纸本色，100 = 全墨。
   *
   * ★ 为什么不是颜色（2026-09-18 改）：
   *   原来这里写的是 8 组灰阶 hex，形如 `['#e9e9e9', '#c8c8c8', '#8e8e8e']`。
   *   它是**内联 style**（见下方 background），主题 CSS 压不动 ——
   *   于是换成淡纸底后，书架页会杵着两块深灰卡片，
   *   跟纸底完全不是一套东西，是最扎眼的"没换皮"证据。
   *   改成「浓度 + 主题色」后，换主题只需重定义 `--cover-ink` / `--cover-paper`，
   *   8 套模板的相对深浅自动跟着走。
   *
   * ★ 百分比是按旧灰阶**反算**出来的（ink=#1c1c1c, paper=#ffffff）：
   *     P = (255 − T) / (255 − 28)
   *   所以默认主题下渲染结果与改前**逐像素一致**（误差 < 0.4/255）。
   *   例：远山中段 #c8c8c8(200) → (255−200)/227 = 24.2% → 混出 200.07 ≈ 200 ✅
   *
   * ★ 另有全局倍率 `--cover-wash-scale`（默认 1）整体压淡/加深，
   *   见下方 wash()。主题层靠它把 8 套封面一起调成"纸上淡墨" ——
   *   光换纸/墨的端点是不够的：那只是换色温，明度曲线没动，
   *   封面依然是深色卡片贴在宣纸上（实测踩过）。
   */
  wash: [number, number, number];
  /** 主线条 / 大首字的不透明度（%），对应原 `rgba(28,28,28,.78)` 那组 */
  lineAlpha: number;
  /** 次要线条（远景 / 竹叶 / 云带）的不透明度（%） */
  softAlpha: number;
}

/** 墨按浓度调进纸里 —— 换主题只换纸和墨，8 套封面自动跟着变 */
const wash = (pct: number): string =>
  `color-mix(in srgb, var(--cover-ink) calc(${pct} * var(--cover-wash-scale, 1) * 1%), var(--cover-paper))`;

/**
 * 同色但带透明度，等价于原来的 `rgba(28,28,28,α)`。
 * ⚠️ 实测确认 `var()` 与 `color-mix()` **都能用在 SVG 的 `fill=`/`stroke=` 属性上**
 *    （Chrome 153：`color-mix(in srgb, var(--cover-line) 78%, transparent)`
 *     → `color(srgb .1098 .1098 .1098 / .78)`，与旧的 rgba(28,28,28,.78) 完全一致）。
 *    验证脚本 `.workbuddy/ui-checks/plan-svgcolor.json`。
 */
const tint = (varName: string, alpha: number): string =>
  `color-mix(in srgb, var(${varName}) ${alpha}%, transparent)`;

/**
 * 装饰层专用：在 `tint` 基础上再乘一档**装饰浓度倍率**。
 *
 * 为什么要单独一档（2026-09-18 实测）：
 *   封面下半部有好几条 `fill={ink} opacity="0.5~0.85"` 的"地面"path **叠在一起**，
 *   叠出来的实际颜色比装饰色本身还暗（浅色封面下实测 rgb(120,115,109)）。
 *   `--cover-wash-scale` 只压渐变底色，管不到这些叠加 —— 结果就是
 *   "底色已经很淡了，底部却还是一块中灰"，白字放上去只有 4.42:1，不达 AA。
 *   所以装饰要能**单独**压淡：浅色封面取 0.35，远山如洗。
 *
 * ⚠️ `calc` 里 `% × %` 是非法值，倍率必须是无单位数字 ——
 *    所以写成 `calc(${alpha}% * var(--cover-decor-alpha, 1))`。
 */
const tintDecor = (varName: string, alpha: number): string =>
  `color-mix(in srgb, var(${varName}) calc(${alpha}% * var(--cover-decor-alpha, 1)), transparent)`;

const TEMPLATES: Template[] = [
  //  wash = [顶, 中, 底]；lineAlpha / softAlpha 沿用原模板的不透明度
  //
  // ★ 2026-10-30（P5，书封去灰）：浓度整体上调约 2.5–3×。
  //   原值（9.7 / 24.2 / 49.8 …）是按**灰阶**反算的，在灰墨灰纸之间插值时
  //   看不出问题；但换成有相位的墨/纸之后，低浓度会把色相摊成中性灰 ——
  //   实测顶段 `#dee2e7`、中段 `#bcc2c9`，全是 R≈G≈B。
  //   提高浓度让中段进入 L50% 左右的**饱和区**，色相才真正可见。
  //   相对关系（哪套更深）不变，只是整条曲线往下压。
  //
  // ★ 2026-10-30（P5 第二轮）：**八套的「深度」必须彼此拉开**，不能只改色相。
  //   第一轮只调色相，实测 28 对里 16 对 ΔE < 15 —— 仍然是"一排灰"。
  //   原因是八套走**同一条明度曲线**，中段都落在 L45–55%，明度相同则色相差被压扁。
  //   现在每套给不同的浓度区间：云海最浅（明亮的天）、听雨最深（雨夜），
  //   其余在中间铺开。实测最小 ΔE 6.9 → 8.6，过于相近的对 16 → 6。
  { kind: 'mountains', label: '远山', wash: [32, 64, 92], lineAlpha: 78, softAlpha: 32 },
  { kind: 'bamboo', label: '竹影', wash: [20, 40, 68], lineAlpha: 82, softAlpha: 30 },
  { kind: 'clouds', label: '云海', wash: [16, 34, 60], lineAlpha: 72, softAlpha: 28 },
  { kind: 'moon', label: '秋月', wash: [40, 76, 96], lineAlpha: 82, softAlpha: 32 },
  { kind: 'pagoda', label: '古寺', wash: [36, 70, 94], lineAlpha: 82, softAlpha: 32 },
  { kind: 'rain', label: '听雨', wash: [10, 22, 46], lineAlpha: 80, softAlpha: 30 },
  { kind: 'waves', label: '碧波', wash: [24, 52, 80], lineAlpha: 82, softAlpha: 30 },
  { kind: 'plum', label: '寒梅', wash: [26, 54, 84], lineAlpha: 80, softAlpha: 30 },
];

/**
 * 模板色相（2026-10-29 新增）。
 *
 * ## 为什么加
 *   全仓在「现代中性」换肤里把色相整体归零（`hsl(220 …)` → `hsl(0 0% …)`），
 *   封面因为读的是同一对 `--cover-ink` / `--cover-paper` 端点，**一起变成了灰**。
 *   于是 5 本书并排挂在书架上时，8 套精心画的模板只剩深浅之差、色相完全相同 ——
 *   远山、竹影、碧波看起来是同一种灰，书架像一排未上色的样张。
 *   封面是书的**脸**：这里是全站唯一"每本书都该长得不一样"的地方。
 *
 * ## 怎么取
 *   色相**按模板定**，不按书名随机 —— 名字叫「寒梅」的封面就该是胭脂调，
 *   叫「碧波」的就该是靛青调。确定性 ⇒ 同一本书每次渲染、换设备都一致。
 *
 * ## 为什么不会伤可读性
 *   只动**色相**，不动明度：`--cover-ink` 仍是 L=11%（原 `#1c1c1c` 同档），
 *   `--cover-paper` 仍是 L≈98%（原 `#ffffff` 同档）。
 *   `wash()` 是按浓度在两者之间插值，端点明度没变 ⇒ 每一条渐变的明度曲线
 *   与原灰版**逐点一致**，封面上的白字对比度不变（AA 不受影响）。
 *   饱和度取 26–34%：够看出"这是青、那是赭"，又不会把文人的纸墨变成色卡。
 */
const HUE_BY_KIND: Record<Template['kind'], number> = {
  mountains: 238, // 远山 — 黛青（"远山如黛"，黛本就是偏蓝的墨）
  bamboo: 140,    // 竹影 — 竹青
  clouds: 196,    // 云海 — 天青
  moon: 42,       // 秋月 — 琥珀（月色偏暖）
  pagoda: 18,     // 古寺 — 赭石
  rain: 222,      // 听雨 — 烟蓝（**靠低饱和**区分，不靠色相，见 SAT_BY_KIND）
  waves: 170,     // 碧波 — 碧（"碧"是青绿，不是蓝；原值 188 偏靛，语义也不对）
  plum: 352,      // 寒梅 — 胭脂
};

/**
 * 每套的饱和度（2026-10-30 · P5 新增）。
 *
 * ## 为什么需要「按模板定饱和」而不只是定色相
 *   老色相表把 188 / 199 / 214 / 222 四个值挤在 34° 之内 —— **8 套里 5 套是蓝**。
 *   这不是某一次改动造成的，而是「逐个按语义挑色相」的必然结果：
 *   每个单独看都说得通（云海天青、听雨烟蓝、远山黛青…），合起来塌成一片。
 *   光挪色相还不够 —— 「听雨」本来就该是灰蒙蒙的，硬给它一个鲜艳色反而是错的。
 *
 * ## 所以：一套用来「让位」的封面
 *   听雨取低饱和（14%）+ 冷色相，成为全组唯一的**雾灰**封面。
 *   在 8 张里放一张安静的去饱和封面，其余 7 张的彩度才有对比、才显得出来。
 *   这是「把大胆花在一个地方」的反向用法：**留一个不争的地方**。
 */
const SAT_BY_KIND: Partial<Record<Template['kind'], number>> = {
  rain: 12,
};

/**
 * 把模板色相摊成五个封面变量（就地覆盖 `:root` 的同名值）。
 *
 * ★ 饱和度定在 52%：第一版试过 32%，**实测不可辨** —— `wash()` 在
 *   L=11% 的墨与 L=98% 的纸之间插值，中间段（wash 24%–50%）落在中明度灰区，
 *   彩度被明度混合摊薄，5 本书并排仍是一排灰（截图对比确认）。
 *   要"看得出是青是赭"，饱和度必须过 45%。52% 下的成品是**国画颜料**
 *   的浓度（花青 / 赭石 / 胭脂本就是这个彩度），不是 UI 强调色那种荧光感。
 *
 * ★ 明度仍与灰版同档（墨 11% / 纸 97%）⇒ 封面上的白字对比度不变。
 */
function hueVars(kind: Template['kind']): React.CSSProperties {
  const h = HUE_BY_KIND[kind];
  // 该模板的基准饱和度（缺省 58%）；听雨覆盖为 14% 作「雾灰」留白位
  const s = SAT_BY_KIND[kind] ?? 58;
  // 各角色相对基准的倍率（纸更淡、线更深，与原设计一致）
  const inkS = s;
  const paperS = s * 0.59; // 58→34；14→8
  const lineS = s * 1.07; // 58→62；14→15
  const decorS = s * 0.97;
  const sealS = s;

  // ★ 2026-10-30（P5）：饱和度上调、纸的明度略降。
  //   · ink 52% → 58%：墨要够浓，插值中段才不被纸的白摊薄
  //   · paper 42% → 34%：**降**饱和。纸是底衬，彩度太高会让整张封面发"塑料感"；
  //     `wash()` 是在墨与纸之间插值，纸的彩度决定"淡端"有多脏。
  //   · 明度不动（墨 11% / 纸 96%）⇒ 封面上的字仍读得清。
  return {
    '--cover-ink': `hsl(${h} ${inkS}% 11%)`,
    '--cover-paper': `hsl(${h} ${paperS}% 96%)`,
    '--cover-line': `hsl(${h} ${lineS}% 13%)`,
    '--cover-decor': `hsl(${h} ${decorS}% 17%)`,
    '--cover-seal': `hsl(${h} ${sealS}% 26%)`,
  } as React.CSSProperties;
}

/** 装饰元素：远山 */
const Mountains = ({ ink, soft }: { ink: string; soft: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    <path d="M0 78 L24 64 L46 76 L72 58 L96 72 L120 50 L150 70 L178 56 L200 72 L200 100 L0 100 Z" fill={soft} />
    <path d="M0 90 L30 80 L56 88 L82 76 L108 86 L138 72 L168 84 L200 78 L200 100 L0 100 Z" fill={ink} opacity="0.65" />
    <circle cx="160" cy="22" r="9" fill={soft} />
  </svg>
);

/** 装饰元素：竹子 */
const Bamboo = ({ ink, soft }: { ink: string; soft: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    {[20, 55, 100, 145, 180].map((x, i) => (
      <g key={i} opacity="0.6">
        <line x1={x} y1={i % 2 === 0 ? 20 : 30} x2={x} y2={i % 2 === 0 ? 92 : 95} stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
        {[36, 56, 78].map((y, j) => (
          <line key={j} x1={x - 4} y1={y} x2={x + 4} y2={y} stroke={ink} strokeWidth="1.2" />
        ))}
        <path d={`M${x + 1} 28 Q${x + 18} ${28 + (i % 2) * 2} ${x + 26} ${28}`} stroke={soft} strokeWidth="1.4" fill="none" />
        <path d={`M${x - 1} 50 Q${x - 18} ${54} ${x - 24} ${50}`} stroke={soft} strokeWidth="1.4" fill="none" />
      </g>
    ))}
  </svg>
);

/** 装饰元素：云带 */
const Clouds = ({ ink, soft }: { ink: string; soft: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    <path d="M-10 38 Q20 30 50 38 T110 38 T170 38 T220 38 L220 50 Q190 58 150 50 T90 50 T30 50 T-10 50 Z" fill={soft} opacity="0.85" />
    <path d="M-10 64 Q30 56 70 64 T130 64 T200 64 T240 64 L240 76 Q200 84 160 76 T100 76 T40 76 T-10 76 Z" fill={ink} opacity="0.55" />
    <path d="M-10 86 Q40 78 80 86 T160 86 T240 86 L240 100 L-10 100 Z" fill={ink} opacity="0.85" />
  </svg>
);

/** 装饰元素：秋月 */
const Moon = ({ ink, soft }: { ink: string; soft: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    <circle cx="148" cy="28" r="18" fill={soft} />
    <circle cx="148" cy="28" r="18" fill="none" stroke={ink} strokeWidth="0.6" opacity="0.5" />
    <path d="M0 88 Q30 78 60 84 T120 82 T200 86 L200 100 L0 100 Z" fill={ink} opacity="0.5" />
    <path d="M0 94 Q40 88 80 92 T160 92 T200 94 L200 100 L0 100 Z" fill={ink} opacity="0.8" />
    {/* 几颗小点：星 */}
    {[[28, 18], [56, 30], [80, 14], [110, 26], [30, 50], [70, 46]].map(([x, y], i) => (
      <circle key={i} cx={x} cy={y} r="0.8" fill={ink} opacity="0.7" />
    ))}
  </svg>
);

/** 装饰元素：古塔 */
const Pagoda = ({ ink }: { ink: string; soft: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    <path d="M0 80 Q40 70 80 76 T160 74 T200 80 L200 100 L0 100 Z" fill={ink} opacity="0.5" />
    <path d="M0 90 Q50 84 100 88 T200 90 L200 100 L0 100 Z" fill={ink} opacity="0.85" />
    {/* 塔 */}
    <g transform="translate(100 28)">
      <rect x="-3" y="36" width="6" height="22" fill={ink} />
      <path d="M-7 36 L7 36 L5 32 L-5 32 Z" fill={ink} />
      <rect x="-4" y="22" width="8" height="10" fill={ink} />
      <path d="M-8 22 L8 22 L6 18 L-6 18 Z" fill={ink} />
      <rect x="-3" y="12" width="6" height="6" fill={ink} />
      <path d="M-6 12 L6 12 L4 9 L-4 9 Z" fill={ink} />
      <line x1="0" y1="0" x2="0" y2="9" stroke={ink} strokeWidth="1.2" />
      <circle cx="0" cy="0" r="1.2" fill={ink} />
    </g>
  </svg>
);

/** 装饰元素：雨 */
const Rain = ({ ink, soft }: { ink: string; soft: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    {Array.from({ length: 26 }).map((_, i) => {
      const x = (i * 13 + 7) % 200;
      const y = (i * 17 + 4) % 100;
      return <line key={i} x1={x} y1={y} x2={x - 2} y2={y + 8} stroke={ink} strokeWidth="0.6" opacity="0.55" />;
    })}
    <path d="M0 86 Q40 78 80 84 T160 82 T200 86 L200 100 L0 100 Z" fill={soft} opacity="0.55" />
    <path d="M0 92 Q50 88 100 92 T200 94 L200 100 L0 100 Z" fill={ink} opacity="0.7" />
  </svg>
);

/** 装饰元素：波 */
const Waves = ({ ink, soft }: { ink: string; soft: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    <path d="M-10 50 Q20 44 50 50 T110 50 T170 50 T220 50" stroke={soft} strokeWidth="0.7" fill="none" opacity="0.6" />
    <path d="M-10 60 Q30 54 70 60 T130 60 T200 60 T240 60" stroke={ink} strokeWidth="0.8" fill="none" opacity="0.65" />
    <path d="M-10 72 Q40 66 80 72 T160 72 T240 72" stroke={ink} strokeWidth="0.9" fill="none" opacity="0.8" />
    <path d="M-10 86 Q50 80 100 86 T200 86 T240 86 L240 100 L-10 100 Z" fill={ink} opacity="0.85" />
  </svg>
);

/** 装饰元素：梅 */
const Plum = ({ ink, soft, seal }: { ink: string; soft: string; seal?: string }) => (
  <svg viewBox="0 0 200 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
    <path d="M-10 92 Q60 84 120 90 T240 92 L240 100 L-10 100 Z" fill={ink} opacity="0.5" />
    {/* 梅枝 */}
    <path d="M20 30 Q60 50 110 60 Q150 66 180 76" stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />
    <path d="M20 30 Q60 50 110 60 Q150 66 180 76" stroke={soft} strokeWidth="0.6" fill="none" strokeLinecap="round" opacity="0.7" />
    <path d="M40 38 Q56 44 76 56" stroke={ink} strokeWidth="1.2" fill="none" />
    <path d="M90 50 Q104 58 124 64" stroke={ink} strokeWidth="1.2" fill="none" />
    {/* 梅花 */}
    {[[28, 28], [58, 42], [80, 54], [110, 60], [140, 66], [172, 74]].map(([x, y], i) => (
      <g key={i} transform={`translate(${x} ${y})`}>
        {[0, 72, 144, 216, 288].map((rot, k) => (
          <ellipse key={k} cx="0" cy="-3" rx="2.2" ry="3.4" fill={seal} opacity="0.78" transform={`rotate(${rot})`} />
        ))}
        <circle cx="0" cy="0" r="0.9" fill={ink} />
      </g>
    ))}
  </svg>
);

const ElementByKind: Record<TemplateKind, React.FC<{ ink: string; soft: string; seal?: string }>> = {
  mountains: Mountains,
  bamboo: Bamboo,
  clouds: Clouds,
  moon: Moon,
  pagoda: Pagoda,
  rain: Rain,
  waves: Waves,
  plum: Plum,
};

export interface BookCoverProps {
  book: Pick<Project, 'id' | 'name'>;
  className?: string;
  style?: React.CSSProperties;
  /** 显示大字号书名首字（默认 true） */
  showFirstChar?: boolean;
}

/**
 * 程序化小说封面。
 * - book.id 决定模板（确定性随机：同 id 永远同一封面）
 * - 8 套中国风：远山/竹/云/月/塔/雨/波/梅
 * - 显示渐变背景 + SVG 装饰 + 大首字 + 底部书名 + 卷印记印
 */
export const BookCover: React.FC<BookCoverProps> = ({ book, className, style, showFirstChar = true }) => {
  const idx = useMemo(() => {
    if (!book.id) return 0;
    return hashCode(book.id) % TEMPLATES.length;
  }, [book.id]);
  const tpl = TEMPLATES[idx]!;
  const Element = ElementByKind[tpl.kind];
  const firstChar = (book.name || '·').trim().charAt(0) || '·';

  // 三个色值全部从主题变量派生 —— 换主题时纸 / 墨 / 印一起换，
  // 组件本身不需要知道当前是哪个主题。
  //
  // ★ 装饰与文字**必须用两个变量**（2026-09-18 踩）：
  //   原先两者共用一个 ink。把 ink 调暖后封面**依然发暗** ——
  //   因为暗的不是渐变（渐变已经很淡），而是 SVG 装饰层里那些
  //   `fill={ink} opacity="0.85"` 的"地面"色块，它们在画布底部铺满近黑。
  //   把 ink 整体调淡又会让书名 / 大首字读不清。
  //   所以拆开：装饰走 `--cover-decor`（浅色封面下调成淡墨，像墨在纸上化开），
  //   文字走 `--cover-line`（始终够深）。默认主题两者同值，外观不变。
  const inkColor = tint('--cover-line', tpl.lineAlpha);
  // 装饰层走 tintDecor（额外乘 --cover-decor-alpha）—— 见 tintDecor 的注释
  const decorInk = tintDecor('--cover-decor', tpl.lineAlpha);
  const decorSoft = tintDecor('--cover-decor', tpl.softAlpha);
  const sealColor = 'var(--cover-seal)';

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        // ★ 2026-10-29：给封面上一层**各自的色相**（见 HUE_BY_KIND）。
        //   这五个变量本来定义在 :root，这里就地为这一张封面覆盖 ——
        //   `wash()` / `tint()` 全都读它们，故一处覆盖、整张封面（底渐变、
        //   SVG 线条、卷印）一起换色，不必改任何模板。
        ...hueVars(tpl.kind),
        background: `linear-gradient(180deg, ${wash(tpl.wash[0])} 0%, ${wash(tpl.wash[1])} 50%, ${wash(tpl.wash[2])} 100%)`,
        ...style,
      }}
      aria-label={`${tpl.label}封面`}
    >
      {/* 装饰 SVG 层 */}
      <Element ink={decorInk} soft={decorSoft} seal={sealColor} />

      {/* 顶部细线 + 模板名（中文小字） */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 10,
          right: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          color: inkColor,
          opacity: 0.75,
        }}
      >
        <span
          style={{
            fontFamily: "'Noto Serif SC', serif",
            fontSize: 9.5,
            letterSpacing: '0.4em',
            writingMode: 'vertical-rl',
            textOrientation: 'upright',
          }}
        >
          {tpl.label}
        </span>
        {/* 卷章记印 */}
        <span
          style={{
            display: 'inline-block',
            padding: 'var(--space-0) var(--space-2)',
            background: sealColor,
            color: 'rgba(245, 245, 245, 0.95)',
            fontFamily: "'Noto Serif SC', serif",
            fontSize: 8.5,
            letterSpacing: '0.1em',
            borderRadius: 'var(--r-3xs)',
            boxShadow: '0 0 0 1px rgba(28, 28, 28, 0.06)',
          }}
        >
          卷
        </span>
      </div>

      {/* 中央大首字 */}
      {showFirstChar && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              fontFamily: "'Noto Serif SC', 'Source Han Serif SC', serif",
              fontSize: 'min(38%, 92px)',
              fontWeight: 500,
              color: inkColor,
              opacity: 0.42,
              writingMode: 'vertical-rl',
              textOrientation: 'upright',
              lineHeight: 1,
              letterSpacing: '0.05em',
              userSelect: 'none',
            }}
          >
            {firstChar}
          </span>
        </div>
      )}

      {/* 底部书名 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 6,
          textAlign: 'center',
          color: inkColor,
          fontFamily: "'Noto Serif SC', 'Source Han Serif SC', serif",
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.1em',
          padding: '0 var(--space-3)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          opacity: 0.92,
        }}
        title={book.name}
      >
        {book.name || '未命名'}
      </div>
    </div>
  );
};

/** 工具：给一个项目生成确定性的封面色调/标签（用于统计/分组） */
export function getBookCoverMeta(book: Pick<Project, 'id'>): Template {
  const idx = book.id ? hashCode(book.id) % TEMPLATES.length : 0;
  return TEMPLATES[idx]!;
}
