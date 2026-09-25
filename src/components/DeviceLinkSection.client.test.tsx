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
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: () => () => {},
    subscribePairRequests: () => () => {},
    pairingsList: () => Promise.resolve([]),
  };
});
vi.mock('./QrImage', () => ({ default: () => React.createElement('div') }));
vi.mock('./QrScanner', () => ({ default: () => React.createElement('div', { 'data-testid': 'heid-scanner' }) }));

import { DeviceLinkSection } from './DeviceLinkSection';
import { EMPTY_STATUS, type LinkStatus } from '../lib/link';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(offline?: Record<string, unknown>) {
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

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  status = {};
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

  it('正在写回时那一行换成进度与取消', async () => {
    status = client({ connected: true });
    await mount(queue({ pending: 4, progress: { done: 1, total: 4 } }));
    expect(container!.textContent).toContain('offline.bannerSyncing:1,4');
    expect(buttons()).toContain('common.cancel');
    expect(buttons()).not.toContain('offline.syncNow');
  });
});
