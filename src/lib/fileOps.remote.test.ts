// @vitest-environment jsdom
/**
 * 文件树管理操作的远程分支（连着的那台电脑那棵树）。
 *
 * 这一整份存在的理由是 2026-10-04 查到的那一刀：安卓上 `HeidBridge` 一直存在（它是设备能力，
 * 与"这条路径属于谁"无关），而原来的分支顺序是**先问桥**，于是手机上在那台电脑的树里点新建，
 * `hide-remote://…` 被当成 SAF 的 `treeUri\0相对路径` 去拆，拆不出来，报一句
 * 「SAF create rejected」。那句话既不是原因也不是用户能做的事。
 *
 * 所以这里两边都要钉：远程路径**必须**走链路命令且不碰桥；本机 SAF 路径**必须**照旧走桥
 * （把顺序反过来也是一种破坏）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./platform', async (importOriginal) => {
  const real = await importOriginal<typeof import('./platform')>();
  return { ...real, IS_ANDROID_APP: true };
});

const remoteCreate = vi.fn();
const remoteMkdir = vi.fn();
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('./remote')>();
  return {
    ...real,
    remoteCreate: (args: unknown) => remoteCreate(args),
    remoteMkdir: (rel: unknown) => remoteMkdir(rel),
  };
});

import { fsCreateEmptyFile, fsDelete, fsMkdir, fsCopy, fsRename, fsReveal } from './fileOps';

const DEV = 'a1b2c3d4e5f6a7b8';
const OK = { conflict: false, exists: false, hash: 'h', size: 0, mtimeMs: 1, serverBom: false, serverBinary: false };

/** 一台"桥还在"的手机：任何一次误用都要看得见 */
function bridge() {
  const b = {
    createInTree: vi.fn(() => 'content://built'),
    renameEntry: vi.fn(() => 'content://renamed'),
    deleteEntry: vi.fn(() => true),
  };
  (window as any).HeidBridge = b;
  return b;
}

beforeEach(() => {
  remoteCreate.mockReset();
  remoteMkdir.mockReset();
  invoke.mockReset();
  delete (window as any).HeidBridge;
});

describe('远程树的建文件夹与建文件', () => {
  it('远程 mkdir 走链路命令，一次都不碰 SAF 桥', async () => {
    const b = bridge();
    remoteMkdir.mockResolvedValue(OK);
    await fsMkdir(`hide-remote://${DEV}/sub/来自手机`);
    expect(remoteMkdir).toHaveBeenCalledWith('sub/来自手机');
    expect(b.createInTree).not.toHaveBeenCalled();
  });

  it('远程新建空文件：relPath 是解码之后的那一份，返回路径带设备身份键', async () => {
    const b = bridge();
    remoteCreate.mockResolvedValue(OK);
    const got = await fsCreateEmptyFile(`hide-remote://${DEV}/sub/note.md`);
    expect(remoteCreate).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'sub/note.md', text: '' }));
    expect(got).toBe(`hide-remote://${DEV}/sub/note.md`);
    expect(b.createInTree).not.toHaveBeenCalled();
  });

  it('根那一层直接建文件时 relPath 就是名字本身', async () => {
    remoteCreate.mockResolvedValue(OK);
    const got = await fsCreateEmptyFile(`hide-remote://${DEV}/note.md`);
    expect(remoteCreate).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'note.md' }));
    expect(got).toBe(`hide-remote://${DEV}/note.md`);
  });

  it('名字里带空格与中文时，返回的身份键是编码过的、发出去的是原样', async () => {
    remoteCreate.mockResolvedValue(OK);
    const got = await fsCreateEmptyFile(`hide-remote://${DEV}/我的 笔记.md`);
    expect(remoteCreate).toHaveBeenCalledWith(expect.objectContaining({ relPath: '我的 笔记.md' }));
    expect(got).toBe(`hide-remote://${DEV}/%E6%88%91%E7%9A%84%20%E7%AC%94%E8%AE%B0.md`);
  });

  it('桌面说那个位置被占着：报错并说清是「换个名字」，不返回一个指向别人文件的路径', async () => {
    remoteCreate.mockResolvedValue({ ...OK, exists: true, hash: 'srv', size: 9 });
    await expect(fsCreateEmptyFile(`hide-remote://${DEV}/note.md`)).rejects.toMatchObject({ code: 'exists' });
  });

  it('远程路径坏到解析不出来时报错，而不是当成本地路径往下写', async () => {
    // 段里带 `..` 的形态在 `parseRemotePath` 那一层就该断
    await expect(fsCreateEmptyFile(`hide-remote://${DEV}/../outside/x.md`)).rejects.toBeTruthy();
    expect(remoteCreate).not.toHaveBeenCalled();
  });
});

describe('协议里没有的那几条：远程路径一律拦下', () => {
  it('重命名 / 删除 / 复制 / 在文件管理器中显示都不碰桥、不碰 fs_ 命令', async () => {
    const b = bridge();
    await expect(fsRename(`hide-remote://${DEV}/a.md`, `hide-remote://${DEV}/b.md`)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(fsDelete(`hide-remote://${DEV}/a.md`, false)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(fsCopy(`hide-remote://${DEV}/a.md`, `hide-remote://${DEV}/c.md`)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(fsReveal(`hide-remote://${DEV}/a.md`)).rejects.toMatchObject({ code: 'unsupported' });
    expect(b.createInTree).not.toHaveBeenCalled();
    expect(b.renameEntry).not.toHaveBeenCalled();
    expect(b.deleteEntry).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('本机 SAF 那两条路维持原样（顺序反过来就是另一种破坏）', () => {
  it('树内目录与新建文件仍走桥，一次远程命令都不发', async () => {
    const b = bridge();
    const tree = 'content://com.android.externalstorage.documents/tree/primary%3ADownload';
    // 树上的目录行 = `treeUri\0相对路径`（fileTree.ts 的 SAF_SEP 约定），与远程前缀毫无共同点
    await fsMkdir(`${tree}\u0000Notes/NewSub`);
    expect(b.createInTree).toHaveBeenCalledWith(`${tree}\u0000Notes`, 'NewSub', true);
    const file = await fsCreateEmptyFile(`${tree}\u0000Notes/a.md`);
    expect(file).toBe('content://built');
    expect(remoteMkdir).not.toHaveBeenCalled();
    expect(remoteCreate).not.toHaveBeenCalled();
  });

  it('重命名与删除仍走桥', async () => {
    const b = bridge();
    await expect(fsRename(`${'content://x/tree'}\u0000a.md`, 'b.md')).resolves.toBeTruthy();
    await fsDelete('content://com.android.document/tree/primary%3ADownload/a.md', false);
    expect(b.renameEntry).toHaveBeenCalled();
    expect(b.deleteEntry).toHaveBeenCalled();
  });
});
