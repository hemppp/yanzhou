// ============================================================
// mapProjection — 经纬度 ↔ 地图世界坐标（0-100 百分比）
// 服务端 location-coords-service 的虚拟世界边界是
// 纬度 ±60、经度 ±170，这里必须与它保持一致，否则地点会被
// 硬夹到地图边缘（这正是旧版所有标记挤在右上角的原因）。
// 地图是正投平面：北在上，所以纬度越大 y 越小。
// ============================================================

export const MAP_BOUNDS = {
  minLat: -60,
  maxLat: 60,
  minLng: -170,
  maxLng: 170,
} as const;

export interface MapWorldPoint {
  x: number;
  y: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 经纬度 → 世界坐标百分比（x: 西→东 0-100，y: 北→南 0-100） */
export function geoToWorld(latitude: number, longitude: number): MapWorldPoint {
  return {
    x:
      clamp01((longitude - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng)) * 100,
    y:
      clamp01((MAP_BOUNDS.maxLat - latitude) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * 100,
  };
}

/** 世界坐标百分比 → 经纬度（右键加点 / 拖拽落点写库时用） */
export function worldToGeo(x: number, y: number): { latitude: number; longitude: number } {
  const u = clamp01(x / 100);
  const v = clamp01(y / 100);
  return {
    longitude: MAP_BOUNDS.minLng + u * (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng),
    latitude: MAP_BOUNDS.maxLat - v * (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat),
  };
}
