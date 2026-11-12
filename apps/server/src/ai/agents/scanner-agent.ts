// ============================================================
// 章节扫描 Agent - 提取实体、状态变化、伏笔、一致性问题
// ============================================================

import type { ChatMessage, StreamChunk } from '../providers/provider-factory.js';
import { parseAgentJson } from './utils.js';

/**
 * 章节扫描 Agent 输入参数
 */
export interface ScannerInput {
  /** 章节完整内容 */
  chapterContent: string;
  /** 章节标题 */
  chapterTitle: string;
  /** 章节序号 */
  chapterOrder: number;
  /** 项目名称 */
  projectName: string;
  /** 前一章节摘要 */
  previousSummary?: string;
  /** 已有实体列表（JSON 序列化，用于上下文） */
  existingEntities?: string;
}

/**
 * 章节扫描 Agent 输出结果
 */
export interface ScannerResult {
  entities: ScannerEntity[];
  events: ScannerEvent[];
  stateChanges: ScannerStateChange[];
  foreshadows: ScannerForeshadow[];
  consistencyIssues: ScannerConsistencyIssue[];
  themes: string[];
  tone: string;
  keyLines: string[];
}

export interface ScannerEntity {
  type: 'character' | 'item' | 'location' | 'event';
  name: string;
  description: string;
  mentioned: boolean;
  active: boolean;
}

/**
 * 章节关键剧情事件（时间线单元）
 */
export interface ScannerEvent {
  /** 事件简短标题（≤15 字） */
  title: string;
  /** 事件详细描述（具体发生了什么） */
  description: string;
  /** 事件类型：普通事件 / 伏笔铺垫 / 状态变化 */
  type: 'event' | 'foreshadow' | 'state_change';
  /** 涉及角色名称（角色在文中的名字） */
  characterNames: string[];
  /** 章节序号 */
  chapterOrder: number;
  /** 故事内时间（自由文本，如有） */
  timestamp?: string;
}

export interface ScannerStateChange {
  entityType: 'character' | 'item' | 'location';
  entityId: string;
  attribute: string;
  oldValue: string;
  newValue: string;
  context: string;
}

export interface ScannerForeshadow {
  type: 'identity' | 'motivation' | 'relation' | 'trauma' | 'turning' | 'fate';
  description: string;
  context: string;
  confidence: number;
}

export interface ScannerConsistencyIssue {
  type: 'character' | 'item' | 'location' | 'timeline' | 'plot';
  description: string;
  severity: 'low' | 'medium' | 'high';
}

// ---- Prompt 模板 ----

const SYSTEM_PROMPT = `你是一个专业的文学分析助手，专门用于分析小说章节内容。你的任务是识别章节中的关键实体、剧情事件、状态变化和潜在的叙事线索。请严格遵循以下格式输出，不要添加任何解释性文字。

分析要求：
1. 识别所有主要角色、物品、地点（不要把事件放进 entities，事件单独放到 events 数组）
2. 识别章节中的关键剧情事件、伏笔铺垫、角色/物品/地点的状态变化
3. 每个事件必须标注涉及的角色名称（用角色在文中的名字，数组形式）
4. 事件类型分类：
   - event：普通剧情事件（遭遇、对话、行动等）
   - foreshadow：伏笔铺垫（暗示后续发展的细节）
   - state_change：角色/物品/地点的状态发生变化（身份、能力、关系、持有权等）
5. 事件标题要简短精炼（15 字以内），概括事件核心
6. 事件描述要包含具体发生了什么，避免空泛
7. 标记任何角色、物品或地点的状态变化
8. 识别潜在的伏笔和叙事线索
9. 提取主题和情感基调
10. 保持客观分析，不添加个人解读`;

function buildUserPrompt(input: ScannerInput): string {
  return [
    '请分析以下章节内容：',
    '',
    input.chapterContent,
    '',
    '章节信息：',
    `- 章节标题：${input.chapterTitle}`,
    `- 章节序号：${input.chapterOrder}`,
    `- 所属项目：${input.projectName}`,
    `- 前一章节摘要：${input.previousSummary || '无'}`,
    input.existingEntities
      ? `\n已有实体列表：\n${input.existingEntities}`
      : '',
  ].join('\n');
}

/** 输出格式描述（内嵌在 user prompt 中） */
function buildOutputFormatSection(): string {
  return `
请按以下 JSON 格式输出分析结果（只输出 JSON，不要包含其他文字）：

{
  "entities": [
    {
      "type": "character|item|location",
      "name": "string",
      "description": "string",
      "mentioned": true/false,
      "active": true/false
    }
  ],
  "events": [
    {
      "title": "事件简短标题（15字以内）",
      "description": "事件详细描述（具体发生了什么）",
      "type": "event|foreshadow|state_change",
      "characterNames": ["涉及角色名称（用角色在文中的名字）"],
      "chapterOrder": 章节序号(数字),
      "timestamp": "故事内时间（自由文本，如无则留空字符串）"
    }
  ],
  "stateChanges": [
    {
      "entityType": "character|item|location",
      "entityId": "string",
      "attribute": "string",
      "oldValue": "string",
      "newValue": "string",
      "context": "string"
    }
  ],
  "foreshadows": [
    {
      "type": "identity|motivation|relation|trauma|turning|fate",
      "description": "string",
      "context": "string",
      "confidence": 0.0-1.0
    }
  ],
  "consistencyIssues": [
    {
      "type": "character|item|location|timeline|plot",
      "description": "string",
      "severity": "low|medium|high"
    }
  ],
  "themes": ["string"],
  "tone": "string",
  "keyLines": ["string"]
}`;
}

/**
 * 执行章节扫描
 *
 * @param provider Chat 函数（由调用方注入）
 * @param input 扫描输入
 * @returns 扫描结果
 */
export async function runScanner(
  chat: (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }, signal?: AbortSignal) => Promise<string>,
  input: ScannerInput,
  options?: { signal?: AbortSignal },
): Promise<ScannerResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserPrompt(input) + '\n\n' + buildOutputFormatSection(),
    },
  ];

  const response = await chat(messages, {
    temperature: 0.3,
    maxTokens: 8192,
  }, options?.signal);

  const parsed = parseAgentJson(response, 'ScannerAgent');

  // 解析 events：优先取 AI 输出的 events 数组；
  // 兜底：若 AI 仍把事件放在 entities 的 type='event' 项里，提取到 events。
  const events = extractEvents(parsed, input.chapterOrder);
  // entities 仅保留 character/item/location（排除 event，避免与 events 重复）
  const rawEntities = (parsed.entities as ScannerEntity[]) || [];
  const entities = rawEntities.filter((e) => e && e.type !== 'event');

  return {
    entities,
    events,
    stateChanges: (parsed.stateChanges as ScannerStateChange[]) || [],
    foreshadows: (parsed.foreshadows as ScannerForeshadow[]) || [],
    consistencyIssues: (parsed.consistencyIssues as ScannerConsistencyIssue[]) || [],
    themes: (parsed.themes as string[]) || [],
    tone: (parsed.tone as string) || '',
    keyLines: (parsed.keyLines as string[]) || [],
  };
}

/**
 * 解析 events 数组，并兜底处理 AI 把事件放在 entities.type='event' 的情况。
 */
function extractEvents(parsed: any, chapterOrder: number): ScannerEvent[] {
  const result: ScannerEvent[] = [];

  // 1) 优先取 events 数组
  const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
  for (const e of rawEvents) {
    if (!e || typeof e !== 'object') continue;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    result.push({
      title,
      description: typeof e.description === 'string' ? e.description : '',
      type: normalizeEventType(e.type),
      characterNames: normalizeStringArray(e.characterNames ?? e.participants),
      chapterOrder: typeof e.chapterOrder === 'number' ? e.chapterOrder : chapterOrder,
      timestamp: typeof e.timestamp === 'string' && e.timestamp ? e.timestamp : undefined,
    });
  }

  // 2) 兜底：从 entities 中提取 type='event' 项（旧格式兼容）
  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
  for (const ent of rawEntities) {
    if (!ent || ent.type !== 'event') continue;
    const title = typeof ent.name === 'string' ? ent.name.trim() : '';
    if (!title) continue;
    // 避免与已解析的 events 重复（按标题去重）
    if (result.some((r) => r.title === title)) continue;
    result.push({
      title,
      description: typeof ent.description === 'string' ? ent.description : '',
      type: 'event',
      characterNames: [],
      chapterOrder,
      timestamp: undefined,
    });
  }

  return result;
}

/** 规范化事件类型字段 */
function normalizeEventType(v: unknown): 'event' | 'foreshadow' | 'state_change' {
  if (v === 'foreshadow' || v === 'state_change') return v;
  return 'event';
}

/** 规范化为字符串数组 */
function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string' && x.trim().length > 0)
    .map((x: string) => x.trim());
}

/**
 * 便捷封装：通过 Provider 直接执行扫描
 */
export async function scanChapter(
  chat: (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }, signal?: AbortSignal) => Promise<string>,
  input: ScannerInput,
  options?: { signal?: AbortSignal },
): Promise<ScannerResult> {
  return runScanner(chat, input, options);
}

// ============================================================
// 流式时间线扫描 — JSON Lines 格式，逐行输出事件
// ============================================================

/** 流式扫描输出的单个时间线事件（与 ScannerEvent 兼容） */
export interface StreamTimelineEvent {
  title: string;
  description: string;
  type: 'event' | 'foreshadow' | 'state_change';
  characterNames: string[];
  chapterOrder: number;
  timestamp?: string;
  /**
   * 原文证据片段（逐字来自当前章节）。
   * ★ 2026-11-07：模型最容易「脑补」event，而 title/description 都是概括，
   *   无法逐字核对。quote 是唯一能确定性验证「这件事真的写在原文里」的字段，
   *   落库前用它做真伪校验（见 toTimelineEvent / toKeywordEvent）。
   */
  quote?: string;
}

/** 流式扫描输出的实体（角色/物品/地点） */
export interface StreamEntity {
  entityType: 'character' | 'item' | 'location';
  name: string;
  description: string;
  context: string;
  // 角色扩展字段（仅 character 类型使用，可选）
  appearance?: string;      // 外貌描述
  personality?: string;     // 性格特征
  role?: 'protagonist' | 'femaleLead' | 'supporting' | 'minor';  // 角色定位
  speechStyle?: string;     // 说话风格/口头禅
  // 物品扩展字段（仅 item 类型使用，可选）：标准类型码（见提示词词表）
  itemType?: string;
}

/** 流式扫描输出的物品流转 */
export interface StreamItemTransfer {
  transferType: 'item_transfer';
  itemName: string;
  fromCharacter: string;
  toCharacter: string;
  action: 'gained' | 'lost' | 'transferred' | 'held';
  context: string;
}

/** 流式扫描输出的角色别名关系 */
export interface StreamAliasMatch {
  aliasType: 'alias_match';
  primaryName: string;
  aliases: string[];
  context: string;
}

/**
 * 流式扫描输出的积分流水（系统文）。
 * 只从原文明确写出的积分数额 / 系统赠予中提取，不猜测。
 */
export interface StreamCreditTransaction {
  creditType: 'credit_transaction';
  action: 'gain' | 'spend' | 'gift';
  characterName: string;
  amount: number;
  reason?: string;
  itemName?: string;
  chapterOrder: number;
}

const TIMELINE_STREAM_SYSTEM_PROMPT = `你是一个专业的小说分析助手。你的任务是阅读章节内容，提取角色/物品/地点实体、物品装备流转、角色别名关系，以及关键时间线事件。

【最高原则】必须严格从段落原文中识别名字，绝不能脑补、推测或"规范化"文中没有出现的名字。
- name 字段必须是文中真实出现过的字符串（逐字匹配），不要替换为"更正式"的版本
- 例如文中写"孔明"，不要输出 name="诸葛亮"；文中写"玄德公"，不要输出 name="刘备"
- 文中没有明确出现的全名绝不能作为 name，只能作为 alias（且需在 context 中说明依据）
-宁可漏识别一个不确定的实体，也不要识别错一个实体。识别精度优先于召回率。

输出格式要求（极其重要）：
- 每行输出一个完整的 JSON 对象，不要有数组包裹，不要有缩进
- 实体行格式：{"entityType":"character|item|location","name":"名称","description":"简短描述","context":"原文片段(必须直接引用文中出现的句子或短语，作为识别证据)"}
- ★ item 实体行必须附带 itemType 字段（标准类型码，词表见下方物品识别规则）：
  {"entityType":"item","name":"金丝软甲","itemType":"armor","description":"简短描述","context":"原文片段"}
- character/location 实体行不输出 itemType
- 角色实体行可附带可选字段（仅在原文有明确信息时输出，无则省略）：
  "appearance":"外貌描述(从原文提取，如'穿白裙的少女'、'剑眉星目')"
  "personality":"性格特征(从原文行为/对话推断，如'沉稳内敛'、'急躁冲动')"
  "role":"protagonist|femaleLead|supporting|minor"(主角/女主/配角/路人，根据戏份判断)
  "speechStyle":"说话风格(从原文对话提取，如'文绉绉'、'粗犷直接'、'喜欢用反问句')"
- 物品流转行格式：{"transferType":"item_transfer","itemName":"物品名","fromCharacter":"来源角色名(无则空字符串)","toCharacter":"目标角色名(无则空字符串)","action":"gained|lost|transferred","context":"上下文片段"}
- 角色别名行格式：{"aliasType":"alias_match","primaryName":"主名称","aliases":["别名1","别名2"],"context":"依据上下文"}
- 积分流水行格式：{"creditType":"credit_transaction","action":"gain|spend|gift","characterName":"角色名","amount":数字,"reason":"事由","itemName":"关联物品名(可选)"}
- 事件行格式：{"title":"事件标题(8-15字)","description":"起因—经过—结果(30-80字)","type":"event|foreshadow|state_change","characterNames":["原文中出现过的称呼"],"timestamp":"故事内时间(如有)","quote":"原文逐字片段(10-40字)"}
- 先输出所有实体行，再输出别名行，再输出物品流转行、积分流水行，最后输出事件行
- 逐行输出，不要换行缩进，不要输出任何其他文字
- 实体 entityType 含义：character=角色，item=物品，location=地点

【角色（character）识别规则（极其重要，必须严格执行）】
- 只识别在段落中明确作为"人"出现的实体，必须满足以下任一证据：
  a) 作为对话发起者出现："XX说"、"XX道"、"XX问"、"XX答"、"XX喝道"等
  b) 作为动作主语出现："XX拔剑"、"XX转身"、"XX皱眉"等明确的人类动作
  c) 作为对话对象出现："对XX说"、"看着XX"、"XX笑道"等
  d) 文中明确指出是人："少年名叫XX"、"这位是XX"等
- name 字段必须从原文逐字提取，保留原样（包括"公"、"先生"等敬称，如果文中就是这样称呼的）
- 如果文中只出现"那少年"、"黑衣人"等代称，name 字段就用这个代称，不要改写
- description 字段：根据文中信息简短描述身份/特征（如"持剑的少年"、"穿黑衣的神秘人"）

【角色识别负面清单（必须严格执行，避免误识别）】
- 不要把动词识别为角色名（如"剑气"、"风起"不是人）
- 不要把地名识别为角色（地名应识别为 location 实体）
- 不要把物品名识别为角色（物品应识别为 item 实体）
- 不要把形容词、副词识别为角色名
- 不要把"他"、"她"、"它"、"那人"等代词作为 name 输出
- 不要把"主角"、"反派"等抽象身份标签作为 name 输出
- 不要把门派/组织名识别为角色（如"天剑门"是组织，不是人）
- 不要把职业/身份作为角色名（如"按摩员"、"服务员"、"司机"是职业，不是人名）
- 不要把亲属关系作为角色名（如"父亲"、"妹妹"、"女朋友"是关系，不是人名）
- 不要把头衔/职位作为独立角色输出（如"皇帝"、"掌门"、"警官"若无具体姓名，不输出）
- 除非前面加了姓氏（如"李警官"、"王医生"），否则纯职业/头衔不输出为角色名
- ★ 单字名极谨慎处理（极易误识别，必须满足以下全部条件才输出）：
  1) 该单字必须作为人名使用（如"陈走了过来"中的"陈"），不能是其他词的组成部分（如"陈酒"中的"陈"是修饰词，不是人名）
  2) 该单字不能是常见姓氏单独出现且无上下文佐证（如仅出现"李"、"王"而无后续动作/对话，不输出）
  3) 该单字不能是动词、形容词、方位词等（如"按"、"打"、"来"、"去"、"大"、"小"绝对不是人名）
  4) 如果该单字+职业描述构成称谓（如"按警员"中的"按"），绝对不能把单字或整个词组识别为角色名
  5) 单字名只在以下情况输出：文中反复使用该单字指代同一人，且该单字独立作为主语/宾语出现
- ★ 动词+名词组合不是人名（如"按警员"是"按压+警员"的动作描述，不是人名"按警员"）
- ★ 介词/副词+名词组合不是人名（如"在门口"、"向北方"不是人名）
- 不要把诗词、武功招式名、咒语中的字词识别为角色
- 不要把外貌/性格描述作为角色名（如"大嗓门"、"胖子"、"瘦子"是描述，不是人名）
- ★ 名字长度异常警惕：超过6个字的名字极可能是误识别（复姓全名最多4-5字），需检查是否把句子片段当成了名字

- 物品（item）识别规则（极其重要，必须严格执行）：
  - 物品指小说中出现的具有实际意义的具体物件，包括但不限于：
    - 武器/兵器：剑、刀、枪、弓、锤、暗器等（如"青锋剑"、"寒冰刀"）
    - 法宝/神器：修真/玄幻中的法宝、灵宝、神器等（如"乾坤圈"、"定海神针"）
    - 信物/令牌：玉佩、令牌、印章、钥匙等（如"虎符"、"门派令牌"）
    - 书籍/卷轴：功法秘籍、地图、书信、卷轴等（如"九阴真经"、"藏宝图"）
    - 药品/丹药：丹药、草药、毒药、解药等（如"九转金丹"、"回魂丹"）
    - 服饰/装备：铠甲、披风、首饰、头盔等（如"金丝软甲"、"凤冠"）
    - 宝物/财宝：金银珠宝、玉器、古玩等（如"夜明珠"、"传国玉玺"）
    - 交通工具：马车、船只、飞剑、坐骑装备等
    - 日用品/工具：茶具、灯盏、罗盘、法器等有具体名称的物品
  - ★ itemType 标准类型码（item 实体必须从下表选择一个，不要自创）：
    weapon=武器/兵器；armor=防具；clothing=衣物/服饰/佩饰；treasure=宝物/财宝；
    token=信物/令牌；artifact=法器/法宝；medicine=药物/草药；book=书籍；
    document=文书/书信/地图；scroll=卷轴/秘籍；key=钥匙；vehicle=交通工具/坐骑；
    gem=宝石/玉器原料；tool=工具/器具；food=食物；plant=植物/灵草；animal=动物/灵兽；
    prop=道具/杂物；other=以上都不是
  - ★★ 宝物（treasure）与衣物（clothing）/防具（armor）的区分判定（极易混淆，必须执行）：
    1) 衣物/服饰（clothing）的判定标准是"用途为穿着或佩戴"：衣、袍、裙、裳、衫、冠、靴、
       鞋、袜、披风、面纱，以及戴在身上的首饰佩饰（手镯、项链、耳环、发簪、玉佩等），
       无论多么珍贵都归 clothing（有防护用途的归 armor）
    2) 宝物（treasure）的判定标准是"以价值为核心"：金银锭、珠宝宝料、古玩、库藏、赃物等
       被珍藏/争夺/交易，但不穿不戴的财物
    3) 两可时的决定性问题：「角色会把它穿/戴在身上，还是收起来珍藏/交易？」
       - 金丝软甲、凤冠、蟒袍 → 穿在身上 → armor 或 clothing（防具优先 armor）
       - 夜明珠、金银两锭、古画 → 收藏/交易 → treasure
       - 玉佩、扳指、手镯 → 佩戴在身 → clothing（若剧情强调它是身份/赠别的信物 → token；
         若剧情强调价值连城被争夺而从不佩戴 → treasure）
    4) 优先级：防护用途 > 信物用途 > 佩戴用途 > 价值用途（例：既是佩戴又是信物的玉佩 → token）
  - ★ 识别要求（精度优先，宁缺毋滥）：
    - 只输出原文中真实出现、且是**具体物件**的物品；不确定时宁可不输出
    - 物品必须有具体名称，或被角色使用/携带/获得/失去/争夺
    - 泛指类物品（如"一把剑"、"一杯茶"）没有专名且无流转意义时不要输出
    - 如果泛指物品在后续流转中有意义（如角色获得了一把无名宝剑），仍需输出
  - ★ 绝对不是物品（违反即视为识别错误）：
    - 货币/数值/属性：积分、金币、银两、灵石、经验、等级、属性、"500 积分"、"100 金币"
    - 系统界面元素：系统面板、属性面板、任务面板、商城界面、系统提示、对话框、按钮、菜单
    - 功法/技能/招式本身（如"基础剑法"）——除非原文明确写的是秘籍、卷轴、玉简等实物载体
    - 角色名、地点名、组织/门派名、抽象概念
  - ★ 同一物品只输出一次；名称用原文中最完整的称呼，不要加书名号/引号

【角色别名识别规则（极其重要，优先级最高，精度优先）】
- 只有非常确定是同一个人的不同称呼才合并为别名关系，宁可不合并也不能误合并
- 【绝对不能合并的情况】（违反任何一条都不能输出别名行）：
  - 两个名字没有任何共同字符 → 绝对不是同一个人，禁止合并
  - 一个是人名、另一个是身份/关系/职业描述 → 禁止合并（如"陈星"和"女朋友"不能合并）
  - 一个是人名、另一个是外貌特征/性格描述 → 禁止合并（如"陈星"和"大嗓门"不能合并）
  - 一个是人名、另一个是泛指代词 → 禁止合并（如"他"、"她"、"那人"、"少年"不能当别名）
- 【核心判断方法】通过上下文语境追踪人物身份：
  - 看对话指代："XX说道"中的XX如果在上下文中明确指向某个人，就是同一个人
  - 看行为一致性：连续动作/对话中出现的不同称呼如果是同一个人在做同一件事，就是别名
  - 看场景指代：同一场景中出现的名字如果描述的是同一个角色的行为/表情/对话，就是同一个人
  - 看他人称呼：A对B说话时用的称呼和B的本名可能不同，要识别出来
  - 看明确的身份介绍：文中明确说"XX又叫YY"、"XX字YY"、"外号XX"时才是别名
- 常见别名类型（必须有明确上下文证据）：
  - 叠字/小名：周粥→粥粥、李明→明明、王芳→芳芳（必须有上下文证明是同一个人）
  - 加前缀/后缀：李将军→李大将军、张公子→张贤弟（同一人被不同尊称）
  - 姓+身份/职位：周队长、王医生、李老师（同一个人被称呼职位）
  - 表字/号：诸葛亮字孔明、宋江号及时雨（文中明确说明时）
  - 外号/绰号：玉面狐狸、飞毛腿、智多星（文中明确是外号时）
  - 简称/昵称：明哥、芳姐、老陈、小王（同一人被简称）
- 【判定辅助公式】名字 A 和名字 B 是同一个人的必要条件：
  1. 至少有一个共同字符（如"陈星"和"小陈"都有"陈"）
  2. 上下文明确指向同一个人
  3. 两者不同时作为不同主语出现在同一段对话中
  三个条件必须同时满足
- primaryName 选择规则（极其重要，避免识别错误）：
  - ★ 优先选文中第一次出现的全名（逐字匹配，不要"规范化"）
  - 如果文中只出现别名/代号，primaryName 就用这个别名/代号，不要脑补全名
  - 如果文中同时出现"孔明"和"诸葛亮"，且"孔明"先出现或出现次数更多，primaryName 用"孔明"，"诸葛亮"放 aliases
  - 不要用历史/常识中的"标准名"覆盖文中实际称呼
- 输出要求：
  - 只输出非常确定的别名关系，不确定的不要输出（宁可漏标，不可误标）
  - 即使角色已经在已有实体列表中，只要发现了新别名，也要输出别名行
  - 已有列表中的角色如果有别名关系，也必须输出
  - 每个别名行的 aliases 数组可以有多个别名

- 物品流转 action 含义：gained=某角色获得装备，lost=某角色失去装备，transferred=装备从一人转移到另一人，held=某角色在本章持有/使用/穿戴该物品（无持有变化）
- 物品流转识别规则：
  - 文中明确提到"XX将YY交给ZZ"、"ZZ接过YY"、"XX获得/得到YY" → transferred 或 gained
  - 文中明确提到"XX失去YY"、"YY被夺走"、"XX扔掉YY" → lost
  - ★ 文中提到角色携带/使用/穿戴某物品（即使没有获得/失去的变化）也必须输出 held 流转行：
    "XX把青铜罗盘摊在掌心"、"XX裹紧了斗篷"、"XX腰间挂着YY"、"XX翻开星图残卷" → held（toCharacter=该角色）
  - held 是人物与物品关系的基础数据：一件重要的物品如果从未输出任何流转行，它就永远不知道归属
  - 只有当角色与物品的持有关系发生明确变化时才输出 gained/lost/transferred；无变化但有持有/使用行为 → held
  - held 行在重复扫描时会去重，不会产生重复关系
- 事件 type 含义：event=普通剧情事件，foreshadow=伏笔铺垫，state_change=状态变化
- ★ 积分流水识别规则（只在原文明确写出时输出，绝不猜测数字）：
  - "消耗/花费/扣除/扣掉 X 积分" → action=spend, amount=X, reason 概括用途（如"兑换基础剑法"）
  - "获得/奖励/到账/增加 X 积分" → action=gain, amount=X, reason 概括来源（如"完成新手任务"）
  - "系统赠送/奖励了某物"但没有积分数字 → action=gift, amount=0, itemName=赠予的物品名
  - 普通物品获得、没有积分数字的消耗，不要当作积分流水
  - 同一笔流水只输出一次

【时间线事件识别规则（精度优先，必须严格执行）】
- 只记录本章真实发生、推动剧情的事件；环境描写、内心感慨、纯背景交代不单独成事件
- 以已发生的事情为基准，按原文叙事先后顺序输出事件
- 一个独立的情节动作/转折成一条；不同时间、不同地点、不同因果的动作**不得合并**成一条；只有同一动作的分句才合并
- title：动宾短语，8-15 字，能独立看懂；不要以"本章""故事""随后"这类空话开头
- description：交代起因—经过—结果，30-80 字，只写原文实际发生的事，不加评价、不推测人物动机
- characterNames：只填本事件中实际出场或直接受影响的角色，且必须是原文中**逐字出现过**的称呼；没有角色就填空数组 []
- quote ★必填：从原文**逐字复制** 10-40 字、最能定位该事件的一段连续文字；不得改写、拼接、加省略号、不得跨段拼凑
- ★ 如果找不到能逐字复制的 quote，说明这件事不是原文实际发生的，**不要输出这条事件**
- timestamp 只在原文有明确故事内时间（如"三日后""子时""次年春天"）时填写，不要自己推算
- 同一件事只输出一条；不要把同一段拆成多条同义事件，也不要把多件事压成一条
- 已有实体列表中的角色不需要再输出为实体行（characters 字段包含 name 和 aliases，文中出现的名字若已在某角色的 name 或 aliases 中，就视为已存在，不要重复输出实体行）
- ★ 但物品（item）必须输出：文中出现的所有物品（含已有物品）都要输出 item 实体行并带 itemType ——客户端按名称去重，已有物品缺失类型时会用 itemType 补全分类
- 但如果发现已有角色的新别名（既不在 name 也不在 aliases 中），仍需通过 alias_match 行补充

【最终自检（输出前必须执行）】
- 每个 character 实体的 name 是否在原文中逐字出现？若否，必须改用文中实际称呼或删除该实体
- context 字段是否引用了原文片段作为证据？若是空字符串或泛泛描述，必须补全
- 是否有把地名/物品名/动词误识别为角色的情况？若有，必须删除
- ★ 单字名角色是否满足全部5条单字名输出条件？若否，删除该实体
- ★ 是否有"动词+名词"或"介词+名词"组合被误识别为人名（如"按警员"）？若有，必须删除
- ★ 角色名是否超过6个字？若是，极可能是句子片段误识别，必须检查并删除
- ★ 每个 item 的 name 是否是具体物件，而不是货币/数值/界面/技能/地点/角色？
- primaryName 是否是文中真实出现的称呼？若否，必须改用文中称呼`;

function buildTimelineStreamUserPrompt(input: ScannerInput): string {
  return [
    `请分析以下章节（第${input.chapterOrder}章 ${input.chapterTitle}），严格从段落原文中提取所有角色/物品/地点实体和关键时间线事件。`,
    '',
    '【本次识别重点】',
    '1. 角色名必须从段落中逐字提取，不要脑补或"规范化"为文中未出现的全名',
    '2. 每个角色的 context 字段必须引用原文片段作为识别证据',
    '3. 不要遗漏任何有名称的物品（武器、法宝、信物、丹药、书籍、宝物等）',
    '4. 识别人物时，优先从对话标签（"XX说"、"XX道"）和动作主语中提取',
    '',
    '【已有实体处理规则（极其重要，避免重复识别）】',
    '- 已有实体列表中的 characters 每项包含 name 和 aliases 两个字段',
    '- 如果文中出现的名字已经在某个已有角色的 name 或 aliases 中，绝不要再输出该角色为新的实体行',
    '- 例：已有 {name:"孔明", aliases:["诸葛亮"]}，文中再出现"诸葛亮"时，不要输出"诸葛亮"的实体行',
    '- 只有当文中出现该角色的全新别名（既不在 name 也不在 aliases 中）时，才输出 alias_match 行补充别名',
    '- ★ items 与 characters 规则不同：文中出现的物品（含已有物品）都必须输出 item 实体行并带 itemType ——',
    '  客户端会按名称去重，已有物品缺失类型时会用 itemType 补全分类；不输出则类型永远缺失',
    '- 已有 locations 同名时不要重复输出',
    '- 但如果发现已有实体的新别名/新变体，仍需通过 alias_match 行补充',
    '',
    '章节内容：',
    input.chapterContent,
    '',
    input.existingEntities
      ? `已有实体（JSON 格式，characters 含 name+aliases）：\n${input.existingEntities}`
      : '',
  ].join('\n');
}

// ============================================================
// 流式 JSON 对象解析（自动扫描 / 关键词提取共用）
// ============================================================

/**
 * 增量式流 JSON 对象扫描器。
 *
 * 与「每次 chunk 都把残留 buffer 从头重扫」相比：
 * - 跨 chunk 保留 depth / inString / escaped 状态，每个字符只访问一次（O(n)）；
 * - 对象未闭合时只把本段 chunk 追加进 parts，闭合时 join 一次，
 *   避免长对象在多轮重扫中反复拼接；
 * - 普通对象直接 JSON.parse，失败才走 parseAgentJson 的修复路径。
 *
 * 解析规则仍与旧实现一致：只取顶层 `{...}`，跳过围栏与解释文字，
 * 允许一行多个对象 / 数组包裹，并感知字符串里的 `{}` 与 `\` 转义。
 */
export class JsonObjectStreamParser {
  /** 当前未闭合对象的文本片段（按 chunk 追加，闭合时 join 一次） */
  private parts: string[] = [];
  private depth = 0;
  private inString = false;
  private escaped = false;
  private scanning = false;

  /** 喂入一段流式文本，返回本次闭合且解析成功的对象 */
  push(chunk: string): unknown[] {
    const values: unknown[] = [];
    let rest = chunk;

    while (rest.length > 0) {
      if (!this.scanning) {
        const start = rest.indexOf('{');
        if (start === -1) break; // 没有对象开头，前缀全是噪声
        rest = rest.slice(start);
        this.resetObject();
        this.scanning = true;
      }

      let closedAt = -1;
      for (let i = 0; i < rest.length; i++) {
        const ch = rest[i]!;
        if (this.escaped) {
          this.escaped = false;
          continue;
        }
        if (ch === '\\') {
          this.escaped = true;
          continue;
        }
        if (ch === '"') {
          this.inString = !this.inString;
          continue;
        }
        if (this.inString) continue;
        if (ch === '{') {
          this.depth++;
        } else if (ch === '}') {
          this.depth--;
          if (this.depth === 0) {
            closedAt = i;
            break;
          }
        }
      }

      if (closedAt === -1) {
        this.parts.push(rest); // 未闭合：保留到下一个 chunk 续接
        break;
      }

      this.parts.push(rest.slice(0, closedAt + 1));
      const raw = this.parts.join('');
      const value = parseJsonObject(raw);
      if (value) {
        values.push(value);
      } else {
        // 这个对象解析失败：尝试从中恢复完整的嵌套对象
        values.push(...recoverCompleteObjects(raw.slice(1)));
      }

      this.scanning = false;
      this.parts = [];
      rest = rest.slice(closedAt + 1);
    }

    return values;
  }

  /**
   * 流结束：返回无法闭合的残留（仅供诊断）。
   * 同时尝试从残留中恢复完整的嵌套对象，避免「外层缺一个 } 就整批丢失」。
   */
  flush(): { values: unknown[]; rest: string } {
    if (!this.scanning) return { values: [], rest: '' };

    const raw = this.parts.join('');
    this.scanning = false;
    this.resetObject();
    return { values: recoverCompleteObjects(raw.slice(1)), rest: raw };
  }

  private resetObject(): void {
    this.parts = [];
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }
}

/**
 * 从一段可能包含残坏对象的文本中恢复**已闭合**的对象。
 * 只 push（不再 flush），避免「一长串未闭合 {」触发递归 flush 的深调用栈。
 */
function recoverCompleteObjects(text: string): unknown[] {
  return new JsonObjectStreamParser().push(text);
}

/**
 * 一次性解析：从任意文本中抽出**已闭合**的顶层 JSON 对象，
 * 并保留未闭合的尾部。内部复用增量扫描器。
 */
export function extractCompleteJsonObjects(text: string): { values: unknown[]; rest: string } {
  const parser = new JsonObjectStreamParser();
  const values = parser.push(text);
  const tail = parser.flush();
  return { values: [...values, ...tail.values], rest: tail.rest };
}

/** 解析单个已闭合对象：先走严格 JSON，失败再用 parseAgentJson 修复 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 继续走修复路径
  }

  try {
    const parsed = parseAgentJson(raw, 'StreamJson');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** 只接受普通对象（排除 null / 数组） */
function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 流式扫描时间线事件
 *
 * @param chatStream Provider 的流式聊天函数
 * @param input 扫描输入
 * @param options.signal 外部取消信号
 * @param options.onEvent 每解析出一个完整事件时回调
 */
export async function streamTimelineEvents(
  chatStream: (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }, signal?: AbortSignal) => AsyncGenerator<StreamChunk>,
  input: ScannerInput,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: StreamTimelineEvent) => void;
    onEntity?: (entity: StreamEntity) => void;
    onItemTransfer?: (transfer: StreamItemTransfer) => void;
    onAliasMatch?: (aliasMatch: StreamAliasMatch) => void;
    onCreditTransaction?: (credit: StreamCreditTransaction) => void;
  } = {},
): Promise<StreamTimelineEvent[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: TIMELINE_STREAM_SYSTEM_PROMPT },
    { role: 'user', content: buildTimelineStreamUserPrompt(input) },
  ];

  const events: StreamTimelineEvent[] = [];
  const scanner = new JsonObjectStreamParser();
  let totalChunkLen = 0;
  let chunkCount = 0;

  let entityCount = 0;
  let transferCount = 0;
  let aliasCount = 0;
  let creditCount = 0;
  let failedRecords = 0;
  const entityLog: string[] = []; // ★ 记录 AI 实际输出的实体名，便于诊断"AI 是否识别对了"
  const aliasLog: string[] = [];  // ★ 记录 AI 输出的别名关系
  console.log('[streamTimelineEvents] 开始流式扫描，章节内容长度=', input.chapterContent.length);

  /** 按判别字段分发一条已解析的 JSON 对象 */
  const dispatchRecord = (value: unknown) => {
    const record = parseStreamRecord(value, input.chapterOrder, input.chapterContent);
    if (!record) {
      failedRecords++;
      // ★ 打印解析失败的具体对象，便于诊断 AI 输出格式问题
      console.warn(`[streamTimelineEvents] 解析失败对象: ${JSON.stringify(value).slice(0, 200)}`);
      return;
    }

    switch (record.kind) {
      case 'entity':
        entityCount++;
        entityLog.push(
          `${record.entity.entityType}:${record.entity.name}` +
            (record.entity.itemType ? `(${record.entity.itemType})` : ''),
        );
        options.onEntity?.(record.entity);
        break;
      case 'alias':
        aliasCount++;
        aliasLog.push(
          `${record.aliasMatch.primaryName} ← [${record.aliasMatch.aliases.join(',')}]`,
        );
        options.onAliasMatch?.(record.aliasMatch);
        break;
      case 'transfer':
        transferCount++;
        options.onItemTransfer?.(record.transfer);
        break;
      case 'credit':
        creditCount++;
        options.onCreditTransaction?.(record.credit);
        break;
      case 'event':
        events.push(record.event);
        options.onEvent?.(record.event);
        break;
    }
  };

  for await (const chunk of chatStream(messages, { temperature: 0.3, maxTokens: 8192 }, options.signal)) {
    const text = chunk.content || '';
    totalChunkLen += text.length;
    chunkCount++;

    for (const value of scanner.push(text)) dispatchRecord(value);
  }

  // 流结束：正常情况 scanner 只剩半条坏数据；尽量恢复其中完整的嵌套对象，并记录丢弃量
  const tail = scanner.flush();
  for (const value of tail.values) dispatchRecord(value);
  if (tail.rest.trim()) {
    failedRecords++;
    console.warn(`[streamTimelineEvents] 丢弃未闭合的尾部: ${tail.rest.slice(0, 200)}`);
  }

  console.log(
    `[streamTimelineEvents] 流式扫描完成: ${chunkCount} 个chunk, 总长度=${totalChunkLen}, ` +
    `实体=${entityCount} [${entityLog.join(' | ')}], ` +
    `别名=${aliasCount} [${aliasLog.join(' | ')}], ` +
    `流转=${transferCount}, 积分流水=${creditCount}, ` +
    `事件=${events.length}, 解析失败对象=${failedRecords}`,
  );

  return events;
}

/** 扫描流记录的判别结果 */
export type StreamRecord =
  | { kind: 'entity'; entity: StreamEntity }
  | { kind: 'alias'; aliasMatch: StreamAliasMatch }
  | { kind: 'transfer'; transfer: StreamItemTransfer }
  | { kind: 'credit'; credit: StreamCreditTransaction }
  | { kind: 'event'; event: StreamTimelineEvent };

/** 对象 → 实体（角色/物品/地点），判别字段不是 entityType 时返回 null */
function toStreamEntity(parsed: Record<string, unknown>): StreamEntity | null {
  const entityType = parsed.entityType;
  if (entityType !== 'character' && entityType !== 'item' && entityType !== 'location') return null;

  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name) return null;

  return {
    entityType,
    name,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    context: typeof parsed.context === 'string' ? parsed.context : '',
    // 扩展字段透传（角色：appearance/personality/role/speechStyle；物品：itemType）
    ...(typeof parsed.appearance === 'string' ? { appearance: parsed.appearance } : {}),
    ...(typeof parsed.personality === 'string' ? { personality: parsed.personality } : {}),
    ...(parsed.role === 'protagonist' ||
    parsed.role === 'femaleLead' ||
    parsed.role === 'supporting' ||
    parsed.role === 'minor'
      ? { role: parsed.role }
      : {}),
    ...(typeof parsed.speechStyle === 'string' ? { speechStyle: parsed.speechStyle } : {}),
    ...(typeof parsed.itemType === 'string' ? { itemType: parsed.itemType } : {}),
  };
}

/** 对象 → 物品流转，判别字段不是 item_transfer 时返回 null */
function toStreamItemTransfer(parsed: Record<string, unknown>): StreamItemTransfer | null {
  if (parsed.transferType !== 'item_transfer') return null;

  const itemName = typeof parsed.itemName === 'string' ? parsed.itemName.trim() : '';
  if (!itemName) return null;

  const action = parsed.action;
  if (action !== 'gained' && action !== 'lost' && action !== 'transferred' && action !== 'held') {
    return null;
  }

  return {
    transferType: 'item_transfer',
    itemName,
    fromCharacter: typeof parsed.fromCharacter === 'string' ? parsed.fromCharacter.trim() : '',
    toCharacter: typeof parsed.toCharacter === 'string' ? parsed.toCharacter.trim() : '',
    action,
    context: typeof parsed.context === 'string' ? parsed.context : '',
  };
}

/** 对象 → 角色别名关系，判别字段不是 alias_match 时返回 null */
function toStreamAliasMatch(parsed: Record<string, unknown>): StreamAliasMatch | null {
  if (parsed.aliasType !== 'alias_match') return null;

  const primaryName = typeof parsed.primaryName === 'string' ? parsed.primaryName.trim() : '';
  if (!primaryName) return null;

  const aliases = Array.isArray(parsed.aliases)
    ? parsed.aliases
        .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        .map((a) => a.trim())
    : [];

  if (aliases.length === 0) return null;

  return {
    aliasType: 'alias_match',
    primaryName,
    aliases,
    context: typeof parsed.context === 'string' ? parsed.context : '',
  };
}

/** 对象 → 积分流水（系统文）；只接受明确写出的数字/赠予，不猜测 */
function toStreamCreditTransaction(
  parsed: Record<string, unknown>,
  defaultChapter: number,
): StreamCreditTransaction | null {
  if (parsed.creditType !== 'credit_transaction') return null;

  const action = parsed.action;
  if (action !== 'gain' && action !== 'spend' && action !== 'gift') return null;

  const characterName =
    typeof parsed.characterName === 'string'
      ? parsed.characterName.trim()
      : typeof parsed.name === 'string'
        ? parsed.name.trim()
        : '';
  if (!characterName) return null;

  const rawAmount = typeof parsed.amount === 'number' ? parsed.amount : Number(parsed.amount);
  if (!Number.isFinite(rawAmount) || rawAmount < 0) return null;

  // 赠予不涉及积分；gain/spend 必须是明确的正数
  const amount = action === 'gift' ? 0 : rawAmount;
  if (action !== 'gift' && amount <= 0) return null;

  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  const itemName = typeof parsed.itemName === 'string' ? parsed.itemName.trim() : '';
  if (action === 'gift' && !reason && !itemName) return null;

  return {
    creditType: 'credit_transaction',
    action,
    characterName,
    amount,
    ...(reason ? { reason } : {}),
    ...(itemName ? { itemName } : {}),
    chapterOrder: defaultChapter,
  };
}

/** 对象 → 时间线事件（扫描始终针对当前章节，不采信模型编造的 chapterOrder） */
function toTimelineEvent(
  parsed: Record<string, unknown>,
  defaultChapter: number,
  chapterContent?: string,
): StreamTimelineEvent | null {
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title) return null;
  // 模型偶尔会把格式示例原样吐出来，直接丢弃
  if (title === '事件标题' || title.toLowerCase() === 'title') return null;

  const { quote, fabricated } = validateEventQuote(parsed.quote, chapterContent);
  // ★ 给了 quote 却对不上原文 = 这条事件是编的；宁可不记，也不能污染时间线
  if (fabricated) return null;

  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';

  return {
    title: title.slice(0, 30),
    description: description || quote || title,
    type: normalizeEventType(parsed.type),
    // ★ 只保留原文里真的出现过的称呼，避免模型把不相干的角色挂到事件上
    characterNames: filterNamesPresentInText(
      normalizeStringArray(parsed.characterNames ?? parsed.participants),
      chapterContent,
    ),
    chapterOrder: defaultChapter,
    timestamp:
      typeof parsed.timestamp === 'string' && parsed.timestamp.trim()
        ? parsed.timestamp.trim()
        : undefined,
    ...(quote ? { quote } : {}),
  };
}

/**
 * 按判别字段把一条 JSON 对象转换为扫描记录。
 * 顺序与旧实现保持一致：实体 → 别名 → 流转 → 积分流水 → 事件。
 */
export function parseStreamRecord(
  value: unknown,
  defaultChapter: number,
  chapterContent?: string,
): StreamRecord | null {
  const parsed = asObjectRecord(value);
  if (!parsed) return null;

  const entity = toStreamEntity(parsed);
  if (entity) return { kind: 'entity', entity };

  const aliasMatch = toStreamAliasMatch(parsed);
  if (aliasMatch) return { kind: 'alias', aliasMatch };

  const transfer = toStreamItemTransfer(parsed);
  if (transfer) return { kind: 'transfer', transfer };

  const credit = toStreamCreditTransaction(parsed, defaultChapter);
  if (credit) return { kind: 'credit', credit };

  const event = toTimelineEvent(parsed, defaultChapter, chapterContent);
  if (event) return { kind: 'event', event };

  return null;
}

// ============================================================
// 按关键词提取事件（用于时间线手动添加时的智能推荐）
// ============================================================

const EXTRACT_BY_KEYWORD_SYSTEM_PROMPT = `你是一个专业的小说时间线编辑。用户会给出一个关键词（通常是角色名、地点名或物品名），你要从章节原文中提取与它【直接相关】的剧情事件，供时间线使用。

【相关性判定】
- 关键词所指的人/物/地参与了这个事件，或事件的经过、结果直接作用于它；
- 只是在环境、回忆或旁白里被顺带提到、没有推动剧情的，不算；
- 关键词可能有别名、简称或尊称，请结合上下文判断是否指同一对象；
- 绝不能脑补原文没有发生的情节。宁可少提，也不要编造。

【提取规则】
- ★ 先逐段通读全文，再输出：每个包含关键词的段落都要判断一次，不要只看开头几段就收尾；
- 按原文的叙事先后顺序输出；
- 一个独立的情节动作/转折成一条；不同时间、不同地点、不同因果的动作**不得合并**；只有描述同一动作的分句才合并；
- title：动宾短语，8～15 字，能独立看懂（如「陈星夜探藏经阁」）；不要以「本章」「故事」「随后」这类空话开头，也不要把角色名当标题；
- description：交代起因—经过—结果，30～80 字，只写原文实际发生的事，不加评价、不推测动机；
- type：event=剧情推进；foreshadow=埋线/暗示；state_change=身份、关系、位置、能力等状态改变；
- characterNames：只列在本事件中实际出场或直接受影响的角色，且必须是原文中**逐字出现过**的称呼；没有角色就输出空数组；
- timestamp：原文有明确故事内时间（如「三日后」「子时」）才填，不要自己推算，否则省略该字段；
- quote ★必填：从原文【逐字复制】10～40 字、最能定位该事件的连续片段；不得改写、拼接、加省略号、不得跨段拼凑；
- ★ 如果找不到能逐字复制的 quote，说明这件事不是原文实际发生的，**不要输出这条事件**；
- 不要输出纯环境描写、内心感慨、背景交代；不要为了凑数编造，也不要因为已经提取到几条就停止。

【输出格式（极其重要）】
- 每个事件输出一行 JSON，行与行之间用换行分隔；
- 不要输出数组括号、Markdown 代码块、编号或任何解释文字；
- 字段示例：{"title":"...","description":"...","type":"event","characterNames":["..."],"timestamp":"...","quote":"..."}`;

/** 单次提取的事件上限：防止模型失控刷屏拖垮时间线 UI */
const MAX_KEYWORD_EVENTS = 80;

export interface KeywordExtractInput {
  chapterContent: string;
  chapterTitle: string;
  chapterOrder: number;
  keyword: string;
  /** 关键词在人物设定里的别名/全名（可选，用于判断「星儿」与「陈星」是同一人） */
  keywordAliases?: string[];
}

export interface KeywordEventParseState {
  /** 跨 chunk 的增量 JSON 扫描器（保留未闭合对象状态，避免重扫） */
  scanner: JsonObjectStreamParser;
  /** 本次提取内已发出的事件标题键，用于去重 */
  seenTitles: Set<string>;
}

export function createKeywordEventParseState(): KeywordEventParseState {
  return { scanner: new JsonObjectStreamParser(), seenTitles: new Set() };
}

/** 标题归一化：去空白/标点、转小写，用于同一批提取内的去重 */
function eventTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 去掉模型习惯性添加的引号/省略号，保留可逐字检索的原文片段 */
function normalizeQuoteText(s: string): string {
  return s
    .replace(/^[\s「『“‘"'（(]+/, '')
    .replace(/[\s」』”’"'）)]+$/, '')
    .replace(/^(?:…|\.{3,}|。{2,})+/, '')
    .replace(/(?:…|\.{3,})+$/, '')
    .trim();
}

function compactForMatch(s: string): string {
  // 注意：JS 的 \s 已包含全角空格 U+3000，无需再单列
  return s.replace(/\s+/g, '').replace(/[「」『』“”"']/g, '');
}

/**
 * 校验 quote 是否真的出自原文。
 * 模型经常改写、拼接或加省略号，导致前端按 quote 定位章节时找不到锚点；
 * 这里只保留能在原文中连续命中的片段，命中不了就丢弃 quote（事件本身仍保留）。
 */
export function sanitizeKeywordQuote(quote: unknown, chapterContent: string): string | undefined {
  if (typeof quote !== 'string') return undefined;
  const cleaned = normalizeQuoteText(quote);
  const compactQuote = compactForMatch(cleaned);
  if (compactQuote.length < 6) return undefined;
  return compactForMatch(chapterContent).includes(compactQuote) ? cleaned.slice(0, 80) : undefined;
}

/**
 * 校验模型给出的事件证据（quote）。
 *
 * 三种情况要区分开：
 *  - 没给 quote      → 不判伪（兼容旧输出/模型偷懒），事件保留；
 *  - 给了且能对上原文 → 保留并回填规范化后的 quote；
 *  - 给了却对不上原文 → fabricated=true，调用方应丢弃该事件。
 *
 * 只有第三种是「编造」的确定性信号，也是这次提升准确率的核心闸门。
 */
export function validateEventQuote(
  rawQuote: unknown,
  chapterContent?: string,
): { quote?: string; fabricated: boolean } {
  if (typeof rawQuote !== 'string' || !rawQuote.trim()) {
    return { fabricated: false };
  }
  if (!chapterContent) {
    return { quote: rawQuote.trim(), fabricated: false };
  }
  const quote = sanitizeKeywordQuote(rawQuote, chapterContent);
  return { quote, fabricated: !quote };
}

/**
 * 只保留在章节原文中真实出现过的角色称呼。
 *
 * 模型常见的两种「挂错」：把传闻/回忆里的人物挂到当前事件，
 * 或把文中称呼规范化成原文没写过的全名。名字对不上原文就不挂关系——
 * 宁可少挂，也不能把关系挂到错误的人身上。
 */
export function filterNamesPresentInText(names: string[], chapterContent?: string): string[] {
  if (!chapterContent) return names;
  const compactChapter = compactForMatch(chapterContent);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const compactName = compactForMatch(trimmed);
    if (!compactName || !compactChapter.includes(compactName)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept;
}

/** 把一条原始 JSON 对象规整为时间线事件；不合格返回 null */
function toKeywordEvent(
  value: unknown,
  defaultChapter: number,
  chapterContent: string,
): (StreamTimelineEvent & { quote?: string }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  if (!title) return null;
  // 模型偶尔会把格式示例原样吐出来，直接丢弃
  if (title === '事件标题' || title.toLowerCase() === 'title') return null;

  const { quote, fabricated } = validateEventQuote(parsed.quote, chapterContent);
  // ★ 给了 quote 却对不上原文 = 这条事件是编的，直接丢弃
  if (fabricated) return null;

  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';

  return {
    title: title.slice(0, 24),
    description: description || quote || title,
    type: normalizeEventType(parsed.type),
    // ★ 只保留原文里真的出现过的称呼，避免模型把不相干的角色挂到事件上
    characterNames: filterNamesPresentInText(
      normalizeStringArray(parsed.characterNames ?? parsed.participants),
      chapterContent,
    ),
    // 关键词提取始终针对当前章节，不采信模型可能编造的 chapterOrder
    chapterOrder: defaultChapter,
    timestamp:
      typeof parsed.timestamp === 'string' && parsed.timestamp.trim()
        ? parsed.timestamp.trim()
        : undefined,
    ...(quote ? { quote } : {}),
  };
}

/** 把解析出的原始对象规整、去重后转为事件 */
function collectKeywordEvents(
  state: KeywordEventParseState,
  values: unknown[],
  defaultChapter: number,
  chapterContent: string,
): (StreamTimelineEvent & { quote?: string })[] {
  const emitted: (StreamTimelineEvent & { quote?: string })[] = [];
  for (const value of values) {
    if (state.seenTitles.size >= MAX_KEYWORD_EVENTS) break;
    const event = toKeywordEvent(value, defaultChapter, chapterContent);
    if (!event) continue;

    const key = eventTitleKey(event.title);
    if (!key || state.seenTitles.has(key)) continue;
    state.seenTitles.add(key);
    emitted.push(event);
  }
  return emitted;
}

/** 消费一个流式 chunk，返回本次新解析出的、去重后的事件 */
export function drainKeywordEventChunk(
  state: KeywordEventParseState,
  chunk: string,
  defaultChapter: number,
  chapterContent: string,
): (StreamTimelineEvent & { quote?: string })[] {
  return collectKeywordEvents(
    state,
    state.scanner.push(chunk),
    defaultChapter,
    chapterContent,
  );
}

/** 流结束：把增量扫描器残留的完整嵌套对象也恢复出来 */
export function flushKeywordEventChunk(
  state: KeywordEventParseState,
  defaultChapter: number,
  chapterContent: string,
): (StreamTimelineEvent & { quote?: string })[] {
  return collectKeywordEvents(
    state,
    state.scanner.flush().values,
    defaultChapter,
    chapterContent,
  );
}

/**
 * 按关键词流式提取事件
 *
 * @param chatStream Provider 的流式聊天函数
 * @param input 章节内容 + 关键词 + 可选别名
 * @param options.signal 外部取消信号
 * @param options.onEvent 每解析出一个完整事件时回调
 */
export async function streamEventsByKeyword(
  chatStream: (messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }, signal?: AbortSignal) => AsyncGenerator<StreamChunk>,
  input: KeywordExtractInput,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: StreamTimelineEvent & { quote?: string }) => void;
  } = {},
): Promise<(StreamTimelineEvent & { quote?: string })[]> {
  const aliases = (input.keywordAliases ?? [])
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a !== input.keyword)
    .slice(0, 10);
  const aliasNote =
    aliases.length > 0
      ? `\n\n（该关键词在设定中也可能被称为：${aliases.join('、')}；判断相关性时请视为同一对象。）`
      : '';

  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_BY_KEYWORD_SYSTEM_PROMPT },
    { role: 'user', content: `请从以下章节中提取与「${input.keyword}」直接相关的所有事件。${aliasNote}

章节：第${input.chapterOrder}章 ${input.chapterTitle}

章节原文：
${input.chapterContent}` },
  ];

  const events: (StreamTimelineEvent & { quote?: string })[] = [];
  const state = createKeywordEventParseState();

  for await (const chunk of chatStream(messages, { temperature: 0.3, maxTokens: 8192 }, options.signal)) {
    const emitted = drainKeywordEventChunk(
      state,
      chunk.content || '',
      input.chapterOrder,
      input.chapterContent,
    );
    for (const event of emitted) {
      events.push(event);
      options.onEvent?.(event);
    }
    if (events.length >= MAX_KEYWORD_EVENTS) break;
  }

  // 流结束时处理残留 buffer
  for (const event of flushKeywordEventChunk(state, input.chapterOrder, input.chapterContent)) {
    events.push(event);
    options.onEvent?.(event);
  }

  return events;
}
