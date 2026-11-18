// ============================================================
// 系统流（积分 + 系统发放物品）识别实测
//
// 逐章扫接口 → 收集 credit_transaction / item 实体 / item_transfer →
// 用 processCreditTransactionShared 同一套规则跑一遍 → 与人工预期对表。
//
// 每个测试项在原文里都写得斩钉截铁，任何漏/错都是算法问题，不是模型理解不了。
// ============================================================

const BASE = process.argv[2] || 'http://127.0.0.1:3899';
const PROJECT_ID = process.argv[3];

if (!PROJECT_ID) {
  console.error('用法: node sysdemo.mjs <baseUrl> <projectId>');
  process.exit(1);
}





const CHAPTERS = [
  {
    title: '第一章 绑定系统',
    text:
      '林晚在出租屋里醒来，眼前浮着一块淡蓝色的系统面板。面板上写着：绑定成功，初始积分 100。' +
      '随后一行小字弹出：检测到宿主首次绑定，赠送新手礼包，内含青锋剑一柄。' +
      '林晚伸手虚按，青锋剑凭空落在掌心。系统提示：获得青锋剑，积分 100 保持不变。',
  },
  {
    title: '第二章 兑换功法',
    text:
      '系统商城界面在面前展开，第一页列着《基础剑法》，售价 60 积分。' +
      '林晚点了兑换。系统提示：消耗 60 积分，兑换基础剑法成功。余额 40 积分。' +
      '一道金光没入眉心，基础剑法的招式在脑中铺开。',
  },
  {
    title: '第三章 新手任务',
    text:
      '任务面板刷新：新手任务「在城西古井旁等三个时辰」，完成奖励 200 积分与一瓶回气丹。' +
      '林晚赶到古井，枯坐三个时辰。任务完成的提示音响起：获得 200 积分，获得回气丹一瓶。' +
      '他打开系统面板看了一眼，积分从 40 变成 240。',
  },
  {
    title: '第四章 不该有的数字',
    text:
      '林晚翻着街边的旧报纸，报上写着某位大老板捐了一千万给慈善基金。' +
      '他也看到巷口猪肉铺贴着「五花肉 38 一斤」的价目表。' +
      '系统面板安静地悬在一旁，没有弹出任何提示。',
  },
  {
    title: '第五章 被抢',
    text:
      '黑衣人从巷子里冲出来，一把夺走林晚手里的青锋剑。林晚追了两步，被一脚踹倒。' +
      '系统提示：失去青锋剑。任务面板刷新：夺回青锋剑，奖励 150 积分。' +
      '林晚抹掉嘴角的血，记住了黑衣人的脸。',
  },
  {
    title: '第六章 夺回',
    text:
      '林晚在码头堵住了黑衣人。两人缠斗半刻，林晚掰断对方的手腕，夺回了青锋剑。' +
      '系统提示音连响两声：夺回青锋剑，任务完成，获得 150 积分。当前积分 390。' +
      '系统又弹出一行：连续两次战斗胜利，额外赠送玄铁护腕一副。玄铁护腕套在林晚小臂上，冰凉贴骨。',
  },
  {
    title: '第七章 系统商店',
    text:
      '系统商城刷新出新货：玄铁护腕标价 800 积分，回气丹标价 20 积分。' +
      '林晚看了看余额，390 积分，两样都买不起。他叹了口气，把系统面板关掉。' +
      '关掉之前，面板角落还有一行小字：积分不足时无法兑换，请继续完成任务。',
  },
  {
    title: '第八章 黑市',
    text:
      '林晚在黑市上把一枚捡来的玉佩卖了三百块钱。摊主多看了他两眼，问他是不是练家子。' +
      '林晚没答话，揣着钱走了。这一趟系统没有发出任何提示，积分也没有变化。',
  },
  {
    title: '第九章 大任务',
    text:
      '系统发布主线任务：斩杀城东妖狼，奖励 1000 积分。林晚提剑出门。' +
      '血战之后，妖狼死在雪地里。系统提示：主线任务完成，获得 1000 积分，当前积分 1390。' +
      '额外奖励：妖狼牙三枚，已存入系统空间。',
  },
  {
    title: '第十章 清点',
    text:
      '林晚把系统空间里的东西一件件取出来清点：青锋剑、回气丹、玄铁护腕、妖狼牙三枚。' +
      '系统面板显示：当前积分 1390。他盯着这个数字，忽然觉得这一路的每一步都标好了价钱。',
  },
];

/** 人工预期：每章应该识别出的积分流水 */
const EXPECTED_CREDITS = [
  { chapter: 1, action: 'gain', amount: 100, character: '林晚', note: '初始积分 100' },
  { chapter: 1, action: 'gift', amount: 0, character: '林晚', item: '青锋剑', note: '新手礼包赠青锋剑' },
  { chapter: 2, action: 'spend', amount: 60, character: '林晚', item: '基础剑法', note: '兑换基础剑法' },
  { chapter: 3, action: 'gain', amount: 200, character: '林晚', note: '新手任务奖励' },
  { chapter: 6, action: 'gain', amount: 150, character: '林晚', item: '青锋剑', note: '夺回任务完成' },
  { chapter: 6, action: 'gift', amount: 0, character: '林晚', item: '玄铁护腕', note: '额外赠送护腕' },
  { chapter: 9, action: 'gain', amount: 1000, character: '林晚', note: '主线任务完成' },
  { chapter: 9, action: 'gift', amount: 0, character: '林晚', item: '妖狼牙', note: '额外奖励妖狼牙' },
];

/** 人工预期：系统发放/兑换得到的物品（应进入角色持有） */
const EXPECTED_ITEMS = ['青锋剑', '回气丹', '玄铁护腕', '妖狼牙'];

async function scan(chapter: { title: string; text: string }, order: number, known: unknown) {
  const res = await fetch(`${BASE}/api/ai/scan-timeline-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Project-Id': PROJECT_ID },
    body: JSON.stringify({
      chapterContent: chapter.text,
      chapterTitle: chapter.title,
      chapterOrder: order,
      projectName: '系统流积分实测',
      existingEntities: JSON.stringify(known),
      projectId: PROJECT_ID,
    }),
  });
  if (!res.ok) throw new Error(`扫描失败 ${res.status}`);
  const raw = await res.text();
  const entities = [];
  const transfers = [];
  const credits = [];
  for (const frame of raw.split('\n\n')) {
    const line = frame.trim();
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload) continue;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }
    if (data.error || data.done) continue;
    if (typeof data.creditType === 'string') credits.push(data);
    else if (typeof data.transferType === 'string') transfers.push(data);
    else if (typeof data.entityType === 'string') entities.push(data);
  }
  return { entities, transfers, credits };
}

async function main() {
  const known = { characters: [], items: [], locations: [] };
  const allCredits: any[] = [];
  const allItems = new Set<string>();
  const chapterLog: any[] = [];

  for (let i = 0; i < CHAPTERS.length; i++) {
    const order = i + 1;
    const chapter = CHAPTERS[i]!;
    process.stdout.write(`第 ${order} 章 ${chapter.title} … `);
    let result;
    try {
      result = await scan(chapter, order, known);
    } catch (e) {
      console.log(`失败 ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (const entity of result.entities) {
      if (entity.entityType === 'character') {
        if (!known.characters.some((c) => c.name === entity.name)) known.characters.push({ name: entity.name, aliases: [] });
      } else if (entity.entityType === 'item') {
        if (!known.items.includes(entity.name)) known.items.push(entity.name);
        allItems.add(entity.name);
      } else if (entity.entityType === 'location') {
        if (!known.locations.includes(entity.name)) known.locations.push(entity.name);
      }
    }
    allCredits.push(...result.credits.map((c) => ({ ...c, chapter: order })));
    chapterLog.push({
      order,
      title: chapter.title,
      credits: result.credits.length,
      items: result.entities.filter((e) => e.entityType === 'item').map((e) => e.name),
      transfers: result.transfers.length,
    });
    console.log(
      `流水=${result.credits.length} 物品=${result.entities.filter((e) => e.entityType === 'item').length} 流转=${result.transfers.length}`,
    );
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n============ 逐章 ============');
  for (const c of chapterLog) {
    console.log(`第${c.order}章 ${c.title}: 流水 ${c.credits} · 物品 [${c.items.join('、') || '—'}] · 流转 ${c.transfers}`);
  }

  console.log('\n============ 积分流水 ============');
  console.log(`共输出 ${allCredits.length} 条（人工预期 ${EXPECTED_CREDITS.length} 条）`);
  for (const c of allCredits) {
    console.log(
      `  第${c.chapter}章 ${c.characterName} ${c.action} ${c.amount}${c.itemName ? ` item=${c.itemName}` : ''}${c.reason ? ` reason=${c.reason}` : ''}`,
    );
  }

  const key = (c: { chapter: number; action: string; amount: number }) => `${c.chapter}|${c.action}|${c.amount}`;
  const actualKeys = new Map<string, number>();
  for (const c of allCredits) actualKeys.set(key(c), (actualKeys.get(key(c)) ?? 0) + 1);

  let hit = 0;
  const miss: string[] = [];
  for (const e of EXPECTED_CREDITS) {
    const k = key(e);
    const count = actualKeys.get(k) ?? 0;
    if (count > 0) {
      hit++;
      actualKeys.set(k, count - 1);
    } else {
      // 允许任务奖励提前一章输出（第 5 章「奖励 150 积分」）
      const adjacent = allCredits.some(
        (c) => c.action === e.action && c.amount === e.amount && Math.abs(c.chapter - e.chapter) <= 1,
      );
      miss.push(`${e.note}（${e.chapter}章 ${e.action} ${e.amount}）${adjacent ? ' ← 相邻章出现过' : ''}`);
    }
  }
  const extra = [...actualKeys.entries()].filter(([, n]) => n > 0);

  console.log(`\n命中 ${hit}/${EXPECTED_CREDITS.length}`);
  if (miss.length) console.log(`漏/错:\n  - ${miss.join('\n  - ')}`);
  if (extra.length) console.log(`多余: ${extra.map(([k, n]) => `${k}×${n}`).join(', ')}`);

  console.log('\n============ 物品 ============');
  console.log(`识别到物品 ${allItems.size} 个: ${[...allItems].join('、')}`);
  const missingItems = EXPECTED_ITEMS.filter((n) => ![...allItems].some((got) => got.includes(n) || n.includes(got)));
  console.log(missingItems.length ? `应有但没识别到: ${missingItems.join('、')}` : '关键物品全部识别到');

  const noisyItems = [...allItems].filter((n) => /积分|点|值|面板|系统|商城|任务|奖励|块钱|余额/.test(n));
  console.log(noisyItems.length ? `疑似误识别为物品: ${noisyItems.join('、')}` : '没有把积分/面板/余额当成物品');

  console.log('\n============ 对照第 4/7/8 章（不该出流水） ============');
  for (const order of [4, 7, 8]) {
    const got = allCredits.filter((c) => c.chapter === order);
    console.log(`第${order}章: ${got.length === 0 ? '✓ 没有输出流水' : `✗ 输出了 ${got.map((c) => `${c.action}${c.amount}`).join(',')}`}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});