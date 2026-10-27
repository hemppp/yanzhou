// ============================================================
// pageView.test.ts —— 页面视图（A4 稿纸分页）的**几何契约**
//
// 只测纯函数：jsdom 没有布局引擎，量页/翻页的真实验证在浏览器里做
// （见 globals.css「页面视图」段的实测口径）。这里锁的是三件最容易改错的事：
//   ① mm→px 的基准（A4 必须 ≈794×1123px，与 Word 的 96dpi 口径一致）；
//   ② 页数换算 `N = round((scrollWidth + 列距) / (列宽 + 列距))` ——
//      取整而非上取整：折行取整误差不该多出一张空页；
//   ③ 页号定位与缩放夹取：光标跟随/翻页全靠这两个纯函数，
//      一旦漂移就会出现「打字打进看不见的页」。
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  PAGE_MM,
  ZOOM_MIN,
  ZOOM_MAX,
  fitZoom,
  mmToPx,
  pageColumnGapPx,
  pageContentWidthPx,
  pageCountOf,
  pageIndexAtX,
  pagePitchPx,
} from '../hooks/usePageView';

describe('页面视图 · 纸张几何', () => {
  it('mm→px 用 96dpi 基准：A4 = 794×1123px（与 Word 页面一致）', () => {
    expect(Math.round(mmToPx(PAGE_MM.w))).toBe(794);
    expect(Math.round(mmToPx(PAGE_MM.h))).toBe(1123);
  });

  it('节距 = 纸宽 + 页缝；列距 = 两倍页边距 + 页缝（纸与纸之间不许贴字）', () => {
    expect(pagePitchPx()).toBeCloseTo(mmToPx(220), 6);
    expect(pageColumnGapPx()).toBeCloseTo(mmToPx(60), 6);
    // 纸的正文列宽 = 纸宽 - 2×页边距 = 160mm
    expect(pageContentWidthPx()).toBeCloseTo(mmToPx(160), 6);
  });

  it('列距必须容得下两张纸的页边距 —— 否则相邻两页的字会挤在一条缝里', () => {
    expect(pageColumnGapPx()).toBeGreaterThan(2 * mmToPx(PAGE_MM.marginMm));
  });
});

describe('页面视图 · 页数换算', () => {
  const colW = pageContentWidthPx();
  const colGap = pageColumnGapPx();
  /** 浏览器分栏后 scrollWidth 的表达式：N 列 + (N-1) 列距 */
  const stripWidthOf = (pages: number) => pages * colW + (pages - 1) * colGap;

  it.each([1, 2, 3, 17])('%i 页的内容总宽换算出同样的页数', (n) => {
    expect(pageCountOf(stripWidthOf(n))).toBe(n);
  });

  it('末列只剩折行取整误差（几 px）时不额外多出一张空页', () => {
    expect(pageCountOf(stripWidthOf(2) + 5)).toBe(2);
  });

  it('空内容 / 非法尺寸一律回到 1 页，不返回 0 或 NaN', () => {
    expect(pageCountOf(0)).toBe(1);
    expect(pageCountOf(-100)).toBe(1);
    expect(pageCountOf(Number.NaN)).toBe(1);
    expect(pageCountOf(Number.POSITIVE_INFINITY)).toBe(1); // 未排版完就量：按 1 页兜底
  });
});

describe('页面视图 · 页号定位与缩放', () => {
  const pitch = pagePitchPx();

  it('页带本地 x → 页号：页内任意点都落在本页（含页边距与半缝）', () => {
    expect(pageIndexAtX(0)).toBe(0);
    expect(pageIndexAtX(mmToPx(PAGE_MM.marginMm))).toBe(0);       // 正文左缘
    expect(pageIndexAtX(pitch - 1)).toBe(0);                     // 第 1 页右缘内侧
    expect(pageIndexAtX(pitch)).toBe(1);                         // 第 2 页起点
    expect(pageIndexAtX(pitch * 3 + mmToPx(PAGE_MM.marginMm))).toBe(3);
  });

  it('负坐标（滚动回弹等）夹到第 0 页', () => {
    expect(pageIndexAtX(-50)).toBe(0);
  });

  it('单页恒为 100%：窗口再矮也不缩字（要看整页请用多页模式）', () => {
    // ★ 实测口径：编辑器区常在 500–900px 高，A4 是 1123px —— 自适应会把字缩到 0.43，
    //   写字看不清。故单页不缩放，装不下就页内纵向滚动（Word 默认行为）。
    expect(fitZoom(1600, 2400, 'single')).toBe(ZOOM_MAX);
    expect(fitZoom(1600, 800, 'single')).toBe(ZOOM_MAX);
    expect(fitZoom(320, 300, 'single')).toBe(ZOOM_MAX);
  });

  it('多页缩放同时受「一屏两张纸」的宽度与整页高度约束', () => {
    const wide = fitZoom(2400, 2400, 'multi');
    const narrow = fitZoom(1200, 2400, 'multi');
    expect(narrow).toBeLessThan(wide);
    // 窗口极窄极矮时夹到下限，宁可让宿主滚动也不缩到看不清
    expect(fitZoom(320, 300, 'multi')).toBe(ZOOM_MIN);
  });

  it('量不到宿主尺寸（首帧）时按 100% 兜底，不产生 NaN 宽度', () => {
    expect(fitZoom(0, 0, 'single')).toBe(ZOOM_MAX);
  });
});
