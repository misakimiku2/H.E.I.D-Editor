// @vitest-environment jsdom
/**
 * 格式菜单的触屏变体：与桌面同一份跟随选区的弹层，但格子从 40×47 放大到
 * ≥56dp、列数按视口收窄、省掉分隔线压缩总高。桌面分支见 desktopmenu 测试。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* platform 在模块加载期读取，须用 vi.mock 提升到 import 之前 */
vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: true,
  IS_ANDROID_APP: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));

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

const panel = () => container!.querySelector('div')!;

describe('FormatMenu 触屏变体', () => {
  it('仍是跟随触发点的弹层，但面板加宽、列数收窄、格子用 56dp', () => {
    render(
      <FormatMenu
        menu={{ x: 140, y: 220, text: '一段文字' }}
        isDarkMode={false}
        canUndo
        canRedo
        onUndo={() => {}}
        onRedo={() => {}}
        onApply={() => {}}
        onClose={() => {}}
      />
    );
    const p = panel();
    const st = p.getAttribute('style') || '';
    expect(st).toContain('left: 140px');
    /* jsdom 视口 1024px 宽 → 6 列、面板 468px */
    expect(st).toContain('width: 468px');
    expect(p.querySelector('.grid-cols-7')).toBeNull();
    const grids = [...p.querySelectorAll('.grid')] as HTMLElement[];
    expect(grids.length).toBeGreaterThan(0);
    expect(grids[0].style.gridTemplateColumns).toContain('repeat(6');
    const buttons = [...p.querySelectorAll('button')];
    expect(buttons.length).toBe(opCount + 2);
    expect(buttons.every(b => b.className.includes('min-h-[56px]'))).toBe(true);
  });

  it('触屏靠分区标题分隔，不再画分隔线', () => {
    render(
      <FormatMenu
        menu={{ x: 10, y: 10, text: '' }}
        isDarkMode={false}
        onApply={() => {}}
        onClose={() => {}}
      />
    );
    expect(panel().querySelectorAll('.h-px').length).toBe(0);
    expect(panel().textContent).toContain('标题');
  });

  it('长按/点「更多」抬手合成的点击被忽略；真实按下过之后再点才执行', () => {
    const applied: MdOp[] = [];
    render(
      <FormatMenu
        menu={{ x: 10, y: 10, text: '一段文字' }}
        isDarkMode={false}
        onApply={op => applied.push(op)}
        onClose={() => {}}
      />
    );
    const bold = [...panel().querySelectorAll('button')].find(b => b.textContent?.includes('粗体'))!;
    /* 只有 click、没有伴随的 pointerdown */
    act(() => { bold.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(applied).toHaveLength(0);

    act(() => { document.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    act(() => { bold.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(applied).toEqual([{ kind: 'bold' }]);
  });
});
