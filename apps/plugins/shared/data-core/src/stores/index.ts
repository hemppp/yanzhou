// ============================================================
// @novel-plugins/data-core/stores — 共享 store 层
//
// 由 `apps/web/src/stores/index.ts`（864 行）切分而来：
//   · 实体 / 领域 store（project/chapter/character/item/…/stats/cascade）→ 此处
//   · manual 专属 store（useQuickPhraseStore / useUIStore）留在 manual 模块
//
// ⚠️ 实体 store 全仓唯一实例：定义只在本包，`apps/web/src/stores/index.ts`
//    仅再导出，绝不重复定义（否则 useProjectStore 出现两个实例，语义 bug）。
// ============================================================

export {
  getForeshadowThreshold,
  useProjectStore,
  useChapterStore,
  useCharacterStore,
  useItemStore,
  useCreditStore,
  useLocationStore,
  useEventStore,
  useForeshadowStore,
  useEarmarkStore,
  useAnnotationStore,
  useOutlineStore,
  useTimelineStore,
  useNoteStore,
} from './entityStores';

export { useStatsStore } from './statsStore';

export { cascadeCleanChapterClient } from './cascadeClean';

export { cascadeCleanFlag } from './cascadeCleanFlag';
export { useEditorStore } from './editorStore';
export { useOutlineNotepadStore } from './outlineNotepadStore';
export type { NotepadSection, OutlineNotepadData } from './outlineNotepadStore';
export { useReferenceStore, splitChapters } from './referenceStore';
