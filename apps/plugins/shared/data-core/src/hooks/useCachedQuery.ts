// ============================================================
// 砚舟 - 缓存查询的 React 绑定（useCachedQuery）
//
// 背景：queryClient（`../api/queryClient`）已经提供了进程内缓存、请求去重与
// 失效能力，但它只是 Promise 层——组件 `await` 它的时候没有任何「旧值可先渲染」
// 的通道，所以即便缓存命中，重新挂载的页面仍会先渲染一帧加载态。
// 这个 Hook 把缓存接到组件生命周期上，补上缺失的那一段：
//
//   1) 挂载时**同步**用缓存里的旧值做初始 state —— 回到访问过的页面立刻出内容，
//      不闪「加载中」；
//   2) 挂载后仍然在后台重新校验（默认 staleTime=0，即每次都拉），拿到新数据
//      再平滑替换 —— 所以「不闪加载」不等于「看旧数据」；
//   3) 查询键变化时（例如在项目之间跳转）立刻切到新键的缓存值，不会残留
//      上一个键的数据；
//   4) 组件卸载后不再 setState。
//
// 与 React Query 的差别：不做全局订阅/共享状态，每个 Hook 实例各自持有一份
// state，仅靠 queryClient 的缓存做跨实例的「秒出」。对本项目的页面级取数够用，
// 且零新依赖。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { getQueryData, query, type QueryKey, type QueryOptions } from '../api/queryClient';

export interface CachedQueryOptions extends QueryOptions {
  /** false 时不发请求（条件查询），默认 true */
  enabled?: boolean;
}

export interface CachedQueryResult<T> {
  /** 当前数据；从未命中过缓存且首次请求未回来时为 undefined */
  data: T | undefined;
  /** 首次加载且没有任何可用数据（有缓存旧值时恒为 false）——用来决定是否显示骨架屏 */
  isLoading: boolean;
  /** 后台请求进行中（含首次请求）——用来显示「刷新中」一类的轻提示 */
  isFetching: boolean;
  error: Error | null;
  /** 立即重新拉取（跳过 staleTime），返回最新数据 */
  refresh: () => Promise<T | undefined>;
}

interface QueryState<T> {
  key: string;
  data: T | undefined;
  hasData: boolean;
  error: Error | null;
}

/**
 * 带缓存的查询 Hook。
 *
 * @param key     查询键（字符串数组，前缀语义与 queryClient 一致）
 * @param fetcher 取数函数（不必 useCallback 包裹，内部用 ref 承载）
 * @param options staleTime 默认 **0**（挂载即后台重新校验）；传 >0 可减少重复请求
 */
export function useCachedQuery<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
  options: CachedQueryOptions = {},
): CachedQueryResult<T> {
  const { enabled = true, staleTime = 0, ...restOptions } = options;
  const keyString = JSON.stringify(key);

  // fetcher / options 通常写成内联字面量，每次渲染引用都变；
  // 用 ref 承载，避免把它们写进 effect 依赖导致无限重取。
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef<QueryOptions>({ staleTime, ...restOptions });
  optionsRef.current = { staleTime, ...restOptions };

  const [state, setState] = useState<QueryState<T>>(() => {
    const cached = enabled ? getQueryData<T>(key) : undefined;
    return { key: keyString, data: cached, hasData: enabled && cached !== undefined, error: null };
  });
  const [isFetching, setIsFetching] = useState(false);

  // 渲染期派生：键变了就立刻改用新键的缓存值（React 官方的「按 props 调整 state」
  // 模式，守卫住条件因此不会死循环）。放在渲染期而不是 effect 里，是为了不出现
  // 「一帧显示上一个键的数据」。
  if (state.key !== keyString) {
    const cached = enabled ? getQueryData<T>(key) : undefined;
    setState({ key: keyString, data: cached, hasData: enabled && cached !== undefined, error: null });
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setIsFetching(true);
    query<T>(key, () => fetcherRef.current(), optionsRef.current)
      .then((next) => {
        if (!cancelled) setState({ key: keyString, data: next, hasData: true, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            error: e instanceof Error ? e : new Error(String(e)),
          }));
        }
      })
      .finally(() => {
        if (!cancelled) setIsFetching(false);
      });
    return () => { cancelled = true; };
    // keyString 是 key 的内容指纹；enabled 变化需要重新判定是否取数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyString, enabled]);

  const refresh = useCallback(async (): Promise<T | undefined> => {
    if (!enabled) return undefined;
    setIsFetching(true);
    try {
      const next = await query<T>(key, () => fetcherRef.current(), optionsRef.current);
      setState({ key: keyString, data: next, hasData: true, error: null });
      return next;
    } catch (e) {
      setState((prev) => ({ ...prev, error: e instanceof Error ? e : new Error(String(e)) }));
      return undefined;
    } finally {
      setIsFetching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyString, enabled]);

  return {
    data: state.data,
    // 有缓存旧值时 isLoading 恒为 false（页面直接出内容），只靠 isFetching 表示后台刷新
    isLoading: enabled && !state.hasData && state.error === null,
    isFetching,
    error: state.error,
    refresh,
  };
}
