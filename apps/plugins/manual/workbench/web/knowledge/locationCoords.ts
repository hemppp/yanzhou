// ============================================================
// locationCoords — 给「还没有坐标」的地点分配虚拟世界坐标
// 从 useAutoEntityDetection 抽出：章节自动扫描与地图上的
// 「AI 识别地点」托底都走同一套算法，避免两处规则漂移。
//
// 策略：
// 1. 不同世界的地图分配到不同区域
// 2. 同一世界内按章节顺序摊开，同章节出现的地点聚簇
// 3. 已有坐标的地点不动
// ============================================================

import type { Location } from '@novel/shared';
import { MAP_BOUNDS } from './mapProjection';

interface CoordCluster {
  centerLat: number;
  centerLng: number;
  radius: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 简单的确定性哈希（djb2 变种），将字符串映射为 [0,1) 的伪随机数 */
function deterministicFraction(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 10000) / 10000;
}

function clampLat(v: number): number {
  return Math.max(MAP_BOUNDS.minLat, Math.min(MAP_BOUNDS.maxLat, v));
}

function clampLng(v: number): number {
  return Math.max(MAP_BOUNDS.minLng, Math.min(MAP_BOUNDS.maxLng, v));
}

/** 虚拟地图区域：中心 + 半径（单位：经纬度） */
const REGIONS: CoordCluster[] = [
  { centerLat: -30, centerLng: -120, radius: 40 },
  { centerLat: -30, centerLng: 120, radius: 40 },
  { centerLat: 30, centerLng: -120, radius: 40 },
  { centerLat: 30, centerLng: 120, radius: 40 },
  { centerLat: 0, centerLng: 0, radius: 50 },
  { centerLat: -50, centerLng: 0, radius: 30 },
  { centerLat: 0, centerLng: -60, radius: 30 },
  { centerLat: 0, centerLng: 60, radius: 30 },
];

/**
 * 为无坐标的地点分配虚拟地图坐标。
 * 只处理「在文中被检测到」的地点（有出现章节），避免空地点堆到地图上。
 */
export function assignAutoCoords(
  locations: Location[],
  updateLocationFn: (id: string, updates: Partial<Location>) => void,
): void {
  const withoutCoords = locations.filter(
    (l) => (l.latitude == null || l.longitude == null) && l.chapters.length > 0,
  );
  if (withoutCoords.length === 0) return;

  // 按世界分组（多世界/穿越小说支持），没有世界的按章节分组
  const worldGroups = new Map<string, Location[]>();
  const chapterGroups = new Map<number, Location[]>();

  for (const loc of withoutCoords) {
    if (loc.world) {
      const list = worldGroups.get(loc.world) || [];
      list.push(loc);
      worldGroups.set(loc.world, list);
    } else {
      const order = loc.chapters[0] ?? 1;
      const list = chapterGroups.get(order) || [];
      list.push(loc);
      chapterGroups.set(order, list);
    }
  }

  const usedRegions = new Set<number>();
  let groupIdx = 0;

  // 先处理有世界的分组（每个世界占一个区域）
  for (const [world, group] of worldGroups) {
    const regionIdx = groupIdx % REGIONS.length;
    usedRegions.add(regionIdx);
    const region = REGIONS[regionIdx % REGIONS.length] ?? REGIONS[0]!;
    if (!region) continue;
    const angleStep = (2 * Math.PI) / Math.max(group.length, 1);

    group.forEach((loc, i) => {
      const angle = angleStep * i + deterministicFraction(`world:${world}`) * 0.5;
      const d = deterministicFraction(`loc:${loc.id}`);
      const dist = region.radius * (0.3 + d * 0.7);
      const lat = region.centerLat + dist * Math.cos(angle);
      const lng = region.centerLng + dist * Math.sin(angle);
      updateLocationFn(loc.id, {
        latitude: clampLat(lat),
        longitude: clampLng(lng),
        mapZoom: 8,
        updatedAt: Date.now(),
      });
    });
    groupIdx++;
  }

  // 再处理无世界的（按章节轮转）
  for (const [order, group] of chapterGroups) {
    let regionIdx = (order - 1 + groupIdx) % REGIONS.length;
    for (let offset = 0; offset < REGIONS.length; offset++) {
      const idx = (regionIdx + offset) % REGIONS.length;
      if (!usedRegions.has(idx)) {
        regionIdx = idx;
        break;
      }
    }
    usedRegions.add(regionIdx);

    const region = REGIONS[regionIdx % REGIONS.length] ?? REGIONS[0]!;
    if (!region) continue;
    const angleStep = (2 * Math.PI) / Math.max(group.length, 1);

    group.forEach((loc, i) => {
      const angle = angleStep * i + order * 0.5;
      const d = deterministicFraction(`loc:${loc.id}`);
      const dist = region.radius * (0.3 + d * 0.7);
      const lat = region.centerLat + dist * Math.cos(angle);
      const lng = region.centerLng + dist * Math.sin(angle);
      updateLocationFn(loc.id, {
        latitude: clamp(lat, MAP_BOUNDS.minLat, MAP_BOUNDS.maxLat),
        longitude: clamp(lng, MAP_BOUNDS.minLng, MAP_BOUNDS.maxLng),
        mapZoom: 8,
        updatedAt: Date.now(),
      });
    });
  }
}
