// ============================================================
// @novel-plugins/ui-kit — 通用 UI 原子（无业务状态）
//
// kernel / manual / auto 三侧共用：错误边界、Toast、墨水返回键、
// 通用抽屉/侧栏、GSAP 动效助手、确认框、AI 原语组件。
// 归属见设计 §2.3 / §3.6 / §3.7（D19-①、D32-Q2）。
// ============================================================

// ---- 基础工具 ----
export {
  ErrorCategory,
  AppError,
  categorizeError,
  isRecoverableError,
  ERROR_EVENTS,
  dispatchApiErrorEvent,
  dispatchToastEvent,
} from './errors';
export type { IApiError, ToastEventData } from './errors';

export { safeConfirm } from './safeConfirm';

export {
  pageEnter,
  staggerCards,
  modalEnter,
  modalExit,
  chapterListEnter,
  buttonPulse,
  countUp,
  toastEnter,
  scrollBatchEnter,
  springEase,
  smoothEase,
  bounceEase,
  pageTransition,
  glassEnter,
  gsap,
  useGSAP,
  ScrollTrigger,
} from './gsap';

// ---- 通用组件 ----
export { ErrorBoundary } from './ErrorBoundary';
export { ToastProvider, useToast } from './ToastProvider';
export type { ToastType, Toast } from './ToastProvider';
export { RightSidebar } from './RightSidebar';
export { BottomDrawer } from './BottomDrawer';
export type { BottomDrawerTab, BottomDrawerProps } from './BottomDrawer';

// ---- hooks / store ----
export { useGlassRipple } from './useGlassRipple';
export {
  THEMES,
  applyTheme,
  applyStoredTheme,
  useThemeStore,
  FONTS,
  applyFonts,
  applyStoredFonts,
  readStoredFonts,
} from './themeStore';
export type { ThemeId, ColorMode, ThemeMeta, FontId, FontKind, FontOption, FontPrefs } from './themeStore';

// ---- AI 原语（无业务状态，kernel 与 auto 共用）----
export * from './primitives';

// ---- AI 对话功能栏（D46 下沉：严格叶子，技能列表经 props 注入）----
export * from './aiBars';
