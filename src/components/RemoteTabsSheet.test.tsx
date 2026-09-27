// @vitest-environment jsdom
/**
 * 手机端「电脑上正打开的」列表页（v1.5 阶段 3 §6.2）。
 *
 * 这里验的是**列表层的判断**：哪种 reason 置灰、点开交出的是哪条身份键、
 * 失败时界面上有没有把桌面的原因说清楚、桌面的 tabs 推送有没有真的去重拉。
 * 真实的局域网往返不在这儿（模拟器上没有那条网），由 `scripts/link-verify.mjs` 在跑着的应用上核。
 *
 * 组件 portal 到 document.body（设置弹窗的 backdrop-blur 会成了 fixed 的包含块），
 * 所以所有查询都从 body 起手，不是从挂载容器。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_ANDROID_APP: true,
  IS_TOUCH_PRIMARY: true,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

const remoteTabs = vi.fn();
vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return { ...real, remoteTabs: () => remoteTabs() };
});

const DEV = 'a1b2c3d4e5f6a7b8';
const ADDR = '192.168.31.87:47123';
/** link 的四个入口按可变态提供：工厂只在被调用时读这些变量，所以能安全引用后置声明 */
let connected = true;
let role = 'client';
let lastError = '';
/** 断开那一刻 Rust 侧会把地址清掉 —— 「正在拨过去」与「曾经连着现在断了」就靠它分档 */
let peerAddr = ADDR;
let remoteEvent: ((type: string) => void) | null = null;

vi.mock('../lib/link', () => ({
  fetchStatus: () => Promise.resolve({
    connected, role, lastError, peerAddr, peerKeyId: connected ? DEV : '', peerDevice: 'Office-PC', openShared: 0,
  }),
  subscribeLinkStatus: () => () => {},
  subscribeRemoteEvents: (cb: (type: string) => void) => {
    remoteEvent = cb;
    return () => { remoteEvent = null; };
  },
  loadPrefs: () => ({ peerName: 'Office-PC' }),
}));

import { RemoteTabsSheet } from './RemoteTabsSheet';
import { RemoteError, makeRemotePath, type RemoteTabView } from '../lib/remote';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const opened: string[] = [];
const browsed: string[] = [];
let closed = 0;

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
  opened.length = 0;
  closed = 0;
  browsed.length = 0;
  connected = true;
  role = 'client';
  lastError = '';
  peerAddr = ADDR;
  remoteEvent = null;
  remoteTabs.mockReset();
});

const tab = (over: Partial<RemoteTabView>): RemoteTabView => ({
  title: 'plan.md', language: 'markdown', mdView: 'preview', dirty: false, readOnly: false,
  line: 0, col: 0, rel: '', reason: '', active: false, ...over,
});

function render() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <RemoteTabsSheet
        dark={false}
        onClose={() => { closed += 1; }}
        onOpen={(p: string) => opened.push(p)}
        onBrowse={(p: string) => browsed.push(p)}
      />,
    );
  });
  return document.body;
}

/** 状态拉取与 tabs 请求各是一串微任务，跑一个宏任务把它们一次冲干净 */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const rows = () => [...document.body.querySelectorAll('li')];
const rowWith = (text: string) => rows().find((li) => (li.textContent ?? '').includes(text));

describe('手机上「电脑上正打开的」列表', () => {
  it('进页面拉一次，三种 reason 各置灰一行（灰行不做成按钮）', async () => {
    remoteTabs.mockResolvedValue([
      tab({ title: 'plan.md', rel: 'notes/plan.md' }),
      tab({ title: 'draft.md', reason: 'dirty' }),
      tab({ title: 'untitled', reason: 'novirtual' }),
      tab({ title: 'gone.md', reason: 'missing' }),
    ]);
    const el = render();
    await flush();
    expect(remoteTabs).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(4);
    /* 可打开的那行是按钮；置灰的三行点都点不动，原因以文字形式写在行上 */
    expect(rowWith('notes/plan.md')?.querySelector('button')).not.toBeNull();
    for (const [title, key] of [['draft.md', 'reasonDirty'], ['untitled', 'reasonNovirtual'], ['gone.md', 'reasonMissing']] as const) {
      const li = rowWith(title)!;
      expect(li.querySelector('button'), `${title} 不该可点`).toBeNull();
      expect(li.textContent).toContain(`remoteTabs.${key}`);
    }
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('点可打开的行：交出拼好的 hide-remote 身份键并收起本页', async () => {
    remoteTabs.mockResolvedValue([tab({ title: 'plan.md', rel: 'notes/plan.md' })]);
    render();
    await flush();
    act(() => { rowWith('notes/plan.md')!.querySelector('button')!.click(); });
    expect(opened).toEqual([makeRemotePath(DEV, 'notes/plan.md')]);
    expect(closed, '打开前先把全屏层收掉，否则看不见刚打开的标签').toBe(1);
  });

  it('根外的 @w 引用同样按原样交给 onOpen（组件不为它分支）', async () => {
    const rel = '@w/3fa1b2c9d4e5/todo.md';
    remoteTabs.mockResolvedValue([tab({ title: 'todo.md', rel })]);
    render();
    await flush();
    act(() => { rowWith(rel)!.querySelector('button')!.click(); });
    expect(opened).toEqual([makeRemotePath(DEV, rel)]);
  });

  it('拉取失败时把桌面的原因显示出来，而不是空列表', async () => {
    remoteTabs.mockRejectedValue(new RemoteError('noroot', '桌面还没设置共享的文件夹'));
    render();
    await flush();
    const text = document.body.textContent ?? '';
    expect(text).toContain('桌面还没设置共享的文件夹');
    expect(text).toContain('remoteTabs.errCodenoroot');
    expect(text, '失败不该被渲染成「没有标签」').not.toContain('remoteTabs.empty');
  });

  it('桌面的 tabs 推送到了就重拉一次，别的类型不动', async () => {
    remoteTabs.mockResolvedValue([tab({ title: 'plan.md', rel: 'notes/plan.md' })]);
    render();
    await flush();
    expect(remoteTabs).toHaveBeenCalledTimes(1);
    act(() => { remoteEvent!('focus'); });
    await flush();
    expect(remoteTabs, '不认识的事件类型不该触发重拉').toHaveBeenCalledTimes(1);
    act(() => { remoteEvent!('tabs'); });
    await flush();
    expect(remoteTabs).toHaveBeenCalledTimes(2);
  });

  it('曾经连着、现在地址已清：说"断开了"而不是"正在连"', async () => {
    connected = false;
    peerAddr = '';
    render();
    await flush();
    expect(remoteTabs).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('remoteTabs.offline');
  });

  /* 2026-09-26 扫码即连：这一屏是扫完码的落地页，所以它必须自己说清"还在连"，
     不再靠先前那句弹完就消失的"已连接"toast（那一弹之后用户还是不知道东西在哪） */
  it('刚把码递过去、桌面还没开始服务：这一屏说"正在连上"并带着设备名', async () => {
    connected = false;
    remoteTabs.mockRejectedValue(new RemoteError('nolink', '还没连上'));
    render();
    await flush();
    expect(document.body.textContent).toContain('remoteTabs.connectingOffice-PC');
    expect(document.body.textContent, '不该把连接中的空档渲染成"电脑上没有标签页"').not.toContain('remoteTabs.empty');
  });

  it('桌面拒了这次配对：把它的原话摆在这一屏上，不静默回到空标签', async () => {
    connected = false;
    peerAddr = '';
    lastError = '这个配对码刚被换掉，请扫桌面上当前那张';
    render();
    await flush();
    expect(document.body.textContent).toContain('这个配对码刚被换掉');
  });

  it('那边一个标签都没开：这一屏直接把「浏览这台电脑的文件」给出来', async () => {
    remoteTabs.mockResolvedValue([]);
    render();
    await flush();
    expect(document.body.textContent).toContain('remoteTabs.empty');
    const btn = [...document.body.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('link.browseRemote'));
    expect(btn, '空列表这一屏要留得下去看整棵树的入口').toBeTruthy();
    act(() => { btn!.click(); });
    expect(browsed).toEqual([makeRemotePath(DEV, '')]);
    expect(closed).toBe(1);
  });

  it('列表非空时头部也有一颗进树的钮，交出的是远程根', async () => {
    remoteTabs.mockResolvedValue([tab({ title: 'plan.md', rel: 'notes/plan.md' })]);
    render();
    await flush();
    const tree = document.body.querySelector('button[aria-label="link.browseRemote"]');
    expect(tree).toBeTruthy();
    act(() => { (tree as HTMLButtonElement).click(); });
    expect(browsed).toEqual([makeRemotePath(DEV, '')]);
  });
});
