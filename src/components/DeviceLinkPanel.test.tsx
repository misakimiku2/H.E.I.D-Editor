// @vitest-environment jsdom
/**
 * 设备互联的一级入口（v1.5 发版前那条工单 + 他第二次点名的形状）。
 *
 * 钉住三件容易做歪的事：
 *  ① 桌面：点按钮开浮层、点外面与 Escape 都收掉 —— 它是常驻入口，不是一次性向导；
 *  ② 手机：顶栏那颗就是「扫一扫」，点开直接进相机层，中间不再有一层抽屉；
 *  ③ 扫到的码走的是与设置里同一条配对（`pairUri`）+ 同一个记对端的收尾（`rememberPeer`），
 *     失败要有话说得出口的地方（这条路上没有面板）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: false,
  IS_ANDROID_APP: false,
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
let emit: ((s: unknown) => void) | null = null;
const paired: { uri: string; device: string }[] = [];
const alerts: string[] = [];
const notes: { title: string; message?: string }[] = [];
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: (cb: (s: unknown) => void) => { emit = cb; return () => { emit = null; }; },
    subscribePairRequests: () => () => {},
    pairingsList: () => Promise.resolve([]),
    pairUri: (uri: string, device: string) => {
      paired.push({ uri, device });
      /* 带 stale 的那一枚按"桌面拒绝"处理：这条路上没有面板，失败必须从提示里说出来 */
      if (uri.includes('stale')) return Promise.reject(new Error('配对码已过期或已用过'));
      return Promise.resolve({ ...real.EMPTY_STATUS, role: 'client', connected: true, peerDevice: 'PC-1', peerKeyId: 'ab12cd34ef56ab78', peerAddr: '192.168.1.20:47123' });
    },
  };
});
vi.mock('../lib/appAlert', () => ({ appAlert: (msg: string) => { alerts.push(msg); } }));
vi.mock('../lib/notifications', () => ({
  showNotification: (n: { title: string; message?: string }) => { notes.push(n); return 'ntf'; },
}));
/* 面板主体就是设置那一块，本文件不重测它，只验有没有被挂进来 */
vi.mock('./DeviceLinkSection', () => ({
  DeviceLinkSection: () => React.createElement('div', { 'data-testid': 'link-section' }),
}));
/* 相机层替身：把 onResult 交出来，测试就能"扫"一枚码 */
let scanProps: { onResult: (t: string) => void; onClose: () => void } | null = null;
vi.mock('./QrScanner', () => ({
  default: (p: { onResult: (t: string) => void; onClose: () => void }) => {
    scanProps = p;
    return React.createElement('div', { 'data-testid': 'heid-scanner' });
  },
}));

import { DeviceLinkMenuButton, ScanLinkEntry } from './DeviceLinkPanel';
import { EMPTY_STATUS, loadPrefs } from '../lib/link';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const flush = async (n = 3) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); });
};

async function mount(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
  await flush();
}

const base = (patch: Record<string, unknown>) => ({ ...EMPTY_STATUS, ...patch });
const dot = () => container!.querySelector('[data-testid="heid-link-dot"]');
const panel = () => container!.querySelector('[data-testid="heid-link-panel"]');
const button = () => container!.querySelector('button')!;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  status = {};
  emit = null;
  scanProps = null;
  paired.length = 0;
  alerts.length = 0;
  notes.length = 0;
  localStorage.clear();
});

describe('桌面 / 平板菜单栏的互联按钮', () => {
  it('平时只有按钮，没有浮层', async () => {
    await mount(<DeviceLinkMenuButton dark={false} />);
    expect(button()).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it('点一下开出浮层，浮层里挂的就是设置那一整块', async () => {
    await mount(<DeviceLinkMenuButton dark={false} />);
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(panel()).toBeTruthy();
    expect(container!.querySelector('[data-testid="link-section"]')).toBeTruthy();
  });

  it('点浮层外面收掉，点里面不收（里面有开关和输入框）', async () => {
    await mount(<DeviceLinkMenuButton dark={false} />);
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(panel()).toBeNull();
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { panel()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(panel()).toBeTruthy();
  });

  it('Escape 收掉', async () => {
    await mount(<DeviceLinkMenuButton dark={false} />);
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(panel()).toBeNull();
  });

  it('状态点与状态栏标记读同一份 link_status：订阅推来什么就亮什么', async () => {
    status = base({ role: 'server', listening: true, port: 47123 });
    await mount(<DeviceLinkMenuButton dark />);
    expect(dot()?.getAttribute('data-link-badge')).toBe('idle');
    await act(async () => { emit?.(base({ role: 'server', listening: true, connected: true })); });
    expect(dot()?.getAttribute('data-link-badge')).toBe('connected');
    /* 悬停说明说的是同一句话，不另编一份状态文案 */
    expect(button().getAttribute('title')).toContain('link.stateConnected');
  });

  it('共享没开时按钮干净，不带一颗常灭的点', async () => {
    status = base({ role: 'off' });
    await mount(<DeviceLinkMenuButton dark />);
    expect(dot()).toBeNull();
  });
});

describe('手机顶栏那颗「扫一扫」', () => {
  it('说明写的是扫一扫，点开直接是相机层', async () => {
    const onOpenChange = vi.fn();
    await mount(<ScanLinkEntry dark={false} open={false} onOpenChange={onOpenChange} />);
    expect(button().getAttribute('aria-label')).toBe('link.scan');
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeNull();
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('相机层由 App 那侧的开合状态决定，关掉就收', async () => {
    await mount(<ScanLinkEntry dark={false} open onOpenChange={() => {}} />);
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeTruthy();
    act(() => { scanProps!.onClose(); });
    /* onClose 走的是 App 的 onOpenChange(false)，组件自己不持有开合 */
  });

  it('扫到 hide-link 码：走同一条配对，并把对端记进偏好（免扫重连靠这份）', async () => {
    const onOpenChange = vi.fn();
    await mount(<ScanLinkEntry dark={false} open onOpenChange={onOpenChange} />);
    await act(async () => { scanProps!.onResult('hide-link://pair?t=abc&h=192.168.1.20&p=47123'); });
    expect(paired).toHaveLength(1);
    expect(paired[0].uri).toContain('hide-link://pair');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    const prefs = loadPrefs();
    expect(prefs.keyId).toBe('ab12cd34ef56ab78');
    expect(prefs.host).toBe('192.168.1.20');
    expect(prefs.port).toBe(47123);
    /* 结果说的那句还是状态那一句话，不另编措辞 */
    expect(notes[0]?.message).toContain('link.stateConnected');
  });

  it('扫到别家应用的二维码：不配对、说清原因，并且把相机收掉', async () => {
    const onOpenChange = vi.fn();
    await mount(<ScanLinkEntry dark={false} open onOpenChange={onOpenChange} />);
    await act(async () => { scanProps!.onResult('https://example.com/x'); });
    expect(paired).toHaveLength(0);
    expect(alerts).toContain('link.errUri');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('配对失败时把桌面给的原话报出来，不静默', async () => {
    await mount(<ScanLinkEntry dark={false} open onOpenChange={() => {}} />);
    await act(async () => { scanProps!.onResult('hide-link://pair?t=stale'); });
    expect(alerts).toContain('配对码已过期或已用过');
    expect(notes).toHaveLength(0);
    expect(loadPrefs().keyId).toBe('');
  });
});
