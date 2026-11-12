// ============================================================
// flatMap — 二维平面世界地图引擎
// 项目种子 → 确定性的大陆 / 岛屿 / 湖泊闭合轮廓（极坐标谐波扰动）。
// Canvas 按「纸面地图」平涂渲染：海面、经纬网、平面陆块、
// 双层海岸描边、纸纹与罗盘。没有高度场、没有光照、没有透视。
// ============================================================

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapRing {
  /** 闭合轮廓，世界坐标 0-100（x 对应经度，y 对应纬度） */
  points: MapPoint[];
}

export interface WorldMap {
  land: MapRing[];
  islands: MapRing[];
  lakes: MapRing[];
}

type Theme = 'light' | 'dark';

/**
 * 地图配色：Canvas 与 DOM 图例共用。
 * ⚠️ canvas 解析不了 CSS 变量，这里必须是可独立解析的完整颜色。
 */
export const FLAT_MAP_PALETTE = {
  light: {
    sea: 'hsl(0 0% 96%)',
    land: 'hsl(0 0% 85%)',
    coast: 'hsl(0 0% 36%)',
    coastHalo: 'hsl(0 0% 36% / 0.18)',
    grid: 'hsl(0 0% 0% / 0.05)',
    frame: 'hsl(0 0% 0% / 0.16)',
  },
  dark: {
    sea: 'hsl(0 0% 11%)',
    land: 'hsl(0 0% 24%)',
    coast: 'hsl(0 0% 68%)',
    coastHalo: 'hsl(0 0% 75% / 0.14)',
    grid: 'hsl(0 0% 100% / 0.055)',
    frame: 'hsl(0 0% 100% / 0.14)',
  },
} as const;

const TAU = Math.PI * 2;

/** djb2 变种确定性哈希 */
export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** mulberry32 伪随机数生成器（确定性） */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一块不规则闭合轮廓：
 * 半径由 4 组不同频率的正弦波叠加，低频制造半岛与海湾，
 * 高频给海岸线一点碎边。roughness 越大越崎岖。
 */
function blob(
  cx: number,
  cy: number,
  radius: number,
  rng: () => number,
  roughness = 1,
): MapRing {
  const waves = [
    { freq: 2 + Math.floor(rng() * 2), amp: (0.05 + rng() * 0.05) * roughness, phase: rng() * TAU },
    { freq: 3 + Math.floor(rng() * 2), amp: (0.035 + rng() * 0.04) * roughness, phase: rng() * TAU },
    { freq: 5 + Math.floor(rng() * 3), amp: (0.018 + rng() * 0.022) * roughness, phase: rng() * TAU },
    { freq: 9 + Math.floor(rng() * 5), amp: (0.006 + rng() * 0.01) * roughness, phase: rng() * TAU },
  ];

  const samples = 96;
  const points: MapPoint[] = [];
  for (let i = 0; i < samples; i++) {
    const th = (i / samples) * TAU;
    let r = 1;
    for (const w of waves) r += w.amp * Math.sin(w.freq * th + w.phase);
    r = Math.max(0.35, r) * radius;
    points.push({ x: cx + Math.cos(th) * r, y: cy + Math.sin(th) * r });
  }
  return { points };
}

/**
 * 依据种子生成整张世界版图。
 * 大陆、岛屿、湖泊都用同一随机流顺序生成，所以同一种子输出完全一致。
 */
export function makeWorldMap(seed: string): WorldMap {
  const rng = mulberry32(hashString(seed));
  const rand = (a: number, b: number) => a + rng() * (b - a);

  // ---- 大陆：3-4 块，中心互斥，避免轮廓叠在一起 ----
  const landSeeds: { x: number; y: number; r: number }[] = [];
  const wantLand = 3 + Math.floor(rng() * 2);
  for (let attempt = 0; attempt < 400 && landSeeds.length < wantLand; attempt++) {
    const candidate = { x: rand(18, 82), y: rand(20, 80), r: rand(10, 16) };
    const clear = landSeeds.every(
      (s) => Math.hypot(s.x - candidate.x, s.y - candidate.y) > (s.r + candidate.r) * 1.3 + 4,
    );
    if (clear) landSeeds.push(candidate);
  }
  const land = landSeeds.map((s) => blob(s.x, s.y, s.r, rng, 1));

  // ---- 湖泊：落在陆块内部，用海色填充 ----
  const lakes: MapRing[] = [];
  for (const s of landSeeds) {
    if (rng() > 0.55) continue;
    const ang = rand(0, TAU);
    const dist = rand(0, s.r * 0.28);
    lakes.push(
      blob(s.x + Math.cos(ang) * dist, s.y + Math.sin(ang) * dist, rand(1.2, 2.6), rng, 0.55),
    );
  }

  // ---- 近海岛屿：必须完全落在所有陆块与已有岛屿之外 ----
  const islands: MapRing[] = [];
  const islandSeeds: { x: number; y: number; r: number }[] = [];
  const wantIslands = 3 + Math.floor(rng() * 3);
  for (let attempt = 0; attempt < 500 && islands.length < wantIslands; attempt++) {
    const candidate = { x: rand(6, 94), y: rand(6, 94), r: rand(1.3, 3.2) };
    const clearOfLand = landSeeds.every(
      (s) => Math.hypot(s.x - candidate.x, s.y - candidate.y) > s.r * 1.32 + candidate.r * 1.3 + 3,
    );
    const clearOfIslands = islandSeeds.every(
      (s) => Math.hypot(s.x - candidate.x, s.y - candidate.y) > s.r + candidate.r + 3,
    );
    if (!clearOfLand || !clearOfIslands) continue;
    islandSeeds.push(candidate);
    islands.push(blob(candidate.x, candidate.y, candidate.r, rng, 0.85));
  }

  return { land, islands, lakes };
}

/** 用中点二次贝塞尔把折线轮廓画得平滑（避免大屏上的多边形棱角） */
function traceRing(
  ctx: CanvasRenderingContext2D,
  ring: MapRing,
  sx: number,
  sy: number,
): void {
  const pts = ring.points;
  const n = pts.length;
  if (n < 3) return;
  const at = (i: number) => pts[(i + n) % n]!;
  const midX = (a: MapPoint, b: MapPoint) => ((a.x + b.x) / 2) * sx;
  const midY = (a: MapPoint, b: MapPoint) => ((a.y + b.y) / 2) * sy;

  ctx.beginPath();
  ctx.moveTo(midX(at(0), at(1)), midY(at(0), at(1)));
  for (let i = 1; i <= n; i++) {
    const cur = at(i);
    const next = at(i + 1);
    ctx.quadraticCurveTo(cur.x * sx, cur.y * sy, midX(cur, next), midY(cur, next));
  }
  ctx.closePath();
}

/** 96×96 的稀疏噪点贴图（按主题缓存），平铺后给纯色块一点纸面颗粒 */
const grainTiles: Partial<Record<Theme, HTMLCanvasElement>> = {};

function grainPattern(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
): CanvasPattern | null {
  let tile = grainTiles[theme];
  if (!tile) {
    const size = 96;
    tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const octx = tile.getContext('2d');
    if (!octx) return null;

    const img = octx.createImageData(size, size);
    const rng = mulberry32(0x5eed1234);
    const ink = theme === 'light' ? 0 : 255;
    for (let i = 0; i < size * size; i++) {
      const o = i * 4;
      img.data[o] = ink;
      img.data[o + 1] = ink;
      img.data[o + 2] = ink;
      img.data[o + 3] = rng() < 0.45 ? Math.floor(rng() * 34) : 0;
    }
    octx.putImageData(img, 0, 0);
    grainTiles[theme] = tile;
  }
  return ctx.createPattern(tile, 'repeat');
}

export interface MapView {
  /** 缩放倍数（1 = 世界坐标 0-100 正好铺满视口） */
  zoom: number;
  /** 屏幕像素平移 */
  tx: number;
  ty: number;
}

export interface FlatMapRenderOptions {
  /** CSS 像素宽 */
  width: number;
  /** CSS 像素高 */
  height: number;
  dpr: number;
  map: WorldMap;
  theme: Theme;
  view: MapView;
}

/**
 * 把平面版图绘制到 canvas：
 * 海面 → 经纬网 → 陆块/岛屿/湖泊平涂 → 纸纹 → 图框 → 罗盘。
 */
export function renderFlatMap(canvas: HTMLCanvasElement, opts: FlatMapRenderOptions): void {
  const { width, height, dpr, map, theme, view } = opts;
  const pal = FLAT_MAP_PALETTE[theme];
  const zoom = Math.max(0.2, view.zoom);

  const pixelW = Math.max(1, Math.round(width * dpr));
  const pixelH = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelW) canvas.width = pixelW;
  if (canvas.height !== pixelH) canvas.height = pixelH;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const sx = width / 100;
  const sy = height / 100;
  // 线宽反向补偿缩放，海岸线在任意倍率下都保持同样的"墨线粗细"
  const hairline = 1 / zoom;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1) 海面铺满视口：平移露出画布外时看到的也应该是海
  ctx.fillStyle = pal.sea;
  ctx.fillRect(0, 0, width, height);

  // 2) 地图内容：世界坐标 → 屏幕 = 基坐标 × zoom + 平移
  ctx.save();
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * view.tx, dpr * view.ty);

  // 经纬网：画在陆块下方，只有海面能看见
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = hairline;
  ctx.beginPath();
  for (let i = 1; i < 10; i++) {
    ctx.moveTo(i * 10 * sx, 0);
    ctx.lineTo(i * 10 * sx, height);
    ctx.moveTo(0, i * 10 * sy);
    ctx.lineTo(width, i * 10 * sy);
  }
  ctx.stroke();

  // 平涂轮廓：先填充，再描一道淡墨晕，最后压一条实线海岸
  const paintRing = (ring: MapRing, fill: string, lineWidth: number) => {
    traceRing(ctx, ring, sx, sy);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = pal.coastHalo;
    ctx.lineWidth = lineWidth * 3.2;
    ctx.stroke();
    ctx.strokeStyle = pal.coast;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };

  map.land.forEach((ring) => paintRing(ring, pal.land, 1.25 * hairline));
  map.islands.forEach((ring) => paintRing(ring, pal.land, 1 * hairline));
  map.lakes.forEach((ring) => paintRing(ring, pal.sea, 0.9 * hairline));

  ctx.restore();

  // 3) 纸纹（屏幕空间，叠在色块上；图框与罗盘之前，保持细线清晰）
  const grain = grainPattern(ctx, theme);
  if (grain) {
    ctx.save();
    ctx.globalAlpha = theme === 'light' ? 0.5 : 0.55;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // 4) 图框（视口框，不随地图平移）
  ctx.strokeStyle = pal.frame;
  ctx.lineWidth = 1;
  ctx.strokeRect(6.5, 6.5, Math.max(0, width - 13), Math.max(0, height - 13));

  // 5) 罗盘（右下角）
  const cx = width - 32;
  const cy = height - 36;
  const r = 13;
  ctx.save();
  ctx.globalAlpha = theme === 'light' ? 0.55 : 0.6;
  ctx.strokeStyle = pal.coast;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();
  // 北针：实心；南针：空心
  ctx.fillStyle = pal.coast;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r + 3);
  ctx.lineTo(cx - 3.4, cy + 1);
  ctx.lineTo(cx, cy - 1.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy + r - 3);
  ctx.lineTo(cx + 3.4, cy - 1);
  ctx.lineTo(cx, cy + 1.5);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = pal.coast;
  ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - r - 7);
  ctx.restore();
}
