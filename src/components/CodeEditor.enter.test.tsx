// @vitest-environment jsdom
/**
 * 编辑器回车键位（v1.4.1 真机回归）。
 *
 * 为什么要专门测它：CodeEditor 用 basicSetup={false} 手工组装扩展，此前既没有
 * defaultKeymap 也没有别的 Enter 绑定——桌面看起来能换行，只是因为浏览器对
 * contenteditable 做了默认插入、CodeMirror 再同步 DOM 结果。安卓 WebView ≥126 上
 * CodeMirror 改走 EditContext 通路，浏览器不再做任何默认编辑，回车就成了空按键
 * （Tab S8 + Gboard 实测：keydown 到达、未被 preventDefault、文档行数不变）。
 * jsdom 同样没有浏览器的默认插入，所以这里断言的正是「键位自己把换行做掉了」。
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

describe('CodeEditor 回车换行', () => {
  let host: HTMLElement;
  let root: Root;
  let echoes: string[];

  const content = () => document.querySelector('.cm-content') as HTMLElement;

  const view = () => EditorView.findFromDOM(content());

  /** 把光标放到文档末尾再敲键，模拟真实按键路径（keydown 落在 contentDOM 上） */
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const dom = content();
    act(() => {
      dom.focus();
      view()!.dispatch({ selection: { anchor: view()!.state.doc.length } });
      dom.dispatchEvent(new KeyboardEvent('keydown', {
        key, keyCode: key === 'Enter' ? 13 : 0, bubbles: true, cancelable: true, ...init,
      }));
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    echoes = [];
  });

  /* 每个用例单独卸载：querySelector('.cm-content') 只取文档里第一个编辑器，
     上一用例残留的实例会把断言引到已死的视图上 */
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('Enter 插入换行（无浏览器默认编辑可依赖时仍然换行）', async () => {
    act(() => {
      root.render(<CodeEditor value="ab" language="plaintext" isDarkMode={false}
        onChange={(v) => { echoes.push(v); }} />);
    });
    await frame();
    expect(view()!.state.doc.lines).toBe(1);
    press('Enter');
    await frame();
    expect(view()!.state.doc.lines).toBe(2);
    expect(echoes[echoes.length - 1]).toBe('ab\n');
  });

  it('Shift-Enter 同样换行', async () => {
    act(() => {
      root.render(<CodeEditor value="x" language="plaintext" isDarkMode={false}
        onChange={(v) => { echoes.push(v); }} />);
    });
    await frame();
    press('Enter', { shiftKey: true });
    await frame();
    expect(view()!.state.doc.lines).toBe(2);
  });

  it('换行续上当前行缩进（insertNewlineAndIndent 语义）', async () => {
    act(() => {
      root.render(<CodeEditor value={'    deep'} language="plaintext" isDarkMode={false}
        onChange={(v) => { echoes.push(v); }} />);
    });
    await frame();
    press('Enter');
    await frame();
    expect(view()!.state.doc.line(2).text).toBe('    ');
  });
});
