// 间距规范度探针 —— 统计三个维度的「野值」数量。
// 用法: node scripts/tools/spacing-audit.mjs <rootDir> [label]
//   rootDir 里应有 apps/web/src 与 apps/plugins
// 野值定义见 docs/design/design-system.md「间距系统」：
//   合法 px = {0,2,4,6,8,10,12,16,20,24,32}；landing 页整段式页面留白 40/48/56/80/100/120/140 豁免。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2];
const label = process.argv[3] ?? root;
const LEGAL = new Set([0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32]);
const PAGE_LEVEL = new Set([40, 48, 56, 80, 100, 120, 140, 400]);
// Tailwind 数字档 → px
const TW_LEGAL = new Set(['0', '0.5', '1', '1.5', '2', '2.5', '3', '4', '5', '6', '8', '12']);

const SKIP = /node_modules|[\\/]dist[\\/]|\.git[\\/]/;
// landing.css 的整段式页面留白由该页自负（design-system.md 明文豁免），
// 且它的 18/22/28/30px 都嵌在 40/80/120px 这类页面节奏的简写里。
const SKIP_CSS = /landing\.css$/;
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules') walk(p); }
    else if (['.tsx', '.ts', '.css'].includes(extname(e))) files.push(p);
  }
})(root);

const tw = new Map(), inline = new Map(), css = new Map();
const samples = { tw: [], inline: [], css: [] };
const TW_RE = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-([0-9]+(?:\.[0-9]+)?)\b/g;
// 内联数值间距：gap: 8 / paddingTop: 3 / margin: '6px 12px' 里的 px 也抓
const INLINE_NUM = /\b(gap|rowGap|columnGap|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginTop|marginBottom|marginLeft|marginRight)\s*:\s*(-?[0-9]+)\b/g;
const INLINE_PX = /\b(gap|rowGap|columnGap|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginTop|marginBottom|marginLeft|marginRight)\s*:\s*'([^']*)'/g;
const INLINE_STR = /(-?[0-9.]+)px/g;
const CSS_DECL = /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:\s*([^;}]+)/g;
const CSS_PX = /(-?[0-9.]+)px/g;

const bump = (m, v, key, file) => { m.set(v, (m.get(v) ?? 0) + 1); if (samples[key].length < 60) samples[key].push(`${v}  ${file}`); };

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = f.slice(root.length + 1);
  if (f.endsWith('.css')) {
    if (SKIP_CSS.test(f)) continue;
    for (const d of src.matchAll(CSS_DECL)) {
      for (const p of d[2].matchAll(CSS_PX)) {
        const n = Math.round(parseFloat(p[1]));
        if (n <= 0 || PAGE_LEVEL.has(n) || LEGAL.has(n)) continue;
        bump(css, n, 'css', rel);
      }
    }
    continue;
  }
  // tsx/ts
  for (const m of src.matchAll(TW_RE)) if (!TW_LEGAL.has(m[1])) bump(tw, `${m[1]} (=${parseFloat(m[1]) * 4}px)`, 'tw', rel);
  for (const m of src.matchAll(INLINE_NUM)) {
    const n = parseInt(m[2], 10);
    if (n === 0 || LEGAL.has(Math.abs(n))) continue;
    if (n < 0) continue; // 负 margin 是布局手法
    bump(inline, n, 'inline', rel);
  }
  for (const m of src.matchAll(INLINE_PX)) {
    for (const p of m[2].matchAll(INLINE_STR)) {
      const n = Math.round(parseFloat(p[1]));
      if (n <= 0 || LEGAL.has(n)) continue;
      bump(inline, n, 'inline', rel);
    }
  }
}

const total = m => [...m.values()].reduce((a, b) => a + b, 0);
const show = (title, m, key) => {
  console.log(`\n## ${title} — 野值 ${total(m)} 处`);
  for (const [v, c] of [...m.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(8)}  ×${c}`);
  if (process.env.SAMPLES && samples[key].length) console.log('   例: ' + samples[key].slice(0, 12).join(' | '));
};

console.log(`\n================ 间距规范度 · ${label} ================`);
console.log(`扫描 ${files.length} 个文件`);
show('Tailwind 非法档位（tsx）', tw, 'tw');
show('内联样式非档位数值（tsx）', inline, 'inline');
show('CSS 文件非法 px（.css）', css, 'css');
console.log(`\n>>> 野值合计 ${total(tw) + total(inline) + total(css)} 处`);
