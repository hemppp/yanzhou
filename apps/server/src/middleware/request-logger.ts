// ============================================================
// 请求日志中间件
// 记录 method、path、status、duration
//
// ★ 重复折叠（2026-11-13）：前端有几处**常量轮询**（状态栏总字数 5 s 一次
//   `/projects/:id`、健康检查、面板刷新…），每个请求一行会把日志淹掉 ——
//   实测一份 408 KB 的 server.out.log 里 5804 行有 4410 行是同一个
//   `GET /api/projects/<id>`，真正有用的日志被 64 MB 滚动提前挤掉。
//
//   折叠语义（不丢信息）：
//     · 某个 method+path+status 的**首次**出现仍立刻原样记录；
//     · 之后同一组合的请求只计数，每 `SUMMARY_INTERVAL_MS` 收一行
//       `… → 200 ×12（最近 60s 内重复，均值 1ms；同类请求行已折叠）`；
//     · 安静下来（超过 `IDLE_RESET_MS` 没再出现）后计数归零，
//       下次出现又回到「首次原样记录」。
//
//   用「时间戳比较」而不是定时器：定时器在这个中间件里会随请求路径数增长、
//   还要 unref 才不阻塞退出，而按需比较没有这些代价。
// ============================================================

import type { Context, Next } from 'hono';

/** 同一请求持续重复时，最多每 60 s 收一行汇总。 */
const SUMMARY_INTERVAL_MS = 60_000;
/** 超过该时长没有重复，就当作新一轮（下次出现按首次原样记录）。 */
const IDLE_RESET_MS = 60_000;
/** 折叠表的最大条目数；超过就先清掉过期条目，仍超则整体重置（防御性上限）。 */
const MAX_ENTRIES = 500;

interface RepeatEntry {
  /** 本轮已折叠（未汇总）的重复次数。 */
  count: number;
  /** 本轮这些重复的耗时总和（用于均值）。 */
  totalMs: number;
  /** 最近一次出现的时间。 */
  lastAt: number;
  /** 上一次输出汇总的时间。 */
  lastSummaryAt: number;
}

const repeats = new Map<string, RepeatEntry>();

function prune(now: number): void {
  for (const [key, entry] of repeats) {
    if (now - entry.lastAt > IDLE_RESET_MS) {
      repeats.delete(key);
    }
  }
  // 仍超上限（例如大量 URL 带 id 的请求）：整体丢弃折叠状态，
  // 宁可多记几行，也不让这张表无界增长。
  if (repeats.size > MAX_ENTRIES) {
    repeats.clear();
  }
}

/**
 * 真正记录一行（或折叠一次计数）。
 *
 * 抽成独立函数而不是写在 `finally` 里：`finally` 中一旦有 `return`，
 * 会把 `next()` 抛出的异常一并吞掉。
 */
function record(method: string, path: string, status: number, duration: number): void {
  const now = Date.now();
  const key = `${method} ${path} ${status}`;
  const entry = repeats.get(key);

  if (entry === undefined || now - entry.lastAt > IDLE_RESET_MS) {
    // 首次（或安静了很久之后的第一条）：原样记录，行格式与历史一致。
    console.log(`[${method}] ${path} → ${status} (${duration}ms)`);
    repeats.set(key, { count: 0, totalMs: 0, lastAt: now, lastSummaryAt: now });
    if (repeats.size > MAX_ENTRIES) prune(now);
    return;
  }

  entry.count += 1;
  entry.totalMs += duration;
  entry.lastAt = now;

  if (now - entry.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    const avg = Math.round(entry.totalMs / entry.count);
    const windowSeconds = Math.round((now - entry.lastSummaryAt) / 1000);
    console.log(
      `[${method}] ${path} → ${status} ×${entry.count}` +
        `（最近 ${windowSeconds}s 内重复，均值 ${avg}ms；同类请求行已折叠）`,
    );
    entry.count = 0;
    entry.totalMs = 0;
    entry.lastSummaryAt = now;
  }
}

export async function requestLogger(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const { method } = c.req;
  const path = c.req.path;

  // 用 try/finally 确保即使 next() 抛出异常也能记录请求日志。
  // 记录逻辑放在单独函数里：`finally` 里不能有 `return`（会吞掉 next() 抛出的异常，
  // eslint no-unsafe-finally）。
  try {
    await next();
  } finally {
    record(method, path, c.res.status, Date.now() - start);
  }
}
