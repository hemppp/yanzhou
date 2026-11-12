// ============================================================
// 自动扫描流解析回归
//
// 背景：旧实现同样按行 split + JSON.parse，模型一旦输出代码围栏、
// 多行美化 JSON 或数组包裹，整条实体/事件都会静默丢失。
// 现在扫描与关键词提取共用 extractCompleteJsonObjects，本文件锁定：
//   ① 四类记录（实体/别名/流转/事件）仍按旧优先级分发；
//   ② 围栏、多行、数组、任意 chunk 断开都能解析；
//   ③ 无法识别的对象只计数，不打断后续记录。
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseStreamRecord,
  streamTimelineEvents,
  type ScannerInput,
} from './scanner-agent.js';

const INPUT: ScannerInput = {
  chapterContent: '陈星推开藏经阁的木门，抽出泛黄的残卷。',
  chapterTitle: '夜探藏经阁',
  chapterOrder: 3,
  projectName: '测试项目',
};

beforeEach(() => {
  // 扫描函数会打印逐条诊断日志，测试里静音
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 按固定长度切块，模拟 SSE chunk 在任意位置断开 */
function chunkEvery(text: string, size: number): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
}

async function runScan(text: string, chunkSize = 11) {
  async function* fakeStream() {
    for (const content of chunkEvery(text, chunkSize)) {
      yield { content };
    }
  }

  const entities: string[] = [];
  const aliases: string[] = [];
  const transfers: string[] = [];
  const events: string[] = [];

  const returned = await streamTimelineEvents(
    fakeStream as never,
    INPUT,
    {
      onEntity: (entity) => entities.push(`${entity.entityType}:${entity.name}`),
      onAliasMatch: (alias) => aliases.push(`${alias.primaryName}←${alias.aliases.join(',')}`),
      onItemTransfer: (transfer) => transfers.push(`${transfer.itemName}:${transfer.action}`),
      onEvent: (event) => events.push(event.title),
    },
  );

  return { entities, aliases, transfers, events, returned };
}

describe('parseStreamRecord', () => {
  it('按实体 → 别名 → 流转 → 事件的顺序分发', () => {
    expect(
      parseStreamRecord({ entityType: 'character', name: '陈星', title: '抢注事件' }, 3),
    ).toMatchObject({ kind: 'entity', entity: { name: '陈星' } });

    expect(
      parseStreamRecord({ aliasType: 'alias_match', primaryName: '陈星', aliases: ['星儿'] }, 3),
    ).toMatchObject({ kind: 'alias', aliasMatch: { primaryName: '陈星' } });

    expect(
      parseStreamRecord(
        { transferType: 'item_transfer', itemName: '残卷', action: 'gained' },
        3,
      ),
    ).toMatchObject({ kind: 'transfer', transfer: { itemName: '残卷' } });

    expect(
      parseStreamRecord({ title: '陈星夜探藏经阁', description: 'd' }, 3),
    ).toMatchObject({ kind: 'event', event: { chapterOrder: 3 } });
  });

  it('强制使用当前章节号，不采信模型输出', () => {
    const record = parseStreamRecord({ title: '事件', chapterOrder: 99 }, 7);
    expect(record).toMatchObject({ kind: 'event', event: { chapterOrder: 7 } });
  });

  it('无法识别的对象 / 非对象返回 null', () => {
    expect(parseStreamRecord({ foo: 'bar' }, 3)).toBeNull();
    expect(parseStreamRecord(null, 3)).toBeNull();
    expect(parseStreamRecord([{ title: 'x' }], 3)).toBeNull();
  });

  it('积分流水按 creditType 分发，并强制当前章节', () => {
    expect(
      parseStreamRecord(
        {
          creditType: 'credit_transaction',
          action: 'spend',
          characterName: '陈星',
          amount: 500,
          reason: '兑换基础剑法',
          itemName: '基础剑法',
          chapterOrder: 99,
        },
        3,
      ),
    ).toEqual({
      kind: 'credit',
      credit: {
        creditType: 'credit_transaction',
        action: 'spend',
        characterName: '陈星',
        amount: 500,
        reason: '兑换基础剑法',
        itemName: '基础剑法',
        chapterOrder: 3,
      },
    });
  });

  it('赠予强制 amount=0，缺角色或非法金额丢弃', () => {
    expect(
      parseStreamRecord(
        {
          creditType: 'credit_transaction',
          action: 'gift',
          characterName: '陈星',
          amount: 100,
          itemName: '令牌',
        },
        2,
      ),
    ).toMatchObject({ kind: 'credit', credit: { action: 'gift', amount: 0 } });

    expect(
      parseStreamRecord(
        { creditType: 'credit_transaction', action: 'spend', characterName: '', amount: 100 },
        2,
      ),
    ).toBeNull();
    expect(
      parseStreamRecord(
        { creditType: 'credit_transaction', action: 'spend', characterName: '陈星', amount: 0 },
        2,
      ),
    ).toBeNull();
  });
});

describe('streamTimelineEvents', () => {
  it('围栏 + 多行 + 数组包裹的混合记录都能解析', async () => {
    const text = `好的，下面是分析结果：
\`\`\`json
{
  "entityType": "character",
  "name": "陈星",
  "description": "少年",
  "context": "陈星推开门"
}
{"aliasType":"alias_match","primaryName":"陈星","aliases":["星儿"],"context":"星儿唤他"}
[
{"transferType":"item_transfer","itemName":"残卷","fromCharacter":"","toCharacter":"陈星","action":"gained","context":"抽出残卷"},
{"title":"陈星夜探藏经阁","description":"陈星潜入藏经阁抽取残卷。","type":"event","characterNames":["陈星"],"chapterOrder":99}
]
\`\`\`
以上。`;

    const result = await runScan(text);

    expect(result.entities).toEqual(['character:陈星']);
    expect(result.aliases).toEqual(['陈星←星儿']);
    expect(result.transfers).toEqual(['残卷:gained']);
    expect(result.events).toEqual(['陈星夜探藏经阁']);
    expect(result.returned).toHaveLength(1);
    expect(result.returned[0]?.chapterOrder).toBe(3);
  });

  it('逐字符喂入时仍能正确跟踪字符串里的括号与转义', async () => {
    const record = JSON.stringify({
      entityType: 'character',
      name: '陈{星}',
      description: '他说"好"',
      context: '路径 C:\\tmp',
    });

    const result = await runScan(record, 1);

    expect(result.entities).toEqual(['character:陈{星}']);
  });

  it('一个 chunk 里的多条记录能连续分发', async () => {
    const result = await runScan(
      '{"entityType":"character","name":"甲"}{"title":"乙事件","description":"d"}',
      1000,
    );

    expect(result.entities).toEqual(['character:甲']);
    expect(result.events).toEqual(['乙事件']);
  });

  it('流结束能从缺外层 } 的残留中恢复完整的嵌套对象', async () => {
    const result = await runScan('{"bad": {"title":"可恢复事件","description":"d"}', 3);

    expect(result.events).toEqual(['可恢复事件']);
  });

  it('一个坏对象不会吞掉后面的记录', async () => {
    const text = [
      '{"foo":"bar"}',
      '{"entityType":"item","name":"残卷","itemType":"scroll"}',
      '{"title":"陈星夜探藏经阁","description":"d"}',
    ].join('\n');

    const result = await runScan(text);

    expect(result.entities).toEqual(['item:残卷']);
    expect(result.events).toEqual(['陈星夜探藏经阁']);
  });

  it('流结束时残留的半条 JSON 不会抛出，也不产生记录', async () => {
    await expect(
      runScan('{"entityType":"character","name":"陈星","description":"写到一半'),
    ).resolves.toMatchObject({ entities: [], events: [] });
  });

  it('流式扫描会把积分流水交给 onCreditTransaction', async () => {
    const text =
      '{"creditType":"credit_transaction","action":"spend","characterName":"陈星","amount":500,"reason":"兑换基础剑法"}';
    const credits: unknown[] = [];

    async function* fakeStream() {
      yield { content: text };
    }

    await streamTimelineEvents(fakeStream as never, INPUT, {
      onCreditTransaction: (credit) => credits.push(credit),
    });

    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      action: 'spend',
      amount: 500,
      characterName: '陈星',
      chapterOrder: 3,
    });
  });

  it('事件 quote 逐字命中原文时保留并带出 quote', async () => {
    const result = await runScan(
      '{"title":"陈星推开木门","description":"陈星推开藏经阁木门，抽出残卷。","type":"event","characterNames":["陈星"],"quote":"陈星推开藏经阁的木门"}',
    );
    expect(result.events).toEqual(['陈星推开木门']);
    expect(result.returned[0]?.quote).toBe('陈星推开藏经阁的木门');
  });

  it('事件 quote 对不上原文时整条丢弃（防编造）', async () => {
    const result = await runScan(
      '{"title":"陈星偷走残卷","description":"陈星偷走残卷。","type":"event","characterNames":["陈星"],"quote":"陈星偷走残卷"}',
    );
    expect(result.events).toEqual([]);
  });

  it('事件只保留原文里出现过的角色名（防挂错）', async () => {
    const result = await runScan(
      '{"title":"陈星推开木门","description":"陈星推开藏经阁木门。","type":"event","characterNames":["陈星","王五"],"quote":"陈星推开藏经阁的木门"}',
    );
    expect(result.returned[0]?.characterNames).toEqual(['陈星']);
  });
});
