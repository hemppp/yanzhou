/**
 * 内嵌批注块的 NodeView（纯 DOM，无 React）
 *
 * 为什么不用 `ReactNodeViewRenderer`：本仓 `@tiptap/react@2.27.2` 的 ReactNodeView 对
 * 非 inline 节点固定把 contentDOM 建成 `<div>`（`contentDOMElementTag` 未进入
 * `ReactNodeViewRendererOptions` 类型，想要「徽标与正文同一行」必须 cast），
 * 而截图要求的正是「类型徽标 + 自由文本」同一行的块级卡片。
 * 纯 DOM NodeView 可以自选 contentDOM 标签、内联样式（不依赖 Tailwind 生成）、
 * 并用官方 `stopEvent` 机制让 `<input>` / 按钮不被 ProseMirror 吞掉按键。
 *
 * 属性与统计口径全部来自 `../annotationBlocks`，此处不再重复定义。
 */

import type { Editor, NodeViewRenderer, NodeViewRendererProps } from '@tiptap/core';
import type { NodeView } from '@tiptap/pm/view';
import {
  ANNOTATION_BLOCK_NODE_NAME,
  DEFAULT_ANNOTATION_KIND,
  normalizeAnnotationBlockState,
  normalizeAnnotationKind,
  type AnnotationBlockState,
} from '../annotationBlocks';

/** 块外观：浅灰底 + 左侧强调条，对齐目标截图 */
const BLOCK_STYLE = [
  'background-color: hsl(var(--paper-inset))',
  'border-left: 3px solid hsl(var(--paper-line-strong))',
  'border-radius: 6px',
  'padding: var(--space-3) var(--space-5)',
  'margin: var(--space-5) 0',
  'font-size: 13px',
  'line-height: 1.85',
  'color: hsl(var(--ink-light))',
].join('; ');

/** 徽标输入框：小号、字距略开、低对比度，视觉上像标记而不是表单 */
const KIND_INPUT_STYLE = [
  'font-family: inherit',
  'font-size: 11px',
  'letter-spacing: 0.08em',
  'color: hsl(var(--ink-pale))',
  'background-color: transparent',
  'border: none',
  'border-bottom: 1px dashed transparent',
  'outline: none',
  'padding: 0',
  'margin: 0',
  'max-width: 14em',
  'vertical-align: baseline',
].join('; ');

/** 正文容器：inline-block 保证「空块也可点」，并给出最小命中区域 */
const CONTENT_STYLE = [
  'display: inline-block',
  'min-width: 4ch',
  'min-height: 1.6em',
  'vertical-align: baseline',
  'outline: none',
].join('; ');

const TOOL_BUTTON_STYLE = [
  'font-family: inherit',
  'font-size: 11px',
  'color: hsl(var(--ink-pale))',
  'background-color: transparent',
  'border: none',
  'padding: 0 var(--space-1)',
  'cursor: pointer',
  'text-decoration: underline',
  'text-underline-offset: 2px',
].join('; ');

function createToolButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.style.cssText = TOOL_BUTTON_STYLE;
  return button;
}

/**
 * 批注块的 NodeView 工厂。
 * 返回的节点视图结构：
 *   div.nm-annotation-block
 *     ├─ span(head, contenteditable=false)  ← 类型徽标 input + 两个小按钮
 *     └─ span(contentDOM)                   ← 自由文本（inline*）
 */
export function createAnnotationBlockNodeView(): NodeViewRenderer {
  return (props: NodeViewRendererProps): NodeView => {
    const { editor, getPos } = props;
    let node = props.node;

    const dom = document.createElement('div');
    dom.className = 'nm-annotation-block';
    dom.setAttribute('data-annotation-block', 'true');
    dom.style.cssText = BLOCK_STYLE;

    const head = document.createElement('span');
    // 显式写属性（而非只设 IDL 属性）：jsdom 下 `contentEditable = 'false'` 不会
    // 反射成 `contenteditable="false"`，显式写属性则浏览器 / jsdom 行为一致。
    head.setAttribute('contenteditable', 'false');
    head.setAttribute('data-annotation-block-head', 'true');

    const kindInput = document.createElement('input');
    kindInput.type = 'text';
    kindInput.className = 'nm-annotation-block-kind';
    kindInput.placeholder = DEFAULT_ANNOTATION_KIND;
    kindInput.setAttribute('aria-label', '批注类型标记');
    kindInput.style.cssText = KIND_INPUT_STYLE;
    // 属性缺失时**不**伪造内容：留空由 placeholder 提示（renderHTML/往返因此保持干净）
    kindInput.value = normalizeAnnotationKind(node.attrs.kind) ?? '';

    const toggleButton = createToolButton('标记已解决', '标记为已解决');
    const deleteButton = createToolButton('删除', '删除该批注块');

    head.appendChild(kindInput);
    head.appendChild(toggleButton);
    head.appendChild(deleteButton);

    const contentDOM = document.createElement('span');
    contentDOM.className = 'nm-annotation-block-content';
    contentDOM.style.cssText = CONTENT_STYLE;

    dom.appendChild(head);
    dom.appendChild(contentDOM);

    /** 当前位置：NodeView 被移动后 `getPos()` 才会反映真实位置，故每次都问 */
    const currentPos = (): number | null => {
      const value = typeof getPos === 'function' ? getPos() : undefined;
      return typeof value === 'number' ? value : null;
    };

    const applyAttrs = (attrs: Record<string, unknown>): void => {
      const pos = currentPos();
      if (pos === null) return;
      editor
        .chain()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
          return true;
        })
        .run();
    };

    const removeBlock = (): void => {
      const pos = currentPos();
      if (pos === null) return;
      editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    };

    /** 依据当前属性刷新视觉与按钮文案（update / 初次挂载共用） */
    const renderState = (): void => {
      const kind = normalizeAnnotationKind(node.attrs.kind) ?? '';
      if (kindInput.value.trim() !== kind) kindInput.value = kind;

      const state: AnnotationBlockState = normalizeAnnotationBlockState(node.attrs.state);
      const resolved = state === 'resolved';
      dom.dataset.state = resolved ? 'resolved' : 'open';
      dom.dataset.annotationBlock = 'true';
      dom.style.opacity = resolved ? '0.62' : '1';
      toggleButton.textContent = resolved ? '重新打开' : '标记已解决';
      // ★ t6 F-3：`createToolButton` 只在建按钮时写了一次 `aria-label`，`renderState`
      //   若不重写，解决态下屏幕阅读器读到的仍是「标记为已解决」——与可见文案/`title`
      //   不一致。这里把 `title` 与 `aria-label` 一并按当前状态重设。
      toggleButton.title = resolved ? '重新打开该批注' : '标记为已解决';
      toggleButton.setAttribute('aria-label', resolved ? '重新打开该批注' : '标记为已解决');
      toggleButton.setAttribute('aria-pressed', resolved ? 'true' : 'false');
    };

    kindInput.addEventListener('input', () => {
      const next = normalizeAnnotationKind(kindInput.value);
      const current = normalizeAnnotationKind(node.attrs.kind);
      if (next === current) return;
      applyAttrs({ kind: next });
    });

    toggleButton.addEventListener('click', (event) => {
      event.preventDefault();
      const next: AnnotationBlockState = normalizeAnnotationBlockState(node.attrs.state) === 'resolved' ? 'open' : 'resolved';
      applyAttrs({ state: next });
    });

    deleteButton.addEventListener('click', (event) => {
      event.preventDefault();
      removeBlock();
    });

    renderState();

    return {
      dom,
      contentDOM,

      update: (updated) => {
        if (updated.type.name !== ANNOTATION_BLOCK_NODE_NAME) return false;
        node = updated;
        renderState();
        return true;
      },

      /** 徽标 / 按钮所在的 head 归我们自己处理，其余事件交给 ProseMirror */
      stopEvent: (event) => event.target instanceof Node && head.contains(event.target),

      /**
       * 选区变化交 ProseMirror 处理（否则光标无法进入批注块）；
       * 只把 contentDOM 内的改动当作文档改动，head 上的属性变更一律忽略。
       */
      ignoreMutation: (mutation) => {
        if (mutation.type === 'selection') return false;
        return !contentDOM.contains(mutation.target);
      },

      selectNode: () => {
        dom.dataset.selected = 'true';
        dom.style.boxShadow = '0 0 0 2px hsl(var(--paper-line-strong))';
      },

      deselectNode: () => {
        delete dom.dataset.selected;
        dom.style.boxShadow = '';
      },
    };
  };
}

/** 供扩展 `addKeyboardShortcuts` 判断「光标是否落在批注块内」复用 */
export function isAnnotationBlockNode(nodeName: string): boolean {
  return nodeName === ANNOTATION_BLOCK_NODE_NAME;
}

/** 仅在测试/调试中需要：拿到某编辑器实例里批注块的 dom 列表 */
export function findAnnotationBlockDoms(editor: Editor): HTMLElement[] {
  return Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.nm-annotation-block'));
}
