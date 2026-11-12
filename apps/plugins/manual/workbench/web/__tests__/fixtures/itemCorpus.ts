// ============================================================
// 大规模物品语料生成器（确定性，无外部依赖）
//
// 目标：不把几十万行 fixture 塞进仓库，也能稳定生成
//   10,000 个互不相同的真物品
//   10,000 条各类型误识别
// 用来压测 validateItemCandidate 的接受率、类型判断和拒绝原因。
//
// 命名规则：
//   正样本 = 安全前缀 (+ 安全中缀) + 类型签名后缀
//   负样本 = 各条拒绝规则的模板化组合
// 固定种子洗牌，测试可重复。
// ============================================================

export interface PositiveItem {
  name: string;
  type: string;
  /** true = 不提供 itemType，依赖名称后缀推断 */
  inference: boolean;
}

export interface NegativeItem {
  name: string;
  reason: string;
}

export interface ItemCorpus {
  positives: PositiveItem[];
  negatives: NegativeItem[];
  /** 「与角色/地点同名」负样本对应的已有实体名 */
  collisionNames: string[];
  totals: {
    positives: number;
    negatives: number;
    types: number;
    byReason: Record<string, number>;
  };
}

/** 这些字不会作为数词/代词/句首标点，也不会拼出 UI 词 */
const PREFIXES = '玄青赤紫金寒烈幽碧苍流星月云风雷霜血玉龙凤虎豹银铁黑白丹灵神鬼天地山河海江林花雪雨雾木土光暗影夜晨暮秋春夏南北东西长短轻重破古新老小大'.split('');
const MIDDLES = '锋影魂心骨云月星风雷霜雪雨露电光暗夜晨古玄灵神魔妖鬼仙佛龙凤虎狼鹰蛇龟鹤松竹梅兰菊莲荷桃李'.split('');

/** "type:s1,s2,..." 每行一组，解析成 [type, suffixes] */
function parseGroups(src: string): Array<[string, string[]]> {
  return src
    .trim()
    .split('\n')
    .map((line) => {
      const [type, rest] = line.split(':');
      return [type.trim(), rest.split(',').map((s) => s.trim())] as [string, string[]];
    });
}

/** 显式类型签名：可含单字后缀，类型由 AI itemType 决定 */
const EXPLICIT_SIGNATURES = parseGroups(`
weapon:剑,刀,枪,炮,弓,锤,戟,鞭,弩,匕首,长矛,暗器,飞刀,手雷,炸弹
armor:甲,盔,盾,盾牌,软甲,铠甲,护腕
clothing:袍,衣,裙,衫,冠,服,靴,鞋,披风,斗篷,手镯,项链,玉佩,戒指,吊坠,手套,玉镯
potion:丹,丸,散,膏,药水,丹药,药剂
medicine:药,灵药,草药
scroll:经,诀,谱,秘籍,卷轴,玉简,竹简,秘典
book:书,册,典,录,本,簿,古籍,书册
document:图,信,诏,契,文书,地图,藏宝图,羊皮纸,诏书,圣旨,状,委任状
token:令,符,印,牌,令牌,信物,虎符,玉玺,腰牌,徽章
gem:珠,玉,宝石,晶石,晶
vehicle:车,船,舟,马,轿,飞剑,机甲,轮椅,无人机
tool:灯,镜,盒,箱,袋,壶,杯,盏,罗盘,伞,扇,炉,钟,铃,铲,表,阀,计,轮,盆,架,仪,扳手,火把,火折子,终端,芯片,无线电
artifact:塔,幡,鼎,葫芦,符箓,阵盘
treasure:金条
plant:草,花,树,藤,莲,参,芝,果,菜,灵草,灵果,灵芝
food:饭,面,酒,茶,糕,饼,糖,粮,汤,肉,蛋,辣子,面包,干粮,高汤,牛肉,卤蛋
animal:兽,鸟,虫,鱼,蛇,狐,狼,虎,鹿,鹰,鹤,猿,熊,灵兽,妖兽,仙鹤,雪狼,黑虎
key:钥匙
prop:玉佩,铜铃,木盒
other:之物
`);

/** 推断类型签名：必须是最长后缀，不会被复合词抢先 */
const INFERENCE_SIGNATURES = parseGroups(`
weapon:匕首,长矛,暗器,飞刀,手雷,炸弹
armor:软甲,铠甲,盾牌,护腕
clothing:披风,斗篷,手镯,项链,玉佩,戒指,吊坠,手套
potion:药水,丹药,药剂,药液
medicine:灵药,草药
scroll:秘籍,卷轴,玉简,竹简,秘典
book:古籍,书册,典籍
document:文书,地图,藏宝图,羊皮纸,诏书,圣旨
token:令牌,信物,虎符,玉玺,徽章
gem:宝石,晶石
vehicle:飞剑,飞舟,机甲,轮椅,无人机
tool:罗盘,丹炉,剑鞘,手电,电池,扳手,火把,芯片
artifact:符箓,阵盘,葫芦
treasure:金条
plant:灵草,灵果,灵芝,人参
food:面包,干粮,高汤,牛肉,卤蛋,灵酒
animal:灵兽,妖兽,仙鹤,雪狼,黑虎
key:钥匙
`);

const ALL_SUFFIXES = Array.from(
  new Set(
    [...EXPLICIT_SIGNATURES, ...INFERENCE_SIGNATURES].flatMap(([, suffixes]) => suffixes),
  ),
);

const NUM_UNITS = ['积分', '金币', '银两', '灵石', '元宝', '钻石', '铜钱', '信用点', '块钱', '元', '经验', '属性点', '攻击力', '声望', '体力'];
const QTY_UNITS = ['个', '枚', '把', '块', '瓶', '袋', '张', '只', '条', '支', '颗', '面', '卷', '本', '套', '双', '对', '份', '罐', '包', '碗', '勺', '碟', '串', '门', '盒'];
const QTY_NOUNS = ['青锋剑', '玉佩', '丹药', '妖兽', '灵石', '木盒', '铜铃', '古镜'];
const ORG_SUFFIXES = ['宗', '门', '派', '帮', '会', '阁', '殿', '寺', '观', '堂', '宫', '楼', '城', '府', '院', '部', '巷', '村', '峰', '洞'];
// 注意：不含「炷香」——它在实现里先命中数量短语（炷是量词），原因不会是时间短语
const TIME_UNITS = ['年', '月', '日', '天', '时辰', '更', '刻', '息', '日后', '天后', '月后', '年后', '时辰后', '夜'];
const PHENOMENA = ['声', '音', '光', '雾', '腥气', '香气', '白烟', '白汽', '火光', '炉火', '寒气', '杀气'];
const UI_WORDS = ['系统面板', '属性面板', '任务面板', '系统提示', '对话框', '背包界面', '状态栏', '商城', '弹幕', '屏幕', '广告牌', '直播间', '信号格'];
const GAME_WORDS = ['副本', '排行榜', '公告', '签到', '抽奖', '血条', '蓝条', '经验条'];
const TECHNIQUE_WORDS = ['心法', '身法', '剑法', '刀法', '拳法', '掌法', '腿法', '法术', '秘术', '神通', '剑招', '刀招', '招式', '阵法', '符术', '咒术'];
const TRACE_WORDS = ['指纹', '脚印', '足迹', '血迹', '毛发', '唾液', '痕迹', '监控录像', '录像'];
const DESCRIPTIVE_NOUNS = ['玉佩', '铜铃', '木盒', '古镜', '铁箱', '旧伞', '折扇', '玉杯', '银壶', '铜锁'];
const SHORT_CHARS = '剑刀枪炮弓锤刃戟鞭弩弹甲盔盾袍衣裙衫冠靴鞋袜丹丸散膏药经诀谱书册典录本簿图信诏契令符印牌珠玉车船舟马轿灯镜盒箱袋壶杯盏伞扇炉钟铃铲塔幡鼎草花树藤莲参芝果饭菜酒茶糕饼糖兽鸟虫鱼蛇狐狼虎鹿鹰鹤猿熊钥匙'.split('');
const SURNAMES = '沈顾林苏江陆叶萧楚燕谢裴崔柳温霍秦唐宋韩'.split('');
const GIVEN_NAMES = ['青岚', '归尘', '长歌', '知微', '孤鸿', '流萤', '疏影', '听雪', '望舒', '南星', '北辰', '东篱', '西洲', '白露', '清和', '惊鸿', '云归', '风眠', '雪见', '寒舟'];
const ABSTRACT_WORDS = [
  '积分', '经验', '等级', '属性', '任务', '奖励', '系统', '金币', '银两', '灵石',
  '元宝', '钻石', '铜钱', '声望', '体力', '生命', '法力', '魅力', '好感', '幸运',
  '悟性', '根骨', '灵根', '修为', '境界', '攻击力', '防御力', '战斗力', '生命值', '法力值',
  '丹田', '气运', '机缘', '因果', '功德', '香火', '信仰', '恐惧', '愤怒', '回忆',
  '记忆', '梦境', '粮草', '军饷', '输出', '功率', '力量', '速度', '敏捷', '智力',
  '精神', '零钱', '信用点', '能力', '技能', '超能力', '剑心', '道心', '佛心', '魔心',
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(input: T[], rand: () => number): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

const DIGITS = '零一二三四五六七八九'.split('');

function cnNumeral(n: number): string {
  if (n <= 0) return '零';
  if (n < 10) return DIGITS[n] as string;
  if (n === 10) return '十';
  if (n < 20) return `十${DIGITS[n % 10]}`;
  if (n < 100) return `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ''}`;
  if (n < 1000) return `${DIGITS[Math.floor(n / 100)]}百${n % 100 ? cnNumeral(n % 100) : ''}`;
  if (n < 10000) return `${DIGITS[Math.floor(n / 1000)]}千${n % 1000 ? cnNumeral(n % 1000) : ''}`;
  return String(n);
}

/** 名称结尾是否被更长的类型后缀覆盖（会让推断偏离目标类型） */
function hasLongerConflictingSuffix(name: string, signature: string): boolean {
  return ALL_SUFFIXES.some(
    (suffix) => suffix.length > signature.length && name.endsWith(suffix),
  );
}

export function generateItemCorpus(positiveTarget = 10000, negativeTarget = 10000): ItemCorpus {
  const rand = mulberry32(20261107);
  const taken = new Set<string>();

  // ---- 正样本：显式类型 5,000 条 ----
  const explicitPool: PositiveItem[] = [];
  const seenExplicit = new Set<string>();
  for (const [type, signatures] of EXPLICIT_SIGNATURES) {
    for (const p of PREFIXES) {
      for (const m of MIDDLES) {
        for (const s of signatures) {
          const name = `${p}${m}${s}`;
          if (name.length < 3 || name.length > 12) continue;
          if (seenExplicit.has(name)) continue;
          seenExplicit.add(name);
          explicitPool.push({ name, type, inference: false });
        }
      }
    }
  }
  const explicit = shuffle(explicitPool, rand).slice(0, Math.ceil(positiveTarget / 2));
  for (const item of explicit) taken.add(item.name);

  // ---- 正样本：后缀推断 5,000 条 ----
  const inferencePool: PositiveItem[] = [];
  const seenInference = new Set<string>();
  for (const [type, signatures] of INFERENCE_SIGNATURES) {
    for (const p of PREFIXES) {
      for (const s of signatures) {
        const name = `${p}${s}`;
        if (taken.has(name) || seenInference.has(name)) continue;
        if (hasLongerConflictingSuffix(name, s)) continue;
        seenInference.add(name);
        inferencePool.push({ name, type, inference: true });
      }
    }
  }
  const needInference = positiveTarget - explicit.length;
  let inference = shuffle(inferencePool, rand).slice(0, needInference);
  if (inference.length < needInference) {
    const extra: PositiveItem[] = [];
    const seenExtra = new Set<string>();
    for (const [type, signatures] of INFERENCE_SIGNATURES) {
      for (const p of PREFIXES) {
        for (const m of MIDDLES) {
          for (const s of signatures) {
            const name = `${p}${m}${s}`;
            if (taken.has(name) || seenExtra.has(name)) continue;
            if (hasLongerConflictingSuffix(name, s)) continue;
            seenExtra.add(name);
            extra.push({ name, type, inference: true });
          }
        }
      }
    }
    inference = inference.concat(
      shuffle(extra, rand).slice(0, needInference - inference.length),
    );
  }
  for (const item of inference) taken.add(item.name);

  const positives = shuffle([...explicit, ...inference], rand);

  // ---- 负样本 ----
  const negatives: NegativeItem[] = [];
  const addNegative = (name: string, reason: string) => {
    if (!name || taken.has(name) || negatives.length >= negativeTarget) return;
    taken.add(name);
    negatives.push({ name, reason });
  };
  const fill = (target: number, reason: string, make: (i: number) => string) => {
    let i = 0;
    let made = 0;
    while (made < target && i < 100000 && negatives.length < negativeTarget) {
      const before = negatives.length;
      addNegative(make(i), reason);
      if (negatives.length > before) made++;
      i++;
    }
  };

  fill(3000, '数值/货币', (i) => `${cnNumeral(i + 1)}${NUM_UNITS[i % NUM_UNITS.length]}`);
  fill(3000, '数量短语', (i) => {
    const unit = QTY_UNITS[i % QTY_UNITS.length];
    const noun = QTY_NOUNS[Math.floor(i / QTY_UNITS.length) % QTY_NOUNS.length];
    return `${cnNumeral(i + 1)}${unit}${noun}`;
  });
  fill(1000, '组织/地点', (i) => {
    const s = ORG_SUFFIXES[i % ORG_SUFFIXES.length];
    const m = MIDDLES[Math.floor(i / ORG_SUFFIXES.length) % MIDDLES.length];
    const p = PREFIXES[Math.floor(i / (ORG_SUFFIXES.length * MIDDLES.length)) % PREFIXES.length];
    return `${p}${m}${s}`;
  });
  fill(500, '时间短语', (i) => `${cnNumeral(i + 1)}${TIME_UNITS[i % TIME_UNITS.length]}`);
  fill(500, '非实体', (i) => {
    const phenomenon = PHENOMENA[i % PHENOMENA.length];
    const m = MIDDLES[Math.floor(i / PHENOMENA.length) % MIDDLES.length];
    const p = PREFIXES[Math.floor(i / (PHENOMENA.length * MIDDLES.length)) % PREFIXES.length];
    return `${p}${m}${phenomenon}`;
  });
  fill(300, '系统界面元素', (i) => `${PREFIXES[i % PREFIXES.length]}${UI_WORDS[i % UI_WORDS.length]}`);
  for (const word of ABSTRACT_WORDS) addNegative(word, '抽象概念');
  fill(200, '系统玩法', (i) => `${PREFIXES[i % PREFIXES.length]}${GAME_WORDS[i % GAME_WORDS.length]}`);
  fill(300, '功法招式', (i) => `${PREFIXES[i % PREFIXES.length]}${TECHNIQUE_WORDS[i % TECHNIQUE_WORDS.length]}`);
  fill(200, '痕迹/证据', (i) => `${PREFIXES[i % PREFIXES.length]}${TRACE_WORDS[i % TRACE_WORDS.length]}`);
  fill(500, '描述性短语', (i) => `${PREFIXES[i % PREFIXES.length]}的${DESCRIPTIVE_NOUNS[i % DESCRIPTIVE_NOUNS.length]}`);
  for (const ch of SHORT_CHARS) addNegative(ch, '名称过短');

  const collisionStart = negatives.length;
  fill(350, '与角色/地点同名', (i) => {
    const given = GIVEN_NAMES[Math.floor(i / SURNAMES.length) % GIVEN_NAMES.length];
    return `${SURNAMES[i % SURNAMES.length]}${given}`;
  });
  const collisionNames = negatives.slice(collisionStart).map((n) => n.name);

  // 补齐到精确条数
  let n = 5000;
  while (negatives.length < negativeTarget) {
    addNegative(`${cnNumeral(n)}${NUM_UNITS[n % NUM_UNITS.length]}`, '数值/货币');
    n++;
  }
  negatives.splice(negativeTarget);

  const byReason: Record<string, number> = {};
  for (const item of negatives) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;

  return {
    positives,
    negatives,
    collisionNames,
    totals: {
      positives: positives.length,
      negatives: negatives.length,
      types: new Set(positives.map((p) => p.type)).size,
      byReason,
    },
  };
}
