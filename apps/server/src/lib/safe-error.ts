// ============================================================
// 错误消息安全化辅助
//
// 防止将内部异常细节（DB schema、文件路径、堆栈片段、第三方 SDK 错误等）
// 通过 HTTP 响应泄露给客户端。所有面向用户的 500 错误应使用 safeInternal，
// 已知业务错误（如 "用户名已被占用"）使用 safeBusiness。
// ============================================================

/**
 * 处理 500 内部错误：服务端打印完整错误，返回给客户端脱敏后的通用提示。
 *
 * @param error - 捕获到的错误
 * @param fallbackMessage - 返回给客户端的通用提示（默认 "服务器内部错误"）
 * @param logPrefix - 控制台日志前缀，便于排查
 * @returns 返回给客户端的安全消息
 */
export function safeInternal(
  error: unknown,
  fallbackMessage: string = '服务器内部错误',
  logPrefix: string = '[SafeError]',
): string {
  console.error(`${logPrefix} 内部错误:`, error);
  return fallbackMessage;
}

/**
 * 处理业务错误：仅当错误消息命中白名单时返回原消息，否则视为未知错误，
 * 服务端打印完整错误并返回通用提示。
 *
 * @param error - 捕获到的错误
 * @param knownMessages - 已知的业务错误消息白名单（精确匹配）
 * @param fallbackMessage - 未命中白名单时返回的通用提示
 * @param logPrefix - 控制台日志前缀
 * @returns 返回给客户端的安全消息
 */
export function safeBusiness(
  error: unknown,
  knownMessages: ReadonlySet<string> | readonly string[],
  fallbackMessage: string = '操作失败',
  logPrefix: string = '[SafeError]',
): string {
  const message = error instanceof Error ? error.message : '';
  const knownSet = knownMessages instanceof Set
    ? knownMessages
    : new Set(knownMessages);
  if (message && knownSet.has(message)) {
    return message;
  }
  console.error(`${logPrefix} 未分类异常（隐藏详情）:`, error);
  return fallbackMessage;
}
