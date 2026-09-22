// @vitest-environment jsdom
/**
 * 颜色圆点冒烟：CodeEditor 渲染含颜色字面量的文档后
 * ① 可见视口内每个颜色值前出现 .cm-colorDot 圆点（含函数式颜色）；
 * ② 点击圆点弹出取色器浮层（data-color-picker）；
 * ③ 浮层 Hex 输入新颜色 → onChange 回调收到按原格式回写后的文本；
 * ④ Escape 关闭浮层。
 * 识别/序列化纯逻辑在 lib/colorLiteral.test.ts 覆盖。
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
import { EditorState } from '@codemirror/state';
import { colorLiteralCovering } from './colorDotExtension';

const frame = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('CodeEditor 颜色圆点', () => {
  let host: HTMLElement;
  let root: Root;
  let latestValue: string;

  const renderEditor = (value: string) => {
    act(() => {
      root.render(
        <CodeEditor
          value={value}
          language="css"
          isDarkMode={false}
          onChange={(v) => { latestValue = v; renderEditor(v); }}
        />,
      );
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latestValue = '';
    return () => {
      act(() => root.unmount());
      host.remove();
    };
  });

  const dots = () => host.querySelectorAll('.cm-colorDot');

  it('视口内颜色值前渲染圆点，点击弹出取色器', async () => {
    renderEditor('a: #f00;\nb: rgb(1, 2, 3);\nc: plain text;\n');
    await frame();

    expect(dots().length).toBe(2);
    /* 圆点内联在行内容里，与颜色值同行 */
    const line1 = host.querySelectorAll('.cm-line')[0];
    expect(line1.querySelector('.cm-colorDot')).not.toBeNull();
    expect(line1.textContent).toContain('#f00');

    act(() => {
      dots()[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-color-picker]')).not.toBeNull();
  });

  it('Hex 输入新颜色实时回写源码（保留原格式家族）', async () => {
    renderEditor('a: rgb(1, 2, 3);\n');
    await frame();

    act(() => {
      dots()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    const input = host.querySelector('[data-color-picker] input') as HTMLInputElement;
    expect(input).not.toBeNull();

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, '#00ff00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    /* rgb() 不变成 hex：家族保持 */
    expect(latestValue).toBe('a: rgb(0, 255, 0);\n');
  });

  it('Escape 关闭取色器', async () => {
    renderEditor('a: #4ec9b0;\n');
    await frame();

    act(() => {
      dots()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-color-picker]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(host.querySelector('[data-color-picker]')).toBeNull();
  });
});

/* 触屏上圆点撑不到 48dp（一行才 19.6dp），取色改由选区工具条的「取色」按钮承担：
   长按只会选中 `ff6a00` 这种不含 `#` 的词，所以按重叠找、按整条回 */
describe('colorLiteralCovering：选区压在哪条颜色上', () => {
  it('只选中了 ff6a00（不含 #）也返回整条 #ff6a00', () => {
    const doc = '.a {\n  color: #ff6a00;\n}\n';
    const from = doc.indexOf('ff6a00');
    const r = colorLiteralCovering(EditorState.create({ doc }), from, from + 3);
    expect(doc.slice(r?.from ?? -1, r?.to ?? -1)).toBe('#ff6a00');
  });

  it('函数式颜色 rgba(...) 也能命中', () => {
    const doc = 'x { background: rgba(12, 200, 90, 0.5); }';
    const from = doc.indexOf('200');
    const r = colorLiteralCovering(EditorState.create({ doc }), from, from + 1);
    expect(r).not.toBeNull();
    expect(doc.slice(r!.from).startsWith('rgba(')).toBe(true);
  });

  it('选区没压在颜色上返回 null', () => {
    const doc = '.a {\n  color: #ff6a00;\n}\n';
    expect(colorLiteralCovering(EditorState.create({ doc }), 0, 2)).toBeNull();
  });
});
