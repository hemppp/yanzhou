/**
 * 路由路径集中管理 — 防止魔法字符串散落各处
 * 顶层路由写在 PATHS.*. 顶层；子路由用 PARENT/CHILD 形式组合
 */

export const PATHS = {
  root: '/',
  bookshelf: '/bookshelf',
  settings: '/settings',
  project: '/project',
} as const;

export const PROJECT_ROUTES = {
  root: '',
  characters: 'characters',
  locations: 'locations',
  timeline: 'timeline',
  snapshots: 'snapshots',
  series: 'series',
  stats: 'stats',
  relationGraph: 'relation-graph',
  heatmap: 'heatmap',
} as const;

export type ProjectRoute = (typeof PROJECT_ROUTES)[keyof typeof PROJECT_ROUTES];

export const isProjectRoute = (path: string): boolean =>
  path === PATHS.project || path.startsWith(`${PATHS.project}/`);
