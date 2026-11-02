// ============================================================
// 章节写入「提案」工具 —— AI 想改正文时，只能提交提案，不能直接改
// ============================================================
//
// ## 为什么是「提案」而不是「写入」
//   正文是作者的作品本体。AI 直接覆盖正文的风险远高于改一个角色字段：
//   一次误判就是整章报废（本项目实测过 3333 字全废）。
//   所以本工具**不调 updateChapter**，只把「AI 想怎么写」打包成一条提案，
//   交给前端弹窗让作者**逐次确认**；作者点确认后，才由前端自己调
//   `updateChapter` 落库。
//
// ## 这条链路的三个保证
//   1. **服务端零写入**：本文件没有任何 `updateChapter` / `fs` 调用。
//      即使 AI 疯狂调用这个工具一万次，数据库也不会变。
//   2. **作者逐次确认**：提案必须经过前端确认弹窗，没有「一键全同意」。
//   3. **可追溯**：提案里带 `currentWordCount` 与 `preview`，确认框能显示
//      「从 N 字 → 变成 M 字」，作者在按下确认前就知道影响面。
//
// ## 与 SDK 的 `write_chapter` 的关系
//   `apps/server/src/ai/agents/sdk/tools.ts` 里那个 `write_chapter` 是
//   **真写**的，且被 `allowWriteChapter: false` 硬关着（从未启用）。
//   本文件是另一条独立链路（走 registry + `/api/ai/chat-stream` 的工具模式），
//   两边的安全模型不同，不要混用。

import { registerTool, type ToolHandlerResult, type ToolContext } from './registry.js';
import { listChapters } from '../../services/chapter-service.js';

/** 提案正文的长度上限 —— 超过就不是「改一段」，而是整章重写，需另行确认 */
const MAX_PROPOSAL_CHARS = 20000;

const proposeChapterEditTool = {
  definition: {
    type: 'function' as const,
    function: {
      name: 'propose_chapter_edit',
      description:
        '【提案，不是写入】向作者提出「这样改某一章正文」的建议。'
        + '调用本工具**不会修改任何内容** —— 作者会在界面上看到提案并手动确认，确认后才会真正写入。'
        + '用 chapterOrder（章节序号，从 1 开始）或 chapterTitle 指定目标章节；'
        + 'mode="append" 表示在现有正文末尾追加，mode="replace" 表示整章替换。'
        + '内容请直接给最终正文（纯文本即可，系统会自动转成段落格式）。'
        + '如果作者只是问意见、没让你写，就不要调这个工具，直接用文字回答。',
      parameters: {
        type: 'object',
        properties: {
          chapterOrder: { type: 'number', description: '目标章节序号（从 1 开始）' },
          chapterTitle: { type: 'string', description: '目标章节标题（可模糊匹配）' },
          mode: {
            type: 'string',
            enum: ['append', 'replace'],
            description: 'append=追加到现有正文末尾（推荐）；replace=整章替换（危险，慎用）',
          },
          content: { type: 'string', description: '要写入的正文（纯文本）' },
          reason: { type: 'string', description: '一句话说明为什么这样改，会显示在确认框里' },
        },
        required: ['content'],
      },
    },
  },
  async handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult> {
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) {
      return { success: false, result: '错误：content 为空，没有可提案的内容。' };
    }
    if (content.length > MAX_PROPOSAL_CHARS) {
      return {
        success: false,
        result: `错误：提案正文 ${content.length} 字，超过上限 ${MAX_PROPOSAL_CHARS} 字。`
          + `整章重写请分几次提案，或先告诉作者你的改写思路。`,
      };
    }

    const order = args.chapterOrder === undefined || args.chapterOrder === null
      ? null : Math.floor(Number(args.chapterOrder));
    const title = typeof args.chapterTitle === 'string' ? args.chapterTitle.trim() : '';
    const mode = args.mode === 'replace' ? 'replace' : 'append';
    const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 200) : '';

    const chapters = await listChapters(ctx.projectId);
    if (chapters.length === 0) {
      return { success: false, result: '本项目还没有章节，无法提案。请让作者先创建章节。' };
    }

    let target = order !== null ? chapters.find((c) => c.order === order) : undefined;
    if (!target && title) target = chapters.find((c) => c.title === title);
    if (!target && title) {
      target = chapters.find((c) => c.title.includes(title) || title.includes(c.title));
    }
    if (!target) {
      const want = order !== null ? `第 ${order} 章` : `「${title}」`;
      return {
        success: false,
        result: `未找到${want}。可用 list_chapters 查看现有章节，再重新提案。`,
      };
    }

    const currentChars = (target.content ?? '').replace(/<[^>]+>/g, '').trim().length;
    const nextChars = mode === 'append' ? currentChars + content.length : content.length;

    return {
      success: true,
      // ★ 措辞刻意强调「未写入」：这个字符串会进 LLM 的 tool 消息，
      //   如果写成「已写入」，模型会以为改完了，后续对话就会基于一个假事实继续。
      result:
        `【提案已提交，尚未写入】目标：第${target.order}章「${target.title}」`
        + `（${mode === 'append' ? '追加' : '整章替换'}，字数 ${currentChars} → ${nextChars}）。`
        + `作者确认后才会真正落库。若作者未确认，正文保持原样。`,
      entity: {
        type: 'chapter',
        action: 'propose',
        id: target.id,
        name: target.title,
        payload: {
          chapterId: target.id,
          chapterTitle: target.title,
          chapterOrder: target.order,
          mode,
          content,
          reason,
          currentChars,
          nextChars,
        },
      },
    };
  },
};

registerTool(proposeChapterEditTool.definition.function.name, proposeChapterEditTool.definition, proposeChapterEditTool.handler);
