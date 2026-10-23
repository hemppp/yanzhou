// ============================================================
// 共享 SSE 流式请求辅助
//
// 统一三件事：
//   1. 组合信号：外部取消（用户停止/组件卸载）+ 空闲超时（连接挂着但无数据）
//   2. 活动通知：每收到网络字节调用 notifyActivity() 重置空闲计时
//   3. 残余 buffer：流结束后最后一条事件可能没有尾部空行，用 drainSSEBuffer 补解析
//
// 兼容 CRLF 分隔；注释行（: keepalive）由调用方按行前缀跳过。
// ============================================================

export interface SSEStreamOptions {
  /** 外部取消信号（用户停止 / 组件卸载） */
  external?: AbortSignal;
  /** 空闲超时：连续这么久没有任何字节则判定超时（默认 45s） */
  idleTimeoutMs?: number;
}

export interface SSEStreamController {
  /** 组合后的信号：外部取消或空闲超时都会触发。传给 fetch 的 signal。 */
  signal: AbortSignal;
  /** 每收到一次网络字节就调用，重置空闲计时 */
  notifyActivity: () => void;
  /** 是否因空闲超时被内部中止（用于把超时归类为错误而非用户取消） */
  isIdleTimeout: () => boolean;
  /** 结束时释放监听与计时器（finally 中调用） */
  dispose: () => void;
}

export function createSSEStreamController(opts: SSEStreamOptions = {}): SSEStreamController {
  const internal = new AbortController();
  const idleMs = opts.idleTimeoutMs ?? 45_000;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onExternalAbort = () => internal.abort(opts.external?.reason);
  if (opts.external) {
    if (opts.external.aborted) onExternalAbort();
    else opts.external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const armIdle = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      internal.abort(new DOMException('SSE idle timeout', 'TimeoutError'));
    }, idleMs);
  };
  armIdle();

  return {
    signal: internal.signal,
    notifyActivity: armIdle,
    isIdleTimeout: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (opts.external) opts.external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * 解析一个 SSE 事件块（不含结尾空行），对其中每个 data: 行调用 onLine。
 * 兼容 CRLF；自动跳过注释行（: keepalive）与空行。
 */
export function forEachSSEDataLine(block: string, onLine: (dataStr: string) => void): void {
  if (!block) return;
  const normalized = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of normalized.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.slice(6);
    if (dataStr.trim()) onLine(dataStr);
  }
}
