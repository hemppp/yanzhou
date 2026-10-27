// ============================================================
// 砚舟 - 全局 Toast 通知系统
// 液态玻璃风格的轻量级通知组件，使用 Context + useReducer 管理队列
// ============================================================

import React, {
  createContext,
  useCallback,
  useContext,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { gsap, useGSAP, toastEnter } from './gsap';
// ============================================================
// 类型定义
// ============================================================

/** Toast 类型 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

/** Toast 数据结构 */
export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** 自动消失时间（毫秒），默认根据类型不同 */
  duration: number;
}

/** Toast 状态 */
interface ToastState {
  toasts: Toast[];
}

/** Toast Action 类型 */
type ToastAction =
  | { type: 'ADD_TOAST'; payload: Omit<Toast, 'id'> }
  | { type: 'REMOVE_TOAST'; payload: string };

/** Toast Context 值 */
interface ToastContextValue {
  /** 显示成功通知 */
  success: (message: string, duration?: number) => void;
  /** 显示错误通知 */
  error: (message: string, duration?: number) => void;
  /** 显示警告通知 */
  warning: (message: string, duration?: number) => void;
  /** 显示信息通知 */
  info: (message: string, duration?: number) => void;
}

// ============================================================
// 配置常量
// ============================================================

/** 最大同时显示的 Toast 数量 */
const MAX_TOASTS = 3;

/** 各类型默认持续时间（毫秒） */
const DEFAULT_DURATIONS: Record<ToastType, number> = {
  success: 3000,
  error: 5000,   // 错误停留更久，让用户看清
  warning: 4000,
  info: 3000,
};

/** 图标（Unicode 字符） */
const TOAST_ICONS: Record<ToastType, string> = {
  success: '\u2713',  // ✓
  error: '\u2717',    // ✗
  warning: '\u26A0',  // ⚠
  info: '\u2139',     // ℹ
};

/** 液态玻璃风格图标颜色映射（按类型区分色相） */
const TOAST_ICON_COLORS: Record<ToastType, string> = {
  success: 'hsl(0 0% 26%)',
  error: 'hsl(var(--destructive))',
  warning: 'hsl(0 0% 40%)',
  info: 'hsl(0 0% 52%)',
};

// ============================================================
// Reducer
// ============================================================

let toastIdCounter = 0;

function generateToastId(): string {
  toastIdCounter += 1;
  return `toast-${Date.now()}-${toastIdCounter}`;
}

function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'ADD_TOAST': {
      const newToast: Toast = {
        ...action.payload,
        id: generateToastId(),
      };
      const toasts = [newToast, ...state.toasts];
      // 限制最大数量，移除最旧的
      if (toasts.length > MAX_TOASTS) {
        toasts.pop();
      }
      return { toasts };
    }

    case 'REMOVE_TOAST': {
      return {
        toasts: state.toasts.filter((t) => t.id !== action.payload),
      };
    }

    default:
      return state;
  }
}

// ============================================================
// Context
// ============================================================

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Toast Hook
 * 在组件中使用此 hook 来触发全局 Toast 通知
 *
 * @example
 * ```tsx
 * const Toast = useToast();
 * Toast.success('保存成功！');
 * Toast.error('操作失败');
 * ```
 */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return context;
}

// ============================================================
// 单个 Toast 组件
// ============================================================

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    timerRef.current = setTimeout(() => {
      // Animate exit before removing
      if (containerRef.current) {
        gsap.to(containerRef.current, {
          opacity: 0,
          y: -20,
          duration: 0.2,
          ease: 'power2.in',
          onComplete: () => onRemove(toast.id),
        });
      } else {
        onRemove(toast.id);
      }
    }, toast.duration);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [toast.id, toast.duration, onRemove]);

  // Enter 动画
  useGSAP(() => {
    if (containerRef.current) {
      toastEnter(containerRef.current);
    }
  }, { scope: containerRef });

  const iconColor = TOAST_ICON_COLORS[toast.type];
  // error 类型用 alert，其他用 status
  const role = toast.type === 'error' ? 'alert' : 'status';

  return (
    <div ref={containerRef}
      className="relative flex items-center gap-3 px-4 py-3 pr-8 min-w-[280px] max-w-[400px]"
      style={{
        borderRadius: 'var(--r-md)',
        background: 'rgb(var(--glass-tint) / 0.7)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        border: '1px solid hsl(var(--border) / 0.3)',
        boxShadow: `
          0 1px 0 0 rgb(var(--glass-highlight) / 0.4) inset,
          0 8px 24px -8px hsl(var(--glass-shadow) / 0.18)
        `,
      }}
      role={role}
      aria-live="polite"
    >
      {/* 图标 */}
      <span
        className="text-base shrink-0"
        style={{ color: iconColor, fontWeight: 600 }}
        aria-hidden="true"
      >
        {TOAST_ICONS[toast.type]}
      </span>

      {/* 消息文本 */}
      <p
        className="flex-1 text-xs leading-relaxed"
        style={{
          fontFamily: "'Noto Serif SC', serif",
          color: 'hsl(var(--foreground))',
          fontSize: '12px',
          lineHeight: '1.55',
          letterSpacing: '0.2px',
        }}
      >
        {toast.message}
      </p>

      {/* 关闭按钮 */}
      <button
        onClick={() => {
          if (containerRef.current) {
            gsap.to(containerRef.current, {
              opacity: 0,
              y: -20,
              duration: 0.2,
              ease: 'power2.in',
              onComplete: () => onRemove(toast.id),
            });
          } else {
            onRemove(toast.id);
          }
        }}
        className="
          absolute right-2 top-1/2 -translate-y-1/2
          w-5 h-5 flex items-center justify-center
          rounded-full transition-colors cursor-pointer
        "
        style={{
          color: 'hsl(var(--muted-foreground))',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'hsl(var(--foreground))';
          e.currentTarget.style.background = 'hsl(var(--foreground) / 0.08)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
          e.currentTarget.style.background = 'transparent';
        }}
        aria-label="关闭通知"
      >
        <span style={{ fontSize: '13px', lineHeight: 1 }}>&times;</span>
      </button>
    </div>
  );
}

// ============================================================
// Toast 容器组件
// ============================================================

function ToastContainer({ state, dispatch }: {
  state: ToastState;
  dispatch: React.Dispatch<ToastAction>;
}) {
  const handleRemove = useCallback(
    (id: string) => {
      dispatch({ type: 'REMOVE_TOAST', payload: id });
    },
    [dispatch],
  );

  if (state.toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="fixed top-4 right-4 z-[9999] flex flex-col gap-3 pointer-events-none"
      aria-label="通知列表"
    >
      {state.toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem toast={toast} onRemove={handleRemove} />
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Toast Provider 组件
// ============================================================

interface ToastProviderProps {
  children: ReactNode;
}

/**
 * 全局 Toast Provider
 * 必须包裹在应用根组件外层，提供 useToast() 能力
 *
 * @example
 * ```tsx
 * <ToastProvider>
 *   <App />
 * </ToastProvider>
 * ```
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [] });

  /**
   * 创建指定类型的 Toast 触发函数
   */
  const createToast = useCallback(
    (type: ToastType) =>
      (message: string, duration?: number): void => {
        dispatch({
          type: 'ADD_TOAST',
          payload: {
            type,
            message,
            duration: duration ?? DEFAULT_DURATIONS[type],
          },
        });
      },
    [],
  );

  const value: ToastContextValue = {
    success: createToast('success'),
    error: createToast('error'),
    warning: createToast('warning'),
    info: createToast('info'),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer state={state} dispatch={dispatch} />
    </ToastContext.Provider>
  );
}
