// ============================================================
// OpenAI Agents SDK 工具适配层
//
// 将现有实体工具注册表转换为 SDK 的 FunctionTool 格式，
// 并新增 web_search、read_chapter、write_chapter、list_chapters 工具。
//
// 注意：
//   - 现有实体工具使用 JSON Schema 定义参数 → strict: false
//   - 新增工具使用 Zod 定义参数 → strict: true（SDK 要求 Zod 必须用 strict）
//   - 两者混合返回为 Tool[]，供 Agent 构造时传入
// ============================================================

import { tool, type FunctionTool, type Tool } from '@openai/agents';
import { z } from 'zod';
import {
  ensureToolsRegistered,
  getAllToolDefinitions,
  executeTool,
  ENTITY_TOOL_NAMES,
  getPluginToolNames,
} from '../../tools/index.js';
import type { ToolHandlerResult } from '../../tools/registry.js';
import { listChapters, updateChapter } from '../../../services/chapter-service.js';

// ---- Agent 运行时上下文 ----

/** Agent 运行时上下文：携带项目隔离所需的 projectId 和用户信息 */
export interface NovelAgentContext {
  projectId: string;
  userId: string;
  /** 章节写入能力默认关闭（安全模式）；恢复需显式传 true 并配合服务端审批 */
  allowWriteChapter?: boolean;
}

// ---- 从 RunContext 提取 projectId 的辅助函数 ----

/**
 * 从 SDK 的 RunContext 中提取 projectId。
 *
 * SDK 的 tool execute 回调签名是 (input, context?)，其中 context 是 RunContext<TContext>。
 * RunContext 包装了我们的 NovelAgentContext，通过 .context 属性访问。
 */
function getProjectId(context: unknown): string {
  const ctx = context as { context?: NovelAgentContext };
  return ctx?.context?.projectId ?? '';
}

/** 读取 Agent 上下文（用于写入能力门禁等） */
function getAgentContext(context: unknown): NovelAgentContext | undefined {
  return (context as { context?: NovelAgentContext })?.context;
}

// ---- 现有实体工具适配 ----

/**
 * 将现有实体工具注册表转换为 OpenAI Agents SDK 的 FunctionTool 格式。
 *
 * 现有工具使用 JSON Schema 定义参数，通过 strict:false 模式传入 SDK；
 * execute 回调中将 input 转为 Record<string,unknown> 后调用 executeTool，
 * 返回 JSON.stringify(result) —— result 是 ToolHandlerResult 对象，
 * 其中 entity 字段供前端展示。
 */
export function wrapExistingTools(allowedNames?: ReadonlySet<string>): Tool<NovelAgentContext>[] {
  ensureToolsRegistered();
  const definitions = getAllToolDefinitions().filter((definition) =>
    allowedNames ? allowedNames.has(definition.function.name) : true,
  );

  return definitions.map((definition) => {
    const name = definition.function.name;
    // ★ JSON Schema 参数 + strict:false；cast as any 绕过 SDK 对 JsonObjectSchemaNonStrict 的严格类型要求
    return tool({
      name,
      description: definition.function.description ?? '',
      parameters: definition.function.parameters as any,
      strict: false,
      execute: async (input: any, context: any) => {
        const args: Record<string, unknown> =
          typeof input === 'string'
            ? (JSON.parse(input) as Record<string, unknown>)
            : (input as Record<string, unknown>);
        const agentCtx = getAgentContext(context);
        const projectId = agentCtx?.projectId ?? '';
        const result: ToolHandlerResult = await executeTool(name, args, {
          projectId,
          user: { id: agentCtx?.userId ?? '' },
        });
        return JSON.stringify(result);
      },
    } as any) as FunctionTool<NovelAgentContext>;
  });
}

// ---- 新增工具 ----

/** web_search：使用 DuckDuckGo Instant Answer API 进行简单互联网搜索 */
const webSearchTool = tool({
  name: 'web_search',
  description: '搜索互联网获取信息。用于查证写作素材、历史背景、科学知识、地名考证等。返回搜索结果摘要。',
  parameters: z.object({
    query: z.string().describe('搜索关键词'),
  }),
  execute: async (input: any) => {
    const query = (input as { query: string }).query;
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = (await resp.json()) as Record<string, unknown>;
      const abstract = (data.AbstractText as string) || '';
      const heading = (data.Heading as string) || '';
      const related = (data.RelatedTopics as Array<Record<string, unknown>> | undefined) ?? [];
      const relatedTexts = related
        .filter((t) => typeof t.Text === 'string')
        .slice(0, 5)
        .map((t) => `- ${t.Text}`)
        .join('\n');
      const result = [heading, abstract, relatedTexts].filter(Boolean).join('\n\n');
      return result || `未找到关于「${query}」的相关信息。建议换个关键词搜索。`;
    } catch (e) {
      return `搜索失败：${e instanceof Error ? e.message : String(e)}`;
    }
  },
} as any) as FunctionTool<NovelAgentContext>;

/** read_chapter：读取项目中某一章的完整内容 */
const readChapterTool = tool({
  name: 'read_chapter',
  description:
    '读取项目中某一章的完整内容。通过 chapter_title（章节标题）或 chapter_order（章节序号，从1开始）指定目标章节。',
  parameters: z.object({
    chapter_title: z.string().nullable().describe('章节标题（精确匹配）'),
    chapter_order: z.number().nullable().describe('章节序号（从1开始）'),
  }),
  execute: async (input: any, context: any) => {
    const args = input as { chapter_title?: string | null; chapter_order?: number | null };
    const projectId = getProjectId(context);
    const chapters = await listChapters(projectId);
    let target = chapters.find((c) => c.title === args.chapter_title);
    if (!target && args.chapter_order != null) {
      target = chapters.find((c) => c.order === args.chapter_order);
    }
    if (!target && args.chapter_title) {
      target = chapters.find(
        (c) => c.title.includes(args.chapter_title!) || args.chapter_title!.includes(c.title),
      );
    }
    if (!target) {
      return `未找到章节「${args.chapter_title || `第${args.chapter_order}章`}」`;
    }
    const content = target.content || '';
    return `【${target.title}】（第${target.order}章，${content.length}字）\n\n${content}`;
  },
} as any) as FunctionTool<NovelAgentContext>;

/** write_chapter：向某一章写入或追加内容 */
const writeChapterTool = tool({
  name: 'write_chapter',
  description:
    '向某一章写入或追加内容。通过 chapter_title 或 chapter_order 指定目标章节。merge=true 时追加到已有内容末尾，false 时覆盖。',
  parameters: z.object({
    chapter_title: z.string().nullable(),
    chapter_order: z.number().nullable(),
    content: z.string().describe('要写入的内容'),
    merge: z.boolean().nullable().describe('是否追加到已有内容末尾（false=覆盖，默认false）'),
  }),
  execute: async (input: any, context: any) => {
    const args = input as {
      chapter_title?: string | null;
      chapter_order?: number | null;
      content: string;
      merge?: boolean | null;
    };
    // ★ handler 层二次拒绝：即使工具被误加回工具集合，
    //   未显式开启 allowWriteChapter 的会话也不允许写章节。
    if (getAgentContext(context)?.allowWriteChapter !== true) {
      return '错误：章节写入已在当前会话被安全策略禁用（Agent 只读模式）。请手动编辑章节，或使用正文同步写入。';
    }
    const projectId = getProjectId(context);
    const chapters = await listChapters(projectId);
    let target = chapters.find((c) => c.title === args.chapter_title);
    if (!target && args.chapter_order != null) {
      target = chapters.find((c) => c.order === args.chapter_order);
    }
    if (!target && args.chapter_title) {
      target = chapters.find(
        (c) => c.title.includes(args.chapter_title!) || args.chapter_title!.includes(c.title),
      );
    }
    if (!target) {
      return `错误：未找到章节「${args.chapter_title || `第${args.chapter_order}章`}」`;
    }
    const merge = args.merge === true;
    const newContent =
      merge && target.content ? `${target.content}\n\n${args.content}` : args.content;
    await updateChapter(target.id, { content: newContent, updatedAt: Date.now() }, projectId);
    return `已${merge ? '追加' : '写入'}内容到「${target.title}」（当前 ${newContent.length} 字）`;
  },
} as any) as FunctionTool<NovelAgentContext>;

/** list_chapters：列出当前项目的所有章节（不含正文） */
const listChaptersTool = tool({
  name: 'list_chapters',
  description: '列出当前项目的所有章节（标题、序号、字数），不返回正文内容。用于了解项目结构。',
  parameters: z.object({}),
  execute: async (_input: any, context: any) => {
    const projectId = getProjectId(context);
    const chapters = await listChapters(projectId);
    const sorted = [...chapters].sort((a, b) => a.order - b.order);
    const lines = sorted.map((c) => `${c.order}. ${c.title}（${(c.content || '').length}字）`);
    return `共 ${sorted.length} 章：\n${lines.join('\n')}`;
  },
} as any) as FunctionTool<NovelAgentContext>;

// ---- 统一导出 ----

/**
 * 获取 SDK 工具集合（按 allowlist 生成，不再无条件暴露全部注册工具）。
 *
 * 默认集合 = 内置实体工具（create/update，无 delete）+ web_search + read_chapter + list_chapters。
 * - write_chapter 默认排除（安全模式：无服务端审批前不暴露章节写入）；
 *   仅当 opts.allowWriteChapter === true 时加入，且 handler 层还有二次拒绝兜底。
 * - create_plugin / list_local_plugins / 插件动态注册的工具一律不在默认集合中
 *   （等同服务端代码执行的能力不进入通用 Agent 工具面）。
 */
export function getAllSdkTools(opts: { allowWriteChapter?: boolean } = {}): Tool<NovelAgentContext>[] {
  // 内置实体工具 + 插件注册的工具（宿主 aiService.tools.register 时标记）
  const allowed = new Set<string>([...ENTITY_TOOL_NAMES, ...getPluginToolNames()]);
  const tools: Tool<NovelAgentContext>[] = [
    ...wrapExistingTools(allowed),
    webSearchTool,
    readChapterTool,
    listChaptersTool,
  ];
  if (opts.allowWriteChapter === true) {
    tools.push(writeChapterTool);
  }
  return tools;
}
