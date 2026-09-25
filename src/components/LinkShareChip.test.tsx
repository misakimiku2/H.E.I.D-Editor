// @vitest-environment jsdom
/**
 * 状态栏那条「手机可访问」常驻标记（阶段 1 定稿第 1 条的硬要求：开启态不能只活在设置页里）。
 * 验的四件事都是"该出现的时候必须出现"这一类：关着不占位、开着要报根、
 * 测试配对那档要换警示文案、连着时报设备名。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({ IS_ANDROID_APP: false, IS_TOUCH_PRIMARY: false, NARROW_QUERY: '(max-width: 767.98px)' }));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

let status: Record<string, unknown> = { role: 'off', listening: false };
let emit: ((s: unknown) => void) | null = null;
vi.mock('../lib/link', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/link')>();
  return {
    ...real,
    fetchStatus: () => Promise.resolve({ ...real.EMPTY_STATUS, ...status }),
    subscribeLinkStatus: (cb: (s: unknown) => void) => { emit = cb; return () => { emit = null; }; },
  };
});

import { LinkShareChip } from './LinkShareChip';
import { EMPTY_STATUS } from '../lib/link';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

const mount = async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => { root!.render(<LinkShareChip dark />); });
  await act(async () => { await Promise.resolve(); });
  return el;
};

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
  status = { role: 'off', listening: false };
});

const base = (patch: Record<string, unknown>) => ({ ...EMPTY_STATUS, ...patch });

describe('LinkShareChip', () => {
  it('没开共享时不占状态栏一格', async () => {
    const el = await mount();
    expect(el.querySelector('[data-testid="heid-link-chip"]')).toBeNull();
  });

  it('共享开着时报「手机可访问」，tooltip 里是当前共享根', async () => {
    status = base({ role: 'server', listening: true, rootDisplay: 'D:\\proj\\notes' });
    const el = await mount();
    const chip = el.querySelector('[data-testid="heid-link-chip"]');
    expect(chip?.textContent).toContain('link.chipSharing');
    expect(chip?.getAttribute('title')).toContain('D:\\proj\\notes');
  });

  it('根外白名单的份数一并进 tooltip（多交出去一分就得看得见一分）', async () => {
    status = base({ role: 'server', listening: true, rootDisplay: 'D:\\a', openShared: 3 });
    const el = await mount();
    expect(el.querySelector('[data-testid="heid-link-chip"]')?.getAttribute('title'))
      .toContain('link.openSharedFiles3');
  });

  it('测试配对开着时换成警示文案', async () => {
    status = base({ role: 'server', listening: true, rootDisplay: 'D:\\a', testPair: true });
    const el = await mount();
    const chip = el.querySelector('[data-testid="heid-link-chip"]');
    expect(chip?.textContent).toContain('link.chipTest');
    expect(chip?.textContent).not.toContain('link.chipSharing');
    expect(chip?.getAttribute('title')).toContain('link.chipTestTip');
  });

  it('连着设备时把设备名带出来，并在状态推送到达时更新', async () => {
    status = base({ role: 'server', listening: true, rootDisplay: 'D:\\a' });
    const el = await mount();
    expect(el.querySelector('[data-testid="heid-link-chip"]')?.textContent).not.toContain('Pixel-7');
    await act(async () => { emit?.(base({ role: 'server', listening: true, connected: true, peerDevice: 'Pixel-7' })); });
    expect(el.querySelector('[data-testid="heid-link-chip"]')?.textContent).toContain('Pixel-7');
  });

  it('手机端（它是读的那一方）恒不渲染', async () => {
    vi.resetModules();
    vi.doMock('../lib/platform', () => ({ IS_ANDROID_APP: true, IS_TOUCH_PRIMARY: true, NARROW_QUERY: '' }));
    const { LinkShareChip: PhoneChip } = await import('./LinkShareChip');
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => { root!.render(<PhoneChip dark />); });
    await act(async () => { await Promise.resolve(); });
    expect(el.querySelector('[data-testid="heid-link-chip"]')).toBeNull();
  });
});
