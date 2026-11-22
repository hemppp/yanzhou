// ============================================================
// 正文注入格式转换的单测
//
// 背景（UI 审计 E1）：AI 写作链路落库的 chapters.content
// 是**纯文本 + `\n\n` 分段**，而编辑器的 setContent(字符串) 按 HTML 解析 →
// 换行被当空白吞掉、整章并成一个段落（实测 64 段并成 1 段）。
//
// 这组用例锁死「纯文本 ↔ HTML」的对称契约：
// - plainTextToHtml 是 htmlToText 的逆函数
// - ensureHtmlContent 只转纯文本，已是 HTML 的一律原样返回（不能误伤）
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  htmlToText,
  isPlainText,
  plainTextToHtml,
  ensureHtmlContent,
} from '../entityDetector';

describe('isPlainText — 判定「不含任何 HTML 标签」', () => {
  it('纯文本返回 true', () => {
    expect(isPlainText('第一段\n\n第二段')).toBe(true);
  });

  it('含 <p> 的 HTML 返回 false', () => {
    expect(isPlainText('<p>段落</p>')).toBe(false);
  });

  it('含自闭合 <br/> 也算 HTML', () => {
    expect(isPlainText('一行<br/>另一行')).toBe(false);
  });

  it('空串按纯文本处理（无标签）', () => {
    expect(isPlainText('')).toBe(true);
  });

  it('数学/文学里的裸 < 不被误判为标签', () => {
    // `<` 后面不是字母开头 → 不是标签
    expect(isPlainText('1 < 2 且 a<b')).toBe(true);
  });

  it('带属性的标签能识别', () => {
    expect(isPlainText('<span class="x">字</span>')).toBe(false);
  });
});

describe('plainTextToHtml — 纯文本转 HTML', () => {
  it('★ 核心回归：5 段纯文本 → 5 个 <p>', () => {
    // 这正是报告里「注入 5 段 → p 只有 1 个」那条
    const plain = '第一段\n\n第二段\n\n第三段\n\n第四段\n\n第五段';
    const html = plainTextToHtml(plain);
    expect(html.match(/<p>/g)?.length).toBe(5);
    expect(html).toBe(
      '<p>第一段</p><p>第二段</p><p>第三段</p><p>第四段</p><p>第五段</p>',
    );
  });

  it('单个 \\n（段内换行）→ <br> 而不是新段落', () => {
    expect(plainTextToHtml('上行\n下行')).toBe('<p>上行<br>下行</p>');
  });

  it('连续空行只当一个段界（与项目其它处 split(/\\n\\n/) 的口径一致）', () => {
    // HTML 的 <p> 之间本就靠边距撑开，tiptap 也会按 schema 归一化，
    // 空 <p> 无法无损保留 → 统一按「空行=段界」处理，与 StyleAdvisor 等既有实现对齐。
    expect(plainTextToHtml('一\n\n\n\n二')).toBe('<p>一</p><p>二</p>');
  });

  it('\\r\\n（Windows 换行）与 \\r 都归一为段落', () => {
    expect(plainTextToHtml('一\r\n\r\n二')).toBe('<p>一</p><p>二</p>');
    expect(plainTextToHtml('一\r\r二')).toBe('<p>一</p><p>二</p>');
  });

  it('转义 HTML 特殊字符，正文里的 < & > 不会被当标签', () => {
    const html = plainTextToHtml('if (a < b && c > d)');
    expect(html).toBe('<p>if (a &lt; b &amp;&amp; c &gt; d)</p>');
    // 转义后再喂回 htmlToText 应能还原（往返不丢字）
    expect(htmlToText(html)).toBe('if (a < b && c > d)\n');
  });

  it('空串返回空串', () => {
    expect(plainTextToHtml('')).toBe('');
  });

  it('首尾多余空行不产生前导/尾随空段落', () => {
    expect(plainTextToHtml('\n\n正文\n\n')).toBe('<p>正文</p>');
  });
});

describe('plainTextToHtml ↔ htmlToText 往返对称', () => {
  it('多段纯文本往返后段落数不变', () => {
    const plain = '第一段\n\n第二段\n\n第三段';
    const roundTrip = htmlToText(plainTextToHtml(plain));
    // htmlToText 每个 </p> 补一个 \n，故末尾多一个
    expect(roundTrip).toBe('第一段\n第二段\n第三段\n');
    expect(roundTrip.split('\n').filter(Boolean).length).toBe(3);
  });

  it('64 段长正文（贴近实测章节规模）不丢段', () => {
    const paras = Array.from({ length: 64 }, (_, i) => `第 ${i + 1} 段正文内容`);
    const html = plainTextToHtml(paras.join('\n\n'));
    expect(html.match(/<p>/g)?.length).toBe(64);
    expect(htmlToText(html).split('\n').filter(Boolean).length).toBe(64);
  });
});

describe('ensureHtmlContent — 注入前的安全闸门', () => {
  it('★ 纯文本被转换（AI 落库正文走这条）', () => {
    expect(ensureHtmlContent('一段\n\n二段')).toBe('<p>一段</p><p>二段</p>');
  });

  it('★ 已是 HTML 的原样返回，不被转义破坏（编辑器自身内容走这条）', () => {
    const html = '<p>已有<b>加粗</b>的段落</p>';
    expect(ensureHtmlContent(html)).toBe(html);
  });

  it('空串返回空串（不会有 <p></p> 之类的多余产物）', () => {
    expect(ensureHtmlContent('')).toBe('');
  });

  it('含 <hr> 的旧缓存内容被识别为 HTML，不做二次转换', () => {
    // EditorPage 会先剔除 hr，此处只验证判定不误伤
    const html = '<p>正文</p><hr>';
    expect(ensureHtmlContent(html)).toBe(html);
  });
});
