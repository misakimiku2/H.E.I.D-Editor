// @vitest-environment jsdom
/**
 * 离线写队列的运行时（v1.5 阶段 5）：断连时保存不丢，重连后按排队顺序回写桌面。
 *
 * 条目 44 点名要的几种事故，这份文件里能验的全在：进程被杀（= 重新挂载同一个库还能读回来）、
 * 存储写不进、**回放途中再次断连**、同文件反复编辑（折叠后只放一条）、基线折叠的后果。
 * 桌面侧真实的回写往返在 `scripts/link-verify.mjs` 的 K 段与真机那一轮。
 *
 * 队列走真的 IndexedDB（fake-indexeddb）而不是替身：折叠、销账、重启存活都是**存储**的行为，
 * 换成替身等于把要验的东西先假设一遍。入队一律走 `enqueueOffline` 那扇真的门 ——
 * 直接往库里塞的话 hook 手里那份是空的，测到的只是测试自己。
 * 只有网络那一侧（`remoteWrite`）与链路状态是替身。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const remoteWrite = vi.fn();
const alerts: string[] = [];
const notes: { id: string; kind: string; title: string }[] = [];

/** 订阅到的状态回调：测试靠它把「连上了 / 又断了」推给 hook */
let emitStatus: ((s: unknown) => void) | null = null;
let currentStatus: Record<string, unknown> = { role: 'off', connected: false, peerKeyId: '' };

vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return { ...real, remoteWrite: (args: RemoteWriteArgs) => remoteWrite(args) };
});

vi.mock('../lib/link', () => ({
  fetchStatus: async () => currentStatus,
  subscribeLinkStatus: (cb: (s: unknown) => void) => {
    emitStatus = cb;
    return () => { emitStatus = null; };
  },
}));

vi.mock('../lib/appAlert', () => ({
  appAlert: (msg: string) => { alerts.push(msg); },
  registerAppAlert: () => {},
}));

vi.mock('../lib/notifications', () => ({
  showNotification: (n: { id: string; kind: string; title: string }) => { notes.push(n); },
}));

import { useOfflineSync, type OfflineSync } from './useOfflineSync';
import { clearQueue, loadQueue, MAX_OFFLINE_CHARS } from '../lib/offlineQueue';
import { makeRemotePath, RemoteError, type RemoteWriteArgs } from '../lib/remote';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'a1b2c3d4e5f6a7b8';
const OTHER = 'ffffffffffffffff';
const pathOf = (rel: string, dev = DEV) => makeRemotePath(dev, rel);
const CONNECTED = { role: 'client', connected: true, peerKeyId: DEV };
const OFFLINE = { role: 'client', connected: false, peerKeyId: DEV };

let root: Root | null = null;
let api: OfflineSync | null = null;
const synced: [string, string, string][] = [];
const conflicts: [string, string][] = [];
const openTabs = new Set<string>();
/** 排队顺序是判据之一，所以时钟要能控：同一个毫秒里分不出先后 */
let clock = 1_000;

function Probe() {
  api = useOfflineSync({
    onSynced: (path, textLf, hash) => synced.push([path, textLf, hash]),
    onConflict: (path, c) => conflicts.push([path, c.serverText]),
    hasTab: path => openTabs.has(path),
    t: (key: string) => key,
  });
  return null;
}

function render() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => { root!.render(<Probe />); });
  return () => root;
}

/** 把在飞的异步链跑完（回放是 async 的，一次 act 只够刷 React 那一半） */
async function settle(rounds = 14) {
  for (let i = 0; i < rounds; i++) await act(async () => { await Promise.resolve(); });
}

/** 等队列真的从 IndexedDB 读回来：fake-indexeddb 的回调排在宏任务上，一次 settle 不够 */
async function waitForQueue(n: number) {
  for (let i = 0; i < 30; i++) {
    if ((api?.entries.length ?? 0) >= n) return;
    await settle(2);
  }
  throw new Error('队列没有读回来');
}

/** 走真的那扇门入队（含折叠、容量判定、通知与告警） */
async function seed(rel: string, text: string, deviceId = DEV, baseHash = 'base') {
  clock += 1_000;
  let res = false;
  await act(async () => {
    res = (await api?.enqueueOffline({
      deviceId, relPath: rel, path: makeRemotePath(deviceId, rel), title: rel,
      text, encoding: 'utf-8', bom: false, baseHash,
    })) ?? false;
  });
  await settle();
  return res;
}

/** 推一次链路状态：connected 由假变真那一条边就是回放的扳机 */
async function pushStatus(next: Record<string, unknown>) {
  currentStatus = next;
  act(() => { emitStatus?.(next); });
  await settle();
}

const written = (hash = 'new-hash') => () => Promise.resolve({
  conflict: false, hash, size: 3, mtimeMs: 1, serverBom: false, serverBinary: false,
});

const conflictOf = (serverText: string, serverHash = 'srv') => () => Promise.resolve({
  conflict: true, hash: serverHash, size: 2, mtimeMs: 1,
  serverHash, serverText, serverEncoding: 'utf-8', serverBom: false, serverBinary: false,
});

const DONE = { conflict: false, hash: 'h', size: 1, mtimeMs: 1, serverBom: false, serverBinary: false };

beforeEach(async () => {
  remoteWrite.mockReset();
  alerts.length = 0;
  notes.length = 0;
  synced.length = 0;
  conflicts.length = 0;
  openTabs.clear();
  openTabs.add(pathOf('a.md'));
  currentStatus = { role: 'off', connected: false, peerKeyId: '' };
  emitStatus = null;
  clock = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => { clock += 1; return clock; });
  await clearQueue();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  api = null;
  vi.restoreAllMocks();
});

describe('useOfflineSync：入队与标记', () => {
  it('离线保存的内容进了手机，队列与标记就该出现（内容一个字不动）', async () => {
    render();
    expect(await seed('a.md', '手机上改的\r\n')).toBe(true);
    expect(await loadQueue()).toHaveLength(1);
    expect(api?.markers.get(pathOf('a.md'))).toBe('queued');
    expect(api?.pending).toBe(1);
    expect(notes.some(n => n.title === 'offline.queued')).toBe(true);
  });

  it('同一文件离线改三次，标记仍是一处：树上不该出现三个点', async () => {
    render();
    await seed('a.md', 'v1');
    await seed('a.md', 'v2');
    await seed('a.md', 'v3');
    expect(api?.pending).toBe(1);
    expect((await loadQueue())[0].text).toBe('v3');
  });

  it('这一份存不进手机时明确说一句，不静默当已保存', async () => {
    render();
    expect(await seed('big.md', 'x'.repeat(MAX_OFFLINE_CHARS + 1))).toBe(false);
    expect(alerts).toEqual(['offline.rejectTooBig']);
    expect(await loadQueue()).toHaveLength(0);
  });
});

describe('useOfflineSync：重连回放', () => {
  it('连上之后按排队顺序逐条写回；成功后销账并把基线换成桌面回传的那一份', async () => {
    render();
    await seed('b.md', '第二早\r\n');
    await seed('a.md', '最早\r\n');
    // 上面两笔的排队时刻决定了顺序：先排的先写
    const list = await loadQueue();
    expect(list.find(e => e.relPath === 'a.md')!.queuedAt)
      .toBeGreaterThan(list.find(e => e.relPath === 'b.md')!.queuedAt);
    remoteWrite.mockImplementation(written('h1'));
    await pushStatus(CONNECTED);
    /* 队列按 queuedAt 升序放，与文件名无关 —— 这里 a.md 是后排队的那个，所以它在后 */
    expect(remoteWrite.mock.calls.map(c => (c[0] as RemoteWriteArgs).relPath)).toEqual(['b.md', 'a.md']);
    expect(await loadQueue()).toEqual([]);
    /* 队列里那份是落盘态（CRLF），交回标签的必须是编辑器空间的 LF，
       否则脏标记判据永远对不上，文件会一直挂着「未保存」 */
    expect(synced).toEqual([
      [pathOf('b.md'), '第二早\n', 'h1'],
      [pathOf('a.md'), '最早\n', 'h1'],
    ]);
    expect(notes.some(n => n.title === 'offline.allDone')).toBe(true);
  });

  it('只放当前这台设备的条目：连着 A 时不能把 B 上攒的那份写进 A', async () => {
    render();
    await seed('mine.md', '在 B 上改的', OTHER);
    remoteWrite.mockImplementation(written());
    await pushStatus(CONNECTED);
    expect(remoteWrite).not.toHaveBeenCalled();
    expect(await loadQueue()).toHaveLength(1);
  });

  it('攒在另一台电脑上的那些必须说出来：重新配对之后不许默默卡住', async () => {
    render();
    await seed('mine.md', '在原来那台上攒的', OTHER);
    await pushStatus(CONNECTED);
    expect(notes.some(n => n.title === 'offline.stranded')).toBe(true);
    // 说了，但一个字都不写
    expect(remoteWrite).not.toHaveBeenCalled();
    expect(await loadQueue()).toHaveLength(1);
  });

  it('同一趟连接只说一次，不做每帧提醒', async () => {
    render();
    await seed('mine.md', 'x', OTHER);
    await pushStatus(CONNECTED);
    const first = notes.filter(n => n.title === 'offline.stranded').length;
    await pushStatus({ ...CONNECTED, peerAddr: '192.168.31.87:47123' });
    expect(notes.filter(n => n.title === 'offline.stranded').length).toBe(first);
  });

  it('要人裁决的那条不自动重放（否则每次重连都撞同一个冲突）', async () => {
    render();
    await seed('a.md', 'x');
    remoteWrite.mockImplementation(conflictOf('桌面上改的'));
    await pushStatus(CONNECTED);
    expect(conflicts).toEqual([[pathOf('a.md'), '桌面上改的']]);
    remoteWrite.mockClear();
    await pushStatus(OFFLINE);
    await pushStatus(CONNECTED);
    expect(remoteWrite).not.toHaveBeenCalled();
    expect(api?.conflicts).toBe(1);
  });

  it('标签没开着时不假装给出差异，只把这条标成需要确认', async () => {
    render();
    openTabs.clear();
    await seed('closed.md', 'x');
    remoteWrite.mockImplementation(conflictOf('桌面上改的'));
    await pushStatus(CONNECTED);
    expect(conflicts).toEqual([]);
    const [e] = await loadQueue();
    expect(e.state).toBe('conflict');
    expect(e.attempts).toBe(1);
    /* 冲突不是一句「同步失败」：文案得说清有几处要人看 */
    expect(notes.some(n => n.title === 'offline.needDecision')).toBe(true);
  });

  it('桌面按路径拒掉（outside 那类永久失败）：记一次尝试、留下原话，条目不动', async () => {
    render();
    await seed('a.md', 'x');
    remoteWrite.mockRejectedValue('outside: 这个路径不在共享范围里');
    await pushStatus(CONNECTED);
    const [e] = await loadQueue();
    expect(e.attempts).toBe(1);
    expect(e.lastError).toBe('这个路径不在共享范围里');
    expect(e.state).toBe('queued');
  });

  it('回放途中又断了：这一条与后面所有条目原样留着，且不算一次尝试', async () => {
    render();
    await seed('a.md', 'first');
    await seed('b.md', 'second');
    await seed('c.md', 'third');
    remoteWrite.mockImplementationOnce(written('h1'));
    remoteWrite.mockRejectedValue(new RemoteError('nolink', '手机上还没有连着桌面'));
    await pushStatus(CONNECTED);
    const list = await loadQueue();
    expect(remoteWrite).toHaveBeenCalledTimes(2);
    expect(list.map(e => e.relPath).sort()).toEqual(['b.md', 'c.md']);
    expect(list.every(e => e.attempts === 0)).toBe(true);
    /* 断连不是失败：既不该弹「同步失败」，也不该把没送出去的那条标成冲突 */
    expect(alerts.length).toBe(0);
    expect(list.every(e => e.state === 'queued')).toBe(true);
  });

  it('取消回放：已经写回去的不退回来，没轮到的原地不动', async () => {
    render();
    await seed('a.md', 'first');
    await seed('b.md', 'second');
    let release: (v: unknown) => void = () => {};
    remoteWrite.mockImplementation((args: RemoteWriteArgs) => (
      args.relPath === 'a.md' ? new Promise(res => { release = res; }) : Promise.resolve(DONE)
    ));
    await pushStatus({ ...CONNECTED, connected: false });
    act(() => { emitStatus?.(CONNECTED); });
    await act(async () => { await Promise.resolve(); });
    api?.cancel();
    release(DONE);
    await settle();
    expect(remoteWrite).toHaveBeenCalledTimes(1);
    expect((await loadQueue()).map(e => e.relPath)).toEqual(['b.md']);
  });

  it('同一时刻只跑一趟回放：连接抖动两下不该把同一个文件写两遍', async () => {
    render();
    await seed('a.md', 'x');
    let release: (v: unknown) => void = () => {};
    remoteWrite.mockImplementation(() => new Promise(res => { release = res; }));
    act(() => { emitStatus?.(CONNECTED); });
    await act(async () => { await Promise.resolve(); });
    // 断一下立刻又连上：第二趟必须被挡在外面
    act(() => { emitStatus?.(OFFLINE); });
    act(() => { emitStatus?.(CONNECTED); });
    await settle();
    release(DONE);
    await settle();
    expect(remoteWrite).toHaveBeenCalledTimes(1);
  });

  it('没连上之前什么都不发：回放只在 connected 为真之后开始', async () => {
    render();
    await seed('a.md', 'x');
    await pushStatus(OFFLINE);
    expect(remoteWrite).not.toHaveBeenCalled();
    expect(api?.offline).toBe(true);
  });
});

describe('useOfflineSync：折叠之后的世界', () => {
  it('同一文件离线改了三次，重连只写一次，带的是最后内容与**最初**基线', async () => {
    render();
    await seed('a.md', 'v1', DEV, 'base-original');
    await seed('a.md', 'v2', DEV, 'base-middle');
    await seed('a.md', 'v3', DEV, 'base-latest');
    remoteWrite.mockImplementation(written('h9'));
    await pushStatus(CONNECTED);
    expect(remoteWrite).toHaveBeenCalledTimes(1);
    const arg = remoteWrite.mock.calls[0][0] as RemoteWriteArgs;
    expect(arg.text).toBe('v3');
    // 带最初的基线而不是中间态 —— 拿中间态去比，桌面没动也会回一次假冲突
    expect(arg.baseHash).toBe('base-original');
  });

  it('应用重启（重新挂载同一个库）之后欠的那份还在，一连上就补放', async () => {
    render();
    await seed('a.md', '重启前存的');
    act(() => { root?.unmount(); });
    root = null;
    expect(await loadQueue()).toHaveLength(1);

    render();
    await settle();
    remoteWrite.mockImplementation(written('hA'));
    await pushStatus(CONNECTED);
    expect(remoteWrite).toHaveBeenCalledTimes(1);
    expect(await loadQueue()).toEqual([]);
  });

  it('启动时就已连着（免扫重连赶在挂载之前完成）也要把欠的放掉，不是只认之后那条边', async () => {
    render();
    await seed('a.md', '断连期间改的');
    act(() => { root?.unmount(); });
    root = null;
    currentStatus = CONNECTED;
    render();
    remoteWrite.mockImplementation(written('hB'));
    await settle();
    expect(remoteWrite).toHaveBeenCalledTimes(1);
    expect(await loadQueue()).toEqual([]);
  });

  it('弃用手机上这一份：只摘队列，桌面那个文件一个字都不碰', async () => {
    render();
    await seed('a.md', 'x');
    remoteWrite.mockClear();
    await act(async () => { await api?.dropForPath(pathOf('a.md')); });
    await settle();
    expect(await loadQueue()).toEqual([]);
    expect(remoteWrite).not.toHaveBeenCalled();
  });

  it('当场又存成功之后，队列里那条旧的待同步跟着销账', async () => {
    render();
    await seed('a.md', '离线攒的');
    await act(async () => { await api?.dropForPath(pathOf('a.md')); });
    await settle();
    expect(api?.pending).toBe(0);
    expect(api?.markers.size).toBe(0);
  });
});
