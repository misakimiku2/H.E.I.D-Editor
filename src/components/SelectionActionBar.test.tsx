// @vitest-environment jsdom
/**
 * 选区浮动工具条（Android ActionMode 等价物）：复制 / 宿主动作 / 一键重复上次命令 / 更多。
 * 关键约束——命中区 ≥48dp、贴选区上方以免压住系统拖拽手柄（放不下才翻下方）、
 * 「一键重复」就是上一次用过的那条命令本身（没用过则不出现），以及工具条在选区
 * 形成那一刻出现时不得被长按抬手合成的 click 顺手触发。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* platform 在模块加载期读取，须用 vi.mock 提升到 import 之前：本组件是触屏专用，
   桌面（IS_TOUCH_PRIMARY=false）下 armed 门控不生效，这里要测的是触屏分支 */
vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: true,
  IS_ANDROID_APP: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));

import { SelectionActionBar, type SelectionAnchor } from './SelectionActionBar';
import type { MdOp } from './MarkdownTools';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

const anchor: SelectionAnchor = { left: 300, top: 400, bottom: 424 };

type Props = React.ComponentProps<typeof SelectionActionBar>;

function setup(over: Partial<Props> = {}) {
  const onCopy = vi.fn();
  const onApply = vi.fn();
  const onMore = vi.fn();
  render(
    <SelectionActionBar
      anchor={anchor}
      isDarkMode={false}
      canEdit
      lastOp={{ kind: 'bold' }}
      onCopy={onCopy}
      onApply={onApply}
      onMore={onMore}
      {...over}
    />
  );
  return { onCopy, onApply, onMore, bar: container!.querySelector('div')! };
}

const labels = (bar: HTMLElement) => [...bar.querySelectorAll('button')].map(b => b.textContent?.trim());
const clickBtn = (bar: HTMLElement, text: string) => {
  const b = [...bar.querySelectorAll('button')].find(x => x.textContent?.trim() === text
    || x.title === text)!;
  act(() => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

describe('SelectionActionBar', () => {
  it('复制 / 一键重复 / 更多，且每个都 ≥48dp', () => {
    const { bar } = setup();
    expect(labels(bar)).toEqual(['复制', '粗体', '']);
    expect([...bar.querySelectorAll('button')].every(b =>
      b.className.includes('min-h-[48px]') && b.className.includes('min-w-[48px]'))).toBe(true);
  });

  it('一键重复按钮显示的就是上一次用的那条命令，点它直接套用', () => {
    const { onApply } = setup({ lastOp: { kind: 'heading', level: 1 } });
    const bar = container!.querySelector('div')!;
    expect(labels(bar)).toContain('H1');
    act(() => { document.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    clickBtn(bar, 'H1');
    expect(onApply).toHaveBeenCalledWith({ kind: 'heading', level: 1 });
  });

  it('从没在菜单里用过任何命令时，不显示这个按钮', () => {
    const { bar } = setup({ lastOp: null });
    expect(labels(bar)).toEqual(['复制', '']);
  });

  it('只读预览只留复制，连一键重复和更多都不给', () => {
    const { bar } = setup({ canEdit: false });
    expect(labels(bar)).toEqual(['复制']);
  });

  it('宿主补充的动作（粘贴 / 全选）排在复制之后，同样 ≥48dp', () => {
    const onPaste = vi.fn();
    const { bar } = setup({
      extraActions: [
        { label: '粘贴', icon: React.createElement('i'), onSelect: onPaste },
        { label: '全选', icon: React.createElement('i'), onSelect: vi.fn() },
      ],
    });
    expect(labels(bar).slice(0, 3)).toEqual(['复制', '粘贴', '全选']);
    act(() => { document.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    clickBtn(bar, '粘贴');
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it('默认贴在选区上方，避免压住系统选择手柄', () => {
    const { bar } = setup();
    const top = parseFloat((bar.getAttribute('style') || '').match(/top:\s*([\d.]+)px/)![1]);
    expect(top + 52).toBeLessThanOrEqual(anchor.top);
  });

  it('选区贴着屏幕顶时翻到选区下方', () => {
    const { bar } = setup({ anchor: { left: 300, top: 20, bottom: 44 } });
    const top = parseFloat((bar.getAttribute('style') || '').match(/top:\s*([\d.]+)px/)![1]);
    expect(top).toBeGreaterThanOrEqual(44);
  });

  it('按钮多了也不会被推出屏幕右边缘', () => {
    const { bar } = setup({
      anchor: { left: 1270, top: 400, bottom: 424 },
      extraActions: [
        { label: '粘贴', icon: React.createElement('i'), onSelect: vi.fn() },
        { label: '全选', icon: React.createElement('i'), onSelect: vi.fn() },
      ],
    });
    const left = parseFloat((bar.getAttribute('style') || '').match(/left:\s*([\d.]+)px/)![1]);
    /* 复制 + 粘贴 + 全选 + 一键重复 + 更多 = 基础位（复制+更多）再加 3 个带文字按钮 */
    expect(left + 132 + 3 * 92).toBeLessThanOrEqual(1024);
  });

  it('长按抬手合成的点击不触发任何动作；真实按下后才生效', () => {
    const { onCopy, onApply } = setup();
    const bar = container!.querySelector('div')!;
    clickBtn(bar, '复制');
    clickBtn(bar, '粗体');
    expect(onCopy).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    act(() => { document.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    clickBtn(bar, '复制');
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
