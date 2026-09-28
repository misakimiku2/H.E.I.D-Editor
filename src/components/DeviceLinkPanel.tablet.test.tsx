// @vitest-environment jsdom
/**
 * 安卓平板壳（`IS_ANDROID_APP` 且宽屏）上菜单栏那颗互联按钮 —— 它走的是桌面那一副形状
 * （贴着按钮的浮层），但内容是客户端那半栏，所以扫码得从这层浮层里进。
 * 2026-09-28 他平板实测点名：平板没有扫码入口。手机那颗在顶栏，平板顶栏沿用桌面布局、
 * 没有那个位置。
 *
 * 这一份只管**宿主该管的事**：浮层的开合、相机层挂在哪、以及有没有把扫码的去处交给状态卡。
 * 「扫一扫摆不摆、摆成主操作」是状态卡自己的判法，见 `DeviceLinkSection.client.test.tsx`。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
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
const statusSubs = new Set<(s: unknown) => void>();
const emitStatus = (s: unknown) => { for (const cb of [...statusSubs]) cb(s); };
const paired: string[] = [];
const alerts: string[] = [];
let handoffCalls = 0;
let cancels = 0;
/** 状态卡有没有拿到扫码的去处 —— 浮层这一侧只负责给，摆不摆由状态卡判 */
let gotScanProp = false;

vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: (cb: (s: unknown) => void) => { statusSubs.add(cb); return () => { statusSubs.delete(cb); }; },
    subscribeLinkRedial: () => () => {},
    linkRedialSnapshot: () => ({ spinning: false }),
    pairingsList: () => Promise.resolve([]),
    pairUri: (uri: string) => {
      paired.push(uri);
      if (uri.includes('stale')) return Promise.reject(new Error('配对码已过期或已用过'));
      return Promise.resolve({ ...real.EMPTY_STATUS, role: 'client', connected: true, peerDevice: 'PC-1' });
    },
  };
});
vi.mock('../lib/appAlert', () => ({ appAlert: (msg: string) => { alerts.push(msg); } }));
vi.mock('./DeviceLinkSection', () => ({
  DeviceLinkSection: (p: { onScan?: () => void }) => {
    gotScanProp = typeof p.onScan === 'function';
    return React.createElement('div', { 'data-testid': 'link-section' },
      p.onScan && React.createElement('button', { onClick: p.onScan }, 'link.scan'));
  },
}));

/** 相机层替身：把回调交出来，测试就能"扫"一枚码 */
let scanProps: { onResult: (t: string) => void; onClose: () => void; onUseCode: () => void } | null = null;
vi.mock('./QrScanner', () => ({
  default: (p: { onResult: (t: string) => void; onClose: () => void; onUseCode: () => void }) => {
    scanProps = p;
    return React.createElement('div', { 'data-testid': 'heid-scanner' });
  },
}));

import { DeviceLinkMenuButton } from './DeviceLinkPanel';
import { EMPTY_STATUS } from '../lib/link';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
const beginHandoff = () => { handoffCalls += 1; return () => { cancels += 1; }; };

const flush = async (n = 3) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); });
};

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<DeviceLinkMenuButton dark onHandoff={beginHandoff} />); });
  await flush();
}

const button = () => container!.querySelector('button')!;
const panel = () => container!.querySelector('[data-testid="heid-link-panel"]');
const scanner = () => container!.querySelector('[data-testid="heid-scanner"]');
const scanBtn = () => [...container!.querySelectorAll('button')].find(b => b.textContent?.includes('link.scan'));

const open = () => act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });

/** 相机层是懒加载的：点完要等一次解包，`scanner()` 才拿得到东西 */
const startScan = async () => {
  await act(async () => { scanBtn()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
};

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  status = {};
  statusSubs.clear();
  scanProps = null;
  gotScanProp = false;
  paired.length = 0;
  alerts.length = 0;
  handoffCalls = 0;
  cancels = 0;
  localStorage.clear();
});

describe('安卓平板浮层与扫码的接线', () => {
  it('浮层里那块状态卡拿到了扫码的去处（平板没有顶栏那颗，这是它唯一的入口）', async () => {
    await mount();
    open();
    expect(gotScanProp, '宿主得把 onScan 交给状态卡').toBe(true);
    expect(scanBtn()).toBeTruthy();
  });

  it('点扫一扫：收掉浮层、开相机层', async () => {
    await mount();
    open();
    await startScan();
    expect(panel()).toBeNull();
    expect(scanner()).toBeTruthy();
  });

  it('扫到 hide-link 码：走与手机同一条配对，并立起这次交接', async () => {
    await mount();
    open();
    await startScan();
    await act(async () => { scanProps!.onResult('hide-link://pair?t=abc&h=192.168.1.20&p=47123'); });
    expect(paired).toHaveLength(1);
    expect(handoffCalls).toBe(1);
    expect(scanner()).toBeNull();
  });

  it('扫到别家的码：不配对、不立交接、说清原因', async () => {
    await mount();
    open();
    await startScan();
    await act(async () => { scanProps!.onResult('https://example.com/x'); });
    expect(paired).toHaveLength(0);
    expect(handoffCalls).toBe(0);
    expect(alerts).toContain('link.errUri');
  });

  it('相机里那颗「改用配对码」把浮层掀回来：两条路是同一格的两个入口', async () => {
    await mount();
    open();
    await startScan();
    act(() => { scanProps!.onUseCode(); });
    expect(scanner()).toBeNull();
    expect(panel()).toBeTruthy();
  });

  it('相机开着的时候链路被后台接回来：把相机收掉，别等他下次断开时自己弹出来', async () => {
    await mount();
    open();
    await startScan();
    await act(async () => {
      emitStatus({ ...EMPTY_STATUS, role: 'client', connected: true, peerDevice: 'PC-1' });
    });
    await flush();
    expect(scanner()).toBeNull();
  });
});
