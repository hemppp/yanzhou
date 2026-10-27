/**
 * 内嵌批注块（annotationBlock）单测
 *
 * 覆盖验收里明确要求的四件事：
 *   1. HTML 往返无损 —— 真实 Tiptap schema 下 `getHTML()` 输出仍带块属性、
 *      文本逐字保留、二次解析幂等（这条守住「随章节 content 走 PUT 后切章/刷新不丢」）
 *   2. 插入 / 编辑 / 删除 / 撤销重做 —— 走真实命令与事务
 *   3. count / strip 纯函数口径
 *   4. 导出「过滤批注块」开关的两种结果（txt 与 markdown 都验）
 *
 * ★ 刻意不做的事：不 mock Tiptap。批注块是新增的**自定义 Node**，只有真 schema
 *   才能证明 parse/render 的两端都成立（手写 DOM 断言会把 schema 错误一起放过）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  ANNOTATION_BLOCKS_EVENT,
  ANNOTATION_BLOCKS_GLOBAL,
  annotationBlockBridge,
  annotationBlocksText,
  collectAnnotationBlocks,
  countAnnotationBlocks,
  publishAnnotationBlockSummary,
  resetAnnotationBlockSummary,
  stripAnnotationBlocks,
} from '../annotationBlocks';
import { AnnotationBlockExtension } from '../extensions/AnnotationBlockExtension';
import { findAnnotationBlockDoms } from '../extensions/AnnotationBlockView';
import { exportMarkdown, exportTXT } from '../../services/data/exportService';
import { ensureHtmlContent, htmlToText } from '@novel-plugins/data-core/editor/entityDetector';

const PARAGRAPH_A = '雨是从后半夜开始下的。';
const PARAGRAPH_B = '沈砚在堂屋里坐到天光泛青。';
const BLOCK_TEXT_A = '第四章写「灶间那句『他早回来了』」，与本章「沈砚十年未归」的时间口径需对齐。';
const BLOCK_TEXT_B = '沈母的药钱来源在本章出现两次，需与原设定核对。';
const KIND = '待核 · 时间线';

/** 与 `AnnotationBlockExtension.renderHTML` 的输出同构（属性顺序无关，仅作输入样本） */
function blockHtml(text: string, kind = KIND, state = 'open'): string {
  return `<div data-annotation-block="true" class="nm-annotation-block" data-kind="${kind}" data-state="${state}">${text}</div>`;
}

const mountedEditors: Editor[] = [];

function createEditor(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, AnnotationBlockExtension],
    content,
  });
  mountedEditors.push(editor);
  return editor;
}

/** 文档里第一个批注块的起始位置（找不到返回 -1） */
function firstAnnotationBlockPos(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (found !== -1) return false;
    if (node.type.name === 'annotationBlock') {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

afterEach(() => {
  while (mountedEditors.length > 0) {
    const editor = mountedEditors.pop();
    editor?.destroy();
  }
  document.body.innerHTML = '';
  resetAnnotationBlockSummary();
});

describe('annotationBlock · HTML 往返', () => {
  it('解析出的批注块经 getHTML 仍带宿主属性与逐字正文', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}<p>${PARAGRAPH_B}</p>`);
    const html = editor.getHTML();

    expect(html).toContain('data-annotation-block="true"');
    expect(html).toContain('class="nm-annotation-block"');
    expect(html).toContain(`data-kind="${KIND}"`);
    expect(html).toContain('data-state="open"');
    expect(annotationBlocksText(html)).toBe(BLOCK_TEXT_A);
    // 批注块之外的正文原样保留
    expect(html).toContain(PARAGRAPH_A);
    expect(html).toContain(PARAGRAPH_B);
  });

  it('二次解析幂等（往返无损）', () => {
    const first = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}`);
    const htmlOnce = first.getHTML();
    const htmlTwice = createEditor(htmlOnce).getHTML();
    expect(htmlTwice).toBe(htmlOnce);
  });

  it('data-kind 缺失时不伪造徽标，也不输出空 data-kind', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p><div data-annotation-block="true" class="nm-annotation-block">孤立批注</div>`);
    const html = editor.getHTML();
    expect(html).not.toContain('data-kind');
    expect(html).toContain('data-state="open"');
    expect(collectAnnotationBlocks(html)).toEqual([{ kind: null, state: 'open', text: '孤立批注' }]);
  });

  it('同一章节内多个批注块顺序稳定', () => {
    const editor = createEditor(
      `<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}<p>${PARAGRAPH_B}</p>${blockHtml(BLOCK_TEXT_B)}`,
    );
    const html = editor.getHTML();
    const texts = collectAnnotationBlocks(html).map((record) => record.text);
    expect(texts).toEqual([BLOCK_TEXT_A, BLOCK_TEXT_B]);

    // 文档顺序：段落 → 块 A → 段落 → 块 B
    const order: string[] = [];
    editor.state.doc.forEach((node: ProseMirrorNode) => {
      order.push(node.type.name);
    });
    expect(order).toEqual(['paragraph', 'annotationBlock', 'paragraph', 'annotationBlock']);

    // 再往返一次顺序不变
    const roundTripped = collectAnnotationBlocks(createEditor(html).getHTML()).map((record) => record.text);
    expect(roundTripped).toEqual([BLOCK_TEXT_A, BLOCK_TEXT_B]);
  });
});

describe('annotationBlock · 插入 / 编辑 / 删除 / 撤销重做', () => {
  it('insertAnnotationBlock 插到当前段落之后，并把选区落在块内正文上', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>`);
    editor.commands.setTextSelection(2);

    expect(editor.commands.insertAnnotationBlock({ kind: KIND, text: '批注占位' })).toBe(true);

    const order: string[] = [];
    editor.state.doc.forEach((node: ProseMirrorNode) => {
      order.push(node.type.name);
    });
    expect(order).toEqual(['paragraph', 'annotationBlock']);
    expect(editor.state.doc.firstChild?.textContent).toBe(PARAGRAPH_A);
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 1, open: 1 });

    // 选区在批注块正文里（有占位文本时整体选中 → 直接输入即替换）
    const { from, to } = editor.state.selection;
    expect(to - from).toBe('批注占位'.length);
    expect(editor.state.doc.textBetween(from, to)).toBe('批注占位');
  });

  it('可编辑块内文本，且编辑可撤销重做', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml('旧批注')}`);
    const pos = firstAnnotationBlockPos(editor);
    expect(pos).toBeGreaterThan(0);

    // 编辑：整体替换块内文本（走真实事务 → 可撤销）
    editor
      .chain()
      .focus()
      .setTextSelection({ from: pos + 1, to: pos + 1 + '旧批注'.length })
      .insertContent('新批注')
      .run();
    expect(annotationBlocksText(editor.getHTML())).toBe('新批注');

    editor.commands.undo();
    expect(annotationBlocksText(editor.getHTML())).toBe('旧批注');

    editor.commands.redo();
    expect(annotationBlocksText(editor.getHTML())).toBe('新批注');
  });

  it('插入可撤销重做：undo 后批注块整块消失，redo 后回来', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>`);
    editor.commands.setTextSelection(2);

    editor.commands.insertAnnotationBlock({ kind: KIND, text: '批注占位' });
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 1, open: 1 });

    editor.commands.undo();
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 0, open: 0 });
    expect(editor.getHTML()).toBe(`<p>${PARAGRAPH_A}</p>`);

    editor.commands.redo();
    expect(annotationBlocksText(editor.getHTML())).toBe('批注占位');
  });

  it('删除可撤销：整块移除后正文只剩段落，undo 复原', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}<p>${PARAGRAPH_B}</p>`);
    const pos = firstAnnotationBlockPos(editor);
    const node = editor.state.doc.nodeAt(pos);
    expect(node?.type.name).toBe('annotationBlock');

    editor.chain().focus().deleteRange({ from: pos, to: pos + (node?.nodeSize ?? 0) }).run();
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 0, open: 0 });
    expect(editor.getHTML()).not.toContain(BLOCK_TEXT_A);
    expect(editor.getHTML()).toContain(PARAGRAPH_A);
    expect(editor.getHTML()).toContain(PARAGRAPH_B);

    editor.commands.undo();
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 1, open: 1 });
    expect(annotationBlocksText(editor.getHTML())).toBe(BLOCK_TEXT_A);
  });

  it('已解决的块仍计入 total，但不计入未解决的 open', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>`);
    editor.commands.setTextSelection(2);
    editor.commands.insertAnnotationBlock({ kind: KIND, text: '已处理', state: 'resolved' });
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 1, open: 0 });

    const pos = firstAnnotationBlockPos(editor);
    const node = editor.state.doc.nodeAt(pos);
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, { ...node?.attrs, state: 'open' });
        return true;
      })
      .run();
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 1, open: 1 });
  });
});

describe('annotationBlock · count / strip 纯函数', () => {
  it('无批注块时 strip 原样返回（不改写正文）', () => {
    const plain = `<p>${PARAGRAPH_A}</p><p>${PARAGRAPH_B}</p>`;
    expect(stripAnnotationBlocks(plain)).toBe(plain);
    expect(countAnnotationBlocks(plain)).toEqual({ total: 0, open: 0 });
    expect(collectAnnotationBlocks(plain)).toEqual([]);
  });

  it('strip 剥掉批注块本身与块内文字，保留其余正文', () => {
    const html = `<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}<p>${PARAGRAPH_B}</p>`;
    const stripped = stripAnnotationBlocks(html);
    expect(stripped).not.toContain('nm-annotation-block');
    expect(stripped).not.toContain('时间口径需对齐');
    expect(stripped).toContain(PARAGRAPH_A);
    expect(stripped).toContain(PARAGRAPH_B);
    expect(countAnnotationBlocks(stripped)).toEqual({ total: 0, open: 0 });
  });

  it('混合状态计数：total 全量、open 只算未解决', () => {
    const html = `${blockHtml(BLOCK_TEXT_A)}${blockHtml(BLOCK_TEXT_B, KIND, 'resolved')}`;
    expect(countAnnotationBlocks(html)).toEqual({ total: 2, open: 1 });
    expect(collectAnnotationBlocks(html)[1]).toEqual({ kind: KIND, state: 'resolved', text: BLOCK_TEXT_B });
  });

  it('类名兜底也算批注块（只有 class、没有宿主属性）', () => {
    const html = `<div class="nm-annotation-block" data-kind="${KIND}">${BLOCK_TEXT_A}</div>`;
    expect(countAnnotationBlocks(html)).toEqual({ total: 1, open: 1 });
    expect(stripAnnotationBlocks(html).trim()).toBe('');
  });
});

describe('annotationBlock · NodeView（浅灰底 + 左强调条 + 徽标 + 自由文本）', () => {
  it('渲染出宿主结构：类型徽标 input + 两个操作按钮 + 可编辑正文容器', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}`);
    const doms = findAnnotationBlockDoms(editor);
    expect(doms).toHaveLength(1);
    const dom = doms[0]!;

    expect(dom.getAttribute('data-annotation-block')).toBe('true');
    expect(dom.dataset.state).toBe('open');
    // 截图外观：浅灰底 + 左侧细强调条（内联样式，不依赖 Tailwind 生成）
    const styleAttr = dom.getAttribute('style') ?? '';
    expect(styleAttr).toContain('background-color: hsl(var(--paper-inset))');
    expect(styleAttr).toContain('border-left: 3px solid hsl(var(--paper-line-strong))');

    const head = dom.querySelector('[data-annotation-block-head]');
    expect(head).not.toBeNull();
    expect(head?.getAttribute('contenteditable')).toBe('false');

    const kindInput = dom.querySelector<HTMLInputElement>('.nm-annotation-block-kind');
    expect(kindInput?.value).toBe(KIND);

    expect(Array.from(dom.querySelectorAll('button')).map((button) => button.textContent)).toEqual([
      '标记已解决',
      '删除',
    ]);

    const content = dom.querySelector('.nm-annotation-block-content');
    expect(content?.textContent).toBe(BLOCK_TEXT_A);
  });

  it('点「标记已解决」改状态（未解决数减一），点「删除」移除整块 —— 均可撤销', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}`);
    const dom = findAnnotationBlockDoms(editor)[0]!;
    const [toggleButton, deleteButton] = Array.from(dom.querySelectorAll('button'));

    toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 1, open: 0 });
    expect(dom.dataset.state).toBe('resolved');

    editor.commands.undo();
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 1, open: 1 });

    const domAfterUndo = findAnnotationBlockDoms(editor)[0]!;
    Array.from(domAfterUndo.querySelectorAll('button'))[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 0, open: 0 });
    expect(editor.getHTML()).not.toContain(BLOCK_TEXT_A);

    editor.commands.undo();
    expect(annotationBlocksText(editor.getHTML())).toBe(BLOCK_TEXT_A);
    void deleteButton;
  });
});

describe('annotationBlock · 导出「过滤批注块」开关', () => {
  const chapter = {
    title: '第一章 山雨欲来',
    content: `<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}<p>${PARAGRAPH_B}</p>`,
  };

  it('txt：关闭时含批注文字，开启时不含（正文两段都在）', () => {
    const included = exportTXT({ title: '砚舟', chapters: [chapter], format: 'txt' });
    const filtered = exportTXT({ title: '砚舟', chapters: [chapter], format: 'txt', filterAnnotations: true });

    expect(included).toContain('时间口径需对齐');
    expect(filtered).not.toContain('时间口径需对齐');
    expect(filtered).not.toContain('待核');

    for (const output of [included, filtered]) {
      expect(output).toContain(PARAGRAPH_A);
      expect(output).toContain(PARAGRAPH_B);
      expect(output).toContain('第一章 山雨欲来');
    }
  });

  it('markdown：同样两种结果，且标题结构不变', () => {
    const included = exportMarkdown({ title: '砚舟', chapters: [chapter], format: 'markdown' });
    const filtered = exportMarkdown({
      title: '砚舟',
      chapters: [chapter],
      format: 'markdown',
      filterAnnotations: true,
    });

    expect(included).toContain('时间口径需对齐');
    expect(filtered).not.toContain('时间口径需对齐');
    expect(filtered).toContain('# 砚舟');
    expect(filtered).toContain('## 第一章 山雨欲来');
    expect(filtered).toContain(PARAGRAPH_A);
  });
});

describe('annotationBlock · 对外接口（本章未解决数量）', () => {
  it('三通道一致：模块快照 / window 全局键 / CustomEvent', () => {
    const received: unknown[] = [];
    const handler = (event: Event) => received.push((event as CustomEvent).detail);
    window.addEventListener(ANNOTATION_BLOCKS_EVENT, handler);

    try {
      const summary = publishAnnotationBlockSummary({ total: 3, open: 2 }, 'chapter-1');
      expect(summary).toEqual({ chapterId: 'chapter-1', total: 3, open: 2 });
      expect(annotationBlockBridge.getSnapshot()).toBe(summary);
      expect((window as unknown as Record<string, unknown>)[ANNOTATION_BLOCKS_GLOBAL]).toEqual(summary);
      expect(received).toEqual([summary]);

      // 数值不变 → 引用稳定（useSyncExternalStore 依赖这一点，否则会无限重渲染）
      const again = publishAnnotationBlockSummary({ total: 3, open: 2 }, 'chapter-1');
      expect(again).toBe(summary);

      // 数值变化 → 换新引用并再次派发
      const changed = publishAnnotationBlockSummary({ total: 3, open: 1 }, 'chapter-1');
      expect(changed).not.toBe(summary);
      // 事件是「发布即派发」：读数不变时派发的仍是**同一个对象引用**，
      // 消费方直接 setState 会因为它不变而跳过重渲染。
      expect(received).toEqual([summary, summary, changed]);
      expect(received[1]).toBe(summary);
    } finally {
      window.removeEventListener(ANNOTATION_BLOCKS_EVENT, handler);
    }
  });

  it('reset 后归零，订阅者收到一次通知', () => {
    const seen: number[] = [];
    const unsubscribe = annotationBlockBridge.subscribe((summary) => seen.push(summary.open));
    try {
      publishAnnotationBlockSummary({ total: 4, open: 4 }, 'chapter-9');
      resetAnnotationBlockSummary();
      expect(seen).toEqual([4, 0]);
      expect(annotationBlockBridge.getSnapshot()).toEqual({ chapterId: null, total: 0, open: 0 });
    } finally {
      unsubscribe();
    }
  });
});

describe('annotationBlock · 章节 content 持久化往返（切章 / 刷新路径）', () => {
  it('getHTML()（= PUT /api/chapters/:id 的 body）经 ensureHtmlContent 回灌后逐字恢复', () => {
    const editor = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}<p>${PARAGRAPH_B}</p>`);
    // 编辑器 onUpdate 里落盘的就是 getHTML()；这里就是发给后端的 content
    const saved = editor.getHTML();
    expect(saved).toContain('data-annotation-block="true"');
    expect(saved).toContain(BLOCK_TEXT_A);

    // 切走：EditorPage 的章节切换 effect 走 setContent(injectContent, false)
    editor.commands.setContent('<p>别的章节正文。</p>', false);
    expect(countAnnotationBlocks(editor.getHTML())).toEqual({ total: 0, open: 0 });

    // 切回 / 刷新后重新进入：读缓存或接口拿到的 content 经 ensureHtmlContent 再 setContent
    const restored = ensureHtmlContent(saved);
    expect(restored).toBe(saved); // 已是 HTML，不再二次包装
    editor.commands.setContent(restored, false);
    expect(editor.getHTML()).toBe(saved); // 逐字恢复，无属性丢失 / 无标签漂移
    expect(annotationBlocksText(editor.getHTML())).toBe(BLOCK_TEXT_A);
    expect(editor.getHTML()).toContain(PARAGRAPH_B);
  });

  it('批注块文字与段落同规则计入 htmlToText 字数（已知口径）', () => {
    const withBlock = createEditor(`<p>${PARAGRAPH_A}</p>${blockHtml(BLOCK_TEXT_A)}`).getHTML();
    const withoutBlock = createEditor(`<p>${PARAGRAPH_A}</p>`).getHTML();
    // htmlToText 把 `</div>` 也当一个换行（entityDetector.ts:17），
    // 故批注块对字数的贡献 = 块内文字长度 + 1：与段落同规则，批注文字计入正文字数（已知项，已在结果中说明）。
    expect(htmlToText(withBlock).length).toBe(
      htmlToText(withoutBlock).length + BLOCK_TEXT_A.length + 1,
    );
    expect(withBlock).toContain(BLOCK_TEXT_A);
  });
});
