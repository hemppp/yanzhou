/**
 * @fileoverview AddBookModal —— 创作方式选择 + AI 写作新书向导
 *
 * 这个组件承担两套互斥的表单：
 *   · 手写：原样保留的旧卡片表单（书名 / 作者 / 简介 / 目标字数）
 *   · AI 写作：两步向导（开书设定 → 流派选择），设定会被写进 `projects.brief`
 *
 * 这里守住三件事（都是回归风险最高的地方）：
 *   1. 切到手写时，旧字段一个不多一个不少
 *   2. 多女主开关真的会展开 / 增删姓名列表，且提交时空白行被剔除
 *   3. 两步向导的数据被合成一份完整 brief + 流派展示名
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddBookModal } from '../AddBookModal';

// gsap 的 modalEnter/Exit 会返回 timeline（组件内部对退出动画调 .then）；
// jsdom 里没有真实动画帧，直接同步 resolve，测试只关心表单行为。
vi.mock('@/utils/gsap', () => ({
  modalEnter: () => ({ kill: () => {} }),
  modalExit: () => ({ kill: () => {}, then: (cb: () => void) => cb() }),
}));

/**
 * 2026-11-04：模式不再是向导内的切换按钮，改由调用方传入 `defaultMode`
 * —— 书库在哪个库点「新建」，就建哪种书。
 */
function setup(
  editBook: Parameters<typeof AddBookModal>[0]['editBook'] = null,
  defaultMode?: 'manual' | 'auto',
) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <AddBookModal isOpen onClose={onClose} onSubmit={onSubmit} editBook={editBook} defaultMode={defaultMode} />,
  );
  return { onSubmit, onClose };
}

/** 把第一步设定表单填满（多女主关时只有一位女主） */
function fillBrief({ title = '末日无声', heroines = ['苏晚'] }: { title?: string; heroines?: string[] } = {}) {
  fireEvent.change(screen.getByPlaceholderText('输入书名'), { target: { value: title } });
  fireEvent.change(screen.getByPlaceholderText(/故事从哪一刻/), { target: { value: '主角在末日前三小时醒来' } });
  fireEvent.change(screen.getByPlaceholderText(/时代、舞台与力量规则/), { target: { value: '丧尸爆发后第三年' } });
  fireEvent.change(screen.getByPlaceholderText(/冷硬克制/), { target: { value: '冷硬克制' } });
  fireEvent.change(screen.getByPlaceholderText('例如：陈默'), { target: { value: '陈默' } });
  const heroineInputs = [screen.getByPlaceholderText('例如：苏晚'), ...heroines.slice(1).map((_, i) => screen.getByPlaceholderText(`第 ${i + 2} 位女主姓名`))];
  heroines.forEach((h, i) => {
    const el = heroineInputs[i];
    if (el) fireEvent.change(el, { target: { value: h } });
  });
}

describe('AddBookModal · 创作方式与 AI 写作向导', () => {
  it('默认手写：旧卡片表单字段齐全，且不出现 AI 设定项', () => {
    setup();
    expect(screen.getByPlaceholderText('输入书名')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入作者名')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('简要描述...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例如：100000')).toBeInTheDocument();
    // AI 向导的字段此时一个都不该有
    expect(screen.queryByPlaceholderText(/故事从哪一刻/)).toBeNull();
    expect(screen.queryByPlaceholderText('例如：苏晚')).toBeNull();
    expect(screen.queryByRole('switch', { name: '是否多女主' })).toBeNull();
  });

  it('切到 AI 写作：出现开书设定表单（书名 / 开局 / 世界观 / 笔风基调 / 主角姓名 / 女主姓名）与多女主开关', () => {
    setup(null, "auto");
    expect(screen.getByText('开书设定')).toBeInTheDocument();
    expect(screen.getByText('流派选择')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入书名')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/故事从哪一刻/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/时代、舞台与力量规则/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/冷硬克制/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例如：陈默')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例如：苏晚')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '是否多女主' })).toHaveAttribute('aria-checked', 'false');
  });

  it('多女主开关：展开可增删的姓名列表，且至少保留一位', () => {
    setup(null, "auto");
    const sw = screen.getByRole('switch', { name: '是否多女主' });
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByPlaceholderText('第 1 位女主姓名')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /添加一位女主/ }));
    expect(screen.getByPlaceholderText('第 2 位女主姓名')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除第 2 位女主' }));
    expect(screen.queryByPlaceholderText('第 2 位女主姓名')).toBeNull();

    // 只剩一位时不允许再删
    expect(screen.getByRole('button', { name: '删除第 1 位女主' })).toBeDisabled();
  });

  it('第一步必填校验：缺书名时点「下一步」不前进并给出提示', () => {
    setup(null, "auto");
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    expect(screen.getByText('请输入书名')).toBeInTheDocument();
    expect(screen.queryByText('末日求生')).toBeNull(); // 还在第一步
  });

  it('第二步流派清单：两大分类齐备，可切换并选中细分流派', () => {
    setup(null, "auto");
    fillBrief();
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));

    // 系统流：末日 / 求生 / 神豪 / 修仙 这些常见流派都要在
    expect(screen.getByText('末日求生')).toBeInTheDocument();
    expect(screen.getByText('神豪系统')).toBeInTheDocument();
    expect(screen.getByText('修仙系统')).toBeInTheDocument();

    // 切到无系统流：换成现实向的清单
    fireEvent.click(screen.getByRole('radio', { name: '无系统流' }));
    expect(screen.getByText('修真仙侠')).toBeInTheDocument();
    expect(screen.queryByText('神豪系统')).toBeNull();

    fireEvent.click(screen.getByText('修真仙侠'));
    // 上一步能回去，且设定还在
    fireEvent.click(screen.getByRole('button', { name: /上一步/ }));
    expect(screen.getByPlaceholderText('输入书名')).toHaveValue('末日无声');
  });

  it('主按钮在两个步骤都必须是 type="submit"（回归：类型一变就会连带提交）', () => {
    // 背景：点击的默认动作在 React 同步换完 DOM 之后才执行，Chrome 会按**换上去的那个节点**
    // 解析。若第一步的按钮是 type="button"、第二步是 type="submit"，点「下一步」会连带提交表单，
    // 刚进第二步就冒「请选择一个流派」并弹回第一步（实测事件序列：click:下一步 → submit，间隔 39ms）。
    // jsdom 不会重现这个默认动作，所以这里只钉住前提：两个步骤的主按钮类型必须一致。
    setup(null, "auto");
    expect(screen.getByRole('button', { name: /下一步/ })).toHaveAttribute('type', 'submit');
    fillBrief();
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    expect(screen.getByRole('button', { name: '创建' })).toHaveAttribute('type', 'submit');
  });

  it('走完向导提交：brief 完整（空白女主行被剔除）+ 流派展示名一并交出', async () => {
    const { onSubmit } = setup(null, "auto");
    fillBrief();

    // 多女主：填三位，其中一位留空
    fireEvent.click(screen.getByRole('switch', { name: '是否多女主' }));
    fireEvent.click(screen.getByRole('button', { name: /添加一位女主/ }));
    fireEvent.click(screen.getByRole('button', { name: /添加一位女主/ }));
    fireEvent.change(screen.getByPlaceholderText('第 1 位女主姓名'), { target: { value: '苏晚' } });
    fireEvent.change(screen.getByPlaceholderText('第 2 位女主姓名'), { target: { value: '陆离' } });
    // 第 3 位故意留空

    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    fireEvent.click(screen.getByText('末日求生'));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: '末日无声',
      mode: 'auto',
      genre: '系统流 · 末日求生',
      brief: {
        opening: '主角在末日前三小时醒来',
        worldview: '丧尸爆发后第三年',
        style: '冷硬克制',
        protagonist: '陈默',
        multipleHeroines: true,
        heroines: ['苏晚', '陆离'],
        genreCategory: 'system',
        genre: '末日求生',
      },
    }));
  });

  it('未选流派时不允许创建', async () => {
    const { onSubmit } = setup(null, "auto");
    fillBrief();
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('请选择一个流派（或自己填一个）')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('编辑 AI 项目：回填已有开书设定，可改流派后保存', async () => {
    const { onSubmit } = setup({
      id: 'p1',
      userId: 'u1',
      name: '旧书',
      currentWordCount: 0,
      createdAt: 0,
      updatedAt: 0,
      mode: 'auto',
      genre: '系统流 · 末日求生',
      brief: {
        opening: '开局A',
        worldview: '世界观A',
        style: '笔风A',
        protagonist: '主角A',
        multipleHeroines: false,
        heroines: ['女主A'],
        genreCategory: 'system',
        genre: '末日求生',
      },
    });
    expect(screen.getByPlaceholderText('输入书名')).toHaveValue('旧书');
    expect(screen.getByPlaceholderText(/故事从哪一刻/)).toHaveValue('开局A');
    expect(screen.getByPlaceholderText('例如：苏晚')).toHaveValue('女主A');

    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    // 赛博朋克属于无系统流，此时（系统流清单）不该出现
    expect(screen.queryByText('赛博朋克')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '无系统流' }));
    fireEvent.click(screen.getByText('赛博朋克'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'auto',
      genre: '无系统流 · 赛博朋克',
      brief: expect.objectContaining({ genreCategory: 'none', genre: '赛博朋克', heroines: ['女主A'] }),
    }));
  });
});
