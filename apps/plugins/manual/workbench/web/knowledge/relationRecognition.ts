// ============================================================
// 关系识别后处理算法（角色 ↔ 角色 / 物品 ↔ 物品 / 地点 ↔ 地点·角色）
//
// 背景：关系此前只有两个来源，且都不够用 ——
//   · 角色关系 = 「同一时间线事件里出现过就两两连『关联』」：一出群戏就被连成
//     完全图，一条真关系（师徒/父子/仇人）都读不出来；
//   · 地点关系 = 「角色与地点在同一章出现过就连『位于』」：同章出现在十个地点的
//     角色会被连出十条边，地图越写越糊。
// 现在改为由扫描模型显式输出关系断言（subject/object/type/证据），本模块做
// 一层确定性校验与落库决策（零模型调用）：
//   ① 类型归一（中文关系词 / 自由描述 → 标准关系码）
//   ② 主体/客体解析（按名称 + 别名解析成实体 id，解析不到一律丢弃）
//   ③ 原文接地（证据片段必须真的出自本章；给了证据却对不上 = 编造）
//   ④ 自指、方向、双向补齐（mutual 两侧都写，单侧删除后图上不残留半边）
//   ⑤ 去重（与已有关系逐条比对，重复只更新章节，不重复堆边）
//
// 设计取舍：宁可少一条关系，也不把关系挂到错误的人身上。解析不到主体/客体的
// 断言直接丢弃 —— 图上画不出、库里存不进，留着只会污染数据。
// ============================================================

import type { CharacterRelation, ItemRelation, LocationRelation, ItemRelationType } from '@novel/shared';

// ------------------------------------------------------------------
// 关系类型词表
// ------------------------------------------------------------------

/**
 * 对称关系：双方地位/情感对等，图上不画箭头，写入两侧都是 mutual。
 * mentor（师徒）与 subordinate（上下级）天然有方向，其余都按对称处理。
 */
const SYMMETRIC_CHARACTER_RELATIONS = new Set<CharacterRelationCode>([
  'friend', 'enemy', 'lover', 'family', 'ally', 'rival', 'mutual',
]);

/** 角色关系标准码（与 RelationGraph 的配色/标签表一致，另加 subordinate/other/同场） */
export type CharacterRelationCode =
  | 'friend'
  | 'enemy'
  | 'lover'
  | 'family'
  | 'ally'
  | 'rival'
  | 'mentor'
  | 'subordinate'
  | 'mutual'
  | 'other';

/** 地点关系标准码：subject 位于 / 邻近 / 通往 / 关联 object */
export type LocationRelationCode = 'located_in' | 'nearby' | 'routes_to' | 'related_to';

/**
 * 中文关系词 → 标准码。
 * 键按「长词优先」命中，避免「师父」被「父」抢先、「仇敌」被「敌」抢先。
 */
const CHARACTER_TYPE_ALIASES: Record<string, CharacterRelationCode> = {
  // 师徒
  师徒: 'mentor', 师父: 'mentor', 师傅: 'mentor', 师尊: 'mentor', 恩师: 'mentor',
  老师: 'mentor', 授业: 'mentor', 弟子: 'mentor', 徒弟: 'mentor', 学生: 'mentor',
  门徒: 'mentor', 传承: 'mentor',
  // 家人
  家人: 'family', 亲人: 'family', 亲属: 'family', 父子: 'family', 父女: 'family',
  母子: 'family', 母女: 'family', 兄弟: 'family', 姐妹: 'family', 兄妹: 'family',
  姐弟: 'family', 父子关系: 'family', 父亲: 'family', 母亲: 'family', 爸爸: 'family',
  妈妈: 'family', 儿子: 'family', 女儿: 'family', 哥哥: 'family', 姐姐: 'family',
  弟弟: 'family', 妹妹: 'family', 叔侄: 'family', 舅甥: 'family', 祖孙: 'family',
  家族: 'family', 血缘: 'family',
  // 恋人
  恋人: 'lover', 情侣: 'lover', 爱人: 'lover', 夫妻: 'lover', 夫妇: 'lover',
  道侣: 'lover', 未婚妻: 'lover', 未婚夫: 'lover', 心上人: 'lover', 恋人关系: 'lover',
  单恋: 'lover', 暗恋: 'lover', 青梅竹马: 'lover',
  // 敌人 / 对手
  敌人: 'enemy', 仇人: 'enemy', 仇敌: 'enemy', 死敌: 'enemy', 宿敌: 'enemy',
  死仇: 'enemy', 血仇: 'enemy', 杀父仇人: 'enemy', 敌对: 'enemy',
  对手: 'rival', 竞争: 'rival', 竞争者: 'rival', 宿命对手: 'rival', 情敌: 'rival',
  // 盟友 / 朋友
  盟友: 'ally', 同盟: 'ally', 同盟者: 'ally', 合作: 'ally', 合作伙伴: 'ally', 同伴: 'ally',
  朋友: 'friend', 好友: 'friend', 挚友: 'friend', 知己: 'friend', 故交: 'friend',
  同门: 'friend', 师兄: 'friend', 师姐: 'friend', 师弟: 'friend', 师妹: 'friend',
  伙伴: 'friend', 同伴关系: 'friend',
  // 上下级
  上下级: 'subordinate', 上下属: 'subordinate', 主仆: 'subordinate', 主从: 'subordinate',
  上司: 'subordinate', 属下: 'subordinate', 下属: 'subordinate', 领导: 'subordinate',
  雇佣: 'subordinate', 长官: 'subordinate',
  // 泛关联
  关联: 'mutual', 相识: 'mutual', 认识: 'mutual', 见过: 'mutual', 有关系: 'mutual',
  mutual: 'mutual',
};

/** 已有英文关系码直接透传 */
const CHARACTER_CODES = new Set<string>([
  'friend', 'enemy', 'lover', 'family', 'ally', 'rival', 'mentor',
  'subordinate', 'mutual', 'other',
]);

/** 物品关系中文词 → 标准码（词表对齐 @novel/shared 的 ItemRelationType） */
const ITEM_TYPE_ALIASES: Record<string, ItemRelationType> = {
  配对: 'paired_with', 一对: 'paired_with', 成对: 'paired_with', 配套: 'paired_with',
  剑鞘: 'paired_with', 原配: 'paired_with', 子母: 'paired_with', 对应: 'paired_with',
  包含: 'contains', 内含: 'contains', 装有: 'contains', 藏着: 'contains', 盛有: 'contains',
  容纳: 'contains', 宝箱: 'contains',
  属于: 'part_of', 部件: 'part_of', 组件: 'part_of', 零件: 'part_of', 组成: 'part_of',
  配件: 'part_of', 分体: 'part_of',
  对立: 'opposite_of', 相克: 'opposite_of', 克制: 'opposite_of', 正邪: 'opposite_of',
  宿敌: 'opposite_of', 相反: 'opposite_of', 克制关系: 'opposite_of',
  变形: 'transforms_into', 化身: 'transforms_into', 化形: 'transforms_into', 转变: 'transforms_into',
  进化: 'transforms_into', 觉醒形态: 'transforms_into',
  关联: 'related_to', 相关: 'related_to', 同源: 'related_to', 类似: 'related_to',
};

const ITEM_CODES = new Set<string>([
  'paired_with', 'contains', 'part_of', 'opposite_of', 'transforms_into', 'related_to',
]);

/** 地点关系中文词 → 标准码 */
const LOCATION_TYPE_ALIASES: Record<string, LocationRelationCode> = {
  位于: 'located_in', 在: 'located_in', 处于: 'located_in', 属于: 'located_in',
  境内: 'located_in', 坐落: 'located_in', 所在地: 'located_in', 出现: 'located_in',
  所在: 'located_in', 逗留: 'located_in',
  邻近: 'nearby', 相邻: 'nearby', 靠近: 'nearby', 附近: 'nearby', 挨着: 'nearby',
  毗邻: 'nearby', 接壤: 'nearby', 隔壁: 'nearby',
  通往: 'routes_to', 通向: 'routes_to', 连接: 'routes_to', 相连: 'routes_to',
  直达: 'routes_to', 延伸至: 'routes_to',
  关联: 'related_to', 相关: 'related_to',
};

const LOCATION_CODES = new Set<string>(['located_in', 'nearby', 'routes_to', 'related_to']);

/** 中文词表按长度倒序，保证「师徒」先于「师」、「仇敌」先于「敌」 */
function sortedEntries<T>(table: Record<string, T>): Array<[string, T]> {
  return Object.entries(table).sort((a, b) => b[0].length - a[0].length);
}

const CHARACTER_TYPE_ENTRIES = sortedEntries(CHARACTER_TYPE_ALIASES);
const ITEM_TYPE_ENTRIES = sortedEntries(ITEM_TYPE_ALIASES);
const LOCATION_TYPE_ENTRIES = sortedEntries(LOCATION_TYPE_ALIASES);

/** 全角转半角 + 去空白 + 小写，只用于类型词比较 */
function compactType(raw: string): string {
  return raw
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function matchAlias<T>(entries: Array<[string, T]>, key: string): T | undefined {
  for (const [word, value] of entries) {
    if (key.includes(word)) return value;
  }
  return undefined;
}

/** 角色关系类型归一：英文码透传，中文/自由描述按词表映射，未知回退 other */
export function normalizeCharacterRelationType(raw?: string): CharacterRelationCode {
  const key = compactType(String(raw ?? ''));
  if (!key) return 'other';
  if (CHARACTER_CODES.has(key)) return key as CharacterRelationCode;
  const aliased = matchAlias(CHARACTER_TYPE_ENTRIES, key);
  if (aliased) return aliased;
  // 自由描述兜底：包含「师」→师徒，包含「父/母/兄/弟/姐/妹」→家人
  if (key.includes('师')) return 'mentor';
  if (/[父母兄弟姐妹子女]/.test(key)) return 'family';
  if (/[敌仇]/.test(key)) return 'enemy';
  return 'other';
}

/** 物品关系类型归一 */
export function normalizeItemRelationType(raw?: string): ItemRelationType {
  const key = compactType(String(raw ?? ''));
  if (!key) return 'related_to';
  if (ITEM_CODES.has(key)) return key as ItemRelationType;
  return matchAlias(ITEM_TYPE_ENTRIES, key) ?? 'related_to';
}

/** 地点关系类型归一；角色作客体时只保留「位于」语义 */
export function normalizeLocationRelationType(
  raw?: string,
  targetKind: LocationRelation['targetKind'] = 'location',
): LocationRelationCode {
  if (targetKind === 'character') return 'located_in';
  const key = compactType(String(raw ?? ''));
  if (!key) return 'related_to';
  if (LOCATION_CODES.has(key)) return key as LocationRelationCode;
  return matchAlias(LOCATION_TYPE_ENTRIES, key) ?? 'related_to';
}

// ------------------------------------------------------------------
// 名称键与接地
// ------------------------------------------------------------------

function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

/** 仅供比较的紧凑键：全角转半角、去空白/标点/引号、小写 */
export function relationNameKey(raw: string): string {
  return toHalfWidth(String(raw ?? ''))
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 接地比较用文本：同 relationNameKey，但保留正文原长 */
function compactText(s: string): string {
  return toHalfWidth(s).toLowerCase().replace(/\s+/g, '').replace(/[「」『』“”‘’"'《》〈〉【】[\]（）()·・]/g, '');
}

// ------------------------------------------------------------------
// 上下文索引
// ------------------------------------------------------------------

export interface RelationEntityRef {
  id: string;
  name: string;
  aliases?: string[];
}

export interface RelationCandidateContext {
  /** 当前章节纯文本，用于关系证据接地 */
  chapterContent?: string;
  characters?: RelationEntityRef[];
  items?: RelationEntityRef[];
  locations?: RelationEntityRef[];
}

/**
 * 预建索引：一章扫描开始时 build 一次，之后每条断言只做 O(1) 查表。
 * 同一次扫描中新落库的实体用 addCharacter/addItem/addLocation 增量登记，
 * 否则「实体行在前、关系行在后」时同一章新建的角色会解析不到。
 */
export interface PreparedRelationContext {
  chapterCompact?: string;
  characterIdByKey: Map<string, string>;
  itemIdByKey: Map<string, string>;
  locationIdByKey: Map<string, string>;
  addCharacter(character: RelationEntityRef): void;
  addItem(item: RelationEntityRef): void;
  addLocation(location: RelationEntityRef): void;
}

function registerRef(map: Map<string, string>, ref: RelationEntityRef): void {
  const nameKey = relationNameKey(ref.name);
  if (nameKey && !map.has(nameKey)) map.set(nameKey, ref.id);
  for (const alias of ref.aliases ?? []) {
    const aliasKey = relationNameKey(alias);
    if (aliasKey && !map.has(aliasKey)) map.set(aliasKey, ref.id);
  }
}

export function prepareRelationContext(ctx: RelationCandidateContext = {}): PreparedRelationContext {
  const characterIdByKey = new Map<string, string>();
  const itemIdByKey = new Map<string, string>();
  const locationIdByKey = new Map<string, string>();
  for (const ref of ctx.characters ?? []) registerRef(characterIdByKey, ref);
  for (const ref of ctx.items ?? []) registerRef(itemIdByKey, ref);
  for (const ref of ctx.locations ?? []) registerRef(locationIdByKey, ref);

  return {
    chapterCompact: ctx.chapterContent ? compactText(ctx.chapterContent) : undefined,
    characterIdByKey,
    itemIdByKey,
    locationIdByKey,
    addCharacter(ref) {
      registerRef(characterIdByKey, ref);
    },
    addItem(ref) {
      registerRef(itemIdByKey, ref);
    },
    addLocation(ref) {
      registerRef(locationIdByKey, ref);
    },
  };
}

// ------------------------------------------------------------------
// 断言校验
// ------------------------------------------------------------------

/** 扫描流输出的关系断言（与 scanner-agent 的 StreamRelationAssertion 同形） */
export interface RelationAssertion {
  assertionType: 'character_relation' | 'item_relation' | 'location_relation';
  subject: string;
  object: string;
  type?: string;
  direction?: 'mutual' | 'from' | 'to';
  context?: string;
  description?: string;
}

export type RelationValidation =
  | { accept: false; reason: string }
  | {
      accept: true;
      kind: 'character';
      subjectId: string;
      objectId: string;
      type: CharacterRelationCode;
      direction: 'mutual' | 'from' | 'to';
      description?: string;
    }
  | {
      accept: true;
      kind: 'item';
      subjectId: string;
      objectId: string;
      type: ItemRelationType;
      description?: string;
    }
  | {
      accept: true;
      kind: 'location';
      subjectId: string;
      /** 客体可能是地点，也可能是角色（「陈星位于藏经阁」） */
      targetId: string;
      targetKind: LocationRelation['targetKind'];
      type: LocationRelationCode;
      description?: string;
    };

/** 证据接地：给了 context 就必须真的出自原文（与事件 quote 同一口径） */
function isGrounded(context: string, prepared: PreparedRelationContext): boolean {
  if (!prepared.chapterCompact) return true;
  const compact = compactText(context);
  if (!compact) return false;
  return prepared.chapterCompact.includes(compact);
}

// ------------------------------------------------------------------
// 关系谓词（证据里必须真的「说了关系」，不能只是两个名字挨在一起）
// ------------------------------------------------------------------

/**
 * 关系类型 → 证据里必须出现的谓词。
 *
 * 为什么需要这一层：只校验「证据出自原文」不够。实测「老周把陈星安置在
 * 听雨楼二楼」被当成陈星-听雨楼的关系证据 —— 两个名字都在、确实是原文，
 * 但这句给的是「安置」，不是「位于」。同理「青云子与顾长渊相对而立」不能
 * 证明师徒。模型很擅长把「同场出现」包装成关系，谓词是唯一的确定性闸门。
 *
 * 规则按**类型**而非按句子：只要该类型的任一谓词出现在证据里即可，宁可宽松
 * 到「同一个动词的多种写法」，也不接受「证据里连一个关系词都没有」。
 */
const RELATION_PREDICATES: Record<CharacterRelationCode, RegExp> = {
  // 「收…为徒」「拜师」「师父」「弟子」「教我」
  mentor: /(师父|师傅|师尊|恩师|弟子|徒弟|门徒|拜师|收.{0,6}为徒|授业|传授|所授|教(导|会|过|他|她)?|门下|入我门)/,
  // 注意：婚宴/成亲/娶/嫁属于「恋人」而不是「家人」——办婚宴的是夫妻，不是亲属
  family: /(父亲|母亲|爹|娘|爸爸|妈妈|儿子|女儿|哥哥|姐姐|弟弟|妹妹|兄长|胞弟|亲弟|亲妹|血缘|亲生|家人|亲人|一族|一家)/,
  lover: /(恋人|情侣|爱人|夫妻|夫妇|道侣|未婚妻|未婚夫|心上人|情人|娶|嫁|婚|成亲|拜堂|相恋|倾心|爱慕|定情|放在心上)/,
  friend: /(朋友|好友|挚友|知己|故交|同门|师兄|师姐|师弟|师妹|忘年之交|惺惺相惜|结为好友|交好|相识多年)/,
  enemy: /(仇|敌|杀|恨|叛|反目|不共戴天|死敌|追杀|为敌|报仇|囚|夺|刺|打落|一掌|拔剑|结下|决战|交战|厮杀|动手|抓走|绑|挟持|押走|伏法|缉拿|拿下|结下死仇)/,
  rival: /(对手|较量|切磋|比试|比拼|再战|不分上下|分庭抗礼|互为对手|竞争)/,
  subordinate: /(属下|下属|部下|上司|上峰|主仆|主上|听命|差遣|命令|号令|统辖|管着)/,
  ally: /(盟友|同盟|结盟|联手|合作|同盟者|同伙|并肩|共同对付)/,
  mutual: /(认识|相识|见过|相识一场|有关系)/,
  other: /./,
};

/** 地点关系谓词：同样必须「说了关系」而不是「同场出现」 */
const LOCATION_PREDICATES: Record<LocationRelationCode, RegExp> = {
  located_in: /(位于|坐落|处在|在|进了|走进|走入|进入|回到|来到|赶到|困在|守在|安置|藏在|关在|挂在|站在|等在|葬在|开着一间|建在|山门|山麓|山脚|之下|之上|腹地|顶层|二楼|东街|镇上)/,
  nearby: /(附近|邻近|相邻|挨着|毗邻|接壤|旁边|不远处|很近|翻过.{0,6}就到|隔壁|隔着|离.{0,8}近|之间|紧邻|就在|对岸|外.{0,4}里|岸边)/,
  routes_to: /(通往|通向|直达|连接|相连|密道|地道|通道|一条路|延伸至|走到尽头)/,
  related_to: /./,
};

/** 物品关系谓词 */
const ITEM_PREDICATES: Record<string, RegExp> = {
  paired_with: /(一对|配对|配套|剑鞘|鞘|子母|成双|一对儿|原配|相配)/,
  contains: /(装|容纳|内含|里含|中有一|藏着|盛着|里面(是|有)|装满)/,
  part_of: /(部件|组件|零件|一部分|取下|拆下|组成|配件)/,
  opposite_of: /(相克|克制|对立|正邪|相反|宿敌|天敌|互克)/,
  transforms_into: /(变成|化作|化形|变形|蜕变|觉醒|进化|化为)/,
  related_to: /(同源|同出一源|相关|同出|类似|伴生|配合|关联)/,
};

// ------------------------------------------------------------------
// 地点在场推断（确定性召回兜底）
// ------------------------------------------------------------------

/**
 * 「某人在某地」的句内证据。
 *
 * 为什么需要这一层：模型对 location_relation 的召回不稳定 —— 同一章里
 * 「沈砚登上江心洲」这种再明确不过的句子，实测有时一条都不输出。整章共现
 * 推断太粗（主角每章换地点会连出几十条边），但**同一句话里同时出现地点名、
 * 人物名，且有在场谓词**，是接近确定性的证据，可以安全地补一条。
 *
 * 约束（宁可漏，不可错）：
 *   · 只在一句话内匹配，不跨句；
 *   · 句子必须含在场谓词（位于/进了/走进/来到/站在/登上/葬在…）；
 *   · 单句最多产出 3 条、单章最多 12 条，避免长句爆炸。
 */
const PRESENCE_SENTENCE = new RegExp(
  '(' +
    [
      '位于', '坐落', '处在', '进了', '走进', '走入', '进入', '回到', '来到', '赶到',
      '登上', '踏入', '困在', '守在', '等在', '站在', '坐在', '躺在', '跪在', '葬在',
      '关在', '藏在', '安置在', '挂在', '开着一间', '建在', '直达', '通往',
    ].join('|') +
    '|在.{0,8}(里|内|中|上|之下|之上|外|旁|腹地|顶层|二楼|门口))',
);

const MAX_PRESENCE_PER_SENTENCE = 3;
const MAX_PRESENCE_PER_CHAPTER = 12;

/** 句末标点与换行：按句切分（不保留标点，context 仍能逐字命中原文） */
const SENTENCE_BREAK = /[。！？!?；;\r\n]+/;

function sentencesOf(chapterContent: string): string[] {
  return chapterContent
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 80);
}

/** 名称（含别名）是否出现在这句话里（紧凑比较，忽略空白/引号） */
function nameInSentence(ref: RelationEntityRef, sentenceCompact: string): boolean {
  const keys = [ref.name, ...(ref.aliases ?? [])].map(relationNameKey).filter(Boolean);
  return keys.some((key) => key.length >= 2 && sentenceCompact.includes(key));
}

/**
 * 从句内证据推断「地点 → 角色」的在场关系。
 * 返回的是标准断言形状，调用方照常走 validate + plan（去重、接地都会再校验一遍）。
 */
export function inferLocationPresence(
  chapterContent: string,
  locations: RelationEntityRef[],
  characters: RelationEntityRef[],
): RelationAssertion[] {
  if (!chapterContent || locations.length === 0 || characters.length === 0) return [];
  const out: RelationAssertion[] = [];
  const seen = new Set<string>();

  for (const sentence of sentencesOf(chapterContent)) {
    if (out.length >= MAX_PRESENCE_PER_CHAPTER) break;
    if (!PRESENCE_SENTENCE.test(sentence)) continue;
    const compactSentence = compactText(sentence);

    const presentLocations = locations.filter((ref) => nameInSentence(ref, compactSentence));
    if (presentLocations.length === 0) continue;
    const presentCharacters = characters.filter((ref) => nameInSentence(ref, compactSentence));
    if (presentCharacters.length === 0) continue;

    let perSentence = 0;
    for (const location of presentLocations) {
      for (const character of presentCharacters) {
        if (perSentence >= MAX_PRESENCE_PER_SENTENCE) break;
        if (out.length >= MAX_PRESENCE_PER_CHAPTER) break;
        if (location.id === character.id) continue;
        const key = `${location.id}|${character.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        perSentence++;
        out.push({
          assertionType: 'location_relation',
          subject: location.name,
          object: character.name,
          type: '位于',
          context: sentence,
        });
      }
    }
  }
  return out;
}

/**
 * 按证据修正模型给出的类型。
 *
 * 实测模型会把「师兄/师姐/同门」标成「师徒」或「上下级」，把「师弟」标成
 * 「认识」。关系词本身是确定的：出现同门类称呼就是同门（friend），出现
 * 师父/收徒才是师徒。只在模型类型明显冲突时改，不推翻 enemy/family 这类
 * 有独立证据的类型。
 */
function refineCharacterTypeFromEvidence(
  type: CharacterRelationCode,
  context: string,
): CharacterRelationCode {
  const text = compactText(context);
  const peer = /(师兄|师姐|师弟|师妹|同门|同窗)/.test(text);
  const master = /(师父|师尊|恩师|拜师|收.{0,6}为徒|弟子|徒弟|门徒|所授)/.test(text);
  // ★ 顺序有关系：一句话里可能同时出现「徒弟」和「师兄」
  //   （「顾长渊是青云子最早收的徒弟，也是陈星与苏晚的师兄」）——
  //   有师徒证据时一律按师徒，只有「仅出现同门称呼」才降级成同门。
  if (master && (type === 'mutual' || type === 'other' || type === 'friend' || type === 'mentor')) {
    return 'mentor';
  }
  // 「成亲/婚宴/娶/嫁」是恋人证据，模型常写成「家人」
  const lover = /(成亲|拜堂|婚宴|娶|嫁|心上人|倾心|定情)/.test(text);
  if (lover && (type === 'family' || type === 'mutual' || type === 'other')) {
    return 'lover';
  }
  if (peer && (type === 'mentor' || type === 'subordinate' || type === 'mutual' || type === 'other')) {
    return 'friend';
  }
  return type;
}

/** 证据必须含该类型的关系谓词；不匹配返回 false */
function hasPredicate(kind: 'character' | 'item' | 'location', type: string, context: string): boolean {
  const text = compactText(context);
  if (!text) return false;
  if (kind === 'character') {
    const pattern = RELATION_PREDICATES[type as CharacterRelationCode] ?? RELATION_PREDICATES.other;
    return pattern.test(text);
  }
  if (kind === 'item') {
    const pattern = ITEM_PREDICATES[type] ?? ITEM_PREDICATES.related_to!;
    return pattern.test(text);
  }
  const pattern = LOCATION_PREDICATES[type as LocationRelationCode] ?? LOCATION_PREDICATES.related_to;
  return pattern.test(text);
}

/**
 * 关系断言校验（纯函数）。accept=false 直接丢弃；accept=true 由调用方落库。
 * 不校验重复 —— 去重需要现有关系快照，由 apply 阶段负责。
 */
export function validateRelationAssertion(
  assertion: RelationAssertion,
  prepared: PreparedRelationContext,
): RelationValidation {
  const subjectKey = relationNameKey(assertion.subject ?? '');
  const objectKey = relationNameKey(assertion.object ?? '');
  if (!subjectKey || !objectKey) return { accept: false, reason: '主体/客体为空' };
  if (subjectKey === objectKey) return { accept: false, reason: '自指关系' };

  // 证据接地：模型给出的证据必须能在本章正文里连续命中，否则视为编造
  // 关系必须带证据：没有证据就无法判断它是「原文写的关系」还是「同场联想」。
  const context = typeof assertion.context === 'string' ? assertion.context.trim() : '';
  if (!context) return { accept: false, reason: '缺少证据' };
  if (!isGrounded(context, prepared)) {
    return { accept: false, reason: '证据与原文不符' };
  }
  // ★ 关系谓词：证据里必须真的「说了关系」，仅仅两个名字同时出现不算。
  //   各分支在类型归一之后各自校验（地点关系的类型取决于客体是地点还是角色）。

  const description = typeof assertion.description === 'string' && assertion.description.trim()
    ? assertion.description.trim().slice(0, 120)
    : undefined;

  if (assertion.assertionType === 'character_relation') {
    const subjectId = prepared.characterIdByKey.get(subjectKey);
    const targetId = prepared.characterIdByKey.get(objectKey);
    if (!subjectId || !targetId) return { accept: false, reason: '角色未解析' };
    const normalized = normalizeCharacterRelationType(assertion.type);
    const type = refineCharacterTypeFromEvidence(normalized, context);
    // 未归一到具体语义的自由描述不值得入图：图上一堆「其他」等于噪声
    if (type === 'other') return { accept: false, reason: '关系类型无法归一' };
    // 「认识/相识/见过」这类泛关系没有信息量，只会把图撑起来；
    // 两个人真有朋友/对手/仇敌关系，模型应当给出具体类型。
    if (type === 'mutual') return { accept: false, reason: '关系类型过泛' };
    if (!hasPredicate('character', type, context)) {
      return { accept: false, reason: '证据里没有关系表述' };
    }
    // 模型没给方向时按关系本身的性质取默认：对称关系 → mutual，
    // 师徒/上下级 → to（subject 是上位者），不做成双向对等
    // ★ 对称关系一律 mutual，**不采信模型给的方向**。
    //   实测模型对同一条朋友关系会写出 `陈星→苏晚(from)` 和 `苏晚→陈星(to)`，
    //   双向存储后两侧方向不一致 → 图中一条边两个箭头，删除时也只删一侧。
    //   对称性是关系类型本身的属性，不是模型每次都要判断的东西。
    const direction = SYMMETRIC_CHARACTER_RELATIONS.has(type)
      ? 'mutual'
      : (assertion.direction === 'from' ? 'from' : 'to');
    return {
      accept: true,
      kind: 'character',
      subjectId,
      objectId: targetId,
      type,
      direction,
      ...(description ? { description } : {}),
    };
  }

  if (assertion.assertionType === 'item_relation') {
    const subjectId = prepared.itemIdByKey.get(subjectKey);
    const targetId = prepared.itemIdByKey.get(objectKey);
    if (!subjectId || !targetId) return { accept: false, reason: '物品未解析' };
    const type = normalizeItemRelationType(assertion.type);
    if (!hasPredicate('item', type, context)) {
      return { accept: false, reason: '证据里没有关系表述' };
    }
    return {
      accept: true,
      kind: 'item',
      subjectId,
      objectId: targetId,
      type,
      ...(description ? { description } : {}),
    };
  }

  // location_relation：存储侧主语永远是地点，另一端是地点或角色。
  // 模型偶尔把方向写反（「陈星位于藏经阁」写成 subject=陈星），这里对调而不是丢。
  let locationId = prepared.locationIdByKey.get(subjectKey);
  let otherLocationId = prepared.locationIdByKey.get(objectKey);
  let otherCharacterId = prepared.characterIdByKey.get(objectKey);
  if (!locationId) {
    const swappedLocationId = prepared.locationIdByKey.get(objectKey);
    const swappedCharacterId = prepared.characterIdByKey.get(subjectKey);
    if (!swappedLocationId || !swappedCharacterId) {
      return { accept: false, reason: '地点未解析' };
    }
    // 角色 → 地点：换成 (地点 ← 角色)
    locationId = swappedLocationId;
    otherLocationId = undefined;
    otherCharacterId = swappedCharacterId;
  }
  if (!otherLocationId && !otherCharacterId) return { accept: false, reason: '客体未解析' };

  const targetKind: LocationRelation['targetKind'] = otherLocationId ? 'location' : 'character';
  // ★ 类型归一：一端是角色 ⇒ 语义只有「某人在某地」，一律 located_in
  //   （模型常写成「关联」）；两端都是地点才按词表分 located_in/nearby/routes_to。
  const type = normalizeLocationRelationType(assertion.type, targetKind);
  if (!hasPredicate('location', type, context)) {
    return { accept: false, reason: '证据里没有关系表述' };
  }
  return {
    accept: true,
    kind: 'location',
    subjectId: locationId,
    targetId: otherLocationId ?? otherCharacterId!,
    targetKind,
    type,
    ...(description ? { description } : {}),
  };
}

// ------------------------------------------------------------------
// 去重与落库计划
// ------------------------------------------------------------------

/** 角色关系去重键：无序对 + 类型（与 RelationGraph 的 seenRel 同口径） */
function characterPairKey(a: string, b: string, type: string): string {
  return [a, b].sort().join('|') + '|' + type;
}

/** 物品关系去重键：无序对 + 类型（ItemGraph 双向存储，图上只画一条） */
function itemPairKey(a: string, b: string, type: string): string {
  return [a, b].sort().join('|') + '|' + type;
}

export interface ExistingRelations {
  characters: Array<{ id: string; relations?: CharacterRelation[] }>;
  items: Array<{ id: string; relations?: ItemRelation[] }>;
  locations: Array<{ id: string; relations?: LocationRelation[] }>;
}

export interface RelationDedupeIndex {
  characters: Set<string>;
  items: Set<string>;
  locations: Set<string>;
  /** 记录本次扫描已写入的键，避免同一流里重复断言反复落库 */
  mark(validation: Extract<RelationValidation, { accept: true }>): boolean;
}

export function prepareRelationDedupe(existing: ExistingRelations): RelationDedupeIndex {
  const characters = new Set<string>();
  for (const character of existing.characters) {
    for (const rel of character.relations ?? []) {
      characters.add(characterPairKey(character.id, rel.targetId, rel.type));
    }
  }
  const items = new Set<string>();
  for (const item of existing.items) {
    for (const rel of item.relations ?? []) {
      items.add(itemPairKey(item.id, rel.targetItemId, rel.type));
    }
  }
  const locations = new Set<string>();
  for (const location of existing.locations) {
    for (const rel of location.relations ?? []) {
      locations.add(
        [location.id, rel.targetKind, rel.targetId].join('|') + '|' + rel.type,
      );
    }
  }

  const index: RelationDedupeIndex = {
    characters,
    items,
    locations,
    mark(validation) {
      if (validation.kind === 'character') {
        const key = characterPairKey(validation.subjectId, validation.objectId, validation.type);
        if (characters.has(key)) return false;
        characters.add(key);
        return true;
      }
      if (validation.kind === 'item') {
        const key = itemPairKey(validation.subjectId, validation.objectId, validation.type);
        if (items.has(key)) return false;
        items.add(key);
        return true;
      }
      const key = [validation.subjectId, validation.targetKind, validation.targetId].join('|') + '|' + validation.type;
      if (locations.has(key)) return false;
      locations.add(key);
      return true;
    },
  };
  return index;
}

/**
 * 关系写入的最小动作集（纯数据，调用方按此写 store）。
 * 角色/物品关系双向存储：图谱按无序对去重，单侧写入会导致删除后另一侧残留。
 */
export type RelationWrite =
  | {
      kind: 'character';
      additions: Array<{ characterId: string; relation: CharacterRelation }>;
    }
  | {
      kind: 'item';
      additions: Array<{ itemId: string; relation: ItemRelation }>;
    }
  | {
      kind: 'location';
      additions: Array<{ locationId: string; relation: LocationRelation }>;
    };

/**
 * 由校验结果生成写入计划。
 * @param chapterOrder 当前章节（写入 relation.chapter，供「关系在第几章建立」展示）
 * @param dedupe       prepareRelationDedupe 产出的去重索引（会被就地更新）
 */
export function planRelationWrite(
  validation: Extract<RelationValidation, { accept: true }>,
  chapterOrder: number,
  dedupe: RelationDedupeIndex,
): { write: RelationWrite; added: boolean } | null {
  const isNew = dedupe.mark(validation);
  if (!isNew) return null;

  if (validation.kind === 'character') {
    // 存储永远成对写入：图谱按无序对去重，只写一侧会让删除后另一侧残留
    // （方向语义仍保留在 direction 上，由 RelationGraph 决定是否画箭头）
    const forward: CharacterRelation = {
      targetId: validation.objectId,
      type: validation.type,
      direction: validation.direction,
      chapter: chapterOrder,
      ...(validation.description ? { description: validation.description } : {}),
    };
    const backwardDirection: CharacterRelation['direction'] =
      validation.direction === 'to' ? 'from' : validation.direction === 'from' ? 'to' : 'mutual';
    const backward: CharacterRelation = {
      targetId: validation.subjectId,
      type: validation.type,
      direction: backwardDirection,
      chapter: chapterOrder,
      ...(validation.description ? { description: validation.description } : {}),
    };
    return {
      write: {
        kind: 'character',
        additions: [
          { characterId: validation.subjectId, relation: forward },
          { characterId: validation.objectId, relation: backward },
        ],
      },
      added: true,
    };
  }

  if (validation.kind === 'item') {
    return {
      write: {
        kind: 'item',
        additions: [
          {
            itemId: validation.subjectId,
            relation: {
              targetItemId: validation.objectId,
              type: validation.type,
              chapter: chapterOrder,
              ...(validation.description ? { description: validation.description } : {}),
            },
          },
          {
            itemId: validation.objectId,
            relation: {
              targetItemId: validation.subjectId,
              type: validation.type,
              chapter: chapterOrder,
              ...(validation.description ? { description: validation.description } : {}),
            },
          },
        ],
      },
      added: true,
    };
  }

  const forward: LocationRelation = {
    targetId: validation.targetId,
    targetKind: validation.targetKind,
    type: validation.type,
    chapter: chapterOrder,
    ...(validation.description ? { description: validation.description } : {}),
  };
  const additions: Array<{ locationId: string; relation: LocationRelation }> = [
    { locationId: validation.subjectId, relation: forward },
  ];
  // 地点 ↔ 地点双向存储；地点 → 角色只写在地点侧（角色结构里没有地点字段）
  if (validation.targetKind === 'location') {
    // ★ 反向类型不能照抄：located_in 是**有向**的（藏经阁位于青云山），
    //   反过来「青云山位于藏经阁」是错的。nearby 对称，routes_to 反向语义
    //   不成立（存成 related_to 太糊，宁可不存反向），related_to 对称。
    const reverseType: LocationRelation['type'] | null =
      validation.type === 'nearby' || validation.type === 'related_to'
        ? validation.type
        : null;
    if (reverseType) {
      additions.push({
        locationId: validation.targetId,
        relation: {
          targetId: validation.subjectId,
          targetKind: 'location',
          type: reverseType,
          chapter: chapterOrder,
          ...(validation.description ? { description: validation.description } : {}),
        },
      });
    }
  }
  return { write: { kind: 'location', additions }, added: true };
}