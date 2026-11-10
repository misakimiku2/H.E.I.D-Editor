// @vitest-environment jsdom
/**
 * 编辑器 Ctrl+A 全选（桌面跳顶回归）。
 *
 * 与 Enter 同一类问题：basicSetup={false} 手工组装扩展，没有 defaultKeymap，
 * Mod-a 此前未绑定。桌面浏览器对 contenteditable 做原生全选后，CodeMirror 的
 * DOM  observer 把选区读回状态时附带 scrollIntoView:true（head 落在文档开头），
 * 视口被钳回顶部；读回的反向选区还与 DOM 选区错位，点击选区内文字无法正常收起。
 * 绑定官方 selectAll 命令后：选区 0..doc.length、无 scrollIntoView，两个症状都消失。
 * jsdom 没有原生全选，这里断言的正是「键位自己把全选做掉了，且不请求滚动」。
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

describe('CodeEditor Ctrl+A 全选', () => {
  let host: HTMLElement;
  let root: Root;

  const content = () => document.querySelector('.cm-content') as HTMLElement;
  const view = () => EditorView.findFromDOM(content());

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('Ctrl+A 由键位表接管，选中整篇文档且不请求滚动', async () => {
    const doc = '第一行内容\n第二行内容\n第三行内容';
    act(() => {
      root.render(<CodeEditor value={doc} language="markdown" isDarkMode={false} onChange={() => {}} />);
    });
    await frame();

    const v = view()!;
    /* 光标放在文档中部，模拟滚动到中间后全选的真实场景 */
    act(() => {
      content().focus();
      v.dispatch({ selection: { anchor: v.state.doc.line(2).from } });
    });

    /* 捕获全选事务是否携带 scrollIntoView（跳顶的根因就是它为 true） */
    let scrollRequested = false;
    const origDispatch = v.dispatch.bind(v);
    v.dispatch = ((...args: Parameters<typeof origDispatch>) => {
      for (const tr of args) {
        if (tr && typeof tr === 'object' && 'scrollIntoView' in tr && tr.scrollIntoView) scrollRequested = true;
      }
      return origDispatch(...args);
    }) as typeof v.dispatch;

    let handled = false;
    act(() => {
      const e = new KeyboardEvent('keydown', {
        key: 'a', keyCode: 65, ctrlKey: true, bubbles: true, cancelable: true,
      });
      content().dispatchEvent(e);
      handled = e.defaultPrevented;
    });
    await frame();

    expect(handled).toBe(true);
    const sel = v.state.selection.main;
    expect(sel.from).toBe(0);
    expect(sel.to).toBe(doc.length);
    expect(sel.anchor).toBe(0);
    expect(sel.head).toBe(doc.length);
    expect(scrollRequested).toBe(false);
  });
});