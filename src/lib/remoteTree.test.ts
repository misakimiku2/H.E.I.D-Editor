import { beforeEach, describe, expect, it, vi } from 'vitest';

/* 阶段 2 的两处接线：远程路径在 `platform.ts` 里的显示名/目录语义，
   以及 `remoteDirLister` 把桌面 `list` 的结果翻译成树认识的 DirEntry。
   命令通道本身（invoke）不 mock 也不测——那是 `remote.test.ts` 的边界之外。 */

const remoteList = vi.fn();
vi.mock('./remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('./remote')>();
  return { ...real, remoteList: (rel: string) => remoteList(rel) };
});

import { displayNameFromPath, dirNameOf } from './platform';
import { pickLister, remoteDirLister } from './remoteTree';
import { makeRemotePath } from './remote';

const DEV = 'a1b2c3d4e5f6a7b8';
const root = makeRemotePath(DEV, '');

beforeEach(() => {
  remoteList.mockReset();
});

describe('platform 的远程分支', () => {
  it('显示名取末段并解码', () => {
    expect(displayNameFromPath(makeRemotePath(DEV, 'notes/计划 2026.md'))).toBe('计划 2026.md');
    expect(displayNameFromPath(makeRemotePath(DEV, 'a%b.md'))).toBe('a%b.md');
  });

  it('所在目录保留完整键，只剥掉末段', () => {
    const p = makeRemotePath(DEV, 'notes/sub/a.md');
    expect(dirNameOf(p)).toBe(makeRemotePath(DEV, 'notes/sub'));
    /* 根那一层没有目录语义（与 content:// 同一处理）——
       落到默认分支会把 "hide-remote:" 当成目录返回，那是个假路径 */
    expect(dirNameOf(root)).toBe('');
    expect(dirNameOf(makeRemotePath(DEV, 'a.md'))).toBe(root);
  });
});

describe('remoteDirLister', () => {
  it('把桌面条目翻成树里的路径，子项键与父目录同设备', async () => {
    remoteList.mockResolvedValue({
      entries: [
        { name: 'sub', isDir: true, size: 0, mtimeMs: 1 },
        { name: 'readme.md', isDir: false, size: 4, mtimeMs: 2 },
      ],
      truncated: false,
    });
    const got = await remoteDirLister.list(makeRemotePath(DEV, 'notes'));
    expect(remoteList).toHaveBeenCalledWith('notes');
    expect(got).toEqual([
      { name: 'sub', isDir: true, path: makeRemotePath(DEV, 'notes/sub') },
      { name: 'readme.md', isDir: false, path: makeRemotePath(DEV, 'notes/readme.md') },
    ]);
  });

  it('根目录用空相对路径去列', async () => {
    remoteList.mockResolvedValue({ entries: [], truncated: false });
    await remoteDirLister.list(root);
    expect(remoteList).toHaveBeenCalledWith('');
  });

  it('不合法的远程键直接抛，不拿空列表冒充"目录是空的"', async () => {
    await expect(remoteDirLister.list(`${makeRemotePath(DEV, '')}/../escape`)).rejects.toThrow();
    expect(remoteList).not.toHaveBeenCalled();
  });

  it('树头显示「设备名 · 根目录名」', () => {
    expect(remoteDirLister.displayName(makeRemotePath(DEV, 'projects/notes'))).toContain('notes');
    expect(remoteDirLister.displayName(makeRemotePath(DEV, ''))).toContain(DEV.slice(0, 8));
  });

  it('不实现 watch：实时更新是阶段 4 的推送通道，现在侧栏退化为手动刷新', () => {
    expect(remoteDirLister.watch).toBeUndefined();
  });
});

describe('pickLister', () => {
  const local = { chooseRoot: async () => null, list: async () => [], displayName: () => '' };

  it('只有远程根换实现，其余仍按平台那一份', () => {
    expect(pickLister(root, local)).toBe(remoteDirLister);
    expect(pickLister('D:\\projects', local)).toBe(local);
    expect(pickLister(null, local)).toBe(local);
    /* 手机上远程根也要走 link 通道——此刻平台那一份指的是 SAF，前缀才是判据 */
    expect(pickLister(makeRemotePath(DEV, 'a'), local)).toBe(remoteDirLister);
  });
});
