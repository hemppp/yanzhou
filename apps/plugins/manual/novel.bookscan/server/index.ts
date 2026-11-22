// ============================================================
// 扫榜拆书 —— Server 面
// 抓取公共书榜（晋江文学城 / 番茄小说 / 七猫），解析为统一书目列表，
// KV 缓存 30 分钟。榜单 URL 全部来自代码内白名单并经 assertPublicUrl
// 校验（仅 http/https 公网 host，拒绝 localhost/环回/私有/保留地址，
// 杜绝 SSRF）；路由挂载在 /api/plugins/bookscan（宿主强制前缀 + 默认鉴权）。
// ============================================================
import { execFile } from 'child_process';
import { Hono } from 'hono';
import type { ServerPluginContext } from '@novel/core';

export const name = 'novel.bookscan';
export const inject = ['routes', 'db'];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_ITEMS = 50;

interface Board {
  key: string;
  label: string;
  url: string;
}

interface SourceDef {
  id: string;
  label: string;
  /** 允许的 host 后缀（配合 assertPublicUrl 双重校验） */
  hosts: string[];
  /** 页面编码（晋江 GBK，其余 UTF-8） */
  encoding: 'utf-8' | 'gbk';
  parse: (html: string) => ScanItem[];
  boards: Board[];
}

export interface ScanItem {
  rank: number;
  title: string;
  author: string;
  novelId: string;
  intro: string;
  category: string;
  /** 完结状态（番茄提供） */
  status?: string;
  /** 附加信息（在读数 / 字数等） */
  meta?: string;
  url: string;
}

/**
 * ★ SSRF 防线（安全约束）：仅允许 http/https 且 host 必须为公网地址。
 *   拒绝 localhost、环回、私有（10/172.16-31/192.168）、保留（169.254/0.0.0.0/IPv6 ULA 等）
 *   以及不在来源 host 白名单内的地址。榜单 URL 均为代码内常量，此处为纵深防御。
 */
export function assertPublicUrl(url: string, allowedHosts: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('榜单 URL 非法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('榜单 URL 仅允许 http/https');
  }
  const host = parsed.hostname.toLowerCase();
  const bad =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^0\./.test(host) ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith('[') || // IPv6 字面量一律拒绝（榜单均为域名）
    host === '0.0.0.0';
  if (bad) throw new Error('榜单 URL 指向保留/私有地址，已拦截');
  if (!allowedHosts.some((h) => host === h || host.endsWith('.' + h))) {
    throw new Error('榜单 URL 不在来源白名单内');
  }
}

// ---- HTML / Nuxt 载荷工具（榜单结构相对稳定，轻量正则解析；避免重依赖） ----

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).trim();
}

/**
 * 番茄排行榜的防爬字体把部分常用字映射到 Unicode 私用区（U+E000–U+F8FF），
 * 纯文本抓下来是 `惹枝` 这类缺字。详情页没有这层混淆，见 enrichFanqieItems。
 */
const PUA_RE = /[\uE000-\uF8FF]/;
function stripPua(s: string): string {
  return s.replace(/[\uE000-\uF8FF]/g, '').trim();
}

/** 解码 Nuxt __NUXT__ 载荷里的字符串（\uXXXX / \n / \" 等 JSON 转义） */
function decodeNuxtString(s: string): string {
  try {
    return JSON.parse('"' + s + '"') as string;
  } catch {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/');
  }
}

/** 晋江 topten 表格：每行 = 作者链接 + 书籍链接（rel 属性是文案）+ 分类 */
export function parseJjwxc(html: string): ScanItem[] {
  const items: ScanItem[] = [];
  const seen = new Set<string>();
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];
    // 锚点两种形态：带文案（attrs 段以 class="tooltip"> 收尾，rel 内含 <br>）与普通锚点
    const book =
      row.match(/href="onebook\.php\?novelid=(\d+)"([\s\S]*?)class="tooltip"[^>]*>([\s\S]*?)<\/a>/) ??
      row.match(/href="onebook\.php\?novelid=(\d+)"([^>]*)>([\s\S]*?)<\/a>/);
    if (!book) continue;
    const novelId = book[1];
    if (seen.has(novelId)) continue;
    const attrs = book[2] ?? '';
    const titleAttr = attrs.match(/title="([^"]*)"/);
    const title = (titleAttr ? stripTags(titleAttr[1]) : '') || stripTags(book[3] ?? '');
    if (!title) continue;

    const rel = attrs.match(/rel="([\s\S]*?)"/);
    const intro = rel
      ? decodeEntities(rel[1])
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]*>/g, '')
          .trim()
      : '';

    const authorMatch = row.match(/href="oneauthor\.php\?authorid=\d+"[^>]*>([\s\S]*?)<\/a>/);
    const author = authorMatch ? stripTags(authorMatch[1]) : '';
    const catMatch = row.match(/原创-[\u4e00-\u9fa5-]+/);
    const rankTd = row.match(/<td[^>]*>\s*(\d{1,3})\s*<\/td>/);

    seen.add(novelId);
    items.push({
      rank: rankTd ? parseInt(rankTd[1], 10) : items.length + 1,
      title,
      author,
      novelId,
      intro,
      category: catMatch ? catMatch[0].trim() : '',
      url: `https://www.jjwxc.net/onebook.php?novelid=${novelId}`,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** 番茄小说 /rank 页面：book-item-text 块（标题/作者/简介）+ book-item-footer（状态/在读数） */
export function parseFanqie(html: string): ScanItem[] {
  const items: ScanItem[] = [];
  const seen = new Set<string>();
  const parts = html.split('<div class="book-item-text">').slice(1);
  for (const part of parts) {
    const footerIdx = part.indexOf('book-item-footer');
    const textPart = part.slice(0, footerIdx >= 0 ? footerIdx : 2500);
    const footerPart = footerIdx >= 0 ? part.slice(footerIdx, footerIdx + 800).replace(/<!-- -->/g, '') : '';

    const head = textPart.match(/href="\/page\/(\d+)"[^>]*>([^<]+)</);
    if (!head) continue;
    const novelId = head[1];
    if (seen.has(novelId)) continue;
    const title = stripTags(head[2]);
    if (!title) continue;

    const authorMatch = textPart.match(/<div class="author">[\s\S]*?<span[^>]*>([^<]+)<\/span>/);
    const introMatch = textPart.match(/<div class="desc[^"]*">([\s\S]*?)<\/div>/);
    const statusMatch = footerPart.match(/book-item-footer-status">([^<]+)</);
    const readsMatch = footerPart.match(/在读：([^<]+)/);

    seen.add(novelId);
    items.push({
      rank: items.length + 1,
      title,
      author: authorMatch ? stripTags(authorMatch[1]) : '',
      novelId,
      intro: introMatch ? stripTags(introMatch[1]) : '',
      category: '',
      status: statusMatch ? stripTags(statusMatch[1]) : undefined,
      meta: readsMatch ? '在读 ' + stripTags(readsMatch[1]) : undefined,
      url: `https://fanqienovel.com/page/${novelId}`,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * 番茄详情页（/page/{id}）：h1 是书名，页面状态里的 abstract 是官方文案。
 * 详情页没有榜单页那层防爬字体，抓下来是正常汉字（2026-11-21 实测 PUA=0）。
 */
export function parseFanqieDetail(html: string): { title: string; author: string; intro: string } | null {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = stripPua(h1 ? stripTags(h1[1]) : '');
  const raw = html.match(/"abstract":"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
  const authorRaw = html.match(/"author":"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
  let intro = '';
  if (raw) {
    try {
      intro = JSON.parse('"' + raw + '"') as string;
    } catch {
      intro = raw;
    }
  }
  intro = stripPua(intro);
  const author = stripPua(authorRaw ? decodeNuxtString(authorRaw) : '');
  if (!title && !intro) return null;
  return { title, author, intro };
}

const DETAIL_FETCH_TIMEOUT_MS = 12_000;
/** 详情页回填的并发上限：单榜最多 10 本，4 并发约 1–2 秒 */
const DETAIL_CONCURRENCY = 4;

/**
 * 番茄榜单标题/文案被防爬字体混淆时，逐本抓详情页换回干净文本。
 * 单本失败不拖垮整榜：回落为「去掉私用区字符」的榜单原文。
 * 榜单结果本身有 30 分钟 KV 缓存，回填只在缓存失效/强制刷新时发生。
 */
export async function enrichFanqieItems(items: ScanItem[]): Promise<ScanItem[]> {
  const targets = items.filter(
    (item) => PUA_RE.test(item.title) || PUA_RE.test(item.author) || PUA_RE.test(item.intro),
  );
  if (targets.length === 0) return items;

  const details = new Map<string, { title: string; author: string; intro: string }>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const item = targets[cursor++]!;
      try {
        const res = await fetch(item.url, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
          signal: AbortSignal.timeout(DETAIL_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const html = new TextDecoder('utf-8').decode(Buffer.from(await res.arrayBuffer()));
        const parsed = parseFanqieDetail(html);
        if (parsed) details.set(item.novelId, parsed);
      } catch {
        // 单本失败忽略，下面统一回落
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, targets.length) }, worker));

  return items.map((item) => {
    const detail = details.get(item.novelId);
    return {
      ...item,
      title: detail?.title || stripPua(item.title),
      author: detail?.author || stripPua(item.author),
      intro: detail?.intro || stripPua(item.intro),
    };
  });
}

/** 七猫 /paihang 页面：Nuxt SSR 载荷 listData（book_id/title/author/分类/字数/简介）。
 *  逐条目分段 + 独立字段提取，避免字段缺省/顺序变化导致整条解析失败。 */
export function parseQimao(html: string): ScanItem[] {
  const items: ScanItem[] = [];
  const seen = new Set<string>();
  const segments = html.split('{book_id:"').slice(1);
  for (const seg of segments) {
    const body = seg.slice(0, 4000);
    const novelId = body.slice(0, body.indexOf('"'));
    if (!novelId || seen.has(novelId)) continue;
    const pick = (key: string): string => {
      const m = body.match(new RegExp(key + ':\"((?:[^\"\\\\]|\\\\.)*)\"'));
      return m ? decodeNuxtString(m[1]).trim() : '';
    };
    const title = pick('title');
    if (!title) continue;
    seen.add(novelId);
    items.push({
      rank: items.length + 1,
      title,
      author: pick('author'),
      novelId,
      intro: pick('intro'),
      category: pick('category2_name'),
      meta: pick('words_num') || undefined,
      url: pick('book_url') || `https://www.qimao.com/shuku/${novelId}/`,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** 榜单白名单：URL 固定在代码内（实测可解析；核对于 2026-09，站点改版时路由返回 502/过期缓存而非崩溃） */
const SOURCES: SourceDef[] = [
  {
    id: 'jjwxc',
    label: '晋江文学城',
    hosts: ['jjwxc.net'],
    encoding: 'gbk',
    parse: parseJjwxc,
    boards: [
      { key: '7', label: '全站积分榜', url: 'https://www.jjwxc.net/topten.php?orderstr=7&t=0' },
      { key: '2', label: 'VIP 强推榜', url: 'https://www.jjwxc.net/topten.php?orderstr=2&t=0' },
    ],
  },
  {
    id: 'fanqie',
    label: '番茄小说',
    hosts: ['fanqienovel.com'],
    encoding: 'utf-8',
    parse: parseFanqie,
    boards: [
      { key: 'all', label: '热门总榜', url: 'https://fanqienovel.com/rank' },
      { key: 'dushi', label: '都市日常', url: 'https://fanqienovel.com/rank/1_2_261' },
      { key: 'xianxia', label: '东方仙侠', url: 'https://fanqienovel.com/rank/1_2_1140' },
      { key: 'qihuan', label: '西方奇幻', url: 'https://fanqienovel.com/rank/1_2_1141' },
      { key: 'kehuan', label: '科幻末世', url: 'https://fanqienovel.com/rank/1_2_8' },
    ],
  },
  {
    id: 'qimao',
    label: '七猫中文网',
    hosts: ['qimao.com'],
    encoding: 'utf-8',
    parse: parseQimao,
    boards: [
      { key: 'boy-hot', label: '男生·大热榜', url: 'https://www.qimao.com/paihang/boy/hot/date/' },
      { key: 'girl-hot', label: '女生·大热榜', url: 'https://www.qimao.com/paihang/girl/hot/date/' },
      { key: 'boy-new', label: '新书榜', url: 'https://www.qimao.com/paihang/boy/new/date/' },
      { key: 'boy-over', label: '完结榜', url: 'https://www.qimao.com/paihang/boy/over/date/' },
    ],
  },
];

/** curl 回退：部分站点（七猫）响应头不规范，node 的 HTTP 解析器会拒绝，
 *  而 curl 宽容。返回 Buffer（未解码），由调用方按来源编码统一解码。 */
function curlFetchBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-sk', '--compressed', '-m', '15', '-A', UA, '-H', 'Accept-Language: zh-CN,zh;q=0.9', url],
      { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        if (err) return reject(err instanceof Error ? err : new Error(String(err)));
        if (!stdout || stdout.length === 0) return reject(new Error('curl 返回空内容'));
        resolve(stdout);
      },
    );
  });
}

export async function fetchBoardHtml(source: SourceDef, board: Board): Promise<string> {
  assertPublicUrl(board.url, source.hosts);
  let buf: Buffer;
  try {
    const res = await fetch(board.url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`榜单站点返回 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (fetchErr) {
    // 节点 HTTP 解析器无法容忍的站点（如七猫的畸形响应头）走 curl 回退
    console.warn(`[novel.bookscan] ${source.id} node fetch 失败，使用 curl 回退:`, fetchErr instanceof Error ? fetchErr.message : fetchErr);
    buf = await curlFetchBuffer(board.url);
  }
  return new TextDecoder(source.encoding).decode(buf);
}

interface CacheEntry {
  fetchedAt: number;
  items: ScanItem[];
}

export function apply(ctx: ServerPluginContext): void {
  const router = new Hono();

  // 可用书源 + 榜单清单
  router.get('/sources', (c) => {
    return c.json({
      sources: SOURCES.map((s) => ({
        id: s.id,
        label: s.label,
        boards: s.boards.map((b) => ({ key: b.key, label: b.label })),
      })),
    });
  });

  // 扫榜：GET /rankings?source=jjwxc&board=7&refresh=1
  router.get('/rankings', async (c) => {
    const sourceId = c.req.query('source') ?? SOURCES[0].id;
    const source = SOURCES.find((s) => s.id === sourceId);
    if (!source) return c.json({ error: { code: 'BAD_SOURCE', message: '未知书源 ' + sourceId } }, 400);
    const boardKey = c.req.query('board') ?? source.boards[0].key;
    const board = source.boards.find((b) => b.key === boardKey);
    if (!board) return c.json({ error: { code: 'BAD_BOARD', message: '未知榜单 ' + boardKey } }, 400);

    const refresh = c.req.query('refresh') === '1';
    const cacheKey = `rankings:${source.id}:${board.key}`;
    if (!refresh) {
      const cached = ctx.db.kv.get<CacheEntry>('novel.bookscan', cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.items.length > 0) {
        return c.json({ source: source.id, board: board.key, boardLabel: board.label, cached: true, fetchedAt: cached.fetchedAt, items: cached.items });
      }
    }

    try {
      const html = await fetchBoardHtml(source, board);
      // 番茄榜单页有防爬字体混淆：逐本回填详情页的干净书名与文案
      const items = source.id === 'fanqie'
        ? await enrichFanqieItems(source.parse(html))
        : source.parse(html);
      if (items.length === 0) throw new Error('榜单解析结果为空（页面结构可能已变化）');
      const entry: CacheEntry = { fetchedAt: Date.now(), items };
      await ctx.db.kv.set('novel.bookscan', cacheKey, entry);
      return c.json({ source: source.id, board: board.key, boardLabel: board.label, cached: false, fetchedAt: entry.fetchedAt, items });
    } catch (err) {
      // 失败兜底：有过期缓存就返回过期数据（标注 stale），否则报错 —— 不让单次抓取失败影响宿主
      const message = err instanceof Error ? err.message : String(err);
      const cached = ctx.db.kv.get<CacheEntry>('novel.bookscan', cacheKey);
      if (cached && cached.items.length > 0) {
        return c.json({ source: source.id, board: board.key, boardLabel: board.label, cached: true, stale: true, fetchedAt: cached.fetchedAt, items: cached.items, warning: '抓取失败，返回缓存: ' + message });
      }
      return c.json({ error: { code: 'FETCH_FAILED', message } }, 502);
    }
  });

  ctx.effect(() => ctx.routes.register('/api/plugins/bookscan', router), 'novel.bookscan: routes');
  ctx.logger.info('扫榜拆书 Server 面已挂载（/api/plugins/bookscan，书源：晋江/番茄/七猫）');
}
