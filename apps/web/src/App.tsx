import React, { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { CommandPalette } from './components/ui/CommandPalette';
import { ToastProvider } from './components/ui/ToastProvider';
import { PATHS } from './routes/paths';
import { lazyRoute } from './routes/Lazy';
import { NotFoundPage } from './routes/NotFoundPage';
import { ScrollToTop } from './routes/ScrollToTop';
import PageFade from './routes/PageFade';
import { usePluginRegistry, useProjectMode, filterByProjectMode } from './plugin/registry';
import type { PluginRouteDef } from './plugin/types';
// ★ 2026-10-07「跳转加载转圈」全修复（④）：路由 chunk 的 loader 与预取表提为共享模块
//   `routes/prefetch.ts`（单一真源）—— 书架条目 hover/pointerdown 的「意图预取」与
//   本文件的空闲预取必须共用同一批 loader，否则两处各写一遍必然漂移。
import {
  loadProjectLayout,
  loadProjectIndex,
  loadChapterEditor,
  loadBookshelf,
  loadSettings,
  loadLanding,
  PRELOAD_ON_PATH,
  ALL_ROUTE_LOADERS,
} from './routes/prefetch';

// ★ 2026-10-27 UI 改造对照页：**仅开发环境**注册（生产构建里这条 lazy 不会被构造，
//   也不会进包）。它只做"看长相"，不接 store、不调 API —— 见该文件头注。
const UiPreviewPage = import.meta.env.DEV
  ? React.lazy(() => import('./dev/UiPreviewPage').then((m) => ({ default: m.UiPreviewPage })))
  : null;

const ProjectLayout = lazyRoute(loadProjectLayout);
const ProjectIndexPage = lazyRoute(loadProjectIndex);
// ★ D44：manual 模块缺席 ⇒ loadChapterEditor 为 null ⇒ 不构造 lazy 路由（不伪造兜底）
const ChapterEditor = loadChapterEditor ? lazyRoute(loadChapterEditor) : null;
const BookshelfPage = lazyRoute(loadBookshelf);
const SettingsPage = lazyRoute(loadSettings);
const LandingPage = lazyRoute(loadLanding);

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/** Cmd/Ctrl + K 打开命令面板的全局快捷键 */
const CommandPaletteHotkey: React.FC = () => {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      setOpen(o => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!open) return null;
  return <CommandPalette isOpen={open} onClose={() => setOpen(false)} onNavigate={navigate} />;
};

/**
 * 路由容器。
 *
 * ★ 2026-10-06 全修复（原「每次跳转都要加载一下」）：
 *   原先这里是 `<AnimatePresence mode="wait"><Routes location={location} key={routeKey}>`。
 *   - AnimatePresence mode="wait" 让旧页 exit 跑完才挂载新页 ⇒ 每次跨段跳转串行硬等 140ms；
 *     已移除（入场淡入改由 PageFade 自己按路由段 key 重放，见 routes/PageFade.tsx）。
 *   - `<Routes>` 上的 `key={routeKey}` 会让整棵路由树重挂载。它**不是**数据重拉的根因
 *     （react-router 本来就只挂载命中的那一个元素，换段必然卸载旧元素、挂载新元素），
 *     真正让每次跳转都出加载态的是「没有数据缓存」与「每个页面是独立 chunk」。
 *     这里仍然去掉它：路由配置树不再无谓重建，key 的职责收敛到 PageFade 一处。
 */
const AppRoutes: React.FC = () => {
  const location = useLocation();
  const routeKey = useMemo(() => {
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return seg ? `/${seg}` : '/';
  }, [location.pathname]);

  // ★ 插件化：订阅插件注册的路由，追加到路由表（按当前项目创作模式过滤）
  const projectMode = useProjectMode();
  const pluginRoutes = filterByProjectMode(usePluginRegistry(s => s.routes), projectMode);

  // ★ 空闲预取下一步最可能进入的路由 chunk（表见 PRELOAD_ON_PATH）。
  //   放在 requestIdleCallback 里，不抢首屏；预取失败一律静默，绝不能影响正常流程。
  useEffect(() => {
    const loaders = PRELOAD_ON_PATH[routeKey];
    if (!loaders || loaders.length === 0) return;
    const run = () => { loaders.forEach(l => { void l().catch(() => {}); }); };
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(run, { timeout: 1000 });
      return () => { w.cancelIdleCallback?.(id); };
    }
    const t = window.setTimeout(run, 700);
    return () => window.clearTimeout(t);
  }, [routeKey]);

  // ★ 全站 chunk 预热：首屏稳定后**并行一次发出**，绝不抢首屏。
  //   2026-10-07 修：原实现是「一个个排队等空闲时间片」（`queue.shift()` +
  //   每次重新 requestIdleCallback，每个最多等 2.5s 空闲），9 个 loader 里排在
  //   尾巴上的要十几秒后才轮到 —— 那段时间里跳转照样出「加载中」，等于没预热。
  //   现在在同一个空闲回调里把全部 import() 一起发出去：浏览器自己复用连接、
  //   自己排优先级，实际是并行下载；而 requestIdleCallback 仍保证不抢首屏。
  //   同一个 import() 只会真正执行一次（模块表缓存），重复预热是廉价 no-op；
  //   任何失败都静默 —— 预热坏掉绝不能影响正常导航。
  useEffect(() => {
    const w = window as IdleWindow;
    let cancelled = false;
    let idleId: number | undefined;
    let timer: number | undefined;
    const run = () => {
      if (cancelled) return;
      for (const load of ALL_ROUTE_LOADERS) void load().catch(() => {});
    };
    if (typeof w.requestIdleCallback === 'function') {
      idleId = w.requestIdleCallback(run, { timeout: 1200 });
    } else {
      timer = window.setTimeout(run, 300);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // 本地版没有登录/管理员：插件路由的 guard 不再拦截，一律直接渲染。
  const renderPluginRoute = (def: PluginRouteDef) => {
    const Comp = def.Component;
    if (def.inProject) {
      return (
        <Route key={def.path} path={def.path} element={<PageFade><ProjectLayout /></PageFade>}>
          <Route index element={<Comp />} />
        </Route>
      );
    }
    return <Route key={def.path} path={def.path} element={<PageFade><Comp /></PageFade>} />;
  };

  return (
    <Routes location={location}>
      <Route path={PATHS.root} element={<PageFade><LandingPage /></PageFade>} />
      <Route path={PATHS.bookshelf} element={<PageFade><BookshelfPage /></PageFade>} />
      <Route path={PATHS.project} element={<PageFade><ProjectLayout /></PageFade>}>
        <Route index element={<ProjectIndexPage />} />
        {/* ★ 带 bookId 的 index 路由（2026-09-15 加）——
            没有它时 `/project/<id>` 单段会落到 path='*' 变 404（2026-09-13 GUI 走查踩过），
            所以那时书架只能**不带 id** 跳 /project，代价是项目身份只活在内存 store 里、
            一刷新就丢（表现为「刷新后内容塌成空态」）。
            加上这条后带 id 的项目页有了自己的 URL，刷新由 ProjectLayout 的
            URL→store 恢复逻辑救回，**URL 成为项目身份的单点真相**。 */}
        <Route path=':bookId' element={<ProjectIndexPage />} />
        {/* ★ D44：manual 模块缺席 ⇒ ChapterEditor 未构造 ⇒ 该路由不注册，
            落到下方 path='*' 的 404（**不**伪造空组件兜底）。 */}
        {ChapterEditor && <Route path=':bookId/:chapterId' element={<ChapterEditor />} />}
      </Route>
      <Route path={PATHS.settings} element={<PageFade><SettingsPage /></PageFade>} />
      {/* ★ UI 改造对照页（仅 dev）：不读任何业务数据 */}
      {UiPreviewPage && <Route path='/dev/ui-preview' element={<React.Suspense fallback={null}><UiPreviewPage /></React.Suspense>} />}
      {/* 插件注册的路由 */}
      {pluginRoutes.map(renderPluginRoute)}
      <Route path='*' element={<PageFade><NotFoundPage /></PageFade>} />
    </Routes>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ScrollToTop />
        <ToastProvider>
          <div className='relative min-h-screen'>
            <AppRoutes />
          </div>
          <CommandPaletteHotkey />
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
};

export default App;
