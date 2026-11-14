// ============================================================
// Hono → node:http 适配器（供 dsh-host-webserver 的 webServer.register 使用）
// 与 @hono/node-server 的 getRequestListener 等价，但：
//   - 错误显式记录（原实现吞错/空 500，难以排查）
//   - 请求/响应生命周期完全受控
// ============================================================

import type { Hono } from 'hono';
import type { IncomingMessage, ServerResponse } from 'http';

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

/** 把 node:http 请求转成 Web Request 并调用 Hono 应用。 */
export function honoListener(app: Hono) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // ★ 断连信号：客户端关页面/断网时 `res` 会 `close`。必须把它接到
    //   `Request.signal` 上 —— 各 SSE 路由都用 `c.req.raw.signal` 取消上游
    //   AI 生成；原来构造 Request 时没传 signal，等于所有取消全部失效，
    //   断开的连接还在全速烧 token，并且下面的读循环会一直等 drain。
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const rawBody = hasBody ? await readBody(req) : null;

      // node req.headers 可能含 undefined 值，需过滤（Headers 构造不允许）
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }

      const request = new Request(url, {
        method,
        headers,
        body: rawBody ?? undefined,
        signal: controller.signal,
      });

      const response = await app.fetch(request);

      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      res.writeHead(response.status, outHeaders);
      if (method === 'HEAD') {
        res.end();
        return;
      }
      // ★ 流式直通：SSE（chat-stream/scan-stream 等）与大响应必须逐块写出。
      //   此前这里 await response.arrayBuffer() 全量缓冲，SSE 心跳与思考增量全部
      //   被憋到流结束才一次性发送 —— 客户端只会看到「空闲超时」，长回复永远失败。
      const body = response.body;
      if (!body) {
        res.end();
        return;
      }
      const reader = body.getReader();
      // 客户端断开时 `res` 的 'close'：用它把「等 drain」「等 read」都唤醒，
      // 否则下面两处 await 会永久挂起，而 Hono 侧的心跳 interval 还在往
      // 一个没人读的流里 enqueue —— 这就是「断开的长连接越攒越多」的根因。
      const closed = new Promise<void>((resolve) => {
        if (res.destroyed || res.writableEnded) {
          resolve();
          return;
        }
        res.once('close', () => resolve());
      });
      try {
        for (;;) {
          const { done, value } = await Promise.race([
            reader.read(),
            closed.then(() => ({ done: true as const, value: undefined })),
          ]);
          if (done) break;
          if (!value) continue;
          if (!res.write(value)) {
            await Promise.race([
              new Promise<void>((resolve) => res.once('drain', () => resolve())),
              closed,
            ]);
          }
        }
        if (!res.writableEnded) res.end();
      } catch (streamErr) {
        // 上游流中断/客户端断开：尽力终止响应
        console.warn('[hono-adapter] 响应流中断:', streamErr instanceof Error ? streamErr.message : streamErr);
        if (!res.writableEnded) res.destroy();
      } finally {
        // 无论如何都要把上游流关掉：让 AI 生成侧的 finally / 心跳清理跑起来。
        try {
          await reader.cancel();
        } catch {
          /* 已结束 */
        }
      }
    } catch (err) {
      // C9：生产环境不向客户端泄露内部错误详情（与 error-handler.ts 脱敏口径一致），
      // 完整堆栈始终记录在服务端日志。
      const isProduction = process.env.NODE_ENV === 'production';
      const message = isProduction
        ? '服务器内部错误'
        : (err instanceof Error ? err.message : String(err));
      console.error('[hono-adapter] 请求处理异常:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message } }));
      } else {
        res.destroy();
      }
    }
  };
}
