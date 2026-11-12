// ============================================================
// 物品识别多题材章节样本
//
// 每个样本 = 一段章节正文 + 一组「模拟 AI 扫描输出的 item 候选」。
// 候选里同时包含真物品与实测高频误识别（货币/系统 UI/声光/描述性短语），
// 用来锁定 validateItemCandidate 的接受/拒绝边界。
// ============================================================

import type { Item } from '@novel/shared';

export interface ItemExpectation {
  accept: boolean;
  /** 期望归一化后的名称（默认取 normalizeItemName(candidate.name)） */
  name?: string;
  /** 期望类型码 */
  type?: string;
  /** 期望拒绝原因 */
  reason?: string;
  /** 期望命中已有物品 */
  existing?: boolean;
}

export interface SampleCandidate {
  name: string;
  itemType?: string;
  context?: string;
  expect: ItemExpectation;
}

export interface ChapterItemSample {
  id: string;
  genre: string;
  title: string;
  text: string;
  existingCharacters?: string[];
  existingLocations?: string[];
  existingItems?: Item[];
  candidates: SampleCandidate[];
}

function makeItem(over: Partial<Item>): Item {
  return {
    id: `item-${over.name ?? 'x'}`,
    projectId: 'p1',
    name: '',
    states: [],
    holders: [],
    currentHolders: [],
    relations: [],
    chapters: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

export const CHAPTER_ITEM_SAMPLES: ChapterItemSample[] = [
  {
    id: 'xianxia-01',
    genre: '修仙',
    title: '寒潭夺剑',
    text: `青云宗后山，寒潭之上浮着一柄断剑，剑身刻着「玄冰剑」三字。
陈星踏水而行，周野横刀拦在潭边。
「把玄冰剑交出来！」周野掌心托着一枚储物戒，刀锋映着寒光。
陈星不答，从怀中取出一张遁地符，符纸无风自燃。下一瞬，他已出现在十丈之外。
周野咬牙追去，却不慎踩碎了一枚回气丹。丹香四散，一只通体雪白的灵狐从草丛中窜出，衔起丹渣便跑。
系统提示响起：获得 100 灵石，经验 +50。`,
    existingCharacters: ['陈星', '周野'],
    existingLocations: ['青云宗后山', '寒潭'],
    existingItems: [makeItem({ name: '「玄冰剑」' })],
    candidates: [
      { name: '玄冰剑', itemType: 'weapon', context: '剑身刻着「玄冰剑」三字', expect: { accept: true, name: '玄冰剑', type: 'weapon', existing: true } },
      { name: '储物戒', itemType: 'tool', context: '掌心托着一枚储物戒', expect: { accept: true, type: 'tool' } },
      { name: '遁地符', itemType: 'token', context: '从怀中取出一张遁地符', expect: { accept: true, type: 'token' } },
      { name: '回气丹', itemType: 'potion', context: '踩碎了一枚回气丹', expect: { accept: true, type: 'potion' } },
      { name: '灵狐', itemType: 'animal', context: '一只通体雪白的灵狐', expect: { accept: true, type: 'animal' } },
      { name: '100 灵石', context: '获得 100 灵石', expect: { accept: false, reason: '数值/货币' } },
      { name: '经验', context: '经验 +50', expect: { accept: false, reason: '抽象概念' } },
      { name: '系统提示', context: '系统提示响起', expect: { accept: false, reason: '系统界面元素' } },
      { name: '寒光', context: '刀锋映着寒光', expect: { accept: false, reason: '非实体' } },
      { name: '寒潭', context: '寒潭之上浮着一柄断剑', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'urban-system-01',
    genre: '都市系统',
    title: '便利店签到',
    text: `林晚站在便利店门口，手机屏幕忽然亮起。
【叮！签到成功，获得幸运+3，积分+500，商城解锁。】
她点开系统面板，兑换了一瓶初级营养液，又用 200 积分买下「隐匿斗篷」。
收银台后的店员抬头看了她一眼，目光在她手腕的旧手表上停了停。
林晚把斗篷塞进背包，背包侧袋里还躺着一枚生锈的铜钥匙。`,
    existingCharacters: ['林晚'],
    existingLocations: ['便利店'],
    candidates: [
      { name: '初级营养液', itemType: 'potion', context: '兑换了一瓶初级营养液', expect: { accept: true, type: 'potion' } },
      { name: '隐匿斗篷', itemType: 'clothing', context: '买下「隐匿斗篷」', expect: { accept: true, type: 'clothing' } },
      { name: '旧手表', itemType: 'tool', context: '手腕的旧手表', expect: { accept: true, type: 'tool' } },
      { name: '铜钥匙', itemType: 'key', context: '一枚生锈的铜钥匙', expect: { accept: true, type: 'key' } },
      { name: '背包', itemType: 'tool', context: '林晚把斗篷塞进背包', expect: { accept: true, type: 'tool' } },
      { name: '幸运+3', context: '获得幸运+3', expect: { accept: false, reason: '数值/货币' } },
      { name: '积分+500', context: '积分+500', expect: { accept: false, reason: '数值/货币' } },
      { name: '200 积分', context: '又用 200 积分', expect: { accept: false, reason: '数值/货币' } },
      { name: '系统面板', context: '她点开系统面板', expect: { accept: false, reason: '系统界面元素' } },
      { name: '商城', context: '商城解锁', expect: { accept: false, reason: '系统界面元素' } },
    ],
  },
  {
    id: 'wuxia-01',
    genre: '武侠',
    title: '破庙夜雨',
    text: `雨夜，破庙。
沈孤鸿将一柄长剑横在膝上，指尖抚过剑鞘上的裂纹。
门外传来马蹄声，一炷香后，三个黑衣人推门而入。
「交出《寒江剑谱》。」为首者压低声音。
沈孤鸿不答，反手掷出一枚柳叶镖。镖入柱三寸，尾端系着一张泛黄的藏宝图。
黑衣人退了一步，袖中滑出一面玄铁盾牌。`,
    existingCharacters: ['沈孤鸿'],
    existingLocations: ['破庙'],
    candidates: [
      { name: '长剑', itemType: 'weapon', context: '将一柄长剑横在膝上', expect: { accept: true, type: 'weapon' } },
      { name: '剑鞘', itemType: 'tool', context: '指尖抚过剑鞘上的裂纹', expect: { accept: true, type: 'tool' } },
      { name: '寒江剑谱', itemType: 'scroll', context: '交出《寒江剑谱》', expect: { accept: true, type: 'scroll' } },
      { name: '柳叶镖', itemType: 'weapon', context: '反手掷出一枚柳叶镖', expect: { accept: true, type: 'weapon' } },
      { name: '藏宝图', itemType: 'document', context: '尾端系着一张泛黄的藏宝图', expect: { accept: true, type: 'document' } },
      { name: '玄铁盾牌', itemType: 'armor', context: '袖中滑出一面玄铁盾牌', expect: { accept: true, type: 'armor' } },
      { name: '马蹄声', context: '门外传来马蹄声', expect: { accept: false, reason: '非实体' } },
      { name: '三个黑衣人', context: '三个黑衣人推门而入', expect: { accept: false, reason: '数量短语' } },
      { name: '香', context: '一炷香后', expect: { accept: false, reason: '名称过短' } },
      { name: '破庙', context: '雨夜，破庙', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'western-fantasy-01',
    genre: '西幻',
    title: '酒馆委托',
    text: `艾琳推开酒馆的木门，风雪灌了进来。
吧台后的矮人举起一只镶银的酒杯：「一杯蜂蜜酒，两枚银币。」
她放下银币，从斗篷内袋取出一卷羊皮纸，纸上是残缺的地图。
角落里，一个戴兜帽的陌生人将法杖斜靠在桌边，杖首嵌着一颗幽蓝的魔晶。
「你在找灰烬王冠？」陌生人低声问。
艾琳握紧了颈间的月光石吊坠。`,
    existingCharacters: ['艾琳'],
    existingLocations: ['酒馆'],
    candidates: [
      { name: '酒杯', itemType: 'tool', context: '举起一只镶银的酒杯', expect: { accept: true, type: 'tool' } },
      { name: '蜂蜜酒', itemType: 'food', context: '一杯蜂蜜酒', expect: { accept: true, type: 'food' } },
      { name: '羊皮纸', itemType: 'document', context: '取出一卷羊皮纸', expect: { accept: true, type: 'document' } },
      { name: '地图', itemType: 'document', context: '纸上是残缺的地图', expect: { accept: true, type: 'document' } },
      { name: '法杖', itemType: 'artifact', context: '将法杖斜靠在桌边', expect: { accept: true, type: 'artifact' } },
      { name: '魔晶', itemType: 'gem', context: '嵌着一颗幽蓝的魔晶', expect: { accept: true, type: 'gem' } },
      { name: '灰烬王冠', itemType: 'clothing', context: '你在找灰烬王冠', expect: { accept: true, type: 'clothing' } },
      { name: '月光石吊坠', itemType: 'clothing', context: '颈间的月光石吊坠', expect: { accept: true, type: 'clothing' } },
      { name: '兜帽', itemType: 'clothing', context: '一个戴兜帽的陌生人', expect: { accept: true, type: 'clothing' } },
      { name: '镶银的酒杯', context: '举起一只镶银的酒杯', expect: { accept: false, reason: '描述性短语' } },
      { name: '银币', context: '两枚银币', expect: { accept: false, reason: '抽象概念' } },
      { name: '残缺的地图', context: '纸上是残缺的地图', expect: { accept: false, reason: '描述性短语' } },
      { name: '酒馆', context: '推开酒馆的木门', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'palace-01',
    genre: '古言宫廷',
    title: '长乐宫问话',
    text: `长乐宫，烛火摇曳。
苏晚跪在青石地上，双手捧着那枚家传的羊脂玉佩。
皇后端坐凤椅，指尖轻轻敲着扶手：「这玉佩的纹样，倒像是前朝之物。」
嬷嬷上前，从锦盒中取出一支金步摇，又抖开一卷明黄诏书。
「奉天承运——」嬷嬷的声音尖细。
苏晚低头，袖中攥紧了一方绣着并蒂莲的帕子。`,
    existingCharacters: ['苏晚', '皇后'],
    existingLocations: ['长乐宫'],
    candidates: [
      { name: '羊脂玉佩', itemType: 'clothing', context: '双手捧着那枚家传的羊脂玉佩', expect: { accept: true, type: 'clothing' } },
      { name: '金步摇', itemType: 'clothing', context: '从锦盒中取出一支金步摇', expect: { accept: true, type: 'clothing' } },
      { name: '明黄诏书', itemType: 'document', context: '又抖开一卷明黄诏书', expect: { accept: true, type: 'document' } },
      { name: '锦盒', itemType: 'tool', context: '从锦盒中取出一支金步摇', expect: { accept: true, type: 'tool' } },
      { name: '帕子', itemType: 'clothing', context: '一方绣着并蒂莲的帕子', expect: { accept: true, type: 'clothing' } },
      { name: '烛火', context: '长乐宫，烛火摇曳', expect: { accept: false, reason: '非实体' } },
      { name: '长乐宫', context: '长乐宫，烛火摇曳', expect: { accept: false, reason: '组织/地点' } },
    ],
  },
  {
    id: 'apocalypse-01',
    genre: '末世科幻',
    title: '避难所封锁',
    text: `避难所负三层，应急灯忽明忽暗。
陆沉打开合金箱，里面躺着一支蓝色药剂和半块能量电池。
「只剩一支了。」林霜说。
他把药剂推给她，自己拿起角落里的电磁步枪，检查弹匣。
墙上的广播忽然响起：「B 区封锁，所有幸存者前往三号闸门。」
陆沉抓起一把战术匕首，又往口袋里塞了两枚手雷。`,
    existingCharacters: ['陆沉', '林霜'],
    existingLocations: ['避难所', '三号闸门'],
    candidates: [
      { name: '合金箱', itemType: 'tool', context: '打开合金箱', expect: { accept: true, type: 'tool' } },
      { name: '蓝色药剂', itemType: 'potion', context: '一支蓝色药剂', expect: { accept: true, type: 'potion' } },
      { name: '能量电池', itemType: 'tool', context: '半块能量电池', expect: { accept: true, type: 'tool' } },
      { name: '电磁步枪', itemType: 'weapon', context: '拿起角落里的电磁步枪', expect: { accept: true, type: 'weapon' } },
      { name: '弹匣', itemType: 'tool', context: '检查弹匣', expect: { accept: true, type: 'tool' } },
      { name: '战术匕首', itemType: 'weapon', context: '抓起一把战术匕首', expect: { accept: true, type: 'weapon' } },
      { name: '手雷', itemType: 'weapon', context: '塞了两枚手雷', expect: { accept: true, type: 'weapon' } },
      { name: '应急灯', itemType: 'tool', context: '应急灯忽明忽暗', expect: { accept: true, type: 'tool' } },
      { name: '一把战术匕首', context: '抓起一把战术匕首', expect: { accept: false, reason: '数量短语' } },
      { name: '两枚手雷', context: '塞了两枚手雷', expect: { accept: false, reason: '数量短语' } },
      { name: '半块能量电池', context: '半块能量电池', expect: { accept: false, reason: '数量短语' } },
      { name: '三号闸门', context: '前往三号闸门', expect: { accept: false, reason: '组织/地点' } },
    ],
  },
  {
    id: 'xuanhuan-sect-01',
    genre: '玄幻宗门',
    title: '外门丹房',
    text: `云岚宗外门，晨钟未响。
杂役弟子叶尘蹲在丹房外，用一把破旧的蒲扇扇着炉火。
「叶尘，把这炉聚气丹看好，少一炉扣你十点贡献。」管事丢下一句话便走了。
叶尘摸了摸怀里的半块残玉，玉上刻着一个「岚」字。
三日后，宗门大比开启。他听说冠军可得一柄青岚剑和一瓶洗髓液。
管事临走前又叮嘱，外门弟子不得私练御剑术。`,
    existingCharacters: ['叶尘'],
    existingLocations: ['云岚宗', '丹房'],
    candidates: [
      { name: '蒲扇', itemType: 'tool', context: '用一把破旧的蒲扇扇着炉火', expect: { accept: true, type: 'tool' } },
      { name: '聚气丹', itemType: 'potion', context: '把这炉聚气丹看好', expect: { accept: true, type: 'potion' } },
      { name: '残玉', itemType: 'gem', context: '怀里的半块残玉', expect: { accept: true, type: 'gem' } },
      { name: '青岚剑', itemType: 'weapon', context: '一柄青岚剑', expect: { accept: true, type: 'weapon' } },
      { name: '洗髓液', itemType: 'potion', context: '一瓶洗髓液', expect: { accept: true, type: 'potion' } },
      { name: '半块残玉', context: '怀里的半块残玉', expect: { accept: false, reason: '数量短语' } },
      { name: '贡献', context: '扣你十点贡献', expect: { accept: false, reason: '抽象概念' } },
      { name: '三日后', context: '三日后，宗门大比开启', expect: { accept: false, reason: '时间短语' } },
      { name: '云岚宗', context: '云岚宗外门', expect: { accept: false, reason: '组织/地点' } },
      { name: '炉火', context: '蒲扇扇着炉火', expect: { accept: false, reason: '非实体' } },
      { name: '御剑术', context: '不得私练御剑术', expect: { accept: false, reason: '功法招式' } },
    ],
  },
  {
    id: 'vrmmo-01',
    genre: '网游',
    title: '全服副本开启',
    text: `【系统公告：全服首个「深渊副本」已开启。】
网吧角落，陈默戴上头盔，登录了《苍穹》。
他的角色站在主城拍卖行前，背包里只剩一把新手铁剑和三十枚铜币。
「兄弟，这把裂风弓怎么卖？」一个弓箭手凑过来。
陈默报了个价，顺手把刚爆出的稀有材料「星尘砂」挂上拍卖行。
排行榜第一的公会「血色黎明」正在招募成员。`,
    existingCharacters: ['陈默'],
    existingLocations: ['主城', '拍卖行'],
    candidates: [
      { name: '头盔', itemType: 'armor', context: '陈默戴上头盔', expect: { accept: true, type: 'armor' } },
      { name: '新手铁剑', itemType: 'weapon', context: '一把新手铁剑', expect: { accept: true, type: 'weapon' } },
      { name: '裂风弓', itemType: 'weapon', context: '这把裂风弓怎么卖', expect: { accept: true, type: 'weapon' } },
      { name: '星尘砂', itemType: 'gem', context: '稀有材料「星尘砂」', expect: { accept: true, type: 'gem' } },
      { name: '深渊副本', context: '「深渊副本」已开启', expect: { accept: false, reason: '系统玩法' } },
      { name: '排行榜', context: '排行榜第一的公会', expect: { accept: false, reason: '系统玩法' } },
      { name: '三十枚铜币', context: '三十枚铜币', expect: { accept: false, reason: '数量短语' } },
      { name: '铜币', context: '三十枚铜币', expect: { accept: false, reason: '抽象概念' } },
      { name: '主城', context: '站在主城拍卖行前', expect: { accept: false, reason: '组织/地点' } },
      { name: '拍卖行', context: '挂上拍卖行', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'crime-01',
    genre: '悬疑刑侦',
    title: '旧仓库取证',
    text: `凌晨三点，城南旧仓库。
林警官蹲在积水边，手套上沾着暗红的血迹。
「死者手里攥着一枚银色打火机。」法医低声说。
强光手电扫过墙面，一串模糊的脚印延伸向通风口。
证物袋里还装着一封没有署名的信，信封上的火漆印着半只鹰。
对讲机里传来同事的声音：「监控录像调到了，凶手左手有伤。」`,
    existingCharacters: ['林警官'],
    existingLocations: ['城南旧仓库', '通风口'],
    candidates: [
      { name: '手套', itemType: 'clothing', context: '手套上沾着暗红的血迹', expect: { accept: true, type: 'clothing' } },
      { name: '银色打火机', itemType: 'tool', context: '一枚银色打火机', expect: { accept: true, type: 'tool' } },
      { name: '强光手电', itemType: 'tool', context: '强光手电扫过墙面', expect: { accept: true, type: 'tool' } },
      { name: '证物袋', itemType: 'tool', context: '证物袋里还装着一封', expect: { accept: true, type: 'tool' } },
      { name: '火漆', itemType: 'tool', context: '信封上的火漆', expect: { accept: true, type: 'tool' } },
      { name: '对讲机', itemType: 'tool', context: '对讲机里传来同事的声音', expect: { accept: true, type: 'tool' } },
      { name: '血迹', context: '手套上沾着暗红的血迹', expect: { accept: false, reason: '痕迹/证据' } },
      { name: '脚印', context: '一串模糊的脚印', expect: { accept: false, reason: '痕迹/证据' } },
      { name: '监控录像', context: '监控录像调到了', expect: { accept: false, reason: '痕迹/证据' } },
      { name: '没有署名的信', context: '一封没有署名的信', expect: { accept: false, reason: '描述性短语' } },
      { name: '城南旧仓库', context: '凌晨三点，城南旧仓库', expect: { accept: false, reason: '组织/地点' } },
      { name: '通风口', context: '延伸向通风口', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'folk-horror-01',
    genre: '克苏鲁民俗',
    title: '老宅守夜',
    text: `雨停后，老宅的天井里浮起一层白雾。
守夜人点燃三炷香，把一碗黑狗血泼在门槛上。
「别回头。」他压低声音，将一枚刻满符文的铜钱塞进我掌心。
阁楼传来铜铃的轻响，一下，又一下。
墙角的桃木剑忽然裂开，剑身上渗出一行暗红的字。
我摸到口袋里那半张黄符，符纸已经湿透了。`,
    existingCharacters: ['守夜人'],
    existingLocations: ['老宅', '天井', '阁楼'],
    candidates: [
      { name: '黑狗血', itemType: 'medicine', context: '一碗黑狗血', expect: { accept: true, type: 'medicine' } },
      { name: '铜铃', itemType: 'tool', context: '阁楼传来铜铃的轻响', expect: { accept: true, type: 'tool' } },
      { name: '桃木剑', itemType: 'weapon', context: '墙角的桃木剑忽然裂开', expect: { accept: true, type: 'weapon' } },
      { name: '黄符', itemType: 'token', context: '那半张黄符', expect: { accept: true, type: 'token' } },
      { name: '符纸', itemType: 'token', context: '符纸已经湿透了', expect: { accept: true, type: 'token' } },
      { name: '三炷香', context: '点燃三炷香', expect: { accept: false, reason: '数量短语' } },
      { name: '半张黄符', context: '那半张黄符', expect: { accept: false, reason: '数量短语' } },
      { name: '铜钱', context: '将一枚刻满符文的铜钱', expect: { accept: false, reason: '抽象概念' } },
      { name: '白雾', context: '浮起一层白雾', expect: { accept: false, reason: '非实体' } },
      { name: '阁楼', context: '阁楼传来铜铃的轻响', expect: { accept: false, reason: '组织/地点' } },
      { name: '天井', context: '老宅的天井里', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'space-mecha-01',
    genre: '星际机甲',
    title: '曙光号出击',
    text: `第七舰队的旗舰「曙光号」驶出跃迁通道。
维修舱里，沈曜钻进三米高的猎隼机甲，检查右臂的等离子炮。
「反应堆只剩 40% 输出。」AI 冷静地播报。
他从工具台上取下一支纳米修复剂，又抓起一柄磁暴战斧。
舷窗外，敌方的无人机群像蝗虫一样压来。
沈曜扣紧头盔，把一枚备用能量核心塞进驾驶舱的卡槽。`,
    existingCharacters: ['沈曜'],
    candidates: [
      { name: '曙光号', context: '旗舰「曙光号」驶出跃迁通道', expect: { accept: true, type: 'vehicle' } },
      { name: '猎隼机甲', context: '钻进三米高的猎隼机甲', expect: { accept: true, type: 'vehicle' } },
      { name: '等离子炮', context: '检查右臂的等离子炮', expect: { accept: true, type: 'weapon' } },
      { name: '纳米修复剂', context: '一支纳米修复剂', expect: { accept: true, type: 'potion' } },
      { name: '磁暴战斧', context: '一柄磁暴战斧', expect: { accept: true, type: 'weapon' } },
      { name: '备用能量核心', itemType: 'tool', context: '一枚备用能量核心', expect: { accept: true, type: 'tool' } },
      { name: '头盔', itemType: 'armor', context: '沈曜扣紧头盔', expect: { accept: true, type: 'armor' } },
      { name: '40% 输出', context: '只剩 40% 输出', expect: { accept: false, reason: '数值/货币' } },
    ],
  },
  {
    id: 'three-kingdoms-01',
    genre: '历史三国',
    title: '下邳城外',
    text: `建安三年，下邳城外。
吕布横戟立马，赤兔马喷着白气。
「取我弓来！」他张弓搭箭，一箭射中辕门外的画戟小枝。
帐中，陈宫展开一卷竹简，眉头紧锁。
案上摆着一方传国玉玺，玺上缺了一角，用黄金补过。
亲兵捧来一柄青龙偃月刀，刀柄上还缠着旧布。`,
    existingCharacters: ['吕布', '陈宫'],
    existingLocations: ['下邳城', '辕门'],
    candidates: [
      { name: '赤兔马', context: '赤兔马喷着白气', expect: { accept: true, type: 'vehicle' } },
      { name: '画戟', context: '一箭射中辕门外的画戟小枝', expect: { accept: true, type: 'weapon' } },
      { name: '竹简', context: '展开一卷竹简', expect: { accept: true, type: 'scroll' } },
      { name: '传国玉玺', context: '一方传国玉玺', expect: { accept: true, type: 'token' } },
      { name: '青龙偃月刀', context: '一柄青龙偃月刀', expect: { accept: true, type: 'weapon' } },
      { name: '弓', context: '取我弓来', expect: { accept: false, reason: '名称过短' } },
      { name: '黄金', context: '用黄金补过', expect: { accept: false, reason: '抽象概念' } },
      { name: '建安三年', context: '建安三年，下邳城外', expect: { accept: false, reason: '时间短语' } },
      { name: '下邳城', context: '下邳城外', expect: { accept: false, reason: '组织/地点' } },
      { name: '辕门', context: '一箭射中辕门外', expect: { accept: false, reason: '组织/地点' } },
      { name: '吕布', context: '吕布横戟立马', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'campus-01',
    genre: '校园',
    title: '开学第一天',
    text: `九月，市一中开学第一天。
林小雨把新课本塞进书包，发现桌洞里躺着一支黑色钢笔。
「这是谁的？」她举起来问。
同桌周航头也不抬：「上周有人落下的，笔帽上刻着个『航』字。」
放学后，林小雨在校门口的文具店买了一本错题本和一盒荧光笔。
路过操场时，她看见单杠下压着一张皱巴巴的请假条。`,
    existingCharacters: ['林小雨', '周航'],
    existingLocations: ['市一中', '文具店', '操场'],
    candidates: [
      { name: '课本', itemType: 'book', context: '把新课本塞进书包', expect: { accept: true, type: 'book' } },
      { name: '书包', itemType: 'tool', context: '塞进书包', expect: { accept: true, type: 'tool' } },
      { name: '黑色钢笔', itemType: 'tool', context: '一支黑色钢笔', expect: { accept: true, type: 'tool' } },
      { name: '钢笔', itemType: 'tool', context: '一支黑色钢笔', expect: { accept: true, type: 'tool' } },
      { name: '错题本', itemType: 'book', context: '一本错题本', expect: { accept: true, type: 'book' } },
      { name: '荧光笔', itemType: 'tool', context: '一盒荧光笔', expect: { accept: true, type: 'tool' } },
      { name: '请假条', itemType: 'document', context: '压着一张皱巴巴的请假条', expect: { accept: true, type: 'document' } },
      { name: '九月', context: '九月，市一中开学第一天', expect: { accept: false, reason: '时间短语' } },
      { name: '一张皱巴巴的请假条', context: '压着一张皱巴巴的请假条', expect: { accept: false, reason: '数量短语' } },
      { name: '市一中', context: '九月，市一中开学第一天', expect: { accept: false, reason: '与角色/地点同名' } },
      { name: '文具店', context: '在校门口的文具店', expect: { accept: false, reason: '与角色/地点同名' } },
      { name: '操场', context: '路过操场时', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'republic-spy-01',
    genre: '民国谍战',
    title: '霞飞路接头',
    text: `霞飞路的咖啡馆里，留声机放着靡靡之音。
顾沉把一份密电码压在咖啡杯下，目光扫过窗外的黄包车。
「先生，您的报纸。」报童递来一份《申报》。
顾沉翻开报纸，夹层里掉出一张委任状，上面盖着军统的钢印。
他不动声色地收起委任状，又从大衣内袋摸出一支勃朗宁手枪。
邻桌的旗袍女人忽然起身，手袋里露出半截银色钥匙。`,
    existingCharacters: ['顾沉'],
    existingLocations: ['霞飞路', '咖啡馆'],
    candidates: [
      { name: '留声机', itemType: 'tool', context: '留声机放着靡靡之音', expect: { accept: true, type: 'tool' } },
      { name: '密电码', itemType: 'document', context: '一份密电码', expect: { accept: true, type: 'document' } },
      { name: '咖啡杯', itemType: 'tool', context: '压在咖啡杯下', expect: { accept: true, type: 'tool' } },
      { name: '黄包车', itemType: 'vehicle', context: '窗外的黄包车', expect: { accept: true, type: 'vehicle' } },
      { name: '报纸', itemType: 'document', context: '您的报纸', expect: { accept: true, type: 'document' } },
      { name: '申报', itemType: 'document', context: '递来一份《申报》', expect: { accept: true, type: 'document' } },
      { name: '委任状', itemType: 'document', context: '掉出一张委任状', expect: { accept: true, type: 'document' } },
      { name: '钢印', itemType: 'token', context: '军统的钢印', expect: { accept: true, type: 'token' } },
      { name: '勃朗宁手枪', itemType: 'weapon', context: '一支勃朗宁手枪', expect: { accept: true, type: 'weapon' } },
      { name: '旗袍', itemType: 'clothing', context: '邻桌的旗袍女人', expect: { accept: true, type: 'clothing' } },
      { name: '手袋', itemType: 'tool', context: '手袋里露出半截银色钥匙', expect: { accept: true, type: 'tool' } },
      { name: '银色钥匙', itemType: 'key', context: '半截银色钥匙', expect: { accept: true, type: 'key' } },
      { name: '靡靡之音', context: '留声机放着靡靡之音', expect: { accept: false, reason: '非实体' } },
      { name: '一份密电码', context: '把一份密电码', expect: { accept: false, reason: '数量短语' } },
      { name: '一支勃朗宁手枪', context: '摸出一支勃朗宁手枪', expect: { accept: false, reason: '数量短语' } },
      { name: '半截银色钥匙', context: '露出半截银色钥匙', expect: { accept: false, reason: '数量短语' } },
      { name: '咖啡馆', context: '霞飞路的咖啡馆里', expect: { accept: false, reason: '与角色/地点同名' } },
      { name: '霞飞路', context: '霞飞路的咖啡馆里', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'tomb-raider-01',
    genre: '盗墓探险',
    title: '墓道尽头',
    text: `洛阳铲带出的泥土还带着腥气。
老胡把黑驴蹄子塞进背包，又摸出一支狼眼手电。
「下面的东西不干净，都把摸金符戴上。」他压低声音。
墓道尽头的石门上刻着一只饕餮，门缝里渗着暗红的水。
小胖点燃一支火折子，火光映出墙上密密麻麻的壁画。
角落里摆着一口青铜棺椁，棺盖上压着一枚巴掌大的铜镜。`,
    existingCharacters: ['老胡', '小胖'],
    existingLocations: ['墓道'],
    candidates: [
      { name: '洛阳铲', itemType: 'tool', context: '洛阳铲带出的泥土', expect: { accept: true, type: 'tool' } },
      { name: '黑驴蹄子', itemType: 'prop', context: '把黑驴蹄子塞进背包', expect: { accept: true, type: 'prop' } },
      { name: '狼眼手电', itemType: 'tool', context: '又摸出一支狼眼手电', expect: { accept: true, type: 'tool' } },
      { name: '摸金符', itemType: 'token', context: '都把摸金符戴上', expect: { accept: true, type: 'token' } },
      { name: '火折子', itemType: 'tool', context: '点燃一支火折子', expect: { accept: true, type: 'tool' } },
      { name: '青铜棺椁', itemType: 'tool', context: '一口青铜棺椁', expect: { accept: true, type: 'tool' } },
      { name: '铜镜', itemType: 'tool', context: '巴掌大的铜镜', expect: { accept: true, type: 'tool' } },
      { name: '腥气', context: '泥土还带着腥气', expect: { accept: false, reason: '非实体' } },
      { name: '石门', context: '墓道尽头的石门', expect: { accept: false, reason: '组织/地点' } },
      { name: '暗红的水', context: '门缝里渗着暗红的水', expect: { accept: false, reason: '描述性短语' } },
      { name: '巴掌大的铜镜', context: '一枚巴掌大的铜镜', expect: { accept: false, reason: '描述性短语' } },
    ],
  },
  {
    id: 'urban-power-01',
    genre: '都市异能',
    title: '雨夜电话亭',
    text: `暴雨夜，江城的霓虹被雨水泡得发白。
苏黎躲进电话亭，掌心的纹路忽然亮起幽蓝的光。
「别用能力，会被『守夜人』发现。」耳机里传来搭档的声音。
她从口袋里摸出一枚刻着编号的黑色徽章，别在大衣内侧。
街对面的便利店亮着灯，货架上的罐装咖啡正在打折。
苏黎买了一罐咖啡，又顺手拿走柜台下那张旧报纸。`,
    existingCharacters: ['苏黎', '守夜人'],
    existingLocations: ['江城', '便利店'],
    candidates: [
      { name: '黑色徽章', itemType: 'token', context: '一枚刻着编号的黑色徽章', expect: { accept: true, type: 'token' } },
      { name: '大衣', itemType: 'clothing', context: '别在大衣内侧', expect: { accept: true, type: 'clothing' } },
      { name: '罐装咖啡', itemType: 'food', context: '货架上的罐装咖啡', expect: { accept: true, type: 'food' } },
      { name: '咖啡', itemType: 'food', context: '苏黎买了一罐咖啡', expect: { accept: true, type: 'food' } },
      { name: '旧报纸', itemType: 'document', context: '那张旧报纸', expect: { accept: true, type: 'document' } },
      { name: '幽蓝的光', context: '亮起幽蓝的光', expect: { accept: false, reason: '非实体' } },
      { name: '能力', context: '别用能力', expect: { accept: false, reason: '抽象概念' } },
      { name: '暴雨夜', context: '暴雨夜，江城的霓虹', expect: { accept: false, reason: '时间短语' } },
      { name: '一罐咖啡', context: '买了一罐咖啡', expect: { accept: false, reason: '数量短语' } },
      { name: '江城', context: '暴雨夜，江城的霓虹', expect: { accept: false, reason: '组织/地点' } },
      { name: '便利店', context: '街对面的便利店', expect: { accept: false, reason: '与角色/地点同名' } },
      { name: '守夜人', context: '会被『守夜人』发现', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'xianxia-sword-01',
    genre: '仙侠剑修',
    title: '剑冢问心',
    text: `剑冢之上，万剑齐鸣。
顾长歌盘坐于断崖，膝上横着一柄无名古剑。
「你的剑心已乱。」白发老者拂袖，袖中飞出一枚玉简。
玉简悬停半空，浮现出《太虚剑经》四个古篆。
顾长歌接过玉简，又从怀中取出一只青玉葫芦，仰头饮了一口灵酒。
山下，一队修士正御剑而来，为首者腰间悬着一枚玄铁剑令。`,
    existingCharacters: ['顾长歌'],
    existingLocations: ['剑冢', '断崖'],
    candidates: [
      { name: '无名古剑', itemType: 'weapon', context: '一柄无名古剑', expect: { accept: true, type: 'weapon' } },
      { name: '玉简', itemType: 'scroll', context: '袖中飞出一枚玉简', expect: { accept: true, type: 'scroll' } },
      { name: '太虚剑经', itemType: 'scroll', context: '浮现出《太虚剑经》', expect: { accept: true, type: 'scroll' } },
      { name: '青玉葫芦', itemType: 'artifact', context: '一只青玉葫芦', expect: { accept: true, type: 'artifact' } },
      { name: '灵酒', itemType: 'food', context: '饮了一口灵酒', expect: { accept: true, type: 'food' } },
      { name: '玄铁剑令', itemType: 'token', context: '一枚玄铁剑令', expect: { accept: true, type: 'token' } },
      { name: '剑心', context: '你的剑心已乱', expect: { accept: false, reason: '抽象概念' } },
      { name: '一枚玉简', context: '袖中飞出一枚玉简', expect: { accept: false, reason: '数量短语' } },
      { name: '一柄无名古剑', context: '膝上横着一柄无名古剑', expect: { accept: false, reason: '数量短语' } },
      { name: '剑冢', context: '剑冢之上', expect: { accept: false, reason: '组织/地点' } },
    ],
  },
  {
    id: 'steampunk-01',
    genre: '蒸汽朋克',
    title: '齿轮城的钟声',
    text: `齿轮城的钟楼敲了十三下。
艾萨克拧紧怀表的发条，黄铜外壳上刻着一圈细密的符文。
「蒸汽压力不足了。」他踢了踢脚边的压力阀，抓起一把黄铜扳手。
工作室的架子上摆着一只玻璃压力计和一罐黑色火药。
窗外，一辆履带式蒸汽战车碾过石板路，烟囱喷出滚滚白烟。
艾萨克戴上护目镜，把一枚铜制齿轮塞进机械臂的接口。`,
    existingCharacters: ['艾萨克'],
    existingLocations: ['齿轮城', '工作室'],
    candidates: [
      { name: '怀表', itemType: 'tool', context: '拧紧怀表的发条', expect: { accept: true, type: 'tool' } },
      { name: '压力阀', itemType: 'tool', context: '踢了踢脚边的压力阀', expect: { accept: true, type: 'tool' } },
      { name: '黄铜扳手', itemType: 'tool', context: '抓起一把黄铜扳手', expect: { accept: true, type: 'tool' } },
      { name: '玻璃压力计', itemType: 'tool', context: '一只玻璃压力计', expect: { accept: true, type: 'tool' } },
      { name: '黑色火药', itemType: 'prop', context: '一罐黑色火药', expect: { accept: true, type: 'prop' } },
      { name: '履带式蒸汽战车', itemType: 'vehicle', context: '一辆履带式蒸汽战车', expect: { accept: true, type: 'vehicle' } },
      { name: '护目镜', itemType: 'armor', context: '艾萨克戴上护目镜', expect: { accept: true, type: 'armor' } },
      { name: '铜制齿轮', itemType: 'tool', context: '一枚铜制齿轮', expect: { accept: true, type: 'tool' } },
      { name: '白烟', context: '烟囱喷出滚滚白烟', expect: { accept: false, reason: '非实体' } },
      { name: '钟楼', context: '齿轮城的钟楼', expect: { accept: false, reason: '组织/地点' } },
      { name: '一罐黑色火药', context: '一罐黑色火药', expect: { accept: false, reason: '数量短语' } },
      { name: '一枚铜制齿轮', context: '一枚铜制齿轮', expect: { accept: false, reason: '数量短语' } },
    ],
  },
  {
    id: 'isekai-01',
    genre: '异世界轻小说',
    title: '公会委托',
    text: `勇者公会的告示板前挤满了人。
「讨伐哥布林，报酬三十枚银币。」莉娜踮起脚，念出委托单上的字。
她检查了一遍装备：一把短剑、一面木盾，还有三瓶初级回复药。
「别忘了带火把。」同伴艾伦递来一支火把和一包干粮。
公会长从柜台下取出一枚铜质冒险者徽章，压在登记簿上。
门外，一辆马车正等着载他们去边境村。`,
    existingCharacters: ['莉娜', '艾伦'],
    existingLocations: ['边境村'],
    candidates: [
      { name: '委托单', itemType: 'document', context: '念出委托单上的字', expect: { accept: true, type: 'document' } },
      { name: '短剑', itemType: 'weapon', context: '一把短剑', expect: { accept: true, type: 'weapon' } },
      { name: '木盾', itemType: 'armor', context: '一面木盾', expect: { accept: true, type: 'armor' } },
      { name: '初级回复药', itemType: 'potion', context: '三瓶初级回复药', expect: { accept: true, type: 'potion' } },
      { name: '火把', itemType: 'tool', context: '递来一支火把', expect: { accept: true, type: 'tool' } },
      { name: '干粮', itemType: 'food', context: '一包干粮', expect: { accept: true, type: 'food' } },
      { name: '铜质冒险者徽章', itemType: 'token', context: '一枚铜质冒险者徽章', expect: { accept: true, type: 'token' } },
      { name: '登记簿', itemType: 'book', context: '压在登记簿上', expect: { accept: true, type: 'book' } },
      { name: '马车', itemType: 'vehicle', context: '一辆马车', expect: { accept: true, type: 'vehicle' } },
      { name: '三十枚银币', context: '报酬三十枚银币', expect: { accept: false, reason: '数量短语' } },
      { name: '三瓶初级回复药', context: '三瓶初级回复药', expect: { accept: false, reason: '数量短语' } },
      { name: '一包干粮', context: '一包干粮', expect: { accept: false, reason: '数量短语' } },
      { name: '勇者公会', context: '勇者公会的告示板', expect: { accept: false, reason: '组织/地点' } },
      { name: '边境村', context: '去边境村', expect: { accept: false, reason: '组织/地点' } },
    ],
  },
  {
    id: 'noble-house-01',
    genre: '侯门宅斗',
    title: '西院妆台',
    text: `侯府西院，炭盆里的银霜炭烧得正旺。
沈知微坐在妆台前，由丫鬟替她插上一支赤金点翠钗。
「夫人赏的。」丫鬟又把一只描金漆盒放在桌上，盒里躺着一对羊脂玉镯。
沈知微指尖一顿，想起母亲临终前塞给她的那支旧银簪。
门外传来脚步声，管事嬷嬷捧着一卷账簿，脸色不太好看。
她垂下眼，把袖中那张药方又往里藏了藏。`,
    existingCharacters: ['沈知微'],
    existingLocations: ['侯府', '西院'],
    candidates: [
      { name: '赤金点翠钗', itemType: 'clothing', context: '一支赤金点翠钗', expect: { accept: true, type: 'clothing' } },
      { name: '描金漆盒', itemType: 'tool', context: '一只描金漆盒', expect: { accept: true, type: 'tool' } },
      { name: '羊脂玉镯', itemType: 'clothing', context: '一对羊脂玉镯', expect: { accept: true, type: 'clothing' } },
      { name: '旧银簪', itemType: 'clothing', context: '那支旧银簪', expect: { accept: true, type: 'clothing' } },
      { name: '账簿', itemType: 'book', context: '捧着一卷账簿', expect: { accept: true, type: 'book' } },
      { name: '药方', itemType: 'document', context: '那张药方', expect: { accept: true, type: 'document' } },
      { name: '炭盆', itemType: 'tool', context: '炭盆里的银霜炭', expect: { accept: true, type: 'tool' } },
      { name: '脚步声', context: '门外传来脚步声', expect: { accept: false, reason: '非实体' } },
      { name: '一对羊脂玉镯', context: '一对羊脂玉镯', expect: { accept: false, reason: '数量短语' } },
      { name: '一张药方', context: '那张药方', expect: { accept: false, reason: '数量短语' } },
      { name: '侯府', context: '侯府西院', expect: { accept: false, reason: '组织/地点' } },
      { name: '西院', context: '侯府西院', expect: { accept: false, reason: '组织/地点' } },
    ],
  },
  {
    id: 'war-01',
    genre: '军事战争',
    title: '三号高地',
    text: `凌晨四点，三号高地。
狙击手陈锋趴在战壕里，把一枚穿甲弹压进弹仓。
「敌方装甲车距离八百米。」观察员举着测距仪低声报告。
陈锋调整瞄准镜，扣下扳机。枪声撕裂山谷。
阵地上，一门迫击炮缓缓转向，炮手们正在搬运弹药箱。
无线电里传来指挥部的命令：「坚守到天亮，等待增援。」
陈锋摸了摸胸口的身份牌，又检查了一遍急救包。`,
    existingCharacters: ['陈锋'],
    existingLocations: ['三号高地', '山谷'],
    candidates: [
      { name: '穿甲弹', itemType: 'weapon', context: '一枚穿甲弹', expect: { accept: true, type: 'weapon' } },
      { name: '装甲车', itemType: 'vehicle', context: '敌方装甲车', expect: { accept: true, type: 'vehicle' } },
      { name: '测距仪', itemType: 'tool', context: '举着测距仪', expect: { accept: true, type: 'tool' } },
      { name: '瞄准镜', itemType: 'tool', context: '调整瞄准镜', expect: { accept: true, type: 'tool' } },
      { name: '迫击炮', itemType: 'weapon', context: '一门迫击炮', expect: { accept: true, type: 'weapon' } },
      { name: '弹药箱', itemType: 'tool', context: '搬运弹药箱', expect: { accept: true, type: 'tool' } },
      { name: '无线电', itemType: 'tool', context: '无线电里传来指挥部的命令', expect: { accept: true, type: 'tool' } },
      { name: '身份牌', itemType: 'token', context: '摸了摸胸口的身份牌', expect: { accept: true, type: 'token' } },
      { name: '急救包', itemType: 'tool', context: '检查了一遍急救包', expect: { accept: true, type: 'tool' } },
      { name: '枪声', context: '枪声撕裂山谷', expect: { accept: false, reason: '非实体' } },
      { name: '一枚穿甲弹', context: '把一枚穿甲弹压进弹仓', expect: { accept: false, reason: '数量短语' } },
      { name: '一门迫击炮', context: '一门迫击炮', expect: { accept: false, reason: '数量短语' } },
      { name: '指挥部', context: '无线电里传来指挥部的命令', expect: { accept: false, reason: '组织/地点' } },
      { name: '三号高地', context: '凌晨四点，三号高地', expect: { accept: false, reason: '与角色/地点同名' } },
      { name: '山谷', context: '枪声撕裂山谷', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
  {
    id: 'food-01',
    genre: '美食',
    title: '老巷牛肉面',
    text: `城南的老巷里，一碗牛肉面卖十二块钱。
老板周叔掀开锅盖，白汽裹着香气涌出来。
他抓起一把手工挂面下锅，又往碗里舀了一勺秘制高汤。
案板上摆着刚切好的卤牛肉和一小碟油泼辣子。
「多加香菜。」穿校服的女孩把零钱拍在柜台上。
周叔笑着应了一声，从坛子里夹出一枚卤蛋。`,
    existingCharacters: ['周叔'],
    existingLocations: ['老巷'],
    candidates: [
      { name: '牛肉面', itemType: 'food', context: '一碗牛肉面', expect: { accept: true, type: 'food' } },
      { name: '手工挂面', itemType: 'food', context: '一把手工挂面', expect: { accept: true, type: 'food' } },
      { name: '秘制高汤', itemType: 'food', context: '一勺秘制高汤', expect: { accept: true, type: 'food' } },
      { name: '卤牛肉', itemType: 'food', context: '刚切好的卤牛肉', expect: { accept: true, type: 'food' } },
      { name: '油泼辣子', itemType: 'food', context: '一小碟油泼辣子', expect: { accept: true, type: 'food' } },
      { name: '香菜', itemType: 'plant', context: '多加香菜', expect: { accept: true, type: 'plant' } },
      { name: '卤蛋', itemType: 'food', context: '一枚卤蛋', expect: { accept: true, type: 'food' } },
      { name: '零钱', context: '把零钱拍在柜台上', expect: { accept: false, reason: '抽象概念' } },
      { name: '白汽', context: '白汽裹着香气涌出来', expect: { accept: false, reason: '非实体' } },
      { name: '香气', context: '白汽裹着香气涌出来', expect: { accept: false, reason: '非实体' } },
      { name: '十二块钱', context: '一碗牛肉面卖十二块钱', expect: { accept: false, reason: '数值/货币' } },
      { name: '一碗牛肉面', context: '一碗牛肉面', expect: { accept: false, reason: '数量短语' } },
      { name: '一把手工挂面', context: '抓起一把手工挂面', expect: { accept: false, reason: '数量短语' } },
      { name: '一勺秘制高汤', context: '舀了一勺秘制高汤', expect: { accept: false, reason: '数量短语' } },
      { name: '一小碟油泼辣子', context: '一小碟油泼辣子', expect: { accept: false, reason: '数量短语' } },
      { name: '一枚卤蛋', context: '夹出一枚卤蛋', expect: { accept: false, reason: '数量短语' } },
    ],
  },
  {
    id: 'ghost-stream-01',
    genre: '灵异直播',
    title: '午夜探废院',
    text: `午夜十二点，主播阿凯把手机架在三脚架上，打开了直播。
「家人们，今天探废弃精神病院。」他压低声音，举起一支强光手电。
弹幕刷过屏幕：「主播身后有人！」
阿凯回头，走廊尽头只有一辆锈迹斑斑的轮椅。
他摸出兜里的护身符，又把一串铜钱系在手腕上。
直播间的人数忽然跳到零，信号格也只剩一格。`,
    existingCharacters: ['阿凯'],
    existingLocations: ['精神病院', '走廊'],
    candidates: [
      { name: '手机', itemType: 'tool', context: '把手机架在三脚架上', expect: { accept: true, type: 'tool' } },
      { name: '三脚架', itemType: 'tool', context: '把手机架在三脚架上', expect: { accept: true, type: 'tool' } },
      { name: '强光手电', itemType: 'tool', context: '举起一支强光手电', expect: { accept: true, type: 'tool' } },
      { name: '轮椅', itemType: 'vehicle', context: '一辆锈迹斑斑的轮椅', expect: { accept: true, type: 'vehicle' } },
      { name: '护身符', itemType: 'token', context: '摸出兜里的护身符', expect: { accept: true, type: 'token' } },
      { name: '铜钱', context: '一串铜钱', expect: { accept: false, reason: '抽象概念' } },
      { name: '一串铜钱', context: '把一串铜钱系在手腕上', expect: { accept: false, reason: '数量短语' } },
      { name: '弹幕', context: '弹幕刷过屏幕', expect: { accept: false, reason: '系统界面元素' } },
      { name: '屏幕', context: '弹幕刷过屏幕', expect: { accept: false, reason: '系统界面元素' } },
      { name: '直播间', context: '直播间的人数忽然跳到零', expect: { accept: false, reason: '系统界面元素' } },
      { name: '信号格', context: '信号格也只剩一格', expect: { accept: false, reason: '系统界面元素' } },
      { name: '精神病院', context: '今天探废弃精神病院', expect: { accept: false, reason: '组织/地点' } },
      { name: '午夜十二点', context: '午夜十二点，主播阿凯', expect: { accept: false, reason: '时间短语' } },
    ],
  },
  {
    id: 'cyberpunk-01',
    genre: '赛博朋克',
    title: '霓虹雨',
    text: `霓虹雨落在义体店的招牌上。
凯蹲在后巷，用一把热熔刀撬开义眼的后盖。
「这枚神经芯片还能卖两千信用点。」中间人叼着烟说。
凯把芯片塞进防静电袋，又检查了一遍腕上的植入式终端。
街口的全息广告牌正循环播放「义体狂欢节」。
他拉低兜帽，避开巡逻的无人机，钻进了地铁通风井。`,
    existingCharacters: ['凯'],
    existingLocations: ['义体店', '后巷', '地铁通风井'],
    candidates: [
      { name: '热熔刀', itemType: 'weapon', context: '用一把热熔刀', expect: { accept: true, type: 'weapon' } },
      { name: '义眼', itemType: 'tool', context: '撬开义眼的后盖', expect: { accept: true, type: 'tool' } },
      { name: '神经芯片', itemType: 'tool', context: '这枚神经芯片', expect: { accept: true, type: 'tool' } },
      { name: '防静电袋', itemType: 'tool', context: '塞进防静电袋', expect: { accept: true, type: 'tool' } },
      { name: '植入式终端', itemType: 'tool', context: '腕上的植入式终端', expect: { accept: true, type: 'tool' } },
      { name: '兜帽', itemType: 'clothing', context: '他拉低兜帽', expect: { accept: true, type: 'clothing' } },
      { name: '无人机', itemType: 'vehicle', context: '避开巡逻的无人机', expect: { accept: true, type: 'vehicle' } },
      { name: '信用点', context: '两千信用点', expect: { accept: false, reason: '抽象概念' } },
      { name: '两千信用点', context: '还能卖两千信用点', expect: { accept: false, reason: '数值/货币' } },
      { name: '全息广告牌', context: '街口的全息广告牌', expect: { accept: false, reason: '系统界面元素' } },
      { name: '一枚神经芯片', context: '这枚神经芯片', expect: { accept: false, reason: '数量短语' } },
      { name: '一把热熔刀', context: '用一把热熔刀', expect: { accept: false, reason: '数量短语' } },
      { name: '后巷', context: '凯蹲在后巷', expect: { accept: false, reason: '组织/地点' } },
      { name: '义体店', context: '落在义体店的招牌上', expect: { accept: false, reason: '与角色/地点同名' } },
      { name: '地铁通风井', context: '钻进了地铁通风井', expect: { accept: false, reason: '与角色/地点同名' } },
    ],
  },
];
