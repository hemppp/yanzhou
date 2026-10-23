import { create } from 'zustand';

interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  timestamp: number;
}

interface ChatHistoryEntry {
  messages: ChatHistoryMessage[];
  updatedAt: number;
}

interface ChatHistoryState {
  histories: Record<string, ChatHistoryEntry>;
  loadHistory: (key: string) => ChatHistoryMessage[];
  saveMessage: (key: string, msg: ChatHistoryMessage) => void;
  updateLastAssistant: (key: string, updates: Partial<ChatHistoryMessage>) => void;
  clearHistory: (key: string) => void;
  /** 删除项目：清理 `${projectId}:*` 前缀的全部历史 */
  removeProject: (projectId: string) => void;
  /** 登出：清空全部历史 */
  clearAll: () => void;
  /** 立即把防抖中的变更落盘（pagehide 前/登出前调用） */
  flushNow: () => void;
}

const STORAGE_KEY = 'novelmuse_chat_histories';
const MAX_MESSAGES_PER_KEY = 100;
/** 历史保留时长：30 天未更新的对话自动清理 */
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadFromStorage(): Record<string, ChatHistoryEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, ChatHistoryEntry>;
      // ★ TTL：超期条目不再返回（下次落盘自然清除）
      const minUpdatedAt = Date.now() - HISTORY_TTL_MS;
      for (const key of Object.keys(parsed)) {
        if (!parsed[key] || parsed[key].updatedAt < minUpdatedAt) delete parsed[key];
      }
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

// ★ 防抖写入：流式 onComplete 会触发 updateLastAssistant，连续发消息也会高频 save，
//   之前每次都全量 JSON.stringify 整个 histories，消息多时卡顿明显。
//   改为防抖 500ms 合并写入，仅最后一次变更真正落盘。
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSnapshot: Record<string, ChatHistoryEntry> | null = null;

// ★ 持久化序列化时剥离 thinking：模型思考内容只在内存中供当前会话查看，不落盘
function serializeHistories(histories: Record<string, ChatHistoryEntry>): string {
  return JSON.stringify(histories, (key, value) => {
    if (key === 'thinking' && typeof value === 'string') return undefined;
    return value;
  });
}

function persistNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingSnapshot) {
    try {
      localStorage.setItem(STORAGE_KEY, serializeHistories(pendingSnapshot));
    } catch {
      // storage full, ignore
    }
    pendingSnapshot = null;
  }
}

function schedulePersist(histories: Record<string, ChatHistoryEntry>) {
  // 记录最新快照，供防抖回调读取
  pendingSnapshot = histories;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 500);
}

// ★ 页面隐藏/关闭前 flush：防抖中的最后一次变更不丢
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => persistNow());
}

export const useChatHistoryStore = create<ChatHistoryState>((set, get) => ({
  histories: loadFromStorage(),

  loadHistory: (key) => {
    return get().histories[key]?.messages ?? [];
  },

  saveMessage: (key, msg) => {
    set((state) => {
      const entry = state.histories[key] ?? { messages: [], updatedAt: 0 };
      const messages = [...entry.messages, msg];
      // 限制消息数量
      const trimmed = messages.length > MAX_MESSAGES_PER_KEY
        ? messages.slice(-MAX_MESSAGES_PER_KEY)
        : messages;
      const next = {
        ...state.histories,
        [key]: { messages: trimmed, updatedAt: Date.now() },
      };
      schedulePersist(next);
      return { histories: next };
    });
  },

  updateLastAssistant: (key, updates) => {
    set((state) => {
      const entry = state.histories[key];
      if (!entry || entry.messages.length === 0) return state;
      const messages = [...entry.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, ...updates };
      }
      const next = {
        ...state.histories,
        [key]: { messages, updatedAt: Date.now() },
      };
      schedulePersist(next);
      return { histories: next };
    });
  },

  clearHistory: (key) => {
    set((state) => {
      const next = { ...state.histories };
      delete next[key];
      schedulePersist(next);
      return { histories: next };
    });
  },

  removeProject: (projectId) => {
    if (!projectId) return;
    set((state) => {
      const next: Record<string, ChatHistoryEntry> = {};
      for (const [key, entry] of Object.entries(state.histories)) {
        if (!key.startsWith(`${projectId}:`)) next[key] = entry;
      }
      schedulePersist(next);
      return { histories: next };
    });
  },

  clearAll: () => {
    pendingSnapshot = null;
    set({ histories: {} });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },

  flushNow: () => persistNow(),
}));
