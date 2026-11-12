// ============================================================
// 地点识别后处理算法
//
// AI 的 location 实体行不可直接信任：实测会把
//   · 人物/群体（众人、守卫、黑衣人）、物品名、组织/团体（公司、帮会）当成地点
//   · 「远处」「身后」「楼下」「门口」这类相对方位短语当成地点
//   · 「清晨」「黄昏」「雨夜」这类时间/天气词当成地点
//   · 「会议」「婚礼」「战争」这类事件/活动当成地点
//   · 「那个山洞」「他们的营地」这类指代短语当成地点
//   · 「一座城」「两条街」这类数量短语当成地点
//   · 原文里根本没出现过的「脑补地名」
//   · 「旧货市场」/「城南旧货市场」这类同地异名重复建点
//
// 这里做一层确定性校验（零模型调用），与 itemRecognition 同构：
//   ① 名称归一化（列表序号、成对引号/括号、动作/介词前缀、关系方位后缀、空白）
//   ② 非地点过滤（人物/时间/方位/事件/组织/抽象/感知/指代/描述性/数量短语）
//   ③ 与角色/物品同名过滤
//   ④ 原文接地校验（名称必须出现在 context 或本章正文）
//   ⑤ 已有地点按归一化键去重 + 方位前缀变体合并
//
// 2026-11 优化：
//   · 归一化 / 接地键只计算一次（原来每个候选要重复归一化 3~4 次）
//   · 方位/新旧前缀键预计算（findExistingLocation 不再每个候选重新归一化 20+ 次）
//   · 指代规则不再「以这/那/此开头就拒绝」—— 那曲、那拉提草原等真实地名不再误杀
//   · 新增描述性短语（…的…）与数量短语（一座城 / 两条街）过滤
//   · 人物 / 时间 / 事件 / 组织 / 感知词表按实测误识别扩充
//   · 第二轮：新增器物（青锋剑 / 龙纹玉佩）、功法招式（青云剑法）、
//     能量属性（灵力 / 灵气 / 内力）后缀过滤 —— 物品名在没有同库物品可撞名时
//     也能被拦住；同时给归一化/比较键加了 2000 条上限的缓存
//
// 设计取舍：
//   · 只做「高置信度排除」。「公园」「车站」这类泛指地点保留 —— 它们在故事里
//     就是可指认的场所，交给 grounding（原文真的写了）兜底。
//   · 变体合并只认「方位/新旧前缀」（城南旧货市场 → 旧货市场），不认后缀
//     （旧货市场东门是另一个地图点），避免把子地点并掉。
// ============================================================

import type { Location } from '@novel/shared';

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
      const symmetric = left === right;
      if (s.length > (symmetric ? 2 : 1) && s.startsWith(left) && s.endsWith(right)) {
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

/**
 * 动作/介词前缀：「前往城隍庙」「在废弃工厂」。
 * 单字前缀要求剩余至少 2 个字，避免把「于都」「向阳路」这类真实地名截断。
 */
const MOTION_PREFIX =
  /^(?:位于|来到|走进|走入|进入|回到|返回|前往|赶往|抵达|到达|离开|通往|通向|靠近|路过|经过|站在|坐在|停在|在|于)(?=.{2,}$)/;

/**
 * 关系方位后缀：「城隍庙附近」「废舍门口」「城隍庙东侧」不是独立地点，归到主地点。
 * 2026-11 扩充了 东/西/南/北 + 边/侧/面，以及 左右 / 怀里 / 手中 等身体方位。
 * 注意不剥「东门 / 后院」这类子地点后缀 —— 它们是可以单独建点的地图位置。
 */
const RELATIONAL_SUFFIX =
  /(?:的)?(?:附近|周围|周边|一带|旁边|边上|左边|右边|左侧|右侧|东边|西边|南边|北边|东侧|西侧|南侧|北侧|东面|西面|南面|北面|前方|后方|内侧|外侧|上方|下方|左右|身边|身旁|身侧|身后|身前|面前|眼前|脚下|头顶|怀里|怀中|手中|手上|肩上|背上|耳边|脚边|门口|门前|窗外|门外|屋里|屋内|院里|院内|上空|里面|外面|深处|之上|之下|之中|以内|以外)$/;

/** 首尾残留标点（中间的点号/连字符保留，兼容「圣·玛丽医院」「A-12 区」） */
const EDGE_PUNCT = /^[，,、；;：:。.!！?？\s·・—–\-#*]+|[，,、；;：:。.!！?？\s·・—–\-#*]+$/g;

/** 内部：纯归一化计算（无缓存） */
function computeNormalizedLocationName(raw: string): string {
  let name = String(raw ?? '').replace(/[​-‍﻿]/g, '').trim();
  name = stripWrappingPairs(name);
  name = name.replace(LIST_MARKER, '');
  name = stripWrappingPairs(name);
  name = name.replace(EDGE_PUNCT, '').trim();
  name = name.replace(MOTION_PREFIX, '');
  // 关系后缀剥完若只剩空/单字（「门口」「屋里」），保留原名 —— 让后续非地点
  // 过滤给出「相对方位」而不是误导性的「空名称」
  const withoutRelation = name.replace(RELATIONAL_SUFFIX, '');
  if (withoutRelation.trim().length >= 2) name = withoutRelation;
  name = stripWrappingPairs(name);
  name = name.replace(EDGE_PUNCT, '');
  return name.replace(/\s+/g, ' ').trim();
}

/** 内部：已归一化名称 → 紧凑比较键（不再重复归一化） */
function locationKeyFromNormalized(normalized: string): string {
  return toHalfWidth(normalized)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 归一化 / 比较键缓存。
 *
 * 长篇里同一批地名会被反复处理：每章重建索引要对全部已有地点归一化一次，
 * 每个候选又要归一化一次。10 万字、300 个地点、30 章扫描就是上万次重复计算。
 * 缓存后这些调用只做一次 Map 查表（纯函数，输入相同必得相同结果）。
 * 上限 2000 条，超出整体清空，内存有界。
 */
const NAME_CACHE_MAX = 2000;
const nameCache = new Map<string, { name: string; key: string }>();

function analyzeLocationName(raw: string): { name: string; key: string } {
  const input = String(raw ?? '');
  const hit = nameCache.get(input);
  if (hit) return hit;
  const name = computeNormalizedLocationName(input);
  const analysis = { name, key: locationKeyFromNormalized(name) };
  if (nameCache.size >= NAME_CACHE_MAX) nameCache.clear();
  nameCache.set(input, analysis);
  return analysis;
}

/** 名称归一化：去序号/包裹符号/动作前缀/关系后缀/首尾标点，压空白 */
export function normalizeLocationName(raw: string): string {
  return analyzeLocationName(raw).name;
}

/** 仅供比较的紧凑键：去空白/标点/引号、全角转半角、转小写 */
export function locationNameKey(raw: string): string {
  return analyzeLocationName(raw).key;
}

/** 接地比较用文本：半角化、去空白、去引号/括号/间隔号 */
function compactText(s: string): string {
  return toHalfWidth(s)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[「」『』“”‘’"'《》〈〉【】[\]（）()·・]/g, '');
}

const CN_NUM = '0-9一二三四五六七八九十百千万亿两零〇';

/** 纯数字（含「三」「五百」「12.5%」） */
const PURE_NUMBER = new RegExp(`^[${CN_NUM}]+(?:\\.[0-9]+)?%?$`);

/** 人物/群体：不是地点 */
const PERSON_WORDS = new Set([
  '众人', '人群', '路人', '行人', '士兵', '守卫', '卫兵', '仆人', '掌柜', '老板',
  '医生', '护士', '警察', '学生', '老师', '孩子', '老人', '女人', '男人', '少年',
  '少女', '青年', '敌人', '对手', '同伴', '家人', '亲人', '朋友', '客人', '顾客',
  '村民', '居民', '市民', '人们', '大家', '自己', '对方', '他们', '她们', '我们',
  '你们', '他', '她', '它', '你', '我', '老者', '老妇', '妇人', '男子', '女子',
  '孩童', '小孩', '弟子', '长老', '掌门', '宗主', '族长', '修士', '武者', '法师',
  '道士', '和尚', '尼姑', '商贩', '摊贩', '小贩', '伙计', '小二', '船夫', '车夫',
  '信使', '使者', '刺客', '杀手', '强盗', '土匪', '乞丐', '流民', '难民', '将领',
  '军官', '侍卫', '随从', '护卫', '门卫', '哨兵', '黑衣人', '白衣人', '灰衣人',
  '蒙面人', '黑袍人', '壮汉', '大汉', '侍女', '丫鬟', '仆役', '勇士', '骑士',
  '大夫', '夫人', '丈夫', '妻子', '汉子',
]);

/** 多字人物后缀：「黑衣守卫」「巡逻士兵」「老妇人」 */
const PERSON_SUFFIX_MULTI =
  /(?:众人|人群|路人|行人|士兵|守卫|卫兵|仆人|掌柜|老板|医生|护士|警察|学生|老师|孩子|老人|女人|男人|少年|少女|青年|敌人|对手|同伴|家人|亲人|朋友|客人|顾客|村民|居民|市民|人们|大家|自己|对方|老者|老妇|妇人|男子|女子|孩童|小孩|弟子|长老|掌门|宗主|族长|修士|武者|法师|道士|和尚|尼姑|商贩|摊贩|小贩|伙计|小二|船夫|车夫|信使|使者|刺客|杀手|强盗|土匪|乞丐|流民|难民|将领|军官|侍卫|随从|护卫|门卫|哨兵|侍女|丫鬟|仆役)$/;

/** 单字人物后缀：「守夜人」「巡逻兵」「老妇人」；只对 3 字以上生效，保护「武汉」 */
const PERSON_SUFFIX_SINGLE = /(?:人|者|员|兵|士|夫|妇|翁|汉|婆|匠)$/;

/** 时间/天气：不是地点 */
const TIME_WORDS = new Set([
  '清晨', '黎明', '拂晓', '早晨', '上午', '中午', '正午', '下午', '傍晚', '黄昏',
  '夜晚', '夜里', '深夜', '半夜', '午夜', '凌晨', '白天', '黑夜', '天亮', '天黑',
  '春天', '夏天', '秋天', '冬天', '春季', '夏季', '秋季', '冬季', '季节',
  '当年', '那年', '这年', '今年', '去年', '明年', '过去', '未来', '现在', '此刻',
  '如今', '当时', '瞬间', '片刻', '不久', '从前', '后来', '雨夜', '雪夜', '风夜',
  '半晌', '良久', '许久', '须臾', '霎时', '刹那', '一瞬', '一会儿', '一时', '多时',
  '入夜', '破晓', '日出', '日落', '子时', '丑时', '寅时', '卯时', '辰时', '巳时',
  '午时', '未时', '申时', '酉时', '戌时', '亥时', '三更', '五更', '初更',
  '前半夜', '后半夜',
]);

/** 时间短语后缀：「三日后」「第二天」「多年以后」 */
const TIME_PATTERN =
  /(?:年前|年后|月前|月后|日前|日后|天前|天后|次日|翌日|第二天|第三天|数日后|多年后|这一刻|那一刻|[0-9一二三四五六七八九十百]+点(?:半|整)?|[0-9一二三四五六七八九十]+(?:更|时辰))$/;

/** 时间后缀：「庆功宴第二天」「清晨」 */
const TIME_SUFFIX =
  /(?:清晨|黎明|拂晓|早晨|上午|中午|正午|下午|傍晚|黄昏|夜晚|夜里|深夜|半夜|午夜|凌晨|白天|黑夜|天亮|天黑|春天|夏天|秋天|冬天|春季|夏季|秋季|冬季|雨夜|雪夜|风夜|半晌|良久|许久|须臾|霎时|刹那|一瞬|一会儿|入夜|破晓|日出|日落|子时|丑时|寅时|卯时|辰时|巳时|午时|未时|申时|酉时|戌时|亥时|三更|五更|初更|前半夜|后半夜)$/;

/** 相对方位/泛指点位：不是独立地点 */
const RELATIVE_WORDS = new Set([
  '这里', '那里', '此处', '该处', '某处', '别处', '何处', '哪里', '哪儿',
  '原地', '身边', '身旁', '身侧', '身后', '身前', '面前', '眼前', '脚下', '头顶',
  '空中', '半空', '天空', '地下', '地面', '水面', '水中', '水里', '窗外',
  '门外', '屋里', '屋内', '院里', '院内', '楼下', '楼上', '街上', '路上',
  '途中', '半路', '四周', '周围', '附近', '远处', '近处', '远方', '对面',
  '背后', '旁边', '边上', '深处', '尽头', '边缘', '角落', '中央', '中心',
  '中间', '内部', '外部', '门口', '门前', '城里', '城外', '山上', '山下',
  '河边', '湖边', '海边', '桥头', '桥下', '林间', '田间', '室内', '室外',
  '东边', '西边', '南边', '北边', '东侧', '西侧', '南侧', '北侧', '东面',
  '西面', '南面', '北面', '左边', '右边', '左侧', '右侧', '前方', '后方',
  '内侧', '外侧', '上方', '下方', '底下', '顶上', '怀里', '怀中', '手中',
  '手上', '肩头', '肩上', '背上', '耳边', '脚边', '全城', '满城',
]);

/** 相对方位后缀：「他身后」「大楼附近」「城隍庙东侧」；不误伤「交易中心」这类专名 */
const RELATIVE_SUFFIX =
  /(?:这里|那里|此处|该处|某处|别处|何处|哪里|原地|身边|身旁|身侧|身后|身前|面前|眼前|脚下|头顶|空中|半空|天空|地下|地面|水面|水中|水里|窗外|门外|屋里|屋内|院里|院内|楼下|楼上|街上|路上|途中|半路|四周|周围|附近|远处|近处|远方|对面|背后|旁边|边上|深处|尽头|边缘|角落|东边|西边|南边|北边|东侧|西侧|南侧|北侧|东面|西面|南面|北面|左边|右边|左侧|右侧|前方|后方|内侧|外侧|上方|下方|左右|怀里|怀中|手中|手上|肩头|肩上|背上|耳边|脚边)$/;

/** 事件/活动：不是地点 */
const EVENT_WORDS = new Set([
  '会议', '宴会', '婚礼', '葬礼', '仪式', '战斗', '战争', '战役', '冲突',
  '谈判', '交易', '拍卖会', '聚会', '酒会', '舞会', '庆典', '祭祀', '审判',
  '调查', '约会', '比赛', '考试', '任务', '事件', '事故', '案件', '危机',
  '阴谋', '计划', '真相', '秘密', '回忆', '记忆', '梦境', '幻觉', '死亡',
  '重生', '穿越', '觉醒', '突破', '晋级', '升级', '顿悟', '大战', '决战',
  '决斗', '厮杀', '追杀', '逃亡', '袭击', '伏击', '突袭', '爆炸', '火灾',
  '地震', '洪水', '瘟疫', '风暴', '暴乱', '叛乱', '起义', '革命', '法事',
  '丧礼', '喜宴', '寿宴', '婚宴', '晚宴', '早朝', '朝会', '集会', '游行',
  '罢工', '处决', '行刑', '祭典',
]);

/** 事件后缀：「庆功宴会」「农民起义」 */
const EVENT_PATTERN =
  /(?:会议|宴会|婚礼|葬礼|仪式|战斗|战争|战役|冲突|谈判|拍卖会|聚会|酒会|舞会|庆典|祭祀|审判|约会|比赛|考试|任务|事件|事故|案件|危机|阴谋|计划|真相|秘密|回忆|记忆|梦境|幻觉|大战|决战|决斗|厮杀|追杀|逃亡|袭击|伏击|突袭|爆炸|火灾|地震|洪水|瘟疫|风暴|暴乱|叛乱|起义|革命|法事|丧礼|喜宴|寿宴|婚宴|晚宴|早朝|朝会|集会|游行|罢工|处决|行刑|祭典)$/;

/** 组织/团体：不是地点（「拍卖行」「报社」这类实体建筑不在此列） */
const ORG_PATTERN =
  /(?:公司|集团|协会|委员会|联盟|政府|军队|部队|帮派|帮会|帮|派|教|社团|俱乐部|组织|小分队|团队|队伍|门派|宗门|家族|世家|商会|公会|教会|军团|兵团|联军|大军|舰队|战队|董事会|议会|国会|内阁|朝廷)$/;

/** 抽象概念：不是地点 */
const ABSTRACT_WORDS = new Set([
  '世界', '人间', '世间', '天地', '空间', '虚空', '境界', '领域', '位面',
  '宇宙', '命运', '时间', '生命', '灵魂', '意识', '精神', '内心', '心中',
  '脑海', '心里', '黑暗', '光明', '寂静', '沉默', '气息', '气场',
  '轮回', '天道', '大道', '法则', '规则', '幻象', '幻影', '潜意识', '宿命',
  '气数', '命数', '天意', '因果', '彼岸', '极乐', '虚无', '混沌', '时空',
  '次元', '结界', '地点', '地方', '位置', '现场', '目的地', '所在地', '聚集地',
  '集合地', '藏身处', '落脚点', '根据地',
]);

/** 感知现象/天气：不是地点（「雨巷」「雪原」有具体后缀，不受影响） */
const SENSORY_PATTERN =
  /(?:声|音|气味|味道|气息|杀气|杀意|寒意|暖意|光|光晕|光芒|火光|灯光|烛光|星光|月光|阳光|影子|阴影|风|雨|雪|雾|霾|烟|烟雾|血腥味|香气|闪电|雷电|雷声|惊雷|闷雷|电流|电弧|朝露|寒露|露水|晚霞|朝霞|彩霞|霞光|彩虹)$/;

/**
 * 器物/物件后缀：AI 把物品名再标一次 location 时的兜底。
 * 只在物品尚未入库（没有撞名可拦）时才会走到这里，
 * 所以刻意排除了与建筑重合的「塔 / 楼 / 桥 / 庙 / 门 / 炉 / 钟」等字。
 */
const OBJECT_SUFFIX =
  /(?:剑|刀|枪|弓|弩|箭|戟|鞭|棍|锤|斧|钺|钩|叉|锏|棒|匕首|长矛|暗器|飞刀|手雷|炸弹|甲|盔|盾|袍|衫|裙|冠|靴|鞋|袜|披风|斗篷|手镯|项链|玉佩|戒指|扳指|面具|吊坠|香囊|荷包|玉镯|丹药|丹|丸|散|膏|药水|药剂|解药|毒药|灵药|草药|秘籍|卷轴|玉简|竹简|秘典|书册|典籍|古籍|藏宝图|通缉令|令牌|信物|虎符|印章|玉玺|腰牌|徽章|宝石|晶石|灵石|灵晶|夜明珠|金条|钥匙|铜镜|古镜|罗盘|机甲|轮椅|无人机|剑鞘|丹炉|阵盘|符箓|符纸|电池|芯片|无线电|终端|手电|火把|火折子|扳手|算盘|骰子)$/;

/** 功法/招式/法术后缀：本身不是地点 */
const TECHNIQUE_SUFFIX =
  /(?:心法|身法|步法|剑法|刀法|拳法|掌法|腿法|枪法|棍法|功法|法术|秘术|咒术|符术|神通|剑招|刀招|招式|阵法|秘技|武技|技能|法|术|诀|谱|招)$/;

/** 能量/属性/修为类后缀：「灵力」「灵气」「内力」「修为」不是地点 */
const ENERGY_SUFFIX =
  /(?:之力|灵气|真气|灵力|内力|法力|元力|斗气|血气|魔气|妖气|仙气|煞气|邪气|怨气|尸气|死气|神识|精神力|气运|机缘|悟性|根骨|灵根|修为|境界|气场|力量|生命值|法力值|战斗力|攻击力|防御力|力|气)$/;

/**
 * 指示/代词前缀：「那个山洞」「这座城」「他们的营地」「他家」。
 *
 * 2026-11 修正：不再「只要以 这/那/此… 开头就拒绝」——
 * 那曲、那拉提草原、那霸这类真实地名会被误杀。现在只拒绝三种确定形态：
 *   ① 指示词 + 量词          那个山洞 / 这座城 / 那棵树
 *   ② 指示词 + 地点类名词    此山 / 那城 / 那些山
 *   ③ 人称代词 + 的/们/家     他们的营地 / 我家
 */
const DEMONSTRATIVE_PREFIX = new RegExp(
  '^(?:' +
    '(?:这些|那些|这|那|此|该|某)' +
      '(?:个|座|条|片|处|块|栋|幢|家|所|户|位|层|排|列|间|棵|株|朵|只|匹|头|艘|辆|架|台|部|本|张|支|根|把|面|扇|堵|道|口|眼|汪|缕|阵|场)' +
    '|(?:这些|那些|这|那|此|该|某)' +
      '(?:山|城|村|镇|店|铺|屋|房|楼|院|园|庙|寺|观|殿|阁|塔|桥|河|湖|海|江|林|谷|洞|岛|州|县|市|区|街|路|巷)' +
    '|(?:他们|她们|我们|你们|他|她|它|你|我)(?:的|们|家)' +
  ')',
);

/**
 * 数量短语的「地点类名词」尾巴。
 * 只在「数量词 + 量词 + 泛指地点名词」完整成立时才判为数量短语，
 * 避免误伤 三家店 / 四块玉 / 两家子 / 五棵松 这类真实地名。
 */
const GENERIC_PLACE_NOUN =
  '(?:大道|大街|小巷|村子|镇子|院子|房子|屋子|铺子|人家|街口|路口|山口|洞口|村口|山脚|河边|湖边|海边|城|街|路|村|镇|楼|房|屋|店|院|园|山|河|湖|海|江|林|岛|桥|港|口|区|市|县|州)';

/** 数量短语：「一座城」「两条街」「三个村子」——不是专名 */
const QUANTITY_PREFIX = new RegExp(
  `^(?:第)?[${CN_NUM}几数]+(?:座|条|片|处|块|栋|幢|所|个|户|位|层|排|列|队|群|批|伙)${GENERIC_PLACE_NOUN}$`,
);

/** 整体/满称前缀：「整座城」「整个村子」 */
const WHOLE_PREFIX = new RegExp(
  `^(?:整|满|全)(?:个|座|条|片|处|块|栋|幢|所)${GENERIC_PLACE_NOUN}$`,
);

export type NonPlaceCheck = { nonPlace: boolean; reason?: string };

function checkNonPlace(name: string, lower: string): NonPlaceCheck {
  if (!name) return { nonPlace: true, reason: '空名称' };
  if (name.length < 2) return { nonPlace: true, reason: '名称过短' };
  if (name.length > 20) return { nonPlace: true, reason: '名称过长' };

  // 句子片段：AI 偶尔把整句原文当名字
  if (/[。！？；，、,.!?;:\n\r\t]/.test(name)) {
    return { nonPlace: true, reason: '句子片段' };
  }

  if (PURE_NUMBER.test(lower)) return { nonPlace: true, reason: '纯数字' };

  // 人物/群体：精确命中，或命中多字人物后缀（「黑衣守卫」），
  // 或 3 字以上命中单字人物后缀（「守夜人」；两字地名「武汉」不受影响）
  if (
    PERSON_WORDS.has(name) ||
    PERSON_WORDS.has(lower) ||
    PERSON_SUFFIX_MULTI.test(name) ||
    (name.length >= 3 && PERSON_SUFFIX_SINGLE.test(name))
  ) {
    return { nonPlace: true, reason: '人物/群体' };
  }

  if (TIME_WORDS.has(name) || TIME_PATTERN.test(name) || TIME_SUFFIX.test(name)) {
    return { nonPlace: true, reason: '时间/天气' };
  }

  if (RELATIVE_WORDS.has(name) || RELATIVE_SUFFIX.test(name)) {
    return { nonPlace: true, reason: '相对方位' };
  }

  if (EVENT_WORDS.has(name) || EVENT_PATTERN.test(name)) {
    return { nonPlace: true, reason: '事件/活动' };
  }

  if (ORG_PATTERN.test(name)) return { nonPlace: true, reason: '组织/团体' };

  if (ABSTRACT_WORDS.has(name)) return { nonPlace: true, reason: '抽象概念' };

  if (SENSORY_PATTERN.test(name)) return { nonPlace: true, reason: '感知现象' };

  // 器物 / 功法 / 能量属性：AI 常把物品名、武学名再标一次 location
  if (OBJECT_SUFFIX.test(name)) return { nonPlace: true, reason: '物品/器物' };
  if (TECHNIQUE_SUFFIX.test(name)) return { nonPlace: true, reason: '功法招式' };
  if (ENERGY_SUFFIX.test(name)) return { nonPlace: true, reason: '抽象概念' };

  // 指代短语（「那个山洞」「他们的营地」）——真实地名「那曲」不再误杀
  if (DEMONSTRATIVE_PREFIX.test(name)) {
    return { nonPlace: true, reason: '指代短语' };
  }

  // 数量短语（「一座城」「两条街」「一群守卫」）
  if (QUANTITY_PREFIX.test(name) || WHOLE_PREFIX.test(name)) {
    return { nonPlace: true, reason: '数量短语' };
  }

  // 描述性短语（「沈家的院子」「城隍庙的后院」）——「的」在首位时保护音译地名
  if (name.length >= 4 && name.indexOf('的') > 0) {
    return { nonPlace: true, reason: '描述性短语' };
  }

  return { nonPlace: false };
}

/**
 * 判断是否明显不是地点名。
 * 返回 nonPlace=true 时 reason 用于诊断日志。
 */
export function isLikelyNonPlaceName(raw: string): NonPlaceCheck {
  const name = normalizeLocationName(raw);
  return checkNonPlace(name, toHalfWidth(name).toLowerCase());
}

/** 方位/新旧前缀：用于合并「旧货市场」与「城南旧货市场」这类同地异名 */
const LOCALITY_PREFIXES = [
  '城东', '城西', '城南', '城北', '东城', '西城', '南城', '北城',
  '东', '西', '南', '北', '老', '新', '旧', '大', '小', '前', '后', '上', '下', '内', '外',
];

/**
 * 预计算的归一化前缀键。
 * 原来每个候选都要在循环里调用 20+ 次 locationNameKey(prefix)，
 * 每章几十个候选就是上千次重复归一化；现在只在模块加载时算一次。
 */
const LOCALITY_PREFIX_KEYS: ReadonlyArray<string> = Array.from(
  new Set(LOCALITY_PREFIXES.map((prefix) => locationNameKey(prefix)).filter(Boolean)),
);

/**
 * 按归一化键查已有地点；查不到时再尝试「方位/新旧前缀 + 短名」变体。
 * 只认前缀（城南旧货市场 → 旧货市场），不认后缀（旧货市场东门是子地点，保留）。
 */
export function findExistingLocation(
  nameKey: string,
  locationsByKey: Map<string, Location>,
): Location | undefined {
  const exact = locationsByKey.get(nameKey);
  if (exact) return exact;

  for (const prefixKey of LOCALITY_PREFIX_KEYS) {
    if (nameKey === prefixKey) continue;
    // 长名 → 短名：多出来的前缀最多 2 字，且短名至少 3 字，避免「东街」并掉「街」
    if (nameKey.startsWith(prefixKey) && nameKey.length - prefixKey.length >= 3) {
      const candidate = locationsByKey.get(nameKey.slice(prefixKey.length));
      if (candidate) return candidate;
    }
    // 短名 → 长名（已有的是带前缀的长名）
    if (nameKey.length >= 3) {
      const candidate = locationsByKey.get(prefixKey + nameKey);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

export interface LocationCandidate {
  name?: string;
  description?: string;
  context?: string;
}

export interface LocationCandidateContext {
  /** 当前章节纯文本，用于「名称必须真实出现」的接地校验 */
  chapterContent?: string;
  existingLocations?: Location[];
  existingCharacters?: Array<{ name: string }>;
  existingItems?: Array<{ name: string }>;
}

/**
 * 预建索引：一章扫描开始时 build 一次，
 * 之后每个候选只做 O(1) 查表，不再重新 filter/normalize 整库。
 * 同一次扫描中新落库的地点/角色/物品用 addLocation / addEntityName 增量更新。
 */
export interface PreparedLocationContext {
  /** 已压缩的本章正文；undefined 表示不需要接地校验 */
  chapterCompact?: string;
  /** 原文是否真的提供了章节正文（空白字符串不算） */
  hasChapterContent: boolean;
  /** 角色/物品归一化键（同名地点一律拒绝） */
  entityKeys: Set<string>;
  /** 已有地点：归一化键 → Location（同名取第一个，与旧 find 语义一致） */
  locationsByKey: Map<string, Location>;
  addEntityName(name: string): void;
  addLocation(location: Location): void;
}

export function prepareLocationContext(
  ctx: LocationCandidateContext = {},
): PreparedLocationContext {
  const entityKeys = new Set<string>();
  for (const entity of [...(ctx.existingCharacters ?? []), ...(ctx.existingItems ?? [])]) {
    const key = locationNameKey(entity.name);
    if (key) entityKeys.add(key);
  }

  const locationsByKey = new Map<string, Location>();
  for (const location of ctx.existingLocations ?? []) {
    const key = locationNameKey(location.name);
    if (key && !locationsByKey.has(key)) locationsByKey.set(key, location);
  }

  const chapterContent = typeof ctx.chapterContent === 'string' && ctx.chapterContent.trim()
    ? ctx.chapterContent
    : undefined;

  return {
    chapterCompact: chapterContent ? compactText(chapterContent) : undefined,
    hasChapterContent: Boolean(chapterContent),
    entityKeys,
    locationsByKey,
    addEntityName(name: string) {
      const key = locationNameKey(name);
      if (key) entityKeys.add(key);
    },
    addLocation(location: Location) {
      const key = locationNameKey(location.name);
      // 覆盖旧值：link 补完章节后，同章重复候选应立刻命中最新章节
      if (key) locationsByKey.set(key, location);
    },
  };
}

function isPreparedLocationContext(
  ctx: LocationCandidateContext | PreparedLocationContext,
): ctx is PreparedLocationContext {
  return 'locationsByKey' in ctx && 'entityKeys' in ctx;
}

/** 地点描述：优先用 AI 的简短描述，缺失时才退回原文证据片段（截断，避免整段入库） */
export function locationDescription(candidate: LocationCandidate): string {
  const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
  const source = description || (typeof candidate.context === 'string' ? candidate.context.trim() : '');
  return source.length > 160 ? `${source.slice(0, 159)}…` : source;
}

export type LocationValidation =
  | {
      accept: true;
      name: string;
      nameKey: string;
      description: string;
      existingLocation?: Location;
    }
  | { accept: false; reason: string };

/**
 * 地点候选校验（纯函数）。
 * accept=false 直接丢弃；accept=true 且 existingLocation 存在时只补章节/描述，不新建。
 */
export function validateLocationCandidate(
  candidate: LocationCandidate,
  ctx: LocationCandidateContext | PreparedLocationContext = {},
): LocationValidation {
  // 名称只归一化一次，后续过滤/接地键/去重全部复用
  const name = normalizeLocationName(candidate.name ?? '');
  const lower = toHalfWidth(name).toLowerCase();
  const nonPlace = checkNonPlace(name, lower);
  if (nonPlace.nonPlace) {
    return { accept: false, reason: nonPlace.reason ?? '非地点' };
  }

  const key = locationKeyFromNormalized(name);
  if (!key) return { accept: false, reason: '空名称' };

  const prepared = isPreparedLocationContext(ctx) ? ctx : prepareLocationContext(ctx);

  // 与角色/物品同名：不是地点（AI 常把人物名、物品名再标一次 location）
  if (prepared.entityKeys.has(key)) {
    return { accept: false, reason: '与角色/物品同名' };
  }

  // 原文接地：名称必须出现在 context 或本章正文中
  const compactName = compactText(name);
  const inContext = candidate.context
    ? compactText(candidate.context).includes(compactName)
    : false;
  const inChapter = prepared.chapterCompact && compactName.length <= prepared.chapterCompact.length
    ? prepared.chapterCompact.includes(compactName)
    : false;
  if ((candidate.context || prepared.hasChapterContent) && !inContext && !inChapter) {
    return { accept: false, reason: '原文中找不到名称' };
  }

  const existingLocation = findExistingLocation(key, prepared.locationsByKey);
  return {
    accept: true,
    name,
    nameKey: key,
    description: locationDescription(candidate),
    ...(existingLocation ? { existingLocation } : {}),
  };
}

export type LocationApply =
  | { kind: 'reject'; reason: string }
  | { kind: 'create'; name: string; nameKey: string; description: string }
  | {
      kind: 'link';
      location: Location;
      chapters: number[];
      /** 仅当已有地点描述为空、本次候选有描述时给出 */
      description?: string;
      /** 章节/描述是否有实际变化；false 时调用方不必写库 */
      changed: boolean;
    };

/**
 * 校验 + 落库决策（纯函数）：所有识别入口共用，避免各自实现一套去重规则。
 * 调用方只需按 kind 处理 create / link，reject 记录日志即可。
 */
export function applyLocationCandidate(
  candidate: LocationCandidate,
  chapterOrder: number,
  ctx: LocationCandidateContext | PreparedLocationContext = {},
): LocationApply {
  const validation = validateLocationCandidate(candidate, ctx);
  if (!validation.accept) {
    return { kind: 'reject', reason: validation.reason };
  }

  const existing = validation.existingLocation;
  if (!existing) {
    return {
      kind: 'create',
      name: validation.name,
      nameKey: validation.nameKey,
      description: validation.description,
    };
  }

  const hasDescription = typeof existing.description === 'string' && existing.description.trim().length > 0;
  const description = !hasDescription && validation.description ? validation.description : undefined;

  const chapters = [...(existing.chapters ?? [])];
  const hasChapter = chapters.includes(chapterOrder);
  if (!hasChapter) {
    chapters.push(chapterOrder);
    chapters.sort((a, b) => a - b);
  }

  return {
    kind: 'link',
    location: existing,
    chapters,
    ...(description !== undefined ? { description } : {}),
    changed: !hasChapter || description !== undefined,
  };
}
