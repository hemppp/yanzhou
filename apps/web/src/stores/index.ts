// ============================================================
// 砚舟 - 全局状态管理（kernel 兼容壳）
//
// 实体 / 领域 store 定义在 @novel-plugins/data-core/stores（全仓唯一实例）。
// 手写台专属 store（useUIStore / useQuickPhraseStore）已随 t4 迁入
//   @novel-plugins/manual-workbench/stores —— 本壳不再提供它们。
//
// 保留本壳仅为兼容 kernel 内既有 `@/stores` 引用；新代码请直接
// 从 `@novel-plugins/data-core/stores` 引入。
// ============================================================

export * from '@novel-plugins/data-core/stores';
