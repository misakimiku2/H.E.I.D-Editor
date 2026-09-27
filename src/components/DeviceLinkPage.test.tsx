// @vitest-environment jsdom
/**
 * 手机端「设备互联」整屏（2026-09-28 从设置里剥离出来的那一屏）。
 * 钉三件他点过名的行为：
 *  - 没连着时这一屏里也给一颗扫一扫（否则进了这屏就想扫的人只能先退出去 —— 死路）；
 *  - 连着时这颗不许出现（手机同时只服务一台，扫了只会顶掉当前那条，那是误操作）；
 *  - 「互联日志」那一行进的是编辑器里那张只读日志标签（回调交给 App，由它建标签并聚焦）。
 * 整屏必须 portal 到 body：底下的设置弹窗带 backdrop-blur，会把它困在弹窗那一格。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: true,
  IS_ANDROID_APP: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key,
}));
vi.mock('../lib/fileIO', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: true,
}));

let status: Record<string, unknown> = {};
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: () => () => {},
    pairingsList: () => Promise.resolve([]),
  };
});
vi.mock('./QrImage', () => ({ default: () => null }));

import { DeviceLinkPage } from './DeviceLinkPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mount = async (over: Partial<React.ComponentProps<typeof DeviceLinkPage>> = {}) => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root: Root = createRoot(el);
  const handlers = {
    onClose: vi.fn(),
    onBrowseRemote: vi.fn(),
    onShowRemoteTabs: vi.fn(),
    onShowLog: vi.fn(),
    onHandoff: () => () => {},
    onScan: vi.fn(),
    ...over,
  };
  await act(async () => {
    root.render(
      <DeviceLinkPage dark={false} {...handlers} />,
    );
  });
  return { root, el, handlers, text: () => document.body.textContent ?? '' };
};

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  status = {};
});

describe('DeviceLinkPage', () => {
  it('没连着时这一屏里有扫一扫，点下去开相机', async () => {
    status = { role: 'client' };
    const { text, handlers } = await mount();
    expect(text()).toContain('link.scan');
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'link.scan');
    await act(async () => { void btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(handlers.onScan).toHaveBeenCalledTimes(1);
  });

  it('连着那台电脑时扫一扫收起：再摆一颗只会顶掉当前这条', async () => {
    status = { role: 'client', connected: true, peerDevice: 'Mate', peerKeyId: 'a4f9e74f4009c330' };
    const { text } = await mount();
    expect(text()).not.toContain('link.scan');
    // 断开与浏览那台电脑的文件仍在这一屏里
    expect(text()).toContain('link.disconnect');
  });

  it('「互联日志」那一行点的是 App 那份唯一的日志屏', async () => {
    status = { role: 'client' };
    const { text, handlers } = await mount();
    expect(text()).toContain('link.logTitle');
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('link.logTitle'));
    await act(async () => { void btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(handlers.onShowLog).toHaveBeenCalledTimes(1);
  });

  it('整屏 portal 到 body，不留在宿主容器那一格里', async () => {
    status = { role: 'client' };
    await mount();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.parentElement).toBe(document.body);
  });
});
