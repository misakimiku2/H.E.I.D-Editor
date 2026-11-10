// @vitest-environment jsdom
/**
 * 选中粘贴 URL 成链接（第一批第 2 项）。
 * 原生 Ctrl+V 与触屏工具条粘贴共用同一契约：trim 后单行 URL 才包裹。
 * 触屏工具条入口需 IS_ANDROID_APP（pasteAtCursor 共用入口），平台开关在此 mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';

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
  useT: () => (key: string) => key,
}));
vi.mock('../lib/platform', () => ({
  IS_ANDROID_APP: true,
  IS_TOUCH_PRIMARY: false,
}));
vi.mock('../lib/fileOps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/fileOps')>();
  return {
    ...actual,
    readClipboardText: vi.fn(async () => 'https://a.b'),
    clipboardReadPermissionState: vi.fn(async () => 'granted'),
  };
});

import { CodeEditor } from './CodeEditor';

const frame = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('选中粘贴 URL 成链接', () => {
  let host: HTMLElement;
  let root: Root;
  let echoes: string[];

  const content = () => document.querySelector('.cm-content') as HTMLElement;
  const view = () => EditorView.findFromDOM(content());

  const renderEditor = async () => {
    act(() => {
      root.render(<CodeEditor value="text here" language="markdown" isDarkMode={false}
        onChange={(v) => { echoes.push(v); }} />);
    });
    await frame();
    act(() => {
      view()!.dispatch({ selection: { anchor: 0, head: 4 } });
    });
    await frame();
  };

  const paste = (text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => text, items: [] },
    });
    act(() => {
      content().dispatchEvent(event);
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    echoes = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('Ctrl+V：首尾空白 trim 后包裹选区', async () => {
    await renderEditor();
    paste('  https://a.b \n');
    await frame();
    expect(view()!.state.doc.toString()).toBe('[text](https://a.b) here');
  });

  it('Ctrl+V：多行 URL 不包裹，走普通粘贴', async () => {
    await renderEditor();
    paste('https://a.b\nc');
    await frame();
    expect(view()!.state.doc.toString()).toBe('https://a.b\nc here');
  });

  it('Ctrl+V：mailto 保持包裹（不回归）', async () => {
    await renderEditor();
    paste('mailto:a@b.c');
    await frame();
    expect(view()!.state.doc.toString()).toBe('[text](mailto:a@b.c) here');
  });

  it('触屏工具条粘贴同样包裹', async () => {
    await renderEditor();
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent === 'ctx.paste');
    expect(btn).toBeTruthy();
    act(() => { (btn as HTMLButtonElement).click(); });
    await frame();
    expect(view()!.state.doc.toString()).toBe('[text](https://a.b) here');
  });
});