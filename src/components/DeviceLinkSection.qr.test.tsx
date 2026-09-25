// @vitest-environment jsdom
/**
 * 桌面「共享这台电脑」这一档的出码时机（2026-09-25 用户点名）：
 * 开共享就应当直接看见二维码，而不是再点一次「让手机连接」。
 *
 * 这里盯的是两件相反的事：
 *  ① 该出的时候一定出（开关一开、以及应用启动时共享本来就是开着的）；
 *  ② 不该出的时候一次都不出 —— `link_pair_qr` 每调一次就换一张一次性票，
 *     多取一次就把用户手上正对着的那张码作废掉。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({ IS_TOUCH_PRIMARY: false, IS_ANDROID_APP: false, NARROW_QUERY: '' }));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key,
}));
vi.mock('../lib/fileIO', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: true,
}));
vi.mock('./QrImage', () => ({
  default: () => React.createElement('div', { 'data-testid': 'heid-qr' }),
}));

let status: Record<string, unknown> = {};
let emit: ((s: unknown) => void) | null = null;
let qrCalls = 0;
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: (cb: (s: unknown) => void) => { emit = cb; return () => { emit = null; }; },
    subscribePairRequests: () => () => {},
    pairingsList: () => Promise.resolve([]),
    pairQr: () => { qrCalls += 1; return Promise.resolve({ uri: 'hide-link://pair?a=b', code: '486275', host: '192.168.31.87', port: 47123 }); },
  };
});

import { DeviceLinkSection } from './DeviceLinkSection';
import { EMPTY_STATUS } from '../lib/link';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLElement | null = null;

const listening = (on: boolean) => ({ ...EMPTY_STATUS, role: 'server', listening: on, port: 47123 });

async function mount(patch: Record<string, unknown>) {
  status = patch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<DeviceLinkSection dark={false} rowCls="" labelCls="" />);
  });
  /* 状态取回 + 懒加载的二维码 chunk 各要一帧 */
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  qrCalls = 0;
  emit = null;
  document.body.innerHTML = '';
});

const qrShown = () => !!container!.querySelector('[data-testid="heid-qr"]');

describe('桌面开共享即出码', () => {
  it('共享本来就开着：面板一打开就摆着码，不需要再点一下', async () => {
    await mount(listening(true));
    expect(qrCalls).toBe(1);
    expect(qrShown()).toBe(true);
    expect(container!.textContent).toContain('486275');
  });

  it('没开共享时一次都不取码（取一张就作废一张）', async () => {
    await mount(listening(false));
    expect(qrCalls).toBe(0);
    expect(qrShown()).toBe(false);
  });

  it('把开关拨到开：状态推到 listening 的那一刻自己去取码', async () => {
    await mount(listening(false));
    expect(qrCalls).toBe(0);
    await act(async () => { emit?.(listening(true)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(qrCalls).toBe(1);
    expect(qrShown()).toBe(true);
  });

  it('状态反复推送时不重复取码', async () => {
    await mount(listening(true));
    await act(async () => { emit?.(listening(true)); emit?.(listening(true)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(qrCalls).toBe(1);
  });

  it('关掉共享再打开：换一张新码（旧票已经跟着端口一起废了）', async () => {
    await mount(listening(true));
    await act(async () => { emit?.(listening(false)); });
    await act(async () => { emit?.(listening(true)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(qrCalls).toBe(2);
  });
});
