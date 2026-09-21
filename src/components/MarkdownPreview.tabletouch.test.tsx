// @vitest-environment jsdom
/**
 * 触屏表格结构工具条：点选单元格浮出、四个动作写回源码的结果、触点尺寸与停靠位置
 * （v1.4.1 把这条自 v1.1.0 起就存在、却从未量过的触屏路径抬到 ≥44dp、钉到键盘之上并补上覆盖）。
 * 停靠用例盯的是平板实测踩到的坑：键盘弹起会把按「点击那一刻的可视框」算出的浮层压到键盘底下，
 * 等于按钮消失。桌面的悬停边线 +/− 单按钮是另一条路径，见 handleTableTool。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* platform 在模块加载期读取，须用 vi.mock 提升到 import 之前 */
vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: true,
  IS_ANDROID_APP: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MarkdownPreview } from './MarkdownPreview';

const MD = [
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '| 3 | 4 |',
].join('\n');

let root: Root | null = null;
let container: HTMLElement | null = null;

/** 挂载预览并返回 onChange 的调用记录（同用例内重复挂载会先收掉上一个） */
function mount(content = MD) {
  act(() => { root?.unmount(); });
  container?.remove();
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<MarkdownPreview content={content} isDarkMode={false} onChange={onChange} />); });
  return { onChange, latest: () => onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as string };
}

/** 点选第 r 行第 c 列单元格（r 为 DOM 行下标：表头占 0） */
function tapCell(r: number, c: number) {
  const cell = container!.querySelectorAll('table')[0].querySelectorAll('tr')[r]
    .querySelectorAll('td, th')[c] as HTMLElement;
  act(() => { cell.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const bar = () => container!.querySelector('[data-md-table-tools]:not(input)') as HTMLElement | null;
const barButton = (label: string) =>
  Array.from(bar()!.querySelectorAll('button')).find(b => b.textContent === label)!;

/** 走原生 value setter：直接赋 .value 会被 React 的实例级补丁判为「值没变」而跳过 onChange */
function typeInto(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('触屏表格结构工具条', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('单击单元格即浮出四个动作（不需要双击、不需要 hover）', () => {
    mount();
    expect(bar()).toBeNull();
    tapCell(1, 0);
    expect(bar()).not.toBeNull();
    expect(Array.from(bar()!.querySelectorAll('button')).map(b => b.textContent))
      .toEqual(['md.rowAdd', 'md.rowDel', 'md.colAdd', 'md.colDel']);
  });

  it('四个动作各 60×44dp：整条定宽 240、按钮 h-11，不低于 v1.4 的触屏档', () => {
    mount();
    tapCell(1, 0);
    const b = bar()!;
    expect(b.className).toContain('w-[240px]');
    for (const btn of Array.from(b.querySelectorAll('button'))) {
      expect(btn.className).toContain('h-11');
      expect(btn.className).toContain('flex-1');
    }
  });

  it('钉在屏幕底缘、键盘之上（fixed + --heid-kb），不跟随内容坐标', () => {
    mount();
    tapCell(1, 0);
    const b = bar()!;
    /* 曾经是「按点击那一刻算出的格子坐标」浮在格子上方：键盘一弹起来就被压到键盘底下，
       平板实测按钮等于消失。现在落点交给 CSS，跟着 IME 注入的高度走 */
    expect(b.className).toContain('fixed');
    expect(b.style.bottom).toBe('calc(var(--heid-kb, 0px) + 12px)');
    expect(b.style.left).toBe('');
    /* 输入框仍然钉在它那一格上（内容系坐标，滚动时跟随单元格） */
    const input = container!.querySelector('input[data-md-table-tools]') as HTMLElement;
    expect(input.style.top).not.toBe('');
  });

  it('行+ 在选中行下方插入空行，其余单元格原样', () => {
    const { latest } = mount();
    tapCell(1, 0);
    act(() => { barButton('md.rowAdd').click(); });
    expect(latest()).toBe([
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '|  |  |',
      '| 3 | 4 |',
    ].join('\n'));
  });

  it('行− 删掉选中行', () => {
    const { latest } = mount();
    tapCell(2, 1);
    act(() => { barButton('md.rowDel').click(); });
    expect(latest()).toBe([
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n'));
  });

  it('无可删项（表头是唯一行、列是唯一列）时不产生空改动，标签页不白标脏', () => {
    const onlyRow = ['| a | b |', '| - | - |'].join('\n');
    const { onChange } = mount(onlyRow);
    tapCell(0, 0);
    act(() => { barButton('md.rowDel').click(); });
    expect(onChange).not.toHaveBeenCalled();

    const onlyCol = ['| a |', '| - |', '| 1 |'].join('\n');
    const r2 = mount(onlyCol);
    tapCell(1, 0);
    act(() => { barButton('md.colDel').click(); });
    expect(r2.onChange).not.toHaveBeenCalled();
  });

  it('列+ 在选中列右侧插入空列（分隔行同步补位）', () => {
    const { latest } = mount();
    tapCell(1, 0);
    act(() => { barButton('md.colAdd').click(); });
    expect(latest()).toBe([
      '| a |  | b |',
      '| - | --- | - |',
      '| 1 |  | 2 |',
      '| 3 |  | 4 |',
    ].join('\n'));
  });

  it('列− 删掉选中列', () => {
    const { latest } = mount();
    tapCell(1, 1);
    act(() => { barButton('md.colDel').click(); });
    expect(latest()).toBe([
      '| a |',
      '| - |',
      '| 1 |',
      '| 3 |',
    ].join('\n'));
  });

  it('未提交的单元格值先落进源码，再做结构变更（不丢字）', () => {
    const { latest } = mount();
    tapCell(1, 0);
    const input = container!.querySelector('input[data-md-table-tools]') as HTMLInputElement;
    typeInto(input, '99');
    act(() => { barButton('md.rowAdd').click(); });
    expect(latest()).toBe([
      '| a | b |',
      '| - | - |',
      '| 99 | 2 |',
      '|  |  |',
      '| 3 | 4 |',
    ].join('\n'));
  });

  it('动作之后工具条收起，等下一次点选', () => {
    mount();
    tapCell(1, 0);
    act(() => { barButton('md.colAdd').click(); });
    expect(bar()).toBeNull();
  });
});
