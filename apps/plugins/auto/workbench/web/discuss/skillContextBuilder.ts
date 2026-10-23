// ============================================================
// 技能上下文收集器
//
// 根据技能声明的 contextKeys，从各 Store 收集实体数据并格式化为
// 文本，通过 NovelChatContext.extraContext 透传给后端。
//
// 后端会在 system prompt 末尾追加：
//   【技能注入上下文】
//   <这里的内容>
//
// 设计要点：
//   - 每个 contextKey 对应一个收集器，互不耦合
//   - 数据量大时自动截断（避免超过 LLM 上下文窗口）
//   - 仅收集当前项目的实体（按 projectId 过滤）
// ============================================================

import {
  useCharacterStore,
  useForeshadowStore,
  useItemStore,
  useLocationStore,
  useEventStore,
  useOutlineStore,
  useTimelineStore,
} from '@novel-plugins/data-core/stores';
// ★ D46：技能类型已随注册表下沉 shared
import type { SkillContextKey } from '@novel-plugins/data-core';

/** 单类上下文最大条数（防止 token 爆炸） */
const MAX_ITEMS_PER_TYPE = 30;

/** 收集角色库上下文 */
function collectCharacters(projectId: string): string {
  const chars = useCharacterStore.getState().characters.filter(c => c.projectId === projectId);
  if (chars.length === 0) return '';
  const limited = chars.slice(0, MAX_ITEMS_PER_TYPE);
  const lines = limited.map(c => {
    const parts = [`- ${c.name}`];
    if (c.aliases?.length) parts.push(`别名:${c.aliases.join('/')}`);
    if (c.appearance) parts.push(`外貌:${c.appearance}`);
    if (c.personality) parts.push(`性格:${c.personality}`);
    if (c.backstory) parts.push(`背景:${c.backstory.slice(0, 80)}`);
    if (c.role) parts.push(`定位:${c.role}`);
    return parts.join(' | ');
  });
  return `【角色库】（共 ${chars.length} 个，显示 ${limited.length} 个）\n${lines.join('\n')}`;
}

/** 收集伏笔列表上下文 */
function collectForeshadows(projectId: string): string {
  const fs = useForeshadowStore.getState().foreshadows.filter(f => f.projectId === projectId);
  if (fs.length === 0) return '';
  const limited = fs.slice(0, MAX_ITEMS_PER_TYPE);
  const lines = limited.map(f => {
    const parts = [`- [${f.type}] ${f.description}`];
    if (f.seedChapter) parts.push(`铺垫:第${f.seedChapter}章`);
    if (f.payoffChapter) parts.push(`回收:第${f.payoffChapter}章`);
    else parts.push(`状态:未回收`);
    return parts.join(' | ');
  });
  return `【伏笔列表】（共 ${fs.length} 条，显示 ${limited.length} 条）\n${lines.join('\n')}`;
}

/** 收集大纲上下文 */
function collectOutline(projectId: string): string {
  const nodes = useOutlineStore.getState().nodes.filter(n => n.projectId === projectId);
  if (nodes.length === 0) return '';
  const limited = nodes.slice(0, MAX_ITEMS_PER_TYPE);
  const lines = limited.map(n => {
    const parts = [`- [${n.type}] ${n.title}`];
    if (n.description) parts.push(`描述:${n.description.slice(0, 80)}`);
    return parts.join(' | ');
  });
  return `【大纲节点】（共 ${nodes.length} 个，显示 ${limited.length} 个）\n${lines.join('\n')}`;
}

/** 收集地点库上下文 */
function collectLocations(projectId: string): string {
  const locs = useLocationStore.getState().locations.filter(l => l.projectId === projectId);
  if (locs.length === 0) return '';
  const limited = locs.slice(0, MAX_ITEMS_PER_TYPE);
  const lines = limited.map(l => {
    const parts = [`- ${l.name}`];
    if (l.world) parts.push(`世界:${l.world}`);
    if (l.description) parts.push(`描述:${l.description.slice(0, 80)}`);
    return parts.join(' | ');
  });
  return `【地点库】（共 ${locs.length} 个，显示 ${limited.length} 个）\n${lines.join('\n')}`;
}

/** 收集物品库上下文 */
function collectItems(projectId: string): string {
  const items = useItemStore.getState().items.filter(i => i.projectId === projectId);
  if (items.length === 0) return '';
  const limited = items.slice(0, MAX_ITEMS_PER_TYPE);
  const lines = limited.map(i => {
    const parts = [`- ${i.name}`];
    if (i.type) parts.push(`类型:${i.type}`);
    if (i.description) parts.push(`描述:${i.description.slice(0, 80)}`);
    if (i.currentHolders?.length) {
      const holderNames = i.currentHolders
        .map(hid => useCharacterStore.getState().characters.find(c => c.id === hid)?.name)
        .filter(Boolean);
      if (holderNames.length) parts.push(`持有者:${holderNames.join('/')}`);
    }
    return parts.join(' | ');
  });
  return `【物品库】（共 ${items.length} 个，显示 ${limited.length} 个）\n${lines.join('\n')}`;
}

/** 收集事件上下文（时间线事件 + 故事事件） */
function collectEvents(projectId: string): string {
  const tlEvents = useTimelineStore.getState().events.filter(e => e.projectId === projectId);
  const storyEvents = useEventStore.getState().events.filter(e => e.projectId === projectId);
  if (tlEvents.length === 0 && storyEvents.length === 0) return '';

  const parts: string[] = [`【事件列表】`];
  if (tlEvents.length > 0) {
    const limited = tlEvents.slice(0, MAX_ITEMS_PER_TYPE);
    parts.push(`时间线事件（共 ${tlEvents.length} 条，显示 ${limited.length} 条）:`);
    for (const e of limited) {
      const line = `  - 第${e.chapter}章: ${e.title || e.description?.slice(0, 40) || '未命名事件'}`;
      parts.push(line);
    }
  }
  if (storyEvents.length > 0) {
    const limited = storyEvents.slice(0, MAX_ITEMS_PER_TYPE);
    parts.push(`故事事件（共 ${storyEvents.length} 条，显示 ${limited.length} 条）:`);
    for (const e of limited) {
      parts.push(`  - 第${e.chapter}章: ${e.title || e.description?.slice(0, 40) || '未命名事件'}`);
    }
  }
  return parts.join('\n');
}

/**
 * 根据技能声明的 contextKeys 收集上下文。
 *
 * @param projectId 当前项目 ID
 * @param contextKeys 技能需要的上下文类型列表
 * @returns 格式化的上下文文本，若无任何数据返回空字符串
 */
export function buildSkillContext(projectId: string, contextKeys: SkillContextKey[]): string {
  if (!contextKeys || contextKeys.length === 0) return '';

  const collectors: Record<SkillContextKey, (pid: string) => string> = {
    characters: collectCharacters,
    foreshadows: collectForeshadows,
    outline: collectOutline,
    locations: collectLocations,
    items: collectItems,
    events: collectEvents,
  };

  const parts: string[] = [];
  for (const key of contextKeys) {
    const text = collectors[key](projectId);
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}
