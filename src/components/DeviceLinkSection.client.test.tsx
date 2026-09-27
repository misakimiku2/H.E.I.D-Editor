// @vitest-environment jsdom
/**
 * 手机侧「设置 → 设备互联」这一格（2026-09-25 第二次点名之后）：
 * 扫一扫不在这格里了 —— 它是顶栏那颗入口，点下去直接开相机；
 * 这一格留下的是不需要相机的等价入口，以及离线队列那一行。
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
let pairUriCalls = 0;
/** 交接的「收回」默认给一个空操作，测试要验它被不被调用时另传一个 */
const noopCancel = () => {};
/** 带 boom 的那一枚按"命令本身没过"处理（地址为空那类：拨号根本没发生） */
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: () => () => {},
    pairingsList: () => Promise.resolve([]),
    pairUri: (uri: string) => {
      pairUriCalls += 1;
      if (String(uri).includes('boom')) return Promise.reject(new Error('地址不能为空'));
      return Promise.resolve({ ...real.EMPTY_STATUS, role: 'client', peerAddr: '192.168.31.87:47123' });
    },
  };
});
vi.mock('./QrImage', () => ({ default: () => React.createElement('div') }));
vi.mock('./QrScanner', () => ({ default: () => React.createElement('div', { 'data-testid': 'heid-scanner' }) }));

import { DeviceLinkSection } from './DeviceLinkSection';
import { EMPTY_STATUS, type LinkStatus } from '../lib/link';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(
  offline?: Record<string, unknown>,
  onShowRemoteTabs?: () => void,
  onHandoff?: () => () => void,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <DeviceLinkSection
        dark={false}
        rowCls=""
        labelCls=""
        offline={offline as never}
        onShowRemoteTabs={onShowRemoteTabs}
        onHandoff={onHandoff ?? (() => noopCancel)}
      />,
    );
  });
  for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); });
}

const client = (patch: Partial<LinkStatus>) => ({ ...EMPTY_STATUS, role: 'client', ...patch });
const queue = (patch: Record<string, unknown>) => ({
  offline: false, pending: 0, conflicts: 0, progress: null,
  onSync: () => {}, onCancel: () => {}, ...patch,
});
const buttons = () => [...container!.querySelectorAll('button')].map(b => b.textContent || '');

/** 在「粘贴配对码」那个输入框里填一枚码并点「配对」 */
async function pair(uri: string) {
  const input = container!.querySelector('input[placeholder^="hide-link://pair"]')!;
  /* React 受控输入：走原生 setter 才拿得到一次真实的 change */
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, uri);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const btn = [...container!.querySelectorAll('button')]
    .find(b => (b.textContent ?? '') === 'link.pairByCode')!;
  await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  status = {};
  pairUriCalls = 0;
});

describe('手机侧那一格', () => {
  it('没有「扫一扫」那颗按钮，也不挂相机层', async () => {
    /* 没链路时这一格该出现的是不需要相机的等价入口（粘贴 / 短码 / 手填） */
    status = { ...EMPTY_STATUS };
    await mount(queue({}));
    expect(buttons()).not.toContain('link.scan');
    expect(container!.querySelector('[data-testid="heid-scanner"]')).toBeNull();
    expect(container!.textContent).toContain('link.pasteCode');
    expect(container!.textContent).toContain('link.shortCode');
  });

  it('有待同步与需确认时各报一行，并给「立即同步」', async () => {
    status = client({ connected: true });
    await mount(queue({ pending: 3, conflicts: 1 }));
    expect(container!.textContent).toContain('offline.bannerConfirm:1');
    expect(container!.textContent).toContain('offline.countTip:3,1');
    expect(buttons()).toContain('offline.syncNow');
  });

  it('链路断着时只报数，不给必然失败的「立即同步」', async () => {
    status = client({});
    await mount(queue({ offline: true, pending: 2 }));
    expect(container!.textContent).toContain('offline.banner:2');
    expect(buttons()).not.toContain('offline.syncNow');
  });

  it('没有欠账时那一行不占位', async () => {
    status = client({});
    await mount(queue({}));
    expect(container!.textContent).not.toContain('offline.countTip');
    expect(container!.textContent).not.toContain('offline.bannerConfirm');
  });

  /* 2026-09-26 定的是"四条路都落在同一屏"，2026-09-27 改成"四条路都走同一个交接触发器"：
     落在哪由 App 那边按状态事件判，这一格不该自己决定去哪儿 */
  it('粘贴配对码这条也走同一个交接触发器', async () => {
    status = { ...EMPTY_STATUS };
    const handoff = vi.fn(() => noopCancel);
    await mount(queue({}), undefined, handoff);
    await pair('hide-link://pair?h=192.168.31.87&p=47123&t=abc');
    expect(pairUriCalls).toBe(1);
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it('命令本身没过时把那次交接收回（拨号根本没发生，不该等它报超时）', async () => {
    status = { ...EMPTY_STATUS };
    const cancel = vi.fn();
    await mount(queue({}), undefined, () => cancel);
    await pair('hide-link://pair?t=boom');
    expect(pairUriCalls, '确实发起过一次').toBe(1);
    expect(cancel, '交接被收回').toHaveBeenCalledTimes(1);
    expect(container!.textContent, '失败原因仍写在这一格里').toContain('地址不能为空');
  });

  it('免扫重连失败之后（role 仍是 client、并没连着）配对入口还得在', async () => {
    /* 2026-09-26 上机撞到：手机启动时自动重连被桌面拒了，role 停在 client。
       那时 `enabled` 按 role 判定就以为"在用"，于是这一格只剩两颗灰掉的按钮，
       粘贴配对码 / 短码 / 手填全被藏起来 —— 想改扫一张新码就没有路。 */
    status = client({ peerAddr: '192.168.31.87:47123', lastError: '这台设备未配对或已被移除，请重新扫码' });
    await mount(queue({}));
    expect(container!.textContent).toContain('link.pasteCode');
    expect(container!.querySelector('input[placeholder^="hide-link://pair"]')).toBeTruthy();
    expect(buttons()).toContain('link.pairByCode');
    expect(container!.textContent, '同时该看得懂上次为什么没连上').toContain('这台设备未配对或已被移除');
  });

  it('正在写回时那一行换成进度与取消', async () => {
    status = client({ connected: true });
    await mount(queue({ pending: 4, progress: { done: 1, total: 4 } }));
    expect(container!.textContent).toContain('offline.bannerSyncing:1,4');
    expect(buttons()).toContain('common.cancel');
    expect(buttons()).not.toContain('offline.syncNow');
  });
});
