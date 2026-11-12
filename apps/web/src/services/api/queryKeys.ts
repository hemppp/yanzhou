/**
 * 全站查询键的单一出处。
 *
 * ★ 为什么集中定义：queryClient 用「字符串数组序列化」做缓存键，键是缓存命中的**唯一凭据**
 *   —— 各处手写字面量，只要一个字符漂移（`['projects','list']` vs `['projects', 'list']`
 *   其实还好，但 `['projects']` vs `['project']` 就是永不命中），页面就退回「每次跳转都重新拉」。
 *   集中定义 + 前缀失效语义，让「在哪失效、在哪命中」一眼可查。
 *
 * ★ 前缀语义：`invalidateQuery(['projects'])` 会命中 `["projects"` 开头的所有键，
 *   即 projects / projects/detail/:id 一起失效 —— 项目增删改后这就是想要的效果。
 */
export const queryKeys = {
  /** 书架列表（GET /projects） */
  projects: ['projects', 'list'] as string[],
  /** 单个项目详情（GET /projects/:id，ProjectLayout 用 URL 里的 bookId 恢复项目） */
  project: (bookId: string) => ['projects', 'detail', bookId] as string[],
  /** 章节计数，按项目 id 列表整体缓存（调用方需保证 id 列表顺序稳定） */
  chapterCounts: (projectIdsKey: string) => ['chapter-counts', projectIdsKey] as string[],
  /** 管理后台总览：用户列表 + 统计（一起取，一起缓存） */
  /** 管理后台的插件列表 */
  adminPlugins: ['admin', 'plugins'] as string[],
};
