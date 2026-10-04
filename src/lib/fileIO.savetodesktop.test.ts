// @vitest-environment jsdom
/**
 * 「存到电脑」那一条保存分支（手机上写好的内容，作为**新文件**落到连着的那台电脑的文件夹树）。
 *
 * 与 `fileIO.remote.test.ts` 盯的是两个方向，别混：那份是**远程标签的写回**（内容本来就是
 * 从桌面读来的，有基线可判，断连时交给离线队列）；这一份根本没有基线可判 —— 桌面上还没有
 * 这个文件，判据全在桌面那侧，所以这里的三种回话（建出来 / 位置被占 / 问过之后桌面又改了）
 * 都只能回到同一层弹窗再问一次。
 *
 * 两条不许走歪的路单独钉住：
 * ① 新建失败**不能**进离线队列（队列回放走 `write`，凭的是"桌面上有这一份"）；
 * ② 已有本机路径的普通保存不能弹任何东西（一次保存一层窗是倒退）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* platform 在模块加载期读取，须用 vi.mock 提升到 import 之前：这一整份都按安卓壳跑 */
vi.mock('./platform', async (importOriginal) => {
  const real = await importOriginal<typeof import('./platform')>();
  return { ...real, IS_ANDROID_APP: true };
});

const alerts: string[] = [];
vi.mock('./appAlert', () => {
  return {
    appAlert: (m: string) => { alerts.push(m); },
    registerAppAlert: () => {},
  };
});

const remoteCreate = vi.fn();
vi.mock('./remote', async (importOriginal) => {
  const real = await importOriginal<typeof import('./remote')>();
  return { ...real, remoteCreate: (args: unknown) => remoteCreate(args) };
});

import { saveFileToDisk } from './fileIO';
import { parseRemoteError } from './remote';
import type { FileTab } from './tabModel';
import type { SaveTarget as Target } from './fileIO';

const DEV = 'a1b2c3d4e5f6a7b8';
/** 选择抽屉交回来的那层（远程路径形态） */
const DIR = `hide-remote://${DEV}/sub`;

function localTab(over: Partial<FileTab> = {}): FileTab {
  return {
    id: 't1', title: 'untitled.txt', path: null, handle: null,
    content: '# 手机上写的\n', originalContent: '',
    language: 'markdown', isDirty: true, readOnly: false, mdView: 'edit',
    encoding: 'utf-8', bom: false, eol: 'lf', originalEol: 'lf',
    ...over,
  } as FileTab;
}

const OK_CREATE = {
  conflict: false, exists: false, hash: 'hash-after', size: 9, mtimeMs: 1,
  serverBom: false, serverBinary: false,
};

/** 一问一答的假弹窗：按顺序吐出事先备好的答案，并记下每次问到的现场 */
function prompt(...answers: (Target | null)[]): { ask: (d: string, o?: unknown) => Promise<Target | null>; calls: { name: string; occupied?: unknown }[] } {
  const calls: { name: string; occupied?: unknown }[] = [];
  let i = 0;
  const ask = async (defaultName: string, occupied?: unknown) => {
    calls.push({ name: defaultName, occupied });
    return answers[Math.min(i++, answers.length - 1)];
  };
  return { ask, calls };
}

const toDesktop = (name: string, extra: Partial<Target> = {}): Target =>
  ({ name, dest: 'desktop', dir: DIR, ...extra }) as Target;

beforeEach(() => {
  remoteCreate.mockReset();
  alerts.length = 0;
});

describe('saveFileToDisk 的「存到电脑」分支', () => {
  it('选电脑：把名字拼进选中的那层，发 create，带回桌面给的基线', async () => {
    remoteCreate.mockResolvedValue(OK_CREATE);
    const { ask } = prompt(toDesktop('note.md'));
    const r = await saveFileToDisk(localTab(), '# 手机上写的\n', true, false, ask);
    expect(remoteCreate).toHaveBeenCalledTimes(1);
    expect(remoteCreate.mock.calls[0][0]).toMatchObject({
      relPath: 'sub/note.md', text: '# 手机上写的\n', encoding: 'utf-8', bom: false,
    });
    expect(r).toMatchObject({ ok: true, savedPath: `hide-remote://${DEV}/sub/note.md`, remoteBaseHash: 'hash-after' });
    expect(r.remoteOffline).toBeUndefined();
  });

  it('落到共享根那一层时路径不带前导斜杠', async () => {
    remoteCreate.mockResolvedValue(OK_CREATE);
    const { ask } = prompt(toDesktop('note.md', { dir: `hide-remote://${DEV}` }));
    await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(remoteCreate.mock.calls[0][0]).toMatchObject({ relPath: 'note.md' });
  });

  it('换行符按标签还原之后才发出去（落盘态只有一个口径）', async () => {
    remoteCreate.mockResolvedValue(OK_CREATE);
    const { ask } = prompt(toDesktop('note.txt'));
    await saveFileToDisk(localTab({ eol: 'crlf' }), 'a\nb\n', true, false, ask);
    expect(remoteCreate.mock.calls[0][0]).toMatchObject({ text: 'a\r\nb\r\n' });
  });

  it('位置被占着：带着桌面给的现场再问一次，改名之后按新名字再发', async () => {
    remoteCreate
      .mockResolvedValueOnce({ ...OK_CREATE, exists: true, hash: 'srv-hash', size: 1234 })
      .mockResolvedValueOnce(OK_CREATE);
    const { ask, calls } = prompt(toDesktop('note.md'), toDesktop('note-2.md'));
    const r = await saveFileToDisk(localTab(), 'x', true, false, ask);
    /* 重问的那一趟必须把目的地与选中的那一层一起带回去：这一层是重新挂载的，
       不带就等于默认「本机」悄悄生效，而屏幕上写的是电脑上那个名字 */
    expect(calls[1].occupied).toEqual({
      name: 'note.md', size: 1234, serverHash: 'srv-hash', dest: 'desktop', dir: DIR,
    });
    expect(remoteCreate).toHaveBeenLastCalledWith(expect.objectContaining({ relPath: 'sub/note-2.md' }));
    expect(r.ok).toBe(true);
  });

  it('用户明确选覆盖：带 overwrite 与刚才那份哈希，桌面才肯写已存在的位置', async () => {
    remoteCreate
      .mockResolvedValueOnce({ ...OK_CREATE, exists: true, hash: 'srv-hash', size: 10 })
      .mockResolvedValueOnce(OK_CREATE);
    const { ask } = prompt(toDesktop('note.md'), toDesktop('note.md', { overwrite: true, baseHash: 'srv-hash' }));
    await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(remoteCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      relPath: 'sub/note.md', overwrite: true, baseHash: 'srv-hash',
    }));
  });

  it('问过之后桌面又改了那一份：回到同一层重问，不去喂 diff 时间线', async () => {
    // 这个标签本来不是远程标签，时间线里没有它的位置；把冲突当"远程保存冲突"报出去，
    // 前端会拿一个还不存在的 tab.path 去挂差异条目。
    remoteCreate
      .mockResolvedValueOnce({
        ...OK_CREATE, conflict: true, hash: 'newest', size: 20, serverHash: 'newest', serverText: '桌面刚改的',
      })
      .mockResolvedValueOnce(OK_CREATE);
    const { ask, calls } = prompt(toDesktop('note.md', { overwrite: true, baseHash: 'stale' }), toDesktop('note-2.md'));
    const r = await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(calls[1].occupied).toEqual({
      name: 'note.md', size: 20, serverHash: 'newest', dest: 'desktop', dir: DIR,
    });
    expect(r.remoteConflict).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('链路断了：当场说一句，绝不进离线队列（队列回放的是有基线的 write）', async () => {
    remoteCreate.mockRejectedValue(parseRemoteError('nolink: 手机上还没有连着桌面'));
    const { ask } = prompt(toDesktop('note.md'));
    const r = await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(r).toMatchObject({ ok: false, savedPath: null });
    expect(r.remoteOffline).toBeUndefined();
    expect(alerts).toEqual(['手机上还没有连着桌面']);
  });

  it('桌面按路径拒绝（永久失败）也照原样报，不压进队列也不重问', async () => {
    remoteCreate.mockRejectedValue(parseRemoteError('outside: 该路径经符号链接指向了共享范围之外，已拒绝'));
    const { ask, calls } = prompt(toDesktop('note.md'));
    const r = await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(r.ok).toBe(false);
    expect(r.remoteOffline).toBeUndefined();
    expect(calls.length).toBe(1);
  });

  it('第二次问的时候取消：就到此为止，不再多发一趟 create', async () => {
    remoteCreate.mockResolvedValue({ ...OK_CREATE, exists: true, hash: 'srv', size: 3 });
    const { ask } = prompt(toDesktop('note.md'), null);
    const r = await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(r.ok).toBe(false);
    expect(remoteCreate).toHaveBeenCalledTimes(1);
  });

  it('目的地改回本机：走系统新建文档，不再多发 create', async () => {
    const uri = 'content://com.android.externalstorage.documents/document/primary%3ANotes.md';
    const writeUri = vi.fn(() => true);
    (window as any).HeidBridge = {
      createDoc: (name: string) => {
        queueMicrotask(() => window.dispatchEvent(new CustomEvent('heid-saf', {
          detail: { kind: 'create', canceled: false, file: { uri, name } },
        })));
      },
      writeUri,
    };
    remoteCreate.mockResolvedValue({ ...OK_CREATE, exists: true, hash: 'srv', size: 3 });
    const { ask } = prompt(toDesktop('note.md'), { name: 'Notes.md', dest: 'local' } as Target);
    const r = await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(remoteCreate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, savedPath: uri });
    expect(writeUri).toHaveBeenCalledTimes(1);
    delete (window as any).HeidBridge;
  });

  it('已经有本机路径的普通保存：一层弹窗都不问，直接落回原文件', async () => {
    const writeUri = vi.fn(() => true);
    (window as any).HeidBridge = { writeUri };
    const ask = vi.fn();
    const r = await saveFileToDisk(localTab({ path: 'content://x' }), 'x', false, false, ask as unknown as
      (d: string, o?: unknown) => Promise<Target | null>);
    expect(ask).not.toHaveBeenCalled();
    expect(remoteCreate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, savedPath: 'content://x' });
    delete (window as any).HeidBridge;
  });

  it('弹窗里没有可用目的地时（返回 null）算取消，不发任何东西', async () => {
    const { ask } = prompt(null);
    const r = await saveFileToDisk(localTab(), 'x', true, false, ask);
    expect(r).toMatchObject({ ok: false, savedPath: null });
    expect(remoteCreate).not.toHaveBeenCalled();
  });
});
