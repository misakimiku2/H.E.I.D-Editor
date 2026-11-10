// @vitest-environment jsdom
/**
 * 选区高亮层不吃点击（桌面「全选后点不动」回归）。
 *
 * CodeMirror 给 .cm-selectionLayer 设内联 z-index:-1，让它画在文字下方；
 * 本应用的 fixSelectionLayer 会移除这个内联 z-index（视觉上调过的），于是
 * 绝对定位的高亮层盖在 position:static 的 .cm-content 之上，且默认
 * pointer-events:auto —— 点击落在高亮 div（.cm-content 的兄弟节点）上，
 * 事件到不了 CodeMirror，选区永远收不起来。全选时整屏文字都被盖住，
 * 只有首行上方/末行下方没被高亮覆盖的空白还能点，症状与用户描述一致。
 * 与 CM 自己的 .cm-cursorLayer 同样处理：pointer-events:none 让点击穿透。
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

import { CodeEditor } from './CodeEditor';

const frame = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('CodeEditor 选区高亮层点击穿透', () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('选区高亮层 pointer-events 为 none，点击能落到文字上', async () => {
    act(() => {
      root.render(<CodeEditor value={'第一行\n第二行'} language="markdown" isDarkMode={false} onChange={() => {}} />);
    });
    await frame();

    const layer = document.querySelector('.cm-selectionLayer') as HTMLElement | null;
    expect(layer).not.toBeNull();
    /* 前置：jsdom 能解析主题注入的样式表（否则下面的断言没有意义） */
    const content = document.querySelector('.cm-content') as HTMLElement;
    expect(getComputedStyle(content).paddingTop).toBe('12px');

    expect(getComputedStyle(layer!).pointerEvents).toBe('none');
  });
});