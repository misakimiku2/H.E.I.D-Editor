// @vitest-environment jsdom
/**
 * 「获取另一版」面板·安卓侧：安卓上扫码没有意义（已经在手机上了），
 * 所以只给桌面版所在的下载页地址 + 复制 / 打开，不放二维码。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_ANDROID_APP: true,
  IS_TOUCH_PRIMARY: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));
const openExternal = vi.fn((_u: string) => Promise.resolve());
vi.mock('../lib/openExternal', () => ({ openExternal: (u: string) => openExternal(u) }));
/* 组件仍会 import 剪贴板工具（桌面分支用得到），这里只挡掉真实实现 */
vi.mock('../lib/fileOps', () => ({ writeClipboardText: () => Promise.resolve() }));

import { OtherPlatformPanel } from './OtherPlatformPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE = 'https://gitee.com/misakimiku2/heid-editor/releases';

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<OtherPlatformPanel version="1.4.2" downloadPage={PAGE} isDarkMode={false} />);
  });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
});

describe('安卓侧面板', () => {
  it('标题是桌面版，地址原样可见（可长按选中）', async () => {
    await render();
    expect(container!.textContent).toContain('about.desktopTitle');
    expect(container!.textContent).toContain(PAGE);
    expect(container!.querySelector('img')).toBeNull();
  });

  it('只给「打开下载页」，不再重复放一个复制按钮', async () => {
    await render();
    const labels = [...container!.querySelectorAll('button')].map(b => b.textContent ?? '');
    expect(labels.some(l => l.includes('about.openDownloadPage'))).toBe(true);
    expect(labels.some(l => l.includes('update.copyLink'))).toBe(false);
    const open = [...container!.querySelectorAll('button')]
      .find(b => b.textContent?.includes('about.openDownloadPage'));
    act(() => { open!.click(); });
    expect(openExternal).toHaveBeenCalledWith(PAGE);
  });
});
