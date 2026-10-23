// ============================================================
// AI 对话技能注册表 —— **已下沉 shared（D46）**
//
// 实现迁至 `@novel-plugins/data-core`（src/skills/skillRegistry.ts），
// 使 auto 模块与 novel.autowrite 共用**同一实例**，且 shared 不反向依赖 kernel。
// 本文件仅作转发，保持模块内既有 `./skillsConfig` / `../skills/skillsConfig` 引用不变。
//
// ★ 新代码请直接 import '@novel-plugins/data-core'。
// ============================================================

export {
  useSkillRegistry,
  registerSkillIcons,
  getSkillMeta,
  resolveSkillIcon,
  getSkillHistorySuffix,
  useSkillsForMode,
  useSkillBarProps,
} from '@novel-plugins/data-core';
export type { SkillMeta, SkillContextKey } from '@novel-plugins/data-core';
