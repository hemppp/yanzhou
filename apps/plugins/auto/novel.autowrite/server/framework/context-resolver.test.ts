/**
 * @fileoverview 开书设定（projects.brief）→ 注入块
 *
 * 这一段是**账要算清的地方**：brief 存在主库、角色手里的工具读不到，
 * 所以它必须由框架强制注入；注入格式一旦漂了，作者在向导里填的开局/世界观/笔风
 * 就等于白填（讨论现场只会看到书名）。
 *
 * 用例取自一次真实的数据修复：`空山雨后`（30 章）的主库行被级联删除后重建，
 * brief 是从这本书**自己的正文与实体数据**反推出来的 —— 所以这里用它的真实内容做断言，
 * 保证"恢复后的设定确实能被注入链路认出来"。
 */

import { describe, it, expect } from 'vitest';
import { formatBrief } from './context-resolver.js';

/** 空山雨后：从正文/角色表/伏笔表反推出来的那份（女主留空，因为数据里确实没有女主） */
const RESTORED = {
  opening: '清晨六点四十，陈默按掉第一声闹钟出门上班；地铁站服务台上一部陌生人落下的旧手机响起，他鬼使神差抬手接听——对面直接叫出了他的名字。',
  worldview: '当代都市，现实向、无超自然力量。三年前姐姐失踪后，陈默一个人过到今天。',
  style: '极克制的白描，短句为主。',
  protagonist: '陈默',
  multipleHeroines: false,
  heroines: [] as string[],
  genreCategory: 'none',
  genre: '悬疑推理',
};

describe('formatBrief', () => {
  it('★ 恢复后的 brief 能被注入链路认出来（开局/世界观/笔风/主角/流派 五行俱在）', () => {
    const t = formatBrief(RESTORED);
    expect(t).toContain('开局：');
    expect(t).toContain('世界观：');
    expect(t).toContain('笔风基调：');
    expect(t).toContain('主角：陈默');
    expect(t).toContain('流派：无系统流 · 悬疑推理');
  });

  it('没有女主时**不输出女主行**（不生成"女主：（空）"这种噪音）', () => {
    expect(formatBrief(RESTORED)).not.toContain('女主');
  });

  it('单女主只写第一位', () => {
    const t = formatBrief({ ...RESTORED, heroines: ['苏晚'] });
    expect(t).toContain('女主：苏晚');
  });

  it('多女主写明人数（作者要知道自己开了几条线）', () => {
    const t = formatBrief({ ...RESTORED, multipleHeroines: true, heroines: ['苏晚', '林夏'] });
    expect(t).toContain('多女主，共 2 位');
    expect(t).toContain('苏晚、林夏');
  });

  it('空 / 非对象 / 缺字段 → 空串（调用方据此整段跳过，不能注入空标题）', () => {
    expect(formatBrief(null)).toBe('');
    expect(formatBrief(undefined)).toBe('');
    expect(formatBrief('')).toBe('');
    expect(formatBrief('不是 JSON')).toBe('');
    expect(formatBrief([])).toBe('');
  });

  it('字符串形式的 JSON 也能解析（库里存的就是 JSON 文本）', () => {
    expect(formatBrief(JSON.stringify(RESTORED))).toContain('主角：陈默');
  });

  it('流派缺 category 时只写流派名（不硬凑一个分类）', () => {
    expect(formatBrief({ ...RESTORED, genreCategory: undefined })).toContain('流派：悬疑推理');
  });
});
