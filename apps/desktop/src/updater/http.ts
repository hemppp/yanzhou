// ============================================================
// apps/desktop/src/updater/http.ts
// 极简 HTTP(S) 客户端：仅 http:/https:，支持重定向、超时、体积上限。
//
// 契约来源：ADR D14.3 补充冻结 ——
//   `url` 只允许 `http:` / `https:`；单文件下载上限 **512 MB**；下载超时 **120 s**。
// 本模块只依赖 node: 内置模块，无第三方运行期依赖。
// ============================================================

import { createWriteStream, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024; // 512 MB
export const DOWNLOAD_TIMEOUT_MS = 120_000; // 120 s
export const MAX_REDIRECTS = 5;

/** 下载过程中任何可预期的失败都抛这个类型（调用方转成 `{ ok:false, error }`）。 */
export class UpdaterHttpError extends Error {
  readonly kind: 'protocol' | 'network' | 'timeout' | 'too-large' | 'status' | 'hash';
  constructor(kind: UpdaterHttpError['kind'], message: string) {
    super(message);
    this.name = 'UpdaterHttpError';
    this.kind = kind;
  }
}

function assertHttpProtocol(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpdaterHttpError('protocol', `不是合法 URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UpdaterHttpError('protocol', `协议不被支持（仅允许 http: / https:）: ${parsed.protocol}`);
  }
  return parsed;
}

/** 计算一段内存数据的 sha256（小写十六进制）。 */
export function sha256HexOfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 计算磁盘文件的 sha256（小写十六进制）。 */
export async function sha256HexOfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * 下载 URL 到内存（用于 manifest.json 这类小文件）。
 * @param maxBytes 体积上限，默认 8 MB。
 */
export function fetchToBuffer(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; redirectsLeft?: number } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const redirectsLeft = opts.redirectsLeft ?? MAX_REDIRECTS;

  return new Promise<Buffer>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = assertHttpProtocol(url);
    } catch (err) {
      reject(err);
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsed,
      { method: 'GET', headers: { 'user-agent': '砚舟-Updater/1.0', accept: '*/*' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new UpdaterHttpError('network', `重定向次数超过 ${MAX_REDIRECTS} 次: ${url}`));
            return;
          }
          const next = new URL(res.headers.location, parsed).toString();
          fetchToBuffer(next, { maxBytes, timeoutMs, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new UpdaterHttpError('status', `HTTP ${status} ${res.statusMessage ?? ''} — ${url}`.trim()));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new UpdaterHttpError('too-large', `响应体超过上限 ${maxBytes} 字节: ${url}`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => reject(new UpdaterHttpError('network', `读取响应失败: ${err.message}`)));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new UpdaterHttpError('timeout', `请求超时（${timeoutMs} ms）: ${url}`));
    });
    req.on('error', (err) => {
      if (err instanceof UpdaterHttpError) reject(err);
      else reject(new UpdaterHttpError('network', `请求失败: ${err.message}`));
    });
    req.end();
  });
}

export interface DownloadResult {
  /** 落盘路径 */
  filePath: string;
  /** 实际字节数 */
  bytes: number;
  /** 实测 sha256（小写十六进制） */
  sha256: string;
}

/**
 * 流式下载到文件，**同时**增量计算 sha256，并做上限/超时保护。
 *
 * 若给了 `expectedSha256`：不一致 ⇒ **删除落盘文件**并抛 `UpdaterHttpError('hash', …)`。
 * 这正是 ADR D14.3-1 的冻结要求（「校验失败绝不进入解压」）。
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  opts: { expectedSha256?: string; maxBytes?: number; timeoutMs?: number; redirectsLeft?: number } = {},
): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const redirectsLeft = opts.redirectsLeft ?? MAX_REDIRECTS;
  const parsed = assertHttpProtocol(url);

  await fsp.mkdir((await import('node:path')).dirname(destPath), { recursive: true });

  const hash = createHash('sha256');
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(new UpdaterHttpError('too-large', `下载体积超过上限 ${maxBytes} 字节: ${url}`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request(
        parsed,
        { method: 'GET', headers: { 'user-agent': '砚舟-Updater/1.0', accept: '*/*' } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              reject(new UpdaterHttpError('network', `重定向次数超过 ${MAX_REDIRECTS} 次: ${url}`));
              return;
            }
            const next = new URL(res.headers.location, parsed).toString();
            downloadToFile(next, destPath, { ...opts, redirectsLeft: redirectsLeft - 1 }).then(
              () => resolve(),
              reject,
            );
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(new UpdaterHttpError('status', `HTTP ${status} ${res.statusMessage ?? ''} — ${url}`.trim()));
            return;
          }
          pipeline(res, counter, createWriteStream(destPath)).then(() => resolve(), reject);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new UpdaterHttpError('timeout', `下载超时（${timeoutMs} ms）: ${url}`));
      });
      req.on('error', (err) => {
        if (err instanceof UpdaterHttpError) reject(err);
        else reject(new UpdaterHttpError('network', `请求失败: ${err.message}`));
      });
      req.end();
    });
  } catch (err) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw err;
  }

  const actual = hash.digest('hex');
  const expected = opts.expectedSha256 ? String(opts.expectedSha256).trim().toLowerCase() : '';
  if (expected !== '' && expected !== actual) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw new UpdaterHttpError('hash', `SHA-256 校验失败：期望 ${expected}，实际 ${actual}`);
  }
  return { filePath: destPath, bytes: total, sha256: actual };
}