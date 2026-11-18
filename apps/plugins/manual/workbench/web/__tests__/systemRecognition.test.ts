// ============================================================
// 系统流识别：系统绑定 + 「系统」不是角色
//
// 锁定两条系统文特有的契约：
//   ① 绑定/解绑是**角色属性**：绑定后角色卡片要能直接看出「已绑定系统」，
//      而不是让用户去时间线里翻一条事件；
//   ② 「系统」不是人：物品流转里 fromCharacter="系统" 时，
//      物品必须记到 **目标角色** 的持有上，而不是整条流转丢失；
//      角色把东西交还系统时，则是该角色 lost。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character, Item } from '@novel/shared';
import {
  useCharacterStore,
  useCreditStore,
  useItemStore,
} from '@novel-plugins/data-core/stores';
import {
  SYSTEM_BIND_TAG,
  applySystemBind,
  isSystemBound,
  isSystemEntityName,
  withSystemBinding,
  systemNameOf,
} from '../knowledge/systemRecognition';
import { handleItemTransferShared } from '../hooks/useScanProcessors';

function character(id: string, name: string, over: Partial<Character> = {}): Character {
  return {
    id,
    projectId: 'p1',
    name,
    aliases: [],
    states: [],
    relations: [],
    chapters: [1],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function item(id: string, name: string, over: Partial<Item> = {}): Item {
  return {
    id,
    projectId: 'p1',
    name,
    type: 'prop',
    states: [],
    holders: [],
    currentHolders: [],
    relations: [],
    chapters: [1],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('isSystemEntityName', () => {
  it('系统与系统界面名都识别为系统', () => {
    for (const name of ['系统', '系统空间', '系统商城', '系统面板', '主神空间', '任务面板']) {
      expect(isSystemEntityName(name), name).toBe(true);
    }
  });

  it('普通人名不会被当成系统', () => {
    for (const name of ['林晚', '系统管理员', '张三', '青云子']) {
      expect(isSystemEntityName(name), name).toBe(false);
    }
  });

  it('空值返回 false', () => {
    expect(isSystemEntityName('')).toBe(false);
    expect(isSystemEntityName(undefined)).toBe(false);
  });
});

describe('withSystemBinding（手动编辑开关）', () => {
  it('绑定并写系统名', () => {
    expect(withSystemBinding(['主角'], true, '人生模拟器')).toEqual([
      '主角',
      '系统绑定',
      '系统:人生模拟器',
    ]);
  });

  it('改系统名时替换旧名，不堆积', () => {
    expect(withSystemBinding(['系统绑定', '系统:旧名'], true, '新名')).toEqual([
      '系统绑定',
      '系统:新名',
    ]);
  });

  it('解绑清掉绑定标签与所有系统名', () => {
    expect(withSystemBinding(['主角', '系统绑定', '系统:人生模拟器'], false)).toEqual(['主角']);
  });

  it('系统名留空只保留绑定标签', () => {
    expect(withSystemBinding([], true, '  ')).toEqual(['系统绑定']);
    expect(withSystemBinding([], true, '系统')).toEqual(['系统绑定']);
  });

  it('没有变化时返回原数组引用（调用方可以据此跳过写库）', () => {
    const tags = ['主角', '系统绑定'];
    expect(withSystemBinding(tags, true, '')).toBe(tags);
    const plain = ['主角'];
    expect(withSystemBinding(plain, false)).toBe(plain);
  });
});
describe('applySystemBind', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    useCharacterStore.setState({
      characters: [character('c1', '林晚'), character('c2', '张三')],
    });
  });

  it('绑定后角色带上「系统绑定」标签，并能取到系统名', () => {
    const result = applySystemBind(
      {
        bindType: 'system_bind',
        characterName: '林晚',
        systemName: '人生模拟器',
        action: 'bind',
        context: '绑定成功，宿主：林晚',
      },
      'p1',
    );

    expect(result).toMatchObject({ changed: true, characterId: 'c1' });
    const lin = useCharacterStore.getState().characters.find((c) => c.id === 'c1')!;
    expect(isSystemBound(lin)).toBe(true);
    expect(lin.tags).toContain(SYSTEM_BIND_TAG);
    expect(systemNameOf(lin)).toBe('人生模拟器');
  });

  it('重复绑定幂等（标签不重复、不触发写库）', () => {
    const bind = {
      bindType: 'system_bind' as const,
      characterName: '林晚',
      action: 'bind' as const,
      context: '再次绑定',
    };
    expect(applySystemBind(bind, 'p1').changed).toBe(true);
    expect(applySystemBind(bind, 'p1').changed).toBe(false);
    const lin = useCharacterStore.getState().characters.find((c) => c.id === 'c1')!;
    expect(lin.tags.filter((t) => t === SYSTEM_BIND_TAG)).toHaveLength(1);
  });

  it('解绑清掉系统标签', () => {
    applySystemBind(
      { bindType: 'system_bind', characterName: '林晚', systemName: '人生模拟器', context: '绑定' },
      'p1',
    );
    expect(
      applySystemBind(
        { bindType: 'system_bind', characterName: '林晚', action: 'unbind', context: '系统剥离' },
        'p1',
      ).changed,
    ).toBe(true);
    const lin = useCharacterStore.getState().characters.find((c) => c.id === 'c1')!;
    expect(isSystemBound(lin)).toBe(false);
    expect(systemNameOf(lin)).toBeUndefined();
  });

  it('只给被点名的那一个角色加标签（系统是属性的，不是全局的）', () => {
    applySystemBind({ bindType: 'system_bind', characterName: '林晚', context: '绑定' }, 'p1');
    const zhang = useCharacterStore.getState().characters.find((c) => c.id === 'c2')!;
    expect(isSystemBound(zhang)).toBe(false);
  });

  it('角色解析不到时不写库', () => {
    expect(
      applySystemBind({ bindType: 'system_bind', characterName: '不存在的人', context: '' }, 'p1'),
    ).toMatchObject({ changed: false, reason: '角色未解析' });
  });

  it('系统名是泛称时不写 `系统:` 标签（信息量为零）', () => {
    applySystemBind(
      { bindType: 'system_bind', characterName: '林晚', systemName: '系统', context: '' },
      'p1',
    );
    const lin = useCharacterStore.getState().characters.find((c) => c.id === 'c1')!;
    expect(systemNameOf(lin)).toBeUndefined();
    expect(isSystemBound(lin)).toBe(true);
  });
});

describe('物品流转：系统作为来源/去向', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    useCharacterStore.setState({
      characters: [character('c1', '林晚'), character('c2', '张三')],
    });
    useItemStore.setState({ items: [item('i1', '回气丹'), item('i2', '青锋剑')] });
    useCreditStore.setState({ creditTransactions: [] });
  });

  const controller = new AbortController();

  it('系统发放给角色：记目标角色 gained，并在账本补一条 gift', () => {
    const n = handleItemTransferShared(
      {
        transferType: 'item_transfer',
        itemName: '回气丹',
        fromCharacter: '系统',
        toCharacter: '林晚',
        action: 'gained',
        context: '系统发放回气丹一瓶',
      },
      3,
      controller,
      'p1',
    );

    expect(n).toBe(1);
    const pill = useItemStore.getState().items.find((i) => i.id === 'i1')!;
    expect(pill.currentHolders).toEqual(['c1']);
    expect(pill.holders).toEqual([{ characterId: 'c1', chapter: 3, action: 'gained' }]);

    const ledger = useCreditStore.getState().creditTransactions;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'gift', amount: 0, characterId: 'c1', relatedItemId: 'i1' });
  });

  it('角色把物品交还系统：记该角色 lost', () => {
    // 先让林晚持有
    handleItemTransferShared(
      { transferType: 'item_transfer', itemName: '青锋剑', fromCharacter: '系统', toCharacter: '林晚', action: 'gained', context: '' },
      1,
      controller,
      'p1',
    );
    useCreditStore.setState({ creditTransactions: [] });

    handleItemTransferShared(
      { transferType: 'item_transfer', itemName: '青锋剑', fromCharacter: '林晚', toCharacter: '系统空间', action: 'lost', context: '' },
      2,
      controller,
      'p1',
    );

    const blade = useItemStore.getState().items.find((i) => i.id === 'i2')!;
    expect(blade.currentHolders).toEqual([]);
    expect(blade.holders.some((h) => h.characterId === 'c1' && h.action === 'lost')).toBe(true);
  });

  it('主角从系统拿到物品再转赠他人：最终持有者是人，系统不出现', () => {
    // 系统 → 林晚
    handleItemTransferShared(
      { transferType: 'item_transfer', itemName: '回气丹', fromCharacter: '系统', toCharacter: '林晚', action: 'gained', context: '系统发放' },
      1,
      controller,
      'p1',
    );
    // 林晚 → 张三
    handleItemTransferShared(
      { transferType: 'item_transfer', itemName: '回气丹', fromCharacter: '林晚', toCharacter: '张三', action: 'transferred', context: '林晚把回气丹递给张三' },
      2,
      controller,
      'p1',
    );

    const pill = useItemStore.getState().items.find((i) => i.id === 'i1')!;
    expect(pill.currentHolders).toEqual(['c2']);
    expect(pill.holders).toEqual([
      { characterId: 'c1', chapter: 1, action: 'gained' },
      { characterId: 'c1', chapter: 2, action: 'lost' },
      { characterId: 'c2', chapter: 2, action: 'gained' },
    ]);
  });

  it('只在系统内部转（系统 → 系统）不写任何持有', () => {
    const n = handleItemTransferShared(
      { transferType: 'item_transfer', itemName: '回气丹', fromCharacter: '系统', toCharacter: '系统空间', action: 'transferred', context: '' },
      1,
      controller,
      'p1',
    );
    expect(n).toBe(0);
    const pill = useItemStore.getState().items.find((i) => i.id === 'i1')!;
    expect(pill.holders).toEqual([]);
  });
});