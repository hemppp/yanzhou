// ============================================================
// @novel-plugins/auto-workbench/stores —— AI 写作台专属 store
//
// 由 `apps/web/src/stores/*` 切分而来（D1/D33）：
//   · aiStore / chatHistoryStore / aiRedstoneStore / workspaceStore → 本模块
//   · 实体 / 领域 store → @novel-plugins/data-core/stores（共享）
//
// 旧路径 `apps/web/src/stores/<name>.ts` 留 1 行 shim（D34），保证 kernel 与
// manual 的既有引用构建绿；新代码请直接从本包引入。
// ============================================================

export { useAIStore } from './aiStore';
export { useChatHistoryStore } from './chatHistoryStore';
export { useAIRedstoneStore } from './aiRedstoneStore';
export { useWorkspaceStore } from './workspaceStore';