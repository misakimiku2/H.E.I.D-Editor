// @vitest-environment jsdom
/**
 * 大文档极速预览（Phase 2）：
 * - 只在分块大文档 + Tauri 桌面端出现入口；
 * - 进入后按可见块批量渲染 Rust HTML，不挂 ReactMarkdown；
 * - 查找导航会优先取目标块 HTML，就绪后滚动并高亮；
 * - 渲染失败显示错误并可切回完整预览。
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
  renderMarkdownHtmlChunks: vi.fn(),
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

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const findInput = () => document.querySelector('input[placeholder="find.placeholderPreview"]') as HTMLInputElement;
const countText = () => findInput().parentElement!.querySelector('span')!.textContent;
const navNext = () => document.querySelector('button[aria-label="find.nextMatch"]') as HTMLButtonElement;

const setNativeValue = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  bridge.buildMdIndex.mockReset();
  bridge.searchMdIndex.mockReset();
  bridge.releaseMdIndex.mockReset();
  bridge.renderMarkdownHtmlChunks.mockReset();
  bridge.buildMdIndex.mockResolvedValue({ id: 7, indexMs: 5, reused: false, contentHash: 'h' });
  bridge.releaseMdIndex.mockResolvedValue(undefined);
  bridge.renderMarkdownHtmlChunks.mockImplementation(async (chunks: string[]) =>
    chunks.map((md) => `<p>FAST ${md.includes(MARKER) ? MARKER : md.slice(0, 10).replace(/[<>&]/g, '')}</p>`));
  scrollIntoView.mockReset();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

describe('大文档极速预览', () => {
  it('入口只在分块大文档出现；进入后渲染 Rust HTML，可切回完整预览', async () => {
    const md = bigDoc();
    await mount(md);
    expect(buttonByText('md.fastPreview')).toBeTruthy();
    act(() => { buttonByText('md.fastPreview')!.click(); });
    await waitFor(() => bridge.renderMarkdownHtmlChunks.mock.calls.length > 0);
    await waitFor(() => host!.textContent!.includes('FAST'));
    /* 极速模式只渲染 Rust HTML，不再挂 ReactMarkdown 的块 */
    expect(host!.textContent).toContain('md.fastPreviewOn');
    expect(document.querySelectorAll('.heid-fast-md').length).toBeGreaterThan(0);

    act(() => { buttonByText('md.fastPreviewSwitch')!.click(); });
    await flush(0);
    expect(buttonByText('md.fastPreview')).toBeTruthy();
    /* 顶部明确显示当前已是完整预览，避免纯文字下看起来「切了没反应」 */
    expect(host!.textContent).toContain('md.fullPreviewOn');
    expect(host!.textContent).not.toContain('md.fastPreviewOn');
    /* 切回完整预览后首屏仍是第 1 章（ReactMarkdown 路径） */
    await waitFor(() => host!.textContent!.includes('第1章'));
  });

  it('小文档不显示极速预览入口', async () => {
    await mount('# 小文档\n\n内容');
    expect(buttonByText('md.fastPreview')).toBeUndefined();
  });

  it('向下滚动收起模式栏，鼠标回到顶部才浮出', async () => {
    const md = bigDoc();
    await mount(md);
    const scroller = host!.querySelector('[data-md-preview]') as HTMLDivElement;
    const bar = () => host!.querySelector('[data-testid="md-mode-bar"]') as HTMLElement;
    expect(bar().getAttribute('aria-hidden')).toBeNull();

    Object.defineProperty(scroller, 'scrollTop', { value: 200, writable: true, configurable: true });
    await act(async () => { scroller.dispatchEvent(new Event('scroll')); });
    await flush(0);
    expect(bar().getAttribute('aria-hidden')).toBe('true');

    /* 鼠标进入预览顶部区域：浮出 */
    await act(async () => {
      scroller.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 10 }));
    });
    await flush(0);
    expect(bar().getAttribute('aria-hidden')).toBeNull();

    /* 鼠标离开顶部：再次收起 */
    await act(async () => {
      scroller.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 200 }));
    });
    await flush(0);
    expect(bar().getAttribute('aria-hidden')).toBe('true');

    /* 回到文档顶部：常显 */
    (scroller as unknown as { scrollTop: number }).scrollTop = 0;
    await act(async () => { scroller.dispatchEvent(new Event('scroll')); });
    await flush(0);
    expect(bar().getAttribute('aria-hidden')).toBeNull();
  });

  it('查找导航优先取目标块 HTML，渲染后滚动并高亮', async () => {
    const md = bigDoc();
    const start = md.indexOf(MARKER);
    bridge.searchMdIndex.mockResolvedValue({
      total: 1, capped: false, indexMs: 5, searchMs: 1, error: null,
      matches: [{
        sourceStart: start, sourceEnd: start + MARKER.length,
        text: MARKER, textTruncated: false, snippet: MARKER,
      }],
    });
    await mount(md, true);
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 1);
    act(() => { buttonByText('md.fastPreview')!.click(); });
    await waitFor(() => host!.textContent!.includes('FAST'));
    expect(host!.textContent).not.toContain('FAST 末尾独有标记');

    await act(async () => { setNativeValue(findInput(), MARKER); });
    await waitFor(() => bridge.searchMdIndex.mock.calls.length > 0);
    await waitFor(() => countText() === '1');
    await act(async () => { navNext().click(); });
    await waitFor(() => host!.textContent!.includes(`FAST ${MARKER}`));
    await waitFor(() => countText() === '1/1');
    expect(scrollIntoView).toHaveBeenCalled();
    /* 目标块的 md 被优先送去渲染 */
    const sent = bridge.renderMarkdownHtmlChunks.mock.calls.flatMap((call) => call[0] as string[]);
    expect(sent.some((chunk) => chunk.includes(MARKER))).toBe(true);
  });

  it('Rust HTML 渲染失败显示错误并可切回完整预览', async () => {
    bridge.renderMarkdownHtmlChunks.mockResolvedValue(null);
    const md = bigDoc();
    await mount(md);
    act(() => { buttonByText('md.fastPreview')!.click(); });
    await waitFor(() => host!.textContent!.includes('md.fastPreviewFailed'));
    act(() => { buttonByText('md.fastPreviewSwitch')!.click(); });
    await flush(0);
    expect(buttonByText('md.fastPreview')).toBeTruthy();
    expect(host!.textContent).toContain('第1章');
  });
});
