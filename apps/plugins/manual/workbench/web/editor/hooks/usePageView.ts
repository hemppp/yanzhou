// ============================================================
// editor/hooks/usePageView.ts —— 章节正文「页面视图」（A4 稿纸分页）
//
// 用户口径（2026-10-26）：「章节正文要像 Word 那样分页排版」——
//   A4 纸 + 页边距 + 页码；默认就是页面视图；页与页**横向**排（第 1 页 → 第 2 页在右），
//   单页模式一次看一页、多页模式缩小一屏并排看两页。
//
// 机制（先说清，改之前务必读）：
//   断页**不靠 JS 切内容**，靠 **CSS 分栏**：把正文流设成
//   `column-width: A4 正文宽` + 定高（A4 正文高）+ `column-fill: auto`，
//   浏览器就把内容一列一列地灌满 —— 一列 = 一页，列与列之间是页缝。
//   正文因此**仍是同一篇 ProseMirror 文档**：打字、光标、选区、批注块、
//   查找替换、撤销历史全部保持原生行为，零改动（这也正是本方案的意义）。
//
//   ⚠️ 本仓「分页」一词已被 AI 工作台占用为**标签页**语义
//      （stores/workspaceStore.ts、docs/design/ui-tab-workspace-design.md）。
//      本功能在代码里一律叫 page-view / nm-page-*，UI 上叫「页面视图」。
//
// 纸规格用 mm（A4 = 210×297mm，页边距 25mm）：语义即纸张；
// 且避开间距审计对字面 px 的野值口径（见 scripts/tools/spacing-audit.mjs）。
//
// 坐标口径（本文件最容易错的地方）：
//   · 布局尺寸（scrollWidth / mm→px）都在**页带自身、未缩放**的坐标系里；
//   · 鼠标/光标给的是**视口坐标**，且在缩放下已被乘过 zoom ⇒ 必须
//     `(rect.left - stripRect.left) / zoom` 折回页带本地坐标再算页号。
//   两条口径混用会得到「翻页翻一半」这类怪现象。
// ============================================================

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** A4 纸张几何（mm）。CSS 侧同名变量见 globals.css「页面视图（稿纸分页）」段。 */
export const PAGE_MM = { w: 210, h: 297, marginMm: 25, gapMm: 10 } as const;

/** CSS 像素基准：1in = 96px ⇒ 1mm = 96/25.4px（A4 ≈ 794×1123px，与 Word 的 96dpi 一致）。 */
const MM_TO_PX = 96 / 25.4;

export const mmToPx = (mm: number): number => mm * MM_TO_PX;

/** 一张纸的横向**节距** = 纸宽 + 页缝。第 i 张纸的左缘 = i × 节距。 */
export const pagePitchPx = (): number => mmToPx(PAGE_MM.w + PAGE_MM.gapMm);

/** 正文流（.ProseMirror）的列宽 = A4 去两倍页边距。 */
export const pageContentWidthPx = (): number => mmToPx(PAGE_MM.w - 2 * PAGE_MM.marginMm);

/** 分栏列距 = 两倍页边距 + 页缝（页边距也是"缝"的一部分：纸与纸之间不能贴字）。 */
export const pageColumnGapPx = (): number => mmToPx(2 * PAGE_MM.marginMm + PAGE_MM.gapMm);

/**
 * 由内容总宽推页数。
 * 浏览器分栏后 `scrollWidth = N×列宽 + (N-1)×列距`，故：
 *   N = round((scrollWidth + 列距) / (列宽 + 列距))
 * 取整而非上取整：末列若只剩一两个像素的余量（折行取整误差），不该多出一张空页。
 */
export function pageCountOf(scrollWidth: number): number {
  const colW = pageContentWidthPx();
  const colGap = pageColumnGapPx();
  if (!Number.isFinite(scrollWidth) || scrollWidth <= 0) return 1;
  return Math.max(1, Math.round((scrollWidth + colGap) / (colW + colGap)));
}

/** 页带本地 x（未缩放布局像素）落在第几页（0 基）。 */
export function pageIndexAtX(localX: number): number {
  return Math.max(0, Math.floor(localX / pagePitchPx() + 1e-6));
}

/**
 * 缩放夹取区间。
 * 下限 0.3：**只对多页模式**生效 —— 那是"看全局的缩略"，小字可接受，
 *   而它的价值恰恰在"整页装得下"（0.5 的旧下限会让短窗口里两张纸的下沿被切掉）。
 *   单页模式恒为 1（见 fitZoom），故下限不会把写字字号缩小。
 */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 1;

const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * 视口尺寸 → 目标缩放。
 *
 *   单页：**100%，不缩放**。
 *     ★ 2026-10-26 实测口径修正（勿改回「整页自适应」）：编辑器区的实际高度常在
 *       500–900px，而 A4 是 1123px ⇒ 自适应会把字缩到 0.5 甚至更低（实测 0.43，
 *       被下限夹到 0.5）——字小到没法写，比"看不全一页"糟得多。
 *       Word 的做法也是 100% + 页内纵向滚动；要看整页/多页，用户点「多页」。
 *   多页：缩到一屏并排 `pagesPerRow` 张纸（缩小是这个模式的目的，用户点它就是要看全局）。
 *
 * 量不到宿主尺寸（首帧）时按 100% 兜底，不产生 NaN 尺寸。
 */
export function fitZoom(
  viewportW: number,
  viewportH: number,
  mode: 'single' | 'multi',
  pagesPerRow = 2,
): number {
  if (!viewportW || !viewportH) return ZOOM_MAX;
  if (mode === 'single') return ZOOM_MAX;
  const pageW = mmToPx(PAGE_MM.w);
  const pageH = mmToPx(PAGE_MM.h);
  const pitch = pagePitchPx();
  const byHeight = (viewportH - 2 * 24) / pageH; // 上下各留 24px 呼吸（与宿主内边距同量级）
  const span = (pagesPerRow - 1) * pitch + pageW; // N 张纸并排所需总宽
  const byWidth = (viewportW - 2 * 24) / span;
  return clampZoom(Math.min(ZOOM_MAX, byHeight, byWidth));
}

export interface PageViewApi {
  /** 页数（≥1）：由内容总宽换算，浏览器分栏产生的列数即页数 */
  pageCount: number;
  /** 当前可见页（0 基）：由宿主的 scrollLeft 反推，不是独立状态 */
  pageIndex: number;
  mode: 'single' | 'multi';
  setMode: (m: 'single' | 'multi') => void;
  /** 翻到第 i 页（自动夹取）；不传则原地重新对齐（内容变化后矫正用） */
  goPage: (i: number) => void;
  /** 当前缩放。单页 = 整页自适应；多页 = 一屏两页。都夹在 [ZOOM_MIN, ZOOM_MAX] */
  zoom: number;
  /** 缩放外框的内联样式（承担缩放后的真实占位尺寸，让宿主滚动条正确） */
  scaleStyle: React.CSSProperties;
  /** 页带的内联样式（未缩放的真实尺寸 + 缩放变换） */
  stripStyle: React.CSSProperties;
  /** 页带元素的 ref：调用方必须挂到 `.nm-page-strip`（div）上（坐标换算的基准） */
  stripRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * 页面视图的全部行为：量页、翻页、缩放、光标跟随。
 *
 * 只读 DOM、只写 ref/内联样式；除「页数/模式」外不进 React 状态 —— 每敲一个字都
 * 触发测量，走状态会让整棵编辑器树重渲染（本仓有过 "Maximum update depth exceeded"
 * 的前车之鉴，见 useEditorInstance.ts 的注释）。
 */
export function usePageView(opts: {
  /** 是否处于页面视图（关掉时本 hook 不挂任何监听） */
  enabled: boolean;
  /** 滚动宿主（.nm-editor-scroll-host，横向翻页就滚它） */
  hostRef: React.RefObject<HTMLElement | null>;
}): PageViewApi {
  const { enabled, hostRef } = opts;
  const [pageCount, setPageCount] = useState(1);
  const [mode, setMode] = useState<'single' | 'multi'>('single');
  const [zoom, setZoom] = useState(1);
  const [pageIndex, setPageIndex] = useState(0);

  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const countRef = useRef(1);
  countRef.current = pageCount;

  /** 页带元素（.nm-page-strip）与正文流（.ProseMirror）—— 测量与坐标换算都要它们 */
  const stripRef = useRef<HTMLDivElement | null>(null);
  /**
   * 纸的缩放比（1 = A4 原尺寸）：宿主窄于纸宽时按可用宽度等比缩小。
   * 写进页带的 `--nm-page-fit`（CSS 侧所有纸规格都乘它），同时给 JS 侧算节距用 ——
   * 两边同源，翻页/页号才不会与真实布局漂移（分屏后单栏只有 ~490px 就是这种场景）。
   */
  const fitRef = useRef(1);
  /**
   * 量宿主宽度 → 更新 fit；返回是否变化（变化时要重算页带尺寸并重挂样式）。
   *
   * ★ 关键：**每次都写一次** `--nm-page-fit` / `marginLeft`，不只在变化时写。
   *   因为页带（.nm-page-strip）会在关/开页面视图、停靠重排时**重新挂载**，
   *   新节点没有上一次的内联变量 ⇒ 若只"变化时写"，新节点会退回默认 fit=1
   *   （实测：分屏后关/开一次视图，纸就长回 794px 并横向溢出 87px）。
   *   返回值只用来决定**是否需要重算页带尺寸**（metricsTick）。
   */
  const syncFit = useCallback((): boolean => {
    const host = hostRef.current;
    const strip = stripRef.current;
    if (!host || !strip) return false;
    // 可用宽 = 内容盒宽 − 左右内边距（宿主 padding 是 var(--space-6)=16px 各一侧）− 再留 16px 余量。
    // ⚠️ clientWidth 含 padding，直接用会把纸算宽 ⇒ 横向溢出（实测分屏后多出 87px）。
    const cs = getComputedStyle(host);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const avail = host.clientWidth - padX - 16;
    const next = Math.min(1, Math.max(ZOOM_MIN, avail / mmToPx(PAGE_MM.w)));
    const changed = Math.abs(next - fitRef.current) >= 0.002;
    fitRef.current = next;
    strip.style.setProperty('--nm-page-fit', String(next));
    if (changed) setFitState(next);
    // 纸比宿主窄时居中（否则纸贴左、右边空一大块）。marginLeft 用实测的纸宽算，
    // 与 transform:scale 无关（页带未缩放宽 = 纸宽 × 页数 + 页边距）。
    const pageW = mmToPx(PAGE_MM.w) * next;
    const margin = Math.max(0, (host.clientWidth - padX - pageW) / 2);
    strip.style.marginLeft = margin > 1 ? `${margin}px` : '';
    return changed;
  }, [hostRef]);
  const rafRef = useRef(0);

  /** 量页：读正文流的 scrollWidth ⇒ 页数。只在页数变化时才进状态。 */
  const measure = useCallback(() => {
    const host = hostRef.current;
    const flow = host?.querySelector<HTMLElement>('.ProseMirror') ?? null;
    if (!flow) return;
    const n = pageCountOf(flow.scrollWidth);
    setPageCount((prev) => (prev === n ? prev : n));
  }, [hostRef]);

  /** 合并到下一帧再量（打字每帧都会触发 DOM 变更，逐次测量会打爆布局） */
  const scheduleMeasure = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      measure();
    });
  }, [measure]);

  // ---- 监听接线：**等宿主出现再挂** ----
  //
  // ⚠️ 2026-10-26 实测教训（勿改回「在依赖 effect 里直接取宿主」）：
  //   章节内容是**异步**到的 —— EditorPage 先渲染空态、拿到章节后才渲染编辑区。
  //   若在「enabled 刚变真」的那一次 effect 里就 `hostRef.current`，取到的是 null ⇒
  //   观察器一个都没挂上：页数永远停在 1、缩放永远 100%，而打字又不报错 ——
  //   表现为「页面视图开了，但只有一张纸」。故用「无依赖 effect + 已接线标记」：
  //   宿主一出现就接线（每次渲染后检查一次，代价是一次引用比较），接完即跳过。
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const wiredRef = useRef<HTMLElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const host = hostRef.current;
    if (!host) return;

    // ★ 页带可能换节点（关/开页面视图、停靠重排）而宿主不变 ⇒ 不能只按宿主判断"已接线"。
    //   每次渲染都调一次 syncFit：它内部每次都写变量（幂等），保证新页带拿到正确纸规格。
    if (syncFit()) setMetricsTick((t) => t + 1);

    if (wiredRef.current === host) return;
    wiredRef.current = host;

    scheduleMeasure();

    // ① 内容变化（打字、切章 setContent、撤销、批注块增删…）
    //    观察**宿主**而不是 .ProseMirror，一次接住三件事：
    //      · 切章走 `editor.commands.setContent(..., false)`（不 emitUpdate）⇒
    //        DOM 变更观察是唯一可靠的信号源；
    //      · 正文节点在停靠布局重排时会被卸载重挂（t6 报告实测）⇒ 盯宿主才能连"换节点"一起接住；
    //      · 首帧时正文节点可能还没生出来 ⇒ 盯宿主就不怕。
    const observer = new MutationObserver(scheduleMeasure);
    observer.observe(host, { childList: true, subtree: true, characterData: true });

    // ② 宿主尺寸变化（窗口缩放 / 停靠布局变化）：既要重量页，也要重算缩放
    const ro = new ResizeObserver(() => {
      scheduleMeasure();
      const r = host.getBoundingClientRect();
      setZoom((prev) => {
        const next = fitZoom(r.width, r.height, modeRef.current);
        return Math.abs(next - prev) < 0.005 ? prev : next;
      });
      // 纸规格（--nm-page-fit）随容器宽度变化 ⇒ 页带尺寸要重算
      if (syncFit()) setMetricsTick((t) => t + 1);
    });
    ro.observe(host);

    // ③ 滚轮翻页 + 滚动刷新页号（见 onHostWheel / onHostScroll 的注释）
    host.addEventListener('wheel', onHostWheel, { passive: false });
    host.addEventListener('scroll', onHostScroll, { passive: true });
    onHostScroll();
    // ④ 字体度量稳定后重量一次（正文走系统衬线回落，首帧与稳定后的行高可能不同）
    let cancelled = false;
    void document.fonts?.ready?.then(() => {
      if (!cancelled) scheduleMeasure();
    });

    teardownRef.current = () => {
      cancelled = true;
      observer.disconnect();
      ro.disconnect();
      host.removeEventListener('wheel', onHostWheel);
      host.removeEventListener('scroll', onHostScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      wiredRef.current = null;
      teardownRef.current = null;
    };
  });

  // 关掉页面视图 / 组件卸载时拆线（与上面那条无依赖 effect 分工，勿合并）
  useEffect(() => () => {
    teardownRef.current?.();
  }, [enabled]);

  // 打开页面视图 / 换模式时：立刻量一次 + 算缩放
  //（ResizeObserver 的首帧回调不一定到；换模式不改尺寸，RO 也不会触发）
  useLayoutEffect(() => {
    if (!enabled) return;
    measure();
    const host = hostRef.current;
    if (!host) return;
    const r = host.getBoundingClientRect();
    setZoom(fitZoom(r.width, r.height, mode));
    // 切进页面视图 / 换模式：先把纸缩放到当前宿主宽度（分屏后单栏只有 ~490px）
    if (syncFit()) setMetricsTick((t) => t + 1);
  }, [enabled, mode, measure, hostRef, syncFit]);

  // ---- 页带尺寸：把「未缩放的真实尺寸」写给 DOM（缩放变换由 stripStyle 承担）----
  // ⚠️ 节距/页宽必须读**实测值**，不能用常量算：
  //   分屏后单栏可能只有 ~700px，CSS 的容器查询会把纸等比缩小（--nm-page-fit），
  //   此时常量算出来的节距会比真实值大 —— 翻页会跳过一页、页码会跳号（实测踩过）。
  //   实测口径：第 2 张纸左缘 - 第 1 张纸左缘 = 真实节距（两者同在一个未缩放的页带里）。
  const pageMetrics = useCallback((): { pitch: number; sheetW: number; sheetH: number } => {
    // 直接用**纸规格**算（不读 DOM）：纸宽 = 210mm × fit，节距 = (纸宽 + 页缝) × fit。
    // 这样与 CSS 里 `calc(210mm * var(--nm-page-fit))` 同源，量不到 DOM 也不会塌成 0
    // （实测踩过：首帧量到 0×0 写进内联宽度后，纸被钉死成 2px 再也长不回来）。
    const fit = fitRef.current || 1;
    return {
      pitch: pagePitchPx() * fit,
      sheetW: mmToPx(PAGE_MM.w) * fit,
      sheetH: mmToPx(PAGE_MM.h) * fit,
    };
  }, []);

  /**
   * 页带尺寸：页数 × 纸宽 + 页缝 + 两侧页边距。
   *
   * ★ fit 必须是**状态**（不能只放 ref）：纸规格由宿主宽度算出，变化时若只改 ref，
   *   useMemo 不重算 ⇒ 页带内联宽度仍按旧规格（实测：分屏后纸缩到 431px，
   *   页带却还是 533px ⇒ 横向溢出 87px，且关/开视图也修不好）。
   *   metricsTick 只是"触发重算"的计数器，真正参与计算的是 fitState。
   */
  const [fitState, setFitState] = useState(1);
  const [metricsTick, setMetricsTick] = useState(0);
  const metrics = useMemo(() => {
    const fit = fitState || 1;
    const m = {
      pitch: pagePitchPx() * fit,
      sheetW: mmToPx(PAGE_MM.w) * fit,
      sheetH: mmToPx(PAGE_MM.h) * fit,
    };
    // ★ 页带尺寸 = N × 纸宽 + (N−1) × 页缝。**不要再加页边距**：
    //   纸宽 210mm 本身已含两侧页边距（正文列宽 160mm + 2×25mm），
    //   页带的 padding 就是这两条页边距 —— 再加一次会多出 2×页边距（实测多 102px，
    //   表现为右边一条大白边 + 横向滚动）。
    const gapFit = mmToPx(PAGE_MM.gapMm) * fit;
    return {
      ...m,
      width: pageCount * m.sheetW + Math.max(0, pageCount - 1) * gapFit,
      height: m.sheetH,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, fitState, metricsTick]);

  // ---- 翻页 ----
  const goPage = useCallback(
    (i: number) => {
      const host = hostRef.current;
      if (!host) return;
      const n = Math.max(1, countRef.current);
      const target = Math.min(n - 1, Math.max(0, i));
      host.scrollTo({ left: target * pageMetrics().pitch * zoomRef.current, behavior: 'smooth' });
    },
    [hostRef, pageMetrics],
  );

  /** 由 scrollLeft 反推当前页（滚动是唯一真源，页号不单独存状态） */
  const syncPageFromScroll = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const step = pageMetrics().pitch * zoomRef.current;
    if (step <= 0) return;
    const idx = Math.max(0, Math.min(countRef.current - 1, Math.round(host.scrollLeft / step)));
    setPageIndex((prev) => (prev === idx ? prev : idx));
  }, [hostRef, pageMetrics]);

  // ---- 光标跟随：打字/点选后光标可能落到别的页，视口要跟过去 ----
  // 这是「页面视图能不能写字」的关键：正文在栏里流动，光标跨页时视口不跟，
  // 用户会看到字"打进看不见的地方"。
  //
  // 返回值 = 「这一次拿到了可用的光标几何」。**拿到全零矩形必须能重试**：
  //   实测（Chromium）打字后的 `selectionchange` 常常抢在浏览器算出光标几何**之前**到达，
  //   此刻 `getBoundingClientRect()` 是 0,0,0,0；若就此 return，跟页再也不会发生
  //   —— 表现为「字打进了看不见的页」（本文件头一版就是这么错的）。
  const followCaret = useCallback((): boolean => {
    const host = hostRef.current;
    const strip = stripRef.current;
    if (!host || !strip) return true; // 没有宿主/页带：不是"几何没算好"，无需重试
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return true;
    if (!host.contains(sel.anchorNode)) return true; // 焦点不在正文里就别抢滚动
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect) return true;
    if (rect.width === 0 && rect.height === 0) return false; // ← 几何未就绪，调用方下一帧重试
    const hostRect = host.getBoundingClientRect();
    // 光标已经在可见窗口里 ⇒ 不动（否则每敲一个字都会把视图拽一下）。
    // 这一条在**视口坐标**里判（rect 与 hostRect 同为视口坐标），与下面的页号换算无关。
    const insideH = rect.left >= hostRect.left + 8 && rect.right <= hostRect.right - 8;
    const insideV = rect.top >= hostRect.top + 8 && rect.bottom <= hostRect.bottom - 8;
    if (insideH && insideV) return true;
    if (!insideH) {
      const stripRect = strip.getBoundingClientRect();
      const k = zoomRef.current || 1;
      // 视口坐标 → 页带本地坐标（见文件头「坐标口径」）
      const idx = pageIndexAtX((rect.left - stripRect.left) / k);
      // ⚠️ 必须 `instant`：宿主带 CSS `scroll-behavior: smooth`，而 `auto` 会「随 CSS」=
      //    动画滚动 —— 打字时跟随一动画，光标就先跑到视野外再被追回来（实测观感很差）。
      host.scrollTo({ left: idx * pagePitchPx() * k, behavior: 'instant' });
      setPageIndex((prev) => (prev === idx ? prev : idx));
    }
    if (!insideV) {
      // 纵向只做**最小位移**把光标贴回窗内（不做"居中"）：
      // 居中会在每次选区变化时重设阅读位置，把用户正在看的地方顶走（实测：
      // 手动滚到页尾读稿时，一次选区变化就被拽回中部）。
      host.scrollTop += rect.top < hostRect.top
        ? rect.top - hostRect.top - 8
        : rect.bottom - hostRect.bottom + 8;
    }
    return true;
  }, [hostRef]);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let tries = 0;
    const MAX_TRIES = 6; // ≈ 100ms：够 Chromium 把光标几何算出来；再久就放弃（别空转）
    const tick = () => {
      raf = 0;
      const settled = followCaret();
      if (!settled && tries < MAX_TRIES) {
        tries += 1;
        raf = requestAnimationFrame(tick);
      } else {
        tries = 0;
      }
    };
    const onSelectionChange = () => {
      tries = 0;
      if (raf) return;
      raf = requestAnimationFrame(tick);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, followCaret]);

  // ---- 滚轮翻页 + 滚动刷新页号 ----
  //
  // ⚠️ 这两个监听器**必须挂在那条"宿主出现后接线"的 effect 上**（见下）：
  //   它们曾各自一条 `[enabled, hostRef, …]` 的 effect，踩的是同一个坑 ——
  //   章节异步到、首帧宿主还不存在 ⇒ `if (!host) return;` 退场、**再也不会重挂**。
  //   实测症状：滚轮不翻页、翻页后页号不更新（而页数/打字跟页都正常，极易误判成"没问题"）。

  /** 滚轮锁：一次滚轮手势只翻一页（触控板的惯性会连发几十个 wheel 事件）。 */
  const wheelLockRef = useRef(0);
  /** 滚轮：页内先滚，滚到页首/页尾才翻页（Word 同款手感）。 */
  const onHostWheel = useCallback(
    (e: WheelEvent) => {
      const host = hostRef.current;
      if (!host) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 横向滚 = 翻页本身，交原生
      const goingDown = e.deltaY > 0;
      // ★ 页内先滚：100% 缩放下窗口常常装不下整页（A4 1123px），纵向滚是
      //   "把这一页看完"的正经动作；只有滚到头才翻页。
      const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 1;
      const atTop = host.scrollTop <= 1;
      if (goingDown ? !atBottom : !atTop) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelLockRef.current < 260) return;
      wheelLockRef.current = now;
      const step = pagePitchPx() * zoomRef.current;
      const current = Math.round(host.scrollLeft / step);
      goPage(current + (goingDown ? 1 : -1));
    },
    [goPage, hostRef],
  );

  /** 滚动即刷新页号（原生横向滚动、程序化滚动都算）。 */
  const onHostScroll = useCallback(() => syncPageFromScroll(), [syncPageFromScroll]);


  // 内容变了 ⇒ 页数变了 ⇒ 当前页可能越界，夹回来
  useEffect(() => {
    if (!enabled) return;
    setPageIndex((prev) => Math.min(prev, pageCount - 1));
  }, [enabled, pageCount]);

  return {
    pageCount,
    pageIndex,
    mode,
    setMode,
    goPage,
    zoom,
    stripRef,
    scaleStyle: {
      width: metrics.width * zoom,
      height: metrics.height * zoom,
    },
    stripStyle: {
      width: metrics.width,
      height: metrics.height,
      transform: `scale(${zoom})`,
      transformOrigin: 'top left',
    },
  };
}
