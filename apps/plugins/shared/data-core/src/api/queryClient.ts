// ============================================================
// 砚舟 - 轻量级数据获取抽象层
// 提供统一的缓存、失效和状态管理能力
// 设计目标：零依赖、类型安全、与 React/Vue 无缝集成
// ============================================================

import type { ApiError } from './apiClient';

// ---------- 类型定义 ----------

/** 查询键，使用字符串数组表示层级关系（类似 React Query） */
export type QueryKey = string[];

/** 缓存条目的状态 */
export interface QueryEntry<T> {
  /** 缓存的数据 */
  data: T;
  /** 缓存时间戳（毫秒） */
  timestamp: number;
  /** 是否正在获取中 */
  isFetching: boolean;
}

/** 查询配置选项 */
export interface QueryOptions {
  /** 缓存有效时间（毫秒），默认 5 分钟（300000ms） */
  staleTime?: number;
  /** 缓存最大存活时间（毫秒），默认 30 分钟（1800000ms） */
  gcTime?: number;
  /** 是否在窗口获得焦点时重新获取（默认 true） */
  refetchOnWindowFocus?: boolean;
}

/** 变更（Mutation）配置选项 */
export interface MutationOptions<TData = unknown, TVariables = void> {
  /** 变更成功后自动使哪些查询失效 */
  invalidateKeys?: QueryKey[];
  /** 成功回调 */
  onSuccess?: (data: TData) => void;
  /** 错误回调 */
  onError?: (error: Error | ApiError) => void;
  /** 变更函数 */
  mutationFn: (variables: TVariables) => Promise<TData>;
}

/** 默认配置 */
const DEFAULT_OPTIONS: Required<QueryOptions> = {
  staleTime: 5 * 60 * 1000, // 5 分钟
  gcTime: 30 * 60 * 1000,   // 30 分钟
  refetchOnWindowFocus: true,
};

// ---------- 内部状态 ----------

/**
 * 内存缓存存储
 * 键 = JSON 序列化的 QueryKey
 */
const cache = new Map<string, QueryEntry<unknown>>();

/**
 * 正在进行的请求去重映射
 * 避免同一查询键并发请求多次
 */
const pendingRequests = new Map<string, Promise<unknown>>();

// ---------- 内部工具函数 ----------

/**
 * 将 QueryKey 序列化为缓存键
 * 确保相同顺序的数组产生相同的字符串
 */
function serializeKey(key: QueryKey): string {
  return JSON.stringify(key);
}

/**
 * 检查缓存条目是否过期（陈旧）
 */
function isStale<T>(entry: QueryEntry<T>, staleTime: number): boolean {
  return Date.now() - entry.timestamp > staleTime;
}

/**
 * 检查缓存条目是否应被垃圾回收
 */
function shouldGc(entry: QueryEntry<unknown>, gcTime: number): boolean {
  return Date.now() - entry.timestamp > gcTime;
}

/**
 * 执行垃圾回收：清除所有过期的缓存条目
 * 应在定时器或特定事件后调用
 */
function garbageCollect(): void {
  for (const [key, entry] of cache.entries()) {
    if (shouldGc(entry, DEFAULT_OPTIONS.gcTime)) {
      cache.delete(key);
    }
  }
}

// ---------- 公开 API ----------

/**
 * 执行数据查询（带缓存）
 *
 * @template T - 返回数据的类型
 * @param 键 - 查询键，用于标识和缓存数据
 * @param fetcher - 数据获取函数，仅在缓存未命中或已过期时调用
 * @param options - 查询选项（缓存时间等）
 * @返回 查询结果数据
 *
 * @example
 * ```ts
 * const projects = await query(
 *   ['projects', userId],
 *   () => apiClient.获取<Project[]>('/API/projects', { userId }),
 *   { staleTime: 60000 } // 1 分钟内不重新请求
 * );
 * ```
 */
export async function query<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
  options: QueryOptions = {},
): Promise<T> {
  const { staleTime = DEFAULT_OPTIONS.staleTime } = options;
  const cacheKey = serializeKey(key);
  const cached = cache.get(cacheKey);

  // 1. 如果有缓存且未过期，直接返回
  if (cached && !isStale(cached, staleTime)) {
    return cached.data as T;
  }

  // 2. 如果已有相同 键 的请求在进行中，复用该 Promise（请求去重）
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey) as Promise<T>;
  }

  // 3. 发起新请求
  const fetchPromise = fetcher()
    .then((data) => {
      // 存入缓存
      cache.set(cacheKey, {
        data,
        timestamp: Date.now(),
        isFetching: false,
      });
      // 清除进行中的请求记录
      pendingRequests.delete(cacheKey);
      return data;
    })
    .catch((error) => {
      // 失败时也清除请求记录，允许重试
      pendingRequests.delete(cacheKey);
      throw error;
    });

  // 标记为正在获取
  pendingRequests.set(cacheKey, fetchPromise);

  return fetchPromise;
}

/**
 * 使指定查询的缓存失效
 *
 * 下次调用 query() 时将强制重新获取数据。
 * 支持前缀匹配：如果传入 `['projects']`，
 * 则 `['projects', '123']` 和 `['projects', '456']` 都会被失效。
 *
 * @param 键 - 要失效的查询键（支持前缀匹配）
 *
 * @example
 * ```ts
 * // 创建项目后，使项目列表缓存失效
 * await mutate('createProject', createFn, {
 *   invalidateKeys: [['projects']],
 * });
 * ```
 */
export function invalidateQuery(key: QueryKey): void {
  const targetPrefix = serializeKey(key);

  for (const cacheKey of cache.keys()) {
    // 前缀匹配：缓存的 键 以目标 键 开头（去除末尾的 ]）
    if (cacheKey.startsWith(targetPrefix.slice(0, -1))) {
      cache.delete(cacheKey);
    }
  }

  // 同时执行垃圾回收
  garbageCollect();
}

/**
 * 使所有缓存失效
 */
export function invalidateAllQueries(): void {
  cache.clear();
  pendingRequests.clear();
}

/**
 * 执行变更操作（Mutation）
 *
 * 变更是对服务端数据的修改操作（POST/PUT/DELETE），
 * 成功后可自动使相关查询缓存失效。
 *
 * @template TData - 返回数据类型
 * @template TVariables - 参数类型
 * @param 标签 - 变更标签（用于日志追踪）
 * @param options - 变更配置
 * @返回 变更结果
 *
 * @example
 * ```ts
 * const newProject = await mutate('createProject', {
 *   mutationFn: (data) => apiClient.post('/API/projects', data),
 *   invalidateKeys: [['projects']],
 *   onSuccess: (result) => Toast.成功('创建成功'),
 *   onError: (err) => Toast.错误(err.消息),
 * });
 * ```
 */
export async function mutate<TData = unknown, TVariables = void>(
  _label: string,
  options: MutationOptions<TData, TVariables>,
): Promise<TData> {
  const { mutationFn, invalidateKeys, onSuccess, onError } = options;

  try {
    const result = await mutationFn({} as TVariables);

    // 成功后自动使相关查询失效
    if (invalidateKeys) {
      for (const key of invalidateKeys) {
        invalidateQuery(key);
      }
    }

    onSuccess?.(result);
    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError?.(err as Error | ApiError);
    throw err;
  }
}

/**
 * 从缓存中预设数据（用于乐观更新或 SSR hydration）
 *
 * @param 键 - 查询键
 * @param data - 要预设的数据
 */
export function setQueryData<T>(key: QueryKey, data: T): void {
  const cacheKey = serializeKey(key);
  cache.set(cacheKey, {
    data,
    timestamp: Date.now(),
    isFetching: false,
  });
}

/**
 * 获取缓存中的数据（不触发请求）
 *
 * @param 键 - 查询键
 * @返回 缓存的数据，不存在则返回 undefined
 */
export function getQueryData<T>(key: QueryKey): T | undefined {
  const cacheKey = serializeKey(key);
  const entry = cache.get(cacheKey);
  return entry?.data as T | undefined;
}

/**
 * 移除指定查询的缓存
 */
export function removeQuery(key: QueryKey): void {
  const cacheKey = serializeKey(key);
  cache.delete(cacheKey);
}

/**
 * 设置窗口焦点监听（可选启用）
 * 当窗口重新获得焦点时，标记所有缓存为过期
 * 需要在应用启动时调用一次
 *
 * @param 启用 - 是否启用（默认 false）
 */
export function setupRefetchOnFocus(enabled: boolean = false): void {
  if (!enabled || typeof window === 'undefined') return;

  window.addEventListener('focus', () => {
    // 标记所有缓存为过期（通过将 timestamp 设为 0 实现）
    for (const [, entry] of cache.entries()) {
      entry.timestamp = 0;
    }
  });
}
