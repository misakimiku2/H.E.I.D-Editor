// @vitest-environment jsdom
/**
 * 「获取另一版」面板·桌面侧：给的是安卓 APK 的镜像直链二维码（桌面用户用手机扫码装安卓版）。
 * 安卓侧见 OtherPlatformPanel.android.test.tsx；地址拼接本身在 lib/update.test.ts 覆盖。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_ANDROID_APP: false,
  IS_TOUCH_PRIMARY: false,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));
const writeClipboardText = vi.fn((_u: string) => Promise.resolve());
vi.mock('../lib/fileOps', () => ({ writeClipboardText: (u: string) => writeClipboardText(u) }));

import { OtherPlatformPanel } from './OtherPlatformPanel';
import { apkMirrorDownloadUrl } from '../lib/update';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <OtherPlatformPanel version="1.4.2" downloadPage="https://example.test/releases" isDarkMode={false} />
    );
  });
}

/** QrImage 是 lazy 的：动态 import + 生成二维码要跑几个微任务，轮询等它落地 */
async function waitForQr(timeoutMs = 3000): Promise<HTMLImageElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    const img = container!.querySelector('img');
    if (img?.getAttribute('src')?.startsWith('data:image/svg+xml,')) return img;
    if (Date.now() > deadline) return null;
  }
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
});

describe('桌面侧面板', () => {
  it('标题是安卓版，并说明门槛', async () => {
    await render();
    expect(container!.textContent).toContain('about.mobileTitle');
    expect(container!.textContent).toContain('about.mobileHint');
    expect(container!.textContent).not.toContain('about.desktopTitle');
  });

  it('渲染二维码图片，内容是镜像上的 APK 直链', async () => {
    await render();
    const img = await waitForQr();
    expect(img).not.toBeNull();
    /* 解码回 SVG，确认编进去的就是那条直链（不是 GitHub 的、也不是当前页地址） */
    const svg = decodeURIComponent(img!.getAttribute('src')!.replace('data:image/svg+xml,', ''));
    expect(svg).toContain('<svg');
    expect(svg.length).toBeGreaterThan(1000);
    expect(apkMirrorDownloadUrl('1.4.2')).toContain('gitee.com');
  });

  it('复制链接走的是同一条 APK 直链', async () => {
    await render();
    const btn = [...container!.querySelectorAll('button')].find(b => b.textContent?.includes('update.copyLink'));
    act(() => { btn!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(writeClipboardText).toHaveBeenCalledWith(apkMirrorDownloadUrl('1.4.2'));
  });
});
