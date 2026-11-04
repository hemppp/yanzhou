// ============================================================
// 外部正文写入 → 打开着的编辑器（事件通道）
//
// ## 为什么需要这个文件
//   EditorPage 只在**章节切换**时 `setContent`（依赖是 `[currentChapterId, editor]`，
//   刻意不含 content —— 否则用户每敲一个字都会重设内容、光标乱跳）。
//   于是从**外部**写 store 的正文（AI 对话确认写入、AI 流式流入）在编辑器里
//   **看不见**：store 变了，Tiptap 不知道。
//
//   不能改成"监听 store 内容变化"：编辑器自己打字也会写 store，写入有防抖，
//   订阅方会读到**滞后一拍**的旧值并把它 setContent 回去 —— 那是直接把用户
//   正在打的字吃掉。所以必须是**显式信号**：谁从外部写，谁负责说一声。
//
// ## 用法
//   写入方（AI 提案确认 / 流式流入）在 `updateChapter` 之后调用
//   `publishExternalChapterContent({ chapterId, content })`；
//   EditorPage 监听本事件，只在**章号匹配**时把内容灌进编辑器，
//   且用 `setContent(..., false)`（不 emitUpdate）避免回写 store 造成循环。
//
//   命名沿用仓库既有惯例（`novelmuse:*`），与 `annotationBlocks.ts` 的
//   `novelmuse:annotation-blocks` 同一模式：零 import 也能监听。
// ============================================================

export const CHAPTER_EXTERNAL_CONTENT_EVENT = 'novelmuse:chapter-external-content';

export interface ChapterExternalContentDetail {
  /** 目标章节 id —— 编辑器只在自己正打开这一章时才应用 */
  chapterId: string;
  /** **完整**的新正文（HTML）。注意不是增量：编辑器会整体 setContent */
  content: string;
}

/** 外部写入方在把内容写进 store 之后调用，让打开着的编辑器同步刷新 */
export function publishExternalChapterContent(detail: ChapterExternalContentDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ChapterExternalContentDetail>(CHAPTER_EXTERNAL_CONTENT_EVENT, { detail }),
  );
}
