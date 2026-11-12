// ============================================================
// 地点识别后处理回归
//
// 重点锁定实测误识别：
//   · 「远处」「身后」「楼下」「城隍庙东侧」等相对方位
//   · 「清晨」「雨夜」「三更」等时间/天气
//   · 「婚礼」「战争」「农民起义」等事件/活动
//   · 「青云帮」「江湖门派」等组织/团体
//   · 「黑衣守卫」「守夜人」等人物/群体
//   · 「那个山洞」「他们的营地」等指代短语
//   · 「一座城」「两条街」等数量短语
//   · 「沈家的院子」等描述性短语
//   · 角色名/物品名被当成地点
//   · 原文里根本没出现的脑补地名
// 以及名称归一化、方位前缀变体合并、章节补全、描述补全。
// ============================================================

import { describe, expect, it } from 'vitest';
import type { Location } from '@novel/shared';
import {
  applyLocationCandidate,
  isLikelyNonPlaceName,
  locationDescription,
  locationNameKey,
  normalizeLocationName,
  prepareLocationContext,
  validateLocationCandidate,
} from '../knowledge/locationRecognition';
import { pickScanChapters } from '../knowledge/recognizeLocations';

function makeLocation(over: Partial<Location> = {}): Location {
  return {
    id: 'l1',
    projectId: 'p1',
    name: '旧货市场',
    states: [],
    chapters: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('normalizeLocationName / locationNameKey', () => {
  it('去列表序号、书名号、首尾引号与多余空白', () => {
    expect(normalizeLocationName('「城隍庙」')).toBe('城隍庙');
    expect(normalizeLocationName('1. 城隍庙')).toBe('城隍庙');
    expect(normalizeLocationName('  《城南旧货市场》  ')).toBe('城南旧货市场');
    expect(normalizeLocationName('城隍  庙')).toBe('城隍 庙');
    expect(locationNameKey('「城隍  庙」')).toBe('城隍庙');
  });

  it('剥动作/介词前缀与关系方位后缀', () => {
    expect(normalizeLocationName('在废弃工厂')).toBe('废弃工厂');
    expect(normalizeLocationName('前往城隍庙')).toBe('城隍庙');
    expect(normalizeLocationName('城隍庙附近')).toBe('城隍庙');
    expect(normalizeLocationName('废舍门口')).toBe('废舍');
    // 2026-11 新增：东/西/南/北 + 边/侧/面、左右、边上
    expect(normalizeLocationName('城隍庙东侧')).toBe('城隍庙');
    expect(normalizeLocationName('清水河东边')).toBe('清水河');
    expect(normalizeLocationName('城隍庙左右')).toBe('城隍庙');
  });

  it('关系后缀剥完只剩单字时保留原名，交给非地点过滤诊断', () => {
    expect(normalizeLocationName('他身后')).toBe('他身后');
    expect(isLikelyNonPlaceName('他身后').reason).toBe('相对方位');
  });

  it('保留名称内部的间隔号/连字符（圣·玛丽医院、A-12 区）', () => {
    expect(normalizeLocationName('圣·玛丽医院')).toBe('圣·玛丽医院');
    expect(normalizeLocationName('A-12 区')).toBe('A-12 区');
    expect(locationNameKey('圣·玛丽医院')).toBe('圣玛丽医院');
  });

  it('全角与半角、标点差异归一到同一个键', () => {
    expect(locationNameKey('城隍庙')).toBe(locationNameKey('「城隍庙」'));
    expect(locationNameKey('Ａ区')).toBe(locationNameKey('A 区'));
  });

  it('归一化缓存命中后结果一致，不同输入不串味', () => {
    const first = normalizeLocationName('城隍庙附近');
    expect(first).toBe('城隍庙');
    // 第二次走缓存，结果必须与首次一致
    expect(normalizeLocationName('城隍庙附近')).toBe(first);
    expect(locationNameKey('城隍庙附近')).toBe('城隍庙');
    // 缓存共享同一个 Map：不同输入不能互相污染
    expect(normalizeLocationName('清水河')).toBe('清水河');
    expect(locationNameKey('清水河')).toBe('清水河');
    expect(normalizeLocationName('城隍庙附近')).toBe('城隍庙');
  });
});

describe('isLikelyNonPlaceName', () => {
  it.each([
    ['守卫', '人物/群体'],
    ['他们', '人物/群体'],
    ['黑衣守卫', '人物/群体'],
    ['老妇人', '人物/群体'],
    ['守夜人', '人物/群体'],
    ['巡逻兵', '人物/群体'],
    ['清晨', '时间/天气'],
    ['雨夜', '时间/天气'],
    ['半晌', '时间/天气'],
    ['三更', '时间/天气'],
    ['三天后', '时间/天气'],
    ['远处', '相对方位'],
    ['楼下', '相对方位'],
    ['东边', '相对方位'],
    ['婚礼', '事件/活动'],
    ['战争', '事件/活动'],
    ['庆功晚宴', '事件/活动'],
    ['农民起义', '事件/活动'],
    ['青云帮', '组织/团体'],
    ['冒险者协会', '组织/团体'],
    ['江湖门派', '组织/团体'],
    ['命运', '抽象概念'],
    ['灵力', '抽象概念'],
    ['灵气', '抽象概念'],
    ['内力', '抽象概念'],
    ['欢呼声', '感知现象'],
    ['青锋剑', '物品/器物'],
    ['龙纹玉佩', '物品/器物'],
    ['三块灵石', '物品/器物'],
    ['青铜罗盘', '物品/器物'],
    ['青云剑法', '功法招式'],
    ['天雷诀', '功法招式'],
    ['御风术', '功法招式'],
    ['那个山洞', '指代短语'],
    ['这个山洞', '指代短语'],
    ['此山', '指代短语'],
    ['他们的营地', '指代短语'],
    ['他家', '指代短语'],
    ['一座城', '数量短语'],
    ['两条街', '数量短语'],
    ['三个村子', '数量短语'],
    ['整座城', '数量短语'],
    ['沈家的院子', '描述性短语'],
    ['城隍庙的后院', '描述性短语'],
    ['123', '纯数字'],
    ['   ', '空名称'],
    ['城', '名称过短'],
    ['青云山青云山青云山青云山青云山青云山青云山青云山', '名称过长'],
    ['他走进城隍庙，看见', '句子片段'],
  ])('拒绝非地点「%s」(%s)', (name, reason) => {
    const result = isLikelyNonPlaceName(name);
    expect(result.nonPlace).toBe(true);
    expect(result.reason).toBe(reason);
  });

  it.each([
    '城隍庙',
    '城南旧货市场',
    '清水河',
    '听雨轩',
    '公园',
    '车站',
    '圣·玛丽医院',
    '旧货市场东门',
    '城隍庙后院',
    '沈家老宅',
    // 器物/功法后缀不能误伤与建筑重合的地名
    '大雁塔',
    '钟楼',
    '鼓楼',
    '剑阁',
    '法门寺',
    '丹霞山',
    '玉溪',
    '灵石镇',
  ])('保留可指认的地点「%s」', (name) => {
    expect(isLikelyNonPlaceName(name).nonPlace).toBe(false);
  });

  it.each([
    // 2026-11 修正：真实地名不再因为「这/那/此」开头被误杀
    '那曲',
    '那拉提草原',
    '那霸',
    // 数量/度量前缀不能误伤真实地名
    '三里屯',
    '四方城',
    '一线天',
    '三间房',
    '三家店',
    '三家村',
    '四块玉',
    '两家子',
    '五棵松',
    // 两字地名不触发单字人物后缀
    '武汉',
  ])('不误杀真实地名「%s」', (name) => {
    expect(isLikelyNonPlaceName(name).nonPlace).toBe(false);
  });

  it('「城隍庙东侧」归一化为主地点而不是新建方位点', () => {
    const result = validateLocationCandidate(
      { name: '城隍庙东侧' },
      { chapterContent: '他站在城隍庙东侧。' },
    );
    expect(result.accept).toBe(true);
    if (result.accept) expect(result.name).toBe('城隍庙');
  });
});

describe('validateLocationCandidate — 接地与撞名', () => {
  const chapter = '陈默走进城隍庙，庙里只剩一盏灯。';

  it('名称出现在本章正文时采纳', () => {
    const result = validateLocationCandidate({ name: '城隍庙' }, { chapterContent: chapter });
    expect(result.accept).toBe(true);
    if (result.accept) expect(result.name).toBe('城隍庙');
  });

  it('名称出现在 context 证据片段时采纳', () => {
    const result = validateLocationCandidate(
      { name: '城隍庙', context: '庙里只剩一盏灯' },
      { chapterContent: chapter },
    );
    // context 里没有名称，但本章正文有 ⇒ 仍然接地
    expect(result.accept).toBe(true);
  });

  it('原文里找不到的脑补地名一律拒绝', () => {
    const result = validateLocationCandidate({ name: '青云山' }, { chapterContent: chapter });
    expect(result.accept).toBe(false);
    if (!result.accept) expect(result.reason).toBe('原文中找不到名称');
  });

  it('与角色/物品同名时拒绝', () => {
    const result = validateLocationCandidate(
      { name: '陈默' },
      {
        chapterContent: '陈默走进城隍庙。',
        existingCharacters: [{ name: '陈默' }],
      },
    );
    expect(result.accept).toBe(false);
    if (!result.accept) expect(result.reason).toBe('与角色/物品同名');

    const itemResult = validateLocationCandidate(
      { name: '青铜罗盘' },
      {
        chapterContent: '他把青铜罗盘放在桌上。',
        existingItems: [{ name: '青铜罗盘' }],
      },
    );
    expect(itemResult.accept).toBe(false);
  });

  it('同章增量登记角色名后立即拒绝同名地点', () => {
    const ctx = prepareLocationContext({ chapterContent: '洞天福地就在眼前。' });
    ctx.addEntityName('洞天福地');
    const result = validateLocationCandidate({ name: '洞天福地' }, ctx);
    expect(result.accept).toBe(false);
    if (!result.accept) expect(result.reason).toBe('与角色/物品同名');
  });
});

describe('applyLocationCandidate — 去重、变体合并与章节补全', () => {
  const chapter = '众人来到旧货市场，又去了城南旧货市场，最后站在旧货市场东门。';

  it('同名地点只补章节，不重复建点', () => {
    const existing = makeLocation({ chapters: [1] });
    const ctx = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [existing],
    });
    const result = applyLocationCandidate({ name: '旧货市场' }, 2, ctx);
    expect(result.kind).toBe('link');
    if (result.kind === 'link') {
      expect(result.location.id).toBe(existing.id);
      expect(result.chapters).toEqual([1, 2]);
      expect(result.changed).toBe(true);
    }
  });

  it('章节已存在时 changed=false，调用方无需写库', () => {
    const existing = makeLocation({ chapters: [2], description: '旧货摊位' });
    const ctx = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [existing],
    });
    const result = applyLocationCandidate({ name: '旧货市场' }, 2, ctx);
    expect(result.kind).toBe('link');
    if (result.kind === 'link') expect(result.changed).toBe(false);
  });

  it('「城南旧货市场」与「旧货市场」合并为同一地点', () => {
    const existing = makeLocation({ chapters: [1] });
    const ctx = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [existing],
    });
    const result = applyLocationCandidate({ name: '城南旧货市场' }, 2, ctx);
    expect(result.kind).toBe('link');
    if (result.kind === 'link') expect(result.location.id).toBe(existing.id);
  });

  it('反过来：已有「城南旧货市场」时，「旧货市场」也合并', () => {
    const existing = makeLocation({ id: 'l-long', name: '城南旧货市场', chapters: [1] });
    const ctx = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [existing],
    });
    const result = applyLocationCandidate({ name: '旧货市场' }, 2, ctx);
    expect(result.kind).toBe('link');
    if (result.kind === 'link') expect(result.location.id).toBe('l-long');
  });

  it('子地点不合并：「旧货市场东门」是另一个地图点', () => {
    const existing = makeLocation({ chapters: [1] });
    const ctx = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [existing],
    });
    const result = applyLocationCandidate({ name: '旧货市场东门' }, 2, ctx);
    expect(result.kind).toBe('create');
  });

  it('已有地点描述为空时补上描述；已有描述不覆盖', () => {
    const emptyDesc = makeLocation({ chapters: [1], description: '' });
    const ctx = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [emptyDesc],
    });
    const filled = applyLocationCandidate(
      { name: '旧货市场', description: '城西的旧货摊位' },
      2,
      ctx,
    );
    expect(filled.kind).toBe('link');
    if (filled.kind === 'link') expect(filled.description).toBe('城西的旧货摊位');

    const hasDesc = makeLocation({ chapters: [1], description: '原有描述' });
    const ctx2 = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [hasDesc],
    });
    const kept = applyLocationCandidate(
      { name: '旧货市场', description: '新描述' },
      2,
      ctx2,
    );
    expect(kept.kind).toBe('link');
    if (kept.kind === 'link') expect(kept.description).toBeUndefined();
  });

  it('同章内重复输出只建一次点', () => {
    const ctx = prepareLocationContext({ chapterContent: chapter });
    const first = applyLocationCandidate({ name: '旧货市场' }, 3, ctx);
    expect(first.kind).toBe('create');
    if (first.kind !== 'create') return;

    ctx.addLocation(makeLocation({ id: 'new', name: first.name, chapters: [3] }));
    const second = applyLocationCandidate({ name: '旧货市场' }, 3, ctx);
    expect(second.kind).toBe('link');
    if (second.kind === 'link') expect(second.changed).toBe(false);
  });

  it('同章内重复输出已有地点时，第二次不再重复写库', () => {
    const existing = makeLocation({ chapters: [1] });
    const ctx = prepareLocationContext({
      chapterContent: chapter,
      existingLocations: [existing],
    });
    const first = applyLocationCandidate({ name: '旧货市场' }, 2, ctx);
    expect(first.kind).toBe('link');
    if (first.kind === 'link') {
      // 调用方 link 后把更新后的地点写回索引（hooks 的实际做法）
      ctx.addLocation({ ...first.location, chapters: first.chapters });
    }
    const second = applyLocationCandidate({ name: '旧货市场' }, 2, ctx);
    expect(second.kind).toBe('link');
    if (second.kind === 'link') expect(second.changed).toBe(false);
  });

  it('2000 个已有地点中仍能正确去重（抽 200 条）', () => {
    const existing = Array.from({ length: 2000 }, (_, i) =>
      makeLocation({ id: `l-${i}`, name: `第${i}号据点`, chapters: [1] }),
    );
    const sample = existing.slice(0, 200);
    // 索引只建一次：之后每条候选都是 Map 查表
    const ctx = prepareLocationContext({
      chapterContent: sample.map((l) => l.name).join('，'),
      existingLocations: existing,
    });
    for (const location of sample) {
      const result = validateLocationCandidate({ name: location.name }, ctx);
      expect(result.accept).toBe(true);
      if (result.accept) expect(result.existingLocation?.id).toBe(location.id);
    }
  });
});

describe('locationDescription', () => {
  it('优先用简短描述，缺失时退回原文证据并截断', () => {
    expect(locationDescription({ description: '城西旧货摊位', context: '原文片段' })).toBe(
      '城西旧货摊位',
    );
    expect(locationDescription({ description: '  ', context: '原文片段' })).toBe('原文片段');

    const long = '旧'.repeat(200);
    const result = locationDescription({ context: long });
    expect(result.length).toBe(160);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('pickScanChapters — 全书均匀抽样', () => {
  const makeChapters = (n: number) => Array.from({ length: n }, (_, i) => ({ order: i + 1 }));

  it('章节数不超过上限时全部返回', () => {
    const picked = pickScanChapters(makeChapters(10), 30);
    expect(picked.map((c) => c.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('超过上限时均匀抽样，覆盖首章与末章且不重复', () => {
    const picked = pickScanChapters(makeChapters(100), 30);
    const orders = picked.map((c) => c.order);
    expect(orders).toHaveLength(30);
    expect(orders[0]).toBe(1);
    expect(orders[orders.length - 1]).toBe(100);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('上限为 1 时只取第一章', () => {
    expect(pickScanChapters(makeChapters(50), 1).map((c) => c.order)).toEqual([1]);
  });

  it('输入乱序时先按章节号排序', () => {
    const picked = pickScanChapters(
      [
        { order: 3 },
        { order: 1 },
        { order: 2 },
      ],
      30,
    );
    expect(picked.map((c) => c.order)).toEqual([1, 2, 3]);
  });
});
