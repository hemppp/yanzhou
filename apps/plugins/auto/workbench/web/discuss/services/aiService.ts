// ============================================================
// AI 服务 - 通过后端 API 调用 AI 能力
// ============================================================

import type { AIScanResult } from '@novel/shared';
import { apiClient } from '@novel-plugins/data-core/api/apiClient';

export interface AiChatOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * AI 服务
 */
export class AIService {
  /**
   * 聊天对话
   */
  async chat(
    messages: { role: string; content: string }[],
    _options?: AiChatOptions
  ): Promise<string> {
    try {
      const response = await apiClient.post<{ response: string }>('/ai/chat', {
        simple: true,
        conversationHistory: messages.map(m => ({
          role: m.role === 'system' ? 'user' : m.role,
          content: m.content,
        })),
        userMessage: messages[messages.length - 1]?.content || '',
      }, { timeoutMs: 60_000 });
      return response.response || '';
    } catch (e) {
      return '[错误] ' + (e instanceof Error ? e.message : '未知错误');
    }
  }

  /**
   * 扫描章节 - 提取角色/物品/地点/事件
   */
  async scanChapter(
    chapterContent: string,
    existingEntities: { roles: string[]; items: string[]; locations: string[] }
  ): Promise<AIScanResult> {
    if (chapterContent.length < 20) {
      return this.emptyResult();
    }

    try {
      const response = await apiClient.post<AIScanResult>('/ai/scan', {
        chapterContent,
        chapterTitle: '',
        chapterOrder: 0,
        projectName: '',
        existingEntities: JSON.stringify({
          characters: existingEntities.roles,
          items: existingEntities.items,
          locations: existingEntities.locations,
        }),
      }, { timeoutMs: 60_000 });

      return response;
    } catch {
      return this.emptyResult();
    }
  }

  private emptyResult(): AIScanResult {
    return {
      chapterId: '',
      characters: [],
      items: [],
      locations: [],
      events: [],
      stateChanges: [],
      foreshadowSuggestions: [],
      consistencyIssues: [],
    };
  }
}

export const aiService = new AIService();