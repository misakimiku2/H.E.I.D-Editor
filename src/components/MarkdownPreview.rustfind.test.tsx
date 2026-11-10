// @vitest-environment jsdom
/**
 * 大文档 Rust 查找接入：
 * - 索引就绪后打开查找不补载全文，计数来自 Rust；
 * - 导航时才扩渲染到命中块并滚动；
 * - 建索引失败自动回退现有「补载全文 + DOM 扫描」；
 * - 预览卸载时释放索引。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class IdleIO {
  constructor(_cb: unknown, _opts?: unknown) {}
  observe() {}
  disconnect() {}
  unobserve() {}
}
(globalThis as any).IntersectionObserver = IdleIO;
(HTMLElement.prototype as any).scrollTo = () => {};
const scrollIntoView = vi.fn();
(HTMLElement.prototype as any).scrollIntoView = scrollIntoView;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
(globalThis as any).cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);

vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: false,
  IS_ANDROID_APP: false,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));
vi.mock('../lib/fileIO', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauri: true,
}));
const bridge = vi.hoisted(() => ({
  buildMdIndex: vi.fn(),
  searchMdIndex: vi.fn(),
  releaseMdIndex: vi.fn(async () => {}),
}));
vi.mock('../lib/mdSearchBridge', () => bridge);

import { MarkdownPreview } from './MarkdownPreview';

const MARKER = '末尾独有标记';

function bigDoc(): string {
  const parts: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const tail = i === 40 ? `\n\n${MARKER}` : '';
    parts.push(`# 第${i}章\n\n${`第${i}章正文。`.repeat(800)}${tail}`);
  }
  return parts.join('\n\n');
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function flush(ms = 0) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/** 条件轮询：高负载下固定 sleep 会偶发失败 */
async function waitFor(cond: () => boolean, timeoutMs = 4000) {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await flush(10);
  }
}

async function mount(md: string, findOpen = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MarkdownPreview content={md} isDarkMode={false} findOpen={findOpen || undefined} />,
    );
  });
  await flush(0);
}

const findInput = () => document.querySelector('input[placeholder="find.placeholderPreview"]') as HTMLInputElement;
const countText = () => findInput().parentElement!.querySelector('span')!.textContent;
const navNext = () => document.querySelector('button[aria-label="find.nextMatch"]') as HTMLButtonElement;

const setNativeValue = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

function mockHit(md: string) {
  const start = md.indexOf(MARKER);
  bridge.searchMdIndex.mockResolvedValue({
    total: 1,
    capped: false,
    indexMs: 5,
    searchMs: 1,
    error: null,
    matches: [{
      sourceStart: start,
      sourceEnd: start + MARKER.length,
      text: MARKER,
      textTruncated: false,
      snippet: MARKER,
    }],
  });
}

beforeEach(() => {
  bridge.buildMdIndex.mockReset();
  bridge.searchMdIndex.mockReset();
  bridge.releaseMdIndex.mockReset();
  bridge.buildMdIndex.mockResolvedValue({ id: 7, indexMs: 5, reused: false, contentHash: 'h' });
  bridge.releaseMdIndex.mockResolvedValue(undefined);
  scrollIntoView.mockReset();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

describe('大文档 Rust 查找', () => {
  it('索引就绪后不补载全文，导航时才渲染命中块', async () => {
    const md = bigDoc();
    mockHit(md);
    await mount(md, true);
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 1);
    expect(bridge.buildMdIndex.mock.calls[0][0]).toBe(md);
    /* 索引构建/就绪期间都不该把第 40 章渲染进 DOM */
    expect(host!.textContent).not.toContain('第40章');

    await act(async () => { setNativeValue(findInput(), MARKER); });
    await waitFor(() => bridge.searchMdIndex.mock.calls.length > 0);
    expect(bridge.searchMdIndex).toHaveBeenCalledWith(7, expect.objectContaining({ query: MARKER }));
    await waitFor(() => countText() === '1');
    expect(host!.textContent).not.toContain('第40章');

    await act(async () => { navNext().click(); });
    await waitFor(() => host!.textContent!.includes('第40章'));
    await waitFor(() => countText() === '1/1');
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('建索引失败自动回退补载全文 + DOM 扫描', async () => {
    const md = bigDoc();
    bridge.buildMdIndex.mockResolvedValue(null);
    await mount(md, true);
    await waitFor(() => host!.textContent!.includes('第40章'));
    await act(async () => { setNativeValue(findInput(), MARKER); });
    await waitFor(() => countText() === '1');
    expect(bridge.searchMdIndex).not.toHaveBeenCalled();
  });

  it('预览卸载时释放 Rust 索引', async () => {
    const md = bigDoc();
    mockHit(md);
    await mount(md, true);
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 1);
    act(() => { root?.unmount(); });
    root = null;
    await waitFor(() => bridge.releaseMdIndex.mock.calls.length > 0);
    expect(bridge.releaseMdIndex).toHaveBeenCalledWith(7);
  });
});
