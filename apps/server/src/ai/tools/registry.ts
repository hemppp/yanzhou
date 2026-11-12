// ============================================================
// AI 工具注册表 (Tools Registry)
//
// 定义 AI 对话中可调用的工具（function calling）。
// 工具 = LLM 可主动调用的函数，用于读写实体数据。
//
// 设计原则：
//  - 工具与技能正交：技能是"对话视角"，工具是"操作能力"
//  - 安全限制：只暴露 create/update，不暴露 delete（防 AI 误删）
//  - 项目隔离：所有 handler 接收 projectId，防止跨项目写入
//  - 复用 service 层：handler 直接调用 services/*-service.ts
//
// 工具调用流程（在 chat-agent.ts 的 tool calling 循环中）：
//   1. LLM 流式返回 tool_calls
//   2. Agent 累积组装完整 ToolCall[]
//   3. 对每个 tool_call，查 registry 找到 handler 执行
//   4. 将执行结果作为 {role:'tool'} 消息追加，再次调用 LLM
//   5. 循环直到 LLM 不再请求工具调用
// ============================================================

import type { ToolDefinition } from '../providers/provider-factory.js';

// ---- 工具执行上下文 ----

export interface ToolContext {
  /** 当前项目 ID（用于项目隔离，所有写入操作绑定此项目；必须先经过项目归属校验） */
  projectId: string;
  /** 发起工具调用的用户信息（本地版固定为本地用户，仅用于数据归属与审计） */
  user: {
    id?: string;
  };
}

// ---- 工具定义 ----

export interface ToolHandlerResult {
  /** 是否执行成功 */
  success: boolean;
  /** 返回给 LLM 的结果文本（JSON 字符串或纯文本） */
  result: string;
  /**
   * 可选：创建/更新的实体信息，用于前端展示。
   *
   * ★ `action: 'propose'` 是「**提案**」而非「已写入」：工具**没有改任何数据**，
   *   只是把「AI 想怎么改」交给前端，由作者点确认后才真正落库。
   *   章节正文（`type: 'chapter'`）**只能**走这条路 —— AI 不能直接改正文。
   */
  entity?: {
    type: 'character' | 'foreshadow' | 'location' | 'item' | 'outline' | 'chapter';
    action: 'create' | 'update' | 'propose';
    id?: string;
    name?: string;
    /** 大纲工具专用：携带结构化载荷供前端写入 localStorage store */
    payload?: Record<string, unknown>;
  };
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolHandlerResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ---- 注册表 ----

const registry = new Map<string, RegisteredTool>();

/** 插件注册的工具名（经宿主 ctx.ai.tools.register 进入；聊天工具集自动包含） */
const pluginToolNames = new Set<string>();

/** 标记一个工具来自插件（宿主 aiService.tools.register 时调用） */
export function markPluginTool(name: string): void {
  pluginToolNames.add(name);
}

/** 获取全部插件工具名（聊天工具白名单动态纳入，插件注销时自动移除） */
export function getPluginToolNames(): string[] {
  return [...pluginToolNames].filter((n) => registry.has(n));
}

/** 注册一个工具 */
export function registerTool(
  name: string,
  definition: ToolDefinition,
  handler: ToolHandler,
): void {
  if (registry.has(name)) {
    console.warn(`[Tools Registry] 工具 "${name}" 已注册，将被覆盖`);
  }
  registry.set(name, { definition, handler });
}

/** 批量注册工具 */
export function registerTools(tools: RegisteredTool[]): void {
  for (const t of tools) {
    registry.set(t.definition.function.name, t);
  }
}

/** 获取所有已注册工具的定义（用于传给 LLM） */
export function getAllToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((t) => t.definition);
}

/** 按名称获取工具定义 */
export function getToolDefinitions(names: string[]): ToolDefinition[] {
  return names
    .map((n) => registry.get(n)?.definition)
    .filter((d): d is ToolDefinition => !!d);
}

/** 注销一个工具（插件卸载时调用） */
export function unregisterTool(name: string): void {
  registry.delete(name);
  pluginToolNames.delete(name);
}

/** 执行工具调用 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolHandlerResult> {
  const tool = registry.get(name);
  if (!tool) {
    return {
      success: false,
      result: `错误：未知工具 "${name}"`,
    };
  }
  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Tools Registry] 工具 "${name}" 执行失败:`, msg);
    return {
      success: false,
      result: `工具执行失败：${msg}`,
    };
  }
}

/** 判断是否为已注册工具 */
export function isRegisteredTool(name: string): boolean {
  return registry.has(name);
}

/** 清空注册表（仅用于测试） */
export function clearRegistry(): void {
  registry.clear();
}
