// @vitest-environment jsdom
/**
 * 格式菜单的桌面分支回归：触屏变体（底部抽屉）加入后，鼠标路径必须保持
 * 「跟随右键坐标的紧凑弹层 + 点击立即执行」。jsdom 的 matchMedia 对
 * (pointer: coarse) 返回 false，因此这里天然走 IS_TOUCH_PRIMARY=false。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { FormatMenu, MENU_SECTIONS, type MdOp } from './MarkdownTools';

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

const opCount = MENU_SECTIONS.reduce((n, s) => n + s.ops.length, 0);

describe('FormatMenu 桌面分支', () => {
  it('跟随触发点定位的弹层，不是底部抽屉', () => {
    render(
      <FormatMenu
        menu={{ x: 140, y: 220, text: '一段文字' }}
        isDarkMode={false}
        onApply={() => {}}
        onClose={() => {}}
      />
    );
    expect(container!.querySelector('.heid-sheet-panel')).toBeNull();
    const panel = container!.querySelector('div')!;
    const st = panel.getAttribute('style') || '';
    /* 跟随触发点定位（top 会被视口高度夹紧，只断言不受夹紧影响的 left/width） */
    expect(st).toContain('left: 140px');
    expect(st).toContain('width: 320px');
    /* 桌面密度：7 列小格子，不是触屏的 56dp 行 */
    const grid = panel.querySelector('.grid-cols-7');
    expect(grid).not.toBeNull();
    expect([...panel.querySelectorAll('button')].every(b => !b.className.includes('min-h-[56px]'))).toBe(true);
    expect(panel.querySelectorAll('button').length).toBe(opCount);
  });

  it('点击格子立即执行，无需先按下（armed 门控只作用于触屏）', () => {
    const applied: MdOp[] = [];
    render(
      <FormatMenu
        menu={{ x: 10, y: 10, text: '' }}
        isDarkMode={false}
        onApply={op => applied.push(op)}
        onClose={() => {}}
      />
    );
    const bold = [...container!.querySelectorAll('button')].find(b => b.textContent?.includes('粗体'))!;
    act(() => { bold.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(applied).toEqual([{ kind: 'bold' }]);
  });

  it('滚动即关闭（触屏抽屉不需要，桌面弹层必须保留）', () => {
    const onClose = vi.fn();
    render(
      <FormatMenu
        menu={{ x: 10, y: 10, text: '' }}
        isDarkMode={false}
        onApply={() => {}}
        onClose={onClose}
      />
    );
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(onClose).toHaveBeenCalled();
  });
});
