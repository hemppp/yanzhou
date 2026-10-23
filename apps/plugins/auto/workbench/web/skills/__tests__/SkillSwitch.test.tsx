/**
 * @fileoverview SkillSwitch —— 左关右开的技能开关
 *
 * 这个开关的全部意义是"让人一眼看清现在是开还是关"，所以测的重点不是点击回调，
 * 而是**两个状态都被写出来**（左「关」右「开」+ 滑块位置）以及无障碍语义。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkillSwitch } from '../SkillSwitch';

function setup(props: Partial<React.ComponentProps<typeof SkillSwitch>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <SkillSwitch enabled={false} onChange={onChange} label="世界观顾问 技能开关" {...props} />,
  );
  return { onChange, ...utils };
}

describe('SkillSwitch', () => {
  it('两个状态都写在界面上：左「关」右「开」', () => {
    setup();
    expect(screen.getByText('关')).toBeInTheDocument();
    expect(screen.getByText('开')).toBeInTheDocument();
  });

  it('语义：role=switch + aria-checked 跟随状态 + 有可读的名字', () => {
    const { unmount } = setup({ enabled: false });
    const off = screen.getByRole('switch');
    expect(off).toHaveAttribute('aria-checked', 'false');
    expect(off).toHaveAccessibleName('世界观顾问 技能开关');
    unmount();

    setup({ enabled: true });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('★ 滑块位置就是状态：关在左、开在右', () => {
    const { container, unmount } = setup({ enabled: false });
    expect(container.querySelector('[data-knob]')).toHaveAttribute('data-knob', 'off');
    unmount();

    const second = setup({ enabled: true });
    expect(second.container.querySelector('[data-knob]')).toHaveAttribute('data-knob', 'on');
  });

  it('点击把状态翻过去（关 → 开、开 → 关）', () => {
    const { onChange } = setup({ enabled: false });
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('已开启时点击回传 false', () => {
    const { onChange } = setup({ enabled: true });
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('disabled / busy 时不响应点击（请求进行中不能重复提交）', () => {
    const { onChange, unmount } = setup({ disabled: true });
    const btn = screen.getByRole('switch');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
    unmount();

    const second = setup({ busy: true });
    const b2 = screen.getByRole('switch');
    expect(b2).toBeDisabled();
    fireEvent.click(b2);
    expect(second.onChange).not.toHaveBeenCalled();
  });
});
