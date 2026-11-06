import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// 主角 / 女主角名字高亮：用 ProseMirror Decoration 自动给文中出现的
// 主角（role=protagonist）和女主角（role=femaleLead）名字加上蓝色文字样式，
// 点击后派发事件打开角色面板。

export interface LeadCharacterHighlightOptions {
  /** 主角和女主角的名字列表（含别名），变化时重建 decoration */
  names: string[];
}

const pluginKey = new PluginKey<DecorationSet>('leadCharacterHighlight');

export const LeadCharacterHighlight = Extension.create<LeadCharacterHighlightOptions>({
  name: 'leadCharacterHighlight',

  addOptions() {
    return {
      names: [],
    };
  },

  addProseMirrorPlugins() {
    /**
     * ★ 2026-11-05 修：这里**不能**把 names 算成一个常量再闭包引用。
     *
     *   名单是**运行期**才有的：`useEditorInstance` 在角色数据变化后执行
     *   `ext.options.names = leadNames` 并派发一个带 `leadCharacterHighlightUpdate`
     *   meta 的空 transaction，指望插件重建 decoration。
     *   而扩展是用 `configure({ names: [] })` 创建的 —— 闭包捕获的是**那一刻**的空数组，
     *   改 `options` 对它无效 ⇒ **高亮从未生效过**
     *   （实测：往正文注入「陈默走进雨里…」（陈默 = 主角），`.lead-character-name` 为 0）。
     *
     *   改为捕获 **options 对象本身**，每次重建时现读 `options.names` ——
     *   `ext.options` 与 `this.options` 是同一个对象，所以运行期的赋值能被读到。
     */
    const options = this.options;
    const currentNames = () =>
      (options.names ?? []).filter(Boolean).sort((a, b) => b.length - a.length);

    return [
      new Plugin<DecorationSet>({
        key: pluginKey,
        state: {
          init(_, { doc }) {
            return buildDecorations(doc, currentNames());
          },
          apply(tr, old) {
            if (tr.docChanged || tr.getMeta('leadCharacterHighlightUpdate')) {
              return buildDecorations(tr.doc, currentNames());
            }
            return old;
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
          handleDOMEvents: {
            click: (_view, event) => {
              const target = event.target as HTMLElement;
              if (!target) return false;
              const name = target.getAttribute('data-lead-name');
              if (!name) return false;
              event.preventDefault();
              window.dispatchEvent(new CustomEvent('nm:open-panel', {
                detail: { key: 'characters' },
              }));
              return true;
            },
          },
        },
      }),
    ];
  },
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把名字表编译成一条「最长优先」的交替正则。
 *
 * ★ 2026-11-06 重写（原名识别优化）。旧实现是**按名字逐个 indexOf**，有两个真缺陷：
 *
 *   ① **会重叠**。名字之间有前缀关系时（如「沈知意」与「沈知」），两个名字各自
 *      在同一个位置命中 ⇒ 同一段字上叠两个装饰，点击时命中哪个取决于 DOM 顺序。
 *   ② **产出无序**。旧实现按「名字」分组 push，同一段文字的装饰可能来自不同名字、
 *      from 忽大忽小；而 ProseMirror 的 `DecorationSet.create` **要求装饰按位置升序**，
 *      乱序会渲染错位。实测：文本「沈知意站在门口，沈知没有回头。」产出
 *      [0-3, 0-2, 8-10, 1-3] —— 既有重叠又没排序。
 *
 * 新做法：一次 `exec` 扫描完。
 *   · 交替分支**长的排前面** ⇒ 同一位置优先命中最长的那个名字，短名不再截断长名；
 *   · 正则匹配后 `lastIndex` 直接跨过整段 ⇒ **天然不重叠**；
 *   · 按文档顺序扫节点、按 index 递增产出 ⇒ **天然有序**；
 *   · 复杂度从 O(名字数 × 文本长) 降到 O(文本长)。
 *
 * ⚠️ 用 `i` 标志：中文无影响，英文艺名（如 "alice"）大小写都能命中。
 */
function compileMatcher(names: string[]): RegExp | null {
  const cleaned = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length);
  if (cleaned.length === 0) return null;
  return new RegExp(cleaned.map(escapeRegExp).join('|'), 'gi');
}

/** 名字表 → 正则的缓存（名单没变就不重编译；每次重建 decoration 都会调用） */
let matcherCacheKey = '';
let matcherCache: RegExp | null = null;
function matcherFor(names: string[]): RegExp | null {
  const key = names.join('\u0000');
  if (key === matcherCacheKey) return matcherCache;
  matcherCacheKey = key;
  matcherCache = compileMatcher(names);
  return matcherCache;
}

function buildDecorations(
  doc: { descendants: (cb: (node: { isText: boolean; text?: string }, pos: number) => void) => void },
  names: string[],
): DecorationSet {
  const re = matcherFor(names);
  if (!re) return DecorationSet.empty;
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    re.lastIndex = 0; // 每个文本节点从头扫（正则是带 g 的状态机）
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // 防御：零宽匹配不会推进 lastIndex，会死循环
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      const start = pos + m.index;
      const end = start + m[0].length;
      decorations.push(
        Decoration.inline(start, end, {
          class: 'lead-character-name',
          'data-lead-name': m[0],
          style: 'color: hsl(217, 71%, 52%); cursor: pointer;',
        }),
      );
    }
  });

  return DecorationSet.create(doc as Parameters<typeof DecorationSet.create>[0], decorations);
}
