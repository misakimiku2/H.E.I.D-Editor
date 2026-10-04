// @vitest-environment jsdom
/**
 * 安卓保存抽屉里的目的地那一档（存手机 / 存电脑）。
 *
 * 这里验的是**摆不摆、点了给回什么**这两件事：
 * ① 没连着电脑、或电脑那侧没开文件夹树时，整排目的地都不该出现 —— 摆一颗点不出结果的
 *    「电脑」比不摆更糟，用户会以为是自己没配对好；
 * ② 撞名再问的那一趟，主按钮的意思必须跟着输入框走（名字没动=覆盖，改了名=再存一次），
 *    而且覆盖要把桌面刚给的基线带回去。
 * 真实的落盘与链路往返不在这里（`fileIO.savetodesktop.test.ts` 与 `scripts/link-verify.mjs`）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/platform', () => ({
  IS_ANDROID_APP: true,
  IS_TOUCH_PRIMARY: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}=${Object.values(vars).join(',')}` : key,
}));

const remoteScope = vi.fn();
const remoteList = vi.fn();
vi.mock('../../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/remote')>();
  return {
    ...real,
    remoteScope: () => remoteScope(),
    remoteList: (rel: string) => remoteList(rel),
  };
});

/** 手机侧看到的那份状态：按可变态提供，工厂只在被调用时读 */
let connected = true;
let peerKeyId = 'a1b2c3d4e5f6a7b8';
vi.mock('../../lib/link', () => ({
  fetchStatus: () => Promise.resolve({ connected, peerKeyId, peerDevice: 'Office-PC', rootDisplay: '' }),
}));

import { SaveNameSheet } from './SaveNameSheet';
import type { RemoteOccupied, SaveTarget } from '../../lib/fileIO';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'a1b2c3d4e5f6a7b8';
let root: Root | null = null;

/** 让 mount 里那两个 await（fetchStatus → remoteScope）跑完 */
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

function render(props: { occupied?: RemoteOccupied } = {}, onResolve = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <SaveNameSheet defaultName="untitled.txt" isDarkMode={false} occupied={props.occupied} onResolve={onResolve} />,
    );
  });
  const has = (s: string) => (document.body.textContent ?? '').includes(s);
  const click = (s: string) => {
    const el = Array.from(document.body.querySelectorAll('button,input'))
      .find(e => (e.textContent ?? '').includes(s));
    if (!el) throw new Error(`界面上没有可点的「${s}」，当前：${document.body.textContent}`);
    act(() => { (el as HTMLElement).click(); });
    return el;
  };
  /** 改输入框的值要走原生 setter：直接赋值 React 收不到 input 事件 */
  const type = (v: string) => {
    const input = document.body.querySelector('input') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  return { onResolve, has, click, type };
}

beforeEach(() => {
  connected = true;
  peerKeyId = DEV;
  remoteScope.mockResolvedValue({ hasRoot: true });
  remoteList.mockResolvedValue({ entries: [], rootName: 'link-test', truncated: false });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('目的地那一档摆不摆', () => {
  it('连着电脑且那侧开着树：两档都在，默认还是本机', async () => {
    const { has, click } = render();
    await flush();
    expect(has('save.destTitle')).toBe(true);
    expect(has('save.destLocal')).toBe(true);
    expect(has('save.destDesktop')).toBe(true);
    // 默认目的地 = 本机：连着电脑也不该把用户原来那一下保存改道
    expect(document.body.querySelector('[aria-pressed="true"]')?.textContent).toContain('save.destLocal');
    expect(has('save.overwrite')).toBe(false);
    void click;
  });

  it('没连着电脑：整排目的地都不出现，保存按本机走', async () => {
    connected = false;
    peerKeyId = '';
    const { has, click, onResolve } = render();
    await flush();
    expect(has('save.destTitle')).toBe(false);
    click('menu.save');
    expect(onResolve).toHaveBeenCalledWith({ name: 'untitled.txt', dest: 'local' });
  });

  it('连着电脑但桌面没开文件夹树：也不出现（没地方可落）', async () => {
    remoteScope.mockResolvedValue({ hasRoot: false });
    const { has } = render();
    await flush();
    expect(has('save.destTitle')).toBe(false);
  });

  it('问不到共享范围（链路抖了一下）：按不可用处理，不摆半死不活的一档', async () => {
    remoteScope.mockRejectedValue(new Error('nolink'));
    const { has } = render();
    await flush();
    expect(has('save.destTitle')).toBe(false);
  });

  it('取消那一下交出 null（= 这次不存了）', async () => {
    const { click, onResolve } = render();
    await flush();
    click('common.cancel');
    expect(onResolve).toHaveBeenCalledWith(null);
  });
});

describe('选了电脑之后', () => {
  it('确认交出「名字 + 选中的那层」，没选过就是共享根那一层', async () => {
    const { click, onResolve, has } = render();
    await flush();
    click('save.destDesktop');
    expect(has('folder.root')).toBe(true);   // 那一行先说清默认落在共享根
    click('menu.save');
    const got = onResolve.mock.calls[0][0] as SaveTarget;
    expect(got.name).toBe('untitled.txt');
    expect(got.dest).toBe('desktop');
    expect(got.dir).toBe(`hide-remote://${DEV}`);
    expect(got.overwrite).toBeUndefined();
  });

  it('那一行进文件夹选择抽屉，选完把位置带回来（身份键带的是那台设备的 keyId）', async () => {
    const { click, has } = render();
    await flush();
    click('save.destDesktop');
    click('folder.root');
    await flush();
    expect(has('folder.pickTitle')).toBe(true);
    expect(has('link-test')).toBe(true);           // 根那一层用桌面给的人话名字
    expect(has(DEV)).toBe(false);                  // keyId 那串十六进制不该出现在界面上
    click('folder.confirm');
    expect(has('folder.pickTitle')).toBe(false);   // 选完收回，回到问名字那一层
  });

  it('在抽屉里选到子文件夹后，那一行改口，交出的 dir 也是它', async () => {
    remoteList.mockImplementation(async (rel: string) => ({
      truncated: false,
      rootName: 'link-test',
      entries: rel === ''
        ? [{ name: 'notes', isDir: true, size: 0, mtimeMs: 1 }, { name: 'a.md', isDir: false, size: 2, mtimeMs: 1 }]
        : [],
    }));
    const { click, has, onResolve } = render();
    await flush();
    click('save.destDesktop');
    click('folder.root');
    await flush();
    expect(has('notes')).toBe(true);
    expect(has('a.md'), '选择抽屉只列目录：文件不能当目的地').toBe(false);
    click('notes');                 // 选中并展开那一层
    click('folder.confirm');
    expect(has('notes')).toBe(true);
    click('menu.save');
    expect(onResolve.mock.calls[0][0]).toMatchObject({ dir: `hide-remote://${DEV}/notes` });
  });
});

describe('桌面上那个位置被占着', () => {
  const occupied: RemoteOccupied = {
    name: 'untitled.txt', size: 1234, serverHash: 'srv-hash',
    dest: 'desktop', dir: `hide-remote://${DEV}/notes`,
  };

  it('重问的这一层记着上一趟选中的目的地与文件夹', async () => {
    const { has, click, onResolve } = render({ occupied });
    await flush();
    // 不需要再点一次「电脑」：那一档本来就是这么进来的
    expect(document.body.querySelector('[aria-pressed="true"]')?.textContent).toContain('save.destDesktop');
    expect(has('notes')).toBe(true);            // 选中的那一层按名字摆回来，不是 keyId
    expect(has(DEV), 'keyId 那串十六进制不该出现在界面上').toBe(false);
    click('save.overwrite');
    expect(onResolve.mock.calls[0][0]).toMatchObject({
      dest: 'desktop', dir: `hide-remote://${DEV}/notes`, overwrite: true, baseHash: 'srv-hash',
    });
  });

  it('名字没动时主按钮就是「覆盖」，并带回桌面给的那份基线', async () => {
    const { click, onResolve } = render({ occupied: { ...occupied, dir: `hide-remote://${DEV}` } });
    await flush();
    click('save.overwrite');
    expect(onResolve.mock.calls[0][0]).toMatchObject({
      dest: 'desktop', overwrite: true, baseHash: 'srv-hash',
    });
  });

  it('改了名字就回到「保存」，不带 overwrite —— 让桌面按新名字再判一次', async () => {
    const { click, has, type, onResolve } = render({ occupied });
    await flush();
    type('note-2.txt');
    expect(has('save.overwrite')).toBe(false);
    click('menu.save');
    expect(onResolve.mock.calls[0][0]).toMatchObject({ name: 'note-2.txt' });
    expect((onResolve.mock.calls[0][0] as SaveTarget).overwrite).toBeUndefined();
  });

  it('桌面上那份太大不能覆盖：主按钮按住不动，改了名字才放', async () => {
    const { has, click, type } = render({ occupied: { ...occupied, size: 99_000_000, serverHash: '' } });
    await flush();
    expect(has('save.occupiedTooLarge')).toBe(true);
    expect(has('save.overwrite')).toBe(false);
    expect((click('menu.save') as HTMLButtonElement).disabled).toBe(true);
    type('other.txt');
    const primary = Array.from(document.body.querySelectorAll('button'))
      .find(b => (b.textContent ?? '').includes('menu.save')) as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
  });

  it('第一次问（没有 occupied）时不出现那句冲突提示', async () => {
    const { has } = render();
    await flush();
    expect(has('save.occupied')).toBe(false);
    expect(has('save.occupiedTooLarge')).toBe(false);
  });
});
