// ============================================================
// 「重写」请求：内核顶栏 → AI 对话面板（跨模块、跨挂载时机）
//
// ## 为什么不是纯事件
//   派发方在 `ProjectLayout`（kernel），消费方在 `@novel-plugins/manual-workbench`
//   的 `AiChatPanel` —— 它是 `React.lazy`，**首次打开前模块都还没加载**。
//   点「重写」时若面板从没开过，`window` 上根本没有监听器，事件会**静默丢失**。
//   （这也解释了它此前"派发了却没人接"为什么一直没被注意到：没人接的时候它看起来
//    只是没反应，而不是报错。）
//
//   ⇒ 事件 + **待处理缓冲**：请求先落在模块级 `pending` 里，面板挂载时补消费。
//     两条路径（事件到达 / 挂载后取用）都走 `takePendingRewrite()` 清空 ——
//     保证同一条请求只触发一次。
//
// ## 分层
//   本文件在 kernel（apps/web）。插件侧经 `@/components/shell/rewriteRequest` 引入
//   —— 与 `EditorPage` 引入 `@/routes/paths` 属同一层级的既有做法，不新增反向依赖。
// ============================================================

export const REWRITE_EVENT = 'nm:rewrite';

export interface RewriteRequest {
  /** 目标章节 id（顶栏取的是"当前章节"，可能为 null） */
  chapterId: string | null;
  chapterTitle: string | null;
  scope: 'chapter';
  /** 顶栏给的原始意图文案，例如「重写当前章节」 */
  prompt: string;
}

let pending: RewriteRequest | null = null;

/** 顶栏调用：记下待处理请求并广播（面板若已挂载则立即响应） */
export function requestRewrite(req: RewriteRequest): void {
  pending = req;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<RewriteRequest>(REWRITE_EVENT, { detail: req }));
}

/**
 * 消费方调用：取出并清空。
 * 事件路径与「挂载后补偿」路径都走它 —— 同一条请求只会被消费一次。
 */
export function takePendingRewrite(): RewriteRequest | null {
  const req = pending;
  pending = null;
  return req;
}
