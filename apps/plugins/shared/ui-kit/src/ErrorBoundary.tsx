// ============================================================
// NovelMuse - 增强版 React 错误边界
// 液态玻璃风格的错误展示界面，区分可恢复/致命错误
// ============================================================

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AppError, categorizeError } from './errors';

// ============================================================
// 类型定义
// ============================================================

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义回退 UI（可选） */
  fallback?: ReactNode;
  /** 精细化错误渲染（可拿到 error 做自定义展示；优先于 fallback） */
  renderError?: (error: Error) => ReactNode;
  /**
   * 致命错误的回调（用于上报等）
   * 当 recoverable 为 false 时触发
   */
  onFatalError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

// ============================================================
// 友好错误消息常量
// ============================================================

/** 致命错误消息（生产环境） */
const FATAL_ERROR_MESSAGE = '应用遇到了严重错误';

/** 可恢复错误消息（生产环境） */
const RECOVERABLE_ERROR_MESSAGE = '页面渲染异常，可以尝试重试';

// ============================================================
// 错误展示组件
// ============================================================

interface ErrorFallbackProps {
  error: Error;
  retryCount: number;
  onRetry: () => void;
  onGoHome: () => void;
}

function ErrorFallback({ error, retryCount, onRetry, onGoHome }: ErrorFallbackProps) {
  const appError = error instanceof AppError ? error : categorizeError(error);
  const isDev = process.env.NODE_ENV === 'development';
  const showRefreshHint = retryCount > 2;
  const isFatal = !appError.recoverable;

  return (
    <div
      className="flex items-center justify-center min-h-[400px] p-8"
      style={{ background: 'transparent', color: 'hsl(var(--foreground))' }}
      role="alert"
    >
      <div className="max-w-md w-full text-center">
        {/* ── 玻璃风格图标区域 ── */}
        <div className="mb-6 flex justify-center">
          <div
            className="w-20 h-20 flex items-center justify-center relative"
            style={{
              borderRadius: 'var(--r-lg)',
              background: isFatal
                ? 'hsl(var(--destructive) / 0.12)'
                : 'hsl(0 0% 45% / 0.12)',
              border: `1px solid hsl(${isFatal ? 'var(--destructive)' : '38 92% 50%'} / 0.3)`,
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              boxShadow: `
                0 1px 0 0 rgb(var(--glass-highlight) / 0.4) inset,
                0 8px 24px -8px hsl(var(--glass-shadow) / 0.18)
              `,
            }}
          >
            <span
              className="text-3xl"
              style={{
                fontFamily: "'Noto Serif SC', serif",
                color: isFatal ? 'hsl(var(--destructive))' : 'hsl(0 0% 45%)',
                fontWeight: 600,
              }}
              aria-hidden="true"
            >
              {isFatal ? '×' : '!'}
            </span>
          </div>
        </div>

        {/* ── 标题 ── */}
        <h2
          className="mb-3 text-base tracking-wide"
          style={{
            fontFamily: "'Noto Serif SC', serif",
            color: isFatal ? 'hsl(var(--destructive))' : 'hsl(0 0% 45%)',
            fontWeight: 600,
          }}
        >
          {isFatal ? '致命错误' : '页面异常'}
        </h2>

        {/* ── 错误消息卡片（液态玻璃） ── */}
        <div
          className="mb-4 p-5 text-left"
          style={{
            borderRadius: 'var(--r-lg)',
            background: 'rgb(var(--glass-tint) / 0.7)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            border: '1px solid hsl(var(--border) / 0.4)',
            boxShadow: `
              0 1px 0 0 rgb(var(--glass-highlight) / 0.4) inset,
              0 12px 32px -12px hsl(var(--glass-shadow) / 0.18)
            `,
          }}
        >
          {isDev ? (
            <>
              {/* 开发环境：显示详细错误信息 */}
              <p
                className="mb-2 text-sm break-all"
                style={{
                  fontFamily: "'Noto Serif SC', serif",
                  color: 'hsl(var(--foreground))',
                  lineHeight: 1.6,
                }}
              >
                {error.message}
              </p>

              {/* 可折叠的堆栈信息 */}
              <details className="group">
                <summary
                  className="cursor-pointer text-xs transition-colors hover:opacity-70"
                  style={{
                    fontFamily: "'Noto Serif SC', serif",
                    color: 'hsl(var(--muted-foreground))',
                  }}
                >
                  查看调试信息
                </summary>
                <pre
                  className="mt-3 p-3 overflow-x-auto whitespace-pre-wrap"
                  style={{
                    background: 'hsl(var(--foreground) / 0.06)',
                    borderRadius: 'var(--r-sm)',
                    fontSize: '10px',
                    lineHeight: '1.6',
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}
                >
                  <code
                    style={{
                      color: 'hsl(var(--muted-foreground))',
                      fontFamily: "'Inter', monospace",
                    }}
                  >
                    {error.stack || error.message}
                  </code>
                </pre>
              </details>
            </>
          ) : (
            /* 生产环境：友好提示 */
            <p
              className="text-sm leading-relaxed"
              style={{
                fontFamily: "'Noto Serif SC', serif",
                color: 'hsl(var(--foreground))',
                lineHeight: 1.7,
              }}
            >
              {isFatal ? FATAL_ERROR_MESSAGE : RECOVERABLE_ERROR_MESSAGE}
            </p>
          )}
        </div>

        {/* ── 多次重试提示 ── */}
        {showRefreshHint && (
          <p
            className="mb-4 text-xs"
            style={{
              fontFamily: "'Noto Serif SC', serif",
              color: 'hsl(var(--muted-foreground))',
            }}
          >
            多次重试失败，建议刷新整个页面
          </p>
        )}

        {/* ── 操作按钮（圆角玻璃按钮） ── */}
        <div className="flex gap-3 justify-center">
          {/* 可恢复错误：显示重试按钮 */}
          {!isFatal && (
            <button
              onClick={onRetry}
              className="px-6 py-3 text-sm transition-all hover:opacity-90 active:scale-[0.98]"
              style={{
                fontFamily: "'Noto Serif SC', serif",
                borderRadius: 'var(--r-sm)',
                background: 'hsl(var(--primary))',
                color: 'hsl(var(--primary-foreground))',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: 'hsl(var(--primary) / 0.5)',
                boxShadow: '0 4px 12px -4px hsl(var(--primary) / 0.4)',
                fontWeight: 500,
              }}
            >
              重试
            </button>
          )}

          {/* 所有情况都显示返回首页按钮 */}
          <button
            onClick={onGoHome}
            className="px-6 py-3 text-sm transition-all hover:opacity-90 active:scale-[0.98]"
            style={{
              fontFamily: "'Noto Serif SC', serif",
              borderRadius: 'var(--r-sm)',
              background: 'rgb(var(--glass-tint) / 0.6)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              color: 'hsl(var(--foreground))',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'hsl(var(--border) / 0.4)',
              boxShadow: `
                0 1px 0 0 rgb(var(--glass-highlight) / 0.4) inset,
                0 4px 12px -4px hsl(var(--glass-shadow) / 0.12)
              `,
              fontWeight: 500,
            }}
          >
            返回首页
          </button>

          {/* 刷新页面选项 */}
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-3 text-xs transition-all hover:opacity-90 active:scale-[0.98]"
            style={{
              fontFamily: "'Noto Serif SC', serif",
              borderRadius: 'var(--r-sm)',
              background: 'rgb(var(--glass-tint) / 0.4)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              color: 'hsl(var(--muted-foreground))',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'hsl(var(--border) / 0.3)',
              fontWeight: 500,
            }}
            aria-label="刷新页面"
          >
            刷新
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ErrorBoundary 主组件
// ============================================================

/**
 * 增强版 React 错误边界
 *
 * 特性：
 * - 区分可恢复错误和致命错误
 * - 可恢复错误显示"重试"按钮
 * - 致命错误显示"返回首页"按钮
 * - 液态玻璃风格的错误展示界面
 * - 开发环境下显示完整错误堆栈
 * - 生产环境显示友好的错误消息
 * - 支持自定义回退 UI
 * - 提供致命错误回调钩子
 *
 * @example
 * ```tsx
 * <ErrorBoundary onFatalError={(err, info) => reportToSentry(err, info)}>
 *   <MyComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const appError = categorizeError(error);

    // 控制台输出完整错误信息（开发者用）
    console.error('[ErrorBoundary] 捕获到渲染错误:', {
      message: error.message,
      category: appError instanceof AppError ? appError.category : 'RENDER_ERROR',
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    });

    // 如果是致命错误，触发回调
    if (!appError.recoverable && this.props.onFatalError) {
      this.props.onFatalError(error, errorInfo);
    }
  }

  handleRetry = (): void => {
    this.setState((prevState) => ({
      hasError: false,
      error: null,
      retryCount: prevState.retryCount + 1,
    }));
  };

  handleGoHome = (): void => {
    // 尝试使用路由导航，失败则刷新页面
    try {
      window.location.href = '/';
    } catch {
      window.location.reload();
    }
  };

  render(): ReactNode {
    const { hasError, error, retryCount } = this.state;
    const { children, fallback, renderError } = this.props;

    if (hasError && error) {
      // 精细化错误渲染优先（可读出 error.message）
      if (renderError) {
        return renderError(error);
      }

      // 如果提供了自定义回退 UI，使用它
      if (fallback) {
        return fallback;
      }

      // 使用增强版的液态玻璃风格错误界面
      return (
        <ErrorFallback
          error={error}
          retryCount={retryCount}
          onRetry={this.handleRetry}
          onGoHome={this.handleGoHome}
        />
      );
    }

    return children;
  }
}
