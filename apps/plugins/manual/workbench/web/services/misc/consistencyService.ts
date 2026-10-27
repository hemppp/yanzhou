// ============================================================
// 砚舟 - 一致性检查服务
// 通过后端 API 检查角色、情节、设定、时间线一致性
// ============================================================

import { apiClient } from '@novel-plugins/data-core/api/apiClient';

export interface ConsistencyCheckResult {
  type: 'character' | 'plot' | 'setting' | 'timeline';
  severity: 'error' | 'warning' | 'info';
  message: string;
  chapter?: string;
  suggestion?: string;
}

/**
 * 检查章节一致性
 */
export async function checkConsistency(
  chapterContent: string,
  context: {
    characterNames: string[];
    characterTraits: Record<string, string>;
    previousChapters: string[];
  }
): Promise<ConsistencyCheckResult[]> {
  if (chapterContent.length < 50) return [];

  try {
    const response = await apiClient.post<{
      inconsistencies?: Array<{
        type: string;
        description: string;
        severity: string;
        suggestions?: string[];
      }>;
    }>(
      '/ai/check-consistency',
      {
        projectName: '',
        charactersJson: JSON.stringify(
          context.characterNames.map((name) => ({
            name,
            trait: context.characterTraits[name] || '',
          }))
        ),
        chaptersSummary: context.previousChapters.join('\n').slice(0, 3000),
      },
      { silent: true, timeoutMs: 60_000 }
    );

    if (response && response.inconsistencies) {
      return response.inconsistencies.map((item: any) => ({
        type: mapType(item.type),
        severity: item.severity === 'high' ? 'error' : item.severity === 'medium' ? 'warning' : 'info',
        message: item.description || '',
        suggestion: item.suggestions?.[0] || '',
      }));
    }

    return [];
  } catch (e) {
    // 后端不可用或出错时返回空数组，由调用方静默处理
    console.warn('[consistencyService] 后端不可用，返回空结果:', e instanceof Error ? e.message : e);
    return [];
  }
}

function mapType(type: string): ConsistencyCheckResult['type'] {
  const map: Record<string, ConsistencyCheckResult['type']> = {
    character: 'character',
    plot: 'plot',
    setting: 'setting',
    timeline: 'timeline',
    location: 'setting',
    foreshadow: 'plot',
    worldbuilding: 'setting',
  };
  return map[type] || 'plot';
}
