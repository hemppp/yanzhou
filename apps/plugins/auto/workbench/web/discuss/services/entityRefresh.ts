// ============================================================
// 实体 Store 刷新工具
//
// AI 工具调用写入实体后，前端需要从后端重新拉取数据刷新 store，
// 让用户在角色库/伏笔/地点/物品面板中看到最新内容。
//
// 刷新策略：按 entity.type 只刷新受影响的 store，避免全量拉取。
// ============================================================

import { apiClient } from '@novel-plugins/data-core/api/apiClient';
import { useCharacterStore, useForeshadowStore, useLocationStore, useItemStore } from '@novel-plugins/data-core/stores';
import type { Character, Foreshadow, Location, Item } from '@novel/shared';

/**
 * 刷新指定类型的实体 store。
 * 在 AI 工具调用执行成功后调用。
 */
export async function refreshEntityStore(
  entityType: 'character' | 'foreshadow' | 'location' | 'item',
  projectId: string,
): Promise<void> {
  if (!projectId) return;
  try {
    switch (entityType) {
      case 'character': {
        const list = await apiClient.get<Character[]>(
          `/characters/projects/${encodeURIComponent(projectId)}`,
        );
        useCharacterStore.getState().setCharacters(list || []);
        break;
      }
      case 'foreshadow': {
        const list = await apiClient.get<Foreshadow[]>(
          `/foreshadows/projects/${encodeURIComponent(projectId)}`,
        );
        useForeshadowStore.getState().setForeshadows(list || []);
        break;
      }
      case 'location': {
        const list = await apiClient.get<Location[]>(
          `/locations/projects/${encodeURIComponent(projectId)}`,
        );
        useLocationStore.getState().setLocations(list || []);
        break;
      }
      case 'item': {
        const list = await apiClient.get<Item[]>(
          `/items/projects/${encodeURIComponent(projectId)}`,
        );
        useItemStore.getState().setItems(list || []);
        break;
      }
    }
  } catch (e) {
    console.warn(`[entityRefresh] 刷新 ${entityType} store 失败:`, e);
  }
}
