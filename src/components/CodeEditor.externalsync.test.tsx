// @vitest-environment jsdom
/**
 * 外部内容替换冒烟（撤销/重做、还原到磁盘等经 value prop 替换整篇内容的路径）：
 * ① value prop 变化时局部同步进 CodeMirror，onChange 回声与新值一致；
 * ② 同值重渲染不触发多余 dispatch（回声不再变化，避免撤销历史自污染）。
 * 滚动保持依赖 CM 对局部 changes 的视口映射，jsdom 无布局，不在此断言。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* jsdom 缺失的 API：CM6 量测需要 ResizeObserver，建视图需要 matchMedia */
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

describe('CodeEditor 外部内容替换', () => {
  let host: HTMLElement;
  let root: Root;
  let echoes: string[];

  const renderWith = (value: string) => {
    act(() => {
      root.render(
        <CodeEditor
          value={value}
          language="plaintext"
          isDarkMode={false}
          onChange={(v) => { echoes.push(v); }}
        />
      );
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    echoes = [];
  });

  it('value prop 变化（模拟撤销）后文档同步为新值并回声 onChange', async () => {
    const docA = '第一行\n第二行\n尾部段落';
    const docB = '第一行\n第二行\n'; /* 模拟撤销掉尾部的粘贴块 */
    renderWith(docA);
    await frame();
    renderWith(docB);
    await frame();
    expect(echoes).toContain(docB);
    renderWith(docB); /* 同值重渲染不再回声（无多余 dispatch） */
    await frame();
    expect(echoes.filter(v => v === docB)).toHaveLength(1);
  });

  it('中间插入的外部替换也能同步（公共前后缀定位变化区间）', async () => {
    const docA = '头部\n旧内容\n尾部';
    const docB = '头部\n新内容\n尾部';
    renderWith(docA);
    await frame();
    renderWith(docB);
    await frame();
    expect(echoes).toContain(docB);
  });
});
