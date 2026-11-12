// ============================================================
// 单章闭环的阶段契约（StageKey / StageState / STAGES）
//
// ★ 2026-11-03 清理：本文件原先是**列表版「本章计划」卡组件**（WorkbenchPlan）。
//   作者要求工作台全面图谱化后，卡片的唯一使用者 WorldStateBoard 已死，
//   组件随之删除。**只留下阶段契约** —— 它是被复用的部分，不是残留：
//     · ChapterPlanGraphPanel（图谱版，现役）
//     · AutoWriteWorkbench（拿 StageKey/StageState 记状态）
//
//   阶段名与顺序是**契约**：图谱版与任何未来视图都从这里取，各写一份必然漂移。
// ============================================================

export type StageKey = 'discuss' | 'write' | 'review' | 'check' | 'polish' | 'deliver';
export type StageState = 'idle' | 'running' | 'done' | 'blocked';

/**
 * 单章闭环的六个阶段。
 * ★ 导出给 ChapterPlanGraphPanel 复用 —— 阶段名与顺序是**契约**，
 *   图谱版与列表版各写一份必然漂移（改一处漏一处是这类 UI 最典型的 bug）。
 */
export const STAGES: ReadonlyArray<{ key: StageKey; label: string; hint: string }> = [
  { key: 'discuss', label: '讨论', hint: '设计智能体来回讨论并收敛出本章结论' },
  { key: 'write', label: '写作', hint: '写作官据结论出稿（目标 3000 字，不足 2500 会先补写）' },
  { key: 'review', label: '意图门', hint: '对照本章结论查有无落实；打回上限 2 次' },
  { key: 'check', label: '校对门', hint: '全文对照设定库查冲突；给一次定向修订后不拦交付' },
  { key: 'polish', label: '润色门', hint: '质量评分（软门，只评分不拦交付）' },
  { key: 'deliver', label: '交付', hint: '写入章节；该章已有正文时按治理原则不自动覆盖' },
];
