// @vitest-environment jsdom
/**
 * 超大文档分块预览：首屏只渲染前几块（不整篇解析），剩余内容由滚动/大纲跳转续载。
 * IntersectionObserver 在 jsdom 里不存在，用永不触发的假实现模拟「还没滚到底」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: false,
  IS_ANDROID_APP: false,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class IdleIO {
  constructor(_cb: unknown, _opts?: unknown) {}
  observe() {}
  disconnect() {}
  unobserve() {}
}
(globalThis as any).IntersectionObserver = IdleIO;
(HTMLElement.prototype as any).scrollTo = () => {};

import { MarkdownPreview, type MarkdownPreviewHandle } from './MarkdownPreview';

/** 40 章、每章几千字，总计 > 15 万字符，触发分块预览 */
function bigDoc(): string {
  const parts: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const tail = i === 40 ? '\n\n末尾独有标记' : '';
    parts.push(`# 第${i}章\n\n${`第${i}章正文。`.repeat(800)}${tail}`);
  }
  return parts.join('\n\n');
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(content: string, findOpen = false) {
  act(() => { root?.unmount(); });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = React.createRef<MarkdownPreviewHandle>();
  act(() => {
    root!.render(
      <MarkdownPreview ref={ref} content={content} isDarkMode={false}
        findOpen={findOpen || undefined} />,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return ref;
}

const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('超大文档分块预览', () => {
  it('首屏只渲染少量块，末尾出现续载提示', async () => {
    const md = bigDoc();
    expect(md.length).toBeGreaterThan(150_000);
    await mount(md);
    expect(container!.textContent).toContain('第1章');
    expect(container!.textContent).not.toContain('第40章');
    expect(container!.textContent).toContain('md.loadMore');
  });

  it('大纲跳到未渲染的远块：先补渲染再滚动', async () => {
    const md = bigDoc();
    const offset = md.indexOf('# 第30章');
    const ref = await mount(md);
    expect(container!.textContent).not.toContain('第30章');
    await act(async () => {
      ref.current!.scrollToOffset(offset);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container!.textContent).toContain('第30章');
    expect(container!.textContent).not.toContain('第40章');
  });

  it('打开查找会补载全文，末尾未滚动到的内容也能搜到', async () => {
    const md = bigDoc();
    await mount(md, true);
    /* 查找打开后分批补渲染剩余块 */
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(container!.textContent).toContain('第40章');
    expect(container!.textContent).not.toContain('md.loadMore');

    const input = document.querySelector('input[placeholder="find.placeholderPreview"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => { setNativeValue(input, '末尾独有标记'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const countEl = input.parentElement!.querySelector('span')!;
    expect(countEl.textContent).toBe('1');
  });
});
