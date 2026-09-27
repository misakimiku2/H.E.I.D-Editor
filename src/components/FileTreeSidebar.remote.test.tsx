// @vitest-environment jsdom
/**
 * 安卓端文件树挂上**远程根**（v1.5 阶段 2）：根是 `hide-remote://<设备>/<相对路径>` 时，
 * 列目录必须走 link 通道而不是 SAF —— 手机的 `getDirLister` 那一份指的是 SAF，
 * 只按运行平台选实现就会去列本地树，看起来"能打开"却永远看不到电脑上的文件。
 *
 * 这一层能验的是**接线**：条目渲染、点击要打开哪个路径、树头显示谁。
 * 真实的局域网往返不在这儿（模拟器无网络路由），由 `scripts/link-verify.mjs` 的 F/G 两段
 * 在跑着的应用上逐条与磁盘核对。
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

const remoteList = vi.fn();
const remoteStat = vi.fn();
vi.mock('../lib/remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/remote')>();
  return { ...real, remoteList: (rel: string) => remoteList(rel), remoteStat: (rel: string) => remoteStat(rel) };
});

/** 链路状态：树要在"接回来"的那一刻把先前那句「没连着桌面」重列掉，所以测试得能推它 */
let linkCb: ((s: unknown) => void) | null = null;
vi.mock('../lib/link', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  subscribeLinkStatus: (cb: (s: unknown) => void) => { linkCb = cb; return () => { linkCb = null; }; },
}));

import { FileTreeSidebar } from './FileTreeSidebar';
import { makeRemotePath } from '../lib/remote';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEV = 'a1b2c3d4e5f6a7b8';
const ROOT_PATH = makeRemotePath(DEV, 'notes');

let root: Root | null = null;
let container: HTMLElement | null = null;
const opened: string[] = [];

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
  opened.length = 0;
  remoteList.mockReset();
  remoteStat.mockReset();
  linkCb = null;
  delete (globalThis as any).HeidBridge;
});

function render(rootPath = ROOT_PATH) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <FileTreeSidebar
        rootPath={rootPath}
        open
        isDarkMode={false}
        activeTabId='t1'
        tabs={[{ id: 't1', path: null, isDirty: false }]}
        onOpenFile={(p: string) => opened.push(p)}
        onRootChange={() => {}}
        onClose={() => {}}
        canManage
        askDangerConfirm={() => Promise.resolve(false)}
        onTabsRenamed={() => {}}
        onFileDeleted={() => {}}
      />
    );
  });
  return container!;
}

/** 懒加载是异步的：把微任务跑干，等价于真实那次 list 回来 */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/* 行元素本身就带 title={node.path}（悬停看全路径用的），测试直接按它定位，
   不为了测试往生产标记里另加一份 data-* */
const rowEls = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('[title]')]
    .map(n => ({ el: n, path: n.getAttribute('title') ?? '' }))
    .filter(x => x.path.startsWith('hide-remote://') && x.path !== ROOT_PATH);
const rowsOf = (el: HTMLElement) => rowEls(el).map(x => x.path);
const rowFor = (el: HTMLElement, rel: string) =>
  rowEls(el).find(x => x.path === makeRemotePath(DEV, rel))?.el;

describe('远程根下的文件树', () => {
  it('列目录走 link 通道，一次都没有碰 SAF 桥', async () => {
    let bridgeCalled = 0;
    (globalThis as any).HeidBridge = { listTree: () => { bridgeCalled += 1; return '[]'; } };
    remoteList.mockResolvedValue({
      entries: [
        { name: 'sub', isDir: true, size: 0, mtimeMs: 1 },
        { name: 'plan.md', isDir: false, size: 12, mtimeMs: 2 },
      ],
      truncated: false,
    });
    const el = render();
    await settle();
    expect(remoteList).toHaveBeenCalledWith('notes');
    expect(bridgeCalled, '远程根不该去列 SAF 树').toBe(0);
    expect(rowsOf(el)).toContain(makeRemotePath(DEV, 'notes/plan.md'));
  });

  it('点文件把完整的 hide-remote 键交给打开入口（含父目录段）', async () => {
    remoteList.mockResolvedValue({
      entries: [{ name: 'plan.md', isDir: false, size: 12, mtimeMs: 2 }],
      truncated: false,
    });
    const el = render();
    await settle();
    const row = rowFor(el, 'notes/plan.md')!;
    act(() => { row.click(); });
    expect(opened).toEqual([makeRemotePath(DEV, 'notes/plan.md')]);
  });

  it('展开子目录用相对路径逐段拼接', async () => {
    remoteList
      .mockResolvedValueOnce({ entries: [{ name: 'sub', isDir: true, size: 0, mtimeMs: 1 }], truncated: false })
      .mockResolvedValueOnce({ entries: [{ name: 'deep.txt', isDir: false, size: 3, mtimeMs: 1 }], truncated: false });
    const el = render();
    await settle();
    const dir = rowFor(el, 'notes/sub')!;
    act(() => { dir.click(); });
    await settle();
    expect(remoteList).toHaveBeenLastCalledWith('notes/sub');
    expect(rowsOf(el)).toContain(makeRemotePath(DEV, 'notes/sub/deep.txt'));
  });

  it('树头显示设备名与根目录名，让人知道这棵树在谁那里', async () => {
    remoteList.mockResolvedValue({ entries: [], truncated: false });
    const el = render();
    await settle();
    const header = el.querySelector<HTMLElement>(`[title="${ROOT_PATH}"]`)!;
    expect(header.textContent).toContain('notes');
  });

  /* 交接换过来的根是**整台电脑的共享根**（`hide-remote://<设备>`，rel 为空），
     按尾段取名就露出 keyId 那串十六进制 —— 2026-09-27 他点名要改掉的就是那一行。
     名字由桌面随 `list` 一起给（rootName），列成功之后补到根节点上。 */
  it('根是整台电脑的共享根时，那一行显示文件夹名而不是那串 keyId', async () => {
    const bare = makeRemotePath(DEV, '');
    remoteList.mockResolvedValue({
      entries: [{ name: 'README.txt', isDir: false, size: 4, mtimeMs: 1 }],
      rootName: 'link-test',
      truncated: false,
    });
    const el = render(bare);
    await settle();
    const spots = [...el.querySelectorAll<HTMLElement>(`[title="${bare}"]`)];
    expect(spots.length, '树头与根节点各一处').toBeGreaterThan(0);
    for (const n of spots) {
      expect(n.textContent).toContain('link-test');
      expect(n.textContent, '不该再给人看身份键').not.toContain(DEV);
    }
  });

  it('桌面没给 rootName（旧版桌面）时那一行退回设备名，仍然不是十六进制', async () => {
    const DEV2 = 'ff00ff00ff00ff00';
    localStorage.setItem('heid-link-prefs', JSON.stringify({ peerName: 'MISAKIMIKU', host: '192.168.31.87', keyId: DEV2 }));
    const bare = makeRemotePath(DEV2, '');
    remoteList.mockResolvedValue({ entries: [], truncated: false });
    const el = render(bare);
    await settle();
    for (const n of [...el.querySelectorAll<HTMLElement>(`[title="${bare}"]`)]) {
      expect(n.textContent).toContain('MISAKIMIKU');
      expect(n.textContent).not.toContain(DEV2);
    }
  });

  it('列不出内容时把原因落在节点上而不是空白树', async () => {
    remoteList.mockRejectedValue(new Error('noroot: 桌面还没设置共享的文件夹'));
    const el = render();
    await settle();
    expect(el.textContent).toContain('桌面还没设置共享的文件夹');
  });

  /* 冷启动那一下：根是上次记下来的远程根，树比链路先去列目录，于是留下一句「没连着桌面」。
     链路接回来要自己重列一次 —— 否则用户看到的是一棵坏掉的树，而得他想到去点刷新
     （2026-09-27 手机上实拍到的正是那一屏）。 */
  it('链路接回来时把「没连着桌面」那一屏重列掉', async () => {
    remoteList.mockRejectedValueOnce(new Error('unavailable: 这台设备没有连着桌面，请先完成配对'));
    const el = render();
    await settle();
    expect(el.textContent).toContain('没有连着桌面');
    remoteList.mockResolvedValue({ entries: [{ name: 'plan.md', isDir: false, size: 12, mtimeMs: 2 }], truncated: false });
    act(() => { linkCb?.({ connected: true }); });
    await settle();
    expect(el.textContent, '那句时机性的错该被重列的结果替掉').not.toContain('没有连着桌面');
    expect(rowsOf(el)).toContain(makeRemotePath(DEV, 'notes/plan.md'));
  });

  it('树是好的时候链路接回来不重列（别把他展开的层收起来）', async () => {
    remoteList.mockResolvedValue({ entries: [{ name: 'a.md', isDir: false, size: 1, mtimeMs: 1 }], truncated: false });
    render();
    await settle();
    const before = remoteList.mock.calls.length;
    act(() => { linkCb?.({ connected: true }); });
    await settle();
    expect(remoteList).toHaveBeenCalledTimes(before);
  });

});
