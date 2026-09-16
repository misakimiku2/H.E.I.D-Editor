// @vitest-environment jsdom
/**
 * 查找浮层冒烟：挂载（Ctrl+F 打开）后查找输入框自动聚焦。
 * 首帧浮层按指针定位前是 visibility:hidden，hidden 下 focus() 静默无效——
 * 聚焦必须等位置就绪，此测试锁住该行为。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));

import { FindReplaceBar } from './FindReplaceBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
}

const baseProps = {
  getView: () => null,
  isDarkMode: false,
  showReplace: false,
  gotoMode: false,
  canReplace: false,
  onClose: () => {},
};

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

describe('FindReplaceBar 自动聚焦', () => {
  it('挂载后查找输入框获得焦点并全选', () => {
    render(<FindReplaceBar {...baseProps} />);
    const input = document.body.querySelector('input[placeholder="find.placeholderFind"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('跳行模式聚焦行号输入框', () => {
    render(<FindReplaceBar {...baseProps} gotoMode />);
    const input = document.body.querySelector('input[placeholder="find.placeholderGoto"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });
});
