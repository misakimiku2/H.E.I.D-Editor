// @vitest-environment jsdom
/**
 * 设备互联的一级入口（v1.5 发版前那条工单 + 他第二次点名的形状 + 2026-09-27 第三条）。
 *
 * 钉住几件容易做歪的事：
 *  ① 桌面：点按钮开浮层、点外面与 Escape 都收掉 —— 它是常驻入口，不是一次性向导；
 *  ② 手机：没连着时顶栏那颗就是「扫一扫」，点开直接进相机层，中间不再有一层抽屉；
 *  ③ 扫到的码走的是与设置里同一条配对（`pairUri`），发起成功后**只立交接的意图**
 *     （把桌面上正看着的那份摊开是交接的事，不在这里），失败要有话说得出口的地方；
 *  ④ 已经连着那台电脑时，那颗换成状态按钮 —— 手机端同时只服务一台，
 *     连着的时候再摆一颗扫码是误操作入口，不是功能。
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
/** 状态订阅的替身：真身给每个订阅者各推一份，这里也必须广播 —— 一个组件里可以有两处
    `useLinkStatus`（状态点那份与扫码那颗那份），只记下最后挂上的那个会漏掉另一处 */
const statusSubs = new Set<(s: unknown) => void>();
const emitStatus = (s: unknown) => { for (const cb of [...statusSubs]) cb(s); };
const paired: { uri: string; device: string }[] = [];
const alerts: string[] = [];
const notes: { title: string; message?: string }[] = [];
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: (cb: (s: unknown) => void) => { statusSubs.add(cb); return () => { statusSubs.delete(cb); }; },
    subscribeLinkRedial: (cb: () => void) => { redialSubs.add(cb); return () => { redialSubs.delete(cb); }; },
    linkRedialSnapshot: () => redialSnap,
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
/** 「正在自己接回来」那份信号：真身由 `startLinkKeepAlive` 写，这里替它写（对象要换引用，
    `useSyncExternalStore` 认引用） */
let redialSnap = { spinning: false };
const redialSubs = new Set<() => void>();
function setRedial(v: boolean) {
  if (redialSnap.spinning === v) return;
  redialSnap = { spinning: v };
  for (const cb of redialSubs) cb();
}

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
/** 交接触发器的替身：记下被叫了几次，并把「收回」交回给调用方去验 */
let handoffCalls = 0;
let cancels = 0;
const beginHandoff = () => { handoffCalls += 1; return () => { cancels += 1; }; };
const noop = () => {};

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
  statusSubs.clear();
  scanProps = null;
  paired.length = 0;
  alerts.length = 0;
  notes.length = 0;
  handoffCalls = 0;
  cancels = 0;
  redialSnap = { spinning: false };
  redialSubs.clear();
  localStorage.clear();
});

describe('桌面 / 平板菜单栏的互联按钮', () => {
  it('平时只有按钮，没有浮层', async () => {
    await mount(<DeviceLinkMenuButton dark={false} onHandoff={beginHandoff} />);
    expect(button()).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it('点一下开出浮层，浮层里挂的就是设置那一整块', async () => {
    await mount(<DeviceLinkMenuButton dark={false} onHandoff={beginHandoff} />);
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(panel()).toBeTruthy();
    expect(container!.querySelector('[data-testid="link-section"]')).toBeTruthy();
  });

  it('桌面这一侧不摆扫一扫：桌面是被扫的那一方，扫码是客户端那半栏的动作', async () => {
    await mount(<DeviceLinkMenuButton dark={false} onHandoff={beginHandoff} />);
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(panel()).toBeTruthy();
    const labels = [...container!.querySelectorAll('button')].map(b => b.textContent ?? '');
    expect(labels.some(x => x.includes('link.scan'))).toBe(false);
  });

  it('点浮层外面收掉，点里面不收（里面有开关和输入框）', async () => {
    await mount(<DeviceLinkMenuButton dark={false} onHandoff={beginHandoff} />);
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(panel()).toBeNull();
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { panel()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(panel()).toBeTruthy();
  });

  it('Escape 收掉', async () => {
    await mount(<DeviceLinkMenuButton dark={false} onHandoff={beginHandoff} />);
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(panel()).toBeNull();
  });

  it('状态点与状态栏标记读同一份 link_status：订阅推来什么就亮什么', async () => {
    status = base({ role: 'server', listening: true, port: 47123 });
    await mount(<DeviceLinkMenuButton dark onHandoff={beginHandoff} />);
    expect(dot()?.getAttribute('data-link-badge')).toBe('idle');
    await act(async () => { emitStatus(base({ role: 'server', listening: true, connected: true })); });
    expect(dot()?.getAttribute('data-link-badge')).toBe('connected');
    /* 悬停说明说的是同一句话，不另编一份状态文案 */
    expect(button().getAttribute('title')).toContain('link.stateConnected');
  });

  it('共享没开时按钮干净，不带一颗常灭的点', async () => {
    status = base({ role: 'off' });
    await mount(<DeviceLinkMenuButton dark onHandoff={beginHandoff} />);
    expect(dot()).toBeNull();
  });
});

describe('手机顶栏那颗互联入口：没连着 = 扫一扫', () => {
  const scan = () => <ScanLinkEntry
    dark={false}
    open
    onOpenChange={noop}
    onHandoff={beginHandoff}
    onStatus={noop}
  />;

  it('说明写的是扫一扫，点开直接是相机层', async () => {
    const onOpenChange = vi.fn();
    await mount(<ScanLinkEntry dark={false} open={false} onOpenChange={onOpenChange} onHandoff={beginHandoff} onStatus={noop} />);
    expect(button().getAttribute('aria-label')).toBe('link.scan');
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeNull();
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('相机层由 App 那侧的开合状态决定，关掉就收', async () => {
    await mount(scan());
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeTruthy();
    act(() => { scanProps!.onClose(); });
    /* onClose 走的是 App 的 onOpenChange(false)，组件自己不持有开合 */
  });

  it('扫到 hide-link 码：走同一条配对，并立起这次交接', async () => {
    const onOpenChange = vi.fn();
    await mount(<ScanLinkEntry dark={false} open onOpenChange={onOpenChange} onHandoff={beginHandoff} onStatus={noop} />);
    await act(async () => { scanProps!.onResult('hide-link://pair?t=abc&h=192.168.1.20&p=47123'); });
    expect(paired).toHaveLength(1);
    expect(paired[0].uri).toContain('hide-link://pair');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    /* 不弹一句"连上了"再让人自己去找东西：扫成功的那一下只立交接的意图，
       把桌面上正看着的那一份摊到前台是交接的事（见 useLinkHandoff）。
       那条路上不该再有通知；而连上之后要做的事都按状态事件判。
       记对端（keyId / 地址）**也不在这里**：这一刻的快照里 peerKeyId 还是空的，
       在命令返回值上记会永远慢一次配对 —— 那份收尾在 App 的状态订阅里，见 `rememberPeer` 的注释。 */
    expect(handoffCalls).toBe(1);
    expect(notes).toHaveLength(0);
    expect(loadPrefs().keyId).toBe('');
  });

  it('扫到别家应用的二维码：不配对、不立交接、说清原因，并且把相机收掉', async () => {
    const onOpenChange = vi.fn();
    await mount(<ScanLinkEntry dark={false} open onOpenChange={onOpenChange} onHandoff={beginHandoff} onStatus={noop} />);
    await act(async () => { scanProps!.onResult('https://example.com/x'); });
    expect(paired).toHaveLength(0);
    expect(handoffCalls).toBe(0);
    expect(alerts).toContain('link.errUri');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('配对失败时把桌面给的原话报出来，并把那次交接收回', async () => {
    await mount(scan());
    await act(async () => { scanProps!.onResult('hide-link://pair?t=stale'); });
    expect(alerts).toContain('配对码已过期或已用过');
    /* 命令本身没过 = 那次拨号根本没发生。交接收回，否则它要等到超时报一句无关的话，
       而真正的原话这时候早就说完了 */
    expect(handoffCalls).toBe(1);
    expect(cancels).toBe(1);
    expect(notes).toHaveLength(0);
    expect(loadPrefs().keyId).toBe('');
  });
});

describe('手机顶栏那颗互联入口：已经连着 = 状态按钮', () => {
  /** 连着那台电脑的一份状态 */
  const onLine = { role: 'client', connected: true, peerDevice: 'PC-1', peerKeyId: 'ab12cd34ef56ab78', peerAddr: '192.168.1.20:47123' };

  it('扫一扫收起，换成状态按钮；点下去是「设备互联」那一格', async () => {
    const onOpenChange = vi.fn();
    const onStatus = vi.fn();
    status = base(onLine);
    await mount(<ScanLinkEntry dark={false} open={false} onOpenChange={onOpenChange} onHandoff={beginHandoff} onStatus={onStatus} />);
    /* 手机端同时只服务一台：连着的时候再摆一颗扫码，扫了只会把当前这条顶掉 —— 那是误操作入口 */
    expect(button().getAttribute('aria-label')).toBe('settings.section.deviceLink');
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    /* 悬停说明仍是状态那句话（与状态栏、设置里那一格同一个口径） */
    expect(button().getAttribute('title')).toContain('link.stateConnected');
  });

  it('相机层即使在 App 那侧还开着也不挂，并且把开合状态收掉', async () => {
    /* 相机开着的时候链路被后台接回来（免扫重连成功）：不收的话 `open` 一直停在 true，
       下次断开时相机会自己弹出来 */
    status = base(onLine);
    const onOpenChange = vi.fn();
    await mount(<ScanLinkEntry dark={false} open onOpenChange={onOpenChange} onHandoff={beginHandoff} onStatus={noop} />);
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('断开之后自己变回扫一扫', async () => {
    status = base(onLine);
    await mount(<ScanLinkEntry dark={false} open={false} onOpenChange={noop} onHandoff={beginHandoff} onStatus={noop} />);
    expect(button().getAttribute('aria-label')).toBe('settings.section.deviceLink');
    await act(async () => { emitStatus(base({ role: 'client', connected: false })); });
    expect(button().getAttribute('aria-label')).toBe('link.scan');
  });
});

/* 亮屏之后手机正在自己接回来（2026-09-27 他点名）：那颗入口这时候摆「扫一扫」，
   等于把"等一等"说成"你来动手"。转圈跟着退避那张表，表跑完自己收（见 link.keepalive.test.ts）。 */
describe('手机顶栏那颗互联入口：正在自己接回来 = 转圈', () => {
  const offlineClient = { role: 'client', connected: false, peerKeyId: '', peerAddr: '' };

  it('退避在跑：说明是「正在接回电脑」，点下去进那一格而不是开相机', async () => {
    status = base(offlineClient);
    setRedial(true);
    const onOpenChange = vi.fn();
    const onStatus = vi.fn();
    await mount(<ScanLinkEntry dark={false} open={false} onOpenChange={onOpenChange} onHandoff={beginHandoff} onStatus={onStatus} />);
    expect(button().getAttribute('aria-label')).toBe('link.redialing');
    act(() => { button().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOpenChange, '接回途中不该把相机推给他').not.toHaveBeenCalledWith(true);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('那一次拨号还在路上（有地址、没连着）也算接回中', async () => {
    status = base({ ...offlineClient, peerAddr: '192.168.1.20:47123' });
    await mount(<ScanLinkEntry dark={false} open={false} onOpenChange={noop} onHandoff={beginHandoff} onStatus={noop} />);
    expect(button().getAttribute('aria-label')).toBe('link.redialing');
  });

  it('表跑完了回到扫一扫，相机那一层仍归 App 那侧的开合管', async () => {
    status = base(offlineClient);
    setRedial(false);
    await mount(<ScanLinkEntry dark={false} open onOpenChange={noop} onHandoff={beginHandoff} onStatus={noop} />);
    expect(button().getAttribute('aria-label')).toBe('link.scan');
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeTruthy();
  });

  it('转圈也不把相机那一层挤掉：他正举着手机扫，后台在接回是他的这一次优先', async () => {
    status = base(offlineClient);
    setRedial(true);
    await mount(<ScanLinkEntry dark={false} open onOpenChange={noop} onHandoff={beginHandoff} onStatus={noop} />);
    expect(button().getAttribute('aria-label')).toBe('link.redialing');
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeTruthy();
  });
});
