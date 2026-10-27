// ============================================================
// editor/PageLayer.tsx —— 页面视图的「纸卡片 + 页码」装饰层
//
// 只画视觉：A4 纸面、投影、页码。**不参与命中**（pointer-events:none，见 globals.css
// 「页面视图」段）—— 点纸上的任何位置都由下面的正文流接住，落在哪一页由浏览器算。
//
// 几何与正文流同源：第 i 张纸的左缘 = i × (纸宽 + 页缝)，而正文流的第 i 列起点
// = 页边距 + i × (纸宽 + 页缝)（列距 = 两倍页边距 + 页缝，见 globals.css）。
// 两者相减正好是页边距 ⇒ 文字严丝合缝落在纸的正文区里（实测对齐 95px）。
//
// 为什么不用 JS 把内容切进每张纸：那会改 ProseMirror 的 DOM 所有权
// （view.dom 由 view 自己 append，见 @tiptap/react 的 EditorContent），
// 打字/选区/撤销全要重做。这里只加一层兄弟装饰，正文仍是一篇文档。
// ============================================================

import { memo } from 'react';
import { pagePitchPx } from './hooks/usePageView';

export const PageLayer = memo(function PageLayer({ pages }: { pages: number }) {
  const pitch = pagePitchPx();
  return (
    <div className="nm-page-layer" aria-hidden="true">
      {Array.from({ length: pages }, (_, i) => (
        <div key={i} className="nm-page-sheet" style={{ left: i * pitch }}>
          <span className="nm-page-num">{i + 1}</span>
        </div>
      ))}
    </div>
  );
});
