// ============================================================
// 砚舟 - 核心 HTTP API 客户端（增强版）
// 封装 获取 调用，提供统一的错误处理、Token 管理、
// 请求/响应拦截、取消令牌支持
// ============================================================

import { dispatchApiErrorEvent } from '@novel-plugins/ui-kit/errors';

// ---------- Token 管理（C4：内存态，不再落 localStorage） ----------

/**
 * C4 迁移说明：JWT 改由服务端 HttpOnly + SameSite=Strict Cookie 承载，
 * JS 不再持久化令牌（XSS 无法窃取会话）。以下 get/set/clear 保留为
 * 「进程内内存」实现：主要是兼容旧调用点（SSE 流式请求、插件 ctx.api、
 * 路由守卫的 token 存在性检查等）——刷新页面后内存为空，鉴权完全走 Cookie。
 */
let memoryToken: string | null = null;

// C4 一次性迁移清理：移除历史版本写入 localStorage 的 JWT（现改 HttpOnly Cookie，
// 遗留值不再被服务端接受，留在本地是纯垃圾且误导安全检查）
try {
  if (typeof window !== 'undefined' && 'localStorage' in window) {
    window.localStorage.removeItem('novelmuse_token');
  }
} catch {
  // 隐私模式等环境下 localStorage 访问可能抛错，忽略
}

/**
 * 获取当前 JWT 令牌（内存态；页面刷新后为 null，会话恢复走 Cookie + /auth/me）
 * @返回 当前令牌，不存在则返回 null
 */
export function getToken(): string | null {
  return memoryToken;
}

/**
 * 将 JWT 令牌暂存于内存（不再写入 localStorage）
 * @param token - 要暂存的 JWT 令牌
 */
export function setToken(token: string): void {
  memoryToken = token;
}

/**
 * 清除内存中的 JWT 令牌，并触发 认证:登出 自定义事件
 * 供全局监听器（如路由守卫）响应
 */
export function clearToken(): void {
  memoryToken = null;
  // 触发自定义事件，供其他模块监听 令牌 失效
  window.dispatchEvent(new CustomEvent('auth:logout'));
}

// ---------- 类型定义 ----------

export interface ApiClientConfig {
  /** API 基础 URL */
  baseUrl: string;
  /** 默认请求头（会被 Token 和 Content-Type 合并） */
  headers?: Record<string, string>;
  /** 动态请求头提供者：每次请求时调用，返回值与默认头合并（用于注入 X-Project-Id 等运行时头） */
  dynamicHeaders?: () => Record<string, string>;
  /** 是否在收到 401 时自动尝试清除 令牌（默认 true） */
  autoHandleUnauthorized?: boolean;
}

export interface RequestOptions {
  /** 外部传入的 AbortSignal，用于取消请求 */
  signal?: AbortSignal;
  /** 额外的请求头（会覆盖默认头） */
  headers?: Record<string, string>;
  /** 静默模式：不触发全局错误事件和 console 输出 */
  silent?: boolean;
  /** 自定义超时（毫秒），默认 8000ms。AI 等慢请求可调大 */
  timeoutMs?: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClient {
  get<T>(path: string, params?: Record<string, string>, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

// ---------- 常量 ----------

const DEFAULT_TIMEOUT_MS = 8000;

/** 请求 ID 计数器，用于日志追踪 */
let requestIdCounter = 0;

// ---------- 内部工具函数 ----------

/**
 * 构建完整的请求 URL
 * 支持绝对路径和相对路径两种模式
 * 
 * @param baseUrl - 基础 URL（可以是完整 URL 如 'http://localhost:3721/API' 或相对路径 '/API'）
 * @param 路径 - 请求路径（如 '/认证/登录'）
 * @param params - 查询参数对象
 * @返回 完整的 URL 字符串
 */
export function buildUrl(baseUrl: string, path: string, params?: Record<string, string>): string {
  // baseUrl 可能是：
  //   - 绝对 URL（含协议），如 'http://localhost:3774/api'
  //   - 相对路径，如 '/api'
  // path 是 API 相对路径，如 '/auth/login'。
  //
  // ★ 不能用 new URL(path, baseUrl)：path 以 '/' 开头时，URL 解析会用 path
  //   替换掉 baseUrl 的整个路径段（'http://host/api' + '/auth/login'
  //   → 'http://host/auth/login'），把 baseUrl 里的 '/api' 前缀吞掉，
  //   导致请求打到 http://localhost:3774/auth/login（缺 /api）→ 404 / CORS 预检失败。
  //   这里显式做「base 路径 + 子路径」拼接，保留 baseUrl 的路径前缀。
  const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(baseUrl);
  const joinedPath = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const url = isAbsolute
    ? new URL(joinedPath)
    : new URL(joinedPath, window.location.origin);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    });
  }

  return url.toString();
}

/**
 * 生成唯一的请求 ID，用于日志追踪和调试
 * 格式：req_时间戳_递增序号
 */
function generateRequestId(): string {
  requestIdCounter += 1;
  return `req_${Date.now()}_${requestIdCounter}`;
}

/**
 * 根据 HTTP 状态码返回标准化的错误信息
 */
function getErrorMessage(status: number, statusText: string): string {
  switch (status) {
    case 400:
      return `请求参数错误 (${statusText})`;
    case 401:
      return '登录已过期，请重新登录';
    case 403:
      return '没有权限执行此操作';
    case 404:
      return '请求的资源不存在';
    case 409:
      return '数据冲突，请刷新后重试';
    case 422:
      return '数据验证失败';
    case 429:
      return '请求过于频繁，请稍后再试';
    case 500:
      return '服务器内部错误，请稍后重试';
    case 502:
    case 503:
    case 504:
      return '服务暂时不可用，请稍后重试';
    default:
      return `请求失败: ${status} ${statusText}`;
  }
}

/**
 * 根据状态码返回标准化错误码
 */
function getErrorCode(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'UNPROCESSABLE_ENTITY';
    case 429: return 'RATE_LIMITED';
    case 500: return 'INTERNAL_SERVER_ERROR';
    case 502: return 'BAD_GATEWAY';
    case 503: return 'SERVICE_UNAVAILABLE';
    case 504: return 'GATEWAY_TIMEOUT';
    default: return 'HTTP_ERROR';
  }
}

// ---------- 核心实现 ----------

function createApiClient(config: ApiClientConfig): ApiClient {
  const { baseUrl, headers: defaultHeaders, dynamicHeaders, autoHandleUnauthorized = true } = config;

  /**
   * 核心请求函数
   * @param 方法 - HTTP 方法
   * @param 路径 - 请求路径（相对路径）
   * @param 正文 - 请求体
   * @param params - URL 查询参数
   * @param options - 额外选项（signal、头部）
   */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>,
    options?: RequestOptions,
  ): Promise<T> {
    const url = buildUrl(baseUrl, path, params);
    const requestId = generateRequestId();

    // 401 静默标记：本请求若为 401，则不弹错误 toast（已在响应处自动跳登录页）
    let isUnauthorizedSilent = false;

    // 创建 AbortController：优先使用外部传入的 signal
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // ★ 标记本次 abort 是否由超时触发，用于在 catch 中区分超时与外部取消
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    // 如果外部提供了 signal，在其 中止 时也中止内部 controller
    let externalAbortListener: (() => void) | undefined;
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutId);
        throw new ApiError(0, 'ABORTED', '请求已被取消');
      }
      externalAbortListener = () => controller.abort();
      options.signal.addEventListener('abort', externalAbortListener);
    }

    // 构建请求头：默认头 + 动态头 + Token + Content-Type + 可选的自定义头
    const fetchHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...defaultHeaders,
      ...(dynamicHeaders ? dynamicHeaders() : {}),
      ...options?.headers,
    };

    // 自动附加 JWT Token
    const token = getToken();
    if (token) {
      fetchHeaders['Authorization'] = `Bearer ${token}`;
    }

    // 添加请求 ID 到 头部（用于后端日志追踪）
    fetchHeaders['X-Request-Id'] = requestId;

    try {
      const response = await fetch(url, {
        method,
        headers: fetchHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // C4：显式携带 Cookie（同源代理场景无影响；跨源/局域网直连时必需）
        credentials: 'include',
      });

      clearTimeout(timeoutId);

      // 清理外部 signal 监听器
      if (externalAbortListener && options?.signal) {
        options.signal.removeEventListener('abort', externalAbortListener);
      }

      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');

      // ========== 错误处理 ==========
      if (!response.ok) {
        // 401 Unauthorized：自动清除令牌 + 跳转登录页 + 静默（不弹 toast）
        if (response.status === 401 && autoHandleUnauthorized) {
          clearToken();
          // 静默标记：后续 catch 块不再 dispatchApiErrorEvent
          isUnauthorizedSilent = true;
          // 跳转到登录页（仅在浏览器环境且当前不在登录页时）
          if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
            // 用 setTimeout 避免在 fetch 链中跳转打断当前帧
            setTimeout(() => {
              window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
            }, 0);
          }
        }

        if (isJson) {
          const errorBody = await response.json().catch(() => ({}));
          const apiError = errorBody?.error || {};
          // 打印失败请求的 method + url + status + 原始响应体，便于定位 400/422 校验失败的具体字段
          // zValidator 默认返回 { success:false, error:{ fieldErrors:... } }，此处完整记录
          console.warn(`[apiClient] ${method} ${path} → ${response.status}`, errorBody);
          throw new ApiError(
            response.status,
            apiError.code || getErrorCode(response.status),
            apiError.message || getErrorMessage(response.status, response.statusText),
            apiError.details ?? errorBody,
          );
        }

        const text = await response.text().catch(() => '');
        throw new ApiError(
          response.status,
          getErrorCode(response.status),
          text || getErrorMessage(response.status, response.statusText),
        );
      }

      // ========== 成功响应解析 ==========
      if (!isJson) {
        // 非 JSON 响应直接返回文本
        return (await response.text()) as unknown as T;
      }

      const json = await response.json();
      // 后端统一响应格式: { data: ... }
      if (json && typeof json === 'object' && 'data' in json) {
        return json.data as T;
      }
      // fallback: 直接返回整个响应体
      return json as T;
    } catch (err) {
      clearTimeout(timeoutId);

      // 清理外部 signal 监听器
      if (externalAbortListener && options?.signal) {
        options.signal.removeEventListener('abort', externalAbortListener);
      }

      if (err instanceof ApiError) {
        // 401 已在响应处处理（清 token + 跳登录），这里静默不再弹 toast
        if (isUnauthorizedSilent || err.status === 401) {
          throw err;
        }
        // 分发 API 错误事件（用于全局 Toast ֪ͨ），静默模式除外
        if (!options?.silent) dispatchApiErrorEvent(err);
        throw err;
      }

      if (err instanceof DOMException && err.name === 'AbortError') {
        // 区分超时取消和外部主动取消：仅当 timedOut 标记为真时才归类为 TIMEOUT
        if (timedOut) {
          const timeoutErr = new ApiError(0, 'TIMEOUT', `请求超时 (${timeoutMs / 1000}s)`);
          if (!options?.silent) dispatchApiErrorEvent(timeoutErr);
          throw timeoutErr;
        }
        // 外部 signal 触发的取消（章节切换/卸载/红石冻结等）归类为 ABORTED，不弹 toast
        throw new ApiError(0, 'ABORTED', '请求已被取消');
      }

      // 网络错误
      const message = err instanceof Error ? err.message : String(err);
      const networkErr = new ApiError(0, 'NETWORK_ERROR', `网络错误: ${message}`);
      if (!options?.silent) dispatchApiErrorEvent(networkErr);
      throw networkErr;
    }
  }

  return {
    get<T>(path: string, params?: Record<string, string>, options?: RequestOptions): Promise<T> {
      return request<T>('GET', path, undefined, params, options);
    },
    post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return request<T>('POST', path, body, undefined, options);
    },
    put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return request<T>('PUT', path, body, undefined, options);
    },
    patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return request<T>('PATCH', path, body, undefined, options);
    },
    delete<T>(path: string, options?: RequestOptions): Promise<T> {
      return request<T>('DELETE', path, undefined, undefined, options);
    },
  };
}

// ---------- 导出单例 ----------

// 动态注入 X-Project-Id 头部：每次请求时从项目 store 读取当前 projectId
// 后端项目级路由根据此头部初始化对应的项目库（每本书独立 .db 文件）
// 采取动态 getter 形式避免顶层 import 循环依赖：stores 不在 apiClient 的加载链上
let _projectIdGetter: (() => string | null | undefined) | null = null;

/**
 * 注册当前 projectId 的 getter 函数。
 * 由项目 store 的入口处调用，避免 apiClient 静态依赖 store 造成循环 import。
 */
export function registerProjectIdGetter(getter: (() => string | null | undefined)): void {
  _projectIdGetter = getter;
}

/**
 * 读取当前项目 ID（供插件 api fetch 等场景注入 X-Project-Id 头）。
 * 未注册 getter 时返回 undefined。
 */
export function getCurrentProjectId(): string | null | undefined {
  return _projectIdGetter?.();
}

/**
 * 解析 API 子路径为完整 URL —— **全仓唯一**知道 API base 的公共函数（D25 收口）。
 *
 * 产品调用点**禁止**再硬编码字面量 `'/api/…'` 或直接读 `import.meta.env.VITE_API_BASE_URL`，
 * 一律经此函数解析；这样 base 只有一处来源，部署时改 `VITE_API_BASE_URL` 即全局生效。
 *
 * 用法：
 *   resolveApiUrl('health')                → `${base}/health`
 *   resolveApiUrl('/plugins/autowrite/x')  → `${base}/plugins/autowrite/x`
 *   resolveApiUrl('/api/health')           → 容错剥离重复前缀 → `${base}/health`
 *
 * @param path 相对 API base 的子路径（可带或不带前导 '/'；可含查询串）
 */
export function resolveApiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
  let p = path.replace(/^\/+/, '');
  // 容错：调用点若仍带 '/api' 前缀，避免拼成 '/api/api/…'
  if (base.endsWith('/api') && (p === 'api' || p.startsWith('api/'))) {
    p = p.slice(3).replace(/^\/+/, '');
  }
  return p ? `${base}/${p}` : base;
}

export const apiClient = createApiClient({
  // 使用相对路径，通过 Vite 开发服务器代理转发到后端
  // 生产环境可以直接使用后端 URL
  baseUrl: import.meta.env.VITE_API_BASE_URL || '/api',
  dynamicHeaders: (): Record<string, string> => {
    const pid = _projectIdGetter?.();
    return pid ? { 'X-Project-Id': pid } : {};
  },
});
