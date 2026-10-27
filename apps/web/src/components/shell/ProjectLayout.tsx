// ============================================================
// ProjectLayout.tsx —— 项目壳（P3 · t4：气泡浮窗 → dockview 停靠系统）
//
// 契约真源：docs/architecture/dock-protocol-adr.md
//   §1.1–1.3  既有 11 字段全部保留；`scope` 语义收窄；`rail` 不再由宿主读取
//   §1.6      三类内容落位；中心槽默认占用者 = 章节编辑器路由出口
//   §2.3.2    'nm:open-panel' 迁移（监听体改调 getPanelNavigation().open）
//   §2.3.3    'nm:open-settings' 保留（navigate(PATHS.settings)）
//   §3.4      候选池合成 = 内置面板槽 ∪ 插件面板槽，按 key 去重
//   §4.3      MAX_OPEN_PANELS 退役（已在 stores/panelOpenStore.ts 落地）
//   §4.4      该退役被**修订取代**（2026-10-07 用户口径）：`MAX_OPEN_PANELS = 3`
//             回归，超限按**最近使用（LRU）**收起最久没用过的那个并抛
//             `novelmuse:toast-notify` 可见提示（不是静默挤掉）
//
// ## 活动栏按钮 = 面板开/关开关（2026-10-07 用户口径）
//   项目壳把 `openKeys` / `onOpenChange` 受控交给 `DockShell`：`openKeys` = 已打开
//   面板集合（`usePanelOpenStore`），`onOpenChange` 回写 `_syncFromView`。
//   因此活动栏图标点击必须走 `closePanel`（而非只 `setActive`），否则按钮只能
//   聚焦、收不起来；`[aria-pressed]` 反映「是否已打开」，`.is-active` 反映
//   「是否当前聚焦」—— 两个独立视觉维度。
//
// ## 本次净变化（对照 ADR §0.1「现状」表）
//   ❌ 删除：`useFloatingPanel` / `FloatingPanelWindow` / `ResizeFrame`
//            （自研绝对定位浮窗引擎 + 八向缩放，共 ~350 行死代码）
//   ❌ 删除：`FloatingBubbles`「功能转轮」（罗盘 + 卫星气泡入口）
//   ❌ 删除：`PanelFallback`（转圈加载壳，浮窗引擎专用）
//   ✅ 新增：`DockShell`（t3 交付的停靠内核）承载全部面板
//   ✅ 新增：`PanelMenu`（顶栏下拉菜单）= 活动栏 / 侧边栏之外的第三入口
//   ✅ 新增：顶栏 + 状态栏的 VS Code Dark Modern 视觉（project-shell.css）
//
// ## 保留不变的既有语义（t9 验收逐条对照）
//   1. `filterByProjectMode` 模式过滤      —— 见下方 §3.4 合池后的过滤
//   2. auto 模式工作台分支 + WorkbenchMissing 降级 —— 见 `mode === 'auto'` 分支
//   3. PanelGuard 错误隔离                 —— 已按 §3.4-3 搬进 DockShell
//                                             （dock/DockPanelContent.tsx 的
//                                             PanelErrorBoundary），不得留在
//                                             已删的浮窗引擎里
//   4. chapters / ai-chat 按 key 取用      —— 降级为**普通面板**（§3.2 决策 3-A），
//                                             由统一候选池承载，无特殊分支
//
// ## 中心槽语义（§1.6）
//   `<Outlet/>`（章节编辑器路由出口）是**中心槽的默认占用者**，
//   经 `DockShellProps.centerDefault` 注入；被声明 `dock:{center:true}`
//   的面板抢占时替换（由 DockShell 内部处理）。
// ============================================================

import React, { useEffect, useMemo, useCallback, useState, Suspense } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import {
  Settings,
  LogOut,
  User,
  Shield,
  AlertTriangle,
  ArrowLeft,
  Moon,
  Sun,
} from 'lucide-react';
import { useProjectStore, useChapterStore } from '@/stores';
import { useReferenceStore } from '@/stores/referenceStore';
import { useAuthStore } from '@/stores/authStore';
import { PATHS } from '@/routes/paths';
import { apiClient } from '@/services/api/apiClient';
import { useCachedQuery } from '@/hooks/useCachedQuery';
import { queryKeys } from '@/services/api/queryKeys';
import { useSyncService } from '@/services/data/syncService';
import type { Project } from '@novel/shared';
import { WorkbenchMissing } from '@/components/shell/WorkbenchMissing';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { DockShell } from '@/components/shell/DockShell';
// ★ 2026-10-07「跳转加载转圈」全修复：面板级加载态提为共享组件（原先只在本文件里，
//   仅服务 auto 工作台一处；停靠内核 DockPanelContent 也需要同一种 fallback）。
import { PanelFallback } from '@/components/shell/PanelFallback';
import type { DockPanelDef, DockShellApi } from '@/components/shell/dock/types';
import { PanelMenu } from '@/components/shell/PanelMenu';
import { usePluginRegistry, useProjectMode, filterByProjectMode, entryAppliesToProjectMode } from '@/plugin/registry';
import { getPanelNavigation, registerPanelViewOpener, registerPanelViewSync, registerPanelViewBase, usePanelOpenStore } from '@/stores/panelOpenStore';
// ★ t4（集成接线）新增：manual 模式首屏三栏种子（chapters / ai-chat）。
//   受控 openKeys 使 DockShell 的 `dock.defaultOpen` 失效（见 store 内注释），
//   缺省打开集合的真源只能是 store，故种子从此处驱动。
import { DEFAULT_OPEN_PANEL_KEYS, seedPanelOpenKeys } from '@/stores/panelOpenStore';
import type { FloatingPanelDef } from '@/plugin/types';
// ★ t1（外壳改造）新增：主题档位、文档标签栏、底部细条与状态栏的真实数据源
import { useThemeStore } from '@/stores/themeStore';
import { BottomIssueList, useIssueCount } from '@/components/shell/issues';
import { formatWordCount, useClock, useProjectWordCountSync, useSaveState } from '@/components/shell/statusBar';
import './project-shell.css';

// ★ 面板定义在 src/plugin/builtin.ts 注册（内置 12 面板 + 编辑器面板），
// 这里通过 usePluginRegistry 订阅；宿主**不再**负责渲染/拖拽/限流 ——
// 位置、尺寸、标签堆叠、悬浮全部由 DockShell（dockview）承担。

// ★ AI 写作模式的工作台：经 **注册表 `workbench` 槽**（auto 模块 `registerWorkbench` 填充）。
//   kernel 不再硬编码 `import('@novel-plugins/auto-workbench/web')` 说明符 ——
//   那是 vite 静态可解析的模块入口字面量，auto 缺席时 `[vite:load-fallback] ENOENT`
//   会让 build 硬失败。改由注册表取（模块缺席 ⇒ 槽为空 ⇒ 不渲染，降级语义）。

/**
 * 应用级致命错误兜底（根 ErrorBoundary 的 renderError）。
 * 面板级错误由 DockShell 内部的 PanelGuard 隔离，不会到这里。
 */
function ShellFatal({ error }: { error: Error }) {
  return (
    <div className="shell-fatal" role="alert">
      <AlertTriangle size={22} style={{ color: 'var(--vscode-semantic-warning)' }} />
      <div style={{ fontSize: 12 }}>应用发生错误，已停止渲染</div>
      <div
        style={{
          fontSize: 10,
          fontFamily: 'var(--vscode-font-family-mono)',
          wordBreak: 'break-all',
          maxWidth: 640,
          color: 'var(--vscode-semantic-error)',
        }}
      >
        {String(error?.message || error)}
      </div>
      <button
        type="button"
        className="nm-btn-apple-icon-sm"
        style={{ padding: 'var(--space-1) var(--space-5)', fontSize: 11 }}
        onClick={function () { window.location.reload(); }}
      >
        重新加载
      </button>
    </div>
  );
}

export function ProjectLayout() {
  var navigate = useNavigate();
  var params = useParams<{ bookId: string }>();
  var urlBookId = params.bookId;
  // ★「返回」策略（2026-09-12 重写）：统一为「退出项目、回书架」，**不再依赖历史栈**。
  //
  //   ⚠ 为什么不能用 navigate(-1)：
  //     `/project` 是**瞬态页** —— 只要有章节，ProjectIndexPage 就会用 replace 跳到章节编辑器，
  //     而 replace 会把 `/project` 这条历史记录**抹掉**。从书架进来时的历史栈实际是
  //     [书架, 章节页]，于是 navigate(-1) 会越过「上一层」直接弹回书架。
  //
  //   ⚠ 为什么不能用 navigate(PATHS.project)：
  //     ProjectIndexPage 挂载后立刻又把你 replace 回章节编辑器，表现为
  //     「点了返回没反应、还在原界面」。
  //
  //   固定回书架后行为稳定可预测：无章节项目的首页本身就在 /project，返回同样出到书架。
  var backTarget = PATHS.bookshelf;
  var backLabel = '返回书架';
  var handleBack = useCallback(function() {
    navigate(backTarget);
  }, [backTarget, navigate]);
  var project = useProjectStore(function(s) { return s.currentProject; });
  var setProject = useProjectStore(function(s) { return s.setProject; });
  var user = useAuthStore(function(s) { return s.user; });
  var logout = useAuthStore(function(s) { return s.logout; });

  // 打开状态来自 store（编辑器内的插件面板栏共享同一份，可开关面板）
  var openPanelKeys = usePanelOpenStore(function(s) { return s.keys; });
  // ★ 2026-10-11：「章节正文」基础标签也当动态标签（可关、计入总上限）——
  //   它的开/关真源是 store.baseOpen，透传给 DockShell 控制中心默认面板的显隐。
  var baseOpen = usePanelOpenStore(function(s) { return s.baseOpen; });
  var syncFromView = usePanelOpenStore(function(s) { return s._syncFromView; });
  var setActiveKey = usePanelOpenStore(function(s) { return s._setActive; });

  // ★ 插件化：面板列表来自插件注册表（内置 12 面板 + 插件新增面板）
  // ★ 按当前项目创作模式过滤：手写台只渲染 manual + shared 面板（auto 面板归 AI 工作台）
  var projectMode = useProjectMode();
  var allFloatingPanels = usePluginRegistry(function(s) { return s.projectPanels; });
  // ★ §3.3：扩展点已由 `builtinBubbles` 更名为 `builtinPanels`。读到的是
  //   `BuiltinPanelDef`（`FloatingPanelDef` 的真子集），**合池后类型天然成立**，
  //   不再需要 `as unknown as FloatingPanelDef` 双断言（§3.2）。
  var builtinPanels = usePluginRegistry(function(s) { return s.builtinPanels; });

  // ★ §3.4 候选池合成（冻结）：内置面板槽 ∪ 插件面板槽，按 key 去重（前者优先）。
  //   这一条同时修掉了实测缺陷：`'ai-chat'` 全仓 0 注册点 ⇒ 合池前 `chatBubbleDef`
  //   恒为 null、AI 对话面板**从不渲染**；合池后只要有模块注册 `'ai-chat'` 即自然生效。
  var candidatePanels = useMemo<FloatingPanelDef[]>(function() {
    var byKey = new Map<string, FloatingPanelDef>();
    for (var i = 0; i < builtinPanels.length; i++) {
      var b = builtinPanels[i];
      if (!b) continue;
      // BuiltinPanelDef 字段集 ⊂ FloatingPanelDef（§3.2），此处是**安全的**收窄
      byKey.set(b.key, {
        key: b.key,
        label: b.label ?? b.key,
        icon: b.icon ?? undefined,
        Component: b.Component,
        width: b.width,
        height: b.height,
        order: b.order,
        modes: b.modes,
        // ★ t4（集成接线）：把 `dock` 一起带过去 —— 原来这里只挑 8 个字段，
        //   `BuiltinPanelDef.dock` 被丢掉，导致 chapters 槽只能落 `slot` 缺省
        //   ('right')，左栏章节树无法出现在左停靠区（目标截图要求）。
        dock: b.dock,
      } as FloatingPanelDef);
    }
    for (var j = 0; j < allFloatingPanels.length; j++) {
      var p = allFloatingPanels[j];
      if (!p) continue;
      if (!byKey.has(p.key)) byKey.set(p.key, p);
    }
    return Array.from(byKey.values());
  }, [builtinPanels, allFloatingPanels]);

  // ★ 保留语义 1/4：`filterByProjectMode` 模式过滤 —— 函数名与行为均不变
  var floatingPanels = useMemo(function() {
    return filterByProjectMode(candidatePanels, projectMode);
  }, [candidatePanels, projectMode]);

  // ★ 单列布局：整池透传给 DockShell（不再做 scope 分流 / center 抢占判定）。
  //   分类真源仍在 DockShell 内部（经 `resolveDockMeta`），本壳不重复一套缺省。
  var allShellPanels = useMemo<DockPanelDef[]>(function() {
    return floatingPanels as DockPanelDef[];
  }, [floatingPanels]);

  // ★ 章节 / AI 对话面板：§3.2 决策 3-A —— 取消 ProjectLayout 的 key 硬编码查找，
  //   降级为**普通面板**，由上面的统一候选池承载，DockShell 对二者无特殊分支。
  //   「内置面板缺席 ⇒ 不渲染」的优雅降级语义因此天然成立。

  // ★ AI 工作台壳经**注册表 `workbench` 槽**取（auto 模块经 ctx.registerWorkbench 填充）。
  //   模块缺席 ⇒ 槽为空 ⇒ 不渲染该工作台（降级语义）。kernel 侧不再出现
  //   `@novel-plugins/auto-workbench/web` 这一模块入口说明符。
  var workbenchSlots = usePluginRegistry(function(s) { return s.workbenches; });
  var activeWorkbench = useMemo(function() {
    var def = workbenchSlots[projectMode] ?? workbenchSlots.shared;
    if (!def) return null;
    return entryAppliesToProjectMode(def, projectMode) ? def : null;
  }, [workbenchSlots, projectMode]);

  // ============================================================
  // ★ t4（集成接线）：manual 模式首屏三栏种子
  //   目标截图是「一打开就在位」：左 240px 章节树 + 中栏正文 + 右 340px AI 对话。
  //   DockShell 的 `dock.defaultOpen` 在受控 openKeys 下不生效
  //   （DockShell.tsx:291-295 + ProjectLayout.tsx:153，store 内有详细注释），
  //   所以默认打开集合只能由这里播进 store。
  //
  //   ★ 2026-10-11 持久化：本调用现在语义是「**恢复或播种**」——
  //     `seedPanelOpenKeys` 先读 localStorage 里用户上次的打开集合；有记录就原样恢复、
  //     **不再播默认种子**（于是关掉「章节 / AI 对话」后刷新不会自己回来，与其余面板
  //     行为一致）；无记录（首次使用）才播 `DEFAULT_OPEN_PANEL_KEYS.manual` 并落盘。
  //     仍幂等：同一会话只执行一次。
  // ============================================================
  useEffect(function() {
    if (projectMode !== 'manual') return;
    seedPanelOpenKeys(DEFAULT_OPEN_PANEL_KEYS.manual);
  }, [projectMode]);

  // ★ 刷新恢复：URL 带有 :bookId 但 store 已重置（currentProject 为 null 或 id 不匹配）时，
  // 从后端拉取项目元数据写回 store。这样刷新 /project/:bookId/:chapterId 不会丢失书籍。
  // ★ 走缓存查询：从别的书 / 别的页面切回来时，项目元数据**直接命中缓存**写回 store，
  //   不再等一次网络往返 —— 这是「进项目要加载一下」串行链上的第一环。后台仍会校验。
  var needsRestoreProject = Boolean(urlBookId) && (!project || project.id !== urlBookId);
  var { data: restoredProject, error: restoreError } = useCachedQuery<Project>(
    queryKeys.project(urlBookId || ''),
    function() { return apiClient.get<Project>('/projects/' + urlBookId); },
    { enabled: needsRestoreProject },
  );

  useEffect(function() {
    if (restoredProject) setProject(restoredProject);
  }, [restoredProject, setProject]);

  useEffect(function() {
    if (restoreError) {
      console.warn('[ProjectLayout] 从 URL bookId 恢复项目失败', restoreError);
    }
  }, [restoreError]);

  // ★ 优先用 URL 的 bookId 触发 syncService，避免 project 暂未恢复时 syncService 拿到 undefined
  //   取回 reload 下传给 AI 写作工作台：交付后实体已在服务端落库，
  //   需要这个实例（而**不能**在工作台里再挂一个 useSyncService —— 那会让每次 store
  //   变更被两个订阅各写一遍，实体重复创建）把项目数据重新拉进 store。
  var { reload: reloadProjectData } = useSyncService(urlBookId || project?.id);

  // ★ 加载参考书：当项目 ID 可用时从后端加载参考书列表
  // 参考书独立于 syncService 的实体同步，且 ReferenceReader 是惰性加载的停靠面板，
  // 刷新页面时面板未打开，ReferenceReader 不会挂载，loadBooks 也不会被调用。
  // 因此需要在 ProjectLayout 层面主动加载，确保参考书数据在项目加载时即可用。
  var referenceProjectId = urlBookId || project?.id;
  useEffect(function() {
    if (!referenceProjectId) return;
    useReferenceStore.getState().loadBooks(referenceProjectId);
  }, [referenceProjectId]);

  // ============================================================
  // ★ t1（外壳改造）：顶栏按钮组 / 文档标签栏 / 底部细条 / 状态栏的真实数据
  // ============================================================
  // 主题档位（亮 / 暗）：真源是 ui-kit 的 themeStore，`setMode` 同时写 <html> 的
  // color-scheme 与 localStorage ⇒「夜间」按钮与「刷新后保持」共用同一条路径。
  // ★ 2026-10-27：状态栏那个「<主题名> · 亮/暗」指示已按用户口径删除（顶栏已有「夜间」
  //   按钮，状态栏再放一份是重复信息）。随之删掉只服务于它的 `themeId` 选择器与
  //   `themeMeta` 派生 —— 顺着删干净，别留悬空依赖。
  var themeMode = useThemeStore(function(s) { return s.mode; });
  var setThemeMode = useThemeStore(function(s) { return s.setMode; });

  // 当前章节：面包屑标题 / 保存态 / 问题清单都取它。用 chapters + id 派生，
  // 避免把「每次调用可能返回新引用」的选择器交给 zustand 的相等性判断。
  var chapters = useChapterStore(function(s) { return s.chapters; });
  var currentChapterId = useChapterStore(function(s) { return s.currentChapterId; });
  var currentChapter = useMemo(function() {
    if (!currentChapterId) return null;
    return chapters.find(function(c) { return c.id === currentChapterId; }) ?? null;
  }, [chapters, currentChapterId]);

  // 状态栏：真实保存态（本地缓存 ↔ store 内容）+ 实时时钟；底部细条：真实问题条数
  var saveState = useSaveState(
    currentChapter
      ? {
          id: currentChapter.id,
          content: currentChapter.content,
          updatedAt: currentChapter.updatedAt,
        }
      : null,
  );
  var clock = useClock();
  var issueCount = useIssueCount();
  // ★ t4：状态栏「N 字」的刷新闭环（缺口与修法见 statusBar.ts 的 hook 注释）。
  //   只在 manual 生效 —— auto 分支不渲染状态栏（下方提前 return），没必要轮询。
  useProjectWordCountSync(projectMode === 'manual' ? (project?.id ?? null) : null);

  // 动作的可见反馈（截图无此位，放状态栏左组末尾，3s 自动消失）
  var [rewriteNotice, setRewriteNotice] = useState<string | null>(null);

  // ★ 用户口径（m04040）：顶栏的「手写 / AI 写作」按钮组已删除，随之下线的还有
  //   `switchProjectMode`（原走真实 `PUT /api/projects/:id { mode }`，是本文件唯一的
  //   mode 写入口）与它的 `modeNotice` 反馈位 —— 创作模式在开书时由书架页新建向导
  //   写入，「进入了 AI 写作就是 AI 写作，手写写作就手写写作」，写作途中不再切换。

  /**
   * ★「重写」= 真实动作（不是死按钮）：
   *   1) 派发 `nm:rewrite` 事件（detail = 当前章节 id/标题/范围），由 AI 对话面板侧消费；
   *   2) 若当前模式注册了 `ai-chat` 面板，直接打开该真实面板；
   *   3) 两种情况都在状态栏给出可见反馈。
   */
  var handleRewrite = useCallback(function() {
    window.dispatchEvent(new CustomEvent('nm:rewrite', {
      detail: {
        chapterId: currentChapterId,
        chapterTitle: currentChapter ? currentChapter.title : null,
        scope: 'chapter',
        prompt: '重写当前章节',
      },
    }));
    var hasChat = allShellPanels.some(function(p) { return p.key === 'ai-chat'; });
    if (hasChat) getPanelNavigation().open('ai-chat');
    setRewriteNotice(hasChat ? '重写请求已发送给 AI 对话' : '重写请求已发出（当前模式无 AI 对话面板）');
    window.setTimeout(function() { setRewriteNotice(null); }, 3000);
  }, [currentChapterId, currentChapter, allShellPanels]);

  // ★ 把 store 的开闭状态桥到 DockShell（视图层）：
  //   · 打开路径由 getPanelNavigation() 的「执行器注册 + 排队回放」承担（§2.4）
  //   · 关闭路径（减少集合）无法表示为单个 open 调用，故注册整集合同步回调
  //   ⇒ 用户点标签 ×、拖走面板等视图层交互，DockShell 经 onOpenChange 回写 store。
  var dockApiRef = React.useRef<DockShellApi | null>(null);
  useEffect(function() {
    var unregisterOpen = registerPanelViewOpener(function(key) {
      dockApiRef.current?.openPanel(key);
    });
    registerPanelViewSync(function(keys) {
      syncFromView(keys);
    });
    // ★ 单列布局：点文档标签栏的基础标签「章节正文」⇒ 切回中心编辑区面板。
    var unregisterBase = registerPanelViewBase(function() {
      dockApiRef.current?.focusBase();
    });
    return function() {
      unregisterOpen();
      registerPanelViewSync(null);
      unregisterBase();
    };
  }, [syncFromView]);

  // ★ 跨组件请求打开面板（ForeshadowWarning 的「查看」、正文高亮、AI 生成插件模板…）
  //
  //   ⚠ 本事件**不得删除**（ADR D6 / §2.3.2）：apps/server/src/ai/tools/plugin-tools.ts:189
  //     的 AI 插件生成模板会**永久**为已落盘插件吐 `'nm:open-panel'` 这个字面量，
  //     已发布的第三方插件也只会发这个事件。前端 4 个派发点（worldbuilding 2 处、
  //     ForeshadowWarning、LeadCharacterHighlight）**一行不改**。
  //
  //   迁移动作（§2.3.2）：回调体从旧的 `openPanel(key)` 改为
  //   `getPanelNavigation().open(key)`；前置校验逐字保留。
  //   监听挂载点：**保留在 `ProjectLayout`**（§2.3.2 允许「DockShell 或其父层」二选一）。
  //     选 ProjectLayout 的理由：它是项目的路由壳，即使 DockShell 尚未 ready
  //     （dockview 初始化是异步的）事件也不会丢 —— 命令式入口会**静默排队**（§2.4），
  //     DockShell ready 后回放。挂在 DockShell 内则要额外处理 ready 前的窗口期。
  //
  //   退出条件（§2.3.2-5 要求写进代码）：当 apps/server 的模板改为派发新的
  //     `nm:panel` 事件 **且** 已落盘的第三方插件完成迁移后，才可删除本监听。
  //     **本重构不满足该条件，故长期保留。**
  useEffect(function() {
    var onOpenPanel = function(e: Event) {
      var key = (e as CustomEvent<{ key: string }>).detail?.key;
      if (!key) return;
      getPanelNavigation().open(key);
    };
    window.addEventListener('nm:open-panel', onOpenPanel as EventListener);
    // ★ D7 / §2.3.3：跨域「打开设置页」事件桥 —— auto 模块/独立插件包内的技能栏
    //   点「添加技能」时派发。插件包不依赖 react-router-dom，故经此桥由 kernel 壳导航
    //   （与 nm:open-panel 同构）。实测当前**零派发点**，但属公开契约
    //   （docs/architecture/web-workbench-split.md:896 有正式记载），保留监听。
    var onOpenSettings = function() { navigate(PATHS.settings); };
    window.addEventListener('nm:open-settings', onOpenSettings as EventListener);
    return function() {
      window.removeEventListener('nm:open-panel', onOpenPanel as EventListener);
      window.removeEventListener('nm:open-settings', onOpenSettings as EventListener);
    };
  }, [navigate]);

  var handleLogout = useCallback(async function() {
    await logout();
    navigate(PATHS.login);
  }, [logout, navigate]);

  // ★ 创作模式分流：AI 写作模式走固定工作台 —— 不渲染停靠外壳。
  //   刻意放在所有 hooks 之后，保证两种模式下 hooks 的调用顺序完全一致。
  //   ★ 工作台组件来自注册表槽（auto 模块注册）。模块缺席 ⇒ activeWorkbench 为 null
  //     ⇒ 渲染「AI 写作台未安装」占位（WorkbenchMissing），保留项目壳与返回入口，
  //       不伪造兜底实现，也**不**用转圈占位（那会让用户永远等待一个不会来的组件）。
  //     本分支只覆盖 mode==='auto'，手写台（manual）路径不受任何影响。
  if ((project?.mode ?? 'manual') === 'auto') {
    var WorkbenchComponent = activeWorkbench?.Component as React.ComponentType<any> | undefined;
    if (!WorkbenchComponent) return <WorkbenchMissing mode="auto" onBack={handleBack} />;
    return (
      <Suspense fallback={<PanelFallback />}>
        <WorkbenchComponent project={project} onBack={handleBack} onProjectDataChanged={reloadProjectData} />
      </Suspense>
    );
  }

  return (
    <ErrorBoundary renderError={function(error) { return <ShellFatal error={error} />; }}>
      <div className="shell-root">
        {/* 顶栏（§5.3.6）：VS Code titleBar/topBar 视觉，颜色全取 --vscode-* */}
        <header className="shell-topbar" role="banner">
          {/* 左侧：返回书架 + 项目名 */}
          <div className="shell-topbar-left">
            {/* ★ 返回入口：原 `InkBackButton`（水墨毛笔箭头）已随水墨体系退役（ADR §6.4）。
                全站返回入口统一改用 lucide 的 `ArrowLeft`（同 AdminPage 的做法），
                保留原有 onClick 行为与中文无障碍标签。 */}
            <button
              type="button"
              onClick={handleBack}
              className="nm-btn-apple-icon-sm"
              title={backLabel}
              aria-label="返回"
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
            {/* ★ t1：面包屑「项目名 / 当前章节名」（截图顶栏左端）。
                · 项目名沿用原 `shell-topbar-title` 的「回书架」语义（点击 = 返回）
                · 章节名取真实 `Chapter.title`（自带「第N章」前缀）；无章节给中性回落 */}
            <nav className="shell-breadcrumb" aria-label="面包屑">
              <button
                type="button"
                className="shell-breadcrumb-root"
                onClick={function() { navigate(backTarget); }}
                title={backLabel}
              >
                {project ? project.name : '听风细雨'}
              </button>
              <span className="shell-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              <span
                className="shell-breadcrumb-leaf"
                title={currentChapter ? currentChapter.title : '未打开章节'}
              >
                {currentChapter ? currentChapter.title : '章节正文'}
              </span>
            </nav>
          </div>

          <div />

          <div className="shell-topbar-right">
            {/* ★ 用户口径（m04040）：「手写 / AI 写作」模式切换按钮已从顶栏移除 ——
                创作模式在开书时定下（书架页新建向导写 project.mode），
                「进入了 AI 写作就是 AI 写作，手写写作就手写写作」，不该在写作途中
                再摆一组模式按钮。当前模式的被动显示仍在状态栏（手写模式 / AI 写作模式）。 */}
            <button
              type="button"
              className="shell-topbar-text-btn"
              title="重写当前章节（发送给 AI 对话面板）"
              aria-label="重写"
              onClick={handleRewrite}
            >
              重写
            </button>
            <button
              type="button"
              className="shell-topbar-text-btn"
              title={themeMode === 'dark' ? '切到亮色' : '切到夜间（暗色）'}
              aria-label={themeMode === 'dark' ? '切到亮色' : '夜间模式'}
              aria-pressed={themeMode === 'dark'}
              onClick={function() { setThemeMode(themeMode === 'dark' ? 'light' : 'dark'); }}
            >
              {themeMode === 'dark' ? <Sun size={13} aria-hidden="true" /> : <Moon size={13} aria-hidden="true" />}
              <span>{themeMode === 'dark' ? '日间' : '夜间'}</span>
            </button>
            <span className="shell-topbar-divider" aria-hidden="true" />
            {/* ★ 面板菜单 = 退役的功能转轮的替代入口（ADR §0.3） */}
            <PanelMenu panels={floatingPanels} />
            <button
              onClick={function() { navigate(PATHS.settings); }}
              className="nm-btn-apple-icon-sm"
              title="设置"
              aria-label="设置"
            >
              <Settings size={15} />
            </button>
            {user?.isAdmin && (
              <button
                onClick={function() { navigate(PATHS.admin); }}
                className="nm-btn-apple-icon-sm"
                title="管理员后台"
                aria-label="管理员后台"
              >
                <Shield size={15} />
              </button>
            )}
            {user && (
              <div className="shell-user-chip">
                <div className="shell-user-avatar">
                  {user.displayName ? user.displayName.charAt(0).toUpperCase() : <User size={10} />}
                </div>
                <span className="shell-user-name">{user.displayName}</span>
              </div>
            )}
            <button
              onClick={handleLogout}
              className="nm-btn-apple-icon-sm"
              title="登出"
              aria-label="登出"
            >
              <LogOut size={15} />
            </button>
          </div>
        </header>

        {/* ★ t6 去层：文档标签行不再是一条独立横条 —— 它已并入中心 dock 组的组头
            （DockShell 的 `dock:doc-tabs` tabComponent），与左「章节」/ 右「AI 对话」
            共用同一条 35px 头部带，顶部由三层收敛为两层（顶栏 + 头部带）。 */}

        {/* 主区：DockShell 承载全部面板（单列 —— 正页标签堆叠 + 悬浮 + Splitter） */}
        <main className="shell-main">
          <DockShell
            panels={allShellPanels}
            /* 中心槽出口（章节编辑器路由）自带 Suspense —— `lazyRoute()` 已为它套了边界
               （routes/Lazy.tsx），编辑器 chunk 未就绪时只在该出口内转圈。 */
            centerDefault={<Outlet />}
            apiRef={dockApiRef}
            openKeys={openPanelKeys}
            baseOpen={baseOpen}
            onOpenChange={syncFromView}
            onActiveChange={setActiveKey}
            // ★ t1：底部细条 =「N 条问题 Ctrl+J」；N 来自真实批注（见 shell/issues.tsx），
            //   展开区渲染真实问题清单。
            bottomPanel={{ issueCount: issueCount, children: <BottomIssueList /> }}
          />
        </main>

        {/* 状态栏（§5.3.5 / t1）：左「● 已保存 · 总字数 · 当前模式」，右「本机时间」。
            全部取自真实来源：保存态 = 本地缓存 ↔ store 内容比对（shell/statusBar.ts），
            总字数 = Project.currentWordCount，模式 = project.mode。
            ★ 2026-10-27：右侧原来还有「主题名 · 亮/暗」一项，按用户口径删除（与顶栏「夜间」
              按钮信息重复）。 */}
        <footer className="shell-statusbar" role="contentinfo">
          <div className="shell-statusbar-group">
            <span className="shell-statusbar-item" title="保存态：章节本地缓存与 store 内容比对">
              <span
                className={saveState.saved ? 'shell-save-dot is-saved' : 'shell-save-dot'}
                aria-hidden="true"
              >
                ●
              </span>
              {saveState.saved ? '已保存' : '保存中…'}
            </span>
            <span className="shell-statusbar-item" title="项目总字数（Project.currentWordCount）">
              {formatWordCount(project ? project.currentWordCount : 0)} 字
            </span>
            <span className="shell-statusbar-divider" aria-hidden="true" />
            <span className="shell-statusbar-item is-remote">
              {projectMode === 'auto' ? 'AI 写作模式' : '手写模式'}
            </span>
            {rewriteNotice ? (
              <span className="shell-statusbar-item is-notice">{rewriteNotice}</span>
            ) : null}
          </div>
          <div className="shell-statusbar-group">
            <span className="shell-statusbar-item" title="本机时间">
              {clock}
            </span>
          </div>
        </footer>
      </div>
    </ErrorBoundary>
  );
}
