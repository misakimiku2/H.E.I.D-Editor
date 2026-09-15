// @vitest-environment jsdom
/**
 * 剪贴板权限冒烟：浏览器（非 Tauri）环境下
 * ① 打开右键菜单不得调 navigator.clipboard.readText（会弹「查看剪贴板」授权框），
 *    改为只读权限查询；
 * ② 权限已授予时菜单粘贴经 readText 插入文本；
 * ③ 权限未授予时菜单粘贴静默降级（聚焦编辑器，等原生 Ctrl+V），不调 readText。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* jsdom 缺失的 API：CM6 量测需要 ResizeObserver，CodeEditor 建视图需要 matchMedia，
   coordsAtPos 需要 DOM Range 的矩形接口（jsdom 无布局，返回零矩形即可） */
(window as any).ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
(window as any).matchMedia = (query: string) => ({
  matches: false, media: query,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
const zeroRect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
const rangeProto = Range.prototype as any;
if (!rangeProto.getClientRects) {
  rangeProto.getClientRects = function () { return [zeroRect]; };
}
if (!rangeProto.getBoundingClientRect) {
  rangeProto.getBoundingClientRect = function () { return zeroRect; };
}

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

import { CodeEditor } from './CodeEditor';

const readTextSpy = vi.fn(() => Promise.resolve(''));
const queryPermission = vi.fn(() => Promise.resolve({ state: 'prompt' } as PermissionStatus));

const setNavigator = (key: string, value: unknown) => {
  Object.defineProperty(window.navigator, key, { value, configurable: true });
};

const frame = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('CodeEditor 剪贴板权限', () => {
  let host: HTMLElement;
  let root: Root;
  let latest: string;

  const renderEditor = (value: string) => {
    act(() => {
      root.render(
        <CodeEditor
          value={value}
          language="plaintext"
          isDarkMode={false}
          onChange={(v) => { latest = v; renderEditor(v); }}
        />,
      );
    });
  };

  const openContextMenu = () => {
    act(() => {
      (host.querySelector('.cm-editor') as HTMLElement)
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
  };

  const pasteBtn = () => host.querySelector('button[title="ctx.paste"]') as HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latest = '';
    readTextSpy.mockClear().mockResolvedValue('');
    queryPermission.mockClear().mockResolvedValue({ state: 'prompt' } as PermissionStatus);
    setNavigator('clipboard', { readText: readTextSpy });
    setNavigator('permissions', { query: queryPermission });
    renderEditor('abc');
  });

  it('打开右键菜单：只做权限查询，不调 readText', async () => {
    openContextMenu();
    await frame();
    expect(pasteBtn()).not.toBeNull();
    expect(queryPermission).toHaveBeenCalledWith({ name: 'clipboard-read' });
    expect(readTextSpy).not.toHaveBeenCalled();
  });

  it('权限已授予：菜单粘贴经 readText 插入文本', async () => {
    openContextMenu();
    await frame();
    queryPermission.mockResolvedValue({ state: 'granted' } as PermissionStatus);
    readTextSpy.mockResolvedValue('hello');
    act(() => { pasteBtn().click(); });
    await frame();
    expect(readTextSpy).toHaveBeenCalledTimes(1);
    expect(latest).toBe('helloabc');
  });

  it('权限未授予：菜单粘贴静默降级，不调 readText', async () => {
    openContextMenu();
    await frame();
    act(() => { pasteBtn().click(); });
    await frame();
    expect(readTextSpy).not.toHaveBeenCalled();
    /* onChange 未触发 = 文档未变 */
    expect(latest).toBe('');
    const content = host.querySelector('.cm-content') as HTMLElement;
    expect(content.contains(document.activeElement)).toBe(true);
  });
});
