// @vitest-environment jsdom
/**
 * 桌面 WebView2 原生右键菜单的兜底屏蔽：应用自有菜单的区域（编辑器、文件树、预览）
 * 各自 preventDefault，欢迎页/状态栏/侧栏空白这些没接管右键的地方由这里压掉，
 * 否则右键就漏出浏览器的「刷新 / 另存为 / 打印」页面菜单。
 * input / textarea 是例外——那里的原生菜单是剪切/复制/粘贴，链接与搜索框靠它粘贴。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/fileIO', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: true,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { usePlatformIntegration, type OverlayActions, type OverlayState } from './usePlatformIntegration';

/** 只关心右键那一条 effect，其余入参给不会炸的占位 */
function Probe() {
  const tabsRef = useRef<{ isDirty: boolean }[]>([]);
  const confirmWindowCloseRef = useRef<() => Promise<boolean>>(async () => false);
  usePlatformIntegration({
    openPathIntoTab: async () => {},
    openPathFromExternal: async () => {},
    openSharedText: () => {},
    hydrated: true,
    tabsRef,
    confirmWindowCloseRef,
    overlayState: {} as OverlayState,
    overlayActions: {} as OverlayActions,
  });
  return (
    <div>
      <div data-testid="blank">打开一个文件开始编辑</div>
      <input data-testid="field" />
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Probe />); });
}

function fire(el: HTMLElement): boolean {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(e); });
  return e.defaultPrevented;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('桌面原生右键菜单兜底', () => {
  it('没接管右键的空白区域：原生页面菜单被压掉', () => {
    mount();
    expect(fire(container!.querySelector('[data-testid="blank"]')!)).toBe(true);
  });

  it('输入框例外：原生剪切/复制/粘贴菜单保持可用', () => {
    mount();
    expect(fire(container!.querySelector('[data-testid="field"]')!)).toBe(false);
  });

  it('卸载后不再拦截右键', () => {
    mount();
    const blank = container!.querySelector('[data-testid="blank"]')!;
    expect(fire(blank as HTMLElement)).toBe(true);
    act(() => { root!.unmount(); });
    root = null;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
