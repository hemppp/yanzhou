// ============================================================
// NovelMuse - 网页搜索服务
// 通过后端 /api/search 代理调用搜索 API，避免前端直连外部服务
// ============================================================

import { validateUserInput, filterSearchContent } from './securityService';
import { apiClient } from '@novel-plugins/data-core/api/apiClient';

// 搜索结果接口
export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

// 搜索配置接口
export interface WebSearchConfig {
  /** 搜索结果数量 */
  maxResults: number;
  /** 搜索超时时间(ms) */
  timeout: number;
  /** 启用安全过滤 */
  enableSecurityFilter: boolean;
}

const DEFAULT_SEARCH_CONFIG: WebSearchConfig = {
  maxResults: 5,
  timeout: 30000,
  enableSecurityFilter: true,
};

/**
 * 搜索请求接口
 */
export interface SearchRequest {
  query: string;
  scene?: 'scene' | 'character' | 'dialogue' | 'emotion';
}

/**
 * 执行网页搜索（通过后端 /api/search 代理）
 * @param request 搜索请求
 * @param config 搜索配置
 * @param signal 可选的 AbortSignal
 * @returns 搜索结果
 */
export async function webSearch(
  request: SearchRequest,
  config: WebSearchConfig = DEFAULT_SEARCH_CONFIG,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const { query, scene } = request;

  // 安全验证输入（前端防御性过滤，后端也会做）
  if (config.enableSecurityFilter) {
    const { safe } = validateUserInput(query);
    if (!safe) {
      console.warn('[WebSearch] 输入包含危险内容，已拒绝:', query);
      return [];
    }
  }

  // 构建优化的搜索查询
  const enhancedQuery = buildEnhancedQuery(query, scene);

  try {
    const data = await apiClient.post<{ results: SearchResult[] }>(
      '/search',
      { query: enhancedQuery, maxResults: config.maxResults },
      { signal, silent: true }
    );

    const results = data?.results ?? [];

    // 对返回结果进行二次安全过滤
    const filteredResults = results.map(r => ({
      ...r,
      snippet: filterSearchContent(r.snippet),
    }));

    return filteredResults;
  } catch (error) {
    console.error('[WebSearch] 搜索失败:', error);
    return [];
  }
}

/**
 * 构建增强的搜索查询
 */
function buildEnhancedQuery(
  originalQuery: string,
  scene?: 'scene' | 'character' | 'dialogue' | 'emotion'
): string {
  const prefix = getScenePrefix(scene);
  return `${prefix} ${originalQuery}`.trim();
}

/**
 * 根据场景类型获取搜索前缀
 */
function getScenePrefix(scene?: 'scene' | 'character' | 'dialogue' | 'emotion'): string {
  switch (scene) {
    case 'scene':
      return '小说场景描写 恢宏气势 细节描写';
    case 'character':
      return '人物描写 动作 神态 心理描写';
    case 'dialogue':
      return '对话描写 人物语言 潜台词';
    case 'emotion':
      return '情感描写 心理活动 氛围营造';
    default:
      return '小说素材 写作参考 场景描写';
  }
}

/**
 * 使用 AI 总结搜索结果
 * @param results 搜索结果
 * @param context 上下文（当前场景描述）
 * @param signal 可选的 AbortSignal
 * @returns 总结后的素材
 */
export async function summarizeSearchResultsWithAI(
  results: SearchResult[],
  _context?: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const prompt = '请对以下搜索结果进行总结（100-200字），提炼关键信息：\n\n搜索结果：\n';

    const response = await apiClient.post<{ response: string }>(
      '/ai/chat',
      {
        simple: true,
        userMessage: prompt,
        conversationHistory: [],
        projectName: '',
        phase: '搜索总结',
      },
      { signal, silent: true }
    );

    return response.response || results.map(r => r.snippet).slice(0, 3).join(' | ');
  } catch (e) {
    console.warn('[WebSearch] AI 总结失败:', e);
    return results.map(r => r.snippet).slice(0, 3).join(' | ');
  }
}

export default {
  webSearch,
  summarizeSearchResultsWithAI,
  DEFAULT_SEARCH_CONFIG,
};
