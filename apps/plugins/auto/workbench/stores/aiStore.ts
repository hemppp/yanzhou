import { create } from 'zustand';
import type { AIScanResult, ConsistencyIssue } from '@novel/shared';
import type { ChatMessage } from '../web/discuss/services/chatService';
import type { StyleProfile } from '@novel-plugins/data-core/editor/styleService';

export interface Suggestion {
  id: string;
  chapterId: string;
  type: 'grammar' | 'style' | 'consistency' | 'plot' | 'character' | 'dialog' | 'pacing';
  severity: 'low' | 'medium' | 'high';
  message: string;
  originalText?: string;
  suggestedText?: string;
  position?: { from: number; to: number };
  createdAt: number;
}

import { getAIConfig, setAIConfig as saveAIConfig } from '../web/discuss/services/aiClient';
import type { AIConfigPatch, AIProvider } from '../web/discuss/services/aiClient';

const MAX_CACHE_ENTRIES = 50;

/**
 * 真正的 LRU 缓存类
 * 使用 Map 数据结构，Map 保持插入顺序，访问时删除再重新插入以维护 LRU 顺序
 */
class LRUCache<T> {
  private cache: Map<string, T>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  /**
   * 获取缓存值，同时更新访问时间（移到 Map 末尾）
   */
  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // 删除再重新插入，移到 Map 末尾（最近访问）
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * 设置缓存值
   */
  set(key: string, value: T): void {
    // 如果键已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 缓存已满，淘汰最久未使用的（Map 的第一个元素）
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * 检查键是否存在
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * 删除指定键
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 转换为普通对象（用于 Zustand store 状态）
   */
  toRecord(): Record<string, T> {
    const record: Record<string, T> = {};
    for (const [key, value] of this.cache) {
      record[key] = value;
    }
    return record;
  }
}

interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: AIProvider;
  apiKeyConfigured?: boolean;
  apiKeyHint?: string;
  /** 服务商标签（如「公益中转站（内置）」）；仅展示用，Key 不回传 */
  label?: string;
  /** 生成参数（可选，未设 = 不干预） */
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

interface SummaryResult {
  summary: string;
  generatedAt: number;
}

const defaultConfig: AIConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4-turbo',
  apiKeyConfigured: false,
};

interface AIStore {
  config: AIConfig;
  // ★ 使用 LRUCache 实例替代 Record，实现真正的 LRU 淘汰策略
  scanResultsCache: LRUCache<AIScanResult>;
  chatHistoryCache: LRUCache<ChatMessage[]>;
  styleProfilesCache: LRUCache<StyleProfile>;
  consistencyIssuesCache: LRUCache<ConsistencyIssue[]>;
  suggestionsCache: LRUCache<Suggestion[]>;
  summaryResultsCache: LRUCache<SummaryResult>;

  updateConfig: (config: AIConfigPatch) => Promise<void>;
  loadConfig: () => Promise<void>;
  resetConfig: () => Promise<void>;

  cacheScanResult: (chapterId: string, result: AIScanResult) => void;
  getScanResult: (chapterId: string) => AIScanResult | undefined;
  clearScanCache: () => void;

  addChatHistory: (messages: ChatMessage[]) => string;
  getChatHistory: (id: string) => ChatMessage[] | undefined;
  clearChatHistory: () => void;

  cacheStyleProfile: (chapterId: string, profile: StyleProfile) => void;
  getStyleProfile: (chapterId: string) => StyleProfile | undefined;
  clearStyleCache: () => void;

  cacheConsistencyIssues: (chapterId: string, issues: ConsistencyIssue[]) => void;
  getConsistencyIssues: (chapterId: string) => ConsistencyIssue[] | undefined;
  clearConsistencyCache: () => void;

  cacheSuggestions: (chapterId: string, suggestions: Suggestion[]) => void;
  getSuggestions: (chapterId: string) => Suggestion[] | undefined;
  clearSuggestionsCache: () => void;

  cacheSummaryResult: (chapterId: string, result: SummaryResult) => void;
  getSummaryResult: (chapterId: string) => SummaryResult | undefined;
  clearSummaryCache: () => void;
}

// Initial config - will be fetched from backend on mount
const initialConfig: AIConfig = {
  ...defaultConfig,
};

// ★ 创建 LRU 缓存实例
const createCaches = () => ({
  scanResultsCache: new LRUCache<AIScanResult>(MAX_CACHE_ENTRIES),
  chatHistoryCache: new LRUCache<ChatMessage[]>(MAX_CACHE_ENTRIES),
  styleProfilesCache: new LRUCache<StyleProfile>(MAX_CACHE_ENTRIES),
  consistencyIssuesCache: new LRUCache<ConsistencyIssue[]>(MAX_CACHE_ENTRIES),
  suggestionsCache: new LRUCache<Suggestion[]>(MAX_CACHE_ENTRIES),
  summaryResultsCache: new LRUCache<SummaryResult>(MAX_CACHE_ENTRIES),
});

export const useAIStore = create<AIStore>((set, get) => ({
  config: initialConfig,
  ...createCaches(),

  updateConfig: async (config) => {
    const current = get().config;
    // 只提交本次修改字段；空 apiKey 表示保留服务端已有 Key。
    await saveAIConfig(config);
    const refreshed = await getAIConfig(true);
    set({
      config: {
        ...current,
        ...refreshed,
        ...(config.apiKey?.trim() ? { apiKey: config.apiKey.trim(), apiKeyConfigured: true } : {}),
      },
    });
  },

  loadConfig: async () => {
    const cfg = await getAIConfig(true);
    set({ config: cfg as AIConfig });
  },
  resetConfig: async () => {
    await saveAIConfig(defaultConfig);
    set({ config: defaultConfig });
  },

  // ★ 使用 LRUCache 的 set 方法，自动维护 LRU 顺序
  cacheScanResult: (chapterId, result) => {
    get().scanResultsCache.set(chapterId, result);
  },

  // ★ 使用 LRUCache 的 get 方法，访问时自动更新 LRU 顺序
  getScanResult: (chapterId) => get().scanResultsCache.get(chapterId),

  clearScanCache: () => {
    get().scanResultsCache.clear();
  },

  addChatHistory: (messages) => {
    const id = Date.now().toString();
    get().chatHistoryCache.set(id, messages);
    return id;
  },

  getChatHistory: (id) => get().chatHistoryCache.get(id),

  clearChatHistory: () => {
    get().chatHistoryCache.clear();
  },

  cacheStyleProfile: (chapterId, profile) => {
    get().styleProfilesCache.set(chapterId, profile);
  },

  getStyleProfile: (chapterId) => get().styleProfilesCache.get(chapterId),

  clearStyleCache: () => {
    get().styleProfilesCache.clear();
  },

  cacheConsistencyIssues: (chapterId, issues) => {
    get().consistencyIssuesCache.set(chapterId, issues);
  },

  getConsistencyIssues: (chapterId) => get().consistencyIssuesCache.get(chapterId),

  clearConsistencyCache: () => {
    get().consistencyIssuesCache.clear();
  },

  cacheSuggestions: (chapterId, suggestions) => {
    get().suggestionsCache.set(chapterId, suggestions);
  },

  getSuggestions: (chapterId) => get().suggestionsCache.get(chapterId),

  clearSuggestionsCache: () => {
    get().suggestionsCache.clear();
  },

  cacheSummaryResult: (chapterId, result) => {
    get().summaryResultsCache.set(chapterId, result);
  },

  getSummaryResult: (chapterId) => get().summaryResultsCache.get(chapterId),

  clearSummaryCache: () => {
    get().summaryResultsCache.clear();
  },
}));
