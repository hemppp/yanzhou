// ============================================================
// AI 对话记录 —— 本地持久化（按「项目 + 章节」分开存）
// ------------------------------------------------------------
// 背景：手写台（`AiChatPanel`）与 AI 自动写作（`ChatPanel`）的对话都是
// `useState<ChatMessage[]>([])`，只存在组件内存里 —— **刷新 / HMR 整页重载后全部丢失**。
// 用户实测反馈：「AI 对话刷新一下聊天记录就没有了」。
//
// 为什么不走服务端：对话是辅助性上下文，不是作品数据；加表 + 路由 + 同步逻辑
// 的成本远高于收益。按项目/章节分开存到 localStorage 即可满足「刷新后还在」。
//
// 存储键：`nm:chat:<projectId>:<scope>`，scope 由调用方决定
//   · 手写台按「项目 + 章节」—— 换章看该章自己的对话
//   · 自动写作按「项目」（整轮讨论，不按章切）
//
// 与 `chapterLocalCache` 同一套纪律：同步写入、失败静默降级、读取时校验形状。
// ⚠️ 不存 streaming 中的消息：刷新时把它们标成 done 或丢弃 —— 半截回复比没有更糟。
// ============================================================

const PREFIX = 'nm:chat:';

/**
 * 单会话最多保留的消息条数。
 *
 * 不裁剪的话：一次长对话（含每轮完整回答）会把整段正文反复写进 localStorage，
 * 迟早撑爆配额（之后写入静默失败，刷新即丢）。丢最旧的、留最近的。
 */
const MAX_PERSISTED_MESSAGES = 200;

/**
 * 统一的最小形状。
 * 两侧的 ChatMessage 结构不同：手写台有 `id/status/tools`，自动写作只有
 * `role/content/timestamp`。所以只要求「能取到一个稳定键」——
 * `id` 优先，没有就用 `timestamp`（自动写作侧每条都有）。
 */
interface PersistableMessage {
  id?: string;
  timestamp?: number;
  status?: string;
}

/** 取该消息的稳定标识；两侧都没有时返回 null（整条丢弃，避免重复/错位） */
function keyOfMessage(m: PersistableMessage): string | null {
  if (typeof m.id === 'string' && m.id) return m.id;
  if (typeof m.timestamp === 'number') return String(m.timestamp);
  return null;
}

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function keyOf(projectId: string, scope: string): string {
  return `${PREFIX}${projectId}:${scope}`;
}

/** 读取该会话的历史消息；没有 / 损坏 / 形状不符时返回空数组（绝不抛） */
export function loadChatHistory<T extends PersistableMessage>(
  projectId: string | null | undefined,
  scope: string,
): T[] {
  if (!projectId || !storageAvailable()) return [];
  try {
    const raw = localStorage.getItem(keyOf(projectId, scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 形状校验：必须能取到稳定键，否则整条丢弃（避免半截数据把界面搞崩）
    return parsed.filter((m): m is T => !!m && typeof m === 'object' && !!keyOfMessage(m));
  } catch {
    return [];
  }
}

/**
 * 写入历史消息。
 *
 * ★ 当次会话里 `status: 'streaming'` 的消息**不落盘** —— 刷新后它们永远不会
 *   再收到后续帧，留着会是一个永远转圈的气泡。直接剔除。
 */
export function saveChatHistory<T extends PersistableMessage>(
  projectId: string | null | undefined,
  scope: string,
  messages: T[],
): void {
  if (!projectId || !storageAvailable()) return;
  try {
    const stable = messages
      .filter((m) => m.status !== 'streaming')
      .slice(-MAX_PERSISTED_MESSAGES);
    // 思维链只在内存里供当前会话查看，不落盘（与 chatHistoryStore 口径一致）。
    localStorage.setItem(
      keyOf(projectId, scope),
      JSON.stringify(stable, (key, value) =>
        key === 'thinking' && typeof value === 'string' ? undefined : value),
    );
  } catch {
    /* 配额满 / 隐私模式：静默降级，不阻塞对话 */
  }
}

/** 清空该会话的历史（「清空对话」按钮用） */
export function clearChatHistory(projectId: string | null | undefined, scope: string): void {
  if (!projectId || !storageAvailable()) return;
  try {
    localStorage.removeItem(keyOf(projectId, scope));
  } catch {
    /* 忽略 */
  }
}