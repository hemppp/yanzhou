// ============================================================
// issues.tsx —— 底部面板「问题清单」的**真实数据源**（t1 外壳改造）
//
// ★ 2026-11-06：底部细条右端的「N 条问题 / Ctrl+J」提示已按用户要求移除。
//   细条现在只剩左端开关 + 插件注册的入口；本模块继续为**展开区**的问题清单
//   提供真实数据（`useChapterIssues` / `useAnnotationBlocks`），绝不伪造数字。
//   原先只服务于细条 N 的 `useIssueCount` / `registerIssueCountProvider` 已一并删除。
// ============================================================

import { useMemo, useSyncExternalStore } from 'react';
import { useAnnotationStore, useChapterStore } from '@/stores';
import type { Annotation } from '@novel/shared';

// ============================================================
// ★ t4（集成接线）：中栏「内嵌批注块」计数的**零 import 通道**
//
// 为什么不用 import：t2 的实现位于 `apps/plugins/manual/workbench/web/editor/`，
// 而本文件属于 kernel（`apps/web/src/`）。kernel 直接 import 插件目录会造出一条
// kernel→plugin 的静态模块边（既有一模块一包的边界约束不允许），所以走 t2
// **已经公开**的两个跨区接口（t2 交付契约原文）：
//   · `window.__novelmuseAnnotationBlocks = { chapterId, total, open }`
//   · `window.addEventListener('novelmuse:annotation-blocks', e => e.detail)`
//     （同步派发同一对象；**值不变不换引用**，故这里用内部 version 计数订阅）
//
// `open` 即「本章未解决批注块数」（原底部细条 N 的取值；细条已不再显示该数字）。
// 桥缺席（无手写台 / 编辑器未挂载）⇒ 全部返回 null，静默回落到 annotation store。
// ============================================================

/** t2 交付的批注块汇总快照（字段与 `AnnotationBlockSummary` 一致）。 */
export interface AnnotationBlockSummary {
  chapterId: string | null;
  total: number;
  open: number;
}

export const ANNOTATION_BLOCKS_GLOBAL_KEY = '__novelmuseAnnotationBlocks';
export const ANNOTATION_BLOCKS_EVENT = 'novelmuse:annotation-blocks';

function isAnnotationBlockSummary(v: unknown): v is AnnotationBlockSummary {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.total !== 'number' || typeof o.open !== 'number') return false;
  return o.chapterId === null || o.chapterId === undefined || typeof o.chapterId === 'string';
}

/** 读取桥的当前快照；桥不存在 / 形状不符 ⇒ null（绝不伪造数字）。 */
export function readAnnotationBlocks(): AnnotationBlockSummary | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as unknown as Record<string, unknown>)[ANNOTATION_BLOCKS_GLOBAL_KEY];
  if (!isAnnotationBlockSummary(raw)) return null;
  const snap = raw as AnnotationBlockSummary;
  return { chapterId: snap.chapterId ?? null, total: snap.total, open: snap.open };
}

let blockVersion = 0;
const blockListeners = new Set<() => void>();

function onAnnotationBlocksEvent(): void {
  blockVersion += 1;
  blockListeners.forEach((l) => l());
}

/** 订阅桥事件（首个订阅者挂 window 监听，最后一个注销时移除）。 */
export function subscribeAnnotationBlocks(listener: () => void): () => void {
  blockListeners.add(listener);
  if (blockListeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener(ANNOTATION_BLOCKS_EVENT, onAnnotationBlocksEvent);
  }
  return () => {
    blockListeners.delete(listener);
    if (blockListeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener(ANNOTATION_BLOCKS_EVENT, onAnnotationBlocksEvent);
    }
  };
}

/** 订阅快照：单调递增的版本号（桥「值不变不换引用」，只能靠它触发重算）。 */
export function annotationBlocksVersion(): number {
  return blockVersion;
}

/**
 * ★ t4：订阅「本章批注块计数」。仅当快照的 chapterId 与入参**完全一致**时返回，
 * 否则 null（切章瞬间、编辑器卸载后的 reset 都不会串台）。
 */
export function useAnnotationBlocks(chapterId: string | null): AnnotationBlockSummary | null {
  const version = useSyncExternalStore(
    subscribeAnnotationBlocks,
    annotationBlocksVersion,
    annotationBlocksVersion,
  );
  return useMemo(() => {
    const snap = readAnnotationBlocks();
    if (!snap || !chapterId) return null;
    return snap.chapterId === chapterId ? snap : null;
  }, [chapterId, version]);
}

/** 当前章节 id（真实 store）。 */
export function useCurrentChapterId(): string | null {
  return useChapterStore((s) => s.currentChapterId);
}

/** 当前章节的批注（问题清单）原始列表。 */
export function useChapterIssues(chapterId: string | null): Annotation[] {
  const annotations = useAnnotationStore((s) => s.annotations);
  return useMemo(
    () => (chapterId ? annotations.filter((a) => a.chapterId === chapterId) : []),
    [annotations, chapterId],
  );
}

const TYPE_LABEL: Record<string, string> = {
  character: '人物',
  item: '物品',
  location: '地点',
  event: '事件',
  foreshadow: '伏笔',
  general: '待核',
  note: '笔记',
};

/** 底部面板展开后的内容：当前章节的问题清单（真实批注；无数据给空态文案）。 */
export function BottomIssueList() {
  const chapterId = useCurrentChapterId();
  const issues = useChapterIssues(chapterId);
  // ★ t4：与原底部细条的 N 同源 —— 展开后能看到计数是怎么算出来的
  const blocks = useAnnotationBlocks(chapterId);

  if (!chapterId) {
    return <div className="shell-bottom-empty">未打开章节。</div>;
  }
  return (
    <div className="shell-bottom-body">
      {blocks ? (
        <div className="shell-bottom-blocks" data-testid="bottom-annotation-blocks">
          内嵌批注块 {blocks.total} 条 · 未解决 {blocks.open} 条
        </div>
      ) : null}
      {issues.length === 0 ? (
        <div className="shell-bottom-empty">当前章节没有问题。</div>
      ) : (
        <ul className="shell-bottom-issues" aria-label="问题清单">
          {issues.map((a) => (
            <li key={a.id} className="shell-bottom-issue">
              <span className="shell-bottom-issue-type">{TYPE_LABEL[a.type] ?? a.type}</span>
              <span className="shell-bottom-issue-text">{a.description || a.selectedText}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
