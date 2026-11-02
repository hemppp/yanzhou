// ============================================================
// AI 工具统一入口
//
// 导入此文件即触发所有工具注册到 registry。
// 使用方只需导入 ensureToolsRegistered() 确保注册完成。
// ============================================================

import { getAllToolDefinitions, registerTool } from './registry.js';

// 导入各模块工具文件（副作用：触发注册）
import './character-tools.js';
import './foreshadow-tools.js';
import './location-tools.js';
import './item-tools.js';
import './outline-tools.js';
// ★ 只读工具（AI 对话「查项目内资料」）：与上面五个写工具分开成文件，
//   便于按文件划分白名单（READ_TOOL_NAMES），也便于审计「AI 能读什么」。
import './read-tools.js';
// ★ 章节写入「提案」工具：只提交提案，不写库（作者确认后由前端落库）。
import './chapter-proposal-tools.js';
import { createPlugin, createPluginToolDef, listPluginsForAI, listPluginsToolDef } from './plugin-tools.js';

// 注册插件管理工具（AI 对话创建插件的能力）
registerTool(createPluginToolDef.function.name, createPluginToolDef, async (args, ctx) => {
  const r = await createPlugin(args as unknown as Parameters<typeof createPlugin>[0], ctx);
  return r;
});
registerTool(listPluginsToolDef.function.name, listPluginsToolDef, async () => listPluginsForAI());

// 重导出常用接口
export {
  type ToolContext,
  type ToolHandlerResult,
  getAllToolDefinitions,
  getToolDefinitions,
  executeTool,
  isRegisteredTool,
  markPluginTool,
  getPluginToolNames,
} from './registry.js';

/** 确保所有工具已注册（幂等，可多次调用） */
export function ensureToolsRegistered(): void {
  // 导入即注册，此函数仅作显式标记
  void getAllToolDefinitions();
}

/** 实体写入模块需要的工具名列表（用于按需启用） */
export const ENTITY_TOOL_NAMES = [
  'create_character',
  'update_character',
  'create_foreshadow',
  'update_foreshadow',
  'create_location',
  'update_location',
  'create_item',
  'update_item',
  'set_outline_core_conflict',
  'set_chapter_outline',
  'set_outline_section',
] as const;

/** 插件管理工具名（AI 对话创建/查看插件） */
export const PLUGIN_TOOL_NAMES = ['create_plugin', 'list_local_plugins'] as const;

/**
 * 只读工具名 —— AI 对话「查项目内资料」的能力集合。
 *
 * ★ 与 `ENTITY_TOOL_NAMES` 刻意分开：那一组是**写**（create/update），
 *   这一组是**读**。调用方可以只给读、不给写（手写台默认就是这样），
 *   也可以两者都给（AI 写作台的工具模式）。
 *
 * ★ 这一组里没有任何文件系统访问 —— 读的是数据库里的项目资料。
 */
export const READ_TOOL_NAMES = [
  'list_project_assets',
  'list_chapters',
  'read_chapter',
  'list_characters',
  'list_locations',
  'list_items',
  'list_foreshadows',
  'list_events',
  'list_outline',
  'list_reference_books',
  'read_reference_book',
  'list_notes',
] as const;

/**
 * 章节写入「提案」工具名。
 *
 * ★ 它**不是**写工具：调用它只产生一条待确认提案，数据库不变。
 *   真正确认写入由前端在用户点「确认」后调 `PUT /api/chapters/:id`。
 *   与 SDK 侧那个真写的 `write_chapter` 是两条独立链路，别混。
 */
export const PROPOSE_CHAPTER_TOOL_NAME = 'propose_chapter_edit' as const;
