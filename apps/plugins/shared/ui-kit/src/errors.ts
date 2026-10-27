// ============================================================
// 砚舟 - 全局错误处理体系
// 错误分类、应用级错误类、错误工具函数
// ============================================================

/**
 * 错误分类枚举
 * 用于区分不同类型的错误，以便采取不同的处理策略
 */
export enum ErrorCategory {
  /** 网络错误（断网、超时、DNS 解析失败等） */
  NETWORK = 'NETWORK',
  /** 认证错误（未登录、令牌 过期、权限不足） */
  AUTHENTICATION = 'AUTHENTICATION',
  /** 验证错误（表单校验失败、数据格式不合法） */
  VALIDATION = 'VALIDATION',
  /** 资源不存在（404） */
  NOT_FOUND = 'NOT_FOUND',
  /** 速率限制（429，请求过于频繁） */
  RATE_LIMIT = 'RATE_LIMIT',
  /** 服务端错误（500 系列错误） */
  SERVER = 'SERVER',
  /** 未知错误 */
  UNKNOWN = 'UNKNOWN',
}

/**
 * 友好错误消息映射
 * 将技术性错误转换为用户友好的中文文案
 */
const FRIENDLY_ERROR_MESSAGES: Record<ErrorCategory, string> = {
  [ErrorCategory.NETWORK]: '网络连接中断，请检查网络后重试',
  [ErrorCategory.AUTHENTICATION]: '身份验证失败，请重新登录',
  [ErrorCategory.VALIDATION]: '数据格式不正确，请检查输入内容',
  [ErrorCategory.NOT_FOUND]: '未找到请求的资源，可能已被移动或删除',
  [ErrorCategory.RATE_LIMIT]: '请求过于频繁，请稍后再试',
  [ErrorCategory.SERVER]: '服务器暂时不可用，请稍后重试',
  [ErrorCategory.UNKNOWN]: '发生了未知错误，请重试',
};

/**
 * 应用级错误类
 * 统一封装所有应用内错误，包含分类信息和恢复策略
 *
 * @example
 * ```ts
 * throw new AppError(ErrorCategory.NETWORK, '无法连接到服务器', 'CONN_FAILED');
 * ```
 */
export class AppError extends Error {
  /**
   * @param category - 错误分类
   * @param 消息 - 原始错误消息（用于开发者调试）
   * @param code - 错误代码（用于日志追踪）
   * @param recoverable - 是否可恢复（决定 UI 展示重试按钮还是返回首页）
   */
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly code?: string,
    public readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = 'AppError';

    // 保持正确的原型链（ES2015+ 的坑）
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * 获取用户友好的错误消息
   */
  get userMessage(): string {
    return FRIENDLY_ERROR_MESSAGES[this.category];
  }
}

/**
 * API 错误接口
 * 用于类型化从 apiClient 抛出的 ApiError
 */
export interface IApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 将任意错误标准化为 AppError
 * 根据错误特征自动推断分类
 *
 * @param err - 任意类型的错误（捕获 捕获的值）
 * @返回 标准化的 AppError 实例
 *
 * @example
 * ```ts
 * 尝试 {
 *   await riskyOperation();
 * } 捕获 (err) {
 *   const appErr = categorizeError(err);
 *   Toast.错误(appErr.userMessage);
 * }
 * ```
 */
export function categorizeError(err: unknown): AppError {
  // 已经是 AppError，直接返回
  if (err instanceof AppError) {
    return err;
  }

  // 处理标准 Error 对象
  if (err instanceof Error) {
    // 网络相关错误检测
    const networkPatterns = [
      /network/i,
      /fetch/i,
      /abort/i,
      /timeout/i,
      /ECONNREFUSED/i,
      /ENOTFOUND/i,
      /Failed to fetch/i,
      /Load failed/i,
      /NetworkError/i,
    ];
    const isNetworkError = networkPatterns.some((pattern) =>
      pattern.test(err.message),
    );

    if (isNetworkError) {
      return new AppError(
        ErrorCategory.NETWORK,
        err.message,
        'NETWORK_ERROR',
        true,
      );
    }

    // DOMException AbortError (获取 超时)
    if (err.name === 'AbortError') {
      return new AppError(
        ErrorCategory.NETWORK,
        err.message || '请求超时',
        'TIMEOUT',
        true,
      );
    }

    // 处理 ApiError (来自 apiClient)
    const apiErr = err as unknown as IApiError;
    if ('status' in apiErr && typeof (apiErr as IApiError).status === 'number') {
      return categorizeApiError(apiErr as IApiError & Error);
    }
  }

  // 处理非 Error 类型的值（字符串、数字、null 等）
  const message =
    err === null ? 'Null error'
    : err === undefined ? 'Undefined error'
    : typeof err === 'string' ? err
    : JSON.stringify(err);

  return new AppError(ErrorCategory.UNKNOWN, message, 'UNKNOWN_ERROR', true);
}

/**
 * 根据 HTTP 状态码对 API 错误进行分类
 *
 * @param apiError - 包含 ״̬ 字段的错误对象
 * @返回 分类后的 AppError
 */
function categorizeApiError(apiError: IApiError & Error): AppError {
  const { status, code, message } = apiError;

  switch (true) {
    case status === 401 || status === 403:
      return new AppError(
        ErrorCategory.AUTHENTICATION,
        message,
        code || `AUTH_${status}`,
        false, // 认证错误通常需要重新登录
      );

    case status === 400 || status === 409 || status === 422:
      // 409 Conflict 用于资源冲突（如用户名已被占用），本质是输入校验失败
      return new AppError(
        ErrorCategory.VALIDATION,
        message,
        code || `VALIDATION_${status}`,
        true,
      );

    case status === 404:
      return new AppError(
        ErrorCategory.NOT_FOUND,
        message,
        code || 'NOT_FOUND',
        true,
      );

    case status === 429:
      // ★ 速率限制：请求过于频繁，可恢复（等待 retryAfter 秒后重试）
      //   之前落入通用 4xx 分支被分类为 UNKNOWN，前端无法识别并给出倒计时提示
      return new AppError(
        ErrorCategory.RATE_LIMIT,
        message,
        code || 'RATE_LIMITED',
        true,
      );

    case status >= 400 && status < 500:
      return new AppError(
        ErrorCategory.UNKNOWN,
        message,
        code || `CLIENT_${status}`,
        true,
      );

    case status >= 500:
      return new AppError(
        ErrorCategory.SERVER,
        message,
        code || `SERVER_${status}`,
        true,
      );

    case status === 0:
      // ״̬ 为 0 通常是网络错误或 CORS 问题
      return new AppError(
        ErrorCategory.NETWORK,
        message,
        code || 'CONNECTION_ERROR',
        true,
      );

    default:
      return new AppError(
        ErrorCategory.UNKNOWN,
        message,
        code || 'UNKNOWN_API_ERROR',
        true,
      );
  }
}

/**
 * 判断错误是否可恢复
 * 可恢复错误会显示"重试"按钮，不可恢复显示"返回首页"
 *
 * @param err - 任意错误
 * @返回 是否可恢复
 */
export function isRecoverableError(err: unknown): boolean {
  const appErr = categorizeError(err);
  return appErr.recoverable;
}

/**
 * 自定义事件名称常量
 * 用于跨模块错误通信
 */
export const ERROR_EVENTS = {
  /** API 调用失败事件 */
  API_ERROR: 'novelmuse:api-error',
  /** 全局 Toast 通知事件 */
  TOAST_NOTIFY: 'novelmuse:toast-notify',
} as const;

/**
 * Toast 通知数据结构
 */
export interface ToastEventData {
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration?: number;
}

/**
 * 分发 API 错误事件
 * 由 apiClient 在请求失败时调用
 *
 * @param 错误 - ApiError 或其他错误对象
 */
export function dispatchApiErrorEvent(error: unknown): void {
  const appError = categorizeError(error);
  console.error('[ErrorSystem] API Error dispatched:', {
    category: appError.category,
    code: appError.code,
    message: appError.message,
    recoverable: appError.recoverable,
  });

  window.dispatchEvent(
    new CustomEvent(ERROR_EVENTS.API_ERROR, {
      detail: { error: appError },
    }),
  );
}

/**
 * 分发 Toast 通知事件
 * 用于在非 React 上下文中触发通知
 *
 * @param data - Toast 数据
 */
export function dispatchToastEvent(data: ToastEventData): void {
  window.dispatchEvent(
    new CustomEvent(ERROR_EVENTS.TOAST_NOTIFY, {
      detail: data,
    }),
  );
}
