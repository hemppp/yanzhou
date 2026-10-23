import { create } from 'zustand';

// ============================================================
// AI 功能开关 Store (Redstone - 红石开关)
// 用于全局控制各 AI 功能的启用/冻结状态
// ============================================================

/**
 * AI 功能名称类型
 *
 * 必须与后端 `apps/server/src/modules/ai.ts` 的 `UserAISettings` 接口对齐：
 * - chat / extract / consistency / style
 * - scanner（章节扫描：/scan、/scan-timeline-stream、/extract-events-stream）
 * - plot（/generate-character、/generate-plot）
 * - rhythm（/analyze-rhythm）
 * - timeline（/analyze-timeline）
 * - quick-phrases（快捷短语）
 *
 * 注意：前端「实体提取」UI 开关历史上叫 `extract`，但后端章节扫描路由用的是 `scanner`。
 * 两者语义有别：`extract` 控制 useLatestChapterPolling，`scanner` 控制 useAutoEntityDetection。
 * 这里把两个都暴露出来，由 UI 决定如何呈现（可合并为一个开关，但底层字段独立）。
 *
 * ★ ghost（幽灵灵感）、scene-predictor（场景预判）、continuation（续写建议）均已下线。
 */
export type AIFeature =
  | 'chat'
  | 'extract'
  | 'consistency'
  | 'style'
  | 'scanner'
  | 'plot'
  | 'rhythm'
  | 'timeline'
  | 'quick-phrases';

/** AI 功能状态对象 */
export interface AIFeatures {
  chat: boolean;
  extract: boolean;
  consistency: boolean;
  style: boolean;
  scanner: boolean;
  plot: boolean;
  rhythm: boolean;
  timeline: boolean;
  'quick-phrases': boolean;
}

/** AI Redstone Store 状态接口 */
export interface AIRedstoneState {
  /** 各 AI 功能的开关状态 */
  features: AIFeatures;
  
  /** 所有功能是否都被冻结 */
  allFrozen: boolean;
  
  /** 正在进行的 AI 请求的 AbortController 映射 */
  pendingAbortControllers: Map<string, AbortController>;
  
  /** 切换单个功能的开关状态 */
  toggleFeature: (feature: AIFeature) => void;
  
  /** 冻结所有 AI 功能，并中止所有正在进行的请求 */
  freezeAll: () => void;
  
  /** 解冻所有 AI 功能 */
  unfreezeAll: () => void;
  
  /** 注册一个 AI 请求的 AbortController，返回 unregister 函数 */
  registerAbort: (feature: AIFeature, controller: AbortController) => () => void;

  /** 注销已完成的请求（请求自然完成时调用，避免 Map 无限增长） */
  unregisterAbort: (feature: AIFeature, controller: AbortController) => void;

  /** 中止特定功能的所有正在进行的请求 */
  abortFeature: (feature: AIFeature) => void;
}

/** 默认功能状态（全部开启） */
const defaultFeatures: AIFeatures = {
  chat: true,
  extract: true,
  consistency: true,
  style: true,
  scanner: true,
  plot: true,
  rhythm: true,
  timeline: true,
  'quick-phrases': true,
};

/** 创建 AI Redstone Store */
export const useAIRedstoneStore = create<AIRedstoneState>((set, get) => ({
  features: { ...defaultFeatures },

  pendingAbortControllers: new Map(),

  /**
   * 所有功能是否都被冻结。
   * 注意：不能用 getter（get allFrozen()），Zustand 浅拷贝后 getter 会退化为静态值。
   * 这里维护显式 state 字段，在 toggleFeature/freezeAll/unfreezeAll 中同步更新，保证响应式。
   */
  allFrozen: false,

  /**
   * 切换单个功能的开关状态
   * @param feature - 要切换的功能名称
   */
  toggleFeature: (feature: AIFeature) => {
    set((state) => {
      const features = {
        ...state.features,
        [feature]: !state.features[feature],
      };
      return {
        features,
        allFrozen: Object.values(features).every((enabled) => !enabled),
      };
    });
  },
  
  /**
   * 冻结所有 AI 功能
   * - 将所有 features 设为 false
   * - 中止所有正在进行的请求
   * - 清空 pendingAbortControllers
   */
  freezeAll: () => {
    const { pendingAbortControllers } = get();

    // 中止所有正在进行的请求
    pendingAbortControllers.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        // 忽略中止过程中的错误
      }
    });

    // 更新状态
    set({
      features: {
        chat: false,
        extract: false,
        consistency: false,
        style: false,
        scanner: false,
        plot: false,
        rhythm: false,
        timeline: false,
        'quick-phrases': false,
      },
      allFrozen: true,
      pendingAbortControllers: new Map(),
    });
  },

  /**
   * 解冻所有 AI 功能
   * - 将所有 features 设为 true
   */
  unfreezeAll: () => {
    set({
      features: { ...defaultFeatures },
      allFrozen: false,
    });
  },
  
  /**
   * 注册一个 AI 请求的 AbortController
   * @param feature - 功能名称
   * @param controller - AbortController 实例
   * @returns unregister 函数，请求完成时调用以从 Map 中移除，避免内存泄漏
   */
  registerAbort: (feature: AIFeature, controller: AbortController) => {
    const key = `${feature}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((state) => {
      const newMap = new Map(state.pendingAbortControllers);
      newMap.set(key, controller);
      return { pendingAbortControllers: newMap };
    });
    // 返回 unregister 函数，调用方在请求完成（成功/失败/abort）后调用
    return () => {
      const newMap = new Map(get().pendingAbortControllers);
      if (newMap.delete(key)) {
        set({ pendingAbortControllers: newMap });
      }
    };
  },

  /**
   * 注销已完成的请求（兼容旧接口，推荐使用 registerAbort 返回的 unregister 函数）
   */
  unregisterAbort: (feature: AIFeature, controller: AbortController) => {
    set((state) => {
      const newMap = new Map(state.pendingAbortControllers);
      let removed = false;
      // 通过引用相等查找对应的 key
      for (const [key, ctrl] of newMap) {
        if (ctrl === controller && key.startsWith(feature)) {
          newMap.delete(key);
          removed = true;
          break;
        }
      }
      return removed ? { pendingAbortControllers: newMap } : state;
    });
  },
  
  /**
   * 中止特定功能的所有正在进行的请求
   * @param feature - 要中止的功能名称
   */
  abortFeature: (feature: AIFeature) => {
    set((state) => {
      const newMap = new Map(state.pendingAbortControllers);
      const keysToRemove: string[] = [];
      
      // 查找并中止该功能的所有请求
      newMap.forEach((controller, key) => {
        if (key.startsWith(feature)) {
          try {
            controller.abort();
          } catch {
            // 忽略中止过程中的错误
          }
          keysToRemove.push(key);
        }
      });
      
      // 从 映射 中移除已中止的请求
      keysToRemove.forEach((key) => newMap.delete(key));
      
      return { pendingAbortControllers: newMap };
    });
  },
}));


