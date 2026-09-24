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
  delete (globalThis as any).HeidBridge;
});

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <FileTreeSidebar
        rootPath={ROOT_PATH}
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

  it('列不出内容时把原因落在节点上而不是空白树', async () => {
    remoteList.mockRejectedValue(new Error('noroot: 桌面还没设置共享的文件夹'));
    const el = render();
    await settle();
    expect(el.textContent).toContain('桌面还没设置共享的文件夹');
  });

});
