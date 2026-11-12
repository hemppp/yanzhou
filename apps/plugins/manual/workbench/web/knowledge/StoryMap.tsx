// ============================================================
// StoryMap — 二维平面世界地图
// 版图由项目种子确定性地生成（见 flatMap.ts）：海面、经纬网、
// 平涂陆块与海岸线；标注层为 DOM/SVG 覆盖。
// latitude/longitude 字段复用为世界坐标百分比 (y/x, 0-100)。
// ============================================================

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLocationStore, useCharacterStore, useTimelineStore, useChapterStore } from '@novel-plugins/data-core/stores';
import { useCurrentProjectId } from '@novel-plugins/data-core/hooks/useCurrentProjectId';
import { nanoid } from 'nanoid';
import { MapPin, Trash2, RefreshCw, Plus, Minus, RotateCcw, Sparkles, Loader2 } from 'lucide-react';
import type { Location } from '@novel/shared';
import { ErrorBoundary, useThemeStore } from '@novel-plugins/ui-kit';
import { makeWorldMap, renderFlatMap, hashString, FLAT_MAP_PALETTE, type MapView } from './flatMap';
import { geoToWorld, worldToGeo } from './mapProjection';
import {
  MAX_LOCATION_SCAN_CHAPTERS,
  recognizeLocations,
  type LocationScanProgress,
} from './recognizeLocations';

/** 将字符串确定性映射为 [0,1)（用于角色/事件小标记的固定偏移） */
function deterministicFraction(seed: string): number {
  return (hashString(seed) % 10000) / 10000;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
/** 地图可以拖出视口的余量（占视口比例），保证平移手感不是"完全拖不动" */
const PAN_MARGIN = 0.35;

/**
 * Location → 世界坐标百分比。
 * ⚠️ 库里存的是经纬度（服务端虚拟世界 lat ±60 / lng ±170），
 * 不是 0-100 的百分比——直接 clamp 会把所有地点压到右上角。
 */
function worldOf(loc: Location): { x: number; y: number } {
  return geoToWorld(loc.latitude ?? 0, loc.longitude ?? 0);
}

/** 图例：平面地图只有陆/海两档，其余两项说明两种小标记 */
function legendFor(theme: 'light' | 'dark') {
  const pal = FLAT_MAP_PALETTE[theme];
  return [
    { label: '陆地', color: pal.land },
    { label: '海洋', color: pal.sea },
    { label: '角色', color: 'hsl(var(--primary) / 0.55)' },
    { label: '事件', color: 'rgb(245 158 11 / 0.7)' },
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

  // 地图视图（缩放 + 平移）。用 ref 同步一份，供 pointermove / wheel 读取最新值
  const [view, setView] = useState<MapView>({ zoom: 1, tx: 0, ty: 0 });
  const viewRef = useRef<MapView>(view);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
  } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  // AI 地点托底识别（逐章扫描，进度可中止）
  const [aiScanning, setAiScanning] = useState(false);
  const [aiProgress, setAiProgress] = useState<LocationScanProgress>({ done: 0, total: 0 });
  const aiAbortRef = useRef<AbortController | null>(null);
  // ★ 结果就地显示：dispatchToastEvent 在 Web 壳里没有监听方（发了也看不见）
  const [aiNote, setAiNote] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | null>(
    null,
  );
  const aiNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const projectId = useCurrentProjectId();
  // 用真实的主题 store：顶栏「夜间」只切 <html>.dark，工作台旧的 isDark 字段从不更新
  const isDark = useThemeStore((s) => s.mode === 'dark');

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

  // ---- 视图控制：滚轮缩放 / 拖拽平移 / 复位 ----
  const applyView = useCallback((next: MapView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const clampView = useCallback(
    (v: MapView): MapView => {
      const w = viewSize.w;
      const h = viewSize.h;
      const zoom = clamp(v.zoom, MIN_ZOOM, MAX_ZOOM);
      return {
        zoom,
        tx: clamp(v.tx, w * (1 - zoom) - w * PAN_MARGIN, w * PAN_MARGIN),
        ty: clamp(v.ty, h * (1 - zoom) - h * PAN_MARGIN, h * PAN_MARGIN),
      };
    },
    [viewSize.w, viewSize.h],
  );

  /** 屏幕坐标（clientX/Y）→ 世界坐标百分比 */
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      const v = viewRef.current;
      const w = viewSize.w || 1;
      const h = viewSize.h || 1;
      if (!el) return { x: 50, y: 50 };
      const rect = el.getBoundingClientRect();
      return {
        x: ((clientX - rect.left - v.tx) / v.zoom / w) * 100,
        y: ((clientY - rect.top - v.ty) / v.zoom / h) * 100,
      };
    },
    [viewSize.w, viewSize.h],
  );

  // 控件上的按下不触发平移（否则 pointer capture 会吞掉按钮的 click）
  const handleMapPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, textarea, a, [role="dialog"]')) return;
    const el = containerRef.current;
    if (!el) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 指针捕获不可用时降级为普通事件流 */
    }
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTx: viewRef.current.tx,
      startTy: viewRef.current.ty,
    };
    setIsPanning(true);
  }, []);

  const handleMapPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current;
      if (!pan || pan.pointerId !== e.pointerId) return;
      applyView(
        clampView({
          zoom: viewRef.current.zoom,
          tx: pan.startTx + (e.clientX - pan.startX),
          ty: pan.startTy + (e.clientY - pan.startY),
        }),
      );
    },
    [applyView, clampView],
  );

  const endPan = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
  }, []);

  // React 的 onWheel 是 passive 的，必须挂原生监听才能 preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 0.5) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const cur = viewRef.current;
      const zoom = clamp(cur.zoom * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      if (zoom === cur.zoom) return;
      const k = zoom / cur.zoom;
      applyView(
        clampView({
          zoom,
          // 以光标为锚点缩放：光标下的世界点保持不动
          tx: px - (px - cur.tx) * k,
          ty: py - (py - cur.ty) * k,
        }),
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyView, clampView]);

  const zoomAtCenter = useCallback(
    (factor: number) => {
      const cur = viewRef.current;
      const zoom = clamp(cur.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (zoom === cur.zoom) return;
      const k = zoom / cur.zoom;
      const cx = viewSize.w / 2;
      const cy = viewSize.h / 2;
      applyView(clampView({ zoom, tx: cx - (cx - cur.tx) * k, ty: cy - (cy - cur.ty) * k }));
    },
    [applyView, clampView, viewSize.w, viewSize.h],
  );

  const resetView = useCallback(
    () => applyView({ zoom: 1, tx: 0, ty: 0 }),
    [applyView],
  );

  // 容器尺寸变化后重新夹取，避免平移量落在旧边界外
  useEffect(() => {
    if (viewSize.w < 10 || viewSize.h < 10) return;
    applyView(clampView(viewRef.current));
  }, [viewSize, applyView, clampView]);

  // 切项目时回到全图
  useEffect(() => {
    applyView({ zoom: 1, tx: 0, ty: 0 });
  }, [projectId, applyView]);

  // ---- 平面版图：项目种子 + 重掷计数 → 确定性世界 ----
  const worldMap = useMemo(
    () => makeWorldMap(`${projectId ?? 'world'}#${seedBump}`),
    [projectId, seedBump],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewSize.w < 10 || viewSize.h < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderFlatMap(canvas, {
      width: viewSize.w,
      height: viewSize.h,
      dpr,
      map: worldMap,
      theme: isDark ? 'dark' : 'light',
      view,
    });
  }, [worldMap, isDark, viewSize, view]);

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
    if (!containerRef.current || !projectId) return;
    e.preventDefault();
    const p = screenToWorld(e.clientX, e.clientY);
    setPendingPosition({
      x: clamp(p.x, 0, 100),
      y: clamp(p.y, 0, 100),
    });
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [projectId, screenToWorld]);

  const confirmAddLocation = useCallback(() => {
    if (!pendingPosition || !projectId) return;
    const name = nameInputRef.current?.value.trim();
    if (!name) {
      setPendingPosition(null);
      return;
    }
    // 地图世界坐标是百分比，库里存的是经纬度
    const geo = worldToGeo(pendingPosition.x, pendingPosition.y);
    const newLoc: Location = {
      id: nanoid(),
      projectId,
      name,
      description: '',
      latitude: geo.latitude,
      longitude: geo.longitude,
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
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 指针捕获不可用时降级为直接跟随事件流
    }
    dragIdRef.current = loc.id;
  }, []);

  const moveDrag = useCallback(
    (e: React.PointerEvent, loc: Location) => {
      if (dragIdRef.current !== loc.id) return;
      const p = screenToWorld(e.clientX, e.clientY);
      const x = clamp(p.x, 0, 100);
      const y = clamp(p.y, 0, 100);
      dragPosRef.current = { x, y };
      setDragPos({ id: loc.id, x, y });
    },
    [screenToWorld],
  );

  const endDrag = useCallback(
    (loc: Location) => {
      if (dragIdRef.current !== loc.id) return;
      dragIdRef.current = null;
      const pos = dragPosRef.current;
      dragPosRef.current = null;
      setDragPos(null);
      if (pos) {
        const geo = worldToGeo(pos.x, pos.y);
        updateLocationWithTimestamp(loc.id, {
          latitude: geo.latitude,
          longitude: geo.longitude,
        });
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

  // ---- AI 托底识别地点 ----
  const showAiNote = useCallback(
    (kind: 'info' | 'success' | 'error', text: string) => {
      setAiNote({ kind, text });
      if (aiNoteTimerRef.current) clearTimeout(aiNoteTimerRef.current);
      aiNoteTimerRef.current = setTimeout(() => setAiNote(null), kind === 'error' ? 8000 : 5500);
    },
    [],
  );

  const handleAiRecognizeLocations = useCallback(async () => {
    // 识别中再次点击 = 停止
    if (aiScanning) {
      aiAbortRef.current?.abort();
      return;
    }
    if (!projectId) return;

    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiScanning(true);
    setAiProgress({ done: 0, total: 0 });

    try {
      const result = await recognizeLocations({
        projectId,
        signal: controller.signal,
        onProgress: setAiProgress,
      });

      const summary = [
        result.created > 0 ? `新增 ${result.created} 个地点` : '',
        result.linked > 0 ? `补全 ${result.linked} 处章节关联` : '',
      ]
        .filter(Boolean)
        .join('，');

      if (result.error) {
        showAiNote(
          'error',
          `AI 识别中断：${result.error.slice(0, 80)}${summary ? `（已${summary}）` : ''}`,
        );
      } else if (result.aborted) {
        showAiNote('info', summary ? `已停止识别：${summary}` : '已停止识别');
      } else if (result.chapters === 0) {
        showAiNote('info', '没有可扫描的章节内容');
      } else if (summary) {
        showAiNote('success', `AI 识别完成：${summary}（扫描 ${result.chapters} 章）`);
      } else {
        showAiNote('info', `AI 识别完成：没有发现新地点（扫描 ${result.chapters} 章）`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showAiNote('error', `AI 识别失败：${msg.slice(0, 100)}`);
    } finally {
      aiAbortRef.current = null;
      setAiScanning(false);
      setAiProgress({ done: 0, total: 0 });
    }
  }, [aiScanning, projectId, showAiNote]);

  // 面板卸载时中止在飞的识别请求 + 清掉提示定时器
  useEffect(
    () => () => {
      aiAbortRef.current?.abort();
      if (aiNoteTimerRef.current) clearTimeout(aiNoteTimerRef.current);
    },
    [],
  );

  const getChapterInfo = useCallback(
    (chapterOrder: number) => {
      const ch = chapters.find((c) => c.order === chapterOrder);
      return ch ? `第${chapterOrder}章 ${ch.title}` : `第${chapterOrder}章`;
    },
    [chapters],
  );

  const legend = legendFor(isDark ? 'dark' : 'light');
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
            <p className="text-[10px] text-muted-foreground mt-1">拖拽平移 · 滚轮缩放 · 右键添加</p>
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

        {/* 平面地图画布 + 标注层 */}
        <div
          ref={containerRef}
          className={`flex-1 relative overflow-hidden select-none touch-none ${
            isPanning ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          role="application"
          aria-label="故事世界平面地图，拖拽平移，滚轮缩放，右键点击添加地点标记"
          onContextMenu={handleContextMenu}
          onPointerDown={handleMapPointerDown}
          onPointerMove={handleMapPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full animate-fade-in"
            role="img"
            aria-label="由项目种子确定性生成的二维平面世界地图"
          />

          {/* 标注层：随地图一起平移/缩放，标记本身反向缩放保持大小 */}
          <div
            className="absolute inset-0"
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`,
              transformOrigin: '0 0',
              willChange: 'transform',
            }}
          >
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
                    vectorEffect="non-scaling-stroke"
                    style={{ stroke: 'hsl(var(--primary))', strokeOpacity: 0.3 }}
                  />
                ))}
              </svg>
            )}

            {/* 角色小标记 */}
            {charDots.map((dot) => (
              <div
                key={`c-${dot.id}`}
                className="absolute w-[9px] h-[9px] rounded-full border border-background shadow-sm pointer-events-none z-10"
                style={{
                  left: `${clamp(dot.x, 0.5, 99.5)}%`,
                  top: `${clamp(dot.y, 0.5, 99.5)}%`,
                  backgroundColor: 'hsl(var(--primary) / 0.55)',
                  transform: `translate(-50%, -50%) scale(${1 / view.zoom})`,
                  transformOrigin: '50% 50%',
                }}
                title={`${dot.label}（角色）`}
                aria-hidden="true"
              />
            ))}

            {/* 事件小标记 */}
            {eventDots.map((dot) => (
              <div
                key={`e-${dot.id}`}
                className="absolute w-[8px] h-[8px] rounded-full border border-background shadow-sm pointer-events-none z-10 bg-amber-500/70"
                style={{
                  left: `${clamp(dot.x, 0.5, 99.5)}%`,
                  top: `${clamp(dot.y, 0.5, 99.5)}%`,
                  transform: `translate(-50%, -50%) scale(${1 / view.zoom})`,
                  transformOrigin: '50% 50%',
                }}
                title={`${dot.label}（事件）`}
                aria-hidden="true"
              />
            ))}

            {/* 地点图钉 */}
            {projectLocations.map((loc) => {
              const pos = effWorld(loc);
              const isSelected = selectedLocation?.id === loc.id;
              const isDragging = dragPos?.id === loc.id;
              // 全图状态下标签彼此压字太乱：放大到 140% 以上或悬停/选中时才显示
              const showLabel = view.zoom >= 1.4 || isSelected;
              return (
                <button
                  key={loc.id}
                  type="button"
                  className={`absolute flex flex-col items-center z-20 group focus:outline-none ${
                    isDragging ? 'cursor-grabbing' : 'cursor-grab'
                  }`}
                  style={{
                    left: `${clamp(pos.x, 1.5, 98.5)}%`,
                    top: `${clamp(pos.y, 4, 99)}%`,
                    zIndex: isDragging || isSelected ? 30 : 20,
                    filter: isSelected
                      ? 'drop-shadow(0 2px 5px hsl(var(--foreground) / 0.45))'
                      : 'drop-shadow(0 1px 2px hsl(var(--foreground) / 0.3))',
                    // 反向缩放：父层放大多少，图钉就缩回多少，视觉尺寸恒定
                    transform: `translate(-50%, -100%) scale(${(isSelected ? 1.12 : 1) / view.zoom})`,
                    transformOrigin: '50% 100%',
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
                    className={`mt-0.5 max-w-[88px] truncate text-[10px] leading-3 px-1 py-px rounded-md bg-background/85 text-foreground/80 pointer-events-none select-none transition-opacity ${
                      showLabel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    {loc.name}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 视图控制 */}
          <div
            className="absolute top-3 left-3 z-40 flex items-center gap-0.5 rounded-xl bg-card/85 backdrop-blur-sm border border-border px-1 py-1 shadow-sm"
            role="group"
            aria-label="地图视图控制"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => zoomAtCenter(1.3)}
              disabled={view.zoom >= MAX_ZOOM}
              aria-label="放大"
              title="放大"
              className="p-1 rounded-lg text-foreground/70 hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
            >
              <Plus size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => zoomAtCenter(1 / 1.3)}
              disabled={view.zoom <= MIN_ZOOM}
              aria-label="缩小"
              title="缩小"
              className="p-1 rounded-lg text-foreground/70 hover:bg-muted hover:text-foreground transition-colors disabled:opacity-30 disabled:pointer-events-none"
            >
              <Minus size={12} aria-hidden="true" />
            </button>
            <span className="px-1 text-[10px] tabular-nums text-muted-foreground select-none">
              {Math.round(view.zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={resetView}
              aria-label="复位视图"
              title="复位视图"
              className="p-1 rounded-lg text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
            >
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          </div>

          {/* 首次引导提示（无地点时） */}
          {projectLocations.length === 0 && hasSized && !pendingPosition && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
              <div className="bg-card/85 backdrop-blur-sm border border-border rounded-2xl px-5 py-3 text-center shadow-lg">
                <MapPin size={28} className="mx-auto mb-1.5 text-primary/50" aria-hidden="true" />
                <p className="text-sm text-foreground/60">
                  在地图上 <strong className="text-foreground/80">右键点击</strong> 添加故事地点
                </p>
                <p className="text-[10px] text-foreground/25 mt-0.5">
                  标注小说中的城市、要塞、秘密基地…地点会落在地图上
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
            aria-label="地图图例"
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

          {/* 地图操作：AI 托底识别 + 重掷版图 */}
          <div
            className="absolute top-3 right-3 z-40 flex items-center gap-2"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={handleAiRecognizeLocations}
              title={
                aiScanning
                  ? '点击停止识别'
                  : `用 AI 扫描章节补齐地点（最多 ${MAX_LOCATION_SCAN_CHAPTERS} 章）`
              }
              aria-label={aiScanning ? '停止 AI 识别地点' : 'AI 识别地点'}
              className={`inline-flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-xl backdrop-blur-sm border transition-colors shadow-sm ${
                aiScanning
                  ? 'bg-primary/10 border-primary/40 text-primary'
                  : 'bg-card/85 border-border text-foreground/70 hover:text-foreground hover:bg-card'
              }`}
            >
              {aiScanning ? (
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles size={12} aria-hidden="true" />
              )}
              {aiScanning
                ? aiProgress.total > 0
                  ? `识别中 ${aiProgress.done}/${aiProgress.total}`
                  : '识别中…'
                : 'AI 识别地点'}
            </button>
            <button
              type="button"
              onClick={() => setSeedBump((b) => b + 1)}
              className="inline-flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-xl bg-card/85 backdrop-blur-sm border border-border text-foreground/70 hover:text-foreground hover:bg-card transition-colors shadow-sm"
              title="重新掷出一套世界版图"
            >
              <RefreshCw size={12} aria-hidden="true" />
              换个版图
            </button>
          </div>

          {/* AI 识别结果（就地提示：Web 壳没有监听 dispatchToastEvent） */}
          {aiNote && (
            <div
              className={`absolute top-12 right-3 z-40 max-w-[280px] rounded-xl border px-3 py-1.5 text-[10px] leading-relaxed shadow-sm backdrop-blur-sm ${
                aiNote.kind === 'error'
                  ? 'bg-destructive/10 border-destructive/40 text-destructive'
                  : 'bg-card/90 border-border text-foreground/75'
              }`}
              role="status"
            >
              {aiNote.text}
            </div>
          )}

          {/* 底部提示 */}
          <div
            className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground bg-background/80 px-3 py-1 rounded-full pointer-events-none select-none"
            aria-hidden="true"
          >
            拖拽平移 · 滚轮缩放 · 右键添加地点 · 拖拽标记移动
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
