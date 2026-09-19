// @vitest-environment jsdom
/**
 * 触屏为主的快捷键提示门控：平板（pointer: coarse）未接物理键盘时右键菜单
 * 不显示 Ctrl+ 提示；HeidBridge 启动时报告已接、或运行中收到 heid-hwkb
 * 事件（外接键盘插拔）才显示。桌面分支（IS_TOUCH_PRIMARY=false 恒显示）
 * 由既有测试隐式覆盖，不在此文件。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* 触屏为主分支：platform 在模块加载期读取，须用 vi.mock 提升到 import 之前 */
vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: true,
  IS_ANDROID_APP: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));

import { ContextMenu, type ContextMenuState } from './ContextMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
}

const menu: ContextMenuState = {
  x: 10,
  y: 10,
  items: [{ label: '撤销', shortcut: 'Ctrl+Z', onSelect: () => {} }],
};

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  delete (window as any).HeidBridge;
});

describe('ContextMenu 快捷键提示（触屏为主）', () => {
  it('未接物理键盘：不显示快捷键提示', () => {
    render(<ContextMenu menu={menu} isDarkMode={false} onClose={() => {}} />);
    expect(container!.textContent).toContain('撤销');
    expect(container!.textContent).not.toContain('Ctrl+Z');
  });

  it('HeidBridge 启动报告已接物理键盘：显示快捷键提示', () => {
    (window as any).HeidBridge = { hwKb: () => true };
    render(<ContextMenu menu={menu} isDarkMode={false} onClose={() => {}} />);
    expect(container!.textContent).toContain('Ctrl+Z');
  });

  it('运行中接入键盘（heid-hwkb 事件）：提示即时出现', () => {
    render(<ContextMenu menu={menu} isDarkMode={false} onClose={() => {}} />);
    expect(container!.textContent).not.toContain('Ctrl+Z');
    act(() => {
      window.dispatchEvent(new CustomEvent('heid-hwkb', { detail: true }));
    });
    expect(container!.textContent).toContain('Ctrl+Z');
  });

  it('运行中拔出键盘（heid-hwkb false）：提示随即隐藏', () => {
    (window as any).HeidBridge = { hwKb: () => true };
    render(<ContextMenu menu={menu} isDarkMode={false} onClose={() => {}} />);
    expect(container!.textContent).toContain('Ctrl+Z');
    act(() => {
      window.dispatchEvent(new CustomEvent('heid-hwkb', { detail: false }));
    });
    expect(container!.textContent).not.toContain('Ctrl+Z');
  });
});
