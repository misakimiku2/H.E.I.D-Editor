// @vitest-environment jsdom
/**
 * Phase 3：大文档索引后台预热与生命周期
 * - 打开大文档后空闲预热，首次查找直接复用，不重复构建；
 * - 切换文档释放旧索引；
 * - 编辑后索引失效，再次查找按新内容重建；
 * - 小文档不预热。
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
(HTMLElement.prototype as any).scrollIntoView = () => {};
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
  releaseMdIndex: vi.fn(async (_id: number) => {}),
  renderMarkdownHtmlChunks: vi.fn(async () => null),
}));
vi.mock('../lib/mdSearchBridge', () => bridge);

import { MarkdownPreview } from './MarkdownPreview';

function bigDoc(label = ''): string {
  const parts: string[] = [];
  for (let i = 1; i <= 40; i++) {
    parts.push(`# 第${i}章\n\n${`第${i}章正文${label}。`.repeat(800)}`);
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

interface MountProps {
  docKey?: string;
  findOpen?: boolean;
}

function render(md: string, props: MountProps = {}) {
  root!.render(
    <MarkdownPreview
      content={md}
      docKey={props.docKey}
      isDarkMode={false}
      findOpen={props.findOpen || undefined}
    />,
  );
}

async function mount(md: string, props: MountProps = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { render(md, props); });
  await flush(0);
}

async function rerender(md: string, props: MountProps = {}) {
  await act(async () => { render(md, props); });
  await flush(0);
}

const findInput = () => document.querySelector('input[placeholder="find.placeholderPreview"]') as HTMLInputElement | null;

beforeEach(() => {
  bridge.buildMdIndex.mockReset();
  bridge.searchMdIndex.mockReset();
  bridge.releaseMdIndex.mockReset();
  bridge.renderMarkdownHtmlChunks.mockReset();
  bridge.buildMdIndex.mockResolvedValue({ id: 7, indexMs: 5, reused: false, contentHash: 'h' });
  bridge.releaseMdIndex.mockResolvedValue(undefined);
  bridge.renderMarkdownHtmlChunks.mockResolvedValue(null);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

describe('大文档索引预热', () => {
  it('打开后后台预热，打开查找直接复用索引', async () => {
    const md = bigDoc();
    await mount(md, { docKey: 'tab-a' });

    /* 首屏提交时不能同步构建 */
    expect(bridge.buildMdIndex).not.toHaveBeenCalled();
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 1);
    expect(bridge.buildMdIndex.mock.calls[0][0]).toBe(md);
    expect(bridge.buildMdIndex.mock.calls[0][1]).toContain('tab-a');

    await rerender(md, { docKey: 'tab-a', findOpen: true });
    await waitFor(() => findInput() != null);
    await flush(50);
    expect(bridge.buildMdIndex).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('find.indexing');
  });

  it('切换文档释放旧索引并为新文档重新预热', async () => {
    const docA = bigDoc('甲');
    const docB = bigDoc('乙');
    bridge.buildMdIndex
      .mockResolvedValueOnce({ id: 7, indexMs: 5, reused: false, contentHash: 'a' })
      .mockResolvedValueOnce({ id: 8, indexMs: 5, reused: false, contentHash: 'b' });

    await mount(docA, { docKey: 'tab-a' });
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 1);

    await rerender(docB, { docKey: 'tab-b' });
    await waitFor(() => bridge.releaseMdIndex.mock.calls.some(([id]) => id === 7));
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 2);
    expect(bridge.buildMdIndex.mock.calls[1][0]).toBe(docB);
    expect(bridge.buildMdIndex.mock.calls[1][1]).toContain('tab-b');
  });

  it('编辑后索引失效，再次查找按新内容重建', async () => {
    const md = bigDoc();
    const edited = `${md}\n\n新增段落`;
    await mount(md, { docKey: 'tab-a' });
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 1);

    /* 渲染内容有 180ms 防抖，等旧索引被判定过期并释放 */
    await rerender(edited, { docKey: 'tab-a' });
    await waitFor(() => bridge.releaseMdIndex.mock.calls.some(([id]) => id === 7));
    expect(bridge.buildMdIndex).toHaveBeenCalledTimes(1);

    await rerender(edited, { docKey: 'tab-a', findOpen: true });
    await waitFor(() => bridge.buildMdIndex.mock.calls.length === 2);
    expect(bridge.buildMdIndex.mock.calls[1][0]).toBe(edited);
  });

  it('小文档不预热', async () => {
    await mount('# 小文档\n\n一段正文', { docKey: 'small' });
    await flush(600);
    expect(bridge.buildMdIndex).not.toHaveBeenCalled();
  });
});
