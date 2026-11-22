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
import * as tls from 'node:tls';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024; // 512 MB
export const DOWNLOAD_TIMEOUT_MS = 120_000; // 120 s
export const MAX_REDIRECTS = 5;

/**
 * HTTP User-Agent。
 *
 * ★ 必须是**纯 ASCII**：Node 的 http.request 会校验 header 值，
 *   含中文（如「砚舟-Updater/1.0」）会直接抛
 *   `Invalid character in header content ["user-agent"]` —— 请求根本发不出去，
 *   表现为「检查更新」永远失败。产品名放注释里，协议值只留 ASCII。
 */
export const USER_AGENT = 'Yanzhou-Updater/1.0';

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

interface ProxyConfig {
  host: string;
  port: number;
  auth?: string;
  secure: boolean;
}

/** 解析 `http(s)://[user:pass@]host:port` 形式的代理地址；不支持协议时返回 null。 */
function parseProxyUrl(proxyUrl: string): ProxyConfig | null {
  try {
    const u = new URL(proxyUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const secure = u.protocol === 'https:';
    const port = Number(u.port || (secure ? 443 : 80));
    if (u.hostname === '' || !Number.isFinite(port)) return null;
    const auth = u.username
      ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
      : undefined;
    return { host: u.hostname, port, auth, secure };
  } catch {
    return null;
  }
}

/**
 * 为 https 目标构建「经 HTTP(S) 代理 CONNECT 隧道」的 Agent。
 *
 * 为什么需要：宿主壳不读系统代理，而双击启动的安装版进程里通常也没有
 * HTTPS_PROXY —— 直连 GitHub 在部分网络下会一直无响应，直到 120s 超时。
 * 代理由 main.ts 通过 `session.resolveProxy()` 解析后经 UpdaterContext 注入，
 * 本模块保持零 electron 依赖。
 *
 * 仅处理 https 目标（更新源与 release 资产均为 https）。代理不可用/协议不支持
 * 时返回 null，调用方退回直连。
 */
function createProxyAgent(proxyUrl: string | undefined): https.Agent | null {
  if (!proxyUrl) return null;
  const proxy = parseProxyUrl(proxyUrl);
  if (proxy === null) return null;

  const agent = new https.Agent({ keepAlive: false });
  // Node 的 Agent 在建立连接时调用实例上的 createConnection；覆盖它即可接管建连。
  (agent as unknown as {
    createConnection: (
      options: { host?: string; port?: number | string; servername?: string },
      callback: (err: Error | null, socket?: tls.TLSSocket) => void,
    ) => void;
  }).createConnection = (options, callback) => {
    const targetHost = options.host || 'localhost';
    const targetPort = Number(options.port || 443);
    const proxyTransport = proxy.secure ? https : http;
    const headers: Record<string, string> = { host: `${targetHost}:${targetPort}` };
    if (proxy.auth) {
      headers['proxy-authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
    }
    const req = proxyTransport.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      agent: false,
    });
    req.setTimeout(15_000, () => {
      req.destroy(new UpdaterHttpError('timeout', `代理连接超时（15000 ms）: ${proxy.host}:${proxy.port}`));
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new UpdaterHttpError('network', `代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: options.servername || targetHost });
      callback(null, tlsSocket);
    });
    req.once('error', (err) => callback(err));
    req.end();
  };
  return agent;
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
  opts: { maxBytes?: number; timeoutMs?: number; redirectsLeft?: number; proxyUrl?: string } = {},
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
    const agent = parsed.protocol === 'https:' ? createProxyAgent(opts.proxyUrl) : null;
    const req = transport.request(
      parsed,
      { method: 'GET', headers: { 'user-agent': USER_AGENT, accept: '*/*' }, ...(agent ? { agent } : {}) },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new UpdaterHttpError('network', `重定向次数超过 ${MAX_REDIRECTS} 次: ${url}`));
            return;
          }
          const next = new URL(res.headers.location, parsed).toString();
          fetchToBuffer(next, { maxBytes, timeoutMs, redirectsLeft: redirectsLeft - 1, proxyUrl: opts.proxyUrl }).then(resolve, reject);
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
  opts: {
    expectedSha256?: string;
    maxBytes?: number;
    timeoutMs?: number;
    redirectsLeft?: number;
    proxyUrl?: string;
  } = {},
): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  let redirectsLeft = opts.redirectsLeft ?? MAX_REDIRECTS;

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
    // ★ 重定向必须在**同一次调用里**循环跟随，不能递归调用自身后由外层继续算哈希：
    //   GitHub 的 release 资产永远是 302 → release-assets.githubusercontent.com。
    //   旧实现把最终文件交给递归调用写，外层自己的 hash 一个字节都没收到，
    //   于是校验时拿「空文件的 e3b0c442…」去比期望值 ⇒ 每次应用内更新都报
    //   「SHA-256 校验失败」，下载本身其实是成功的（2026-11-21/22 两次实测）。
    let currentUrl = url;
    for (;;) {
      const parsed = assertHttpProtocol(currentUrl);
      let redirectTo: string | null = null;

      await new Promise<void>((resolve, reject) => {
        const transport = parsed.protocol === 'https:' ? https : http;
        const agent = parsed.protocol === 'https:' ? createProxyAgent(opts.proxyUrl) : null;
        const req = transport.request(
          parsed,
          { method: 'GET', headers: { 'user-agent': USER_AGENT, accept: '*/*' }, ...(agent ? { agent } : {}) },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
              res.resume();
              if (redirectsLeft <= 0) {
                reject(new UpdaterHttpError('network', `重定向次数超过 ${MAX_REDIRECTS} 次: ${currentUrl}`));
                return;
              }
              redirectTo = new URL(res.headers.location, parsed).toString();
              resolve();
              return;
            }
            if (status < 200 || status >= 300) {
              res.resume();
              reject(new UpdaterHttpError('status', `HTTP ${status} ${res.statusMessage ?? ''} — ${currentUrl}`.trim()));
              return;
            }
            pipeline(res, counter, createWriteStream(destPath)).then(() => resolve(), reject);
          },
        );
        req.setTimeout(timeoutMs, () => {
          req.destroy(new UpdaterHttpError('timeout', `下载超时（${timeoutMs} ms）: ${currentUrl}`));
        });
        req.on('error', (err) => {
          if (err instanceof UpdaterHttpError) reject(err);
          else reject(new UpdaterHttpError('network', `请求失败: ${err.message}`));
        });
        req.end();
      });

      if (redirectTo === null) break;
      redirectsLeft -= 1;
      currentUrl = redirectTo;
    }
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