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
/** 面板这一侧只该"问"，换不换由服务端判：所以两个计数分开看，`rotateCalls` 必须一直是 0 */
let infoCalls = 0;
let rotateCalls = 0;
let infoSeq = 1;
/** 模拟服务端"这张挂够久了，换一张"：第 n 次问的时候换 */
let rotateOnCall = -1;
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  const info = () => ({ uri: `hide-link://pair?t=${infoSeq}`, code: String(infoSeq).repeat(6), host: '192.168.31.87', port: 47123 });
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: (cb: (s: unknown) => void) => { emit = cb; return () => { emit = null; }; },
    pairingsList: () => Promise.resolve([]),
    pairInfo: () => {
      infoCalls += 1;
      if (infoCalls === rotateOnCall) infoSeq += 1;
      return Promise.resolve(info());
    },
    pairQr: () => { rotateCalls += 1; infoSeq += 1; return Promise.resolve(info()); },
  };
});

import { DeviceLinkSection } from './DeviceLinkSection';
import { EMPTY_STATUS, QR_POLL_MS } from '../lib/link';

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
    root!.render(<DeviceLinkSection dark={false} rowCls="" labelCls="" onHandoff={() => () => {}} />);
  });
  /* 状态取回 + 懒加载的二维码 chunk 各要一帧 */
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  infoCalls = 0;
  rotateCalls = 0;
  rotateOnCall = -1;
  infoSeq = 1;
  emit = null;
  document.body.innerHTML = '';
});

const qrShown = () => !!container!.querySelector('[data-testid="heid-qr"]');
const codeShown = () => [1, 2, 3, 4].map((i) => String(i).repeat(6)).find((c) => (container!.textContent || '').includes(c)) ?? '';

async function tick(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
  for (let i = 0; i < 2; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('桌面开共享即出码', () => {
  it('共享本来就开着：面板一打开就摆着码，不需要再点一下', async () => {
    await mount(listening(true));
    expect(infoCalls).toBe(1);
    expect(qrShown()).toBe(true);
    expect(codeShown()).toBe('111111');
  });

  it('没开共享时一次都不问', async () => {
    await mount(listening(false));
    expect(infoCalls).toBe(0);
    expect(qrShown()).toBe(false);
  });

  it('把开关拨到开：状态推到 listening 的那一刻自己去问', async () => {
    await mount(listening(false));
    expect(infoCalls).toBe(0);
    await act(async () => { emit?.(listening(true)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(infoCalls).toBe(1);
    expect(qrShown()).toBe(true);
  });

  it('状态反复推送时不重复问', async () => {
    await mount(listening(true));
    await act(async () => { emit?.(listening(true)); emit?.(listening(true)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(infoCalls).toBe(1);
  });

  it('关掉共享再打开：重新问一次', async () => {
    await mount(listening(true));
    await act(async () => { emit?.(listening(false)); });
    await act(async () => { emit?.(listening(true)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(infoCalls).toBe(2);
  });

  /* 2026-09-27：定时器**只问不换**。每问一次就换一张的话，设置弹窗与浮层两个面板
     各自的定时器会抢着换，屏幕上摆的很快就不是当前那张 —— 手机照屏幕上那张算密钥，
     两边派生出不同密钥，报出来的是「帧解密失败」这种看不出谁做错了什么的串。 */
  it('定时器一直问，但一张都不换', async () => {
    vi.useFakeTimers();
    try {
      await mount(listening(true));
      await tick(QR_POLL_MS * 4);
      expect(infoCalls).toBe(5);
      expect(rotateCalls, '换码是服务端的事，面板不许自己换').toBe(0);
      expect(codeShown(), '服务端没说要换，屏幕上就该还是这张').toBe('111111');
    } finally {
      vi.useRealTimers();
    }
  });

  it('服务端说该换了，界面才跟着换一张', async () => {
    vi.useFakeTimers();
    try {
      rotateOnCall = 3;
      await mount(listening(true));
      expect(codeShown()).toBe('111111');
      await tick(QR_POLL_MS * 3);
      expect(codeShown()).toBe('222222');
    } finally {
      vi.useRealTimers();
    }
  });

  it('已经有设备连着时连问都不问（第二台本来就收 busy）', async () => {
    vi.useFakeTimers();
    try {
      await mount({ ...listening(true), connected: true, peerKeyId: 'ab12cd34ef56ab78' });
      await tick(QR_POLL_MS * 3);
      expect(infoCalls).toBe(0);
      // 断开那一刻恢复：用户随时回头都该看见一张能扫的码
      await act(async () => { emit?.(listening(true)); });
      for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
      expect(infoCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('「换一个码」那颗按钮才是手动换码', async () => {
    await mount(listening(true));
    const btn = [...container!.querySelectorAll('button')].find((b) => (b.textContent || '').includes('link.refreshCode'))!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(rotateCalls).toBe(1);
    expect(codeShown()).toBe('222222');
  });
});

/* 2026-09-27 他点名：连着的时候那一格只说「设备已连接」，别的说明都不要。
   这一条同时钉住"不留着手上的那一张"——面板开着的时候来了一条连接，
   屏幕上那张码已经不再成立，摆着它等于给一个扫不动的入口留着位置。 */
describe('有设备连着时那一格说什么', () => {
  const onLine = { connected: true, peerDevice: 'NOH-AL00', peerKeyId: 'ab12cd34ef56ab78', peerAddr: '192.168.31.172:5555' };

  it('连上了：码收掉、不再续码，只留一行「设备已连接」', async () => {
    await mount(listening(true));
    expect(qrShown()).toBe(true);
    const before = infoCalls;
    await act(async () => { emit?.({ ...listening(true), ...onLine }); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(qrShown(), '一张扫不动的码不该留在屏幕上').toBe(false);
    expect(infoCalls, '连着的时候不再问码').toBe(before);
    expect(container!.textContent).toContain('link.deviceConnected');
  });

  it('面板是连着之后才打开的：一次都不问码，那一行照样在', async () => {
    await mount({ ...listening(true), ...onLine });
    expect(infoCalls).toBe(0);
    expect(qrShown()).toBe(false);
    expect(container!.textContent).toContain('link.deviceConnected');
  });

  it('断开之后那一行让回给码', async () => {
    await mount({ ...listening(true), ...onLine });
    await act(async () => { emit?.(listening(true)); });
    for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container!.textContent).not.toContain('link.deviceConnected');
    expect(qrShown()).toBe(true);
  });
});
