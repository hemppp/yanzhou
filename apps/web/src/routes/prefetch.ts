/**
 * 路由 chunk 加载器与预取表 —— **单一真源**（kernel 侧）。
 *
 * ★ 2026-10-07「跳转加载转圈」全修复（④）：
 *   这些 loader 原先只活在 `App.tsx` 模块作用域里，于是「提前预取」只能从
 *   `App.tsx` 内部发起（`PRELOAD_ON_PATH` 的空闲回调）。用户从书架点开一本书时，
 *   点击**先于**空闲回调 ⇒ 预取输给点击的竞态，链路照样现下载。
 *   提到本模块后，书架条目可在 `mouseenter` / `pointerdown`（**用户意图出现、
 *   但点击尚未发生**）就调用 `prefetchProjectEntry()`，把四段串行里的前三段
 *   提前发出去；`App.tsx` 的空闲预取继续复用同一批 loader（同一个 import()
 *   说明符 ⇒ 命中同一份模块缓存，重复预取是廉价 no-op）。
 *
 * 放在 `routes/` 下：与 `Lazy.tsx` / `paths.ts` 同属 kernel 域，无跨域边。
 */

import type { ComponentType } from 'react';
import { loadModuleComponent, loadModulePreload } from '../plugin/moduleEntries';
import { PATHS } from './paths';

// 路由：每个 lazy 路由走统一 fallback。
// ★ loader 提为常量，供「空闲预取」与「意图预取」复用 —— 同一个 import() 结果被
//   浏览器/打包器缓存，预取过再导航即为命中缓存，省掉整段 chunk 下载 + 解析时间。
export const loadProjectLayout = () => import('../components/shell/ProjectLayout').then(m => ({ default: m.ProjectLayout }));
export const loadProjectIndex = () => import('../pages/ProjectIndexPage').then(m => ({ default: m.ProjectIndexPage }));
// ★ D35 + D44：章节编辑器经 **manual 模块公开入口** 惰性引用，kernel 不再静态
//   import `@/components/editor/ChapterEditor`（K2M 边）。
//   D44：说明符改由 **构建期 glob** 解析（`plugin/moduleEntries.ts`）——
//   原写法 `import('@novel-plugins/manual-workbench/web')` 是 vite 静态可解析的
//   模块入口字面量，manual 缺席时 `[vite:load-fallback] ENOENT` 使 build 硬失败。
//   模块缺席 ⇒ loader 为 null ⇒ 该路由不注册（保留 404，不伪造兜底实现）。
export const loadChapterEditor = loadModuleComponent<ComponentType<any>>('manual', 'ChapterEditor');
export const loadBookshelf = () => import('../pages/BookshelfPage').then(m => ({ default: m.BookshelfPage }));
export const loadSettings = () => import('../pages/SettingsPage').then(m => ({ default: m.SettingsPage }));
export const loadLanding = () => import('../pages/LandingPage').then(m => ({ default: m.LandingPage }));

/**
 * ★ 2026-10-07「跳转画面会加载一下」修复 —— 模块自持的**面板级**预取。
 *
 * 路由级 loader（上面那批）只覆盖「页面」这一层 chunk。进项目之后才出现的那批
 * chunk 全在模块内部（12 个手写台停靠面板、章节左栏、AI 对话面板），kernel 看不到
 * 它们的 import 说明符 —— 这正是「进项目先出一排『加载中…』，点开面板再出一次」的来源。
 *
 * 预取**内容**因此由模块入口导出的 `preload()` 自己决定，kernel 只经 `import.meta.glob`
 * 解析出的模块入口调用它（D35：kernel 不碰插件内部实现，不新增任何静态 import）。
 * 模块缺席（或没导出 preload）⇒ loader 为 null ⇒ 该条目不参与，不产生悬空 loader。
 */
const loadManualPreload = loadModulePreload('manual');
const loadAutoPreload = loadModulePreload('auto');
export const MODULE_PRELOAD_LOADERS: Array<() => Promise<unknown>> = [
  ...(loadManualPreload ? [loadManualPreload] : []),
  ...(loadAutoPreload ? [loadAutoPreload] : []),
];

/**
 * 跳转链路预取表：停在某段路由时，空闲预取「下一步最可能进入」的 chunk，
 * 把「点击之后才开始下载」变成「点击即命中缓存」。
 *
 * /bookshelf → 进项目其实是四段**串行**：ProjectLayout chunk → ProjectIndexPage chunk
 *   → 等章节数据到位 → ProjectIndexPage 自动 redirect → ChapterEditor chunk（编辑器依赖链最重）。
 *   前三块 chunk 一次性预热掉，链路里就只剩数据请求的真实耗时。
 * /project   → 章节编辑器（同上，兜住直接落在 /project 的情况）
 *
 * ★ D44：manual 缺席时 ChapterEditor 不存在，预取表相应剔除（不产生悬空 loader）。
 */
export const PRELOAD_ON_PATH: Record<string, Array<() => Promise<unknown>>> = {
  [PATHS.bookshelf]: [
    loadProjectLayout, loadProjectIndex, ...(loadChapterEditor ? [loadChapterEditor] : []),
    // ★ 2026-10-07：再补上**面板级**预取。进项目后立刻要渲染的就是左栏章节树 +
    //   右栏 AI 对话 + 用户可能点开的 12 个停靠面板，它们全在模块内部，
    //   路由级 loader 一个都覆盖不到。在书架页（唯一入口）就把它们发出去，
    //   等真正进项目时面板已是同步命中，不再出现「一排加载中…」。
    ...MODULE_PRELOAD_LOADERS,
  ],
  [PATHS.project]: [
    ...(loadChapterEditor ? [loadChapterEditor] : []),
    ...MODULE_PRELOAD_LOADERS,
  ],
};

/**
 * 全站页面 chunk 清单（★ 2026-10-06「跳转都要加载」全修复）。
 *
 * 每个页面都是独立 chunk，**首次**进入任何一个页面都会走 React.lazy 的
 * Suspense fallback（那个「加载中...」转圈）—— 这才是「每次跳转都加载一下」里
 * 「加载」两个字最直观的来源。首屏稳定后**一次性并行**预热，之后跳转
 * 全部命中模块缓存，页面上只剩数据请求的真实耗时。
 *
 * 顺序 = 访问概率 × 体积：ProjectLayout 单块 448KB、且是「进项目」链路第一段，
 * 所以排第一；编辑器依赖链最重，紧随其后。
 * （顺序自 2026-10-07 起只影响「发起先后」，不再决定「谁被拖到最后」——
 *   全站预热已从串行空闲队列改为并行一次发出。）
 */
export const ALL_ROUTE_LOADERS: Array<() => Promise<unknown>> = [
  loadProjectLayout,
  loadProjectIndex,
  ...(loadChapterEditor ? [loadChapterEditor] : []),
  loadBookshelf,
  loadSettings,
  loadLanding,
];

/**
 * ★ 2026-10-07「跳转加载转圈」全修复（④）：**意图预取** —— 用户悬停/按下书架条目
 * 时立刻发出「进项目」链路的全部 chunk，不等空闲回调、不等点击。
 *
 * 用书架那条表（ProjectLayout + ProjectIndexPage + ChapterEditor + 模块面板预取）
 * —— 它正是「从书架进项目」的完整四段串行链。与空闲预取共用同一批 loader
 * ⇒ 同一个 import() 说明符 ⇒ 命中同一份模块缓存，重复调用是廉价 no-op。
 * 任何失败一律静默：预取绝不能影响正常导航。
 */
export function prefetchProjectEntry(): void {
  for (const load of PRELOAD_ON_PATH[PATHS.bookshelf] ?? []) {
    void load().catch(() => {});
  }
}
