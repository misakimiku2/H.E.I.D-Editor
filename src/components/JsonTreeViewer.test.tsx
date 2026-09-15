// @vitest-environment jsdom
/**
 * JsonTreeViewer 组件冒烟：树渲染（默认两层展开 / 折叠摘要 / 计数徽标）、
  展开收起交互、解析失败横幅与切回文本入口。纯函数逻辑在 lib/jsonTree.test.ts 覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));
vi.mock('../lib/fileOps', () => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));

import { JsonTreeViewer } from './JsonTreeViewer';

let root: Root | null = null;
const mount = async (props: Parameters<typeof JsonTreeViewer>[0]) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<JsonTreeViewer {...props} />); });
  return host;
};

afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null; }
  document.body.innerHTML = '';
});

/** 等待异步解析（YAML 动态 import）完成：轮询直到谓词为真或超时 */
const waitUntil = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  }
  return pred();
};

describe('JsonTreeViewer', () => {
  it('渲染对象树：默认展开 root 层、深层折叠显示计数与摘要', async () => {
    const host = await mount({
      content: '{"a":{"b":[1,2,"x"]},"s":"hi"}',
      kind: 'json',
      isDarkMode: false,
    });
    await waitUntil(() => host.textContent!.includes('a:'));
    // root 与其子节点默认展开
    expect(host.textContent).toContain('a:');
    expect(host.textContent).toContain('[3]');
    // 深层（a 的子节点 b）默认折叠：显示摘要而非元素
    expect(host.textContent).toContain('b:');
    expect(host.textContent).toContain('[ 1, 2, x ]');
    // 顶层标量直接显示
    expect(host.textContent).toContain('hi');
  });

  it('点击分支切换展开；全部收起清空展开态', async () => {
    const host = await mount({
      content: '{"a":[1]}',
      kind: 'json',
      isDarkMode: false,
    });
    await waitUntil(() => host.textContent!.includes('a:'));
    expect(host.textContent).toContain('[1]');
    await act(async () => {
      host.querySelector('[data-testid="json-collapse-all"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).toContain('{1}');
    expect(host.textContent).not.toContain('a:');
  });

  it('解析失败显示错误横幅与切回文本按钮', async () => {
    const onFallback = vi.fn();
    const host = await mount({ content: '{oops', kind: 'json', isDarkMode: false, onFallbackText: onFallback });
    await waitUntil(() => !!host.querySelector('[data-testid="json-fallback-text"]'));
    const btn = host.querySelector('[data-testid="json-fallback-text"]');
    expect(btn).toBeTruthy();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onFallback).toHaveBeenCalled();
  });

  it('YAML 内容同样进树（懒加载 js-yaml）', async () => {
    const host = await mount({ content: 'a: 1\nb: [x]', kind: 'yaml', isDarkMode: true });
    await waitUntil(() => host.textContent!.includes('a:'));
    expect(host.textContent).toContain('a:');
    expect(host.textContent).toContain('1');
  });
});
