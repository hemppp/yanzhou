// ============================================================
// @novel-plugins/data-core — 共享数据层与服务
//
// kernel / manual / auto 三侧共用：带鉴权 API 客户端（含 resolveApiUrl）、
// 数据库服务、本地缓存、同步中间件、实体检测/文风/节奏服务、共享 store。
// 归属见设计 §2.3 / §3.3 / §3.4（F7/D10/D11）。
//
// 子路径入口：`@novel-plugins/data-core/stores`（共享 store 层）。
// ============================================================

// ---- API 客户端（base 唯一来源）----
export {
  apiClient,
  buildUrl,
  resolveApiUrl,
  ApiError,
  getToken,
  setToken,
  clearToken,
  registerProjectIdGetter,
  getCurrentProjectId,
} from './api/apiClient';
export type { ApiClient, ApiClientConfig, RequestOptions } from './api/apiClient';

export { authApi, adminApi } from './api/authApi';
export type { LoginRequest, RegisterRequest, AuthResponse, AdminUser, AdminStats } from './api/authApi';

// ---- 数据服务 ----
export * from './data/databaseService';
export {
  cacheChapterContent,
  getCachedChapterContent,
  clearCachedChapterContent,
} from './data/chapterLocalCache';
export type { CachedChapter } from './data/chapterLocalCache';
// AI 对话记录本地持久化（按「项目 + 章节」分开存；刷新不丢）
export { loadChatHistory, saveChatHistory, clearChatHistory } from './data/chatHistoryCache';
export { clearProjectLocalData, clearAllLocalUserData, registerLocalDataCleaner } from './data/localUserData';
export { useSyncService } from './data/syncService';

// ---- AI 对话技能注册表（D46 下沉：auto 模块与 novel.autowrite 共用；图标由 kernel 推入）----
export {
  useSkillRegistry,
  registerSkillIcons,
  getSkillMeta,
  resolveSkillIcon,
  getSkillHistorySuffix,
  useSkillsForMode,
  useSkillBarProps,
} from './skills/skillRegistry';
export type { SkillMeta, SkillContextKey } from './skills/skillRegistry';

// ---- 编辑器辅助服务 ----
export { htmlToText, isPlainText, plainTextToHtml, ensureHtmlContent } from './editor/entityDetector';
export {
  styleService,
  sentenceLengthLabels,
  perspectiveLabels,
  dialogueLabels,
  paragraphLabels,
} from './editor/styleService';
export type { StyleProfile, StyleAnalysisResult } from './editor/styleService';
export { rhythmService, summarizeRhythm } from './editor/rhythmService';
export type { RhythmMark, RhythmAnalysisResult } from './editor/rhythmService';

// ---- 共享 store ----
export * from './stores';
