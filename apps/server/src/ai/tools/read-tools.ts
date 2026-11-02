// ============================================================
// 只读工具 —— AI 对话「查项目内资料」的能力
// ============================================================
//
// 为什么单独一个文件：现有 `character-tools.ts` / `outline-tools.ts` 等是
// **写**工具（create/update），本文件全是**读**工具。读写分文件后，
// 白名单可以直接按文件划分（`READ_TOOL_NAMES` / `ENTITY_TOOL_NAMES`），
// 也让「AI 能读什么」在一处看全。
//
// ## 安全边界（重要）
//   1. **只读**：本文件所有 handler 只调 service 的 `list*` / `get*`，
//      不写任何表。想给 AI 写能力必须另立工具并走审批，不走这里。
//   2. **项目隔离**：所有查询强制 `ctx.projectId`，与 ToolContext 契约一致
//      （projectId 已由宿主在 `/api/ai/chat-stream` 里过归属校验）。
//   3. **不碰文件系统**：本文件**没有**任何 `fs` 调用。AI 读的是数据库里的
//      项目资料（参考书 / 笔记 / 章节 / 设定），不是本机任意路径的文件。
//      这是刻意的：读磁盘需要路径白名单 + 大小限制 + 敏感文件排除，
//      那是另一件事，不该混进「读资料」里悄悄放开。
//
// ## 输出纪律
//   每个 handler 都必须**有上限**（条数 + 字数），否则一本 20 万字的参考书
//   会一次把上下文塞爆，表现为「AI 突然答非所问」而不是报错。上限见各常量。

import { registerTools, type ToolHandlerResult, type ToolContext } from './registry.js';
import {
  listCharacters,
  getCharacter,
} from '../../services/character-service.js';
import { listLocations } from '../../services/location-service.js';
import { listItems } from '../../services/item-service.js';
import { listForeshadows } from '../../services/foreshadow-service.js';
import { listEvents } from '../../services/event-service.js';
import { listOutlineNodes } from '../../services/outline-service.js';
import { listReferenceBooks, getReferenceBook } from '../../services/reference-service.js';
import { listNotes } from '../../services/note-service.js';
import { listChapters, getChapter } from '../../services/chapter-service.js';

// ---- 输出上限 ----

/** 列表类工具默认返回条数上限（再多 AI 也用不上，只会挤掉别的上下文） */
const LIST_LIMIT = 60;
/** 单次返回的总字数上限 —— 超过即截断并明确标注 */
const MAX_RESULT_CHARS = 6000;
/** 单个条目（如一本参考书的一章）的截断长度 */
const MAX_ITEM_CHARS = 2000;

/** 统一截断：超长时明确标注，不让 AI 误以为拿到的是全文 */
function clip(text: string, limit = MAX_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…（已截断，原文共 ${text.length} 字，仅返回前 ${limit} 字）`;
}

function oneLine(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** 把「有值才输出」的字段拼成一行，避免大量空字段噪声 */
function fields(pairs: Array<[string, unknown]>): string {
  return pairs
    .map(([k, v]) => {
      const s = oneLine(v);
      return s ? `${k}=${s}` : '';
    })
    .filter(Boolean)
    .join('；');
}

/** 统一处理空结果 —— 空列表必须说清「查过了、确实是空」，而不是返回空字符串让 AI 自己编 */
function emptyResult(what: string): ToolHandlerResult {
  return { success: true, result: `本项目暂无${what}。` };
}

// ---- 资料总览 ----

const listProjectAssetsTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_project_assets',
      description:
        '列出当前项目的全部资料概况（章节数、角色数、地点数、物品数、伏笔数、事件数、大纲节点数、参考书数、笔记数），每类附带名称清单。'
        + '当你不确定项目里有什么、该查哪一类时，先调这个。不返回正文。',
      parameters: {
        type: 'object',
        properties: {
          /** 每类最多列几个名字 */
          previewCount: { type: 'number', description: '每类最多列出几个名称（默认 12，最多 40）' },
        },
      },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const preview = Math.max(1, Math.min(40, Math.floor(Number(args.previewCount)) || 12));
    const [chapters, characters, locations, items, foreshadows, events, outlines, refs, notes] =
      await Promise.all([
        listChapters(ctx.projectId),
        listCharacters(ctx.projectId),
        listLocations(ctx.projectId),
        listItems(ctx.projectId),
        listForeshadows(ctx.projectId),
        listEvents(ctx.projectId),
        listOutlineNodes(ctx.projectId),
        listReferenceBooks(ctx.projectId),
        listNotes(ctx.projectId),
      ]);

    const names = (arr: unknown[], pick: (x: any) => string) =>
      arr.slice(0, preview).map((x) => pick(x)).filter(Boolean).join('、')
      + (arr.length > preview ? `…（共 ${arr.length}）` : '');

    const lines = [
      `【项目资料概况】`,
      `章节 ${chapters.length} 章${chapters.length ? `：${names([...chapters].sort((a, b) => a.order - b.order), (c) => `${c.order}.${c.title}`)}` : ''}`,
      `角色 ${characters.length} 位${characters.length ? `：${names(characters, (c) => c.name)}` : ''}`,
      `地点 ${locations.length} 处${locations.length ? `：${names(locations, (l) => l.name)}` : ''}`,
      `物品 ${items.length} 件${items.length ? `：${names(items, (i) => i.name)}` : ''}`,
      `伏笔 ${foreshadows.length} 条${foreshadows.length ? `：${names(foreshadows, (f) => oneLine(f.content ?? f.description ?? '').slice(0, 20))}` : ''}`,
      `事件 ${events.length} 个${events.length ? `：${names(events, (e) => oneLine(e.title ?? e.summary ?? '').slice(0, 20))}` : ''}`,
      `大纲节点 ${outlines.length} 个`,
      `参考书 ${refs.length} 本${refs.length ? `：${names(refs, (r) => `《${r.title}》${r.chapters?.length ? `(${r.chapters.length}节)` : ''}`)}` : ''}`,
      `笔记 ${notes.length} 条${notes.length ? `：${names(notes, (n) => oneLine(n.title ?? '').slice(0, 20))}` : ''}`,
      '',
      `提示：要读具体内容，分别用 read_chapter / list_characters / read_reference_book / list_notes 等工具。`,
    ];
    return { success: true, result: clip(lines.join('\n')) };
  },
};

// ---- 章节 ----

const listChaptersTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_chapters',
      description: '列出当前项目的全部章节（序号、标题、字数、状态），不含正文。用于了解全书结构与进度。',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const chapters = await listChapters(ctx.projectId);
    if (chapters.length === 0) return emptyResult('章节');
    const sorted = [...chapters].sort((a, b) => a.order - b.order);
    const lines = sorted
      .slice(0, LIST_LIMIT)
      .map((c) => `${c.order}. ${c.title}（${c.wordCount ?? 0} 字${c.status ? `，${c.status}` : ''}）`);
    return {
      success: true,
      result: clip(`共 ${sorted.length} 章：\n${lines.join('\n')}`),
    };
  },
};

const readChapterTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'read_chapter',
      description:
        '读取当前项目中某一章的正文。用 chapterOrder（章节序号，从 1 开始）或 chapterTitle（标题）指定目标，两者都可用，序号优先。'
        + '返回纯文本（已去掉 HTML 标签）。',
      parameters: {
        type: 'object',
        properties: {
          chapterOrder: { type: 'number', description: '章节序号（从 1 开始）' },
          chapterTitle: { type: 'string', description: '章节标题（可模糊匹配）' },
        },
      },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const order = args.chapterOrder === undefined || args.chapterOrder === null
      ? null : Math.floor(Number(args.chapterOrder));
    const title = typeof args.chapterTitle === 'string' ? args.chapterTitle.trim() : '';

    const chapters = await listChapters(ctx.projectId);
    if (chapters.length === 0) return emptyResult('章节');

    let target = order !== null ? chapters.find((c) => c.order === order) : undefined;
    if (!target && title) target = chapters.find((c) => c.title === title);
    if (!target && title) {
      target = chapters.find((c) => c.title.includes(title) || title.includes(c.title));
    }
    if (!target) {
      const want = order !== null ? `第 ${order} 章` : `「${title}」`;
      return { success: false, result: `未找到${want}。可用 list_chapters 先看有哪些章。` };
    }

    const text = htmlToText(target.content ?? '');
    const body = text.trim() ? text : '（本章尚无正文）';
    return {
      success: true,
      result: clip(`【第${target.order}章 ${target.title}】（${target.wordCount ?? 0} 字）\n\n${body}`, MAX_ITEM_CHARS * 3),
    };
  },
};

/**
 * HTML → 纯文本（服务端侧最小实现）。
 *
 * 为什么不复用前端 `data-core` 的 `htmlToText`：那是**前端包**，
 * server 不依赖它（会反向耦合）。这里只需要「去标签 + 段落换行」，
 * 十来行即可，且必须保留 `<br>` / `</p>` 的换行语义 —— 否则章节会连成一坨。
 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- 角色 / 地点 / 物品 / 伏笔 / 事件 / 大纲 ----

const listCharactersTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_characters',
      description:
        '列出当前项目的角色设定（姓名、定位、欲望、恐惧、信念、性格、说话风格、背景）。'
        + '这是查「人物是谁、什么性格、想什么」的首选工具。',
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['protagonist', 'femaleLead', 'supporting', 'minor'],
            description: '只看某一类角色（可选）',
          },
        },
      },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    let characters = await listCharacters(ctx.projectId);
    if (characters.length === 0) return emptyResult('角色设定');
    const role = typeof args.role === 'string' ? args.role : '';
    if (role) characters = characters.filter((c) => c.role === role);
    if (characters.length === 0) return { success: true, result: `本项目暂无定位为 ${role} 的角色。` };

    const ROLE_CN: Record<string, string> = {
      protagonist: '主角', femaleLead: '女主', supporting: '配角', minor: '龙套',
    };
    const lines = characters.slice(0, LIST_LIMIT).map((c, i) => {
      const head = `${i + 1}. ${c.name}${c.role ? `（${ROLE_CN[c.role] ?? c.role}）` : ''}`;
      const body = fields([
        ['别名', (c.aliases ?? []).join('/')],
        ['欲望', c.desire],
        ['恐惧', c.fear],
        ['信念', c.belief],
        ['弱点', c.weakness],
        ['外貌', c.appearance],
        ['性格', c.personality],
        ['说话风格', c.speechStyle],
        ['背景', c.backstory],
      ]);
      return body ? `${head}\n   ${body}` : head;
    });
    return { success: true, result: clip(`【角色设定】共 ${characters.length} 位\n${lines.join('\n')}`) };
  },
};

const listLocationsTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_locations',
      description: '列出当前项目的地点设定（名称、描述、类型、所属区域）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const locations = await listLocations(ctx.projectId);
    if (locations.length === 0) return emptyResult('地点设定');
    const lines = locations.slice(0, LIST_LIMIT).map((l, i) => {
      const body = fields([['类型', (l as any).type], ['描述', l.description], ['区域', (l as any).region]]);
      return `${i + 1}. ${l.name}${body ? `\n   ${body}` : ''}`;
    });
    return { success: true, result: clip(`【地点设定】共 ${locations.length} 处\n${lines.join('\n')}`) };
  },
};

const listItemsTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_items',
      description: '列出当前项目的物品设定（名称、描述、类型、归属）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const items = await listItems(ctx.projectId);
    if (items.length === 0) return emptyResult('物品设定');
    const lines = items.slice(0, LIST_LIMIT).map((it, i) => {
      const body = fields([['类型', (it as any).type], ['描述', it.description], ['归属', (it as any).owner]]);
      return `${i + 1}. ${it.name}${body ? `\n   ${body}` : ''}`;
    });
    return { success: true, result: clip(`【物品设定】共 ${items.length} 件\n${lines.join('\n')}`) };
  },
};

const listForeshadowsTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_foreshadows',
      description:
        '列出当前项目的伏笔（内容、状态：已播种/已暗示/已回收、埋设章节、回收章节）。'
        + '写新章节前查这个，避免提前回收或忘了回收。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['planted', 'hinted', 'recovered'], description: '只看某个状态（可选）' },
        },
      },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    let list = await listForeshadows(ctx.projectId);
    if (list.length === 0) return emptyResult('伏笔');
    const status = typeof args.status === 'string' ? args.status : '';
    if (status) list = list.filter((f) => (f as any).status === status);
    if (list.length === 0) return { success: true, result: `本项目暂无状态为 ${status} 的伏笔。` };

    const ST_CN: Record<string, string> = { planted: '已播种', hinted: '已暗示', recovered: '已回收' };
    const lines = list.slice(0, LIST_LIMIT).map((f, i) => {
      const anyF = f as any;
      const body = fields([
        ['状态', ST_CN[anyF.status] ?? anyF.status],
        ['埋设', anyF.plantedChapter ? `第${anyF.plantedChapter}章` : ''],
        ['回收', anyF.recoveredChapter ? `第${anyF.recoveredChapter}章` : ''],
        ['类型', anyF.type],
      ]);
      const text = oneLine(anyF.content ?? anyF.description ?? '');
      return `${i + 1}. ${text}${body ? `\n   ${body}` : ''}`;
    });
    return { success: true, result: clip(`【伏笔】共 ${list.length} 条\n${lines.join('\n')}`) };
  },
};

const listEventsTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_events',
      description: '列出当前项目的剧情事件（标题、摘要、发生章节）。用于回顾「已经发生了什么」。',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const events = await listEvents(ctx.projectId);
    if (events.length === 0) return emptyResult('剧情事件');
    const lines = events.slice(0, LIST_LIMIT).map((e, i) => {
      const anyE = e as any;
      const body = fields([['摘要', anyE.summary], ['章节', anyE.chapterOrder ? `第${anyE.chapterOrder}章` : '']]);
      return `${i + 1}. ${oneLine(anyE.title) || '(无标题)'}${body ? `\n   ${body}` : ''}`;
    });
    return { success: true, result: clip(`【剧情事件】共 ${events.length} 个\n${lines.join('\n')}`) };
  },
};

const listOutlineTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_outline',
      description: '列出当前项目的大纲节点（层级、标题、内容摘要）。用于确认全书走向与当前章节该写什么。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回几个节点（默认 40，最多 100）' },
        },
      },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const nodes = await listOutlineNodes(ctx.projectId);
    if (nodes.length === 0) return emptyResult('大纲');
    const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit)) || 40));
    const lines = nodes.slice(0, limit).map((n, i) => {
      const anyN = n as any;
      const body = oneLine(anyN.content ?? anyN.summary ?? '').slice(0, 200);
      const indent = '  '.repeat(Math.max(0, Math.min(3, (anyN.level ?? 0))));
      return `${i + 1}. ${indent}${oneLine(anyN.title) || '(无标题)'}${body ? `：${body}` : ''}`;
    });
    return {
      success: true,
      result: clip(`【大纲】共 ${nodes.length} 个节点${nodes.length > limit ? `（仅列前 ${limit} 个）` : ''}\n${lines.join('\n')}`),
    };
  },
};

// ---- 参考书 / 笔记 ----

const listReferenceBooksTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_reference_books',
      description: '列出当前项目的参考书（书名、作者、分节数）。要看具体内容用 read_reference_book。',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const books = await listReferenceBooks(ctx.projectId);
    if (books.length === 0) return emptyResult('参考书');
    const lines = books.slice(0, LIST_LIMIT).map((b, i) => {
      const sections = Array.isArray(b.chapters) ? b.chapters.length : 0;
      return `${i + 1}. 《${b.title}》${b.author ? ` · ${b.author}` : ''}${sections ? `（${sections} 节）` : `（${(b.content ?? '').length} 字）`}`;
    });
    return { success: true, result: clip(`【参考书】共 ${books.length} 本\n${lines.join('\n')}`) };
  },
};

const readReferenceBookTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'read_reference_book',
      description:
        '读取一本参考书的内容。可用 bookTitle（书名，可模糊匹配）或 bookId 指定。'
        + '可用 sectionIndex（第几节，从 0 开始）只读某一节；不给则读开头部分。'
        + '单次返回有字数上限，超长会明确标注截断。',
      parameters: {
        type: 'object',
        properties: {
          bookTitle: { type: 'string', description: '书名（可模糊匹配）' },
          bookId: { type: 'string', description: '参考书 id（精确）' },
          sectionIndex: { type: 'number', description: '第几节（从 0 开始，可选）' },
        },
      },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const bookId = typeof args.bookId === 'string' ? args.bookId.trim() : '';
    const bookTitle = typeof args.bookTitle === 'string' ? args.bookTitle.trim() : '';
    const sectionIndex = args.sectionIndex === undefined || args.sectionIndex === null
      ? null : Math.floor(Number(args.sectionIndex));

    let book = bookId ? await getReferenceBook(bookId, ctx.projectId) : null;
    if (!book) {
      const books = await listReferenceBooks(ctx.projectId);
      if (books.length === 0) return emptyResult('参考书');
      if (bookTitle) {
        book = books.find((b) => b.title === bookTitle)
          ?? books.find((b) => b.title.includes(bookTitle) || bookTitle.includes(b.title))
          ?? null;
      }
      if (!book) {
        return {
          success: false,
          result: `未找到参考书${bookTitle ? `「${bookTitle}」` : ''}。可用 list_reference_books 看有哪些。`,
        };
      }
    }

    const sections = Array.isArray(book.chapters) ? book.chapters : [];
    if (sectionIndex !== null && sections.length > 0) {
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return {
          success: false,
          result: `《${book.title}》只有 ${sections.length} 节（下标 0~${sections.length - 1}），sectionIndex=${sectionIndex} 越界。`,
        };
      }
      const sec = sections[sectionIndex];
      return {
        success: true,
        result: clip(`《${book.title}》第 ${sectionIndex} 节【${sec.title}】\n\n${sec.content}`, MAX_ITEM_CHARS),
      };
    }

    // 未指定节：分节书按节拼接（每节截断），否则读正文开头
    if (sections.length > 0) {
      const parts = sections.slice(0, 5).map((s, i) => `【${i}. ${s.title}】\n${(s.content ?? '').slice(0, MAX_ITEM_CHARS)}`);
      return {
        success: true,
        result: clip(
          `《${book.title}》共 ${sections.length} 节，下面是前 ${Math.min(5, sections.length)} 节（要看其余节请传 sectionIndex）：\n\n${parts.join('\n\n')}`,
        ),
      };
    }

    const body = (book.content ?? '').trim();
    if (!body) return { success: true, result: `《${book.title}》没有内容。` };
    return { success: true, result: clip(`《${book.title}》\n\n${body}`, MAX_ITEM_CHARS * 2) };
  },
};

const listNotesTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'list_notes',
      description: '列出当前项目的笔记（标题、内容摘要）。作者的随手记录、灵感、待办常在这里。',
      parameters: { type: 'object', properties: {} },
    },
  },
  async handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const notes = await listNotes(ctx.projectId);
    if (notes.length === 0) return emptyResult('笔记');
    const lines = notes.slice(0, LIST_LIMIT).map((n, i) => {
      const anyN = n as any;
      const body = oneLine(anyN.content).slice(0, 200);
      return `${i + 1}. ${oneLine(anyN.title) || '(无标题)'}${body ? `：${body}` : ''}`;
    });
    return { success: true, result: clip(`【笔记】共 ${notes.length} 条\n${lines.join('\n')}`) };
  },
};

// ---- 注册 ----

registerTools([
  listProjectAssetsTool,
  listChaptersTool,
  readChapterTool,
  listCharactersTool,
  listLocationsTool,
  listItemsTool,
  listForeshadowsTool,
  listEventsTool,
  listOutlineTool,
  listReferenceBooksTool,
  readReferenceBookTool,
  listNotesTool,
]);
