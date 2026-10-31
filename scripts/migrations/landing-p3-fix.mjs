/**
 * landing-p3-fix.mjs — 让「不再做入场」的元素恢复可见
 *
 * 背景：P3 把落地页的入场动画从「每个区块各播一遍」收敛成「Hero 一次 + 功能列表一次」。
 * 但 landing.css 里这些区块的**初态**是 `opacity: 0`，靠 JS 淡入。
 * 删掉对应的 GSAP 调用后，它们会永远停在不可见 —— 页面看起来缺了一块。
 *
 * 本脚本只做一件事：把指定选择器规则块里的 `opacity: 0;` 与配套的 `transform: translateY(…)`
 * 初态删掉。不碰其它声明。
 *
 * 用法：node scripts/migrations/landing-p3-fix.mjs <landing.css> [--write]
 */

import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const write = process.argv.includes('--write');
if (!file) {
  console.error('用法: node landing-p3-fix.mjs <landing.css> [--write]');
  process.exit(1);
}

/** 这些选择器不再参与入场动画 ⇒ 必须可见 */
const TARGETS = [
  '.landing-section-divider',
  '.landing-section-title',
  '.landing-section-desc',
  '.landing-cta-title',
  '.landing-cta-subtitle',
  '.landing-cta-btn',
];

const lines = readFileSync(file, 'utf8').split('\n');
const changes = [];
let current = null;
let depth = 0;

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];

  // 进入目标规则块
  const selMatch = raw.match(/^(\.[a-zA-Z0-9_-]+)\s*\{/);
  if (selMatch && TARGETS.includes(selMatch[1])) {
    current = selMatch[1];
    depth = 1;
    continue;
  }

  if (current) {
    depth += (raw.match(/\{/g) ?? []).length;
    depth -= (raw.match(/\}/g) ?? []).length;

    if (depth <= 0) {
      current = null;
      continue;
    }

    if (/^\s*opacity:\s*0;\s*$/.test(raw)) {
      changes.push({ line: i + 1, sel: current, kind: 'opacity', text: raw.trim() });
      lines[i] = null;
    } else if (/^\s*transform:\s*translateY\(/.test(raw)) {
      changes.push({ line: i + 1, sel: current, kind: 'transform', text: raw.trim() });
      lines[i] = null;
    }
  }
}

console.log(`\n=== landing-p3-fix：${file} ===`);
for (const c of changes) console.log(`  L${String(c.line).padStart(4)}  ${c.sel.padEnd(26)} 移除 ${c.text}`);
console.log(`\n共 ${changes.length} 处`);

if (write) {
  // 去掉被置 null 的行，同时避免留下连续空行
  const out = [];
  for (const l of lines) {
    if (l === null) continue;
    out.push(l);
  }
  writeFileSync(file, out.join('\n'));
  console.log(`✅ 已写入 ${file}`);
} else {
  console.log('（干跑，未写入。加 --write 落盘）');
}
