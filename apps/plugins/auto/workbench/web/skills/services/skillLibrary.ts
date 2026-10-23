// ============================================================
// 集中式 Skills 库 —— 前端客户端
//
// 对接后端路由（设计见 docs/architecture/skills-library.md）：
//   GET    /api/ai/skill-library              库里全部技能（按两类分开）+ 孤儿归属
//   POST   /api/ai/skill-library/install      安装 / 重装
//   DELETE /api/ai/skill-library/:id          删除
//   GET    /api/ai/skill-targets              全部智能体 + 技能计数
//   GET    /api/ai/skill-targets/:agentId     某智能体的技能 + 开关
//   PUT    /api/ai/skill-targets/:agentId/toggle       单条开关
//   PUT    /api/ai/skill-targets/:agentId/toggle-all   批量开关
//
// ★ apiClient 自带 `/api` 前缀并自动解包 `{data:...}`，所以这里只写 `/ai/...`
//   （与 pipelineSession 的 SSE 不同 —— 那要走裸 fetch 写全路径）。
// ============================================================

import { apiClient } from '@novel-plugins/data-core/api/apiClient';

/** 'assistant' = 智能体 skills；'agent' = agent skills（按用户口径的分类存放） */
export type SkillCategory = 'assistant' | 'agent';

export interface LibrarySkill {
  id: string;
  name: string;
  description: string;
  color: string;
  iconKey: string;
  category: SkillCategory;
  ownerAgent: string | null;
  ownerAgentName: string | null;
  systemPrompt: string;
  contextKeys: string[];
  source: 'builtin' | 'installed';
  /**
   * 归属可见性（2026-09-17 加）：
   *   'public'  = 内置 / 插件带 —— 所有用户可见，谁都能删
   *   'private' = 当前用户自己上传的 —— 只有本人可见、只有本人能删
   * 后端由 `user_id` 是否为 NULL 推出，不下发 raw userId。
   */
  visibility?: 'public' | 'private';
  createdAt: number;
  updatedAt: number;
}

export interface SkillTargetView {
  id: string;
  name: string;
  kind: 'assistant' | 'agent';
  short: string;
  color: string;
  description: string;
  group: string;
  source: 'core' | 'plugin';
  total: number;
  enabled: number;
}

export interface TargetSkill extends LibrarySkill {
  enabled: boolean;
  /** 是否被显式配置过 —— 没配过就是"默认关"，界面要能区分 */
  configured: boolean;
}

export interface TargetSkillsView {
  target: SkillTargetView;
  skills: TargetSkill[];
}

/** 归属写了但智能体清单里没声明 —— 界面必须显式提示，否则"装了却看不见"无从排查 */
export interface OrphanOwner { agentId: string; count: number; skillIds: string[] }

const BASE = '/ai';

/** 技能市场里的一条（公共目录条目 + 我装没装） */
export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  ownerAgent: string | null;
  systemPrompt: string;
  contextKeys?: string[];
  version: string;
  tags?: string[];
  /** 已经装过（公共的同 id 或我的私有副本）—— 装了就不显示「安装」按钮 */
  installed: boolean;
  /** 目录声明的归属智能体在清单里是否存在；false 时界面要提示「装了也看不见」 */
  ownerKnown: boolean;
}

/**
 * 技能市场：浏览公共技能源（当前是内置目录，见后端 services/skill-catalog.ts）。
 * 从市场装进来的技能是**当前用户私有的**，不是公共的。
 */
export function fetchSkillMarket(): Promise<{
  entries: MarketEntry[];
  byCategory: { assistant: MarketEntry[]; agent: MarketEntry[] };
}> {
  return apiClient.get(`${BASE}/skill-market`);
}

export function fetchSkillLibrary(): Promise<{
  skills: LibrarySkill[];
  byCategory: { assistant: LibrarySkill[]; agent: LibrarySkill[] };
  orphans: OrphanOwner[];
}> {
  return apiClient.get(`${BASE}/skill-library`);
}

export interface InstallSkillInput {
  id: string;
  name: string;
  description?: string;
  color?: string;
  iconKey?: string;
  category: SkillCategory;
  ownerAgent?: string | null;
  systemPrompt?: string;
  contextKeys?: string[];
}

export function installSkillOnLibrary(input: InstallSkillInput): Promise<LibrarySkill> {
  return apiClient.post(`${BASE}/skill-library/install`, input);
}

export function removeSkillFromLibrary(id: string): Promise<{ id: string; removed: boolean }> {
  return apiClient.delete(`${BASE}/skill-library/${encodeURIComponent(id)}`);
}

export function fetchSkillTargets(): Promise<{ targets: SkillTargetView[] }> {
  return apiClient.get(`${BASE}/skill-targets`);
}

export function fetchTargetSkills(agentId: string): Promise<TargetSkillsView> {
  return apiClient.get(`${BASE}/skill-targets/${encodeURIComponent(agentId)}`);
}

export function toggleAgentSkill(
  agentId: string, skillId: string, enabled: boolean,
): Promise<{ agentId: string; skillId: string; enabled: boolean }> {
  return apiClient.put(`${BASE}/skill-targets/${encodeURIComponent(agentId)}/toggle`, { skillId, enabled });
}

export function toggleAllAgentSkills(
  agentId: string, enabled: boolean,
): Promise<{ agentId: string; enabled: boolean; count: number }> {
  return apiClient.put(`${BASE}/skill-targets/${encodeURIComponent(agentId)}/toggle-all`, { enabled });
}
