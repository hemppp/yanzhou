// ============================================================
// 对话助手 Agent - 小说写作对话模式
//
// 支持按 phase 字段分发不同业务场景的 prompt：
//   - 默认：通用创作伙伴对话
//   - 小说对话：带章节/角色上下文的写作问答
//   - 大纲撰写：根据已有大纲为目标分区续写草稿
//   - 大纲优化：优化已有分区内容
//   - 大纲生成：根据主题生成完整大纲
//   - 卡文诊断：诊断卡文原因并给出建议
//   - 续写提示：基于卡文诊断生成多个续写开头
//   - 风格改写：按风格档案改写文本
// ============================================================

import type { ChatMessage, StreamChunk } from '../providers/provider-factory.js';
import { parseAgentJson } from './utils.js';
import { getSkillSystemPrompt } from './skills.js';

/**
 * 对话助手 Agent 输入
 *
 * 字段分类：
 *  - 通用：userMessage / conversationHistory / projectName / phase
 *  - 默认对话：currentChapter / keyCharacters / keyThemes
 *  - 小说对话：chapterTitle / characterNames / chapterContent
 *  - 大纲撰写：partitionTitle / partitionPlaceholder / previousSections
 *  - 大纲优化：sectionTitle / sectionContent
 *  - 大纲生成：topic / genre
 *  - 卡文诊断：currentParagraph / precedingParagraphs / charactersInScene / location / knowledgeBaseContext
 *  - 续写提示：currentParagraph / blockType / blockReason / atmosphere / writingTips / promptCount
 *  - 风格改写：text / styleProfile
 */
export interface ChatInput {
  /** 对话历史 */
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[];
  /** 用户最新消息（phase 场景下可空，由后端组装） */
  userMessage?: string;
  /** 项目名称 */
  projectName?: string;
  /** 当前章节（默认对话场景） */
  currentChapter?: string;
  /** 关键角色（默认对话场景） */
  keyCharacters?: string;
  /** 关键主题（默认对话场景） */
  keyThemes?: string;
  /** 当前创作阶段 / 业务场景标识 */
  phase?:
    | '小说对话'
    | '大纲撰写'
    | '大纲优化'
    | '大纲生成'
    | '卡文诊断'
    | '续写提示'
    | '风格改写'
    // ---- 新增 phase ----
    | '章节分析'    // 分析当前章节，识别角色对话和叙事描写
    | '智能续写'    // 结合大纲+前三章+所有模块上下文，给出续写建议
    | string;

  // ---- 技能选择器（用户主动激活的专家模式）----
  /** 激活的技能 ID（如 'character-analyst'），叠加专属 prompt + 注入上下文 */
  skillId?: string;
  /** 前端按技能 contextKeys 收集并格式化的实体上下文文本 */
  extraContext?: string;

  // ---- 智能续写 / 章节分析 场景 ----
  /** 后端构建的完整项目上下文（大纲+角色+地点+物品+伏笔+事件+前三章等） */
  enhancedContext?: string;
  /** 前三章内容（按 order 排序，用于续写分析） */
  previousChapters?: string[];

  // ---- 小说对话场景 ----
  /** 当前章节标题 */
  chapterTitle?: string;
  /** 出场角色名列表 */
  characterNames?: string[];
  /** 当前章节内容（可截断） */
  chapterContent?: string;

  // ---- 大纲撰写场景 ----
  /** 目标分区标题 */
  partitionTitle?: string;
  /** 目标分区的预期方向 / 占位描述 */
  partitionPlaceholder?: string;
  /** 已有前置分区列表 */
  previousSections?: { title: string; content: string }[];

  // ---- 大纲优化场景 ----
  /** 待优化的分区标题 */
  sectionTitle?: string;
  /** 待优化的分区原文 */
  sectionContent?: string;

  // ---- 大纲生成场景 ----
  /** 大纲主题 */
  topic?: string;
  /** 类型 / 风格 */
  genre?: string;

  // ---- 卡文诊断场景 ----
  /** 当前段落（卡文位置） */
  currentParagraph?: string;
  /** 前文段落列表 */
  precedingParagraphs?: string[];
  /** 出场角色列表 */
  charactersInScene?: string[];
  /** 当前地点 */
  location?: string;
  /** 知识库上下文（角色库/地点库/物品库等已拼好的字符串列表） */
  knowledgeBaseContext?: string[];

  // ---- 续写提示场景 ----
  /** 卡文类型 */
  blockType?: string;
  /** 卡文原因 */
  blockReason?: string;
  /** 场景氛围 */
  atmosphere?: string;
  /** 写作技巧建议 */
  writingTips?: string[];
  /** 续写提示数量 */
  promptCount?: number;

  // ---- 风格改写场景 ----
  /** 待改写的文本 */
  text?: string;
  /** 风格档案 */
  styleProfile?: {
    sentenceLength?: string;
    perspective?: string;
    dialogueStyle?: string;
    paragraphLength?: string;
  };
}

/**
 * 对话助手 Agent 输出（结构化版本）
 */
export interface ChatResult {
  response: string;
  questions: string[];
  suggestions: string[];
  insights: string[];
  emotionalSupport: string;
  nextSteps: string[];
  contextualAwareness: {
    characterDevelopment: string;
    plotProgression: string;
    themeExploration: string;
    worldbuildingConsistency: string;
  };
}

// ============================================================
// Prompt 模板
// ============================================================

// ---- 默认对话场景 ----

const DEFAULT_SYSTEM_PROMPT = `你是一个专业的写作伙伴，专门用于与作家进行创作对话。你的任务是作为创作伙伴，提供有深度的反馈、建议和讨论，帮助作家完善作品。

对话原则：
1. 保持专业但友好的语气
2. 以提问引导思考，而不是直接给出答案
3. 尊重作家的创作意图和选择
4. 提供具体、可操作的建议
5. 鼓励探索多种可能性
6. 在适当时候提供情感支持
7. 保持对故事世界的深入了解
8. 避免过度干预，让作家保持主导权

请根据当前对话上下文，以创作伙伴的身份进行回应。`;

// ---- 小说对话场景 ----

const NOVEL_CHAT_SYSTEM_PROMPT = `你是一个小说写作助手。你的任务是阅读当前章节内容，回答作者关于剧情、角色、设定的问题，提供具体建议。

行为准则：
1. 优先基于"当前章节内容"作答，引用原文细节来支撑你的回答
2. 当作者询问"这一段怎么样""帮我看看这里"时，明确指出是章节中的哪一部分
3. 当作者要求修改/改写时，给出修改后的具体文本，并说明改动理由
4. 当作者询问角色动机、伏笔设置、节奏安排时，结合章节内容分析
5. 如果章节内容不足以回答（如询问后续剧情），明确告知并给出建议
6. 保持简洁，避免空话套话

当作者上传了"当前章节内容"时，你必须完整阅读后再回答。`;

// ---- 大纲撰写场景 ----

const OUTLINE_CONTINUE_SYSTEM_PROMPT = `你是一个小说大纲撰写助手。你的任务是根据已有大纲内容，为指定分区撰写 100-200 字的草稿。

要求：
1. 保持与已有内容风格一致
2. 符合该分区的预期方向
3. 内容具体、有画面感

直接给出草稿内容，不要解释。`;

// ---- 大纲优化场景 ----

const OUTLINE_OPTIMIZE_SYSTEM_PROMPT = `你是一个小说大纲优化助手。你的任务是优化已有分区内容，使其更清晰、更有结构、更有画面感。

要求：
1. 保留核心信息
2. 可以重组段落、补充细节、强化冲突或人物动机

直接给出优化后的版本，不要解释改动。`;

// ---- 大纲生成场景 ----

const OUTLINE_GENERATE_SYSTEM_PROMPT = `你是一个小说大纲生成助手。你的任务是根据主题和类型，生成一份完整的小说大纲（8-12 个分区）。

可用分区类型（按需取舍）：
- 一句话故事
- 核心主题
- 故事背景
- 主要人物
- 核心冲突
- 故事梗概
- 结构框架
- 开场与结尾
- 伏笔与悬念
- 基调与意象
- 备注

请返回 JSON 数组，每项 { "title": "分区标题", "content": "分区内容" }。只输出 JSON，不要其他文字。`;

// ---- 卡文诊断场景 ----

const WRITER_BLOCK_DIAGNOSE_SYSTEM_PROMPT = `你是一位资深小说写作指导师。作者当前卡文了，请诊断卡文原因并提供帮助。

请分析以下内容，按格式返回：

1. 卡文类型：从以下选项中选择最匹配的一个：
   - 场景描写（环境、景物、氛围描写困难）
   - 人物描写（外貌、神态、特征描写困难）
   - 动作描写（打斗、动作序列描写困难）
   - 对话描写（角色对白设计困难）
   - 情感描写（心理、情感表达困难）
   - 环境气氛（天气、光影、声音渲染困难）
   - 过渡转换（场景切换、承上启下困难）
   - 心理描写（内心独白、思想描写困难）
   - 其他

2. 卡文原因：1-2句话分析为什么作者在此处卡住

3. 氛围：[1-2个关键词]

4. 节奏：[快/中/慢]

5. 感官元素：[3-5个建议增加的感官描写关键词，用逗号分隔]

6. 写作技巧：[3-5条针对此卡文类型的具体写作建议，每条不超过30字]

7. 剧情走向：[1句话建议接下来的情节方向]

只返回分析结果，不要其他解释。`;

// ---- 续写提示场景 ----

const WRITER_BLOCK_PROMPT_SYSTEM_PROMPT = `你是一个小说续写助手。你的任务是基于场景和卡文诊断，以第三人称续写若干个不同风格的开头段落（约 50 字）。

要求：
1. 风格要求：写实、诗意、紧张（选择 3 种不同风格）
2. 特别关注卡文类型方面的描写
3. 每个开头用 | 分隔
4. 风格标注：[写实] [诗意] [紧张]`;

// ---- 风格改写场景 ----

const STYLE_REWRITE_SYSTEM_PROMPT = `你是一个写作风格改写助手。你的任务是将给定文本按指定风格档案改写。

要求：
1. 保持原文的核心内容和情节
2. 调整句子长度符合指定风格
3. 对话风格符合指定风格
4. 段落长度符合指定风格

直接给出改写后的文本，不要解释。`;

// ---- 章节分析场景 ----

const CHAPTER_ANALYSIS_SYSTEM_PROMPT = `你是一个小说章节分析助手。你的任务是分析当前章节内容，识别出所有角色对话和叙事描写，并按结构化格式输出。

输出格式要求：

【角色对话】
- 角色A（角色定位标签）：“对话内容”
- 角色B（角色定位标签）：“对话内容”

【叙事描写】
- 此处输出环境描写、动作描写、心理活动、氛围渲染等非对话内容

【本章要点】
- 本章推进的核心情节：1-2 句话概括
- 角色关系变化：如有变化则描述

分析原则：
1. 严格基于章节原文内容，不编造不存在的对话或描写
2. 角色定位标签从提供的角色设定中获取（如主角、女主、配角等）
3. 对话内容保持原文措辞，不缩写不改写
4. 叙事描写部分用简洁语言概括，不是原文照搬
5. 若无角色资料，仅按角色名输出定位`;

// ---- 智能续写场景 ----

const SMART_CONTINUE_SYSTEM_PROMPT = `你是一个小说智能续写助手。你的任务是结合大纲规划、前三章内容、所有角色和世界观设定，为当前章节提供续写建议。

以下是你将收到的完整上下文：

【大纲规划】小说的整体结构规划，指示当前章节应达到的情节目标
【前三章内容】当前章节之前的最新 3 章内容，展示故事进展到哪了
【角色设定】所有角色的定位、性格、外貌、说话风格等
【世界观设定】地点、物品、伏笔、事件等背景信息
【当前章节】作者正在写的章节内容

请按以下结构输出（直接给出内容，不要额外解释）：

## 当前进展分析
1-2 句话概括当前章节写到了哪，是否与大纲规划一致。

## 续写方向建议
提供 2-3 个不同的续写方向，每个方向一句话说明。

## 推荐续写（约 200 字）
从上述方向中选一个最推荐的，输出一段约 200 字的续写文本。
要求：
1. 风格与原文保持一致
2. 自然融入当前章节的场景和角色
3. 体现角色定位和性格特点
4. 语言流畅，有画面感

注意：续写内容将直接插入正文，请确保：
- 与当前章节无缝衔接
- 不重复已有内容
- 不使用 Markdown 格式，使用纯文本`;

// ============================================================
// 默认对话场景的 Prompt 构建
// ============================================================

function buildDefaultUserPrompt(input: ChatInput): string {
  return [
    '请以创作伙伴的身份回应以下对话：',
    '',
    input.conversationHistory && input.conversationHistory.length > 0
      ? `对话历史：\n${input.conversationHistory.map((m) => `[${m.role}]: ${m.content}`).join('\n')}\n`
      : '',
    '当前上下文：',
    input.projectName ? `- 项目名称：${input.projectName}` : '',
    input.currentChapter ? `- 当前章节：${input.currentChapter}` : '',
    input.keyCharacters ? `- 关键角色：${input.keyCharacters}` : '',
    input.keyThemes ? `- 关键主题：${input.keyThemes}` : '',
    input.phase ? `- 当前创作阶段：${input.phase}` : '',
    '',
    `作家的最新消息：\n${input.userMessage || ''}`,
    '',
    '请以创作伙伴的身份进行回应，提供有深度的反馈和建议。',
  ].join('\n');
}

function buildOutputFormatSection(): string {
  return `
请按以下 JSON 格式输出回应（只输出 JSON，不要包含其他文字）：

{
  "response": "主回应内容（使用中文，自然流畅）",
  "questions": ["引导性提问"],
  "suggestions": ["具体可操作的建议"],
  "insights": ["深入的洞察"],
  "emotionalSupport": "情感支持的话语",
  "nextSteps": ["下一步建议"],
  "contextualAwareness": {
    "characterDevelopment": "角色发展方面的观察",
    "plotProgression": "情节推进方面的观察",
    "themeExploration": "主题探索方面的观察",
    "worldbuildingConsistency": "世界观一致性方面的观察"
  }
}`;
}

// ============================================================
// 各业务场景的 Prompt 构建
// ============================================================

/** 小说对话场景：构建用户消息 */
function buildNovelChatUserMessage(input: ChatInput): string {
  const sections: string[] = [];
  if (input.chapterContent) {
    // 放宽到 8000 字（约 1.5 万 token），覆盖中短篇章节
    const truncated = input.chapterContent.length > 8000
      ? input.chapterContent.slice(0, 8000) + '\n\n[... 章节内容过长，已截断至前 8000 字 ...]'
      : input.chapterContent;
    sections.push('【当前章节内容】\n' + truncated);
  }
  if (input.userMessage && input.userMessage.trim()) {
    sections.push('【作者提问】\n' + input.userMessage);
  }
  return sections.filter(Boolean).join('\n\n');
}

/** 小说对话场景：构建系统上下文 */
function buildNovelChatSystemContext(input: ChatInput): string {
  return [
    '当前章节：' + (input.chapterTitle || '未命名'),
    '出场角色：' + (input.characterNames?.join('、') || '未明确'),
    input.chapterContent
      ? `章节内容长度：${input.chapterContent.length} 字`
      : '（未提供章节内容）',
  ].join('\n');
}

/** 大纲撰写场景：构建用户消息 */
function buildOutlineContinueUserMessage(input: ChatInput): string {
  const context = (input.previousSections || [])
    .filter((s) => s.content && s.content.trim())
    .map((s) => '【' + s.title + '】\n' + s.content.trim())
    .join('\n\n');

  const placeholderPart = input.partitionPlaceholder
    ? '该分区的预期方向：' + input.partitionPlaceholder + '\n'
    : '';
  const contextPart = context
    ? '\n已有内容：\n' + context
    : '\n（暂无前置内容，可自由发挥）';

  return (
    '请根据以下已有大纲内容，为分区「' +
    (input.partitionTitle || '') +
    '」撰写一段草稿（100-200 字）。\n' +
    placeholderPart +
    contextPart
  );
}

/** 大纲优化场景：构建用户消息 */
function buildOutlineOptimizeUserMessage(input: ChatInput): string {
  return (
    '请优化以下分区「' +
    (input.sectionTitle || '') +
    '」的内容，使其更清晰、更有结构、更有画面感。\n' +
    '保留核心信息，但可以重组段落、补充细节、强化冲突或人物动机。\n' +
    '直接给出优化后的版本，不要解释改动。\n\n' +
    '原文：\n' +
    (input.sectionContent || '')
  );
}

/** 大纲生成场景：构建用户消息 */
function buildOutlineGenerateUserMessage(input: ChatInput): string {
  const genrePart = input.genre ? '类型 / 风格：' + input.genre + '\n' : '';
  return (
    '请根据以下信息，生成一份完整的小说大纲（8-12 个分区）。\n' +
    '主题：' +
    (input.topic || '') +
    '\n' +
    genrePart +
    '\n请用以下分区类型（按需取舍）：一句话故事 / 核心主题 / 故事背景 / 主要人物 / ' +
    '核心冲突 / 故事梗概 / 结构框架 / 开场与结尾 / 伏笔与悬念 / 基调与意象 / 备注。\n' +
    '\n返回 JSON 数组，每项 { title, content }。'
  );
}

/** 卡文诊断场景：构建用户消息 */
function buildWriterBlockDiagnoseUserMessage(input: ChatInput): string {
  const kbContext = (input.knowledgeBaseContext || []).join('\n\n');
  return [
    '【当前段落（卡文位置）】',
    input.currentParagraph || '(空白段落 - 作者在此卡住了)',
    '',
    '【前文】',
    (input.precedingParagraphs || []).join('\n') || '(无)',
    '',
    '【出场角色】',
    (input.charactersInScene || []).join('、') || '未明确',
    '',
    '【当前地点】',
    input.location || '未明确',
    '',
    kbContext,
  ].filter(Boolean).join('\n');
}

/** 续写提示场景：构建用户消息 */
function buildWriterBlockPromptUserMessage(input: ChatInput): string {
  const count = input.promptCount && input.promptCount > 0 ? input.promptCount : 3;
  return [
    `基于以下场景和卡文诊断，以第三人称续写 ${count} 个不同风格的开头段落（约 50 字）：`,
    '',
    '【场景】',
    input.currentParagraph || '(当前为空白段落)',
    '',
    '【卡文类型】',
    input.blockType || '',
    '',
    '【卡文原因】',
    input.blockReason || '',
    '',
    '【氛围】',
    input.atmosphere || '',
    '',
    '【写作建议】',
    (input.writingTips || []).join('；'),
    '',
    '【要求】',
    '风格要求：写实、诗意、紧张（选择 3 种不同风格）',
    `特别关注${input.blockType || '相关'}方面的描写`,
    '每个开头用 | 分隔',
    '风格标注：[写实] [诗意] [紧张]',
  ].join('\n');
}

/** 风格改写场景：构建用户消息 */
function buildStyleRewriteUserMessage(input: ChatInput): string {
  const profile = input.styleProfile || {};
  const profileDesc = [
    profile.sentenceLength ? `句子长度：${profile.sentenceLength}` : '',
    profile.perspective ? `叙事视角：${profile.perspective}` : '',
    profile.dialogueStyle ? `对话风格：${profile.dialogueStyle}` : '',
    profile.paragraphLength ? `段落长度：${profile.paragraphLength}` : '',
  ].filter(Boolean).join('\n');

  return [
    `请将以下文本改写为符合下方风格档案的写作风格：`,
    '',
    '【风格档案】',
    profileDesc,
    '',
    '【原文】',
    input.text || '',
    '',
    '【要求】',
    '1. 保持原文的核心内容和情节',
    profile.sentenceLength ? `2. 调整句子长度符合"${profile.sentenceLength}"风格` : '',
    profile.dialogueStyle ? `3. 对话风格符合"${profile.dialogueStyle}"` : '',
    profile.paragraphLength ? `4. 段落长度符合"${profile.paragraphLength}"` : '',
    '',
    '改写后的文本：',
  ].filter(Boolean).join('\n');
}

/** 章节分析场景：构建用户消息 */
function buildChapterAnalysisUserMessage(input: ChatInput): string {
  const sections: string[] = [];

  if (input.enhancedContext) {
    sections.push('【项目全局上下文】\n' + input.enhancedContext);
  }

  if (input.chapterTitle) {
    sections.push('【当前章节】' + input.chapterTitle);
  }

  if (input.chapterContent) {
    const truncated = input.chapterContent.length > 6000
      ? input.chapterContent.slice(0, 6000) + '\n\n[... 内容过长，已截断至前 6000 字 ...]'
      : input.chapterContent;
    sections.push('【当前章节内容】\n' + truncated);
  }

  if (input.characterNames && input.characterNames.length > 0) {
    sections.push('【出场角色】\n' + input.characterNames.join('、'));
  }

  sections.push('');
  sections.push('请按【角色对话】/【叙事描写】/【本章要点】的结构分析以上章节内容。');

  return sections.join('\n\n');
}

/** 智能续写场景：构建用户消息 */
function buildSmartContinueUserMessage(input: ChatInput): string {
  const sections: string[] = [];

  if (input.enhancedContext) {
    sections.push('【项目全局上下文】\n' + input.enhancedContext);
  }

  if (input.chapterTitle) {
    sections.push('【当前章节标题】' + input.chapterTitle);
  }

  if (input.chapterContent) {
    const truncated = input.chapterContent.length > 4000
      ? input.chapterContent.slice(0, 4000) + '\n\n[... 内容过长，已截断至前 4000 字 ...]'
      : input.chapterContent;
    sections.push('【当前章节内容】\n' + truncated);
  }

  if (input.userMessage && input.userMessage.trim()) {
    sections.push('【作者补充说明】\n' + input.userMessage);
  }

  sections.push('');
  sections.push('请分析当前章节进展，给出续写方向建议和推荐续写文本。续写文本将直接插入正文，请使用纯文本。');

  return sections.join('\n\n');
}

// ============================================================
// 技能叠加段落
// ============================================================

/**
 * 构造技能叠加段落：技能专属 system prompt + 前端注入的实体上下文。
 * 若未激活技能，返回空字符串（不影响默认对话）。
 */
function buildSkillSection(input: ChatInput): string {
  const skillPrompt = getSkillSystemPrompt(input.skillId);
  if (!skillPrompt && !input.extraContext) return '';
  const parts: string[] = [];
  if (skillPrompt) parts.push(skillPrompt);
  if (input.extraContext) parts.push(`【技能注入上下文】\n${input.extraContext}`);
  return '\n\n' + parts.join('\n\n');
}

// ============================================================
// 按 phase 分发 system prompt 与 user message
// ============================================================

interface PhasePrompt {
  systemPrompt: string;
  userMessage: string;
}

/**
 * 根据 input.phase 构建对应的 system prompt 与 user message。
 * 若 phase 缺失或未匹配到业务场景，返回 null（走默认对话逻辑）。
 */
function buildPhasePrompt(input: ChatInput): PhasePrompt | null {
  switch (input.phase) {
    case '小说对话': {
      // ★ 技能叠加：在小说对话 system prompt 基础上追加技能专属指导 + 注入上下文
      const skillSection = buildSkillSection(input);
      return {
        systemPrompt: `${NOVEL_CHAT_SYSTEM_PROMPT}\n\n${buildNovelChatSystemContext(input)}${skillSection}`,
        userMessage: buildNovelChatUserMessage(input),
        // ★ 小说对话也支持多轮：把历史拼进 user message 尾部
        // (实际历史会通过 messages 数组追加，见 runChatAgentSimple)
      };
    }
    case '大纲撰写':
      return {
        systemPrompt: OUTLINE_CONTINUE_SYSTEM_PROMPT,
        userMessage: buildOutlineContinueUserMessage(input),
      };
    case '大纲优化':
      return {
        systemPrompt: OUTLINE_OPTIMIZE_SYSTEM_PROMPT,
        userMessage: buildOutlineOptimizeUserMessage(input),
      };
    case '大纲生成':
      return {
        systemPrompt: OUTLINE_GENERATE_SYSTEM_PROMPT,
        userMessage: buildOutlineGenerateUserMessage(input),
      };
    case '卡文诊断':
      return {
        systemPrompt: WRITER_BLOCK_DIAGNOSE_SYSTEM_PROMPT,
        userMessage: buildWriterBlockDiagnoseUserMessage(input),
      };
    case '续写提示':
      return {
        systemPrompt: WRITER_BLOCK_PROMPT_SYSTEM_PROMPT,
        userMessage: buildWriterBlockPromptUserMessage(input),
      };
    case '风格改写':
      return {
        systemPrompt: STYLE_REWRITE_SYSTEM_PROMPT,
        userMessage: buildStyleRewriteUserMessage(input),
      };
    case '章节分析':
      return {
        systemPrompt: `${CHAPTER_ANALYSIS_SYSTEM_PROMPT}\n\n${input.enhancedContext ? '注意：以下提供了完整的项目上下文（角色设定等），分析时据此标注角色定位。' : ''}`,
        userMessage: buildChapterAnalysisUserMessage(input),
      };
    case '智能续写':
      return {
        systemPrompt: `${SMART_CONTINUE_SYSTEM_PROMPT}\n\n${input.enhancedContext ? '以上是完整的项目上下文。' : ''}`,
        userMessage: buildSmartContinueUserMessage(input),
      };
    default:
      return null;
  }
}

// ============================================================
// Agent 执行函数
// ============================================================

/**
 * 运行对话助手（结构化输出）
 */
export async function runChatAgent(
  chat: (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }, signal?: AbortSignal) => Promise<string>,
  input: ChatInput,
  options?: { signal?: AbortSignal },
): Promise<ChatResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildDefaultUserPrompt(input) + '\n\n' + buildOutputFormatSection(),
    },
  ];

  const response = await chat(messages, {
    temperature: 0.7,
    maxTokens: 8192,
  }, options?.signal);

  const parsed = parseAgentJson(response, 'ChatAgent');

  return {
    response: (parsed.response as string) || '',
    questions: (parsed.questions as string[]) || [],
    suggestions: (parsed.suggestions as string[]) || [],
    insights: (parsed.insights as string[]) || [],
    emotionalSupport: (parsed.emotionalSupport as string) || '',
    nextSteps: (parsed.nextSteps as string[]) || [],
    contextualAwareness: {
      characterDevelopment:
        (parsed.contextualAwareness as Record<string, string>)
          ?.characterDevelopment || '',
      plotProgression:
        (parsed.contextualAwareness as Record<string, string>)
          ?.plotProgression || '',
      themeExploration:
        (parsed.contextualAwareness as Record<string, string>)
          ?.themeExploration || '',
      worldbuildingConsistency:
        (parsed.contextualAwareness as Record<string, string>)
          ?.worldbuildingConsistency || '',
    },
  };
}

/**
 * 简化版对话：仅返回自然文本回应（用于流式输出 / phase 业务场景）
 *
 * 行为：
 *  - 若 input.phase 命中已知业务场景，则使用对应 prompt 模板组装消息
 *  - 否则走默认对话逻辑：system prompt + 对话历史 + 用户消息
 */
export async function runChatAgentSimple(
  chat: (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }, signal?: AbortSignal) => Promise<string>,
  input: ChatInput,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const phasePrompt = buildPhasePrompt(input);

  // phase 命中业务场景：使用对应 prompt 模板
  if (phasePrompt) {
    const messages: ChatMessage[] = [
      { role: 'system', content: phasePrompt.systemPrompt },
    ];

    // ★ 小说对话场景：支持多轮对话历史
    // 章节内容只放在第一条 user 消息中（避免每轮重复发送大段章节内容浪费 token）
    if (input.phase === '小说对话' && input.conversationHistory && input.conversationHistory.length > 0) {
      // 第一条 user 消息：章节内容 + 第一条用户提问
      messages.push({ role: 'user', content: phasePrompt.userMessage });
      // 后续历史消息按原顺序追加（跳过 conversationHistory[0]，因为它已经合并到上面）
      for (let i = 1; i < input.conversationHistory.length; i++) {
        const m = input.conversationHistory[i];
        messages.push({ role: m.role, content: m.content });
      }
    } else if (phasePrompt.userMessage) {
      // 其他 phase：单轮 user 消息
      messages.push({ role: 'user', content: phasePrompt.userMessage });
    }

    const response = await chat(messages, {
      temperature: 0.7,
      // ★ 8192：推理模型（reasoning）会先耗预算产思维链，2048 时正文 content 可能为空串
      //   （finish_reason='length'）→ 上层回落占位默认值且 success:true（假绿）。
      maxTokens: 8192,
    }, options?.signal);
    return response;
  }

  // 默认对话逻辑
  const conversationMessages: ChatMessage[] = [];
  if (input.conversationHistory) {
    for (const m of input.conversationHistory) {
      conversationMessages.push(m);
    }
  }

  const systemContext = [
    '你是一个专业的写作伙伴。当前上下文：',
    input.projectName ? `项目：${input.projectName}` : '',
    input.currentChapter ? `当前章节：${input.currentChapter}` : '',
    input.keyCharacters ? `关键角色：${input.keyCharacters}` : '',
    input.keyThemes ? `关键主题：${input.keyThemes}` : '',
    input.phase ? `创作阶段：${input.phase}` : '',
  ]
    .filter(Boolean)
    .join('；');

  const messages: ChatMessage[] = [
    { role: 'system', content: `${DEFAULT_SYSTEM_PROMPT}\n\n${systemContext}${buildSkillSection(input)}` },
    ...conversationMessages,
    { role: 'user', content: input.userMessage || '' },
  ];

  const response = await chat(messages, {
    temperature: 0.7,
    // ★ 8192：推理模型思维链预算（见上方同类说明）
    maxTokens: 8192,
  }, options?.signal);

  return response;
}

// ============================================================
// 流式版本（SSE）— 修复"假流式"问题
// ============================================================

/**
 * 流式简化版对话：逐 chunk yield AI 回复文本和思考内容。
 *
 * 与 runChatAgentSimple 的区别：
 *  - 接收 chatStream（AsyncGenerator<StreamChunk>）而非 chat（Promise<string>）
 *  - 每收到一个 chunk 立即 yield，前端可实时渲染
 *  - 消息组装逻辑与 runChatAgentSimple 完全一致（复用 buildPhasePrompt）
 *
 * 用于 POST /ai/chat-stream SSE 路由。
 */
export async function* runChatAgentSimpleStream(
  chatStream: (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }, signal?: AbortSignal) => AsyncGenerator<StreamChunk>,
  input: ChatInput,
  options?: { signal?: AbortSignal },
): AsyncGenerator<StreamChunk> {
  const phasePrompt = buildPhasePrompt(input);

  // phase 命中业务场景
  if (phasePrompt) {
    const messages: ChatMessage[] = [
      { role: 'system', content: phasePrompt.systemPrompt },
    ];

    // ★ 小说对话场景：支持多轮对话历史（与 runChatAgentSimple 一致）
    if (input.phase === '小说对话' && input.conversationHistory && input.conversationHistory.length > 0) {
      messages.push({ role: 'user', content: phasePrompt.userMessage });
      for (let i = 1; i < input.conversationHistory.length; i++) {
        const m = input.conversationHistory[i]!;
        messages.push({ role: m.role, content: m.content });
      }
    } else if (phasePrompt.userMessage) {
      messages.push({ role: 'user', content: phasePrompt.userMessage });
    }

    yield* chatStream(messages, {
      temperature: 0.7,
      // ★ 推理型模型（如 glm-5.3-flash）的 reasoning token 也计入 max_tokens：
      //   2048 会被思考阶段吃满导致正文为空，提高到 16384 留足输出余量
      maxTokens: 16384,
    }, options?.signal);
    return;
  }

  // 默认对话逻辑
  const conversationMessages: ChatMessage[] = [];
  if (input.conversationHistory) {
    for (const m of input.conversationHistory) {
      conversationMessages.push(m);
    }
  }

  const systemContext = [
    '你是一个专业的写作伙伴。当前上下文：',
    input.projectName ? `项目：${input.projectName}` : '',
    input.currentChapter ? `当前章节：${input.currentChapter}` : '',
    input.keyCharacters ? `关键角色：${input.keyCharacters}` : '',
    input.keyThemes ? `关键主题：${input.keyThemes}` : '',
    input.phase ? `创作阶段：${input.phase}` : '',
  ]
    .filter(Boolean)
    .join('；');

  const messages: ChatMessage[] = [
    { role: 'system', content: `${DEFAULT_SYSTEM_PROMPT}\n\n${systemContext}${buildSkillSection(input)}` },
    ...conversationMessages,
    { role: 'user', content: input.userMessage || '' },
  ];

  yield* chatStream(messages, {
    temperature: 0.7,
    // ★ 同上：推理模型的思考 token 计入 max_tokens，2048 不够用
    maxTokens: 16384,
  }, options?.signal);
}

// ============================================================
// 工具调用流式版本 — 支持 AI 主动调用工具读写实体
//
// 在 runChatAgentSimpleStream 基础上扩展：
//   1. 流式调用 LLM（携带 tools 定义）
//   2. 累积 content + tool_calls（流式分片）
//   3. 若收到完整 tool_calls → yield tool_call 事件 → 执行工具 → yield tool_result
//   4. 追加 assistant（含 tool_calls）+ tool 消息，再次调用 LLM
//   5. 循环直到 LLM 不再请求工具或达到最大轮数
// ============================================================

import type { ToolCall, ToolCallDelta, ToolDefinition } from '../providers/provider-factory.js';
import { executeTool, type ToolContext } from '../tools/index.js';

/** 工具调用流式 chunk（扩展 StreamChunk） */
export interface ToolStreamChunk {
  content?: string;
  thinking?: string;
  /** 工具调用开始（LLM 请求调用工具） */
  tool_call?: {
    id: string;
    name: string;
    arguments: string;
  };
  /** 工具执行结果 */
  tool_result?: {
    id: string;
    name: string;
    success: boolean;
    result: string;
    /**
     * 实体副作用（与 `ToolHandlerResult.entity` 同形）。
     * ★ 必须与 registry 那边保持**逐字一致** —— 包括 `'chapter'` 与 `'propose'`：
     *   章节正文只能以「提案」形式返回（AI 不直接写正文），少了这两个字面量
     *   提案就到不了前端确认框。
     */
    entity?: {
      type: 'character' | 'foreshadow' | 'location' | 'item' | 'outline' | 'chapter';
      action: 'create' | 'update' | 'propose';
      id?: string;
      name?: string;
      payload?: Record<string, unknown>;
    };
  };
}

/** 工具调用选项 */
export interface ToolChatOptions {
  signal?: AbortSignal;
  /** 可用工具列表 */
  tools?: ToolDefinition[];
  /** 工具执行上下文（projectId 等） */
  toolContext?: ToolContext;
  /** 最大工具调用轮数（防死循环），默认 5 */
  maxToolRounds?: number;
}

/**
 * 累积流式 tool_calls 分片，组装为完整 ToolCall[]。
 *
 * OpenAI 流式协议中，tool_calls 的 arguments 是分片传输的：
 *   chunk1: { index: 0, id: 'call_xxx', function: { name: 'create_character', arguments: '{"na' } }
 *   chunk2: { index: 0, function: { arguments: 'me":"张三"}' } }
 *   chunk3: { index: 1, id: 'call_yyy', function: { name: 'update_foreshadow', arguments: '{}' } }
 *
 * 此函数按 index 累积，最终返回完整数组。
 */
function accumulateToolCallDeltas(
  deltas: ToolCallDelta[],
): ToolCall[] {
  const map = new Map<number, { id?: string; name?: string; argsBuffer: string }>();
  for (const d of deltas) {
    const existing = map.get(d.index) ?? { id: undefined, name: undefined, argsBuffer: '' };
    if (d.id) existing.id = d.id;
    if (d.name) existing.name = d.name;
    if (d.arguments) existing.argsBuffer += d.arguments;
    map.set(d.index, existing);
  }
  const result: ToolCall[] = [];
  // 按 index 排序
  const sortedIndices = Array.from(map.keys()).sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const entry = map.get(idx)!;
    if (!entry.id || !entry.name) {
      // 缺少 id 或 name，跳过（不应发生）
      continue;
    }
    result.push({
      id: entry.id,
      type: 'function',
      function: {
        name: entry.name,
        arguments: entry.argsBuffer || '{}',
      },
    });
  }
  return result;
}

/**
 * 工具调用流式对话。
 *
 * 与 runChatAgentSimpleStream 的区别：
 *  - 携带 tools 定义，LLM 可主动调用工具
 *  - 实现工具调用循环（流式 → 执行 → 再调用）
 *  - yield 额外的 tool_call / tool_result 事件
 *
 * 工具调用循环终止条件：
 *  1. LLM 不再请求工具调用（正常结束）
 *  2. 达到 maxToolRounds（防死循环）
 *  3. 外部 signal abort
 */
export async function* runChatAgentWithTools(
  chatStream: (
    messages: ChatMessage[],
    options?: { temperature?: number; maxTokens?: number; tools?: ToolDefinition[]; toolChoice?: 'auto' | 'none' | 'required' },
    signal?: AbortSignal,
  ) => AsyncGenerator<StreamChunk>,
  input: ChatInput,
  toolOptions: ToolChatOptions,
): AsyncGenerator<ToolStreamChunk> {
  const { tools, toolContext, maxToolRounds = 5 } = toolOptions;
  const signal = toolOptions.signal;

  // 若无工具，降级为普通流式
  if (!tools || tools.length === 0 || !toolContext) {
    // 复用普通流式逻辑，转换 chunk 类型
    for await (const chunk of runChatAgentSimpleStream(chatStream, input, { signal })) {
      yield chunk;
    }
    return;
  }

  // 构建初始消息（与 runChatAgentSimpleStream 一致）
  const phasePrompt = buildPhasePrompt(input);
  let baseMessages: ChatMessage[];

  if (phasePrompt) {
    baseMessages = [{ role: 'system', content: phasePrompt.systemPrompt }];
    if (input.phase === '小说对话' && input.conversationHistory && input.conversationHistory.length > 0) {
      baseMessages.push({ role: 'user', content: phasePrompt.userMessage });
      for (let i = 1; i < input.conversationHistory.length; i++) {
        const m = input.conversationHistory[i]!;
        baseMessages.push({ role: m.role, content: m.content });
      }
    } else if (phasePrompt.userMessage) {
      baseMessages.push({ role: 'user', content: phasePrompt.userMessage });
    }
  } else {
    const conversationMessages: ChatMessage[] = [];
    if (input.conversationHistory) {
      for (const m of input.conversationHistory) {
        conversationMessages.push(m);
      }
    }
    const systemContext = [
      '你是一个专业的写作伙伴。当前上下文：',
      input.projectName ? `项目：${input.projectName}` : '',
      input.currentChapter ? `当前章节：${input.currentChapter}` : '',
      input.keyCharacters ? `关键角色：${input.keyCharacters}` : '',
      input.keyThemes ? `关键主题：${input.keyThemes}` : '',
    ]
      .filter(Boolean)
      .join('；');
    baseMessages = [
      { role: 'system', content: `${DEFAULT_SYSTEM_PROMPT}\n\n${systemContext}${buildSkillSection(input)}` },
      ...conversationMessages,
      { role: 'user', content: input.userMessage || '' },
    ];
  }

  // ---- 工具调用循环 ----
  // ★ 在 system prompt 末尾追加工具使用指导，让 LLM 知道可以主动调用工具
  const toolInstruction = `\n\n【工具调用能力】
你可以在回复中主动调用以下工具来直接创建/修改小说设定，无需用户手动操作：
- 角色库：create_character / update_character
- 伏笔列表：create_foreshadow / update_foreshadow
- 地点库：create_location / update_location
- 物品库：create_item / update_item
- 大纲：set_outline_core_conflict（核心冲突）/ set_chapter_outline（某章细节）/ set_outline_section（自由分区）

使用原则：
1. 当用户提到"帮我创建一个角色""加个伏笔""写一下第三章大纲"等明确意图时，直接调用对应工具
2. 工具调用后内容会立即写入对应模块，用户可实时看到
3. 可以在一次回复中调用多个工具（如同时创建角色和设置伏笔）
4. 调用工具后，用自然语言简要说明你做了什么
5. 对于大纲工具，上下文中提供了章节列表和当前大纲状态，请据此选择正确的目标`;
  if (baseMessages[0]?.role === 'system') {
    baseMessages[0] = { ...baseMessages[0], content: baseMessages[0].content + toolInstruction };
  }
  let messages = baseMessages;
  for (let round = 0; round < maxToolRounds; round++) {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    // 流式调用，累积 content 和 tool_calls
    let contentBuffer = '';
    const toolCallDeltas: ToolCallDelta[] = [];

    for await (const chunk of chatStream(messages, {
      temperature: 0.7,
      // ★ 8192：推理模型思维链预算（见上方同类说明）
      maxTokens: 8192,
      tools,
      toolChoice: 'auto',
    }, signal)) {
      if (chunk.thinking) {
        yield { thinking: chunk.thinking };
      }
      if (chunk.content) {
        contentBuffer += chunk.content;
        yield { content: chunk.content };
      }
      if (chunk.tool_calls_delta) {
        toolCallDeltas.push(chunk.tool_calls_delta);
      }
    }

    // 累积组装完整 tool_calls
    const toolCalls = accumulateToolCallDeltas(toolCallDeltas);

    // 若无工具调用，循环结束
    if (toolCalls.length === 0) {
      return;
    }

    // 追加 assistant 消息（含 tool_calls）
    messages = [
      ...messages,
      {
        role: 'assistant' as const,
        content: contentBuffer || '',
        tool_calls: toolCalls,
      },
    ];

    // 逐个执行工具，yield tool_call 和 tool_result 事件
    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      const toolArgsStr = tc.function.arguments;

      // yield tool_call 事件（让前端显示"正在调用工具…"）
      yield {
        tool_call: {
          id: tc.id,
          name: toolName,
          arguments: toolArgsStr,
        },
      };

      // 解析参数
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(toolArgsStr || '{}');
      } catch {
        // 参数解析失败，返回错误
        yield {
          tool_result: {
            id: tc.id,
            name: toolName,
            success: false,
            result: `错误：参数 JSON 解析失败：${toolArgsStr.slice(0, 100)}`,
          },
        };
        messages.push({
          role: 'tool',
          content: `错误：参数 JSON 解析失败`,
          tool_call_id: tc.id,
          name: toolName,
        });
        continue;
      }

      // ★ 工具 allowlist 门禁：只执行本次请求显式暴露给 LLM 的工具，
      //   防止伪造/幻觉的工具名绕过定义层过滤（如未对非管理员展示的 create_plugin
      //   或插件动态注册的工具）。registry 里存在 ≠ 当前会话允许执行。
      if (!tools.some((t) => t.function.name === toolName)) {
        const denyMsg = `错误：工具 "${toolName}" 不在当前会话的可用工具列表中`;
        yield {
          tool_result: {
            id: tc.id,
            name: toolName,
            success: false,
            result: denyMsg,
          },
        };
        messages.push({
          role: 'tool',
          content: denyMsg,
          tool_call_id: tc.id,
          name: toolName,
        });
        continue;
      }

      // 执行工具
      const execResult = await executeTool(toolName, parsedArgs, toolContext);

      // yield tool_result 事件
      yield {
        tool_result: {
          id: tc.id,
          name: toolName,
          success: execResult.success,
          result: execResult.result,
          entity: execResult.entity,
        },
      };

      // 追加 tool 消息
      messages.push({
        role: 'tool',
        content: execResult.result,
        tool_call_id: tc.id,
        name: toolName,
      });
    }
    // 循环继续：带着 tool 结果再次调用 LLM
  }

  // 达到最大轮数，yield 提示
  yield {
    content: '\n\n[已达到工具调用最大轮数限制]',
  };
}


