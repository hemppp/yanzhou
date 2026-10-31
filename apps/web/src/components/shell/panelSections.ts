// ============================================================
// panelSections.ts — 活动栏（`shell-rail`）的分区**词汇表**
//
// ## 为什么需要这个文件
//   活动栏此前是 16 个图标等距排一列：没有分组、没有文字，只能靠悬停 tooltip
//   逐个认。作者口径是「不知道哪个是哪个」。改造后按 `FloatingPanelDef.section`
//   把图标分进若干**带小标题的区段**（写作 / 资料 / 工具），一眼能看出
//   「这一组是查资料的」。
//
// ## 职责边界（重要）
//   本文件**只定义词汇与顺序**：分区叫什么、按什么次序出现、未声明时归哪一组。
//   它**不含任何「某面板属于某组」的映射** —— 那是面板**拥有者**的事
//   （手写台在 `panels.tsx` 里声明，auto 在 `auto/workbench/web/index.tsx` 里声明），
//   宿主（DockShell）只按字段渲染，不认识任何业务 key。
//   这样 DockShell.smoke.test 的「活动栏条目由外部 panels 派生（不硬编码业务面板）」
//   契约保持不变，第三方插件也不会因为不在下面的顺序表里被丢掉 ——
//   未知分区名一律**按首次出现顺序追加**在末尾，不会静默消失。
// ============================================================

/**
 * 分区的**显示顺序**（已知分区）。
 *
 * 为什么是这个次序：「写作」是主线（正文 / AI 协同），
 * 「资料」是写作时要反复翻查的东西（角色、地点、伏笔、设定…），
 * 「工具」是低频的产出与检视（统计、图谱、导出）。
 * 越靠上越常用 —— 竖栏是纵向的，靠上的区段点击成本更低。
 */
export const RAIL_SECTION_ORDER = ['写作', '资料', '工具'] as const;

/**
 * 未声明 `section` 的面板归入的分区。
 *
 * 取中性词「其它」而不是硬塞进「工具」：第三方插件没声明分组时，
 * 说「它属于工具」是**编造事实**；说「其它」才是如实的兜底。
 */
export const DEFAULT_RAIL_SECTION = '其它';

/**
 * 按分区把条目分组，保持**组内原始顺序**（不排序 —— 顺序真源仍是面板注册顺序）。
 *
 * 返回的数组按「已知分区顺序 → 未知分区首次出现顺序」排列；
 * 空分组不产出（没有面板的区段不占竖向空间，避免竖栏里出现孤立标题）。
 */
export function groupByRailSection<T extends { section?: string }>(
  items: readonly T[],
): { section: string; items: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const name = it.section ?? DEFAULT_RAIL_SECTION;
    const bucket = buckets.get(name);
    if (bucket) bucket.push(it);
    else buckets.set(name, [it]);
  }

  const known = RAIL_SECTION_ORDER.filter((s) => buckets.has(s)) as string[];
  const unknown = [...buckets.keys()].filter(
    (s) => !(RAIL_SECTION_ORDER as readonly string[]).includes(s),
  );

  return [...known, ...unknown].map((section) => ({
    section,
    items: buckets.get(section) as T[],
  }));
}
