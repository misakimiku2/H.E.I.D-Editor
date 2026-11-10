// @vitest-environment jsdom
/**
 * 预览查找栏的外部搜索引擎适配（大文档 Rust 索引）：
 * 构建中显示索引提示并禁用导航；就绪后计数/导航完全由外部引擎驱动；
 * 引擎失败时回退到容器 DOM 扫描，功能不退化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { PreviewFindBar, type PreviewFindExternal } from './PreviewFindBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let container: HTMLElement | null = null;

const setNativeValue = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(external: PreviewFindExternal) {
  act(() => { root?.unmount(); });
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  container = document.createElement('div');
  const p1 = document.createElement('p');
  p1.textContent = 'hello hello';
  const p2 = document.createElement('p');
  p2.textContent = 'hello';
  container.appendChild(p1);
  container.appendChild(p2);
  root = createRoot(host);
  act(() => {
    root!.render(
      <PreviewFindBar
        getContainer={() => container}
        content="hello hello\n\nhello"
        isDarkMode={false}
        external={external}
        onClose={() => {}}
      />,
    );
  });
  await flush();
}

const findInput = () => document.querySelector('input[placeholder="find.placeholderPreview"]') as HTMLInputElement;
const countText = () => findInput().parentElement!.querySelector('span')!.textContent;
const navButton = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

function externalOf(partial: Partial<PreviewFindExternal>): PreviewFindExternal {
  return {
    status: 'ready',
    search: vi.fn(async () => ({ total: 0, capped: false })),
    step: vi.fn(async () => null),
    ...partial,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  host = null;
  container = null;
  root = null;
});

describe('PreviewFindBar 外部搜索适配', () => {
  it('构建中显示索引提示，不调用外部搜索，导航禁用', async () => {
    const search = vi.fn(async () => ({ total: 0, capped: false }));
    await mount(externalOf({ status: 'building', search }));
    await act(async () => { setNativeValue(findInput(), 'hello'); });
    await flush();
    expect(search).not.toHaveBeenCalled();
    expect(countText()).toBe('find.indexing');
    expect(navButton('find.nextMatch').disabled).toBe(true);
    expect(navButton('find.prevMatch').disabled).toBe(true);
  });

  it('就绪后计数与导航由外部引擎驱动', async () => {
    const search = vi.fn(async () => ({ total: 3, capped: false }));
    const step = vi.fn(async () => ({ current: 0, total: 3, capped: false }));
    await mount(externalOf({ search, step }));
    await act(async () => { setNativeValue(findInput(), 'hello'); });
    await flush();
    expect(search).toHaveBeenCalledWith({ query: 'hello', caseSensitive: false, regexp: false, wholeWord: false });
    expect(countText()).toBe('3');
    expect(navButton('find.nextMatch').disabled).toBe(false);

    await act(async () => { navButton('find.nextMatch').click(); });
    await flush();
    expect(step).toHaveBeenLastCalledWith(1);
    expect(countText()).toBe('1/3');

    step.mockResolvedValueOnce({ current: 2, total: 3, capped: false });
    await act(async () => { navButton('find.prevMatch').click(); });
    await flush();
    expect(step).toHaveBeenLastCalledWith(-1);
    expect(countText()).toBe('3/3');
  });

  it('外部引擎失败时回退 DOM 扫描', async () => {
    const search = vi.fn(async () => ({ total: 99, capped: false }));
    const step = vi.fn(async () => null);
    await mount(externalOf({ status: 'failed', search, step }));
    await act(async () => { setNativeValue(findInput(), 'hello'); });
    await flush();
    expect(search).not.toHaveBeenCalled();
    expect(countText()).toBe('3');
  });

  it('结果超过导航上限时显示 + 号', async () => {
    const search = vi.fn(async () => ({ total: 5000, capped: true }));
    await mount(externalOf({ search }));
    await act(async () => { setNativeValue(findInput(), 'hello'); });
    await flush();
    expect(countText()).toBe('5000+');
  });

  it('外部正则编译错误显示「正则无效」', async () => {
    const search = vi.fn(async () => ({ total: 0, capped: false, error: 'look-around not supported' }));
    await mount(externalOf({ search }));
    await act(async () => {
      (document.querySelector('button[aria-label="find.useRegex"]') as HTMLButtonElement).click();
    });
    await act(async () => { setNativeValue(findInput(), '(?=x)'); });
    await flush();
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ regexp: true, query: '(?=x)' }));
    expect(countText()).toBe('find.invalidRegex');
  });
});
