// ============================================================
// 扫榜拆书 —— Web 面
// 扫榜 UI 内置于参考书「拆书」标签的「扫榜导入」区（BookAnalysis 内置集成，
// 数据走本插件 Server 面的 /api/plugins/bookscan/*）。
// 插件此处只注册 Ctrl+K 命令，通过自定义事件唤起拆书页里的扫榜导入区。
// ============================================================
import type { WebPluginContext } from '@novel/core/web';

/** 与手写台参考书面板（manual/workbench/web/editor/ReferenceReader.tsx）中的监听一致 */
const SCAN_IMPORT_OPEN_EVENT = 'nm:bookscan:open';

export const name = 'novel.bookscan';
export const inject = ['commands'];

export function apply(ctx: WebPluginContext): void {
  ctx.registerCommand({
    id: 'novel.bookscan.open',
    title: '扫榜拆书：打开榜单导入',
    keywords: ['扫榜', '榜单', '拆书', '晋江', '排行榜'],
    run: () => {
      window.dispatchEvent(new CustomEvent(SCAN_IMPORT_OPEN_EVENT));
      ctx.logger.info('[novel.bookscan] 已请求打开拆书页的扫榜导入区');
    },
  });
  ctx.logger.info('扫榜拆书 Web 面已挂载（UI 位于参考书「拆书」标签的扫榜导入区）');
}
