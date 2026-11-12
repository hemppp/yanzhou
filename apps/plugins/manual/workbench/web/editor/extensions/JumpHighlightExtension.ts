import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// 时间线跳转后的「正文片段」高亮。
//
// ★ 为什么必须走 ProseMirror Decoration，而不是直接改 DOM：
//   实测把文本节点包进 `<span data-nm-jump-highlight>` 后，高亮在 60ms 内就消失 ——
//   ProseMirror 的 DOM 观察器把外来节点视为"被外部篡改"，随即按自己的 view
//   重绘该段，span 被整个替换掉。Decoration 是编辑器**自己**的渲染产物，
//   既不触发 DOM 归属冲突，也能在用户继续输入时随文档 mapping 自动跟随。
//
// 高亮由外部（editor/jumpHighlight 的调用方）通过 transaction meta 驱动：
//   tr.setMeta(JUMP_HIGHLIGHT_META, [{ from, to }, ...])  // 点亮
//   tr.setMeta(JUMP_HIGHLIGHT_META, null)                  // 清除

export const JUMP_HIGHLIGHT_META = 'nmJumpHighlight';

export interface JumpHighlightRange {
  from: number;
  to: number;
}

const pluginKey = new PluginKey<DecorationSet>('nmJumpHighlight');

/** 内联样式：用 span 而不是 <mark> —— globals.css 对 `.ProseMirror mark` 有
 *  `background: transparent !important` 的重置，<mark> 的底色会被吃掉。 */
const HIGHLIGHT_STYLE = [
  'background-color: rgba(212, 162, 74, 0.32)',
  'border-radius: 3px',
  'box-shadow: 0 0 0 2px rgba(212, 162, 74, 0.16)',
  'transition: background-color 0.7s ease, box-shadow 0.7s ease',
].join('; ');

function buildDecorations(doc: Parameters<typeof DecorationSet.create>[0], ranges: JumpHighlightRange[]): DecorationSet {
  const valid = ranges.filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from);
  if (valid.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    valid.map(({ from, to }) =>
      Decoration.inline(from, to, {
        class: 'nm-jump-highlight',
        'data-nm-jump-highlight': '1',
        style: HIGHLIGHT_STYLE,
      }),
    ),
  );
}

export const JumpHighlightExtension = Extension.create({
  name: 'nmJumpHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: pluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(JUMP_HIGHLIGHT_META) as JumpHighlightRange[] | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (Array.isArray(meta)) return buildDecorations(tr.doc, meta);
            // 没有 meta 的普通编辑事务：让高亮随文档变化跟随（删除文字时自动缩短）
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
