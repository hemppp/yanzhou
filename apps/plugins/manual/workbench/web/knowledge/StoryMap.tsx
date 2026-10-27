// ============================================================
// StoryMap — 高斯泼溅程序化地势图
// 地势由一组随机高斯核实时泼溅生成（见 splatTerrain.ts），
// 故事地点作为"聚落"核参与塑形；标注层为 DOM/SVG 覆盖。
// latitude/longitude 字段复用为世界坐标百分比 (y/x, 0-100)。
// ============================================================

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLocationStore, useCharacterStore, useTimelineStore, useChapterStore } from '@novel-plugins/data-core/stores';
import { useUIStore } from '../../stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { nanoid } from 'nanoid';
import { MapPin, Trash2, RefreshCw } from 'lucide-react';
import type { Location } from '@novel/shared';
import { ErrorBoundary } from '@novel-plugins/ui-kit';
import { makeTerrainSplats, makeLocationSplats, renderSplatTerrain, hashString } from './splatTerrain';

/** 将字符串确定性映射为 [0,1)（用于角色/事件小标记的固定偏移） */
function deterministicFraction(seed: string): number {
  return (hashString(seed) % 10000) / 10000;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Location → 世界坐标百分比（longitude → x，latitude → y） */
function worldOf(loc: Location): { x: number; y: number } {
  return {
    x: clamp(loc.longitude ?? 50, 0, 100),
    y: clamp(loc.latitude ?? 50, 0, 100),
  };
}

/** 主题图例色板 */
function legendFor(isDark: boolean) {
  // 水墨化（2026-09-16）：地形原为彩色（#a8cde0 蓝 / #b9cc8f 绿 / #8d8776 褐 / #f2efe6 米白），
  // 与黑白水墨主题冲突。改为按「明度」区分地貌：深海最深 → 雪峰最浅。
  // ⚠️ 地貌靠明度辨认，相邻档差 ≥12% 才分得开；图例每项都带文字标签，不依赖颜色识别。
  return isDark
    ? [
        { label: '深海', color: 'hsl(0 0% 12%)' },
        { label: '浅海', color: 'hsl(0 0% 28%)' },
        { label: '平原', color: 'hsl(0 0% 44%)' },
        { label: '山地', color: 'hsl(0 0% 60%)' },
        { label: '雪峰', color: 'hsl(0 0% 82%)' },
      ]
    : [
        { label: '深海', color: 'hsl(0 0% 20%)' },
        { label: '浅海', color: 'hsl(0 0% 38%)' },
        { label: '平原', color: 'hsl(0 0% 54%)' },
        { label: '山地', color: 'hsl(0 0% 70%)' },
        { label: '雪峰', color: 'hsl(0 0% 92%)' },
      ];
}

interface WorldPoint {
  id: string;
  label: string;
  x: number;
  y: number;
}

export function StoryMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const detailInputRef = useRef<HTMLInputElement>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragPosRef = useRef<{ x: number; y: number } | null>(null);

  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [pendingPosition, setPendingPosition] = useState<{ x: number; y: number } | null>(null);
  const [seedBump, setSeedBump] = useState(0);
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null);

  const projectId = useCurrentProjectId();
  const isDark = useUIStore((s) => s.isDark);

  const locations = useLocationStore((s) => s.locations);
  const addLocation = useLocationStore((s) => s.addLocation);
  const updateLocation = useLocationStore((s) => s.updateLocation);
  const deleteLocation = useLocationStore((s) => s.deleteLocation);
  const chapters = useChapterStore((s) => s.chapters);
  const characters = useCharacterStore((s) => s.characters);
  const timelineEvents = useTimelineStore((s) => s.events);

  const updateLocationWithTimestamp = useCallback(
    (id: string, data: Partial<Location>) => {
      updateLocation(id, { ...data, updatedAt: Date.now() });
    },
    [updateLocation],
  );

  const projectLocations = useMemo(
    () => locations.filter((l) => l.projectId === projectId),
    [locations, projectId],
  );

  // ---- 容器尺寸跟踪 ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setViewSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- 地势渲染：项目种子 + 地点聚落核 → 高斯泼溅 ----
  const locSignature = useMemo(
    () => projectLocations.map((l) => `${l.id}:${l.latitude ?? 'x'},${l.longitude ?? 'x'}`).join('|'),
    [projectLocations],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !projectId || viewSize.w < 10 || viewSize.h < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const terrainSplats = makeTerrainSplats(`${projectId}#${seedBump}`);
    const locSplats = makeLocationSplats(projectLocations.map(worldOf));
    renderSplatTerrain(canvas, {
      width: viewSize.w,
      height: viewSize.h,
      dpr,
      splats: [...terrainSplats, ...locSplats],
      theme: isDark ? 'dark' : 'light',
    });
  }, [projectId, seedBump, isDark, viewSize, locSignature, projectLocations]);

  // ---- 角色小标记（挂在首个共同章节的地点旁） ----
  const charDots = useMemo<WorldPoint[]>(() => {
    const projectChars = characters.filter((c) => c.projectId === projectId);
    const dots: WorldPoint[] = [];
    for (const char of projectChars) {
      if (!char.chapters || char.chapters.length === 0) continue;
      const host = projectLocations.find((l) => l.chapters.some((ch) => char.chapters.includes(ch)));
      if (!host) continue;
      const base = worldOf(host);
      dots.push({
        id: char.id,
        label: char.name,
        x: base.x + (deterministicFraction(`${char.id}:x`) - 0.5) * 4.5,
        y: base.y + (deterministicFraction(`${char.id}:y`) - 0.5) * 4.5,
      });
    }
    return dots;
  }, [characters, projectId, projectLocations]);

  // ---- 事件小标记 ----
  const eventDots = useMemo<WorldPoint[]>(() => {
    const projectEvents = timelineEvents.filter((e) => e.projectId === projectId);
    const dots: WorldPoint[] = [];
    for (const evt of projectEvents) {
      if (evt.chapter == null) continue;
      const host = projectLocations.find((l) => l.chapters.includes(evt.chapter!));
      if (!host) continue;
      const base = worldOf(host);
      dots.push({
        id: evt.id,
        label: evt.title,
        x: base.x + (deterministicFraction(`${evt.id}:x`) - 0.5) * 3,
        y: base.y + (deterministicFraction(`${evt.id}:y`) - 0.5) * 3,
      });
    }
    return dots;
  }, [timelineEvents, projectId, projectLocations]);

  /** 拖拽中的地点使用实时位置 */
  const effWorld = useCallback(
    (loc: Location): { x: number; y: number } => {
      if (dragPos && dragPos.id === loc.id) return { x: dragPos.x, y: dragPos.y };
      return worldOf(loc);
    },
    [dragPos],
  );

  // ---- 关系连线：共享角色的地点两两相连 ----
  const connectionLines = useMemo(() => {
    const projectChars = characters.filter((c) => c.projectId === projectId);
    const lines: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    const drawnPairs = new Set<string>();
    for (const char of projectChars) {
      if (!char.chapters || char.chapters.length < 2) continue;
      const related = projectLocations.filter((l) =>
        l.chapters.some((ch) => char.chapters.includes(ch)),
      );
      for (let i = 0; i < related.length; i++) {
        for (let j = i + 1; j < related.length; j++) {
          const a = related[i]!;
          const b = related[j]!;
          const pairKey = [a.id, b.id].sort().join(':');
          if (drawnPairs.has(pairKey)) continue;
          drawnPairs.add(pairKey);
          const pa = effWorld(a);
          const pb = effWorld(b);
          lines.push({ key: pairKey, x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y });
        }
      }
    }
    return lines;
  }, [characters, projectId, projectLocations, effWorld]);

  // ---- 右键添加地点 ----
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const el = containerRef.current;
    if (!el || !projectId) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    setPendingPosition({
      x: clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100),
    });
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [projectId]);

  const confirmAddLocation = useCallback(() => {
    if (!pendingPosition || !projectId) return;
    const name = nameInputRef.current?.value.trim();
    if (!name) {
      setPendingPosition(null);
      return;
    }
    const newLoc: Location = {
      id: nanoid(),
      projectId,
      name,
      description: '',
      latitude: pendingPosition.y,
      longitude: pendingPosition.x,
      states: [],
      chapters: [],
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    addLocation(newLoc);
    setPendingPosition(null);
  }, [pendingPosition, projectId, addLocation]);

  const cancelAddLocation = useCallback(() => setPendingPosition(null), []);

  // ---- 拖拽标记 ----
  const startDrag = useCallback((e: React.PointerEvent, loc: Location) => {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 指针捕获不可用时降级为直接跟随事件流
    }
    dragIdRef.current = loc.id;
  }, []);

  const moveDrag = useCallback((e: React.PointerEvent, loc: Location) => {
    if (dragIdRef.current !== loc.id || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
    const y = clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100);
    dragPosRef.current = { x, y };
    setDragPos({ id: loc.id, x, y });
  }, []);

  const endDrag = useCallback(
    (loc: Location) => {
      if (dragIdRef.current !== loc.id) return;
      dragIdRef.current = null;
      const pos = dragPosRef.current;
      dragPosRef.current = null;
      setDragPos(null);
      if (pos) {
        updateLocationWithTimestamp(loc.id, { latitude: pos.y, longitude: pos.x });
      }
    },
    [updateLocationWithTimestamp],
  );

  // ---- 选中地点时聚焦详情 ----
  useEffect(() => {
    if (selectedLocation && detailInputRef.current) {
      requestAnimationFrame(() => detailInputRef.current?.focus());
    }
  }, [selectedLocation]);

  // ---- 删除 ----
  const handleDelete = useCallback(() => {
    if (!selectedLocation) return;
    deleteLocation(selectedLocation.id);
    setSelectedLocation(null);
  }, [selectedLocation, deleteLocation]);

  const getChapterInfo = useCallback(
    (chapterOrder: number) => {
      const ch = chapters.find((c) => c.order === chapterOrder);
      return ch ? `第${chapterOrder}章 ${ch.title}` : `第${chapterOrder}章`;
    },
    [chapters],
  );

  const legend = legendFor(isDark);
  const hasSized = viewSize.w >= 10 && viewSize.h >= 10;

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground" role="status">
        <div className="text-center">
          <MapPin size={48} className="mx-auto mb-4 opacity-50" aria-hidden="true" />
          <p className="text-sm">请先选择一个项目</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="h-full flex">
        {/* 地点列表侧栏 */}
        <aside className="w-56 border-r border-border flex flex-col shrink-0" aria-label="地点列表">
          <div className="p-3 border-b border-border">
            <div className="flex items-center gap-2">
              <MapPin size={16} className="text-foreground/60" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-foreground/80">地点标记</h2>
              <span
                className="text-xs text-muted-foreground ml-auto"
                aria-label={`共 ${projectLocations.length} 个地点`}
              >
                {projectLocations.length}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">右键地图添加 · 拖拽移动</p>
          </div>
          <nav className="flex-1 overflow-y-auto" role="list" aria-label="地点导航列表">
            {projectLocations.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground" role="status">
                暂无地点标记
                <br />
                右键地图添加
              </div>
            ) : (
              projectLocations.map((loc) => {
                const pos = effWorld(loc);
                return (
                  <button
                    key={loc.id}
                    onClick={() => setSelectedLocation(loc)}
                    role="listitem"
                    aria-current={selectedLocation?.id === loc.id ? 'true' : undefined}
                    aria-label={`选中地点 ${loc.name}`}
                    className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                      selectedLocation?.id === loc.id
                        ? 'bg-muted border-l-2 border-primary'
                        : 'hover:bg-muted/50 border-l-2 border-transparent'
                    }`}
                  >
                    <div className="w-2 h-2 rounded-full shrink-0 bg-primary" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground/80 truncate" title={loc.name}>
                        {loc.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {pos.x.toFixed(1)}, {pos.y.toFixed(1)}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </nav>
        </aside>

        {/* 地势图画布 + 标注层 */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden"
          role="application"
          aria-label="故事世界地势图，右键点击添加地点标记"
          onContextMenu={handleContextMenu}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full animate-fade-in"
            role="img"
            aria-label="由高斯泼溅算法实时生成的世界地势"
          />

          {/* 关系连线 */}
          {hasSized && connectionLines.length > 0 && (
            <svg
              className="absolute inset-0 pointer-events-none"
              width="100%"
              height="100%"
              aria-hidden="true"
            >
              {connectionLines.map((l) => (
                <line
                  key={l.key}
                  x1={`${l.x1}%`}
                  y1={`${l.y1}%`}
                  x2={`${l.x2}%`}
                  y2={`${l.y2}%`}
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                  style={{ stroke: 'hsl(var(--primary))', strokeOpacity: 0.3 }}
                />
              ))}
            </svg>
          )}

          {/* 角色小标记 */}
          {charDots.map((dot) => (
            <div
              key={`c-${dot.id}`}
              className="absolute w-[9px] h-[9px] rounded-full border border-background shadow-sm pointer-events-none z-10 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${clamp(dot.x, 0.5, 99.5)}%`, top: `${clamp(dot.y, 0.5, 99.5)}%`, backgroundColor: 'hsl(var(--primary) / 0.55)' }}
              title={`${dot.label}（角色）`}
              aria-hidden="true"
            />
          ))}

          {/* 事件小标记 */}
          {eventDots.map((dot) => (
            <div
              key={`e-${dot.id}`}
              className="absolute w-[8px] h-[8px] rounded-full border border-background shadow-sm pointer-events-none z-10 -translate-x-1/2 -translate-y-1/2 bg-amber-500/70"
              style={{ left: `${clamp(dot.x, 0.5, 99.5)}%`, top: `${clamp(dot.y, 0.5, 99.5)}%` }}
              title={`${dot.label}（事件）`}
              aria-hidden="true"
            />
          ))}

          {/* 地点图钉 */}
          {projectLocations.map((loc) => {
            const pos = effWorld(loc);
            const isSelected = selectedLocation?.id === loc.id;
            const isDragging = dragPos?.id === loc.id;
            return (
              <button
                key={loc.id}
                type="button"
                className={`absolute flex flex-col items-center -translate-x-1/2 -translate-y-full z-20 focus:outline-none ${
                  isDragging ? 'cursor-grabbing' : 'cursor-grab'
                }`}
                style={{
                  left: `${clamp(pos.x, 1.5, 98.5)}%`,
                  top: `${clamp(pos.y, 4, 99)}%`,
                  zIndex: isDragging || isSelected ? 30 : 20,
                  filter: isSelected
                    ? 'drop-shadow(0 2px 5px hsl(var(--foreground) / 0.45))'
                    : 'drop-shadow(0 1px 2px hsl(var(--foreground) / 0.3))',
                  transform: `translate(-50%, -100%) scale(${isSelected ? 1.12 : 1})`,
                  transition: isDragging ? 'none' : 'filter 0.15s',
                }}
                onClick={() => setSelectedLocation(loc)}
                onPointerDown={(e) => startDrag(e, loc)}
                onPointerMove={(e) => moveDrag(e, loc)}
                onPointerUp={() => endDrag(loc)}
                onPointerCancel={() => endDrag(loc)}
                onContextMenu={(e) => e.stopPropagation()}
                aria-label={`地点 ${loc.name}`}
                aria-pressed={isSelected}
              >
                <svg width="22" height="30" viewBox="0 0 24 32" aria-hidden="true">
                  <path
                    d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0Z"
                    style={{ fill: 'hsl(var(--primary))' }}
                    stroke="hsl(var(--background))"
                    strokeWidth="1.5"
                  />
                  <circle cx="12" cy="12" r="4.5" style={{ fill: 'hsl(var(--primary-foreground))' }} />
                </svg>
                <span
                  className="mt-0.5 max-w-[88px] truncate text-[10px] leading-3 px-1 py-px rounded-md bg-background/85 text-foreground/80 pointer-events-none select-none"
                >
                  {loc.name}
                </span>
              </button>
            );
          })}

          {/* 首次引导提示（无地点时） */}
          {projectLocations.length === 0 && hasSized && !pendingPosition && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
              <div className="bg-card/85 backdrop-blur-sm border border-border rounded-2xl px-5 py-3 text-center shadow-lg">
                <MapPin size={28} className="mx-auto mb-1.5 text-primary/50" aria-hidden="true" />
                <p className="text-sm text-foreground/60">
                  在地图上 <strong className="text-foreground/80">右键点击</strong> 添加故事地点
                </p>
                <p className="text-[10px] text-foreground/25 mt-0.5">
                  标注小说中的城市、要塞、秘密基地…地点会顶起地势
                </p>
              </div>
            </div>
          )}

          {/* 内联命名对话框 */}
          {pendingPosition && (
            <div
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border rounded-2xl p-3 shadow-xl animate-fade-in"
              role="dialog"
              aria-label="输入地点名称"
            >
              <div className="flex items-center gap-2">
                <input
                  ref={nameInputRef}
                  type="text"
                  placeholder="输入地点名称…"
                  className="w-48 px-2.5 py-1.5 text-sm bg-background border border-border rounded-[14px] outline-none focus:border-primary/50 transition-colors text-foreground"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmAddLocation();
                    if (e.key === 'Escape') cancelAddLocation();
                  }}
                />
                <button
                  onClick={confirmAddLocation}
                  className="px-3 py-1.5 text-xs rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
                >
                  确定
                </button>
                <button
                  onClick={cancelAddLocation}
                  className="px-2 py-1.5 text-xs rounded-xl hover:bg-muted text-foreground/60 transition-colors"
                >
                  取消
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">Enter 确认 · Esc 取消</p>
            </div>
          )}

          {/* 图例 */}
          <div
            className="absolute bottom-3 left-3 z-40 flex items-center gap-2.5 bg-background/70 backdrop-blur-sm border border-border/60 rounded-full px-3 py-1 pointer-events-none select-none"
            aria-label="地势图例"
          >
            {legend.map((item) => (
              <span key={item.label} className="flex items-center gap-1 text-[10px] text-foreground/50">
                <span
                  className="w-2 h-2 rounded-[3px] border border-foreground/10"
                  style={{ backgroundColor: item.color }}
                  aria-hidden="true"
                />
                {item.label}
              </span>
            ))}
          </div>

          {/* 重新生成地势 */}
          <button
            onClick={() => setSeedBump((b) => b + 1)}
            className="absolute top-3 right-3 z-40 inline-flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-xl bg-card/85 backdrop-blur-sm border border-border text-foreground/70 hover:text-foreground hover:bg-card transition-colors shadow-sm"
            title="重掷一个全新的世界地势"
          >
            <RefreshCw size={12} aria-hidden="true" />
            重新生成地势
          </button>

          {/* 底部提示 */}
          <div
            className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground bg-background/80 px-3 py-1 rounded-full pointer-events-none select-none"
            aria-hidden="true"
          >
            右键添加地点 · 拖拽移动标记 · 地势由高斯泼溅实时生成
          </div>
        </div>

        {/* 地点详情侧栏 */}
        {selectedLocation && (
          <aside
            className="w-64 border-l border-border flex flex-col shrink-0 bg-card animate-fade-in"
            aria-label={`地点详情：${selectedLocation.name}`}
            role="region"
          >
            <div className="p-3 border-b border-border">
              <div className="flex items-center gap-2">
                <MapPin size={14} className="text-primary shrink-0" aria-hidden="true" />
                <input
                  ref={detailInputRef}
                  type="text"
                  value={selectedLocation.name}
                  onChange={(e) =>
                    updateLocationWithTimestamp(selectedLocation.id, { name: e.target.value })
                  }
                  aria-label="地点名称"
                  className="flex-1 text-sm font-medium text-foreground/90 bg-transparent border-none outline-none"
                />
                <button
                  onClick={handleDelete}
                  className="p-1 rounded-xl hover:bg-destructive/20 text-destructive transition-colors"
                  aria-label={`删除地点 ${selectedLocation.name}`}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              <div className="text-xs text-muted-foreground">
                世界坐标：{effWorld(selectedLocation).x.toFixed(1)},{' '}
                {effWorld(selectedLocation).y.toFixed(1)}
              </div>

              <div>
                <label
                  htmlFor="location-description"
                  className="text-[10px] text-muted-foreground uppercase tracking-wider"
                >
                  描述
                </label>
                <textarea
                  id="location-description"
                  value={selectedLocation.description || ''}
                  onChange={(e) =>
                    updateLocationWithTimestamp(selectedLocation.id, {
                      description: e.target.value,
                    })
                  }
                  placeholder="添加地点描述..."
                  rows={3}
                  aria-label="地点描述"
                  className="w-full mt-1 px-2 py-1.5 text-sm text-foreground/80 bg-muted/50 border border-border rounded-[14px] outline-none focus:border-primary/50 resize-none transition-colors"
                />
              </div>

              {selectedLocation.chapters.length > 0 && (
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    出现章节
                  </label>
                  <div className="mt-1 flex flex-wrap gap-1" role="list" aria-label="出现章节列表">
                    {selectedLocation.chapters.map((ch) => (
                      <span
                        key={ch}
                        role="listitem"
                        className="px-1.5 py-0.5 text-[10px] rounded-xl bg-muted text-foreground/60"
                      >
                        {getChapterInfo(ch)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedLocation.tags.length > 0 && (
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    标签
                  </label>
                  <div className="mt-1 flex flex-wrap gap-1" role="list" aria-label="标签列表">
                    {selectedLocation.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 text-[10px] rounded-xl bg-primary/10 text-primary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedLocation.chapters.length === 0 && selectedLocation.tags.length === 0 && (
                <p className="text-xs text-muted-foreground text-center pt-4">暂无章节和标签信息</p>
              )}
            </div>
          </aside>
        )}
      </div>
    </ErrorBoundary>
  );
}
