// @vitest-environment jsdom
/**
 * 打开着的远程文件被桌面改了，手机端要去核对（v1.5 阶段 4）。
 *
 * 这里盯三条容易写歪的：
 * 1. **帧没命中就一次请求都不发** —— 桌面推的是「变了哪些目录」，文件不在那些目录里
 *    就该安静；否则一次 npm install 会给每个开着的标签添一次白跑的往返；
 * 2. **哈希相同不算外部修改** —— 我们自己保存的那一次，桌面也会推一帧回来；
 * 3. **读不到就忽略而不是报错** —— 与桌面那份外部监听同一口径（删除场景不在这里提示）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const remoteStat = vi.fn();
const remoteRead = vi.fn();
vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return {
    ...real,
    remoteStat: (rel: string) => remoteStat(rel),
    remoteRead: (rel: string, enc?: string) => remoteRead(rel, enc),
  };
});

/** 抓住订阅回调，测试里手动"推一帧" */
let emit: ((type: string, data: string) => void) | null = null;
vi.mock('../lib/link', () => ({
  subscribeRemoteEvents: (cb: (type: string, data: string) => void) => {
    emit = cb;
    return () => { emit = null; };
  },
}));

import { useRemoteFileChanges, type RemoteWatched } from './useRemoteFileChanges';
import { makeRemotePath } from '../lib/remote';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'a1b2c3d4e5f6a7b8';
const pathOf = (rel: string) => makeRemotePath(DEV, rel);

let root: Root | null = null;
let tabs: RemoteWatched[] = [];
const changes: [string, string, string, string][] = [];

function Probe() {
  useRemoteFileChanges({ tabs, onExternalChange: (p, b, a, h) => changes.push([p, b, a, h]) });
  return null;
}

function render() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => { root!.render(<Probe />); });
}

/** 换一批标签页并让组件真的重渲染一次（hook 读的是渲染时快照，只改变量它是看不见的） */
function setTabs(next: RemoteWatched[]) {
  tabs = next;
  act(() => { root!.render(<Probe />); });
}

/** 把在飞的 stat/read 链跑完（回调里是 async，act 只保证 React 侧刷新） */
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

/** 推一帧 fs；null 表示退化帧（装不下） */
async function pushFrame(dirs: string[] | null) {
  act(() => { emit!('fs', dirs ? JSON.stringify({ dirs }) : ''); });
  await settle();
}

beforeEach(() => {
  emit = null;
  changes.length = 0;
  remoteStat.mockReset();
  remoteRead.mockReset();
  tabs = [{ path: pathOf('src/App.tsx'), originalContent: 'const a = 1\n', baseHash: 'h-old' }];
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
});

describe('useRemoteFileChanges', () => {
  it('帧命中父目录 → 核对一次；哈希相同就当无事发生', async () => {
    render();
    remoteStat.mockResolvedValue({ size: 12, mtimeMs: 1, isDir: false, hash: 'h-old' });
    await pushFrame(['src']);
    expect(remoteStat).toHaveBeenCalledTimes(1);
    expect(remoteStat).toHaveBeenCalledWith('src/App.tsx');
    expect(remoteRead).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it('哈希变了 → 读一次并给出前后两份与新的基线', async () => {
    render();
    remoteStat.mockResolvedValue({ size: 20, mtimeMs: 2, isDir: false, hash: 'h-new' });
    remoteRead.mockResolvedValue({ text: 'const a = 2\r\n', encoding: 'utf-8', bom: false, lossy: false, binary: false, hash: 'h-new', size: 15, mtimeMs: 2 });
    await pushFrame(['src']);
    expect(changes).toHaveLength(1);
    const [path, before, after, hash] = changes[0];
    expect(path).toBe(pathOf('src/App.tsx'));
    expect(before).toBe('const a = 1\n');
    expect(after).toBe('const a = 2\n');
    expect(hash).toBe('h-new');
  });

  it('变的是兄弟目录 → 一次请求都不发', async () => {
    render();
    await pushFrame(['docs']);
    expect(remoteStat).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it('退化帧（桌面那一帧装不下）按"全都核对一遍"处理', async () => {
    render();
    setTabs([
      { path: pathOf('src/App.tsx'), originalContent: 'a\n', baseHash: 'h1' },
      { path: pathOf('docs/x.md'), originalContent: 'b\n', baseHash: 'h2' },
    ]);
    remoteStat.mockResolvedValue({ size: 1, mtimeMs: 1, isDir: false, hash: '' });
    await pushFrame(null);
    expect(remoteStat).toHaveBeenCalledTimes(2);
  });

  it('根下的文件看的是空串那一层', async () => {
    render();
    setTabs([{ path: pathOf('readme.md'), originalContent: 'x\n', baseHash: 'h' }]);
    remoteStat.mockResolvedValue({ size: 1, mtimeMs: 1, isDir: false, hash: '' });
    await pushFrame(['docs']);
    expect(remoteStat).not.toHaveBeenCalled();
    await pushFrame(['']);
    expect(remoteStat).toHaveBeenCalledTimes(1);
  });

  it('桌面不给哈希（目录 / 超限文件）就不判断，宁可不提醒也不误报覆盖', async () => {
    render();
    remoteStat.mockResolvedValue({ size: 9e6, mtimeMs: 1, isDir: false, hash: '' });
    remoteRead.mockResolvedValue({ text: 'z', encoding: 'utf-8', bom: false, lossy: false, binary: false, hash: 'x', size: 1, mtimeMs: 1 });
    await pushFrame(['src']);
    expect(remoteRead).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it('stat 失败（被删 / 换根 / 链路断）静默忽略这一帧', async () => {
    render();
    remoteStat.mockRejectedValue(new Error('notfound: 桌面上没有这个文件'));
    await pushFrame(['src']);
    expect(changes).toEqual([]);
  });

  it('同一文件的第二帧在它还在核对时不再排队', async () => {
    render();
    let resolveStat: (v: unknown) => void = () => {};
    remoteStat.mockImplementation(() => new Promise(r => { resolveStat = r; }));
    act(() => { emit!('fs', JSON.stringify({ dirs: ['src'] })); });
    act(() => { emit!('fs', JSON.stringify({ dirs: ['src'] })); });
    await settle();
    expect(remoteStat).toHaveBeenCalledTimes(1);
    resolveStat({ size: 1, mtimeMs: 1, isDir: false, hash: 'h-old' });
    await settle();
    await pushFrame(['src']);
    expect(remoteStat).toHaveBeenCalledTimes(2);
  });

  it('没有基线的标签不核对（拿不到"和什么比"）', async () => {
    render();
    setTabs([{ path: pathOf('src/App.tsx'), originalContent: 'a\n', baseHash: '' }]);
    await pushFrame(['src']);
    expect(remoteStat).not.toHaveBeenCalled();
  });

  it('换根也按整份核对一遍', async () => {
    render();
    remoteStat.mockResolvedValue({ size: 1, mtimeMs: 1, isDir: false, hash: 'h-old' });
    act(() => { emit!('rootChanged', ''); });
    await settle();
    expect(remoteStat).toHaveBeenCalledTimes(1);
  });
});
