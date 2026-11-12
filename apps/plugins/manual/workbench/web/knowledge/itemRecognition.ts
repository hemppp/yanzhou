// ============================================================
// 物品识别后处理算法
//
// AI 的 item 实体行不可直接信任：实测会把「500 积分」「系统面板」
// 这类货币/系统 UI 当成物品，也会把角色/地点名、原文里没出现的
// 名词写进物品库。这里做一层确定性校验：
//   ① 名称归一化（列表序号、成对引号/括号、尾部品阶标注、空白）
//   ② 非物品名单过滤（货币/数值/属性/系统 UI/描述性短语/句子片段）
//   ③ 与角色/地点同名过滤
//   ④ 原文接地校验（名称必须出现在 context 或本章正文）
//   ⑤ 已有物品按归一化键去重
//   ⑥ AI 类型归一化 + 名称后缀兜底推断（最长后缀优先）
//
// 2026-11 优化：
//   · 修复成对括号只删右半边导致「青锋剑（上品」截断的问题
//   · 列表符号 - / • / · / （1） 现在能正确剥离
//   · 数值过滤支持「单位 + 数字」反向写法与属性/状态词
//   · 类型推断改为最长后缀优先，消除「飞剑→武器」「牡丹→丹药」误判
//   · 名称分析与接地文本复用，避免同一候选重复归一化 4 次
// ============================================================

import type { Item } from '@novel/shared';

/** 物品类型别名表：把 AI 的中文类型词/类型码映射到标准类型码 */
const ITEM_TYPE_ALIASES: Record<string, string> = {
  weapon: 'weapon', 武器: 'weapon', 兵器: 'weapon', 兵刃: 'weapon', 装备: 'weapon',
  armor: 'armor', 防具: 'armor', 铠甲: 'armor', 软甲: 'armor', 盔甲: 'armor', 护具: 'armor',
  clothing: 'clothing', 衣物: 'clothing', 衣服: 'clothing', 服饰: 'clothing', 服装: 'clothing',
  佩饰: 'clothing', 首饰: 'clothing', 饰品: 'clothing', 戴饰: 'clothing', 衣袍: 'clothing', 袍服: 'clothing',
  面具: 'clothing',
  treasure: 'treasure', 宝物: 'treasure', 财宝: 'treasure', 珍宝: 'treasure', 金银: 'treasure', 财物: 'treasure',
  token: 'token', 信物: 'token', 令牌: 'token', 令牌信物: 'token', 符: 'token', 符箓: 'token',
  artifact: 'artifact', 法器: 'artifact', 法宝: 'artifact', 神器: 'artifact', 灵宝: 'artifact',
  傀儡: 'artifact', 阵盘: 'artifact',
  medicine: 'medicine', 药物: 'medicine', 药品: 'medicine', 解药: 'medicine', 毒药: 'medicine',
  potion: 'potion', 丹药: 'potion', 丹: 'potion',
  book: 'book', 书籍: 'book',
  document: 'document', 文书: 'document', 书信: 'document', 信件: 'document', 地图: 'document',
  scroll: 'scroll', 卷轴: 'scroll', 秘籍: 'scroll', 功法: 'scroll',
  key: 'key', 钥匙: 'key',
  vehicle: 'vehicle', 载具: 'vehicle', 交通工具: 'vehicle', 坐骑: 'vehicle', 马车: 'vehicle', 船只: 'vehicle', 飞剑: 'vehicle',
  gem: 'gem', 宝石: 'gem', 玉器: 'gem', 珠宝: 'gem', 夜明珠: 'gem',
  tool: 'tool', 工具: 'tool', 器具: 'tool',
  food: 'food', 食物: 'food',
  plant: 'plant', 植物: 'plant', 灵草: 'plant', 灵果: 'plant',
  animal: 'animal', 动物: 'animal', 灵兽: 'animal',
  prop: 'prop', 道具: 'prop', 杂物: 'prop',
  other: 'other', 其他: 'other',
};

/** 物品标准类型码集合（与 ItemManager 配色词表一致） */
const ITEM_TYPE_CODES = new Set([
  'weapon', 'token', 'artifact', 'document', 'key', 'medicine', 'clothing', 'vehicle',
  'treasure', 'book', 'food', 'plant', 'animal', 'tool', 'prop', 'potion', 'armor', 'scroll', 'gem', 'other',
]);

/** 类型归一化：AI 输出的类型码/中文类型词 → 标准类型码；无法识别回退 other */
export function normalizeItemType(raw?: string): string {
  if (!raw) return 'other';
  const key = raw.trim().toLowerCase();
  if (ITEM_TYPE_CODES.has(key)) return key;
  return ITEM_TYPE_ALIASES[key] ?? 'other';
}

/** 全角 ASCII（ＡＢＣ１２３，（））转半角；仅用于匹配，不改展示名 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/** 成对包裹符号：只有左右都匹配才剥离，避免只删半边造成截断 */
const WRAPPING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'],
  ['《', '》'], ['〈', '〉'], ['【', '】'], ['[', ']'],
  ['（', '）'], ['(', ')'], ['<', '>'], ['{', '}'],
  ['"', '"'], ["'", "'"],
];

function stripWrappingPairs(input: string): string {
  let s = input.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of WRAPPING_PAIRS) {
      // 对称引号至少 3 个字符才剥，避免把单引号/双引号名字本身删掉
      const symmetric = left === right;
      if (
        s.length > (symmetric ? 2 : 1) &&
        s.startsWith(left) &&
        s.endsWith(right)
      ) {
        s = s.slice(left.length, s.length - right.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

/** 列表序号/项目符号：`1.` `1、` `（1）` `-` `•` `·` `*` … */
const LIST_MARKER =
  /^\s*(?:[-–—•·▪●○*]+|\d+\s*[.、)）]|[（(【\[]\s*\d+\s*[）)】\]]|[（(【\[]\s*[一二三四五六七八九十]+\s*[）)】\]])\s*/;

/** 尾部品阶/状态标注：只剥离「已知品阶」或纯数字，保留其他有意义的括注 */
const QUALIFIER_WORDS = new Set([
  '上品', '中品', '下品', '极品', '绝品', '凡品', '仙品', '神品',
  '残卷', '残本', '残篇', '真品', '赝品', '仿品', '仿制', '完整', '破损', '已损', '旧', '新',
]);

function stripTrailingQualifier(input: string): string {
  const m = input.match(/^(.*\S)\s*[（(【\[]([^（(【\[\]】)）]{1,8})[）)】\]]$/);
  if (!m) return input;
  const [, baseRaw = '', innerRaw = ''] = m;
  const base = baseRaw.trim();
  const inner = innerRaw.trim();
  if (!base) return input;
  const isQualifier = /^[0-9一二三四五六七八九十]+$/.test(inner) || QUALIFIER_WORDS.has(inner);
  return isQualifier ? base : input;
}

/** 名称归一化：去列表序号、成对包裹符号、尾部品阶标注、多余空白 */
export function normalizeItemName(raw: string): string {
  let name = String(raw ?? '').trim();
  name = stripWrappingPairs(name);
  name = name.replace(LIST_MARKER, '');
  name = stripWrappingPairs(name);
  name = stripTrailingQualifier(name);
  return name.replace(/\s+/g, ' ').trim();
}

/** 仅供比较的紧凑键：去空白/标点/引号、全角转半角、转小写 */
export function itemNameKey(raw: string): string {
  return toHalfWidth(normalizeItemName(raw))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 接地比较用文本：半角化、去空白、去引号/括号/间隔号 */
function compactText(s: string): string {
  return toHalfWidth(s)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[「」『』“”‘’"'《》〈〉【】[\]（）()·・]/g, '');
}

/** 系统 UI 元素：面板/菜单/按钮这类界面名词，不是实体物品 */
const SYSTEM_UI_WORDS = [
  '系统面板', '属性面板', '任务面板', '商城界面', '系统界面', '系统提示', '系统消息',
  '任务提示', '任务列表', '任务奖励弹窗', '对话框', '提示框', '弹窗', '状态栏', '属性栏',
  '技能栏', '任务栏', '菜单栏', '按钮', '面板', '界面', '菜单', '系统商城', '商城',
  '背包界面', '聊天框', '加载条', '进度条', '弹幕', '屏幕', '信号格', '直播间', '广告牌', '告示板',
];

/** 抽象概念/属性：单独成词时不是物品（「任务令牌」不受影响） */
const ABSTRACT_WORDS = new Set([
  '积分', '经验', '等级', '属性', '任务', '奖励', '系统', '技能点', '天赋点', '属性点',
  '金币', '银两', '银币', '铜币', '硬币', '纸币', '钱币', '灵石', '灵晶', '元宝', '钻石', '铜钱',
  '银元', '大洋', '铜板', '黄金', '贡献', '贡献点', '声望', '体力', '生命', '法力',
  '魅力', '好感', '好感度', '幸运', '幸运值', '悟性', '根骨', '灵根', '修为', '境界',
  '攻击力', '防御力', '战斗力', '生命值', '法力值', '魅力值', '丹田',
  '气运', '机缘', '因果', '功德', '香火', '信仰', '恐惧', '愤怒', '回忆', '记忆', '梦境',
  '粮草', '军饷', '输出', '功率', '力量', '速度', '敏捷', '智力', '精神',
  '零钱', '信用点', '能力', '技能', '超能力', '剑心', '道心', '佛心', '魔心',
]);

/** 声/光/火/雾等感知现象：AI 偶尔会把它们当物品输出 */
const NON_ENTITY_PATTERN =
  /(?:声|音|气味|味道|气息|杀气|杀意|剑意|刀意|光|雾|风雪|火光|烛火|灯光|炉火|篝火|白烟|浓烟|炊烟|烟雾|蒸汽|白汽|水汽|气)$/;

/** 游戏系统玩法名词：副本/排行榜不是实体 */
const GAME_SYSTEM_PATTERN =
  /(?:副本|排行榜|公告|签到|抽奖|任务栏|技能栏|血条|蓝条|经验条)$/;

/** 功法/招式/法术本身不是物品（秘籍、卷轴等实物载体另由后缀识别） */
const TECHNIQUE_PATTERN =
  /(?:心法|身法|步法|剑法|刀法|拳法|掌法|腿法|功法|法术|秘术|神通|剑招|刀招|招式|阵法|符术|咒术|法|术|功|招|式|罩)$/;

/** 组织/地点后缀：被误标成 item 的宗门、城池、殿阁 */
const ORG_LOCATION_PATTERN =
  /(?:宗|门|派|帮|会|阁|殿|寺|观|堂|山庄|书院|学院|宫|楼|城|仓库|峰|洞|冢|村|府|院|部|巷|廊|站|校|厂|亭)$/;

/** 时间短语：三日后、九月、一炷香、午夜十二点 */
const TIME_PATTERN = /(?:年|月|日|天|夜|时辰|更|刻|炷香|息|日后|天后|月后|年后|时辰后)$/;
const TIME_OF_DAY_PATTERN = /(?:[0-9一二三四五六七八九十百]+点(?:半|整)?)$/;

/** 痕迹/证据：指纹、脚印、血迹、录像 */
const TRACE_PATTERN =
  /(?:指纹|脚印|足迹|血迹|毛发|唾液|痕迹|监控录像|录像|录音)$/;

const CN_NUM = '0-9一二三四五六七八九十百千万亿两零〇半';
const NUM_VALUE = `[+-]?[${CN_NUM}]+(?:\\.[0-9]+)?%?`;
/** 货币/属性单位，长词在前，避免「贡献点」被「点」抢先匹配 */
const STAT_UNIT =
  '贡献点|贡献|技能点|天赋点|属性点|生命值|法力值|魅力值|幸运值|攻击力|防御力|战斗力|好感度|' +
  '积分|声望|经验|体力|生命|法力|魅力|好感|幸运|悟性|根骨|灵根|修为|境界|等级|属性|' +
  '输出|功率|能量|暴击率|暴击|命中|闪避|速度|敏捷|力量|智力|精神|' +
  '信用点|块钱|金币|银两|银币|银元|大洋|铜板|灵石|灵晶|元宝|钻石|铜钱|元|点|hp|mp|exp|lv';

const NUMERIC_WITH_UNIT = new RegExp(`^${NUM_VALUE}\\s*(?:万|千|百|亿)?\\s*(?:${STAT_UNIT})$`, 'i');
const UNIT_WITH_NUMERIC = new RegExp(`^(?:${STAT_UNIT})\\s*${NUM_VALUE}$`, 'i');

const QUANTITY_PREFIX = new RegExp(
  `^[${CN_NUM}]+(?:\\.[0-9]+)?\\s*(?:大|小|满)?\\s*` +
    `(?:个|件|把|枚|颗|块|瓶|袋|张|只|条|支|次|级|章|柄|面|卷|本|部|套|双|对|副|锭|株|匹|艘|辆|座|盏|炷|份|截|罐|包|碗|勺|碟|串|门|盒|缸)`,
);

const PRONOUN_PREFIX = /^(?:那|这|此|某|他|她|它|你|我)(?:个|把|枚|件|只|条|张|支|柄|颗|块|瓶|袋)?/;

type NonItemCheck = { nonItem: boolean; reason?: string };

function checkNonItem(name: string, lower: string): NonItemCheck {
  if (!name) return { nonItem: true, reason: '空名称' };

  // 纯数字 / 百分比（含中文数字，如「三」「五百」「12.5」）
  if (new RegExp(`^[${CN_NUM}]+(?:\\.[0-9]+)?%?$`).test(lower)) {
    return { nonItem: true, reason: '纯数字' };
  }

  // 数字 + 货币/属性单位，以及「积分+500」「HP 100」「等级3」这类反向写法
  if (NUMERIC_WITH_UNIT.test(lower) || UNIT_WITH_NUMERIC.test(lower)) {
    return { nonItem: true, reason: '数值/货币' };
  }

  // 数量短语（如「三个人」「五把剑」「一百零八颗佛珠」）
  if (QUANTITY_PREFIX.test(lower)) {
    return { nonItem: true, reason: '数量短语' };
  }

  // 货币/抽象概念单独成词（「任务令牌」包含令牌，不在此列）
  if (ABSTRACT_WORDS.has(lower)) {
    return { nonItem: true, reason: '抽象概念' };
  }

  // 系统 UI 元素
  if (SYSTEM_UI_WORDS.some((w) => lower.includes(w))) {
    return { nonItem: true, reason: '系统界面元素' };
  }

  // 声/光/火/雾等感知现象，不是实体物品
  if (NON_ENTITY_PATTERN.test(name)) {
    return { nonItem: true, reason: '非实体' };
  }

  // 游戏副本/公会/排行榜这类玩法名词
  if (GAME_SYSTEM_PATTERN.test(name)) {
    return { nonItem: true, reason: '系统玩法' };
  }

  // 功法/招式/法术本身，不是实物道具
  if (TECHNIQUE_PATTERN.test(name)) {
    return { nonItem: true, reason: '功法招式' };
  }

  // 宗门/城池/殿阁等组织与地点
  if (ORG_LOCATION_PATTERN.test(name)) {
    return { nonItem: true, reason: '组织/地点' };
  }

  // 时间短语（「三日后」「九月」「午夜十二点」）
  if (TIME_PATTERN.test(name) || TIME_OF_DAY_PATTERN.test(name)) {
    return { nonItem: true, reason: '时间短语' };
  }

  // 指纹/脚印/血迹/录像等痕迹证据
  if (TRACE_PATTERN.test(name)) {
    return { nonItem: true, reason: '痕迹/证据' };
  }

  // 指代/数量前缀（「那把剑」「这个玉佩」）——不是物品专名
  if (name.length >= 3 && PRONOUN_PREFIX.test(name)) {
    return { nonItem: true, reason: '指代短语' };
  }

  // 描述性短语（「沈知意的玉佩」「他的剑」）——除非是「的卢」这类两字专名
  if (name.length >= 4 && name.includes('的')) {
    return { nonItem: true, reason: '描述性短语' };
  }

  // 明显是句子片段（AI 偶尔把整句原文当名字）
  if (/[。！？；，、,.!?;,\n\r:：]/.test(name)) {
    return { nonItem: true, reason: '句子片段' };
  }

  if (name.length > 20) return { nonItem: true, reason: '名称过长' };
  if (name.length < 2) return { nonItem: true, reason: '名称过短' };

  return { nonItem: false };
}

/**
 * 判断是否明显不是实体物品。
 * 返回 nonItem=true 时 reason 用于诊断日志。
 */
export function isLikelyNonItemName(raw: string): NonItemCheck {
  const name = normalizeItemName(raw);
  return checkNonItem(name, toHalfWidth(name).toLowerCase());
}

/** 名称后缀 → 类型兜底（仅当 AI 类型缺失或为 other 时使用） */
const TYPE_SUFFIXES: Array<{ type: string; suffixes: string[] }> = [
  { type: 'weapon', suffixes: ['剑', '刀', '枪', '炮', '弓', '锤', '刃', '戟', '鞭', '棍', '箭', '弩', '弹', '匕首', '长矛', '暗器', '飞刀', '斧', '钺', '钩', '叉', '锏', '棒', '杖', '镖', '手雷', '炸弹', '地雷', '手榴弹'] },
  { type: 'armor', suffixes: ['甲', '盔', '盾', '盾牌', '护腕', '护心镜', '软甲', '铠甲', '盔甲', '战甲', '护甲'] },
  {
    type: 'clothing',
    suffixes: ['袍', '衣', '裙', '衫', '冠', '服', '靴', '鞋', '袜', '披风', '斗篷', '面纱', '手镯', '项链', '耳环', '发簪', '簪', '钗', '玉佩', '戒指', '扳指', '腰带', '香囊', '荷包', '面具', '吊坠', '坠', '步摇', '帕', '帕子', '帽', '兜帽', '披帛', '手套', '镯', '玉镯', '床单', '被单'],
  },
  { type: 'potion', suffixes: ['丹', '丸', '散', '膏', '药水', '丹药', '液', '药剂', '药液', '针剂', '剂'] },
  { type: 'medicine', suffixes: ['药', '草', '灵药', '草药'] },
  { type: 'scroll', suffixes: ['经', '诀', '谱', '秘籍', '卷轴', '玉简', '竹简', '功法', '秘典'] },
  { type: 'book', suffixes: ['书', '册', '简', '典', '录', '本', '簿', '古籍', '书册', '典籍'] },
  { type: 'document', suffixes: ['图', '信', '诏', '契', '文书', '地图', '藏宝图', '通缉令', '纸', '羊皮纸', '诏书', '圣旨', '状', '报', '报表', '单', '药方', '请假条', '借条', '收条', '欠条', '密电码'] },
  { type: 'token', suffixes: ['令', '符', '符纸', '印', '牌', '令牌', '信物', '虎符', '印章', '玉玺', '令箭', '腰牌', '章', '徽章'] },
  { type: 'gem', suffixes: ['珠', '玉', '宝石', '晶石', '晶'] },
  { type: 'key', suffixes: ['钥匙'] },
  { type: 'vehicle', suffixes: ['车', '船', '舟', '马', '轿', '号', '机甲', '轮椅', '无人机', '飞剑', '飞舟', '飞船', '战船', '坐骑'] },
  { type: 'tool', suffixes: ['灯', '镜', '盒', '箱', '袋', '壶', '杯', '盏', '罗盘', '伞', '扇', '炉', '钟', '铃', '铲', '表', '阀', '计', '轮', '盆', '架', '仪', '剑鞘', '丹炉', '匣', '电池', '包', '机', '手电', '筒', '烛', '扳手', '火把', '火折子', '终端', '芯片', '无线电'] },
  { type: 'artifact', suffixes: ['塔', '幡', '鼎', '葫芦', '符箓', '阵盘'] },
  { type: 'treasure', suffixes: ['金条'] },
  { type: 'plant', suffixes: ['草', '花', '树', '藤', '莲', '参', '芝', '果', '菜', '灵草', '灵果', '灵芝', '人参'] },
  { type: 'food', suffixes: ['饭', '面', '酒', '茶', '糕', '饼', '糖', '面包', '粮', '汤', '肉', '蛋', '辣子'] },
  { type: 'animal', suffixes: ['兽', '鸟', '虫', '鱼', '蛇', '狐', '狼', '虎', '鹿', '鹰', '鹤', '猿', '熊'] },
];

/** 同名异义的高频词：后缀判定会误伤的，先做精确覆盖 */
const TYPE_OVERRIDES: Record<string, string> = {
  牡丹: 'plant',
  兰花: 'plant',
  菊花: 'plant',
  梅花: 'plant',
  桃花: 'plant',
  莲花: 'plant',
  玉米: 'food',
  糯米: 'food',
  海马: 'animal',
  斑马: 'animal',
  河马: 'animal',
  的卢: 'vehicle',
};

/** 展开成「后缀 → 类型」，长度相同时按上表顺序取先者 */
const TYPE_SUFFIX_ENTRIES: Array<{ suffix: string; type: string }> = TYPE_SUFFIXES.flatMap(
  ({ type, suffixes }) => suffixes.map((suffix) => ({ suffix, type })),
);

/** 内部：已归一化名称 → 类型 */
function inferItemTypeFromNormalized(normalized: string): string {
  if (!normalized) return 'other';
  const override = TYPE_OVERRIDES[normalized];
  if (override) return override;

  let bestType = 'other';
  let bestLength = 0;
  for (const { suffix, type } of TYPE_SUFFIX_ENTRIES) {
    // 最长后缀优先：飞剑(2) > 剑(1)，玉佩(2) > 玉(1)
    if (suffix.length > bestLength && normalized.endsWith(suffix)) {
      bestLength = suffix.length;
      bestType = type;
    }
  }
  return bestType;
}

export function inferItemType(name: string): string {
  return inferItemTypeFromNormalized(normalizeItemName(name));
}

function resolveItemTypeFromNormalized(normalized: string, aiType?: string): string {
  const normalizedType = normalizeItemType(aiType);
  return normalizedType === 'other' ? inferItemTypeFromNormalized(normalized) : normalizedType;
}

/** 优先用 AI 类型；AI 没给出或给了 other 时按名称后缀兜底 */
export function resolveItemType(name: string, aiType?: string): string {
  return resolveItemTypeFromNormalized(normalizeItemName(name), aiType);
}

export interface ItemCandidate {
  name: string;
  itemType?: string;
  context?: string;
  description?: string;
}

/**
 * 原始上下文。单条校验可直接传；
 * 批量校验请先用 prepareItemContext 预建索引，避免每条候选重建 Map。
 */
export interface ItemCandidateContext {
  /** 当前章节纯文本，用于「名称必须真实出现」的接地校验 */
  chapterContent?: string;
  existingItems?: Item[];
  existingCharacters?: Array<{ name: string }>;
  existingLocations?: Array<{ name: string }>;
}

/**
 * 预建索引：一章扫描开始时 build 一次，
 * 之后每个候选只做 O(1) 查表，不再重新 filter/normalize 整库。
 * 同一次扫描中新落库的物品/角色/地点用 addItem / addEntityName 增量更新。
 */
export interface PreparedItemContext {
  /** 已压缩的本章正文；undefined 表示不需要接地校验 */
  chapterCompact?: string;
  /** 原文是否真的提供了章节正文（空字符串不算） */
  hasChapterContent: boolean;
  /** 角色/地点归一化键 */
  entityKeys: Set<string>;
  /** 已有物品：归一化键 → Item（同名取第一个，与旧 find 语义一致） */
  itemsByKey: Map<string, Item>;
  addEntityName(name: string): void;
  addItem(item: Item): void;
}

export function prepareItemContext(ctx: ItemCandidateContext = {}): PreparedItemContext {
  const entityKeys = new Set<string>();
  for (const entity of [...(ctx.existingCharacters ?? []), ...(ctx.existingLocations ?? [])]) {
    const key = itemNameKey(entity.name);
    if (key) entityKeys.add(key);
  }

  const itemsByKey = new Map<string, Item>();
  for (const item of ctx.existingItems ?? []) {
    const key = itemNameKey(item.name);
    if (key && !itemsByKey.has(key)) itemsByKey.set(key, item);
  }

  return {
    chapterCompact: ctx.chapterContent ? compactText(ctx.chapterContent) : undefined,
    hasChapterContent: Boolean(ctx.chapterContent),
    entityKeys,
    itemsByKey,
    addEntityName(name: string) {
      const key = itemNameKey(name);
      if (key) entityKeys.add(key);
    },
    addItem(item: Item) {
      const key = itemNameKey(item.name);
      if (key && !itemsByKey.has(key)) itemsByKey.set(key, item);
    },
  };
}

function isPreparedItemContext(
  ctx: ItemCandidateContext | PreparedItemContext,
): ctx is PreparedItemContext {
  return 'itemsByKey' in ctx && 'entityKeys' in ctx;
}

export type ItemValidation =
  | {
      accept: true;
      name: string;
      type: string;
      nameKey: string;
      existingItem?: Item;
    }
  | { accept: false; reason: string };

/**
 * 物品候选校验（纯函数）。
 * 用法：accept=false 直接丢弃；accept=true 且 existingItem 存在时只补类型，不新建。
 */
export function validateItemCandidate(
  candidate: ItemCandidate,
  ctx: ItemCandidateContext | PreparedItemContext = {},
): ItemValidation {
  // 名称只归一化一次，后续过滤/类型/去重全部复用
  const name = normalizeItemName(candidate.name);
  const nonItem = checkNonItem(name, toHalfWidth(name).toLowerCase());
  if (nonItem.nonItem) {
    return { accept: false, reason: nonItem.reason ?? '非物品' };
  }

  const key = itemNameKey(name);
  if (!key) return { accept: false, reason: '空名称' };

  // 原始上下文按需转成索引；已预建的索引直接复用
  const prepared = isPreparedItemContext(ctx) ? ctx : prepareItemContext(ctx);

  // 与角色/地点同名：不是物品
  if (prepared.entityKeys.has(key)) {
    return { accept: false, reason: '与角色/地点同名' };
  }

  // 原文接地：名称必须出现在 context 或本章正文中
  const compactName = compactText(name);
  const grounded =
    (candidate.context ? compactText(candidate.context).includes(compactName) : false) ||
    (prepared.chapterCompact ? prepared.chapterCompact.includes(compactName) : false);
  if ((candidate.context || prepared.hasChapterContent) && !grounded) {
    return { accept: false, reason: '原文中找不到名称' };
  }

  const existingItem = prepared.itemsByKey.get(key);
  return {
    accept: true,
    name,
    type: resolveItemTypeFromNormalized(name, candidate.itemType),
    nameKey: key,
    ...(existingItem ? { existingItem } : {}),
  };
}
